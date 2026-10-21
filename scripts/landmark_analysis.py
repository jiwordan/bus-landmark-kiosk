"""Exploratory spherical-distance analysis, not a walking-accessibility result.

No network requests or credential access. Reads preserved source JSON and stops CSV.
GBIS datum is not explicitly confirmed: results must remain provisional.
"""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import re


BASE_DATASETS = ('15021148', '15017323', '15013109')
ADDITIONAL_DATASETS = ('15012890', '15012894')
DATASETS = BASE_DATASETS + ADDITIONAL_DATASETS
SERVICE_DATASETS = ('15013205', '15013117')
ALL_DATASETS = DATASETS + SERVICE_DATASETS
OFFICE_NAME = re.compile(r'(?:시청|구청|주민센터|행정복지센터|동사무소|읍사무소|면사무소|우체국)$')
PARK_TYPES = {'근린공원', '문화공원', '역사공원', '수변공원', '체육공원'}
RADII = (200, 300, 500)
REGION = re.compile(r'경기도\s+(?:수원시|용인시)')


def distance_m(lat1, lon1, lat2, lon2):
    """Great-circle approximation in metres using mean Earth radius 6,371,008.8m."""
    values = (lat1, lon1, lat2, lon2)
    if not all(math.isfinite(v) for v in values):
        raise ValueError('Non-finite coordinate')
    if not (-90 <= lat1 <= 90 and -90 <= lat2 <= 90 and -180 <= lon1 <= 180 and -180 <= lon2 <= 180):
        raise ValueError('Coordinate outside longitude/latitude bounds')
    lat1, lat2, dlon = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1, max(0, h))))


def normalize(inputs, region_pattern=REGION):
    """Keep regional eligible facilities; park eligibility is not major status.

    Deduplicate school ID or name+address within each dataset, preserve source refs,
    flag shared coordinates without merging different facilities.
    """
    unique, exclusions = {}, []
    for dataset in ALL_DATASETS:
        for index, row in enumerate(inputs.get(dataset, []), 1):
            name_field = {'15021148': 'SCHOOL_NM', '15017323': 'FCLTY_NM', '15013109': 'LBRRY_NM',
                          '15012890': 'PARK_NM', '15012894': 'MRKT_NM',
                          '15013205': 'STATN_NM', '15013117': 'OPEN_LC_NM'}[dataset]
            name = str(row.get(name_field) or '').strip()
            road = str(row.get('RDNMADR') or '').strip()
            lot = str(row.get('LNMADR') or '').strip()
            address = road or lot
            ref = row.get('_source_record_ref', f'{dataset}:record-{index}')
            reason = ''
            if region_pattern is not None and not region_pattern.search(road + ' ' + lot):
                reason = 'outside_region'
            elif dataset == '15021148' and row.get('OPER_STTUS') != '운영':
                reason = 'not_operating'
            elif dataset == '15013109' and row.get('LBRRY_SE') != '공공도서관':
                reason = 'not_public_library'
            elif dataset == '15012890' and row.get('PARK_SE') not in PARK_TYPES:
                reason = 'not_candidate_park_type'
            elif dataset == '15013117' and not (OFFICE_NAME.search(name) or name.endswith('노인복지관')):
                reason = 'not_approved_building_type'
            elif not name:
                reason = 'missing_name'
            try:
                lat, lon = float(row.get('LATITUDE')), float(row.get('LONGITUDE'))
                distance_m(lat, lon, lat, lon)
                if not (35 <= lat <= 39 and 126 <= lon <= 129):
                    raise ValueError('Outside regional coordinate range')
            except (ValueError, TypeError):
                if not reason:
                    reason = 'invalid_coordinates'
                lat = lon = None
            if reason:
                exclusions.append({'source_dataset': dataset, 'source_record_ref': ref, 'name': name,
                                   'address': address, 'reason': reason})
                continue
            category = {'15021148': '학교', '15017323': '박물관·미술관', '15013109': '공공도서관',
                        '15012890': '공원 후보', '15012894': '전통시장',
                        '15013205': '도시철도역',
                        '15013117': '노인복지관' if name.endswith('노인복지관') else '공공기관'}[dataset]
            canonical = re.sub(r'\s+', '', name + '|' + address)
            identity = str(row.get('SCHOOL_ID') or canonical) if dataset == '15021148' else canonical
            key = dataset + ':' + identity
            facility_id = dataset + ':' + (identity if dataset == '15021148' else hashlib.sha256(identity.encode()).hexdigest()[:16])
            facility = {'facility_id': facility_id, 'name': name, 'category': category,
                        'source_subtype': row.get('SCHOOL_SE') or row.get('FCLTY_TYPE') or row.get('LBRRY_SE') or row.get('PARK_SE') or row.get('MRKT_TYPE') or row.get('ROUTE_NM') or row.get('OPEN_FCLTY_TYPE') or '',
                        'address': address, 'latitude': lat, 'longitude': lon,
                        'source_dataset': dataset, 'source_url': f'https://www.data.go.kr/data/{dataset}/standard.do',
                        'source_provider': row.get('INSTT_NM') or row.get('INSTITUTION_NM')
                            or ('소상공인시장진흥공단' if dataset == '15012894' else ''),
                        'reference_date': row.get('REFERENCE_DATE') or '',
                        'source_record_refs': ref, 'source_record_count': 1, 'quality_flags': '',
                        'coordinate_role': 'station_representative_point_exit_unverified' if dataset == '15013205' else 'source_facility_point_entrance_unverified',
                        'access_review': 'unverified', 'selected_for_display': 'not_decided',
                        'park_area_m2': str(row.get('PARK_AR') or '') if dataset == '15012890' else '',
                        'display_review': 'major_park_status_unverified' if dataset == '15012890' else 'recognition_unverified'}
            if key in unique:
                previous = unique[key]
                refs = previous['source_record_refs'] + ';' + ref
                count = previous['source_record_count'] + 1
                flags = previous['quality_flags']
                if (previous['latitude'], previous['longitude']) != (lat, lon):
                    flags = ';'.join(filter(None, [flags, 'duplicate_coordinate_conflict']))
                if facility['reference_date'] < previous['reference_date']:
                    facility = previous
                facility.update(source_record_refs=refs, source_record_count=count, quality_flags=flags)
            unique[key] = facility
    facilities = list(unique.values())
    coordinates = {}
    for facility in facilities:
        coordinates.setdefault((round(facility['latitude'], 6), round(facility['longitude'], 6)), []).append(facility)
    for group in coordinates.values():
        if len(group) > 1:
            for facility in group:
                facility['quality_flags'] = ';'.join(filter(None, [facility['quality_flags'], 'shared_coordinate']))
    return facilities, exclusions


def link_facilities(stops, facilities, route_id='228000286'):
    """Preserve every visit of every stop, retain links within 500m unrounded."""
    links = []
    for stop in stops:
        if 'routeId' in stop and str(stop['routeId']) != route_id:
            raise ValueError('Stop does not belong to analysis route')
        seq = int(stop['stationSeq'])
        for facility in facilities:
            distance = distance_m(float(stop['y']), float(stop['x']), facility['latitude'], facility['longitude'])
            if distance <= 500:
                links.append({'route_id': route_id, 'visit_key': f'{route_id}:{seq}',
                              'station_id': str(stop['stationId']), 'station_seq': seq,
                              'station_name': stop['stationName'], 'turn_seq': int(stop['turnSeq']),
                              'turn_yn': stop['turnYn'], 'facility_id': facility['facility_id'],
                              'facility_name': facility['name'], 'category': facility['category'],
                              'distance_m': distance,
                              'within_200m': distance <= 200, 'within_300m': distance <= 300,
                              'within_500m': True,
                              'distance_status': 'provisional_great_circle_not_walking',
                              'access_review': 'unverified'})
    return links


def summarize(stops, facilities, links):
    """Counts distinguish deduplicated facilities, stop IDs and visit records."""
    summaries = []
    total_ids = len({str(s['stationId']) for s in stops})
    for radius in RADII:
        subset = [link for link in links if link['distance_m'] <= radius]
        ids = {link['facility_id'] for link in subset}
        covered = {link['station_id'] for link in subset}
        categories = {category: sum(f['category'] == category and f['facility_id'] in ids for f in facilities)
                      for category in ('학교', '박물관·미술관', '공공도서관', '공원 후보', '전통시장', '공공기관', '도시철도역', '노인복지관')}
        degrees = [sum(link['station_id'] == station for link in
                       { (l['station_id'], l['facility_id']): l for l in subset }.values()) for station in covered]
        summaries.append({'radius_m': radius, 'unique_facilities': len(ids), 'schools': categories['학교'],
                          'museums_and_galleries': categories['박물관·미술관'], 'public_libraries': categories['공공도서관'],
                          'park_candidates': categories['공원 후보'], 'traditional_markets': categories['전통시장'],
                          'public_offices': categories['공공기관'], 'metro_stations': categories['도시철도역'],
                          'elderly_welfare_centres': categories['노인복지관'],
                          'visit_facility_pairs': len(subset),
                          'unique_station_facility_pairs': len({(l['station_id'], l['facility_id']) for l in subset}),
                          'covered_unique_stations': len(covered), 'total_unique_stations': total_ids,
                          'covered_stop_visits': len({l['station_seq'] for l in subset}),
                          'total_stop_visits': len(stops), 'max_facilities_per_station': max(degrees, default=0),
                          'quality_flagged_facilities': sum(bool(f.get('quality_flags')) for f in facilities if f['facility_id'] in ids),
                          'status': 'provisional_partial_category_coverage'})
    return summaries


def run(raw_directory, stops_path, output_directory, datasets=BASE_DATASETS,
        region_pattern=REGION, route_id='228000286'):
    """Validate complete downloads, calculate and export source-traceable analysis."""
    inputs, sources = {}, []
    for dataset in datasets:
        header_path = raw_directory / f'{dataset}-header.json'
        header = json.loads(header_path.read_text(encoding='utf-8-sig'))
        rows = []
        pages = sorted(raw_directory.glob(f'{dataset}-page-*.json'), key=lambda p: int(p.stem.rsplit('-', 1)[1]))
        for path in pages:
            records = json.loads(path.read_text(encoding='utf-8-sig'))
            if not isinstance(records, list):
                raise ValueError(f'Not an array: {path.name}')
            for index, record in enumerate(records, 1):
                rows.append(dict(record, _source_record_ref=f'{path.name}#record-{index}'))
        if len(rows) != header['totalCount']:
            raise ValueError(f'Source count mismatch for {dataset}')
        inputs[dataset] = rows
        for path in [header_path, *pages]:
            sources.append({'source_dataset': dataset, 'file': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                            'downloaded_rows': len(rows), 'expected_rows': header['totalCount']})
    with stops_path.open(encoding='utf-8-sig', newline='') as stream:
        stops = list(csv.DictReader(stream))
    facilities, exclusions = normalize(inputs, region_pattern=region_pattern)
    links = link_facilities(stops, facilities, route_id=route_id)
    summaries = summarize(stops, facilities, links)
    candidates = []
    for facility in facilities:
        related = [link for link in links if link['facility_id'] == facility['facility_id']]
        if related:
            nearest = min(related, key=lambda link: link['distance_m'])
            candidates.append(dict(facility, nearest_station_id=nearest['station_id'],
                nearest_station_seq=nearest['station_seq'], nearest_station_name=nearest['station_name'],
                nearest_distance_m=nearest['distance_m'],
                within_200m=nearest['distance_m'] <= 200, within_300m=nearest['distance_m'] <= 300))
    candidates.sort(key=lambda f: (f['category'], f['nearest_distance_m'], f['name']))
    output_directory.mkdir(parents=True, exist_ok=True)
    exports = {'facilities-regional.csv': (facilities, ['facility_id', 'name']),
               'candidates-500m.csv': (candidates, ['facility_id', 'name']),
               'stop-facility-links-500m.csv': (links, ['station_id', 'station_seq', 'facility_id', 'distance_m']),
               'radius-comparison.csv': (summaries, ['radius_m', 'unique_facilities']),
               'excluded-records.csv': (exclusions, ['source_dataset', 'source_record_ref', 'name', 'address', 'reason'])}
    for filename, (records, fallback) in exports.items():
        with (output_directory / filename).open('w', encoding='utf-8-sig', newline='') as stream:
            writer = csv.DictWriter(stream, fieldnames=list(records[0]) if records else fallback)
            writer.writeheader()
            writer.writerows(records)
    (output_directory / 'analysis-metadata.json').write_text(json.dumps({
        'sources': sources, 'regional_facilities': len(facilities), 'candidate_facilities_500m': len(candidates),
        'route_id': route_id, 'address_region_filter': region_pattern.pattern if region_pattern else None,
        'exclusion_counts': {reason: sum(e['reason'] == reason for e in exclusions) for reason in sorted({e['reason'] for e in exclusions})},
        'radii_m': RADII, 'distance_method': 'Haversine, mean Earth radius 6371008.8m',
        'crs_status': 'GBIS x/y treated as longitude/latitude; datum not explicitly confirmed; exploratory only',
        'missing_categories': ['대학교']
            + (['버스터미널'] if '15013205' in datasets else ['교통거점'])
            + (['종합병원·보건소'] if '15013117' in datasets else ['공공기관', '의료·복지'])
            + ([] if '15012890' in datasets else ['주요공원'])
            + (['백화점·대형마트'] if '15012894' in datasets else ['주요상업시설']),
        'category_coverage': {
            'public_offices': 'partial_open_space_registry' if '15013117' in datasets else 'not_collected',
            'elderly_welfare_centres': 'partial_open_space_registry' if '15013117' in datasets else 'not_collected',
            'metro_stations': 'partial_registry_exit_unverified' if '15013205' in datasets else 'not_collected'},
        'park_landmark_selection': 'major_park_status_unverified' if '15012890' in datasets else 'not_collected',
        'walking_accessibility': 'unverified', 'effect_on_older_users': 'not_measured',
        'summary': summaries}, ensure_ascii=False, indent=2), encoding='utf-8')
    return summaries


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, default=Path('data/raw/facilities/2026-10-11'))
    parser.add_argument('--stops', type=Path, default=Path('data/processed/yongin-55/stops.csv'))
    parser.add_argument('--output', type=Path, default=Path('data/processed/yongin-55/landmarks'))
    parser.add_argument('--include-parks-markets', action='store_true', help='Require park and market sources; use a separate output directory to preserve baseline results')
    parser.add_argument('--include-public-services', action='store_true', help='Require all seven sources, including station and approved public-building records')
    args = parser.parse_args()
    datasets = ALL_DATASETS if args.include_public_services else DATASETS if args.include_parks_markets else BASE_DATASETS
    print(json.dumps(run(args.raw, args.stops, args.output, datasets=datasets), ensure_ascii=False, indent=2))
