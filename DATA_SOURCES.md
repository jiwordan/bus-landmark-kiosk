# 데이터 출처와 공개 범위

버스 수집일은 2026-10-16, 시설 보존일은 2026-10-11입니다. 수집일과 각 레코드의 데이터 기준일은 다릅니다. 시설 CSV의 `source_url`, `source_provider`, `reference_date`, `source_record_refs` 등 출처 필드를 보존했습니다.

| 자료 | 제공기관·제공 주체 | 공식 URL |
| --- | --- | --- |
| 경기도_버스노선 조회 | 경기도 | https://www.data.go.kr/data/15080662/openapi.do |
| 경기도_정류소 조회 | 경기도 | https://www.data.go.kr/data/15080666/openapi.do |
| 경기도_버스위치정보 조회 | 경기도 | https://www.data.go.kr/data/15080648/openapi.do |
| 전국초중등학교위치표준데이터 | 한국교육시설안전원 | https://www.data.go.kr/data/15021148/standard.do |
| 전국박물관미술관정보표준데이터 | 지방자치단체·문화체육관광부 등 | https://www.data.go.kr/data/15017323/standard.do |
| 전국도서관표준데이터 | 지방자치단체·교육청 등 | https://www.data.go.kr/data/15013109/standard.do |
| 전국도시공원정보표준데이터 | 지방자치단체 등 | https://www.data.go.kr/data/15012890/standard.do |
| 전국전통시장표준데이터 | 소상공인시장진흥공단 | https://www.data.go.kr/data/15012894/standard.do |
| 전국도시철도역사정보표준데이터 | 철도 운영기관·지방자치단체 등 | https://www.data.go.kr/data/15013205/standard.do |
| 전국공공시설개방정보표준데이터 | 지방자치단체 등 | https://www.data.go.kr/data/15013117/standard.do |

## 이용조건 확인 범위

2026-10-21 공식 포털 확인 시 경기도 버스 API 3종은 `이용허락범위 제한 없음`으로 표시되었습니다. 시설 표준 목록 중 일부는 동일 화면에 이용조건이 별도로 표시되지 않았으며, 모든 개별 원천자료의 이용조건을 검증 완료한 것으로 주장하지 않습니다. 재이용자는 위 공식 출처와 원제공자의 현재 이용조건을 확인해야 합니다. 이 문서는 제공자의 허락을 대신하지 않습니다.

공개 파일은 분석에 사용한 노선 주변 부분집합과 산출물입니다. 전국 시설 원본 전체, 실시간 차량 원문, 요청 URL·인증키, 개인 위치·설문자료는 포함하지 않습니다. 시설 대표 좌표는 출입구나 안전한 보행 경로가 아닙니다.

## 네이버 지도와 권리 범위

네이버 Maps JavaScript API는 배경지도 표시용입니다. 명칭·거리·방향 분석의 입력 자료가 아닙니다. 공식 SDK 호출 코드만 포함하며 SDK·지도 타일·지도 캡처·지도 포함 PDF를 재배포하지 않습니다.

- API 문서: https://navermaps.github.io/maps.js.ncp/docs/
- Maps 이용약관: https://www.ncloud.com/policy/terms/maps

키 설정 및 이용 한도는 실행자 본인 계정으로 관리해야 합니다. 저장소에 있는 공개 코드와 데이터 출처 표기가 외부 서비스나 외부 데이터에 대한 소유권·포괄적인 재배포 허락을 부여하는 것은 아닙니다. 별도의 오픈소스 라이선스는 부여하지 않았습니다.
