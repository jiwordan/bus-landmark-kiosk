import { makeViewModel, facilityStopInfo, isBoardingStop, routeHeadingDegrees, displayRouteShape, routeArrowSamples, landmarkNameLines, selectStation } from './map-state.mjs';

const $ = id => document.getElementById(id);
let payload, map, sdkPromise;
let catalog, selectedStationId, selectedRouteId, routeCycle = 0;
let mapAuthFailed = false;
let activeLayers = [];
let routeArrowLayers = [], routeArrowListener, displayShape = [], overviewZoom = null;
let bounds;
let selectedFacilityId = null;
let inspectedStopVisitKey = null;
let busLayers = [], busTimer, busController, busCycle = 0;
const BUS_REFRESH_MS = 90000;
const kinds = {
  '학교': ['🏫', 'school'], '공공도서관': ['📚', 'library'], '공원 후보': ['🌳', 'park'],
  '공공기관': ['🏛', 'office'], '도시철도역': ['🚉', 'station'], '박물관·미술관': ['🏛', 'museum'],
  '전통시장': ['🛒', 'market'], '노인복지관': ['🤝', 'welfare'],
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error('Local map data unavailable');
  return response.json();
}

async function initData() {
  $('data-error').hidden = true;
  $('station-select').disabled = true;
  $('route-list').replaceChildren();
  try {
    catalog = await fetchJson('/api/catalog');
    selectedStationId = catalog.defaultStationId;
    $('station-select').replaceChildren(...catalog.stations.map(station => {
      const option = element('option', '', `${station.mobileNo} · ${station.nextStopName} 방향`);
      option.value = station.stationId;
      return option;
    }));
    $('station-select').value = selectedStationId;
    renderRoutes();
    $('station-select').disabled = false;
  } catch {
    $('data-error').hidden = false;
  }
}

function renderRoutes() {
  const { station, routes } = selectStation(catalog, selectedStationId);
  $('welcome-title').textContent = station.name;
  $('welcome-direction').textContent = `${station.mobileNo} · 다음 정류장 ${station.nextStopName} 방향`;
  $('route-list').replaceChildren(...routes.map(route => {
    const button = element('button', 'route-card');
    button.dataset.routeId = route.routeId;
    const copy = element('span', 'route-card-copy');
    copy.append(element('strong', '', `${route.startName} ↔ ${route.endName}`),
      element('span', '', '전체 노선과 주요 시설 보기'));
    button.append(element('span', 'route-number', route.routeNumber), copy, element('span', '', '→'));
    button.addEventListener('click', () => void openRoute(route.routeId));
    return button;
  }));
}

function disposeMap() {
  stopRouteArrows();
  selectedFacilityId = null;
  inspectedStopVisitKey = null;
  $('destination-info').hidden = true;
  stopBusUpdates();
  for (const layer of activeLayers) layer.setMap(null);
  activeLayers = [];
  map?.destroy();
  map = null;
  bounds = null;
  delete $('map').dataset.sdkReady;
  delete $('map').dataset.routeId;
  $('fit-route').disabled = true;
}

function loadSdk(key) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    mapAuthFailed = false;
    const script = document.createElement('script');
    const fail = (reason = 'network') => {
      $('map').dataset.sdkIssue = ['auth', 'not-ready', 'timeout'].includes(reason) ? reason : 'network';
      clearTimeout(timer); script.remove(); sdkPromise = null; reject(new Error('Map SDK unavailable'));
    };
    const timer = setTimeout(() => fail('timeout'), 15000);
    window.navermap_authFailure = () => {
      mapAuthFailed = true;
      fail('auth');
      if (map) showMapError('auth');
    };
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}`;
    script.onerror = fail;
    script.onload = () => {
      if (mapAuthFailed || typeof window.naver?.maps?.Map !== 'function') return fail('not-ready');
      clearTimeout(timer);
      resolve(window.naver.maps);
    };
    document.head.append(script);
  });
  return sdkPromise;
}

function pointMarker(point, content, zIndex, yAnchor = .5, interactive = false) {
  const maps = window.naver.maps;
  const wrapper = element('div', 'map-overlay');
  if (interactive) {
    wrapper.className += ' interactive';
    content.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      content.click();
    });
  }
  wrapper.style.transform = `translate(-50%, ${-yAnchor * 100}%)`;
  wrapper.append(content);
  return new maps.Marker({ map, position: new maps.LatLng(point.lat, point.lng),
    icon: { content: wrapper, anchor: new maps.Point(0, 0) }, zIndex, clickable: interactive });
}

function fitRoute(clearSelection = true) {
  if (!map) return;
  if (clearSelection && (selectedFacilityId || inspectedStopVisitKey)) {
    selectedFacilityId = null;
    inspectedStopVisitKey = null;
    updateView();
  }
  map.autoResize();
  map.fitBounds(bounds, { top: 100, right: 100, bottom: 70, left: 100 });
  overviewZoom = map.getZoom();
  clearRouteArrows();
}

function clearRouteArrows() {
  for (const layer of routeArrowLayers) layer.setMap(null);
  routeArrowLayers = [];
}

function stopRouteArrows() {
  clearRouteArrows();
  if (routeArrowListener) window.naver.maps.Event.removeListener(routeArrowListener);
  routeArrowListener = null;
  displayShape = [];
  overviewZoom = null;
}

function renderRouteArrows() {
  clearRouteArrows();
  if (!map || $('map').dataset.sdkReady !== 'true' || !displayShape.length
    || map.getZoom() < 17 || (overviewZoom !== null && map.getZoom() <= overviewZoom)) return;
  const maps = window.naver.maps, projection = map.getProjection(), size = map.getSize();
  const points = displayShape.map(p => projection.fromCoordToOffset(new maps.LatLng(p.lat,p.lng)));
  for (const sample of routeArrowSamples(points,size.width,size.height)) {
    const coord = projection.fromOffsetToCoord(new maps.Point(sample.x,sample.y));
    const arrow = element('span','route-arrow');
    arrow.setAttribute('aria-hidden','true');
    arrow.style.transform = `rotate(${sample.angle}deg)`;
    arrow.dataset.angle = String(sample.angle);
    routeArrowLayers.push(pointMarker({lat:coord.lat(),lng:coord.lng()},arrow,1,.5));
  }
}

function fitSelection() {
  if (!map || !selectedFacilityId) return;
  const info = facilityStopInfo(payload, $('visit-select').value, selectedFacilityId);
  if (!info) return;
  const maps = window.naver.maps, area = new maps.LatLngBounds();
  const stop = info.stop ?? info.referenceStop;
  const points = [info.facility, ...(stop ? [stop] : [])];
  for (const point of points) area.extend(new maps.LatLng(point.lat, point.lng));
  const lat = points.reduce((sum,p)=>sum+p.lat,0)/points.length;
  const lng = points.reduce((sum,p)=>sum+p.lng,0)/points.length;
  // A minimum extent avoids extreme zoom for coincident facility/stop points.
  area.extend(new maps.LatLng(lat-.001,lng-.001));
  area.extend(new maps.LatLng(lat+.001,lng+.001));
  map.autoResize();
  map.fitBounds(area, { top: 110, right: 105, bottom: 110, left: 105 });
}

function selectFacility(id, fromList = false) {
  if (!map || $('map').dataset.sdkReady !== 'true') return;
  if (!facilityStopInfo(payload, $('visit-select').value, id)) return;
  selectedFacilityId = id;
  inspectedStopVisitKey = null;
  updateView();
  fitSelection();
  if (fromList) [...$('facility-list').querySelectorAll('button')]
    .find(button => button.dataset.facilityId === id)?.focus({preventScroll:true});
  $('destination-info').scrollIntoView?.({block:'start',behavior:'smooth'});
}

function inspectStop(visitKey) {
  if (!map || $('map').dataset.sdkReady !== 'true') return;
  if (!payload.stops.some(stop => stop.visitKey === visitKey && isBoardingStop(stop))) return;
  inspectedStopVisitKey = inspectedStopVisitKey === visitKey ? null : visitKey;
  updateView();
  const cycle = routeCycle;
  // The SDK attaches replacement marker buttons during its next draw frame.
  window.requestAnimationFrame(() => {
    if (cycle !== routeCycle) return;
    [...$('map').querySelectorAll('.stop-label')]
      .find(button => button.dataset?.visitKey === visitKey)?.focus({preventScroll:true});
  });
}

async function waitForBaseTiles(container, cycle) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (cycle !== routeCycle) throw new Error('Route cancelled');
    if (mapAuthFailed) throw new Error('Map authentication failed');
    const loaded = [...container.querySelectorAll('img')].some(image =>
      image.complete && image.naturalWidth >= 128 && image.naturalHeight >= 128);
    if (loaded) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Background map did not load');
}

function showMapError(stage) {
  stopRouteArrows();
  selectedFacilityId = null;
  inspectedStopVisitKey = null;
  $('destination-info').hidden = true;
  stopBusUpdates();
  delete $('map').dataset.sdkReady;
  $('map').dataset.errorStage = stage;
  $('fit-route').disabled = true;
  $('map-message').hidden = false;
  $('map-message-title').textContent = '네이버 지도를 불러오지 못했어요';
  $('map-message-detail').textContent = '인터넷 연결, Client ID, Dynamic Map 선택, 이용 한도와 등록 주소(http://localhost:8080)를 확인해 주세요.';
  $('retry').hidden = false;
  for (const layer of activeLayers) layer.setMap(null);
  activeLayers = [];
  map?.destroy();
  map = null;
  sdkPromise = null;
}

function listFacilities(view) {
  $('facility-count').textContent = `${view.displayFacilities.length}곳 표시 검토 · 직선 반경 500m`;
  $('facility-list').replaceChildren(...view.displayFacilities.map(facility => {
    const [icon] = kinds[facility.category] ?? ['●'];
    const item = element('li', facility.reachable ? '' : 'past');
    const button = element('button', 'facility-button');
    button.type = 'button';
    button.dataset.facilityId = facility.id;
    button.disabled = $('map').dataset.sdkReady !== 'true';
    button.setAttribute('aria-pressed', String(facility.id === selectedFacilityId));
    button.setAttribute('aria-label', `${facility.name}와 연결 정류장 함께 보기`);
    button.addEventListener('click', () => selectFacility(facility.id, true));
    const copy = element('div', '');
    const info = facilityStopInfo(payload,view.currentStop.visitKey,facility.id);
    const status = info.kind === 'nearby' ? '현재 정류장 근처' : info.kind === 'alight' ? '현재 방향에서 하차 가능' :
      info.kind === 'opposite' ? (info.opposite.kind === 'nearby' ? '반대편 정류장 근처' : '반대편에서 탑승 필요') : '현재 방향의 하차 지점 없음';
    copy.append(element('strong', '', facility.name), element('small', '',
      `${facility.category} · ${status}`));
    button.append(element('span', 'list-icon', icon), copy);
    item.append(button);
    return item;
  }));
  $('pending-count').textContent = `확인 중인 후보 ${view.pendingFacilities.length}곳`;
  $('pending-list').replaceChildren(...view.pendingFacilities.map(f =>
    element('li', '', `${f.name} — ${f.reviewNote}`)));
}

function updateView() {
  if (!payload) return;
  const view = makeViewModel(payload, $('visit-select').value);
  const destination = selectedFacilityId ? facilityStopInfo(payload, $('visit-select').value, selectedFacilityId) : null;
  $('destination-info').hidden = !destination;
  $('destination-info').dataset.state = destination?.kind ?? '';
  $('destination-reference').hidden = !destination?.referenceStop;
  if (destination) {
    $('destination-title').textContent = destination.facility.name;
    if (destination.kind === 'opposite') {
      const other = destination.opposite;
      const station = catalog.stations.find(s=>s.stationId===other.boardingStop.stationId);
      const boarding = `반대편 정류장(${station?.mobileNo ?? other.boardingStop.name}${other.nextStopName ? ` · ${other.nextStopName} 방향` : ''})`;
      $('destination-stop').textContent = other.kind === 'nearby' ? '반대편 정류장 근처에 있어요' : '목적지와 반대 방향이에요';
      $('destination-detail').textContent = other.kind === 'nearby' ?
        `${boarding}에서 시설까지 직선 약 ${Math.round(other.distanceM)}m예요. 보행 경로를 확인하세요.` :
        `${destination.facility.name}에 가려면 ${boarding}에서 ${payload.routeNumber}번을 타세요.`;
    } else if (destination.stop) {
      $('destination-stop').textContent = destination.kind === 'nearby' ? '현재 정류장 근처에 있어요' : `${destination.stop.name} 정류장에서 내리세요`;
      $('destination-detail').textContent = `${destination.kind === 'nearby' ? destination.stop.name : `지금부터 ${destination.stopsAway}개 정류장 뒤`} · 시설까지 직선 약 ${Math.round(destination.distanceM)}m`;
    } else {
      $('destination-stop').textContent = destination.oppositeChecked ? '이 노선에서는 가까운 하차 지점을 찾지 못했어요.' : '현재 방향에서는 가까운 하차 지점을 찾지 못했어요.';
      $('destination-detail').textContent = destination.oppositeChecked ? '두 탑승 방향에서 회차 전 직선 500m 이내 하차 지점을 찾지 못했어요. 다른 노선을 확인해 주세요.' : '반대편 탑승 정보는 확인되지 않았어요. 다른 노선·탑승 방향을 확인해 주세요.';
    }
    if (destination.referenceStop) $('destination-reference').textContent =
      `위치 참고 · ${destination.referenceKind === 'past' ? '이미 지난 정류장' : '현재 방향의 하차 지점 아님'} · ${destination.referenceStop.name} · 시설까지 직선 약 ${Math.round(destination.distanceM)}m`;
  }
  $('current-name').textContent = `현재 정류장 · ${view.currentStop.name}`;
  $('direction-note').textContent = view.ended ? '마지막 경유 정류장입니다 · 운행 종료' :
    `다음 정류장 · ${view.nextStop?.name ?? '방향 확인 중'} · 경유 순번 ${view.currentStop.sequence}`;
  listFacilities(view);
  if (!map) return;
  const maps = window.naver.maps;
  for (const layer of activeLayers) layer.setMap(null);
  activeLayers = [];
  const position = point => new maps.LatLng(point.lat, point.lng);
  const overlay = (point, content, zIndex, yAnchor = 1, interactive = false) => {
    activeLayers.push(pointMarker(point, content, zIndex, yAnchor, interactive));
  };
  displayShape = payload.shapeAvailable ? displayRouteShape(payload.shape) : [];
  if (payload.shapeAvailable) {
    activeLayers.push(new maps.Polyline({ map, path: displayShape.map(position), strokeWeight: 8,
      strokeColor: '#248a4f', strokeOpacity: .9, strokeStyle: 'solid', zIndex: 1 }));
  }
  for (const stop of view.boardingStops) {
    const selected = destination?.stop?.visitKey === stop.visitKey;
    const reference = destination?.referenceStop?.visitKey === stop.visitKey;
    const inspected = inspectedStopVisitKey === stop.visitKey;
    const expanded = selected || reference || inspected;
    const marker = element('button', `stop-label${selected ? ' selected-stop' : ''}${reference ? ' reference-stop' : ''}${inspected ? ' inspected-stop' : ''}${expanded && stop.visitKey === view.currentStop.visitKey ? ' current-destination-stop' : ''}`);
    marker.type = 'button';
    marker.setAttribute('aria-label', `${stop.name} ${reference ? '하차 추천 아님 · 위치 참고' : '정류장 이름 보기'}`);
    marker.setAttribute('aria-expanded', String(expanded));
    marker.addEventListener('click', () => inspectStop(stop.visitKey));
    marker.dataset.visitKey = stop.visitKey;
    if (expanded) {
      const name = element('span','stop-name',stop.name);
      if (reference) name.append(element('small','stop-reference-tag',destination.referenceKind === 'past' ? '이미 지난 정류장 · 위치 참고' : '하차 추천 아님 · 위치 참고'));
      marker.append(name);
    }
    marker.title = `${stop.sequence}. ${stop.name}`;
    overlay(stop, marker, inspected ? 11 : expanded ? 10 : 2, .5, true);
  }
  for (const facility of view.displayFacilities) {
    const [icon, kind] = kinds[facility.category] ?? ['●', ''];
    const selected = facility.id === selectedFacilityId;
    const marker = element('button', `landmark ${kind}${facility.reachable ? '' : ' past'}${selected ? ' selected' : ''}`);
    marker.type = 'button';
    marker.setAttribute('aria-label', `${facility.name}와 연결 정류장 함께 보기`);
    marker.setAttribute('aria-pressed', String(selected));
    marker.addEventListener('click', () => selectFacility(facility.id));
    marker.dataset.facilityId = facility.id;
    const name = element('span', 'poi-name');
    name.append(...landmarkNameLines(facility.name).map(line => element('span', '', line)));
    marker.append(element('span', 'poi-icon', icon), name);
    marker.title = `${facility.name} · ${facility.category} · 대표 위치`;
    overlay(facility, marker, selected ? 9 : 4, .5, true);
  }
  const flag = element('div', 'current-marker');
  const label = element('div', 'flag', '여기에 있어요');
  flag.append(label, element('span', 'current-point'));
  const bearing = routeHeadingDegrees(payload.shape, view.currentStop, view.nextStop);
  if (!view.ended && bearing !== null) {
    const sign = element('div', 'signpost');
    const rotation = bearing - 90;
    const radians = rotation * Math.PI / 180;
    const side = Math.sin(radians) > 0.000001 ? -1 : 1;
    const postLength = 48;
    sign.style.transform = `rotate(${rotation}deg)`;
    sign.dataset.heading = String(bearing);
    sign.setAttribute('role', 'img');
    sign.setAttribute('aria-label', '현재 정류장에서 버스가 진행하는 방향');
    const arrow = element('span', 'arrow');
    arrow.setAttribute('aria-hidden', 'true');
    const stem = element('span', 'stem');
    stem.style.top = side === 1 ? `-${postLength}px` : '0px';
    arrow.style.top = `${-postLength * side - 12}px`;
    sign.append(stem, arrow);
    flag.append(sign);
    label.style.left=`${postLength*side*Math.sin(radians)-12}px`;
    label.style.top=`${-postLength*side*Math.cos(radians)-Math.abs(32*Math.sin(radians))-Math.abs(12*Math.cos(radians))-8}px`;
  }
  overlay(view.currentStop, flag, 8, .5);
  renderRouteArrows();
}

function clearBusMarkers() {
  for (const layer of busLayers) layer.setMap(null);
  busLayers = [];
}

function canUpdateBuses() {
  return map && $('map').dataset.sdkReady === 'true' && !$('route-screen').hidden && !document.hidden;
}

function stopBusUpdates() {
  busCycle++;
  clearTimeout(busTimer);
  busController?.abort();
  busController = null;
  clearBusMarkers();
  $('refresh-buses').disabled = false;
  $('live-status').dataset.state = 'idle';
  $('live-status').textContent = '버스 위치 확인 대기';
}

async function refreshBuses() {
  if (!canUpdateBuses() || busController) return;
  clearTimeout(busTimer);
  const cycle = busCycle;
  const routeId = payload.routeId;
  let retryMs = BUS_REFRESH_MS;
  const controller = new AbortController();
  busController = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  $('refresh-buses').disabled = true;
  $('live-status').dataset.state = 'loading';
  $('live-status').textContent = '버스 위치를 확인하는 중이에요';
  try {
    const response = await fetch(`/api/bus-locations?routeId=${encodeURIComponent(routeId)}`, { cache: 'no-store', signal: controller.signal });
    const data = await response.json();
    if (cycle !== busCycle) return;
    if (response.status === 429 && data.error === 'cooldown') {
      const seconds = Number.isFinite(data.retrySeconds) ? Math.max(1, Math.min(90, data.retrySeconds)) : 90;
      retryMs = seconds * 1000;
      clearBusMarkers();
      $('live-status').dataset.state = 'waiting';
      $('live-status').textContent = `호출량 보호를 위해 ${seconds}초 뒤 버스 위치 확인 · 노선 지도는 이용할 수 있어요`;
      return;
    }
    if (!response.ok) throw new Error(data.error === 'auth' || data.error === 'config' ? 'auth' : 'unavailable');
    if (data.routeId !== payload.routeId || !Array.isArray(data.vehicles)
      || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error('unavailable');
    clearBusMarkers();
    for (const bus of data.vehicles) {
      const marker = element('div', 'bus-marker', '🚌');
      marker.title = `${payload.routeNumber}번 버스 · 기준 정류장 ${bus.stationName} · ${bus.state} · 정류장 기준 위치`;
      marker.setAttribute('aria-label', marker.title);
      busLayers.push(pointMarker(bus, marker, 7));
    }
    const time = new Date(data.fetchedAt).toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
    const count = data.vehicles.length;
    $('live-status').dataset.state = count ? 'ok' : 'empty';
    $('live-status').textContent = `${count ? `운행정보 ${count}대` : '조회된 운행 버스가 없어요'} · 조회 ${time} · 90초마다 확인`
      + (data.skippedCount ? ` · 정류장 대응 불가 ${data.skippedCount}건 제외` : '');
  } catch (error) {
    if (cycle !== busCycle) return;
    clearBusMarkers();
    $('live-status').dataset.state = 'error';
    $('live-status').textContent = `${error.message === 'auth' ? '버스 위치 API 이용 권한·인증키를 확인해 주세요' : '버스 위치를 불러오지 못했어요'} · 이전 위치 표시 중단 · 90초 뒤 다시 확인`;
  } finally {
    clearTimeout(timeout);
    if (cycle === busCycle) {
      busController = null;
      $('refresh-buses').disabled = false;
      if (canUpdateBuses()) busTimer = setTimeout(refreshBuses, retryMs);
    }
  }
}

function startBusUpdates() {
  stopBusUpdates();
  void refreshBuses();
}

async function openRoute(routeId = selectedRouteId) {
  if (!catalog || !catalog.routes.some(r => r.routeId === routeId)) return;
  const cycle = ++routeCycle;
  const stationId = selectedStationId;
  selectedRouteId = routeId;
  disposeMap();
  payload = null;
  $('welcome').hidden = true;
  $('route-screen').hidden = false;
  const route = catalog.routes.find(r=>r.routeId===routeId);
  $('route-number').textContent = route.routeNumber;
  $('route-title').textContent = `${route.startName} ↔ ${route.endName}`;
  $('route-legend').textContent = `${route.routeNumber}번 노선`;
  $('route-screen').setAttribute('aria-label',`${route.routeNumber}번 전체 노선 지도`);
  $('map').setAttribute('aria-label',`${route.routeNumber}번 전체 버스 노선`);
  $('facility-list').replaceChildren();
  $('pending-list').replaceChildren();
  $('facility-count').textContent = '노선·시설 확인 중';
  $('pending-count').textContent = '확인 중인 후보';
  $('current-name').textContent = selectStation(catalog,stationId).station.name;
  $('direction-note').textContent = selectStation(catalog,stationId).station.nextStopName + ' 방향';
  $('shape-warning').hidden = true;
  $('map-message').hidden = false;
  $('map-message-title').textContent = '지도를 불러오는 중이에요';
  $('map-message-detail').textContent = '네이버 배경지도에 전체 노선과 주요 시설을 표시합니다.';
  $('retry').hidden = true;
  let stage = 'data';
  try {
    const loaded = await fetchJson(`/api/map-data?routeId=${encodeURIComponent(routeId)}&stationId=${encodeURIComponent(stationId)}`);
    if (cycle !== routeCycle) return;
    if (loaded.routeId !== routeId) throw new Error('Unexpected route');
    payload = loaded;
    const initialView = makeViewModel(payload, payload.sampleVisitKey);
    $('visit-select').replaceChildren(...payload.stops.filter(isBoardingStop).map(stop=>{
      const option=element('option','',`${stop.sequence}. ${stop.name}`);
      option.value=stop.visitKey; return option;
    }));
    $('visit-select').value=payload.sampleVisitKey;
    $('shape-warning').hidden=payload.shapeAvailable;
    updateView();
    stage = 'config';
    const config = await fetchJson('/api/config');
    if (cycle !== routeCycle) return;
    if (!config.clientId) throw new Error('Missing Client ID');
    stage = 'sdk';
    const maps = await loadSdk(config.clientId);
    if (cycle !== routeCycle) return;
    stage = 'map';
    map = new maps.Map($('map'), { center: new maps.LatLng(payload.stops[0].lat, payload.stops[0].lng),
      // Keep road geometry but omit default names and transit symbols.
      mapTypes: new maps.MapTypeRegistry({
        normal: maps.NaverStyleMapTypeOptions.getNormalMap({ overlayType: 'bg.ol' }),
      }),
      zoom: 13, zoomControl: true, zoomControlOptions: { position: maps.Position.RIGHT_CENTER } });
    const ownedMap = map;
    routeArrowListener = maps.Event.addListener(map,'idle',() => { if (map === ownedMap) renderRouteArrows(); });
    stage = 'bounds';
    bounds = new maps.LatLngBounds();
    for (const point of [...payload.shape, ...payload.stops, ...initialView.displayFacilities])
      bounds.extend(new maps.LatLng(point.lat, point.lng));
    stage = 'overlays';
    updateView();
    stage = 'fit';
    fitRoute();
    stage = 'tiles';
    await waitForBaseTiles($('map'), cycle);
    if (cycle !== routeCycle) return;
    if (mapAuthFailed) throw new Error('Map authentication failed');
    $('fit-route').disabled = false;
    $('map-message').hidden = true;
    $('map').dataset.sdkReady = 'true';
    $('map').dataset.routeId = routeId;
    updateView();
    startBusUpdates();
  } catch {
    if (cycle !== routeCycle) return;
    showMapError(stage);
    if (stage === 'data') {
      $('map-message-title').textContent = '선택한 노선 자료를 불러오지 못했어요';
      $('map-message-detail').textContent = '다른 버스를 선택하거나 잠시 후 다시 시도해 주세요.';
    }
  }
}

$('back').addEventListener('click', () => { ++routeCycle; disposeMap(); payload=null; $('route-screen').hidden = true; $('welcome').hidden = false; });
$('station-select').addEventListener('change', () => {
  ++routeCycle; disposeMap(); payload=null;
  selectedStationId=$('station-select').value;
  renderRoutes();
});
$('fit-route').addEventListener('click', fitRoute);
$('visit-select').addEventListener('change', () => { inspectedStopVisitKey = null; updateView(); if (selectedFacilityId) fitSelection(); });
$('retry').addEventListener('click', () => void openRoute());
$('data-retry').addEventListener('click', initData);
$('refresh-buses').addEventListener('click', refreshBuses);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopBusUpdates();
  else if (canUpdateBuses()) startBusUpdates();
});
window.addEventListener('pagehide', stopBusUpdates);
window.addEventListener('resize', () => {
  if (map && !$('route-screen').hidden) {
    if (selectedFacilityId) fitSelection();
    else fitRoute(false);
  }
});
initData();
