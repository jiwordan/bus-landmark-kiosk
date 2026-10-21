"""Tests catch distance-unit, filtering, duplicate and visit-order mistakes."""
import importlib.util
import math
import csv
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'landmark_analysis.py'


class LandmarkAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.analysis = None
        if MODULE_PATH.exists():
            spec = importlib.util.spec_from_file_location('landmark_analysis', MODULE_PATH)
            cls.analysis = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.analysis)

    def require_analysis(self):
        self.assertIsNotNone(self.analysis, 'The landmark analysis module has not been implemented')
        return self.analysis

    def test_distance_uses_metres_and_rejects_invalid_coordinates(self):
        a = self.require_analysis()
        self.assertEqual(a.distance_m(37, 127, 37, 127), 0)
        self.assertAlmostEqual(a.distance_m(0, 0, 0, 1), 111195.08, delta=0.1)
        for coords in [(127, 37, 37, 127), (math.nan, 0, 0, 0), (0, math.inf, 0, 0)]:
            with self.subTest(coords=coords), self.assertRaises(ValueError):
                a.distance_m(*coords)

    def test_normalization_filters_closed_schools_and_small_libraries(self):
        a = self.require_analysis()
        school = {'SCHOOL_ID': 'S1', 'SCHOOL_NM': '학교', 'OPER_STTUS': '운영',
                  'SCHOOL_SE': '초등학교', 'RDNMADR': '경기도 용인시 학교로 1',
                  'LATITUDE': '37.27', 'LONGITUDE': '127.10', 'REFERENCE_DATE': '2026-10-01'}
        library = {'LBRRY_NM': '도서관', 'LBRRY_SE': '공공도서관',
                   'RDNMADR': '경기도 수원시 도서관로 1', 'LATITUDE': '37.27', 'LONGITUDE': '127.10'}
        inputs = {'15021148': [school, dict(school, SCHOOL_ID='S2', OPER_STTUS='폐교'),
                              dict(school, SCHOOL_ID='S3', LONGITUDE='')],
                  '15013109': [library, dict(library, LBRRY_NM='작은문고', LBRRY_SE='작은도서관')],
                  '15017323': []}
        facilities, exclusions = a.normalize(inputs)
        self.assertEqual([f['name'] for f in facilities], ['학교', '도서관'])
        self.assertEqual(sorted(e['reason'] for e in exclusions),
                         ['invalid_coordinates', 'not_operating', 'not_public_library'])

    def test_dedup_keeps_latest_record_but_never_merges_distinct_names_by_coordinate(self):
        a = self.require_analysis()
        museum = {'FCLTY_NM': '첫박물관', 'RDNMADR': '경기도 용인시 상갈로 6',
                  'LATITUDE': '37.27', 'LONGITUDE': '127.10', 'REFERENCE_DATE': '2024-01-01'}
        facilities, exclusions = a.normalize({'15021148': [], '15013109': [],
            '15017323': [museum, dict(museum, REFERENCE_DATE='2025-01-01'),
                         dict(museum, FCLTY_NM='두번째박물관')]})
        self.assertEqual(len(facilities), 2)
        self.assertEqual(facilities[0]['reference_date'], '2025-01-01')
        self.assertEqual(len(facilities[0]['source_record_refs'].split(';')), 2)
        self.assertEqual(exclusions, [])
        self.assertTrue(all('shared_coordinate' in f['quality_flags'] for f in facilities))

    def test_added_park_and_market_sources_filter_park_types_without_claiming_major_status(self):
        # Ignoring the new sources or admitting pocket/children parks loses the agreed scope.
        a = self.require_analysis()
        park = {'MANAGE_NO': 'P1', 'PARK_NM': '근린공원', 'PARK_SE': '근린공원',
                'PARK_AR': '81927', 'RDNMADR': '경기도 용인시 공원로 1',
                'LATITUDE': '37.27', 'LONGITUDE': '127.10', 'REFERENCE_DATE': '2026-08-06'}
        market = {'MRKT_NM': '전통시장', 'MRKT_TYPE': '상설장',
                  'RDNMADR': '경기도 수원시 시장로 1', 'LATITUDE': '37.27', 'LONGITUDE': '127.10'}
        facilities, exclusions = a.normalize({'15012890': [park,
            dict(park, MANAGE_NO='P2', PARK_NM='어린이공원', PARK_SE='어린이공원'),
            dict(park, MANAGE_NO='P3', PARK_NM='소공원', PARK_SE='소공원'),
            dict(park, MANAGE_NO='P4', PARK_NM='묘지공원', PARK_SE='묘지공원')],
            '15012894': [market]})
        self.assertEqual([(f['name'], f['category']) for f in facilities],
                         [('근린공원', '공원 후보'), ('전통시장', '전통시장')])
        self.assertEqual([e['reason'] for e in exclusions], ['not_candidate_park_type'] * 3)
        self.assertEqual(facilities[0]['park_area_m2'], '81927')
        self.assertEqual(facilities[0]['display_review'], 'major_park_status_unverified')
        self.assertEqual(facilities[0]['selected_for_display'], 'not_decided')
        self.assertEqual(facilities[1]['source_provider'], '소상공인시장진흥공단')

    def test_radius_summary_counts_added_types_once_across_multiple_visits(self):
        # Omitting the added types from the summary hides category coverage.
        a = self.require_analysis()
        stops = [{'stationId': 'A', 'stationSeq': str(seq), 'stationName': '정류장',
                  'x': '0', 'y': '0', 'turnSeq': '2', 'turnYn': 'N'} for seq in (1, 3)]
        facilities = [{'facility_id': 'P1', 'name': '공원', 'category': '공원 후보',
                       'latitude': 0, 'longitude': 0},
                      {'facility_id': 'M1', 'name': '시장', 'category': '전통시장',
                       'latitude': 0, 'longitude': 0.0018}]
        summaries = a.summarize(stops, facilities, a.link_facilities(stops, facilities))
        self.assertEqual([(s.get('park_candidates'), s.get('traditional_markets'),
                           s['unique_facilities'], s['visit_facility_pairs']) for s in summaries],
                         [(1, 0, 1, 2), (1, 1, 2, 4), (1, 1, 2, 4)])

    def test_public_open_spaces_group_by_approved_building_not_room_or_manager(self):
        # Room-level counts and inference from the managing office would create false landmarks.
        a = self.require_analysis()
        room = {'OPEN_LC_NM': '광교2동 행정복지센터', 'OPEN_FCLTY_NM': '대회의실',
                'OPEN_FCLTY_TYPE': '회의실', 'RDNMADR': '경기도 수원시 센터로 1',
                'LATITUDE': '37.27', 'LONGITUDE': '127.10', 'REFERENCE_DATE': '2026-06-30'}
        inputs = {'15013117': [room, dict(room, OPEN_FCLTY_NM='소회의실'),
            dict(room, OPEN_LC_NM='공원 족구장', INSTITUTION_NM='영덕1동행정복지센터'),
            dict(room, OPEN_LC_NM='노인복지관', OPEN_FCLTY_NM='강당')],
            '15013205': [{'STATN_NM': '기흥역', 'ROUTE_NM': '분당선',
                'RDNMADR': '경기도 용인시 중부대로 460', 'LATITUDE': '37.275657',
                'LONGITUDE': '127.115944', 'REFERENCE_DATE': '2020-12-31'}]}
        facilities, exclusions = a.normalize(inputs)
        self.assertEqual(sorted((f['name'], f['category']) for f in facilities),
            [('광교2동 행정복지센터', '공공기관'), ('기흥역', '도시철도역'), ('노인복지관', '노인복지관')])
        centre = next(f for f in facilities if f['category'] == '공공기관')
        self.assertEqual(centre['source_record_count'], 2)
        self.assertEqual(len(centre['source_record_refs'].split(';')), 2)
        self.assertEqual([e['reason'] for e in exclusions], ['not_approved_building_type'])
        station = next(f for f in facilities if f['category'] == '도시철도역')
        self.assertEqual(station['coordinate_role'], 'station_representative_point_exit_unverified')

    def test_new_service_categories_are_counted_without_claiming_full_coverage(self):
        a = self.require_analysis()
        stops = [{'stationId': 'A', 'stationSeq': '1', 'stationName': '정류장',
                  'x': '0', 'y': '0', 'turnSeq': '1', 'turnYn': 'Y'}]
        facilities = [{'facility_id': str(i), 'name': category, 'category': category,
                       'latitude': 0, 'longitude': 0}
                      for i, category in enumerate(['공공기관', '도시철도역', '노인복지관'])]
        summaries = a.summarize(stops, facilities, a.link_facilities(stops, facilities))
        self.assertEqual([(s.get('public_offices'), s.get('metro_stations'),
                           s.get('elderly_welfare_centres'), s['unique_facilities']) for s in summaries],
                         [(1, 1, 1, 3)] * 3)

    def test_linking_preserves_repeat_visits_and_radius_comparison_uses_unrounded_distance(self):
        a = self.require_analysis()
        stops = [{'stationId': 'A', 'stationSeq': str(seq), 'stationName': '정류장',
                  'x': '0', 'y': '0', 'turnSeq': '2', 'turnYn': 'N'} for seq in (1, 3)]
        facilities = [{'facility_id': 'S1', 'name': '학교1', 'category': '학교', 'latitude': 0, 'longitude': 0},
                      {'facility_id': 'M1', 'name': '박물관', 'category': '박물관·미술관', 'latitude': 0, 'longitude': 0.0018},
                      {'facility_id': 'S2', 'name': '학교2', 'category': '학교', 'latitude': 0, 'longitude': 0.0036}]
        links = a.link_facilities(stops, facilities)
        self.assertEqual(len(links), 6)
        self.assertEqual({l['station_seq'] for l in links}, {1, 3})
        summary = a.summarize(stops, facilities, links)
        self.assertEqual([(s['radius_m'], s['unique_facilities'], s['visit_facility_pairs'],
                           s['unique_station_facility_pairs'], s['covered_unique_stations']) for s in summary],
                         [(200, 1, 2, 1, 1), (300, 2, 4, 2, 1), (500, 3, 6, 3, 1)])
        self.assertEqual([s['schools'] for s in summary], [1, 1, 2])
        self.assertEqual([s['museums_and_galleries'] for s in summary], [0, 1, 1])

    def test_pipeline_checks_source_count_and_exports_real_rows(self):
        a = self.require_analysis()
        with TemporaryDirectory(dir=MODULE_PATH.parents[1] / 'tests') as temp:
            root = Path(temp)
            raw = root / 'raw'
            raw.mkdir()
            school = {'SCHOOL_ID': 'S1', 'SCHOOL_NM': '학교', 'OPER_STTUS': '운영',
                      'SCHOOL_SE': '초등학교', 'RDNMADR': '경기도 용인시 학교로 1',
                      'LATITUDE': '37.27', 'LONGITUDE': '127.10', 'REFERENCE_DATE': '2026-10-01'}
            for dataset, rows in [('15021148', [school]), ('15017323', []), ('15013109', [])]:
                (raw / f'{dataset}-header.json').write_text(json.dumps({'totalCount': len(rows)}), encoding='utf-8')
                (raw / f'{dataset}-page-1.json').write_text(json.dumps(rows), encoding='utf-8')
            stops_file = root / 'stops.csv'
            stops_file.write_text('stationId,stationSeq,stationName,x,y,turnSeq,turnYn\nA,1,정류장,127.10,37.27,1,Y\n', encoding='utf-8-sig')
            a.run(raw, stops_file, root / 'out')
            with (root / 'out' / 'radius-comparison.csv').open(encoding='utf-8-sig', newline='') as stream:
                summary = list(csv.DictReader(stream))
            self.assertEqual([r['unique_facilities'] for r in summary], ['1', '1', '1'])
            with (root / 'out' / 'candidates-500m.csv').open(encoding='utf-8-sig', newline='') as stream:
                self.assertEqual(next(csv.DictReader(stream))['name'], '학교')
            (raw / '15021148-header.json').write_text('{"totalCount":2}', encoding='utf-8')
            with self.assertRaises(ValueError):
                a.run(raw, stops_file, root / 'bad-output')

    def test_cli_explicitly_includes_additional_sources_and_rejects_incomplete_download(self):
        # Ignoring the flag, silently skipping missing pages or claiming missing types breaks reproducibility.
        with TemporaryDirectory(dir=MODULE_PATH.parents[1] / 'tests') as temp:
            root = Path(temp)
            raw = root / 'raw'
            raw.mkdir()
            park = {'PARK_NM': '근린공원', 'PARK_SE': '근린공원', 'PARK_AR': '81927',
                    'RDNMADR': '경기도 용인시 공원로 1', 'LATITUDE': '37.27', 'LONGITUDE': '127.10'}
            for dataset, rows in [('15021148', []), ('15017323', []), ('15013109', []),
                                  ('15012890', [park]), ('15012894', [])]:
                (raw / f'{dataset}-header.json').write_text(json.dumps({'totalCount': len(rows)}), encoding='utf-8')
                (raw / f'{dataset}-page-1.json').write_text(json.dumps(rows), encoding='utf-8')
            stops_file = root / 'stops.csv'
            stops_file.write_text('stationId,stationSeq,stationName,x,y,turnSeq,turnYn\nA,1,정류장,127.10,37.27,1,Y\n', encoding='utf-8-sig')
            command = [sys.executable, str(MODULE_PATH), '--raw', str(raw), '--stops', str(stops_file),
                       '--output', str(root / 'out'), '--include-parks-markets']
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stderr)
            with (root / 'out' / 'radius-comparison.csv').open(encoding='utf-8-sig', newline='') as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual([(r['unique_facilities'], r['park_candidates']) for r in rows], [('1', '1')] * 3)
            metadata = json.loads((root / 'out' / 'analysis-metadata.json').read_text(encoding='utf-8'))
            self.assertEqual(len(metadata['sources']), 10)
            self.assertNotIn('주요공원', metadata['missing_categories'])
            self.assertIn('백화점·대형마트', metadata['missing_categories'])
            self.assertEqual(metadata['park_landmark_selection'], 'major_park_status_unverified')
            (raw / '15012890-header.json').write_text('{"totalCount":2}', encoding='utf-8')
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Source count mismatch for 15012890', result.stderr)

    def test_cli_public_services_preserves_partial_coverage_and_validates_source_totals(self):
        # A service-only run must not silently drop old sources or imply a complete facility census.
        with TemporaryDirectory(dir=MODULE_PATH.parents[1] / 'tests') as temp:
            root = Path(temp)
            raw = root / 'raw'
            raw.mkdir()
            station = {'STATN_NM': '기흥역', 'ROUTE_NM': '분당선',
                       'RDNMADR': '경기도 용인시 중부대로 460', 'LATITUDE': '37.27', 'LONGITUDE': '127.10'}
            for dataset in ['15021148', '15017323', '15013109', '15012890', '15012894', '15013205', '15013117']:
                records = [station] if dataset == '15013205' else []
                (raw / f'{dataset}-header.json').write_text(json.dumps({'totalCount': len(records)}), encoding='utf-8')
                (raw / f'{dataset}-page-1.json').write_text(json.dumps(records), encoding='utf-8')
            stops_file = root / 'stops.csv'
            stops_file.write_text('stationId,stationSeq,stationName,x,y,turnSeq,turnYn\nA,1,정류장,127.10,37.27,1,Y\n', encoding='utf-8-sig')
            command = [sys.executable, str(MODULE_PATH), '--raw', str(raw), '--stops', str(stops_file),
                       '--output', str(root / 'out'), '--include-public-services']
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stderr)
            metadata = json.loads((root / 'out' / 'analysis-metadata.json').read_text(encoding='utf-8'))
            self.assertEqual(len(metadata['sources']), 14)
            self.assertEqual(metadata['regional_facilities'], 1)
            self.assertEqual(metadata['category_coverage']['metro_stations'], 'partial_registry_exit_unverified')
            self.assertEqual(metadata['category_coverage']['public_offices'], 'partial_open_space_registry')
            self.assertIn('종합병원·보건소', metadata['missing_categories'])
            (raw / '15013205-header.json').write_text('{"totalCount":2}', encoding='utf-8')
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Source count mismatch for 15013205', result.stderr)


if __name__ == '__main__':
    unittest.main()
