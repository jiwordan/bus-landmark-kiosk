"""Reproduce each route's 500m analysis from preserved national sources."""
import csv
import json
from pathlib import Path
from scripts.landmark_analysis import run, ALL_DATASETS
from scripts.collect_imae_routes import write_json, write_csv


def make_reviews(candidates):
    return [{'facility_id':r['facility_id'], 'name':r['name'], 'category':r['category'],
        'review_status':'location_review_first' if r['quality_flags'] else 'normal_review',
        'review_note':('좌표 품질 확인 필요: '+r['quality_flags']) if r['quality_flags'] else
                      '출처·좌표 범위·유형·중복 기초 검토; 현장 위치·인지도·보행 접근 미검증'} for r in candidates]


def prepare(workspace: Path):
    base = workspace / 'data/processed/imae-kiosk'
    catalog = json.loads((base / 'catalog.json').read_text(encoding='utf-8'))
    raw = workspace / 'data/raw/facilities/2026-10-11'
    # Refuse to overwrite previous analyses or human review decisions.
    for route in catalog['routes']:
        root = base / 'routes' / route['routeId']
        if (root / 'landmarks').exists() or (root / 'display-review.csv').exists():
            raise ValueError('analysis-already-exists')
    summaries = []
    for route in catalog['routes']:
        rid = route['routeId']
        root = base / 'routes' / rid
        summary = run(raw, root / 'stops.csv', root / 'landmarks', datasets=ALL_DATASETS,
                      region_pattern=None, route_id=rid)
        with (root / 'landmarks/candidates-500m.csv').open(encoding='utf-8-sig', newline='') as stream:
            candidates = list(csv.DictReader(stream))
        reviews = make_reviews(candidates)
        write_csv(root / 'display-review.csv', reviews,
                  ['facility_id','name','category','review_status','review_note'])
        row = {'routeId':rid, 'routeNumber':route['routeNumber'], 'radii':summary,
               'displayCount':sum(r['review_status']=='normal_review' for r in reviews),
               'pendingCount':sum(r['review_status']!='normal_review' for r in reviews)}
        summaries.append(row)
        print(json.dumps(row,ensure_ascii=False),flush=True)
    write_json(base / 'analysis-summary.json', summaries)
    return summaries


if __name__ == '__main__':
    prepare(Path(__file__).resolve().parents[1])
