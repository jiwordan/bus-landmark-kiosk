// Offline evidence analysis. No API calls, credentials, or changes to map behavior.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const normalize=text=>text.normalize('NFKC').replace(/\s+/gu,'').trim();
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const suffix='(?:앞|입구|정문|후문|동문|서문|남문|북문|사거리|삼거리|건너편|전면|후면|동편|서편|남편|북편)';
const units=text=>text.split(/[.·ㆍ,，/]+/u).map(normalize).filter(Boolean);

function explicitUnit(name,unit,category){
  const ending=category==='도시철도역'?`(?:${suffix}|[0-9]+번출구(?:앞|건너편)?)?`:`${suffix}?`;
  return new RegExp(`^${escape(name)}${ending}$`,'u').test(unit);
}

export function nameEvidence(facility,stopNames){
  const name=normalize(facility.name),possible=new Set();
  const withoutParentheses=name.replace(/\([^)]*\)/gu,'');
  if(withoutParentheses!==name&&withoutParentheses)possible.add(withoutParentheses);
  if(facility.category==='학교'){
    const parts=name.match(/^(.*?)(초등학교|중학교|고등학교)$/u);
    if(parts){
      const endings={'초등학교':['초등학교','초교','초'],'중학교':['중학교','중'],'고등학교':['고등학교','고교','고']}[parts[2]];
      for(const stem of new Set([parts[1],parts[1].replace(/^(?:성남|서울)/u,'')])){
        if(stem)for(const ending of endings)possible.add(stem+ending);
      }
    }
  }
  possible.delete(name);
  const explicitStops=[],aliasStops=[];
  for(const stop of new Set(stopNames)){
    const tokens=units(stop);
    if(tokens.some(token=>explicitUnit(name,token,facility.category)))explicitStops.push(stop);
    else if(tokens.some(token=>[...possible].some(alias=>explicitUnit(alias,token,facility.category))))aliasStops.push(stop);
  }
  return {status:explicitStops.length?'explicit':aliasStops.length?'abbreviation_review':'not_explicit',explicitStops,aliasStops};
}

export function summarizeNames(rows){
  const order={not_explicit:0,abbreviation_review:1,explicit:2},unique=new Map();
  for(const row of rows){
    const previous=unique.get(row.facilityId);
    if(!previous||order[row.status]>order[previous])unique.set(row.facilityId,row.status);
  }
  const result={total:unique.size,explicit:0,abbreviation_review:0,not_explicit:0};
  for(const status of unique.values())result[status]++;
  return result;
}

function legKeys(payload,current){
  const boundary=payload.stops.filter(s=>s.sequence>=current.sequence&&s.turn).sort((a,b)=>a.sequence-b.sequence)[0];
  return new Set(payload.stops.filter(s=>s.sequence>=current.sequence&&(!boundary||s.sequence<=boundary.sequence)).map(s=>s.visitKey));
}

const passThrough=stop=>/[（(](?:경유|미정차)[）)]/u.test(stop.name);

// Frozen reference policy for the pre-fix study, NOT the app's current logic.
// Keeping this independent lets the original before/filtered comparison remain
// reproducible after the app starts hiding landmarks with no real stop links.
function referenceDirectionInfo(payload,current,links,stopIndex){
  const choose=boarding=>{
    const keys=legKeys(payload,boarding),candidates=links.filter(l=>keys.has(l.visitKey));
    return candidates.find(l=>l.visitKey===boarding.visitKey)??candidates[0];
  };
  const choice=choose(current);
  if(choice)return {kind:choice.visitKey===current.visitKey?'nearby':'alight',stop:stopIndex.get(choice.visitKey),
    distanceM:choice.distanceM,stopsAway:payload.stops.filter(s=>s.sequence>current.sequence&&s.sequence<=stopIndex.get(choice.visitKey).sequence).length};
  const known=payload.stations?.some(s=>s.visitKey===current.visitKey&&s.stationId===current.stationId);
  const other=known?payload.stations.find(s=>s.stationId!==current.stationId):null;
  const candidate=other?stopIndex.get(other.visitKey):null;
  const boardingStop=candidate?.stationId===other?.stationId&&candidate&&payload.stops.some(s=>s.turn
    &&s.sequence>=Math.min(current.sequence,candidate.sequence)&&s.sequence<Math.max(current.sequence,candidate.sequence))?candidate:null;
  const alternative=boardingStop?choose(boardingStop):null;
  const opposite=alternative?{boardingStop,stop:stopIndex.get(alternative.visitKey),distanceM:alternative.distanceM,
    kind:alternative.visitKey===boardingStop.visitKey?'nearby':'alight'}:null;
  return {stop:null,stopsAway:null,kind:opposite?'opposite':'unavailable',opposite,oppositeChecked:!!boardingStop};
}

export function analyzeDirections(source,{excludePassThrough=false}={}){
  const passKeys=new Set(source.stops.filter(passThrough).map(s=>s.visitKey));
  const payload=excludePassThrough?{...source,links:source.links.filter(l=>!passKeys.has(l.visitKey))}:source;
  const current=payload.stops.find(s=>s.visitKey===payload.sampleVisitKey);
  if(!current)throw new Error('Missing boarding visit');
  const eligible=legKeys(payload,current),stopIndex=new Map(payload.stops.map(s=>[s.visitKey,s]));
  const summary={total:0,nearby:0,alight:0,opposite:0,unavailable:0,oppositeNearby:0,
    nearestAllOutside:0,nearestMixedTie:0,currentAlternativeDespiteNearestOutside:0,
    currentNameExplicit:0,currentNameAlias:0,currentNameNotExplicit:0,noRadiusLinks:0};
  const details=[];
  for(const facility of payload.facilities.filter(f=>f.reviewStatus==='normal_review')){
    const links=payload.links.filter(l=>l.facilityId===facility.id&&l.distanceM>=0&&l.distanceM<=500)
      .sort((a,b)=>a.distanceM-b.distanceM||stopIndex.get(a.visitKey).sequence-stopIndex.get(b.visitKey).sequence);
    if(!links.length&&!excludePassThrough)throw new Error('Displayed facility has no radius links');
    const tied=links.length?links.filter(l=>Math.abs(l.distanceM-links[0].distanceM)<=1e-6):[];
    const nearestAllOutside=!!tied.length&&tied.every(l=>!eligible.has(l.visitKey));
    const nearestMixedTie=!nearestAllOutside&&tied.some(l=>!eligible.has(l.visitKey));
    const info=referenceDirectionInfo(payload,current,links,stopIndex);
    const available=links.filter(l=>eligible.has(l.visitKey));
    if(!!info.stop!==!!available.length||(info.stop&&!eligible.has(info.stop.visitKey)))throw new Error('Current-leg classification mismatch');
    if(info.opposite){
      const oppositeKeys=legKeys(payload,info.opposite.boardingStop);
      if(!oppositeKeys.has(info.opposite.stop.visitKey)||info.opposite.distanceM>500)throw new Error('Opposite-leg classification mismatch');
    }
    if(info.kind==='unavailable'&&!info.oppositeChecked)throw new Error('Opposite boarding was not verified');
    const currentNameEvidence=available.length?nameEvidence(facility,available.map(l=>stopIndex.get(l.visitKey).name)):null;
    summary.total++;summary[info.kind]++;
    if(!links.length)summary.noRadiusLinks++;
    if(info.opposite?.kind==='nearby')summary.oppositeNearby++;
    if(nearestAllOutside)summary.nearestAllOutside++;
    if(nearestMixedTie)summary.nearestMixedTie++;
    if(nearestAllOutside&&info.stop)summary.currentAlternativeDespiteNearestOutside++;
    if(currentNameEvidence)summary[{explicit:'currentNameExplicit',abbreviation_review:'currentNameAlias',not_explicit:'currentNameNotExplicit'}[currentNameEvidence.status]]++;
    const nearest=links.length?stopIndex.get(links[0].visitKey):null;
    details.push({routeId:payload.routeId,routeNumber:payload.routeNumber,stationId:payload.selectedStationId,
      boardingVisit:current.visitKey,facilityId:facility.id,facilityName:facility.name,category:facility.category,
      kind:info.kind,chosenVisit:info.stop?.visitKey??null,chosenStopName:info.stop?.name??null,
      chosenDistanceM:info.stop?info.distanceM:null,stopsAway:info.stop&&excludePassThrough?
        payload.stops.filter(s=>s.sequence>current.sequence&&s.sequence<=info.stop.sequence&&!passKeys.has(s.visitKey)).length:info.stopsAway,
      oppositeVisit:info.opposite?.stop.visitKey??null,oppositeStopName:info.opposite?.stop.name??null,
      oppositeDistanceM:info.opposite?.distanceM??null,oppositeKind:info.opposite?.kind??null,
      naiveVisit:nearest?.visitKey??null,naiveStopName:nearest?.name??null,naiveDistanceM:links[0]?.distanceM??null,
      nearestAllOutside,nearestMixedTie,nearestTiedVisits:tied.map(l=>l.visitKey),
      currentNameEvidence});
  }
  if(summary.total!==summary.nearby+summary.alight+summary.opposite+summary.unavailable)throw new Error('Direction totals do not reconcile');
  return {summary,details};
}

const percent=(n,d)=>d?`${(100*n/d).toFixed(1)}%`:'해당 없음';

async function run(){
  const sourceBase=path.join(root,'data/processed/imae-kiosk');
  const catalog=JSON.parse(await readFile(path.join(sourceBase,'catalog.json'),'utf8'));
  const extraction=spawnSync('python',['-X','utf8','-c',
    "import json; from pathlib import Path; from scripts.map_data import build_payload,load_catalog; w=Path.cwd(); c=load_catalog(w); print(json.dumps([build_payload(w,r['routeId'],s['stationId']) for s in c['stations'] for r in c['routes']],ensure_ascii=False))"],
    {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true});
  if(extraction.status!==0)throw new Error('Saved public-data extraction failed');
  const payloads=JSON.parse(extraction.stdout),nameDetails=[],nameByRoute=[],directions=[],cleanDirections=[];
  for(const payload of payloads.filter(p=>p.selectedStationId===catalog.defaultStationId)){
    const stops=new Map(payload.stops.map(s=>[s.visitKey,s]));
    const rows=payload.facilities.map(f=>{
      const linked=payload.links.filter(l=>l.facilityId===f.id);
      return {routeId:payload.routeId,routeNumber:payload.routeNumber,facilityId:f.id,facilityName:f.name,
        category:f.category,reviewStatus:f.reviewStatus,...nameEvidence(f,linked.map(l=>stops.get(l.visitKey).name)),
        wholeNameSubstring:linked.some(l=>normalize(stops.get(l.visitKey).name).includes(normalize(f.name))),
        nearestLinks:linked.sort((a,b)=>a.distanceM-b.distanceM).slice(0,3).map(l=>({
          visitKey:l.visitKey,stopName:stops.get(l.visitKey).name,distanceM:l.distanceM}))};
    });
    nameDetails.push(...rows);
    nameByRoute.push({routeId:payload.routeId,routeNumber:payload.routeNumber,
      allCandidates:summarizeNames(rows),displayed:summarizeNames(rows.filter(r=>r.reviewStatus==='normal_review'))});
  }
  for(const payload of payloads){
    const station=catalog.stations.find(s=>s.stationId===payload.selectedStationId);
    directions.push({routeId:payload.routeId,routeNumber:payload.routeNumber,mobileNo:station.mobileNo,...analyzeDirections(payload)});
    cleanDirections.push({routeId:payload.routeId,routeNumber:payload.routeNumber,mobileNo:station.mobileNo,
      ...analyzeDirections(payload,{excludePassThrough:true})});
  }
  const allCandidates=summarizeNames(nameDetails),displayed=summarizeNames(nameDetails.filter(r=>r.reviewStatus==='normal_review'));
  const relaxedNameCount=new Set(nameDetails.filter(r=>r.reviewStatus==='normal_review'&&r.wholeNameSubstring).map(r=>r.facilityId)).size;
  const passThroughVisits=payloads.filter(p=>p.selectedStationId===catalog.defaultStationId).flatMap(p=>p.stops.filter(passThrough)
    .map(s=>({routeId:p.routeId,routeNumber:p.routeNumber,...s})));
  const affectedSelections=directions.flatMap(d=>d.details.map(x=>({...x,mobileNo:d.mobileNo})))
    .filter(x=>[x.chosenStopName,x.oppositeStopName].some(name=>name&&/[（(](?:경유|미정차)[）)]/u.test(name)));
  const passThroughAudit={passThroughVisits,affectedSelections,
    affectedUniqueFacilities:new Set(affectedSelections.map(x=>x.facilityId)).size,
    explanationUrl:'https://www.gbis.go.kr/gbis2014/schBus.action?cmd=mainSearchText&gubun=busInfo&routeId=208000018&searchText=60'};
  if(allCandidates.total!==333||displayed.total!==313)throw new Error('Unexpected snapshot population');
  const sources=[path.join(sourceBase,'catalog.json'),fileURLToPath(import.meta.url)];
  for(const route of catalog.routes)for(const relative of ['stops.csv','route-line.csv','display-review.csv',
    'landmarks/candidates-500m.csv','landmarks/stop-facility-links-500m.csv'])sources.push(path.join(sourceBase,'routes',route.routeId,relative));
  const manifest=[];
  for(const file of sources)manifest.push({path:path.relative(root,file).replaceAll('\\','/'),sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
  const result={analysisDate:'2026-10-18',busSnapshot:'2026-10-16',facilitySnapshot:'2026-10-11',radiusM:500,
    nameSummary:{allCandidates,displayed,byRoute:nameByRoute,relaxedWholeNameSubstring:relaxedNameCount},
    nameDetails,directions,cleanDirections,passThroughAudit,manifest,
    definitions:{explicit:'공백·유니코드를 정규화하고 구분자로 나눈 정류장명 단위에서 시설 전체 이름을 확인. 앞·입구 등 위치 접미어 및 역의 숫자 출구 표기를 허용.',
      abbreviation_review:'학교 약칭·성남/서울 접두어 생략·괄호 설명 생략의 규칙상 가능성. 같은 시설로 확정하지 않음.',
      not_explicit:'위 규칙으로 시설명 명시 또는 약칭 가능성을 찾지 못함. 인지 실패·안내 누락을 뜻하지 않음.',
      baseline:'노선 전체의 500m 연결 중 시설까지 직선거리가 최소인 정류장. 분석용 가상 대조 방식이며 상용 지도나 기존 노선표의 실제 안내 결과가 아님.',
      nearestAllOutside:'거리 최솟값 동률 후보가 모두 현재 탑승 이후·다음 회차까지 구간 밖인 시설. 동률 허용 오차 0.000001m.',
      observations:'방향표의 단위는 노선×탑승 정류장×표시 시설. 같은 시설이 반복되므로 고유 시설·사람·이용 횟수와 다름.'}};
  const output=path.join(sourceBase,'evidence-2026-10-18');
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'analysis.json'),JSON.stringify(result,null,2)+'\n');
  const tableNames=nameByRoute.map(r=>{
    const s=r.displayed;return `| ${r.routeNumber} | ${s.total} | ${s.explicit} | ${s.abbreviation_review} | ${s.not_explicit} |`;
  });
  const tableDirections=mobileNo=>cleanDirections.filter(d=>d.mobileNo===mobileNo).map(d=>{
    const s=d.summary;return `| ${d.routeNumber} | ${s.total} | ${s.nearby} | ${s.alight} | ${s.opposite} | ${s.unavailable} | ${s.nearestAllOutside} | ${s.nearestMixedTie} |`;
  });
  const nameNotExplicit=displayed.total-displayed.explicit;
  const totals=mobileNo=>cleanDirections.filter(d=>d.mobileNo===mobileNo).reduce((sum,d)=>{
    for(const [key,value] of Object.entries(d.summary))sum[key]=(sum[key]??0)+value;
    return sum;
  },{});
  const baselineRows=['07159','07303'].map(mobileNo=>{
    const s=totals(mobileNo);
    return `| ${mobileNo} | ${s.total} | ${s.total-s.noRadiusLinks} | ${s.nearestAllOutside} | ${s.currentAlternativeDespiteNearestOutside} |`;
  });
  const text=[
    '# 성남 키오스크 안내 보완 분석',
    '',
    '분석일 2026-10-18. 버스 자료는 2026-10-16, 시설 원본은 2026-10-11 보존분이다. 아래 비교는 수정 전 표시 모집단을 유지한 참고 분석이다. 현재 앱은 경유/미정차 지점과 실제 정류장 연결이 없는 시설을 표시에서 제외한다. 원본 자료와 제출 HWP/PDF는 보존했다.',
    '',
    '## 핵심 결과',
    '',
    `표시 대상 고유 시설 ${displayed.total}곳 중 연결 정류장명에서 시설 전체 이름이 명시된 곳은 ${displayed.explicit}곳이다. 전체 이름 명시를 확인하지 못한 ${nameNotExplicit}곳(${percent(nameNotExplicit,displayed.total)}) 중 ${displayed.abbreviation_review}곳은 약칭·생략 표기의 추가 검토 대상이다. 나머지 ${displayed.not_explicit}곳은 선언한 약칭 규칙에서도 대응을 찾지 못했다. 문자상 결과이며 이해 실패율이나 안내 누락률이 아니다.`,
    '',
    '## 먼저 확인할 품질 문제',
    '',
    `수정 전 정책을 재현한 참고 계산에서 경유·미정차 표기 지점이 선택된 시설은 고유 ${passThroughAudit.affectedUniqueFacilities}곳, 탑승 방향을 각각 센 선택 기록은 ${affectedSelections.length}건이다. 예를 들어 9407번의 모란(경유)·야탑(경유)·탄천고가교(경유)가 하차 또는 반대편 탑승 근거에 들어갔다. 공식 경기버스정보도 교차로·IC·미정차 정류소·가상 경유지를 별도로 설명하므로 이를 일반 승하차 지점으로 취급하면 안 된다.`,
    '',
    '이 분석은 경유/미정차 표기가 명시된 지점만 하차 연결에서 제외한 보수적 비교를 추가했다. 원본 경로와 경유 순서는 유지했다. 표기가 없는 모든 정류장의 실제 정차 여부까지 인증한 것은 아니다. JSON의 directions는 수정 전 정책을 보존한 독립 참고 계산, cleanDirections는 경유 표기 연결 제외 비교다. 아래 방향 표는 cleanDirections를 사용한다. 두 계산은 원래 시설 모집단을 유지하므로 현재 앱의 표시 개수와 구분해야 한다. 제출 HWP/PDF에는 이번 수정이 아직 반영되지 않았다.',
    '',
    `[경기버스정보의 경유지 설명](${passThroughAudit.explanationUrl})`,
    '',
    '## 시설 이름의 문자상 대응',
    '',
    '| 노선 | 표시 시설 | 전체 이름 명시 | 약칭 가능성 검토 | 규칙상 대응 미확인 |',
    '| --- | ---: | ---: | ---: | ---: |',...tableNames,
    '',
    `노선 간 중복 제거: 전체 후보 ${allCandidates.total}곳(명시 ${allCandidates.explicit}, 약칭 검토 ${allCandidates.abbreviation_review}, 대응 미확인 ${allCandidates.not_explicit}), 표시 대상 ${displayed.total}곳(명시 ${displayed.explicit}, 약칭 검토 ${displayed.abbreviation_review}, 대응 미확인 ${displayed.not_explicit}). 노선별 표의 합계는 노선 간 같은 시설을 반복하므로 고유 시설 수가 아니다.`,
    '',
    '해당 노선에서 시설과 직선 500m로 연결된 모든 정류장 이름을 비교했다. 글로벌 집계는 어느 한 노선에서라도 명시되면 명시로 센다. 따라서 현재 탑승 방향이나 특정 정류장에서 이름을 볼 수 있다는 뜻은 아니다. 방향별 도달 후보의 이름 대응도 JSON에 별도 보존했다.',
    '',
    '학교 약칭(초등학교/초교/초, 중학교/중, 고등학교/고교/고)과 학교명의 성남·서울 접두어 생략, 괄호 설명 생략은 가능성 검토로만 구분했다. 약칭 일치·미일치 모두 현장 인지도를 확정하지 않는다. 이매역효성아파트처럼 시설명을 포함한 아파트명은 역 이름 명시로 자동 인정하지 않는다.',
    '',
    `엄격한 이름 단위·접미어 조건을 없애고 시설 전체 이름이 정류장명 어디에든 포함되면 인정하는 민감도 비교는 ${relaxedNameCount}곳이다. 이 느슨한 기준은 아파트명 등에 포함된 역 이름도 셀 수 있으므로 주 지표로 쓰지 않는다. 약칭·별칭·개칭 전 이름을 전수 확인한 결과가 아니다.`,
    '',
    '## 운행 방향별 안내와 거리만 사용한 대조',
    '',
    '현재 주변은 현재 정류장이 시설 반경 안인 경우다. 현재 방향 하차는 현재 이후부터 다음 회차까지 후보가 있는 경우다. 반대편 연결은 현재 후보가 없고 검증된 반대편 키오스크에서 연결이 있는 경우이며, 반대편 주변 시설도 포함한다. 여기서 하차 후보는 경유/미정차 표기를 제외한 규칙상 후보이지 실제 보행·입구 검증을 마친 추천 지점이 아니다. 양방향 후보 없음은 해당 노선의 저장된 두 탑승 방향에서 후보가 없는 경우이지 다른 교통수단으로 접근할 수 없다는 뜻이 아니다.',
    '',
    ...['07159','07303'].flatMap(mobileNo=>[
      `### 탑승 정류장 ${mobileNo}`,'',
      '| 노선 | 표시 시설 | 현재 주변 | 현재 방향 하차 | 반대편 연결 | 양방향 후보 없음 | 최단거리 후보 모두 구간 밖 | 방향 혼합 동률 |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',...tableDirections(mobileNo),'',
    ]),
    '가상 대조 방식은 운행 순서·방향을 무시하고 노선 전체에서 시설까지 가장 가까운 정류장을 고른다. 현재 탑승 구간 밖의 정류장이 최솟값 동률 후보 전부를 차지하는 경우만 확실한 방향 확인 대상으로 센다. 구간 안팎이 동률이면 별도 열에 남겨 확실한 충돌에 합치지 않는다. 이 비율은 실제 이용자 오탑승률·기존 지도 오류율·개선 효과가 아니다.',
    '',
    '두 방향 모두에서 9407번 표시 목록 125곳 중 14곳은 경유 표기 지점을 제외하면 해당 노선의 500m 연결 자체가 없어진다. 위 표에서는 원래 표시 목록을 비교 모집단으로 유지해 후보 없음에 포함했다. 거리 대조 비율을 낼 때는 이 14곳을 비교 가능 분모에서 제외해야 한다. 노선 간 동일 시설을 반복해 센 방향 관측을 고유 시설 수로 합산하지 않는다.',
    '',
    '### 거리만 고른 가상 대조 방식과의 비교',
    '',
    '| 탑승 정류장 | 노선·시설 관측 | 경유 표기 제외 후 거리 비교 가능 | 최단거리 후보 모두 현재 구간 밖 | 현재 구간에 다른 후보 존재 |',
    '| --- | ---: | ---: | ---: | ---: |',...baselineRows,
    '',
    `07159에서 ${totals('07159').currentAlternativeDespiteNearestOutside}건은 현재 방향에 500m 후보가 있음에도 거리만 고른 최소 후보는 현재 운행 구간 밖에 있었다. 이는 거리 최소화와 방향 적합성이 다르다는 계산상 근거다. 07303은 ${totals('07303').currentAlternativeDespiteNearestOutside}건이다. 두 수치를 사람이나 고유 시설 수로 합산하지 않는다.`,
    '',
    '### 확인 사례',
    '',
    '351번·07159의 무지개도서관은 거리만 고르면 6번째 무지개도서관.구미파출소.건영아파트(약 49.7m)지만, 현재 58번째 경유 이후 구간의 후보는 77번째 청구아파트(약 92.8m)다. 시설 전체 이름이 노선 어딘가에 존재해도 현재 방향의 하차 후보 이름에 존재하는 것은 아니다.',
    '',
    '55번·07159의 판교역은 거리만 고르면 이미 지난 12번째 판교역동편(약 152.8m)이다. 현재 111번째 경유 이후 구간의 후보는 116번째 판교역동편(약 181.0m)으로, 같은 정류장 이름이라도 경유 순번·탑승 방향을 함께 확인해야 한다.',
    '',
    '성남여수초등학교는 55번·07159 현재 구간에는 후보가 없고, 반대편 07303에서 23번째 성남시청전면(약 356.1m)이 연결된다. 앞의 두 사례처럼 현재 구간에 대안을 찾는 경우와 반대편 탑승을 안내해야 하는 경우를 분리한다.',
    '',
    '## 보고서에 반영할 의미',
    '',
    '시설 개수 자체보다 정류장명과 목적지 이름 사이의 문자상 정보 차이, 동일 목적지의 탑승 방향별 연결 차이를 핵심 결과로 제시할 수 있다. 500m 공간 후보 추출과 운행 방향 검증을 함께 써야 한다. 기존 노선표의 전체 정보·별칭·지역 인지도를 조사하지 않았으므로 명칭 대응만으로 기존 안내가 잘못됐다고 단정하지 않는다.',
    '',
    '현재 자료의 시설 분포는 확보된 유형과 기준일에 영향을 받는다. 표시 대상은 알려진 좌표 이상을 분리한 시안용 목록이며 검증된 인지도 순위가 아니다. 고령층 효과·보행 경로·시설 입구·횡단 안전·실제 운행시간은 분석하지 않았다. 소규모 이용자 비교는 후속 현장 조사이며 숫자를 생성해 보충하지 않았다.',
    '',
    '### 보고서 삽입용 문단',
    '',
    `기존 시제품의 표시 대상 고유 시설 ${displayed.total}곳과 각 노선에서 직선 500m 이내로 연결된 정류장명을 비교하였다. 이름 단위·위치 접미어를 고려한 규칙에서 시설 전체 이름이 명시된 시설은 ${displayed.explicit}곳, 명시되지 않은 시설 중 선언한 약칭·생략 규칙의 추가 검토 대상은 ${displayed.abbreviation_review}곳이었다. 이 결과는 정류장명과 시설명 사이의 문자상 대응이며 이용자 이해 실패율을 의미하지 않는다.`,
    '',
    `6개 노선·양쪽 탑승 정류장의 운행 구간을 비교하였다. 경유/미정차 표기 지점을 후보에서 제외한 대조 분석에서 기본 07159의 노선·시설 조합 ${totals('07159').currentAlternativeDespiteNearestOutside}건은 현재 운행 구간에 하차 후보가 있음에도 거리 최소 후보가 구간 밖에 위치했다. 공간적 근접성만으로 하차 지점을 결정하지 않고 운행 순서·회차 경계·실제 정차 여부를 함께 구분할 필요가 있다. 이는 분석용 가상 대조 결과이지 실제 오탑승이나 상용 지도 오류를 측정한 값이 아니다.`,
    '',
    `품질 점검에서는 9407번의 경유 표기 지점이 고유 시설 ${passThroughAudit.affectedUniqueFacilities}곳의 하차 또는 반대 방향 안내 근거에 포함된 것을 확인하였다. 이를 분석 단계에서 제외한 뒤 재집계했다. 시제품에도 실제 정류장 기준 필터를 적용하고, 실제 정류장으로부터 직선 500m 이내 연결이 없는 시설은 해당 노선 지도와 표시 목록에서 제외했다. 제출 보고서의 문구·수치 동기화는 별도 작업이다.`,
    '',
    '## 재현',
    '',
    '`node scripts/analyze_kiosk_evidence.mjs` 실행. 분석 JSON에 시설별 명시/약칭 근거, 방향별 선택 정류장, 가상 대조 후보·동률 및 입력 파일 SHA-256을 포함했다. 새 API 호출·키 사용은 없다.',
    '',
  ].join('\n');
  await writeFile(path.join(root,'docs/kiosk-evidence-2026-10-18.md'),text);
  console.log(JSON.stringify({nameSummary:result.nameSummary,cleanDirections:cleanDirections.map(({details,...d})=>d),
    passThroughAudit:{visits:passThroughVisits.length,affectedSelections:affectedSelections.length,
      affectedUniqueFacilities:passThroughAudit.affectedUniqueFacilities}},null,2));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
