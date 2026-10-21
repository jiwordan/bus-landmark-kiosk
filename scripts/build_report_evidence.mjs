// Current submission population; retain the earlier 313-facility study unchanged.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {makeViewModel,isBoardingStop,facilityStopInfo} from '../web/kiosk/map-state.mjs';
import {nameEvidence,summarizeNames,analyzeDirections} from './analyze_kiosk_evidence.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export function analyzeCurrentPayload(payload){
  const view=makeViewModel(payload,payload.sampleVisitKey),keys=new Set(view.boardingStops.map(s=>s.visitKey));
  const links=payload.links.filter(l=>keys.has(l.visitKey)&&Number.isFinite(l.distanceM)&&l.distanceM>=0&&l.distanceM<=500);
  const stopIndex=new Map(view.boardingStops.map(s=>[s.visitKey,s]));
  const shown=new Set(view.displayFacilities.map(f=>f.id));
  const nameDetails=view.displayFacilities.map(f=>({facilityId:f.id,facilityName:f.name,
    ...nameEvidence(f,links.filter(l=>l.facilityId===f.id).map(l=>stopIndex.get(l.visitKey).name))}));
  const radii=[200,300,500].map(radius=>{
    const ids=new Set(links.filter(l=>l.distanceM<=radius).map(l=>l.facilityId));
    return {radiusM:radius,candidates:ids.size,facilityIds:[...ids].sort()};
  });
  const comparison=analyzeDirections({...payload,facilities:view.displayFacilities,links},{excludePassThrough:true});
  for(const row of comparison.details){
    const app=facilityStopInfo(payload,payload.sampleVisitKey,row.facilityId);
    assert.equal(row.kind,app.kind);
    assert.equal(row.chosenVisit,app.stop?.visitKey??null);
    assert.equal(row.oppositeVisit,app.opposite?.stop.visitKey??null);
    if(app.stop)assert.equal(row.stopsAway,app.stopsAway);
  }
  const removed=payload.facilities.filter(f=>f.reviewStatus==='normal_review'&&!shown.has(f.id));
  return {routeId:payload.routeId,routeNumber:payload.routeNumber,stationId:payload.selectedStationId,
    sourceVisits:payload.stops.length,boardingVisits:view.boardingStops.length,shapePoints:payload.shape.length,
    markedVisits:payload.stops.filter(s=>!isBoardingStop(s)),radii,
    initialDisplay:payload.facilities.filter(f=>f.reviewStatus==='normal_review').length,
    displayCount:shown.size,pendingCount:radii[2].candidates-shown.size,
    removedFacilities:removed.map(({id,name})=>({id,name})),names:summarizeNames(nameDetails),nameDetails,directions:comparison};
}

async function run(){
  const catalog=JSON.parse(await readFile(path.join(root,'data/processed/imae-kiosk/catalog.json'),'utf8'));
  const extraction=spawnSync('python',['-X','utf8','-c',
    "import json; from pathlib import Path; from scripts.map_data import build_payload,load_catalog; w=Path.cwd(); c=load_catalog(w); print(json.dumps([build_payload(w,r['routeId'],s['stationId']) for s in c['stations'] for r in c['routes']]))"],
    {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true});
  if(extraction.status!==0)throw new Error('Saved public-data extraction failed');
  const payloads=JSON.parse(extraction.stdout),directions=payloads.map(analyzeCurrentPayload);
  const routes=directions.filter(r=>r.stationId===catalog.defaultStationId);
  const names=summarizeNames(routes.flatMap(r=>r.nameDetails));
  const uniqueCandidates=new Set(routes.flatMap(r=>r.radii[2].facilityIds)).size;
  const totals=catalog.stations.map(s=>({mobileNo:s.mobileNo,stationId:s.stationId,
    ...directions.filter(r=>r.stationId===s.stationId).reduce((sum,r)=>{
      for(const [key,n] of Object.entries(r.directions.summary))sum[key]=(sum[key]??0)+n;
      return sum;
    },{})}));
  assert.equal(names.total,309);
  assert.equal(routes.reduce((sum,r)=>sum+r.displayCount,0),498);
  assert.equal(routes.reduce((sum,r)=>sum+r.boardingVisits,0),536);
  assert.equal(routes.reduce((sum,r)=>sum+r.removedFacilities.length,0),14);
  assert.ok(directions.every(r=>r.directions.summary.noRadiusLinks===0));
  const sourceFiles=['scripts/build_report_evidence.mjs','scripts/analyze_kiosk_evidence.mjs','web/kiosk/map-state.mjs',
    'data/processed/imae-kiosk/catalog.json'];
  for(const route of catalog.routes)for(const file of ['stops.csv','route-line.csv','display-review.csv',
    'landmarks/candidates-500m.csv','landmarks/stop-facility-links-500m.csv']){
    sourceFiles.push(`data/processed/imae-kiosk/routes/${route.routeId}/${file}`);
  }
  const manifest=[];
  for(const file of sourceFiles)manifest.push({path:file,sha256:createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')});
  const result={analysisDate:'2026-10-18',busSnapshot:'2026-10-16',facilitySnapshot:'2026-10-11',radiusM:500,
    population:'Current visible facilities; only non-marked boarding-stop links. Not the preserved 313-facility historical study.',
    names,uniqueCandidates,totals,routes,directions,manifest};
  const output=path.join(root,'data/processed/imae-kiosk/report-2026-10-18');
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'analysis.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({names,uniqueCandidates,totals,routes:routes.map(r=>({number:r.routeNumber,stops:r.boardingVisits,
    radii:r.radii.map(x=>x.candidates),display:r.displayCount,pending:r.pendingCount,names:r.names}))},null,2));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
