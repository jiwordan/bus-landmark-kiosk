"""Read the saved public-data snapshot without reading credentials or changing it."""
import csv
import math
import json
import re
from pathlib import Path

ROUTE_ID = '228000286'
REVIEW_STATES = {'normal_review', 'location_review_first', 'identity_review_first'}


def _rows(path):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def _point(lat, lng):
    lat, lng = float(lat), float(lng)
    if not (math.isfinite(lat) and math.isfinite(lng) and 35 <= lat <= 39 and 126 <= lng <= 129):
        raise ValueError('Invalid public-data coordinate')
    return {'lat': lat, 'lng': lng}


def _unique(rows, key):
    result = {row[key]: row for row in rows}
    if len(result) != len(rows) or '' in result:
        raise ValueError('Duplicate or missing public-data identifier')
    return result


def _ordered(rows):
    rows.sort(key=lambda row: row['sequence'])
    if [row['sequence'] for row in rows] != list(range(1, len(rows) + 1)) or not rows:
        raise ValueError('Missing or duplicate route sequence')
    return rows


def load_catalog(workspace: Path) -> dict:
    catalog = json.loads((workspace / 'data/processed/imae-kiosk/catalog.json').read_text(encoding='utf-8'))
    stations = _unique(catalog['stations'], 'stationId')
    if set(stations) != {'206000305','206000314'} or catalog['defaultStationId'] != '206000305':
        raise ValueError('Invalid kiosk station catalog')
    routes = _unique(catalog['routes'], 'routeId')
    if len(routes) != 6:
        raise ValueError('Incomplete route catalog')
    for rid, route in routes.items():
        if not re.fullmatch(r'[0-9]{9}', rid) or not isinstance(route['shapeAvailable'], bool):
            raise ValueError('Invalid catalog route')
        visits = _unique(route['stations'], 'stationId')
        if visits.keys() != stations.keys():
            raise ValueError('Incomplete station directions')
        for visit in visits.values():
            if not re.fullmatch(re.escape(rid) + r':[1-9][0-9]*', visit['visitKey']):
                raise ValueError('Invalid catalog visit')
    return catalog


def build_payload(workspace: Path, route_id=ROUTE_ID, station_id=None) -> dict:
    legacy = route_id == ROUTE_ID
    if legacy:
        root = workspace / 'data/processed/yongin-55'
        landmarks = root / 'landmarks-v3'
        review_path = workspace / 'data/reviews/landmark-display-review-v1.csv'
        metadata = {'routeId':ROUTE_ID, 'routeNumber':'55', 'dataDate':'2026-10-11',
                    'sampleVisitKey':f'{ROUTE_ID}:1', 'shapeAvailable':True}
    else:
        catalog = load_catalog(workspace)
        route = next((r for r in catalog['routes'] if r['routeId'] == route_id), None)
        station_id = station_id or catalog['defaultStationId']
        selection = next((s for s in route['stations'] if s['stationId']==station_id), None) if route else None
        if not route or not selection:
            raise ValueError('Unknown kiosk route or station')
        root = workspace / 'data/processed/imae-kiosk/routes' / route_id
        landmarks, review_path = root / 'landmarks', root / 'display-review.csv'
        metadata = {**route, 'dataDate':catalog['dataDate'], 'facilityDataDate':'2026-10-11',
                    'sampleVisitKey':selection['visitKey'], 'selectedStationId':station_id}
    shape = []
    for row in _rows(root / 'route-line.csv'):
        if row['routeId'] != route_id:
            raise ValueError('Unexpected bus route')
        shape.append({'sequence': int(row['lineSeq']), **_point(row['y'], row['x'])})
    stops = []
    for row in _rows(root / 'stops.csv'):
        sequence = int(row['stationSeq'])
        if row['routeId'] != route_id or row['visitKey'] != f'{route_id}:{sequence}':
            raise ValueError('Invalid stop visit identity')
        stops.append({'visitKey': row['visitKey'], 'sequence': sequence,
                      'stationId': row['stationId'], 'name': row['stationName'],
                      'turn': row['turnYn'] == 'Y', **_point(row['y'], row['x'])})
    stops = _ordered(stops)
    stop_index = _unique(stops, 'visitKey')
    if metadata['sampleVisitKey'] not in stop_index or (not legacy and
            stop_index[metadata['sampleVisitKey']]['stationId'] != station_id):
        raise ValueError('Catalog does not match route stops')
    if not legacy:
        for selection in metadata['stations']:
            if (selection['visitKey'] not in stop_index or
                    stop_index[selection['visitKey']]['stationId'] != selection['stationId']):
                raise ValueError('Catalog direction does not match stop visit')
    reviews = _unique(_rows(review_path), 'facility_id')
    candidates = _rows(landmarks / 'candidates-500m.csv')
    candidate_index = _unique(candidates, 'facility_id')
    if reviews.keys() != candidate_index.keys():
        raise ValueError('Facility review coverage does not match candidates')
    facilities = []
    for row in candidates:
        review = reviews[row['facility_id']]
        if (review['name'] != row['name'] or review['category'] != row['category']
                or review['review_status'] not in REVIEW_STATES):
            raise ValueError('Invalid facility review identity or status')
        facilities.append({'id': row['facility_id'], 'name': row['name'], 'category': row['category'],
                           'reviewStatus': review['review_status'], 'reviewNote': review['review_note'],
                           'sourceUrl': row['source_url'], 'referenceDate': row['reference_date'],
                           **_point(row['latitude'], row['longitude'])})
    links = []
    pairs = set()
    for row in _rows(landmarks / 'stop-facility-links-500m.csv'):
        visit, facility = row['visit_key'], row['facility_id']
        distance = float(row['distance_m'])
        if (row['route_id'] != route_id or visit not in stop_index or facility not in candidate_index
                or not math.isfinite(distance) or not 0 <= distance <= 500
                or (visit, facility) in pairs):
            raise ValueError('Invalid stop-facility connection')
        stop = stop_index[visit]
        if row['station_id'] != stop['stationId'] or int(row['station_seq']) != stop['sequence']:
            raise ValueError('Connection does not match stop visit')
        pairs.add((visit, facility))
        links.append({'visitKey': visit, 'facilityId': facility, 'distanceM': distance})
    if {link['facilityId'] for link in links} != candidate_index.keys():
        raise ValueError('Candidate has no valid radius connection')
    if metadata['shapeAvailable'] != (len(shape) >= 2):
        raise ValueError('Shape availability mismatch')
    return {**metadata, 'shape':_ordered(shape) if shape else [], 'stops':stops,
            'facilities':facilities, 'links':links}
