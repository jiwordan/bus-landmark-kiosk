// Exercise real application event flow; only DOM/map SDK/network boundaries are doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as state from '../web/kiosk/map-state.mjs';

class Element {
  constructor(tag='div') { this.tagName=tag.toUpperCase();this.children=[]; this.dataset={}; this.style={}; this.listeners={}; this.hidden=false; this.value=''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children=[...items]; }
  addEventListener(type,fn) { this.listeners[type]=fn; }
  click() { this.listeners.click?.(); }
  setAttribute(name,value) { this[name]=value; }
  remove() {}
  querySelectorAll() { return []; }
}
const catalog={dataDate:'2026-10-16',defaultStationId:'206000305',stations:[
  {stationId:'206000305',mobileNo:'07159',name:'기준정류장',nextStopName:'안말초교'},
  {stationId:'206000314',mobileNo:'07303',name:'반대편',nextStopName:'매송중학교'}],
  routes:[['204000017','55'],['204000182','351'],['107000008','422'],['204000024','9407'],['204000155','누리4'],['241215002','3-1']]
    .map(([routeId,routeNumber])=>({routeId,routeNumber,startName:'기점',endName:'종점',stations:[
      {stationId:'206000305',visitKey:`${routeId}:1`,nextStopName:'안말초교'},
      {stationId:'206000314',visitKey:`${routeId}:2`,nextStopName:'매송중학교'}]}))};
function payload(rid,sid='206000305') {
  return {...catalog.routes.find(r=>r.routeId===rid),dataDate:'2026-10-16',shapeAvailable:true,
    sampleVisitKey:`${rid}:${sid==='206000305'?1:2}`,stops:[1,2,3].map(i=>({visitKey:`${rid}:${i}`,
      stationId:i===1?'206000305':i===2?'206000314':'last',sequence:i,name:`정류장${i}`,lat:37.39+i/1000,lng:127.12})),
    shape:[{lat:37.39,lng:127.12},{lat:37.4,lng:127.12}],facilities:[],links:[]};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function harness(override, options={}) {
  const nodes=new Map(); const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  get('route-screen').hidden=true;
  const windows={}, instances=[], markers=[], lines=[], scripts=[], timers=new Set(); let tilesReady=!options.deferTiles;
  const maps={
    Map:class {
      constructor(container,options){this.options=options;this.fits=[];this.zoom=13;this.fitZoom=13;this.listeners={};instances.push(this);}
      autoResize(){}fitBounds(bounds){this.fits.push(bounds);this.zoom=this.fitZoom;}
      getZoom(){return this.zoom;}getSize(){return {width:600,height:400};}
      getProjection(){return {
        fromCoordToOffset:p=>({x:(p.lng-127.12)*100000+100,y:(37.395-p.lat)*100000+100}),
        fromOffsetToCoord:p=>({lat:()=>37.395-(p.y-100)/100000,lng:()=>127.12+(p.x-100)/100000}),
      };}
      destroy(){this.destroyed=true;}
    },
    Event:{addListener(map,name,fn){map.listeners[name]=fn;return {map,name};},removeListener(handle){delete handle.map.listeners[handle.name];}},
    MapTypeRegistry:class {constructor(types){this.types=types;}},
    NaverStyleMapTypeOptions:{getNormalMap:options=>options},
    LatLng:class {constructor(lat,lng){this.lat=lat;this.lng=lng;}}, LatLngBounds:class {constructor(){this.points=[];}extend(p){this.points.push(p);}}, Point:class {constructor(x,y){this.x=x;this.y=y;}},
    Marker:class {constructor(options){this.map=options.map;this.position=options.position;this.clickable=options.clickable;this.content=options.icon.content.children[0];this.kind=this.content.className;markers.push(this);}setMap(value){this.map=value;}},
    Polyline:class {constructor(options){this.map=options.map;this.path=options.path;lines.push(this);}setMap(value){this.map=value;}}, Position:{RIGHT_CENTER:1}};
  get('map').querySelectorAll=()=>tilesReady?[{complete:true,naturalWidth:256,naturalHeight:256}]:[];
  const document={getElementById:get,createElement:tag=>new Element(tag),hidden:false,
    addEventListener(){},head:{append(script){scripts.push(script);if(!options.deferSdk)queueMicrotask(()=>script.onload());}}};
  const context=vm.createContext({...state,document,window:{naver:{maps},requestAnimationFrame:fn=>queueMicrotask(fn),addEventListener:(name,fn)=>windows[name]=fn},
    AbortController,Date,console,encodeURIComponent,URLSearchParams,
    setTimeout:(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timer.unref();timers.add(timer);return timer;},
    clearTimeout:timer=>{timers.delete(timer);clearTimeout(timer);},
    fetch:async(path,options)=>{
      const result=override?.(path,options); if(result) return result;
      if(path==='/api/catalog')return {ok:true,json:async()=>structuredClone(catalog)};
      if(path==='/api/config')return {ok:true,json:async()=>({clientId:'browserTestOnly'})};
      const url=new URL(path,'http://localhost');
      if(url.pathname==='/api/map-data')return {ok:true,json:async()=>payload(url.searchParams.get('routeId'),url.searchParams.get('stationId'))};
      return {ok:false,status:429,json:async()=>({error:'cooldown',retrySeconds:70})};
    }});
  const source=(await readFile(new URL('../web/kiosk/app.mjs',import.meta.url),'utf8')).replace(/^import .*?;\r?\n/,'');
  vm.runInContext(source+'\nglobalThis.actions={openRoute,initData};',context);
  await tick();
  return {get,actions:context.actions,instances,markers,lines,scripts,timers,resize:()=>windows.resize(),
    releaseSdk:()=>scripts[0].onload(),releaseTiles:()=>{tilesReady=true;},
    close:()=>{windows.pagehide?.();for(const timer of timers)clearTimeout(timer);}};
}

test('route waypoints stay in source geometry but not stop markers, visit options or facility choices',async()=>{
  const rid = '204000024';
  const p = payload(rid);
  p.stops[1].name = '모란(경유)';
  p.facilities = ['virtual-only','real'].map(id=>({id,name:id,category:'학교',reviewStatus:'normal_review',lat:37.395,lng:127.12}));
  p.links = [
    {visitKey:`${rid}:2`,facilityId:'virtual-only',distanceM:100},
    {visitKey:`${rid}:2`,facilityId:'real',distanceM:50},
    {visitKey:`${rid}:3`,facilityId:'real',distanceM:400},
  ];
  const original = structuredClone(p);
  const h = await harness(path=>path.startsWith('/api/map-data')?{ok:true,json:async()=>p}:null);
  try {
    await h.actions.openRoute(rid);
    const stops = h.markers.filter(m=>m.map&&m.kind==='stop-label');
    assert.equal(stops.length,2);
    assert.equal(h.get('visit-select').children.length,2);
    assert.equal(h.markers.filter(m=>m.map&&m.kind.includes('landmark')).length,1);
    assert.equal(h.get('facility-list').children.length,1);
    assert.equal(h.lines.find(l=>l.map).path.length,p.shape.length);
    assert.deepEqual(p,original);
  } finally {h.close();}
});

test('welcome shows six routes for 07159 and opening another route changes identity',async()=>{
  const h=await harness();
  try {
    assert.equal(h.get('route-list').children.length,6);
    assert.equal(h.get('station-select').value,'206000305');
    await h.actions.openRoute('204000182');
    await tick();
    assert.equal(h.get('map').dataset.routeId,'204000182');
    assert.equal(h.get('visit-select').value,'204000182:1');
    assert.match(h.get('live-status').textContent,/70/);
    h.get('station-select').value='206000314';
    h.get('station-select').listeners.change();
    await h.actions.openRoute('204000017');
    assert.equal(h.get('visit-select').value,'204000017:2');
  } finally {h.close();}
});

test('every route keeps road geometry without default names or transit layers',async()=>{
  const h=await harness();
  try {
    for(const route of catalog.routes){
      await h.actions.openRoute(route.routeId);
      assert.equal(h.instances.at(-1).options.mapTypes?.types.normal.overlayType,'bg.ol',
        'Keep road geometry but do not request default names or transit layers');
      assert.equal(h.markers.filter(m=>m.map&&m.kind==='stop-label').length,3);
      assert.equal(h.markers.filter(m=>m.map&&m.kind==='current-marker').length,1);
    }
  } finally {h.close();}
});

test('route arrows appear only when zoomed in and are cleared on overview, back and route changes',async()=>{
  const h=await harness();
  const arrows=()=>h.markers.filter(m=>m.map&&m.kind==='route-arrow');
  try{
    await h.actions.openRoute('204000017');
    const map=h.instances.at(-1),zoom=level=>{map.zoom=level;map.listeners.idle?.();};
    assert.equal(arrows().length,0,'Keep the initial overview clean');
    zoom(16);assert.equal(arrows().length,0);
    zoom(17);assert.ok(arrows().length>0,'A zoomed-in route needs direction arrows');
    assert.ok(arrows().every(m=>m.content.style.transform==='rotate(-90deg)'&&m.clickable===false));
    assert.ok(arrows().every(m=>m.content['aria-hidden']==='true'));
    const old=arrows();zoom(18);
    assert.ok(old.every(m=>m.map===null),'Replace samples rather than accumulating markers');
    assert.equal(arrows().length,old.length);
    assert.equal(h.markers.filter(m=>m.map&&m.kind==='current-marker').length,1);
    h.get('fit-route').listeners.click();assert.equal(arrows().length,0);
    map.fitZoom=18;h.get('fit-route').listeners.click();
    zoom(18);assert.equal(arrows().length,0,'Hide arrows even if a short route overview has a high zoom');
    zoom(19);assert.ok(arrows().length>0);
    h.get('back').listeners.click();assert.equal(arrows().length,0);
    assert.equal(map.listeners.idle,undefined,'Detach the old map listener');
    await h.actions.openRoute('204000182');assert.equal(arrows().length,0);
  }finally{h.close();}
});

test('late route response cannot resurrect a route after back and another selection',async()=>{
  let release;
  const h=await harness(path=>path.includes('/api/map-data?')&&path.includes('204000017')
    ?new Promise(resolve=>{release=resolve;}):null);
  try {
    const old=h.actions.openRoute('204000017'); await tick();
    h.get('back').listeners.click();
    await h.actions.openRoute('204000182');
    release({ok:true,json:async()=>payload('204000017')}); await old;
    assert.equal(h.get('map').dataset.routeId,'204000182');
    assert.equal(h.get('route-screen').hidden,false);
  } finally {h.close();}
});

test('map draws a corrected display line while preserving raw stop positions',async()=>{
  const p=payload('204000017');
  const geo=(x,y)=>({lat:37+y/111195.08,lng:127+x/(111195.08*Math.cos(37*Math.PI/180))});
  p.shape=[[-100,-5],[0,0],[100,-5],[150,0],[150,100],[100,5],[0,0],[-100,5]]
    .map(([x,y])=>geo(x,y));
  const original=structuredClone(p);
  const h=await harness(path=>path.startsWith('/api/map-data?')?{ok:true,json:async()=>p}:null);
  try{
    await h.actions.openRoute('204000017');
    const line=h.lines.find(l=>l.map);
    assert.ok((line.path[6].lat-line.path[1].lat)*111195.08>9,
      'The actual Polyline must use separated lanes, not the pinched raw line');
    assert.deepEqual(p,original);
    assert.equal(h.markers.filter(m=>m.map&&m.kind==='stop-label').length,3);
  }finally{h.close();}
});

test('landmark and list clicks fit the destination and correct stop together, then reset safely',async()=>{
  const p=payload('204000017');
  p.facilities=[{id:'school',name:'목적지학교',category:'학교',reviewStatus:'normal_review',lat:37.395,lng:127.121},
    {id:'near',name:'근처도서관',category:'공공도서관',reviewStatus:'normal_review',lat:37.3915,lng:127.12}];
  p.links=[{visitKey:'204000017:2',facilityId:'school',distanceM:210},
    {visitKey:'204000017:1',facilityId:'near',distanceM:141}];
  const h=await harness(path=>path.startsWith('/api/map-data?')?{ok:true,json:async()=>p}:null);
  const click=id=>h.markers.find(m=>m.map&&m.content.dataset.facilityId===id).content.listeners.click();
  try{
    await h.actions.openRoute('204000017');
    assert.equal(typeof h.markers.find(m=>m.map&&m.content.dataset.facilityId==='school').content.listeners.click,'function');
    click('school');
    assert.equal(h.get('destination-info').hidden,false);
    assert.equal(h.get('destination-title').textContent,'목적지학교');
    assert.match(h.get('destination-stop').textContent,/정류장2/);
    assert.match(h.get('destination-detail').textContent,/1개 정류장 뒤.*210m/);
    const fit=h.instances[0].fits.at(-1).points;
    assert.ok(fit.some(p=>p.lat===37.395&&p.lng===127.121));
    assert.ok(fit.some(p=>p.lat===37.392&&p.lng===127.12));
    assert.ok(h.markers.some(m=>m.map&&m.kind.includes('selected-stop')));
    h.markers.find(m=>m.map&&m.content.dataset.visitKey==='204000017:1').content.listeners.click();
    assert.equal(h.get('destination-title').textContent,'목적지학교','Stop inspection must not replace the destination');
    assert.ok(h.markers.some(m=>m.map&&m.kind.includes('selected-stop')),'Keep the destination alighting stop');
    h.resize();
    assert.equal(h.get('destination-info').hidden,false,'Resize must retain destination focus');
    h.get('facility-list').children[1].children[0].listeners.click();
    assert.match(h.get('destination-stop').textContent,/현재 정류장 근처/);
    assert.match(h.get('destination-detail').textContent,/141m/);
    assert.ok(h.markers.some(m=>m.map&&m.kind.includes('current-destination-stop')),
      'A current-stop destination needs a label position that clears the existing flag');
    h.get('fit-route').listeners.click();
    assert.equal(h.get('destination-info').hidden,true);
    assert.equal(h.markers.filter(m=>m.map&&m.kind.includes('selected-stop')).length,0);
    click('school');h.get('back').listeners.click();
    assert.equal(h.get('destination-info').hidden,true);
    await h.actions.openRoute('204000182');
    assert.equal(h.get('destination-info').hidden,true,'Never retain the last route destination');
  }finally{h.close();}
});

test('landmarks with only past stops still frame and name the nearest stop without advising alighting',async()=>{
  const p=payload('204000017');
  p.stations=[];
  p.facilities=[{id:'past',name:'지난학교',category:'학교',reviewStatus:'normal_review',lat:37.391,lng:127.121}];
  p.links=[{visitKey:'204000017:1',facilityId:'past',distanceM:120}];
  const h=await harness(path=>path.startsWith('/api/map-data?')?{ok:true,json:async()=>p}:null);
  try{
    await h.actions.openRoute('204000017');
    h.get('visit-select').value='204000017:2';h.get('visit-select').listeners.change();
    h.markers.find(m=>m.map&&m.content.dataset.facilityId==='past').content.listeners.click();
    const stop=h.markers.find(m=>m.map&&m.kind.includes('reference-stop'));
    assert.ok(stop,'A past-only landmark must still show its nearby stop');
    assert.equal(stop.content.children.find(n=>n.className==='stop-name').textContent,'정류장1');
    assert.match(h.get('destination-stop').textContent,/현재 방향.*하차 지점/);
    assert.doesNotMatch(h.get('destination-stop').textContent,/내리세요/);
    assert.match(h.get('destination-reference').textContent,/이미 지난.*정류장1.*120m/);
    assert.equal(h.markers.some(m=>m.map&&m.kind.includes('selected-stop')),false);
    const fit=h.instances[0].fits.at(-1).points;
    assert.ok(fit.some(point=>point.lat===37.391&&point.lng===127.121));
    assert.ok(fit.some(point=>point.lat===p.stops[0].lat&&point.lng===p.stops[0].lng));
    assert.equal(h.get('visit-select').value,'204000017:2');
  }finally{h.close();}
});

const directionPayload=()=>{
  const p=payload('204000017');
  p.stops=[['206000314','반대편'],['east','성남시청전면'],['turn','회차'],['west','성남시청전면'],['206000305','현재'],['end','종점']]
    .map(([stationId,name],i)=>({stationId,name,sequence:i+1,visitKey:`204000017:${i+1}`,turn:i===2,lat:37.39+i*.001,lng:127.12}));
  p.sampleVisitKey='204000017:5';
  p.stations=[{stationId:'206000305',visitKey:'204000017:5'},
    {stationId:'206000314',visitKey:'204000017:1'}];
  p.facilities=[{id:'school',name:'목적지학교',category:'학교',reviewStatus:'normal_review',lat:37.391,lng:127.121}];
  p.links=[{visitKey:'204000017:2',facilityId:'school',distanceM:350},
    {visitKey:'204000017:4',facilityId:'school',distanceM:420}];
  return p;
};

test('verified opposite boarding advice never paints a past reference as a blue alighting stop',async()=>{
  const p=directionPayload();
  const h=await harness(path=>path.startsWith('/api/map-data?')?{ok:true,json:async()=>p}:null);
  try{
    await h.actions.openRoute('204000017');
    h.markers.find(m=>m.map&&m.content.dataset.facilityId==='school').content.listeners.click();
    assert.match(h.get('destination-stop').textContent,/목적지와 반대 방향/);
    assert.match(h.get('destination-detail').textContent,/목적지학교.*반대편.*07303.*55번.*타세요/);
    assert.equal(h.get('destination-info').dataset.state,'opposite');
    assert.equal(h.markers.some(m=>m.map&&m.kind.includes('selected-stop')),false);
    const reference=h.markers.find(m=>m.map&&m.kind.includes('reference-stop'));
    assert.equal(reference.content.dataset.visitKey,'204000017:4');
    assert.match(h.get('destination-reference').textContent,/이미 지난.*성남시청전면/);
    assert.equal(h.get('visit-select').value,'204000017:5','Do not automatically switch the kiosk');
    h.get('visit-select').value='204000017:1';h.get('visit-select').listeners.change();
    assert.match(h.get('destination-stop').textContent,/성남시청전면.*내리세요/);
    assert.equal(h.get('destination-info').dataset.state,'alight');
    assert.equal(h.get('destination-reference').hidden,true);
    assert.equal(h.markers.find(m=>m.map&&m.kind.includes('selected-stop')).content.dataset.visitKey,'204000017:2');
    h.get('fit-route').listeners.click();assert.equal(h.get('destination-info').hidden,true);
  }finally{h.close();}
});

test('no reachable stop in either verified direction asks for another route, not opposite boarding',async()=>{
  const p=directionPayload();p.links=[p.links[1]];
  const h=await harness(path=>path.startsWith('/api/map-data?')?{ok:true,json:async()=>p}:null);
  try{
    await h.actions.openRoute('204000017');
    h.markers.find(m=>m.map&&m.content.dataset.facilityId==='school').content.listeners.click();
    assert.match(h.get('destination-stop').textContent,/이 노선.*가까운 하차 지점/);
    assert.match(h.get('destination-detail').textContent,/다른 노선/);
    assert.doesNotMatch(h.get('destination-detail').textContent,/반대편.*타세요/);
    assert.equal(h.get('destination-info').dataset.state,'unavailable');
    assert.equal(h.markers.some(m=>m.map&&m.kind.includes('selected-stop')),false);
  }finally{h.close();}
});

test('a landmark near the opposite kiosk shows nearby information without telling users to board',async()=>{
  const p=directionPayload();p.links=[{visitKey:'204000017:1',facilityId:'school',distanceM:200}];
  const h=await harness(path=>path.startsWith('/api/map-data?')?{ok:true,json:async()=>p}:null);
  try{
    await h.actions.openRoute('204000017');
    h.markers.find(m=>m.map&&m.content.dataset.facilityId==='school').content.listeners.click();
    assert.match(h.get('destination-stop').textContent,/반대편 정류장 근처/);
    assert.match(h.get('destination-detail').textContent,/200m/);
    assert.doesNotMatch(h.get('destination-detail').textContent,/타세요/);
  }finally{h.close();}
});

test('ordinary stops reveal their names on click without moving the kiosk or changing map extent',async()=>{
  const h=await harness();
  const stop=key=>h.markers.find(m=>m.map&&m.content.dataset.visitKey===key).content;
  const labels=()=>h.markers.filter(m=>m.map&&m.kind.includes('inspected-stop'));
  try{
    await h.actions.openRoute('204000017');
    const fits=h.instances[0].fits.length;
    assert.equal(stop('204000017:2').tagName,'BUTTON');
    assert.equal(typeof stop('204000017:2').listeners.click,'function');
    stop('204000017:2').listeners.click();
    assert.equal(labels().length,1);
    assert.equal(labels()[0].content.children.find(n=>n.className==='stop-name').textContent,'정류장2');
    assert.equal(typeof stop('204000017:2').listeners.keydown,'function');
    stop('204000017:2').listeners.keydown({key:'Enter',preventDefault(){},stopPropagation(){}});
    assert.equal(labels().length,0,'Enter must toggle without relying on the map SDK default action');
    stop('204000017:2').listeners.keydown({key:' ',preventDefault(){},stopPropagation(){}});
    assert.equal(labels().length,1,'Space must also activate the stop');
    assert.equal(h.get('visit-select').value,'204000017:1');
    assert.equal(h.instances[0].fits.length,fits,'Inspecting a stop must not unexpectedly zoom');
    stop('204000017:3').listeners.click();
    assert.equal(labels().length,1);
    assert.equal(labels()[0].content.children.find(n=>n.className==='stop-name').textContent,'정류장3');
    h.resize();assert.equal(labels().length,1,'Resizing must retain the inspected name');
    stop('204000017:3').listeners.click();assert.equal(labels().length,0,'Clicking again hides the name');
    stop('204000017:1').listeners.click();
    assert.ok(labels()[0].kind.includes('current-destination-stop'),'Current-stop name must clear the flag');
    h.get('fit-route').listeners.click();assert.equal(labels().length,0);
    stop('204000017:2').listeners.click();h.get('back').listeners.click();
    await h.actions.openRoute('204000182');assert.equal(labels().length,0,'Do not retain labels across routes');
  }finally{h.close();}
});

test('current stop is a signpost anchored at its foot, with separate upright text and no terminal arrow',async()=>{
  const h=await harness();
  try {
    await h.actions.openRoute('204000017');
    const marker=h.markers.find(m=>m.map&&m.kind==='current-marker').content;
    const sign=marker.children.find(n=>n.className==='signpost');
    assert.ok(sign,'Directional signpost missing');
    assert.equal(sign.children.find(n=>n.className==='arrow').getAttribute?.('aria-hidden') ?? sign.children.find(n=>n.className==='arrow')['aria-hidden'],'true');
    assert.ok(marker.children.some(n=>n.className==='current-point'));
    assert.ok(marker.children.some(n=>n.className==='flag'&&n.textContent==='여기에 있어요'));
    assert.equal(marker.style.transform,undefined,'Upright label must not rotate with the sign');
    h.get('visit-select').value='204000017:3'; h.get('visit-select').listeners.change();
    const terminal=h.markers.find(m=>m.map&&m.kind==='current-marker').content;
    assert.equal(terminal.children.some(n=>n.className==='signpost'),false);
  } finally {h.close();}
});

test('southbound signpost sits west of the stop without reversing its arrow',async()=>{
  const p=payload('204000017');
  p.stops=p.stops.map((s,i)=>({...s,lat:37.4-i*0.001,lng:127.12}));
  p.shape=[{lat:37.401,lng:127.12},{lat:37.398,lng:127.12}];
  const h=await harness(path=>path.startsWith('/api/map-data?')?{ok:true,json:async()=>p}:null);
  try {
    await h.actions.openRoute('204000017');
    const marker=h.markers.find(m=>m.map&&m.kind==='current-marker').content;
    const sign=marker.children.find(n=>n.className==='signpost');
    const label=marker.children.find(n=>n.className==='flag');
    assert.ok(parseFloat(label.style.left)<-55,'Label must clear the route on the west side');
    assert.ok(parseFloat(sign.children.find(n=>n.className==='arrow').style.top)<=36,
      'Shorter post must bring the arrow centre within 48px of the stop');
    assert.equal(sign.style.transform,'rotate(90deg)','Southbound arrow must still point down');
    assert.equal(sign.children.find(n=>n.className==='stem').style.top,'0px');
    assert.ok(parseFloat(sign.children.find(n=>n.className==='arrow').style.top)>0);
  } finally {h.close();}
});

test('SDK-pending A B back A creates only the final map and stops timers on back',async()=>{
  const h=await harness(null,{deferSdk:true});
  try {
    const first=h.actions.openRoute('204000017'); await tick();
    h.get('back').listeners.click();
    const middle=h.actions.openRoute('204000182'); await tick();
    h.get('back').listeners.click();
    const last=h.actions.openRoute('204000017'); await tick();
    assert.equal(h.scripts.length,1);
    h.releaseSdk(); await Promise.all([first,middle,last]); await tick();
    assert.equal(h.instances.length,1);
    assert.equal(h.get('map').dataset.routeId,'204000017');
    h.get('back').listeners.click();
    assert.equal(h.instances.filter(m=>!m.destroyed).length,0);
    assert.equal(h.timers.size,0);
  } finally {h.close();}
});

test('tile-pending A B back A cannot revive destroyed maps',async()=>{
  const h=await harness(null,{deferTiles:true});
  try {
    const first=h.actions.openRoute('204000017'); await tick();
    h.get('back').listeners.click();
    const middle=h.actions.openRoute('204000182'); await tick();
    h.get('back').listeners.click();
    const last=h.actions.openRoute('204000017'); await tick();
    h.releaseTiles(); await Promise.all([first,middle,last]); await tick();
    assert.equal(h.instances.length,3);
    assert.equal(h.instances.filter(m=>!m.destroyed).length,1);
    assert.equal(h.get('map').dataset.routeId,'204000017');
    h.get('back').listeners.click();
    assert.equal(h.timers.size,0);
  } finally {h.close();}
});

test('late vehicle response from an earlier A cannot add markers to a new A',async()=>{
  let release, calls=0;
  const h=await harness(path=>{
    if(path.startsWith('/api/bus-locations') && ++calls===1)return new Promise(resolve=>{release=resolve;});
    return null;
  });
  try {
    await h.actions.openRoute('204000017'); await tick();
    h.get('back').listeners.click();
    await h.actions.openRoute('204000182'); await tick();
    h.get('back').listeners.click();
    await h.actions.openRoute('204000017'); await tick();
    release({ok:true,status:200,json:async()=>({routeId:'204000017',fetchedAt:new Date().toISOString(),
      vehicles:[{id:'123',stationName:'이전응답',lat:37.4,lng:127.1,state:'출발'}]})});
    await tick();
    assert.equal(h.markers.filter(m=>m.kind==='bus-marker'&&m.map).length,0);
    assert.equal(h.get('map').dataset.routeId,'204000017');
    assert.equal(h.get('live-status').dataset.state,'waiting');
    h.get('back').listeners.click();
    assert.equal(h.timers.size,0);
  } finally {h.close();}
});
