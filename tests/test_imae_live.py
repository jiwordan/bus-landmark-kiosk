"""Cross-route quotas and caches must not leak or multiply upstream requests."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import URLError
from scripts import bus_locations as m
from tests.test_bus_locations import Body, response

STOPS=[{'stationId':'206000305','sequence':1,'name':'정류장','lat':37.3954,'lng':127.1234}]


def data(rid):
    return response([{'routeId':rid,'stationId':'206000305','stationSeq':1,
                      'vehId':'123','stateCd':2,'plateNo':'PRIVATE_PLATE'}])


class ImaeLiveTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(m,'RequestGate'),'Shared request gate missing')
        self.temp=TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.env=Path(self.temp.name)/'.env.local'
        self.env.write_text('DATA_GO_KR_SERVICE_KEY=PRIVATE_TEST_KEY',encoding='utf-8')

    def test_multiple_routes_share_90_second_gate_but_not_cache(self):
        clock=[0]
        with patch.object(m.time,'monotonic',side_effect=lambda:clock[0]), patch.object(m,'urlopen') as remote:
            gate=m.RequestGate()
            a=m.LiveBusLocations(self.env,STOPS,route_id='204000017',request_gate=gate)
            b=m.LiveBusLocations(self.env,STOPS,route_id='204000182',request_gate=gate)
            remote.return_value=Body(data('204000017'))
            first=a.get(); self.assertEqual(first['routeId'],'204000017')
            clock[0]=1
            with self.assertRaises(m.LocationUnavailable) as caught: b.get()
            self.assertEqual(str(caught.exception),'cooldown')
            self.assertEqual(caught.exception.retry_seconds,89)
            self.assertEqual(remote.call_count,1)
            self.assertEqual(a.get()['vehicles'][0]['id'],'123')
            clock[0]=90; remote.return_value=Body(data('204000182'))
            second=b.get(); self.assertEqual(second['routeId'],'204000182')
            self.assertEqual(second['vehicles'][0]['id'],'123')
            self.assertNotIn('PRIVATE_PLATE',json.dumps(second))
            self.assertEqual(remote.call_count,2)

    def test_failure_still_uses_global_gate_and_never_reveals_key(self):
        with patch.object(m.time,'monotonic',return_value=0), patch.object(m,'urlopen',side_effect=URLError('PRIVATE_TEST_KEY')) as remote:
            gate=m.RequestGate()
            a=m.LiveBusLocations(self.env,STOPS,route_id='204000017',request_gate=gate)
            b=m.LiveBusLocations(self.env,STOPS,route_id='204000182',request_gate=gate)
            with self.assertRaisesRegex(m.LocationUnavailable,'^network$'): a.get()
            with self.assertRaisesRegex(m.LocationUnavailable,'^cooldown$'): b.get()
            self.assertEqual(remote.call_count,1)

    def test_wrong_route_cannot_match_even_at_same_station(self):
        vehicles,skipped=m.normalize_locations(data('204000017'),STOPS,route_id='204000182')
        self.assertEqual(vehicles,[]); self.assertEqual(skipped,1)


if __name__=='__main__': unittest.main()
