"""A wrong route, collapsed visit, fabricated line or key leak must fail."""
import importlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[1]


def envelope(field, rows, code=0):
    return {'response': {'msgHeader': {'resultCode': code}, 'msgBody': {field: rows}}}


def stop(station, seq):
    return {'stationId': station, 'stationSeq': seq, 'stationName': '시험정류장',
            'x': 127.1234, 'y': 37.3954, 'turnYn': 'Y' if seq == 2 else 'N'}


class ImaeRouteTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / 'scripts/collect_imae_routes.py').exists(), 'Collector missing')
        self.m = importlib.import_module('scripts.collect_imae_routes')

    def normalized(self, route='204000017', code=0):
        return self.m.normalize_route(route,
            envelope('busRouteInfoItem', {'routeId': route, 'routeName': '55',
                     'startStationName': '시작', 'endStationName': '끝', 'turnStSeq': 2}),
            envelope('busRouteStationList', [stop('206000314', 1), stop('other', 2),
                                            stop('206000305', 3), stop('last', 4)]),
            envelope('busRouteLineList', [{'lineSeq': 1, 'x': 127.12, 'y': 37.39},
                                        {'lineSeq': 2, 'x': 127.13, 'y': 37.4}], code))

    def test_keeps_station_visits_separate(self):
        route = self.normalized()
        self.assertEqual([s['visitKey'] for s in route['stops']],
                         ['204000017:1','204000017:2','204000017:3','204000017:4'])
        self.assertEqual([(s['stationId'], s['visitKey']) for s in route['stations']],
                         [('206000305', '204000017:3'), ('206000314', '204000017:1')])
        self.assertTrue(route['shapeAvailable'])

    def test_catalog_has_six_routes_and_default_07159(self):
        routes = [dict(self.normalized(), routeId=rid, routeNumber=number)
                  for rid, number in self.m.ROUTES.items()]
        stations = [{'stationId': sid, 'mobileNo': mobile, 'stationName': '시험정류장'}
                    for sid, mobile in [('206000305','07159'),('206000314','07303')]]
        via = {s['stationId']: [{'routeId': r['routeId']} for r in routes] for s in stations}
        c = self.m.build_catalog(stations, via, routes)
        self.assertEqual(c['defaultStationId'], '206000305')
        self.assertEqual([r['routeNumber'] for r in c['routes']], ['55','351','422','9407','누리4','3-1'])
        self.assertEqual(c['stations'][0]['mobileNo'], '07159')
        via['206000305'].pop()
        with self.assertRaises(ValueError): self.m.build_catalog(stations, via, routes)

    def test_rejects_other_route_and_missing_selected_station(self):
        for rid, rows in [('999', [stop('206000305',1)]),
                          ('204000017', [stop('other',1)])]:
            with self.subTest(rid=rid), self.assertRaises(ValueError):
                self.m.normalize_route('204000017', envelope('busRouteInfoItem', {'routeId':rid}),
                    envelope('busRouteStationList',rows), envelope('busRouteLineList',[]))

    def test_missing_shape_is_explicit(self):
        route = self.normalized(code=4)
        self.assertFalse(route['shapeAvailable'])
        self.assertEqual(route['shape'], [])

    def test_seoul_route_without_detail_keeps_official_stops_and_shape(self):
        route = self.m.normalize_route('107000008', envelope('busRouteInfoItem', [], 4),
            envelope('busRouteStationList', [stop('206000314',1),stop('turn',2),stop('206000305',3),stop('last',4)]),
            envelope('busRouteLineList', [{'lineSeq':1,'x':127.1,'y':37.4}, {'lineSeq':2,'x':127.2,'y':37.5}]))
        self.assertEqual(route['routeNumber'], '422')
        self.assertFalse(route['detailAvailable'])
        self.assertTrue(route['shapeAvailable'])
        self.assertEqual(route['endName'], '시험정류장')

    def test_fetch_error_never_contains_key(self):
        with patch.object(self.m, 'urlopen', side_effect=URLError('URL?serviceKey=SECRET_VALUE')):
            with self.assertRaisesRegex(ValueError, '^upstream-network$'):
                self.m.fetch_response('SECRET_VALUE','busstationservice','getBusStationListv2',keyword='이매고교')


if __name__ == '__main__': unittest.main()
