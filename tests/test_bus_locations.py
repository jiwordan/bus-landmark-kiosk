"""Exercise live response normalization and credential-safe, shared request caching."""
import importlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
STOPS = [
    {'stationId': 'same', 'sequence': 18, 'name': '반복 정류장', 'lat': 37.27, 'lng': 127.11},
    {'stationId': 'same', 'sequence': 23, 'name': '반복 정류장', 'lat': 37.27, 'lng': 127.11},
    {'stationId': 'next', 'sequence': 24, 'name': '다음 정류장', 'lat': 37.28, 'lng': 127.12},
]


def vehicle(sequence=18, station='same', identity='123'):
    return {'routeId': 228000286, 'routeTypeCd': 13, 'vehId': identity, 'plateNo': '시험용차량',
            'stationSeq': sequence, 'stationId': station, 'stateCd': 2,
            'crowded': 1, 'lowPlate': 0, 'remainSeatCnt': -1, 'taglessCd': 0}


def response(rows, code=0):
    return {'response': {'comMsgHeader': '', 'msgHeader': {'queryTime': '2026-10-12 12:00:00',
            'resultCode': code, 'resultMessage': 'API_INTERNAL_TEXT'}, 'msgBody': {'busLocationList': rows}}}


class Body:
    def __init__(self, value):
        self.body = json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.body


class BusLocationsTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / 'scripts/bus_locations.py').exists(), 'Live bus implementation is missing')
        self.module = importlib.import_module('scripts.bus_locations')
        self.temp = TemporaryDirectory(dir=ROOT / 'tests')
        self.addCleanup(self.temp.cleanup)
        self.env_path = Path(self.temp.name) / '.env.local'
        self.env_path.write_text("DATA_GO_KR_SERVICE_KEY='SERVER%2BKEY%2FTEST%3D'\n", encoding='utf-8-sig')

    def test_matches_route_station_and_visit_without_leaking_raw_vehicle_fields(self):
        wrong_route = {**vehicle(identity='4'), 'routeId': 999}
        rows = [vehicle(), vehicle(23, identity='2'), vehicle(24, 'next', '3'),
                vehicle(24, 'same', '5'), wrong_route, vehicle(identity='123')]
        vehicles, skipped = self.module.normalize_locations(response(rows), STOPS)
        self.assertEqual(skipped, 3)
        self.assertEqual([(v['id'], v['sequence'], v['lat'], v['lng']) for v in vehicles],
                         [('123', 18, 37.27, 127.11), ('2', 23, 37.27, 127.11), ('3', 24, 37.28, 127.12)])
        self.assertEqual(vehicles[0]['state'], '정류소 출발')
        self.assertNotIn('시험용차량', json.dumps(vehicles, ensure_ascii=False))

    def test_single_empty_no_result_and_invalid_responses(self):
        self.assertEqual(len(self.module.normalize_locations(response(vehicle()), STOPS)[0]), 1)
        self.assertEqual(self.module.normalize_locations(response(None), STOPS), ([], 0))
        self.assertEqual(self.module.normalize_locations(response(None, 4), STOPS), ([], 0))
        for value in ({}, response([], 1), response('bad'), {'OpenAPI_ServiceResponse': {
            'cmmMsgHeader': {'returnReasonCode': '30', 'returnAuthMsg': 'SERVER_SECRET'}}}):
            with self.subTest(value=value):
                with self.assertRaises(self.module.LocationUnavailable) as caught:
                    self.module.normalize_locations(value, STOPS)
                self.assertNotIn('SERVER_SECRET', str(caught.exception))

    def test_shared_cache_refreshes_at_ninety_seconds_and_url_encodes_key_once(self):
        service = self.module.LiveBusLocations(self.env_path, STOPS)
        with patch('scripts.bus_locations.time.monotonic', return_value=0) as clock, \
                patch('scripts.bus_locations.urlopen', side_effect=[Body(response([vehicle()])),
                    Body(response([vehicle(24, 'next')]))]) as upstream:
            first = service.get()
            params = parse_qs(urlsplit(upstream.call_args.args[0]).query)
            self.assertEqual(params['serviceKey'], ['SERVER+KEY/TEST='])
            self.assertEqual(params['routeId'], ['228000286'])
            clock.return_value = 89
            self.assertEqual(service.get(), first)
            self.assertEqual(upstream.call_count, 1)
            clock.return_value = 90
            second = service.get()
            self.assertEqual(second['vehicles'][0]['sequence'], 24)
            self.assertEqual(upstream.call_count, 2)
            self.assertEqual(second['refreshSeconds'], 90)
            for secret in ('SERVER+KEY/TEST=', 'SERVER%2BKEY', 'API_INTERNAL_TEXT'):
                self.assertNotIn(secret, json.dumps(second))

    def test_failure_does_not_serve_old_positions_or_repeat_requests_inside_cache_window(self):
        service = self.module.LiveBusLocations(self.env_path, STOPS)
        failure = URLError('https://example.invalid/?serviceKey=SERVER_SECRET')
        with patch('scripts.bus_locations.time.monotonic', return_value=0) as clock, \
                patch('scripts.bus_locations.urlopen', side_effect=[Body(response([vehicle()])), failure,
                    Body(response([]))]) as upstream:
            self.assertEqual(len(service.get()['vehicles']), 1)
            clock.return_value = 90
            with self.assertRaises(self.module.LocationUnavailable) as caught:
                service.get()
            self.assertEqual(str(caught.exception), 'network')
            clock.return_value = 100
            with self.assertRaises(self.module.LocationUnavailable):
                service.get()
            self.assertEqual(upstream.call_count, 2)
            clock.return_value = 180
            self.assertEqual(service.get()['vehicles'], [])

    def test_missing_duplicate_keys_and_denied_http_never_expose_credentials(self):
        for config in ('', 'DATA_GO_KR_SERVICE_KEY=a\nDATA_GO_KR_SERVICE_KEY=b'):
            self.env_path.write_text(config, encoding='utf-8')
            with self.assertRaises(self.module.LocationUnavailable) as caught:
                self.module.LiveBusLocations(self.env_path, STOPS).get()
            self.assertEqual(str(caught.exception), 'config')
        self.env_path.write_text('DATA_GO_KR_SERVICE_KEY=SERVER_SECRET', encoding='utf-8')
        with patch('scripts.bus_locations.urlopen', side_effect=HTTPError(
                'https://example.invalid/?serviceKey=SERVER_SECRET', 403, 'SERVER_SECRET', {}, None)):
            with self.assertRaises(self.module.LocationUnavailable) as caught:
                self.module.LiveBusLocations(self.env_path, STOPS).get()
            self.assertEqual(str(caught.exception), 'auth')
