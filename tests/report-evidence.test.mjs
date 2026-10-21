import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';

const moduleUrl=new URL('../scripts/build_report_evidence.mjs',import.meta.url);
const evidence=existsSync(moduleUrl)?await import(moduleUrl):null;

test('report statistics use actual-stop links and current visible landmarks without mutating the snapshot',()=>{
  assert.ok(evidence,'Current report evidence builder is missing');
  const payload={routeId:'r',routeNumber:'55',selectedStationId:'here',sampleVisitKey:'r:1',shape:[{lat:37,lng:127}],
    stops:[{visitKey:'r:1',sequence:1,name:'기준',stationId:'here'},
      {visitKey:'r:2',sequence:2,name:'가상(경유)',stationId:'virtual'},
      {visitKey:'r:3',sequence:3,name:'실제학교',stationId:'school',turn:true}],
    facilities:[{id:'a',name:'도서관',category:'공공도서관',reviewStatus:'normal_review'},
      {id:'b',name:'실제학교',category:'학교',reviewStatus:'normal_review'}],
    links:[{facilityId:'a',visitKey:'r:2',distanceM:100},
      {facilityId:'b',visitKey:'r:2',distanceM:50},{facilityId:'b',visitKey:'r:3',distanceM:400}]};
  const before=structuredClone(payload),result=evidence.analyzeCurrentPayload(payload);
  assert.equal(result.boardingVisits,2);
  assert.equal(result.displayCount,1);
  assert.deepEqual(result.removedFacilities.map(f=>f.id),['a']);
  assert.deepEqual(result.radii.map(r=>r.candidates),[0,0,1]);
  assert.deepEqual(result.names,{total:1,explicit:1,abbreviation_review:0,not_explicit:0});
  assert.equal(result.directions.details[0].chosenVisit,'r:3');
  assert.equal(result.directions.details[0].stopsAway,1);
  assert.deepEqual(payload,before);
});
