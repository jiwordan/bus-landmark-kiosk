export function selectStation(catalog, stationId) {
  const station = catalog.stations.find(s => s.stationId === stationId);
  if (!station) throw new Error('Unknown kiosk station');
  return { station, routes:catalog.routes.filter(r=>r.stations.some(s=>s.stationId===stationId)) };
}

// GBIS includes virtual route waypoints as stop visits. They still belong to
// route geometry/live vehicle matching, but cannot be boarding/alighting stops.
export function isBoardingStop(stop) {
  return !!stop && !/[（(]\s*(?:경유|미정차)\s*[）)]/u.test(stop.name ?? '');
}

function boardingLinks(payload) {
  const stops = new Map(payload.stops.filter(isBoardingStop).map(s => [s.visitKey,s]));
  return payload.links.filter(l => stops.has(l.visitKey) && Number.isFinite(l.distanceM)
    && l.distanceM >= 0 && l.distanceM <= 500).map(l => ({...l,stop:stops.get(l.visitKey)}));
}

function forwardVisits(stops,current) {
  const turn=stops.find(s=>s.sequence>=current.sequence&&s.turn);
  return stops.filter(s=>isBoardingStop(s)&&s.sequence>=current.sequence&&(!turn||s.sequence<=turn.sequence));
}

function closestForwardLink(stops,current,linked) {
  const keys=new Set(forwardVisits(stops,current).map(s=>s.visitKey));
  const candidates=linked.filter(l=>keys.has(l.visitKey));
  return candidates.find(l=>l.visitKey===current.visitKey)
    ?? candidates.sort((a,b)=>a.distanceM-b.distanceM||a.stop.sequence-b.stop.sequence)[0];
}

export function makeViewModel(payload, currentVisitKey) {
  const currentStop = payload.stops.find(s => s.visitKey === currentVisitKey);
  if (!currentStop) throw new Error('Unknown stop visit');
  const boardingStops = payload.stops.filter(isBoardingStop);
  const links = boardingLinks(payload);
  const supported = new Set(links.map(l => l.facilityId));
  const later = boardingStops.filter(s => s.sequence > currentStop.sequence);
  const ended = later.length === 0;
  const nextStop = later.find(s => s.lat !== currentStop.lat || s.lng !== currentStop.lng) ?? null;
  const futureKeys = new Set(forwardVisits(payload.stops,currentStop).map(s => s.visitKey));
  const reachable = new Set(ended ? [] : links.filter(l => futureKeys.has(l.visitKey)).map(l => l.facilityId));
  const unique = [...new Map(payload.facilities.map(f => [f.id, f])).values()];
  return {
    currentStop, nextStop, ended, boardingStops,
    displayFacilities: unique.filter(f => f.reviewStatus === 'normal_review' && supported.has(f.id))
      .map(f => ({ ...f, reachable: reachable.has(f.id) })),
    pendingFacilities: unique.filter(f => f.reviewStatus !== 'normal_review'),
  };
}

export function bearingDegrees(from, to) {
  if (from.lat === to.lat && from.lng === to.lng) return null;
  const radians = Math.PI / 180;
  const a = from.lat * radians, b = to.lat * radians, delta = (to.lng - from.lng) * radians;
  return (Math.atan2(Math.sin(delta) * Math.cos(b),
    Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(delta)) / radians + 360) % 360;
}

export function facilityStopInfo(payload, currentVisitKey, facilityId) {
  const current=payload.stops.find(s=>s.visitKey===currentVisitKey);
  if(!current)throw new Error('Unknown stop visit');
  const facility=payload.facilities.find(f=>f.id===facilityId&&f.reviewStatus==='normal_review');
  if(!facility)return null;
  const linked=boardingLinks(payload).filter(l=>l.facilityId===facilityId);
  if(!linked.length)return null;
  const choice=closestForwardLink(payload.stops,current,linked);
  if(!choice){
    const previousTurn=payload.stops.filter(s=>s.sequence<current.sequence&&s.turn).at(-1);
    const past=linked.filter(l=>l.stop.sequence<current.sequence&&(!previousTurn||l.stop.sequence>previousTurn.sequence));
    const byDistance=(a,b)=>a.distanceM-b.distanceM||a.stop.sequence-b.stop.sequence;
    const nearest=past.sort(byDistance)[0]??linked.sort(byDistance)[0];
    const knownKiosk=payload.stations?.some(s=>s.visitKey===currentVisitKey&&s.stationId===current.stationId);
    const other=knownKiosk?payload.stations.find(s=>s.stationId!==current.stationId):null;
    const otherStop=other?payload.stops.find(s=>s.visitKey===other.visitKey&&s.stationId===other.stationId&&isBoardingStop(s)):null;
    const differentLeg=otherStop&&payload.stops.some(s=>s.turn&&s.sequence>=Math.min(current.sequence,otherStop.sequence)
      &&s.sequence<Math.max(current.sequence,otherStop.sequence));
    const boardingStop=differentLeg?otherStop:null;
    const alternative=boardingStop?closestForwardLink(payload.stops,boardingStop,linked):null;
    const opposite=alternative?{boardingStop,stop:alternative.stop,distanceM:alternative.distanceM,
      kind:alternative.visitKey===boardingStop.visitKey?'nearby':'alight',
      nextStopName:payload.stops.find(s=>s.sequence>boardingStop.sequence&&isBoardingStop(s))?.name??null}:null;
    return {facility,stop:null,referenceStop:nearest?.stop??null,
      referenceKind:nearest?(past.includes(nearest)?'past':'other-direction'):null,
      kind:opposite?'opposite':'unavailable',opposite,oppositeChecked:!!boardingStop,
      distanceM:nearest?.distanceM??null,stopsAway:null};
  }
  return {facility,stop:choice.stop,kind:choice.visitKey===currentVisitKey?'nearby':'alight',distanceM:choice.distanceM,
    stopsAway:payload.stops.filter(s=>isBoardingStop(s)&&s.sequence>current.sequence&&s.sequence<=choice.stop.sequence).length};
}

export function routeHeadingDegrees(shape, current, next) {
  if (!next) return null;
  const forward = bearingDegrees(current, next);
  if (forward === null) return null;
  const metres = 111195.08, eastScale = Math.cos(current.lat * Math.PI / 180);
  const local = p => ({x:(p.lng-current.lng)*metres*eastScale, y:(p.lat-current.lat)*metres});
  const segments = [];
  for (let i=1; i<shape.length; i++) {
    const a=local(shape[i-1]), b=local(shape[i]);
    const dx=b.x-a.x, dy=b.y-a.y, length2=dx*dx+dy*dy;
    if (!length2) continue;
    const t=Math.max(0,Math.min(1,-(a.x*dx+a.y*dy)/length2));
    const distance=Math.hypot(a.x+t*dx,a.y+t*dy);
    const heading=bearingDegrees(shape[i-1],shape[i]);
    const difference=Math.abs((heading-forward+540)%360-180);
    segments.push({distance,heading,difference});
  }
  if (!segments.length) return forward;
  const nearest=Math.min(...segments.map(s=>s.distance));
  // Nearby overlapping outbound/return segments need the selected visit's next stop.
  return segments.filter(s=>s.distance<=nearest+6)
    .sort((a,b)=>a.difference-b.difference || a.distance-b.distance)[0].heading;
}

export function routeArrowSamples(points,width,height) {
  const arrows=[];
  let travelled=0,next=70;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    if(!length)continue;
    for(;next<travelled+length;next+=140){
      const along=next-travelled;
      if(along<8||length-along<8)continue;
      const x=a.x+dx*along/length,y=a.y+dy*along/length;
      if(x<10||x>width-10||y<10||y>height-10)continue;
      if(arrows.some(p=>Math.hypot(p.x-x,p.y-y)<40))continue;
      arrows.push({x,y,angle:Math.atan2(dy,dx)*180/Math.PI});
    }
    travelled+=length;
  }
  return arrows;
}

export function displayRouteShape(shape) {
  if (shape.length < 3) return shape;
  const compact=[],indices=[];
  for(const point of shape){
    const previous=compact.at(-1);
    if(!previous||previous.lat!==point.lat||previous.lng!==point.lng)compact.push(point);
    indices.push(compact.length-1);
  }
  if(compact.length!==shape.length){
    const corrected=displayRouteShape(compact);
    return shape.map((point,i)=>({...point,lat:corrected[indices[i]].lat,lng:corrected[indices[i]].lng}));
  }
  const metres=111195.08, eastScale=Math.cos(shape[0].lat*Math.PI/180);
  const points=shape.map(p=>({x:(p.lng-shape[0].lng)*metres*eastScale,y:(p.lat-shape[0].lat)*metres}));
  const result=shape.map(p=>({...p})), visits=new Map();
  shape.forEach((p,i)=>{
    const key=`${p.lat},${p.lng}`;
    if(!visits.has(key))visits.set(key,[]);
    visits.get(key).push(i);
  });
  const project=(i,minTurnCos=.5)=>{
    if(i===0||i===shape.length-1)return null;
    const a=points[i-1],p=points[i],b=points[i+1];
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    const ax=p.x-a.x,ay=p.y-a.y,bx=b.x-p.x,by=b.y-p.y;
    const legs=Math.hypot(ax,ay)*Math.hypot(bx,by);
    if(length<10||length>500||!legs||(ax*bx+ay*by)/legs<minTurnCos)return null;
    const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/(length*length);
    if(t<=0||t>=1)return null;
    const x=a.x+t*dx,y=a.y+t*dy;
    if(Math.hypot(x-p.x,y-p.y)>12)return null;
    return {x,y,dx:dx/length,dy:dy/length};
  };
  const tangents=i=>{
    if(i<2||i+2>=shape.length)return null;
    const a=points[i-2],b=points[i-1],c=points[i+1],d=points[i+2];
    const unit=(from,to)=>{
      const x=to.x-from.x,y=to.y-from.y,length=Math.hypot(x,y);
      return length>=5&&length<=500?{x:x/length,y:y/length}:null;
    };
    const incoming=unit(a,b),outgoing=unit(c,d);
    return incoming&&outgoing?{incoming,outgoing}:null;
  };
  const dot=(a,b)=>a.x*b.x+a.y*b.y;
  const corner=i=>{
    const support=tangents(i);
    if(!support)return null;
    const {incoming,outgoing}=support,b=points[i-1],c=points[i+1];
    if(Math.abs(dot(incoming,outgoing))>.85)return null;
    const den=incoming.x*outgoing.y-incoming.y*outgoing.x;
    const dx=c.x-b.x,dy=c.y-b.y;
    const alongIn=(dx*outgoing.y-dy*outgoing.x)/den;
    const alongOut=(dx*incoming.y-dy*incoming.x)/den;
    if(alongIn<0||alongIn>500||alongOut>0||alongOut< -500)return null;
    const x=b.x+alongIn*incoming.x,y=b.y+alongIn*incoming.y;
    if(Math.hypot(x-points[i].x,y-points[i].y)>12)return null;
    return {x,y,incoming,outgoing};
  };
  // Paired corners use their own approach/departure lines, never a diagonal shortcut.
  for(const indices of visits.values()){
    if(indices.length!==2||indices[1]-indices[0]<5)continue;
    const [i,j]=indices,ca=corner(i),cb=corner(j);
    let a,b;
    if(ca&&cb&&ca.incoming.x*cb.outgoing.x+ca.incoming.y*cb.outgoing.y<-.95
      &&ca.outgoing.x*cb.incoming.x+ca.outgoing.y*cb.incoming.y<-.95){
      a=ca;b=cb;
    }else{
      a=project(i);b=project(j);
      if(!a||!b){
        const first=tangents(i),second=tangents(j);
        // shortcut: Unmatched junctions stay unchanged until road-level geometry can verify them.
        if(!first||!second||dot(first.incoming,first.outgoing)<.85||dot(second.incoming,second.outgoing)<.85
          ||dot(first.incoming,second.outgoing)>-.95||dot(first.outgoing,second.incoming)>-.95)continue;
        a=project(i,0);b=project(j,0);
      }
      if(!a||!b||a.dx*b.dx+a.dy*b.dy>-.9)continue;
    }
    if(Math.hypot(a.x-b.x,a.y-b.y)<2)continue;
    for(const [index,p] of [[i,a],[j,b]]){
      result[index].lat=shape[0].lat+p.y/metres;
      result[index].lng=shape[0].lng+p.x/(metres*eastScale);
    }
  }
  return result;
}

export function landmarkNameLines(name) {
  const characters = [...name];
  if (characters.length <= 6) return [name];
  const suffix = name.match(/^(.*?)(초등학교|고등학교|중학교|도서관)$/);
  if (suffix?.[1]) return [suffix[1], suffix[2]];
  const middle = Math.ceil(characters.length / 2);
  return [characters.slice(0, middle).join(''), characters.slice(middle).join('')];
}

