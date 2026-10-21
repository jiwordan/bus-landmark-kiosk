"""Reconcile current report population against the preserved CSVs independently."""
import hashlib
import json
import re
import unittest
from pathlib import Path
from tests.csv_helpers import rows

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'data/processed/imae-kiosk'


class ReportEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = json.loads((BASE / 'report-2026-10-18/analysis.json').read_text(encoding='utf-8'))

    def test_current_population_and_radii_match_actual_stop_csv_links(self):
        all_candidates, all_display = set(), set()
        for route in self.result['routes']:
            folder = BASE / 'routes' / route['routeId']
            stops = rows(folder / 'stops.csv')
            real = {s['visitKey'] for s in stops if not re.search(r'[（(]\s*(?:경유|미정차)\s*[）)]', s['stationName'])}
            links = [l for l in rows(folder / 'landmarks/stop-facility-links-500m.csv') if l['visit_key'] in real]
            self.assertEqual(route['boardingVisits'], len(real))
            for radius in route['radii']:
                ids = {l['facility_id'] for l in links if float(l['distance_m']) <= radius['radiusM']}
                self.assertEqual(ids, set(radius['facilityIds']))
                self.assertEqual(len(ids), radius['candidates'])
            candidates = set(route['radii'][2]['facilityIds'])
            shown = {r['facility_id'] for r in rows(folder / 'display-review.csv')
                     if r['review_status'] == 'normal_review'} & candidates
            self.assertEqual(shown, {r['facilityId'] for r in route['nameDetails']})
            self.assertEqual(len(shown), route['displayCount'])
            all_candidates.update(candidates)
            all_display.update(shown)
        self.assertEqual((len(all_candidates), len(all_display)), (329, 309))
        self.assertEqual(self.result['names'], {'total': 309, 'explicit': 40, 'abbreviation_review': 18, 'not_explicit': 251})
        self.assertEqual(sum(r['boardingVisits'] for r in self.result['routes']), 536)
        for entry in self.result['manifest']:
            self.assertEqual(hashlib.sha256((ROOT / entry['path']).read_bytes()).hexdigest(), entry['sha256'])

    def test_direction_comparison_uses_current_visible_population(self):
        for direction in self.result['directions']:
            folder = BASE / 'routes' / direction['routeId']
            stops = rows(folder / 'stops.csv')
            by_key = {s['visitKey']: s for s in stops}
            boarding = direction['directions']['details'][0]['boardingVisit']
            start = int(by_key[boarding]['stationSeq'])
            end = min([int(s['stationSeq']) for s in stops if s['turnYn'] == 'Y' and int(s['stationSeq']) >= start] or [10**9])
            eligible = {s['visitKey'] for s in stops if start <= int(s['stationSeq']) <= end}
            links = [l for l in rows(folder / 'landmarks/stop-facility-links-500m.csv')
                     if not re.search(r'[（(]\s*(?:경유|미정차)\s*[）)]', by_key[l['visit_key']]['stationName'])]
            conflicts = 0
            for row in direction['directions']['details']:
                linked = [l for l in links if l['facility_id'] == row['facilityId']]
                self.assertTrue(linked)
                own = [l for l in linked if l['visit_key'] in eligible]
                closest = min(float(l['distance_m']) for l in linked)
                nearest = [l for l in linked if abs(float(l['distance_m']) - closest) <= 1e-6]
                outside = all(l['visit_key'] not in eligible for l in nearest)
                self.assertEqual(outside, row['nearestAllOutside'])
                conflicts += bool(own) and outside
                if own:
                    current = next((l for l in own if l['visit_key'] == boarding), None)
                    choice = current or min(own, key=lambda l: (float(l['distance_m']), int(by_key[l['visit_key']]['stationSeq'])))
                    self.assertEqual(choice['visit_key'], row['chosenVisit'])
            self.assertEqual(conflicts, direction['directions']['summary']['currentAlternativeDespiteNearestOutside'])
        self.assertEqual([s['total'] for s in self.result['totals']], [498, 498])
        self.assertEqual([s['currentAlternativeDespiteNearestOutside'] for s in self.result['totals']], [93, 128])


if __name__ == '__main__':
    unittest.main()
