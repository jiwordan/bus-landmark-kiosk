import test from 'node:test';
import assert from 'node:assert/strict';
import {nameEvidence,summarizeNames,analyzeDirections} from '../scripts/analyze_kiosk_evidence.mjs';

test('full facility names match only complete stop-name units with optional location suffixes',()=>{
  assert.equal(nameEvidence({name:'매송중학교',category:'학교'},['매송 중학교.풍림아파트']).status,'explicit');
  assert.equal(nameEvidence({name:'성남시청',category:'공공기관'},['성남시청전면']).status,'explicit');
  assert.equal(nameEvidence({name:'이매역',category:'도시철도역'},['이매역3번출구']).status,'explicit');
  assert.equal(nameEvidence({name:'이매역',category:'도시철도역'},['이매역효성아파트']).status,'not_explicit');
});

test('school abbreviations and omitted parenthetical names are review possibilities, not confirmed matches',()=>{
  assert.equal(nameEvidence({name:'매송중학교',category:'학교'},['매송중.풍림아파트']).status,'abbreviation_review');
  assert.equal(nameEvidence({name:'성남여수초등학교',category:'학교'},['여수초교']).status,'abbreviation_review');
  assert.equal(nameEvidence({name:'매송중학교',category:'학교'},['매송고']).status,'not_explicit');
  assert.equal(nameEvidence({name:'판교제9호(나들이)공원',category:'공원 후보'},['판교제9호공원']).status,'abbreviation_review');
});

test('a single explicit linked stop takes precedence over abbreviation possibilities',()=>{
  const result=nameEvidence({name:'매송중학교',category:'학교'},['매송중','매송중학교.풍림아파트']);
  assert.equal(result.status,'explicit');
  assert.deepEqual(result.explicitStops,['매송중학교.풍림아파트']);
});

test('global name summary deduplicates facilities and checks evidence on every route',()=>{
  assert.deepEqual(summarizeNames([
    {facilityId:'a',status:'abbreviation_review'},{facilityId:'a',status:'explicit'},
    {facilityId:'b',status:'abbreviation_review'},{facilityId:'c',status:'not_explicit'}
  ]),{total:3,explicit:1,abbreviation_review:1,not_explicit:1});
});

test('distance-only comparison separates definite outside-leg minima from mixed-direction ties',()=>{
  const stops=Array.from({length:7},(_,i)=>({sequence:i+1,visitKey:`r:${i+1}`,stationId:String(i+1),
    name:`정류장${i+1}`,turn:[3,7].includes(i+1)}));
  const payload={routeId:'r',routeNumber:'55',sampleVisitKey:'r:5',selectedStationId:'5',stops,
    stations:[{stationId:'1',visitKey:'r:1'},{stationId:'5',visitKey:'r:5'}],
    facilities:['a','b','c'].map(id=>({id,name:id,reviewStatus:'normal_review'})),
    links:[['a',2,80],['a',6,120],['b',2,80],['b',6,80],['c',5,300],['c',6,100]]
      .map(([facilityId,seq,distanceM])=>({facilityId,visitKey:`r:${seq}`,distanceM}))};
  const result=analyzeDirections(payload);
  assert.equal(result.summary.nearby,1);
  assert.equal(result.summary.alight,2);
  assert.equal(result.summary.nearestAllOutside,1);
  assert.equal(result.summary.nearestMixedTie,1);
  assert.equal(result.summary.currentAlternativeDespiteNearestOutside,1);
  assert.equal(result.details.find(x=>x.facilityId==='a').chosenVisit,'r:6');
  assert.equal(result.details.find(x=>x.facilityId==='c').chosenVisit,'r:5');
});

test('pass-through exclusion preserves route order but never treats marked waypoints as alighting stops',()=>{
  const stops=Array.from({length:7},(_,i)=>({sequence:i+1,visitKey:`r:${i+1}`,stationId:String(i+1),
    name:i===5?'모란(경유)':`정류장${i+1}`,turn:[3,7].includes(i+1)}));
  const payload={routeId:'r',routeNumber:'9407',sampleVisitKey:'r:5',selectedStationId:'5',stops,
    stations:[{stationId:'1',visitKey:'r:1'},{stationId:'5',visitKey:'r:5'}],
    facilities:['a','b'].map(id=>({id,name:id,reviewStatus:'normal_review'})),
    links:[['a',6,80],['a',7,200],['b',6,100]].map(([facilityId,seq,distanceM])=>({facilityId,visitKey:`r:${seq}`,distanceM}))};
  const raw=analyzeDirections(payload);
  const clean=analyzeDirections(payload,{excludePassThrough:true});
  assert.equal(raw.summary.alight,2);
  assert.equal(clean.summary.alight,1);
  assert.equal(clean.summary.unavailable,1);
  assert.equal(clean.summary.noRadiusLinks,1);
  assert.equal(clean.details.find(x=>x.facilityId==='a').chosenVisit,'r:7');
  assert.equal(clean.details.find(x=>x.facilityId==='a').stopsAway,1);
  assert.equal(clean.details.find(x=>x.facilityId==='b').chosenVisit,null);
  assert.equal(payload.links.length,3,'The map snapshot must not be mutated by analysis');
});
