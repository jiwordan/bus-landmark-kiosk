"""Retrieve only the current 55 bus positions; credentials and raw responses stay private."""
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
from threading import Lock
import time
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode
from urllib.request import urlopen

ROUTE_ID = '228000286'
REFRESH_SECONDS = 90
API = 'https://apis.data.go.kr/6410000/buslocationservice/v2/getBusLocationListv2'
STATES = {'0': '교차로 통과', '1': '정류소 도착', '2': '정류소 출발'}


class LocationUnavailable(Exception):
    """Carries a fixed public reason, never the upstream URL, key or message."""
    def __init__(self, reason, retry_seconds=None):
        super().__init__(reason)
        self.retry_seconds = retry_seconds


class RequestGate:
    """One process-wide quota window shared by every route and failed attempt."""
    def __init__(self):
        self.lock = Lock()
        self.last_attempt = None

    def try_acquire(self):
        with self.lock:
            now = time.monotonic()
            if self.last_attempt is not None:
                remaining = REFRESH_SECONDS - (now - self.last_attempt)
                if remaining > 0:
                    return math.ceil(remaining)
            self.last_attempt = now
            return 0


def read_service_key(path: Path) -> str:
    try:
        values = [match.group(1).strip().strip('"').strip("'")
                  for line in path.read_text(encoding='utf-8-sig').splitlines()
                  if (match := re.match(r'^\s*DATA_GO_KR_SERVICE_KEY\s*=\s*(.*?)\s*$', line))]
    except OSError:
        raise LocationUnavailable('config') from None
    if len(values) != 1:
        raise LocationUnavailable('config')
    key = unquote(values[0])
    if not re.fullmatch(r'[A-Za-z0-9_+/=-]{8,512}', key):
        raise LocationUnavailable('config')
    return key


def normalize_locations(data, stops, route_id=ROUTE_ID):
    if not isinstance(data, dict):
        raise LocationUnavailable('upstream')
    gate = data.get('OpenAPI_ServiceResponse', {}).get('cmmMsgHeader', {})
    gate_code = str(gate.get('returnReasonCode', ''))
    if gate_code:
        raise LocationUnavailable('auth' if gate_code in {'20', '30', '31'} else 'upstream')
    response = data.get('response')
    if not isinstance(response, dict) or not isinstance(response.get('msgHeader'), dict):
        raise LocationUnavailable('upstream')
    code = str(response['msgHeader'].get('resultCode', ''))
    if code == '4':
        return [], 0
    if code != '0':
        raise LocationUnavailable('upstream')
    body = response.get('msgBody') or {}
    if not isinstance(body, dict):
        raise LocationUnavailable('upstream')
    rows = body.get('busLocationList') or []
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list):
        raise LocationUnavailable('upstream')
    visits = {stop['sequence']: stop for stop in stops}
    vehicles, seen, skipped = [], set(), 0
    for row in rows:
        try:
            if not isinstance(row, dict) or str(row.get('routeId')) != route_id:
                raise ValueError
            sequence = row['stationSeq']
            if not re.fullmatch(r'[0-9]+', str(sequence)):
                raise ValueError
            stop = visits[int(sequence)]
            identity = str(row['vehId'])
            if (str(row['stationId']) != stop['stationId'] or identity in seen
                    or not re.fullmatch(r'[0-9]{1,20}', identity)):
                raise ValueError
        except (KeyError, ValueError, TypeError):
            skipped += 1
            continue
        seen.add(identity)
        vehicles.append({'id': identity, 'sequence': stop['sequence'], 'stationId': stop['stationId'],
                         'stationName': stop['name'], 'lat': stop['lat'], 'lng': stop['lng'],
                         'state': STATES.get(str(row.get('stateCd')), '상태 미확인')})
    return vehicles, skipped


class LiveBusLocations:
    def __init__(self, env_path: Path, stops, route_id=ROUTE_ID, request_gate=None):
        self.env_path, self.stops = env_path, stops
        self.route_id, self.request_gate = route_id, request_gate
        self.lock = Lock()
        self.last_attempt = None
        self.cached = None
        self.error = None

    def get(self):
        # Share a 90-second window across tabs, refresh buttons and failures to limit API usage.
        with self.lock:
            now = time.monotonic()
            if self.last_attempt is None or now - self.last_attempt >= REFRESH_SECONDS:
                if self.request_gate:
                    retry = self.request_gate.try_acquire()
                    if retry:
                        raise LocationUnavailable('cooldown', retry_seconds=retry)
                self.last_attempt, self.cached, self.error = now, None, None
                try:
                    key = read_service_key(self.env_path)
                    url = API + '?' + urlencode({'serviceKey': key, 'routeId': self.route_id, 'format': 'json'})
                    with urlopen(url, timeout=12) as stream:
                        body = stream.read(1_000_001)
                    if len(body) > 1_000_000:
                        raise LocationUnavailable('upstream')
                    vehicles, skipped = normalize_locations(json.loads(body), self.stops, route_id=self.route_id)
                    self.cached = {'routeId': self.route_id, 'vehicles': vehicles, 'skippedCount': skipped,
                                   'fetchedAt': datetime.now(timezone.utc).isoformat(),
                                   'refreshSeconds': REFRESH_SECONDS}
                except HTTPError as error:
                    self.error = 'auth' if error.code in {401, 403} else 'network'
                except LocationUnavailable as error:
                    self.error = str(error)
                except (URLError, OSError, ValueError, KeyError, TypeError, AttributeError):
                    self.error = 'network'
            if self.error:
                raise LocationUnavailable(self.error) from None
            return self.cached
