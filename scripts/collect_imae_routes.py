"""Collect an immutable official snapshot; never print credentials or request URLs."""
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode, quote
from urllib.request import urlopen

from scripts.bus_locations import read_service_key
from scripts.map_data import _point

ROUTES = {'204000017': '55', '204000182': '351', '107000008': '422',
          '204000024': '9407', '204000155': '누리4', '241215002': '3-1'}
STATIONS = ('206000305', '206000314')
KST = timezone(timedelta(hours=9))


def fetch_response(key, service, operation, **params):
    url = f'https://apis.data.go.kr/6410000/{service}/v2/{operation}?' + urlencode(
        {'serviceKey': key, 'format': 'json', **params})
    try:
        with urlopen(url, timeout=20) as stream:
            body = stream.read(10_000_001)
        if len(body) > 10_000_000 or any(value.encode() in body for value in (key, quote(key, safe=''))):
            raise ValueError('upstream-body')
        result = json.loads(body)
        if not isinstance(result, dict):
            raise ValueError('upstream-body')
        return result
    except (OSError, ValueError, TypeError):
        raise ValueError('upstream-network') from None


def items(data, field, allow_empty=False):
    response = data.get('response', {})
    code = str((response.get('msgHeader') or {}).get('resultCode', ''))
    if code == '4' and allow_empty:
        return []
    if code != '0':
        raise ValueError('upstream-result')
    rows = (response.get('msgBody') or {}).get(field) or []
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list) or (not rows and not allow_empty):
        raise ValueError('upstream-items')
    return rows


def normalize_route(route_id, info, stops, line):
    details = items(info, 'busRouteInfoItem', allow_empty=True)
    detail = details[0] if details else {'routeId': route_id, 'routeName': ROUTES[route_id]}
    if str(detail.get('routeId')) != route_id:
        raise ValueError('route-identity')
    visits = sorted(items(stops, 'busRouteStationList'), key=lambda row: int(row['stationSeq']))
    if [int(s['stationSeq']) for s in visits] != list(range(1, len(visits) + 1)):
        raise ValueError('stop-sequence')
    turn = next((int(s['stationSeq']) for s in visits if s.get('turnYn') == 'Y'), len(visits))
    normalized = []
    for s in visits:
        _point(s['y'], s['x'])
        seq = int(s['stationSeq'])
        normalized.append({'routeId': route_id, 'stationId': str(s['stationId']),
            'stationName': s['stationName'], 'stationSeq': seq, 'turnSeq': int(s.get('turnSeq') or turn),
            'turnYn': s.get('turnYn', 'N'), 'x': s['x'], 'y': s['y'], 'visitKey': f'{route_id}:{seq}'})
    selections = []
    for sid in STATIONS:
        matches = [(i, s) for i, s in enumerate(normalized) if s['stationId'] == sid]
        if len(matches) != 1:
            raise ValueError('station-visit-identity')
        i, s = matches[0]
        if i + 1 == len(normalized):
            raise ValueError('station-visit-terminal')
        selections.append({'stationId': sid, 'visitKey': s['visitKey'],
                           'nextStopName': normalized[i+1]['stationName']})
    shape = []
    for row in sorted(items(line, 'busRouteLineList', allow_empty=True), key=lambda row: int(row['lineSeq'])):
        _point(row['y'], row['x'])
        shape.append({'routeId': route_id, 'lineSeq': int(row['lineSeq']), 'x': row['x'], 'y': row['y']})
    if shape and [r['lineSeq'] for r in shape] != list(range(1, len(shape)+1)):
        raise ValueError('shape-sequence')
    return {'routeId': route_id, 'routeNumber': str(detail.get('routeName', '')),
            'startName': detail.get('startStationName') or normalized[0]['stationName'],
            'endName': detail.get('endStationName') or normalized[turn-1]['stationName'],
            'detailAvailable': bool(details),
            'shapeAvailable': len(shape) >= 2, 'stations': selections, 'stops': normalized, 'shape': shape}


def build_catalog(stations, via, routes):
    if {r['routeId'] for r in routes} != set(ROUTES) or len(routes) != len(ROUTES):
        raise ValueError('route-set-changed')
    public_stations = []
    for sid in STATIONS:
        station = next(s for s in stations if str(s['stationId']) == sid)
        if {str(r['routeId']) for r in via[sid]} != set(ROUTES):
            raise ValueError('station-route-set-changed')
        directions = {s['nextStopName'] for r in routes for s in r['stations'] if s['stationId'] == sid}
        if len(directions) != 1:
            raise ValueError('station-direction-changed')
        public_stations.append({'stationId': sid, 'mobileNo': str(station['mobileNo']).strip().zfill(5),
            'name': station['stationName'], 'nextStopName': directions.pop()})
    return {'dataDate': datetime.now(KST).date().isoformat(), 'defaultStationId': STATIONS[0],
        'stations': public_stations,
        'routes': [{key: value for key, value in r.items() if key not in {'stops', 'shape'}} for r in routes]}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)


def write_csv(path, rows, fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def collect(workspace: Path, output: Path = None, resume=False):
    date = datetime.now(KST).date().isoformat()
    raw = output or workspace / f'data/raw/gbis/{date}/imae-kiosk'
    processed = workspace / 'data/processed/imae-kiosk'
    if processed.exists() or (raw.exists() and not (resume and (raw / '_incomplete.json').exists())):
        raise ValueError('snapshot-already-exists')
    key = read_service_key(workspace / '.env.local')
    sources = []

    def fetch(name, service, operation, **params):
        target = raw / (name + '.json')
        if resume and target.exists():
            data = json.loads(target.read_text(encoding='utf-8'))
        else:
            data = fetch_response(key, service, operation, **params)
            write_json(target, data)
        sources.append({'file': target.name, 'service': service, 'operation': operation, 'parameters': params,
            'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        return data

    try:
        stations = items(fetch('station-search', 'busstationservice', 'getBusStationListv2',
                               keyword='이매고교'), 'busStationList')
        via = {sid: items(fetch(f'station-{sid}-routes', 'busstationservice', 'getBusStationViaRouteListv2',
                              stationId=sid), 'busRouteList') for sid in STATIONS}
        routes = []
        for rid, number in ROUTES.items():
            responses = [fetch(f'route-{rid}-{suffix}', 'busrouteservice', operation, routeId=rid)
                for suffix, operation in [('info','getBusRouteInfoItemv2'), ('stops','getBusRouteStationListv2'),
                                           ('line','getBusRouteLineListv2')]]
            route = normalize_route(rid, *responses)
            if route['routeNumber'] != number:
                raise ValueError('route-number-changed')
            routes.append(route)
        catalog = build_catalog(stations, via, routes)
        for route in routes:
            root = processed / 'routes' / route['routeId']
            write_csv(root / 'stops.csv', route['stops'], list(route['stops'][0]))
            write_csv(root / 'route-line.csv', route['shape'], ['routeId','lineSeq','x','y'])
            write_json(root / 'route-info.json', {k:v for k,v in route.items() if k not in {'shape','stops'}})
        write_json(processed / 'catalog.json', catalog)
        write_json(raw / 'manifest.json', {'collectedAt': datetime.now(KST).isoformat(), 'sources': sources})
        return catalog
    except Exception:
        if raw.exists() and not (raw / '_incomplete.json').exists():
            write_json(raw / '_incomplete.json', {'status':'incomplete', 'sourcesSaved':len(sources)})
        raise ValueError('collection-incomplete') from None


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resume', action='store_true', help='Reuse only a previously incomplete snapshot, without overwriting files')
    args = parser.parse_args()
    try:
        catalog = collect(Path(__file__).resolve().parents[1], resume=args.resume)
        print(json.dumps({'defaultStationId': catalog['defaultStationId'], 'routes': catalog['routes']}, ensure_ascii=False))
    except (ValueError, OSError) as error:
        print('Collection stopped:', str(error) if isinstance(error, ValueError) else 'filesystem')
        raise SystemExit(1) from None
