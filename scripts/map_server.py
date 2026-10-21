"""Loopback-only kiosk server with an explicit public-file allowlist."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from threading import Lock
from urllib.parse import urlsplit, parse_qs

from scripts.map_data import build_payload, load_catalog, ROUTE_ID
from scripts.bus_locations import LiveBusLocations, LocationUnavailable, RequestGate, REFRESH_SECONDS

ASSETS = {'/': ('index.html', 'text/html'), '/index.html': ('index.html', 'text/html'),
          '/styles.css': ('styles.css', 'text/css'), '/app.mjs': ('app.mjs', 'text/javascript'),
          '/map-state.mjs': ('map-state.mjs', 'text/javascript')}


class BadSelection(Exception):
    pass


def parse_selection(workspace, query, include_station=False):
    if not query:
        return ROUTE_ID, None
    allowed = {'routeId','stationId'} if include_station else {'routeId'}
    try:
        params = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=3)
    except ValueError:
        raise BadSelection from None
    if (not params or not params.keys() <= allowed or 'routeId' not in params or
            any(len(v)!=1 or not re.fullmatch(r'[0-9]{9}', v[0]) for v in params.values())):
        raise BadSelection
    rid = params['routeId'][0]
    catalog = load_catalog(workspace)
    if rid not in {r['routeId'] for r in catalog['routes']}:
        raise BadSelection
    sid = params.get('stationId',[catalog['defaultStationId']])[0] if include_station else None
    if sid is not None and sid not in {s['stationId'] for s in catalog['stations']}:
        raise BadSelection
    return rid, sid


def read_map_config(env_path: Path) -> dict:
    lines = env_path.read_text(encoding='utf-8-sig').splitlines() if env_path.exists() else []
    config = {}
    for setting, field in (('NAVER_MAPS_CLIENT_ID', 'clientId'),):
        values = []
        for line in lines:
            match = re.match(r'^\s*' + setting + r'\s*=\s*(.*?)\s*$', line)
            if match:
                values.append(match.group(1).strip().strip('"').strip("'"))
        if len(values) > 1:
            raise ValueError('Duplicate map setting')
        value = values[0] if values and values[0] else None
        if value is not None and not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', value):
            raise ValueError('Invalid map setting')
        config[field] = value
    return config


def make_server(workspace: Path, port: int = 8080) -> ThreadingHTTPServer:
    public_root = (workspace / 'web/kiosk').resolve()
    live = {}
    request_gate = RequestGate()
    live_lock = Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            # Request strings can contain keys; do not log them.
            pass

        def respond(self, status, body, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type + '; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def serve(self):
            try:
                parsed = urlsplit(self.path)
                path = parsed.path
                if path == '/api/config':
                    payload = read_map_config(workspace / '.env.local')
                elif path == '/api/catalog':
                    if parsed.query:
                        raise BadSelection
                    payload = load_catalog(workspace)
                elif path == '/api/map-data':
                    payload = build_payload(workspace, *parse_selection(workspace, parsed.query, True))
                elif path == '/api/bus-locations':
                    rid, _ = parse_selection(workspace, parsed.query)
                    with live_lock:
                        if rid not in live:
                            live[rid] = LiveBusLocations(workspace / '.env.local',
                                build_payload(workspace, rid)['stops'], route_id=rid, request_gate=request_gate)
                        selected_live = live[rid]
                    payload = selected_live.get()
                elif path in ASSETS:
                    name, content_type = ASSETS[path]
                    asset = (public_root / name).resolve()
                    if asset.parent != public_root:
                        self.respond(404, b'{"error":"Not found"}')
                        return
                    self.respond(200, asset.read_bytes(), content_type)
                    return
                else:
                    self.respond(404, b'{"error":"Not found"}')
                    return
                self.respond(200, json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8'))
            except BadSelection:
                self.respond(400, b'{"error":"Invalid route or station selection"}')
            except LocationUnavailable as error:
                payload = {'error': str(error), 'refreshSeconds': REFRESH_SECONDS}
                if error.retry_seconds is not None:
                    payload['retrySeconds'] = error.retry_seconds
                self.respond(429 if str(error)=='cooldown' else 503, json.dumps(payload).encode('utf-8'))
            except FileNotFoundError:
                self.respond(404, b'{"error":"Required file unavailable"}')
            except (ValueError, KeyError, TypeError, OSError):
                self.respond(503, b'{"error":"Map configuration or public data unavailable"}')

        do_GET = serve
        do_HEAD = serve

        def do_POST(self):
            self.respond(405, b'{"error":"Method not allowed"}')

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def main():
    try:
        server = make_server(Path(__file__).resolve().parents[1])
    except OSError:
        print('Cannot start kiosk server: localhost:8080 is unavailable.')
        return 1
    print('Kiosk preview: http://localhost:8080', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
