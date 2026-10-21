"""Catch old-region filtering, wrong route joins and unreviewed facility display."""
from pathlib import Path
import importlib
import math
import unittest
from unittest.mock import patch
from scripts import landmark_analysis as a

ROOT = Path(__file__).resolve().parents[1]


class ImaeAnalysisTests(unittest.TestCase):
    def test_seoul_and_seongnam_survive_unrestricted_normalization(self):
        rows = [{'SCHOOL_ID':str(i), 'SCHOOL_NM':name, 'RDNMADR':address, 'OPER_STTUS':'운영',
                 'LATITUDE':37.4, 'LONGITUDE':127.1} for i,name,address in
                [(1,'이매고등학교','경기도 성남시 탄천로 1'),(2,'서울학교','서울특별시 강남구 도산대로 1')]]
        facilities, excluded = a.normalize({'15021148':rows}, region_pattern=None)
        self.assertEqual([r['name'] for r in facilities], ['이매고등학교','서울학교'])
        self.assertEqual(excluded, [])
        self.assertEqual(a.normalize({'15021148':rows})[0], [])

    def test_route_id_and_repeated_visit_keys(self):
        stops = [{'routeId':'204000017','stationId':'A','stationSeq':seq,'stationName':'반복',
                  'x':127,'y':37,'turnSeq':3,'turnYn':'N'} for seq in [1,3]]
        facility = {'facility_id':'f','name':'시설','category':'학교','latitude':37,'longitude':127}
        links = a.link_facilities(stops,[facility],route_id='204000017')
        self.assertEqual([r['visit_key'] for r in links], ['204000017:1','204000017:3'])
        with self.assertRaises(ValueError): a.link_facilities(stops,[facility],route_id='999')

    def test_500m_boundary_and_500point1_exclusion(self):
        stops = [{'stationId':'A','stationSeq':1,'stationName':'정류장','x':127,'y':37,'turnSeq':1,'turnYn':'N'}]
        facilities = [{'facility_id':str(i),'name':'시설','category':'학교','latitude':37,'longitude':127} for i in [1,2]]
        with patch.object(a,'distance_m',side_effect=[500.0,500.1]):
            self.assertEqual([r['facility_id'] for r in a.link_facilities(stops,facilities,route_id='204000017')],['1'])

    def test_flags_held_out_and_review_covers_candidates(self):
        self.assertTrue((ROOT / 'scripts/prepare_imae_routes.py').exists(), 'Preparation module missing')
        module = importlib.import_module('scripts.prepare_imae_routes')
        rows = [{'facility_id':str(i),'name':'시설','category':'학교','quality_flags':flag}
                for i,flag in [(1,''),(2,'shared_coordinate')]]
        reviews = module.make_reviews(rows)
        self.assertEqual([r['facility_id'] for r in reviews],['1','2'])
        self.assertEqual([r['review_status'] for r in reviews],['normal_review','location_review_first'])
        self.assertIn('미검증',reviews[0]['review_note'])


if __name__ == '__main__': unittest.main()
