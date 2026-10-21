import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('../web/kiosk/map-state.mjs', import.meta.url);
let state;
if (existsSync(moduleUrl)) state = await import(moduleUrl);
const requireState = () => {
  assert.ok(state, 'Map state implementation is missing');
  return state;
};
const fixture = () => ({
  stops: [
    { visitKey: '228000286:18', stationId: 'same', sequence: 18, lat: 37.27, lng: 127.11 },
    { visitKey: '228000286:19', stationId: 'next-a', sequence: 19, lat: 37.28, lng: 127.11 },
    { visitKey: '228000286:23', stationId: 'same', sequence: 23, lat: 37.27, lng: 127.11 },
    { visitKey: '228000286:24', stationId: 'next-b', sequence: 24, lat: 37.27, lng: 127.12 },
    { visitKey: '228000286:43', stationId: 'last', sequence: 43, lat: 37.29, lng: 127.09 },
  ],
  facilities: [
    { id: 'A', name: '도서관', reviewStatus: 'normal_review' },
    { id: 'B', name: '학교', reviewStatus: 'normal_review' },
    { id: 'C', name: '박물관', reviewStatus: 'location_review_first' },
  ],
  links: [
    { visitKey: '228000286:19', facilityId: 'A', distanceM: 200 },
    { visitKey: '228000286:18', facilityId: 'B', distanceM: 300 },
    { visitKey: '228000286:24', facilityId: 'B', distanceM: 100 },
  ],
});

test('non-stopping waypoints cannot be alighting stops or count as stops ahead', () => {
  const p = fixture();
  p.stops[1].name = '모란(경유)';
  p.stops[2].name = '교차로（미정차）';
  p.links = [
    { visitKey: p.stops[1].visitKey, facilityId: 'A', distanceM: 10 },
    { visitKey: p.stops[3].visitKey, facilityId: 'A', distanceM: 400 },
  ];
  const original = structuredClone(p);
  const view = state.makeViewModel(p, p.stops[0].visitKey);
  assert.equal(view.nextStop.visitKey, p.stops[3].visitKey);
  assert.deepEqual(view.boardingStops.map(s => s.visitKey), [p.stops[0], p.stops[3], p.stops[4]].map(s => s.visitKey));
  const info = state.facilityStopInfo(p, p.stops[0].visitKey, 'A');
  assert.equal(info.stop.visitKey, p.stops[3].visitKey);
  assert.equal(info.stopsAway, 1);
  assert.deepEqual(p, original, 'original stop visits and links must remain intact');
});

test('hide a landmark only when no actual stop anywhere on this route is within 500m', () => {
  const p = fixture();
  p.stops[1].name = '모란(경유)';
  p.links = [
    { visitKey: p.stops[1].visitKey, facilityId: 'A', distanceM: 100 },
    { visitKey: p.stops[0].visitKey, facilityId: 'B', distanceM: 500 },
  ];
  const view = state.makeViewModel(p, p.stops[3].visitKey);
  assert.deepEqual(view.displayFacilities.map(f => f.id), ['B'], 'past/opposite real stops still support a landmark');
  assert.equal(state.facilityStopInfo(p, p.stops[3].visitKey, 'A'), null);
  assert.equal(state.facilityStopInfo(p, p.stops[3].visitKey, 'B').kind, 'unavailable');
  p.links.push({ visitKey: p.stops[3].visitKey, facilityId: 'A', distanceM: 501 });
  assert.deepEqual(state.makeViewModel(p, p.stops[3].visitKey).displayFacilities.map(f => f.id), ['B']);
});

test('saved six routes and both kiosks remove only unsupported landmarks and preserve source paths', async () => {
  const {spawnSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const extraction = spawnSync('python',['-X','utf8','-c',
    "import json; from pathlib import Path; from scripts.map_data import build_payload,load_catalog; w=Path.cwd(); c=load_catalog(w); print(json.dumps([build_payload(w,r['routeId'],s['stationId']) for s in c['stations'] for r in c['routes']]))"],
    {cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  assert.equal(extraction.status,0,extraction.stderr);
  const payloads=JSON.parse(extraction.stdout), expected={'55':[126,80],'351':[82,60],'422':[116,170],'9407':[89,111],'누리4':[77,47],'3-1':[46,30]};
  const allShown=new Set(), removed=[];
  for(const p of payloads){
    const original=JSON.stringify(p),view=state.makeViewModel(p,p.sampleVisitKey);
    assert.deepEqual([view.boardingStops.length,view.displayFacilities.length],expected[p.routeNumber]);
    const realKeys=new Set(p.stops.filter(s=>!/[（(]\s*(?:경유|미정차)\s*[）)]/u.test(s.name)).map(s=>s.visitKey));
    for(const facility of p.facilities.filter(f=>f.reviewStatus==='normal_review')){
      const supported=p.links.some(l=>l.facilityId===facility.id&&realKeys.has(l.visitKey)&&l.distanceM>=0&&l.distanceM<=500);
      const info=state.facilityStopInfo(p,p.sampleVisitKey,facility.id);
      assert.equal(view.displayFacilities.some(f=>f.id===facility.id),supported);
      assert.equal(!!info,supported);
      if(info?.stop)assert.ok(realKeys.has(info.stop.visitKey));
      if(info?.opposite)assert.ok(realKeys.has(info.opposite.stop.visitKey));
      if(supported)allShown.add(facility.id);
      else removed.push({route:p.routeNumber,id:facility.id});
    }
    assert.equal(JSON.stringify(p),original,'No source data, shape vertex or live position visit was removed');
  }
  assert.equal(removed.length,28,'14 route-specific removals in each of the two kiosk directions');
  assert.ok(removed.every(r=>r.route==='9407'));
  assert.ok(removed.some(r=>allShown.has(r.id)),'A facility removed from 9407 remains supported on another route');
});

test('repeated stop uses visit sequence rather than station ID', () => {
  const { makeViewModel } = requireState();
  const before = makeViewModel(fixture(), '228000286:18');
  const after = makeViewModel(fixture(), '228000286:23');
  assert.equal(before.currentStop.stationId, after.currentStop.stationId);
  assert.equal(before.nextStop.visitKey, '228000286:19');
  assert.equal(after.nextStop.visitKey, '228000286:24');
});

test('terminal has no direction or reachable facilities and equal coordinates are skipped', () => {
  const { makeViewModel, bearingDegrees } = requireState();
  const end = makeViewModel(fixture(), '228000286:43');
  assert.equal(end.ended, true);
  assert.equal(end.nextStop, null);
  assert.ok(end.displayFacilities.every(f => !f.reachable));
  assert.equal(bearingDegrees({ lat: 37, lng: 127 }, { lat: 37, lng: 127 }), null);
  const p = fixture();
  p.stops[1].lat = p.stops[0].lat;
  const result = makeViewModel(p, '228000286:18');
  assert.equal(result.nextStop.visitKey, '228000286:24');
});

test('facilities stay unique and pending reviews stay off default map', () => {
  const { makeViewModel } = requireState();
  const p = fixture();
  p.facilities.push({ ...p.facilities[0] });
  const result = makeViewModel(p, '228000286:23');
  assert.deepEqual(result.displayFacilities.map(f => [f.id, f.reachable]), [['A', false], ['B', true]]);
  assert.deepEqual(result.pendingFacilities.map(f => f.id), ['C']);
  assert.equal(p.facilities[0].reachable, undefined);
});

test('unknown visit fails and empty facility lists remain usable', () => {
  const { makeViewModel } = requireState();
  assert.throws(() => makeViewModel(fixture(), 'unknown'));
  const p = fixture();
  p.facilities = [];
  p.links = [];
  assert.deepEqual(makeViewModel(p, '228000286:18').displayFacilities, []);
});

test('geographic bearing uses north-zero and east-ninety degrees', () => {
  const { bearingDegrees } = requireState();
  assert.ok(Math.abs(bearingDegrees({ lat: 37, lng: 127 }, { lat: 38, lng: 127 })) < 0.01);
  assert.ok(Math.abs(bearingDegrees({ lat: 37, lng: 127 }, { lat: 37, lng: 128 }) - 90) < 0.5);
  assert.ok(Math.abs(bearingDegrees({ lat: 37, lng: 127 }, { lat: 36, lng: 127 }) - 180) < 0.01);
});

test('landmark names keep all text and facility suffixes within one or two lines', () => {
  const { landmarkNameLines } = requireState();
  assert.equal(typeof landmarkNameLines, 'function', 'Landmark line formatting is missing');
  for (const [name, expected] of [
    ['흥덕도서관', ['흥덕도서관']],
    ['상현고등학교', ['상현고등학교']],
    ['광교푸른숲도서관', ['광교푸른숲', '도서관']],
    ['용인한얼초등학교', ['용인한얼', '초등학교']],
    ['광교호수중학교', ['광교호수', '중학교']],
    ['가나다라마바사아', ['가나다라', '마바사아']],
  ]) {
    const lines = landmarkNameLines(name);
    assert.deepEqual(lines, expected);
    assert.equal(lines.join(''), name);
    assert.ok(lines.length <= 2);
  }
});

test('station selection keeps the explicit 07159 default and rejects unknown directions', () => {
  const { selectStation } = requireState();
  assert.equal(typeof selectStation, 'function');
  const catalog = { defaultStationId:'206000305', stations:[
    {stationId:'206000305',mobileNo:'07159'}, {stationId:'206000314',mobileNo:'07303'}],
    routes:['55','351','422','9407','누리4','3-1'].map(routeNumber => ({routeNumber, stations:[
      {stationId:'206000305',visitKey:routeNumber+':111'},
      {stationId:'206000314',visitKey:routeNumber+':15'}]}))};
  assert.equal(selectStation(catalog,catalog.defaultStationId).station.mobileNo,'07159');
  assert.deepEqual(selectStation(catalog,'206000314').routes.map(r=>r.routeNumber),
    ['55','351','422','9407','누리4','3-1']);
  assert.throws(()=>selectStation(catalog,'other'));
});

test('signpost follows the nearby route segment rather than a diagonal next-stop bearing', () => {
  const { routeHeadingDegrees } = requireState();
  assert.equal(typeof routeHeadingDegrees, 'function');
  const shape = [{lat:37,lng:127},{lat:37,lng:127.002},{lat:37.002,lng:127.002}];
  const stop = {lat:37.00001,lng:127.001};
  const next = {lat:37.002,lng:127.002};
  assert.ok(Math.abs(routeHeadingDegrees(shape,stop,next)-90)<0.1);
  assert.equal(routeHeadingDegrees(shape,stop,null),null);
});

test('overlapping opposite route segments use the forward direction and absent shapes fall back safely', () => {
  const { routeHeadingDegrees } = requireState();
  assert.equal(typeof routeHeadingDegrees, 'function');
  const shape = [{lat:37,lng:127},{lat:37,lng:127.002},{lat:37,lng:127}];
  const current = {lat:37,lng:127.001};
  assert.ok(Math.abs(routeHeadingDegrees(shape,current,{lat:37,lng:127.002})-90)<0.1);
  assert.ok(Math.abs(routeHeadingDegrees(shape,current,{lat:37,lng:127})-270)<0.1);
  assert.equal(routeHeadingDegrees([],current,{lat:38,lng:127.001}),0);
  assert.equal(routeHeadingDegrees([current,current],current,{lat:38,lng:127.001}),0);
});

const geo = (x,y) => ({lat:37+y/111195.08,lng:127+x/(111195.08*Math.cos(37*Math.PI/180))});

test('route arrows are sparse, inside the viewport and follow both directions of the line',()=>{
  assert.equal(typeof state.routeArrowSamples,'function');
  const points=[{x:0,y:100},{x:600,y:100},{x:600,y:200},{x:0,y:200}];
  const arrows=state.routeArrowSamples(points,600,300);
  assert.deepEqual(arrows.map(p=>Math.round(p.angle)),[0,0,0,0,180,180,180,180]);
  for(const arrow of arrows){
    assert.ok(arrow.x>=10&&arrow.x<=590&&arrow.y>=10&&arrow.y<=290);
    assert.ok(arrow.y===100||arrow.y===200,'Place arrows on the line, not alongside it');
  }
  for(let i=0;i<arrows.length;i++)for(let j=i+1;j<arrows.length;j++)
    assert.ok(Math.hypot(arrows[i].x-arrows[j].x,arrows[i].y-arrows[j].y)>=40);
  assert.equal(state.routeArrowSamples([],600,300).length,0);
  assert.equal(state.routeArrowSamples([{x:20,y:20},{x:20,y:20}],600,300).length,0);
  assert.equal(state.routeArrowSamples([{x:0,y:-100},{x:600,y:-100}],600,300).length,0);
  const north=state.routeArrowSamples([{x:100,y:300},{x:100,y:0}],200,300);
  assert.ok(north.length>0&&north.every(p=>p.angle===-90));
});

const pinch = () => [[-100,-5],[0,0],[100,-5],[150,0],[150,100],[100,5],[0,0],[-100,5]]
  .map(([x,y],i)=>({...geo(x,y),sequence:i+1}));

test('display shape separates opposite lanes pinched at a shared point without changing source coordinates',()=>{
  assert.equal(typeof state.displayRouteShape,'function');
  const shape=pinch(), original=structuredClone(shape);
  const result=state.displayRouteShape(shape);
  assert.deepEqual(shape,original,'Public source coordinates must remain untouched');
  assert.deepEqual(result.map(p=>p.sequence),shape.map(p=>p.sequence));
  assert.ok(Math.abs((result[1].lat-37)*111195.08+5)<0.01,'Eastbound lane must remain south');
  assert.ok(Math.abs((result[6].lat-37)*111195.08-5)<0.01,'Westbound lane must remain north');
  for(const i of [0,2,3,4,5,7])assert.deepEqual(result[i],shape[i]);
});

test('display shape reconstructs paired turning lanes instead of a shared triangular corner',()=>{
  const shape=[[-100,-5],[-40,-5],[10,0],[5,-40],[5,-100],[100,-150],[150,0],
    [100,50],[15,-100],[15,-40],[10,0],[-40,5],[-100,5]].map(([x,y])=>geo(x,y));
  const original=structuredClone(shape), result=state.displayRouteShape(shape);
  for(const [index,x,y] of [[2,5,-5],[10,15,5]]){
    assert.ok(Math.abs((result[index].lat-geo(x,y).lat)*111195.08)<.01,
      'Turning lane must meet its own approach/departure tangents');
    assert.ok(Math.abs((result[index].lng-geo(x,y).lng)*111195.08)<.01);
  }
  assert.deepEqual(shape,original);
  shape.forEach((p,i)=>{if(i!==2&&i!==10)assert.deepEqual(result[i],p);});
});

test('corner correction leaves unsupported, unrelated and oversized turns untouched',()=>{
  const base=[[-100,-5],[-40,-5],[10,0],[5,-40],[5,-100],[100,-150],[150,0],
    [100,50],[15,-100],[15,-40],[10,0],[-40,5],[-100,5]];
  const unrelated=structuredClone(base);unrelated[8]=[100,-100];
  const missingTangent=structuredClone(base);missingTangent[0]=[-40,-5];
  const tooFar=structuredClone(base);tooFar[2]=[50,30];tooFar[10]=[50,30];
  const crossing=[[-100,0],[-40,0],[0,0],[40,0],[100,0],[150,100],
    [100,150],[0,100],[0,40],[0,0],[0,-40],[0,-100]];
  for(const xy of [unrelated,missingTangent,tooFar,crossing]){
    const shape=xy.map(([x,y])=>geo(x,y));
    assert.deepEqual(state.displayRouteShape(shape),shape);
  }
});

test('near-straight opposing lanes with a noisy junction vertex use their outer tangents',()=>{
  const xy=[[34,4],[6,3],[0,0],[-16,0],[-87,-26],[-150,-100],[-150,-150],
    [-83,-33],[-12,-8],[0,0],[6,-3],[33,-2]];
  const shape=xy.map(([x,y])=>geo(x,y)),original=structuredClone(shape);
  const result=state.displayRouteShape(shape);
  assert.ok((result[2].lat-result[9].lat)*111195.08>5,
    'The opposed lanes must not collapse at a single noisy vertex');
  assert.deepEqual(shape,original);
  shape.forEach((p,i)=>{if(i!==2&&i!==9)assert.deepEqual(result[i],p);});
  const fork=structuredClone(xy);fork[11]=[30,-40];
  const differentApproaches=fork.map(([x,y])=>geo(x,y));
  assert.deepEqual(state.displayRouteShape(differentApproaches),differentApproaches,
    'Do not separate a junction when the outer approach directions disagree');
});

test('both saved Songhyeon routes separate their remaining shared junction vertex',async()=>{
  const {readFile}=await import('node:fs/promises');
  for(const [rid,upper,lower] of [['204000182',219,457],['204000155',570,47]]){
    const saved=JSON.parse(await readFile(new URL(`../data/raw/gbis/2026-10-16/imae-kiosk/route-${rid}-line.json`,import.meta.url),'utf8'));
    const shape=saved.response.msgBody.busRouteLineList.map(p=>({sequence:p.lineSeq,lat:p.y,lng:p.x}));
    const original=structuredClone(shape),result=state.displayRouteShape(shape);
    assert.ok((result[upper].lat-result[lower].lat)*111195.08>5,
      `${rid}: Songhyeon opposing lanes still share a junction vertex`);
    assert.deepEqual(shape,original);
  }
});

test('consecutive duplicate vertices do not prevent separation or lose their own visit metadata',()=>{
  const base=pinch();
  const shape=[...base.slice(0,2),{...base[1],sequence:99},...base.slice(2)];
  const original=structuredClone(shape),result=state.displayRouteShape(shape);
  assert.ok((result[7].lat-result[1].lat)*111195.08>9);
  assert.equal(result[1].lat,result[2].lat);assert.equal(result[1].lng,result[2].lng);
  assert.deepEqual(result.map(p=>p.sequence),[1,2,99,3,4,5,6,7,8]);
  assert.deepEqual(shape,original);
});

test('55 Hadaewon duplicate run is separated without dropping any source vertices',async()=>{
  const {readFile}=await import('node:fs/promises');
  const saved=JSON.parse(await readFile(new URL('../data/raw/gbis/2026-10-16/imae-kiosk/route-204000017-line.json',import.meta.url),'utf8'));
  const shape=saved.response.msgBody.busRouteLineList.map(p=>({sequence:p.lineSeq,lat:p.y,lng:p.x}));
  const original=structuredClone(shape),result=state.displayRouteShape(shape);
  assert.ok((result[792].lat-result[234].lat)*111195.08>5,'A duplicate source run must not leave a lane pinch');
  assert.deepEqual(result[234].lat,result[235].lat);assert.equal(result[234].lng,result[235].lng);
  assert.deepEqual(result.map(p=>p.sequence),shape.map(p=>p.sequence));
  assert.deepEqual(shape,original);
});

test('facility focus uses the current stop when nearby, otherwise a future stop before turnaround',()=>{
  assert.equal(typeof state.facilityStopInfo,'function');
  const p=fixture();
  p.stops[3].turn=true;
  p.links=[
    {visitKey:'228000286:18',facilityId:'A',distanceM:141},
    {visitKey:'228000286:19',facilityId:'A',distanceM:90},
    {visitKey:'228000286:18',facilityId:'B',distanceM:30},
    {visitKey:'228000286:24',facilityId:'B',distanceM:200},
    {visitKey:'228000286:43',facilityId:'B',distanceM:10},
  ];
  const nearby=state.facilityStopInfo(p,'228000286:18','A');
  assert.equal(nearby.kind,'nearby');assert.equal(nearby.stop.sequence,18);assert.equal(nearby.distanceM,141);
  const next=state.facilityStopInfo(p,'228000286:19','B');
  assert.equal(next.kind,'alight');assert.equal(next.stop.sequence,24);assert.equal(next.distanceM,200);
  assert.equal(next.stopsAway,2,'Count stop visits, not a gap in sequence numbers');
  p.links=p.links.filter(l=>l.visitKey!=='228000286:24');
  assert.equal(state.facilityStopInfo(p,'228000286:19','B').kind,'unavailable');
  assert.equal(state.facilityStopInfo(p,'228000286:19','B').stop,null);
  assert.equal(state.facilityStopInfo(p,'228000286:19','C'),null,'Do not focus held facilities');
  assert.equal(state.facilityStopInfo(p,'228000286:19','unknown'),null);
  assert.throws(()=>state.facilityStopInfo(p,'unknown','A'));
});

test('facility focus prefers a same-direction past reference over a closer return-leg stop',()=>{
  const p={stops:[{visitKey:'a',sequence:1},{visitKey:'b',sequence:2},{visitKey:'c',sequence:3,turn:true},{visitKey:'d',sequence:4}],
    facilities:[{id:'school',reviewStatus:'normal_review'}],links:[
      {facilityId:'school',visitKey:'a',distanceM:200},
      {facilityId:'school',visitKey:'d',distanceM:120},
      {facilityId:'school',visitKey:'missing',distanceM:1}]};
  const info=state.facilityStopInfo(p,'c','school');
  assert.equal(info.kind,'unavailable');
  assert.equal(info.stop,null,'A reference stop is not a recommended alighting stop');
  assert.equal(info.referenceStop?.visitKey,'a');
  assert.equal(info.referenceKind,'past');
  assert.equal(info.distanceM,200);
  p.links=[{facilityId:'school',visitKey:'a',distanceM:501}];
  assert.equal(state.facilityStopInfo(p,'c','school'),null,'No valid 500m link means the landmark is not selectable');
});

const directionFixture=()=>({
  stations:[{stationId:'here',visitKey:'v5'},{stationId:'other',visitKey:'v1'}],
  stops:[['other','출발'],['east','같은이름'],['turn','회차'],['west','같은이름'],['here','현재'],['end','종점']]
    .map(([stationId,name],i)=>({stationId,name,sequence:i+1,visitKey:`v${i+1}`,turn:i===2,lat:37.39+i*.001,lng:127.12})),
  facilities:[{id:'school',name:'목적지학교',reviewStatus:'normal_review'}],
  links:[{visitKey:'v2',facilityId:'school',distanceM:350},{visitKey:'v4',facilityId:'school',distanceM:420}],
});

test('opposite-direction advice requires a verified kiosk visit with a reachable pre-turn destination',()=>{
  const p=directionFixture(),info=state.facilityStopInfo(p,'v5','school');
  assert.equal(info.kind,'opposite');
  assert.equal(info.stop,null,'Never show a return-side reference as a current-side alighting stop');
  assert.equal(info.opposite.boardingStop.visitKey,'v1');
  assert.equal(info.opposite.stop.visitKey,'v2');
  assert.equal(info.opposite.kind,'alight');
  assert.equal(info.referenceStop.visitKey,'v4');assert.equal(info.referenceKind,'past');
  assert.equal(state.makeViewModel(p,'v5').displayFacilities[0].reachable,false);
  const forward=state.facilityStopInfo(p,'v1','school');
  assert.equal(forward.kind,'alight');assert.equal(forward.stop.visitKey,'v2');
});

test('a nearby future stop works without a same-named or face-to-face opposite stop',()=>{
  const p=directionFixture();p.stops[1].name='다른이름정류장';
  const info=state.facilityStopInfo(p,'v1','school');
  assert.equal(info.kind,'alight');assert.equal(info.stop.name,'다른이름정류장');
  p.links=[p.links[1]];
  assert.equal(state.makeViewModel(p,'v1').displayFacilities[0].reachable,false,
    'A stop after turnaround must not be advertised as reachable in this direction');
});

test('opposite advice does not infer a kiosk pair or send passengers around the turnaround',()=>{
  const p=directionFixture();p.links=[p.links[1]];
  let info=state.facilityStopInfo(p,'v5','school');
  assert.equal(info.kind,'unavailable');assert.equal(info.oppositeChecked,true);
  assert.equal(info.opposite,null,'The opposite kiosk also requires a pre-turn stop');
  p.links.push({visitKey:'v2',facilityId:'school',distanceM:500.001});
  assert.equal(state.facilityStopInfo(p,'v5','school').kind,'unavailable');
  p.links[1].distanceM=500;
  assert.equal(state.facilityStopInfo(p,'v5','school').kind,'opposite');
  p.stations[1].stationId='mismatched';
  info=state.facilityStopInfo(p,'v5','school');
  assert.equal(info.kind,'unavailable');assert.equal(info.oppositeChecked,false);
  assert.equal(state.facilityStopInfo(directionFixture(),'v6','school').kind,'unavailable');
  const noTurn=directionFixture();noTurn.stops[2].turn=false;
  assert.equal(state.facilityStopInfo(noTurn,'v5','school').kind,'unavailable',
    'Different stop IDs without a verified direction boundary do not prove opposite boarding');
});

test('a facility beside the opposite kiosk does not require boarding a bus',()=>{
  const p=directionFixture();p.links=[{visitKey:'v1',facilityId:'school',distanceM:200}];
  const info=state.facilityStopInfo(p,'v5','school');
  assert.equal(info.kind,'opposite');assert.equal(info.opposite.kind,'nearby');
  assert.equal(info.opposite.stop.visitKey,'v1');
});

test('facility focus respects repeated visits, equal-distance ties, terminal and the 500m boundary',()=>{
  assert.equal(typeof state.facilityStopInfo,'function');
  const p=fixture();
  p.links=[{visitKey:'228000286:19',facilityId:'A',distanceM:30},
    {visitKey:'228000286:24',facilityId:'A',distanceM:500},
    {visitKey:'228000286:43',facilityId:'A',distanceM:500}];
  assert.equal(state.facilityStopInfo(p,'228000286:23','A').stop.visitKey,'228000286:24');
  p.links[1].distanceM=500.001;
  assert.equal(state.facilityStopInfo(p,'228000286:23','A').stop.visitKey,'228000286:43');
  p.links[2].distanceM=NaN;
  assert.equal(state.facilityStopInfo(p,'228000286:23','A').kind,'unavailable');
  assert.equal(state.facilityStopInfo(p,'228000286:43','A').kind,'unavailable');
});

test('display shape preserves genuine crossings, turns, identical retraces and large deviations',()=>{
  assert.equal(typeof state.displayRouteShape,'function');
  const paths=[
    [], [geo(0,0)],
    [[-100,0],[0,0],[100,0],[100,100],[50,150],[0,100],[0,0],[0,-100]].map(([x,y])=>geo(x,y)),
    [[-100,0],[0,0],[-100,5],[-150,100],[0,100],[100,5],[0,0],[100,0]].map(([x,y])=>geo(x,y)),
    [[-100,-5],[0,0],[100,-5],[150,50],[200,100],[100,-5],[0,0],[-100,-5]].map(([x,y])=>geo(x,y)),
    pinch().map((p,i)=>i===1||i===6?geo(0,30):p),
  ];
  for(const path of paths)assert.deepEqual(state.displayRouteShape(path),path);
});

const properCrossings=shape=>{
  const scale=Math.cos(shape[0].lat*Math.PI/180);
  const p=shape.map(q=>({x:(q.lng-shape[0].lng)*111195.08*scale,y:(q.lat-shape[0].lat)*111195.08}));
  const crossings=[];
  for(let i=1;i<p.length;i++)for(let j=i+5;j<p.length;j++){
    const a=p[i-1],b=p[i],c=p[j-1],d=p[j];
    const ux=b.x-a.x,uy=b.y-a.y,vx=d.x-c.x,vy=d.y-c.y,den=ux*vy-uy*vx;
    if(Math.abs(den)<1e-8)continue;
    const t=((c.x-a.x)*vy-(c.y-a.y)*vx)/den;
    const s=((c.x-a.x)*uy-(c.y-a.y)*ux)/den;
    if(t>1e-7&&t<1-1e-7&&s>1e-7&&s<1-1e-7)crossings.push([i,j]);
  }
  return crossings;
};

test('six saved routes preserve source visits and genuine crossings while correcting lane pinches',async()=>{
  assert.equal(typeof state.displayRouteShape,'function');
  const {readFile}=await import('node:fs/promises');
  for(const rid of ['204000017','204000182','107000008','204000024','204000155','241215002']){
    const saved=JSON.parse(await readFile(new URL(`../data/raw/gbis/2026-10-16/imae-kiosk/route-${rid}-line.json`,import.meta.url),'utf8'));
    const shape=saved.response.msgBody.busRouteLineList.map(p=>({sequence:p.lineSeq,lat:p.y,lng:p.x}));
    const original=structuredClone(shape), result=state.displayRouteShape(shape);
    assert.deepEqual(shape,original);
    assert.equal(result.length,shape.length);
    assert.deepEqual(result[0],shape[0]);assert.deepEqual(result.at(-1),shape.at(-1));
    assert.deepEqual(result.map(p=>p.sequence),shape.map(p=>p.sequence));
    assert.deepEqual(properCrossings(result),properCrossings(shape),
      `${rid}: Do not introduce new segment crossings or erase existing crossings`);
    let changed=0;
    result.forEach((p,i)=>{
      const movement=Math.hypot((p.lat-shape[i].lat)*111195.08,
        (p.lng-shape[i].lng)*111195.08*Math.cos(shape[i].lat*Math.PI/180));
      assert.ok(movement<=12.01,'Do not distort the route beyond a small local correction');
      if(movement>0.01)changed++;
    });
    assert.ok(changed>0,`Repeated-lane pinches still uncorrected on ${rid}`);
    if(rid==='204000017'){
      assert.ok((result[910].lat-result[118].lat)*111195.08>8,
        'The reported Bo-pyeong school crossing must stay separated');
      assert.ok((result[931].lat-result[97].lat)*111195.08>6,
        'The reported Pangyo school corner must no longer converge');
      assert.ok((result[931].lng-result[97].lng)*111195.08*Math.cos(result[97].lat*Math.PI/180)>5,
        'Both the horizontal and vertical approaches must remain separated');
    }
  }
});

