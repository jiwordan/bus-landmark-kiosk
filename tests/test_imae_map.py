"""Multi-route payload and HTTP behavior with small, key-free public fixtures."""
import csv
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import http.client
import unittest
from scripts import map_data
from scripts.map_server import make_server

ROUTES = [('204000017','55'),('204000182','351'),('107000008','422'),
          ('204000024','9407'),('204000155','누리4'),('241215002','3-1')]


def csv_file(path, rows):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)


def fixture(root):
    base=root/'data/processed/imae-kiosk'
    base.mkdir(parents=True)
    catalog={'dataDate':'2026-10-16','defaultStationId':'206000305', 'stations':[
        {'stationId':'206000305','mobileNo':'07159','name':'정류장','nextStopName':'안말초교'},
        {'stationId':'206000314','mobileNo':'07303','name':'정류장','nextStopName':'매송중학교'}], 'routes':[]}
    for rid,number in ROUTES:
        route={'routeId':rid,'routeNumber':number,'startName':'기점','endName':'종점','shapeAvailable':True,
               'stations':[{'stationId':sid,'visitKey':f'{rid}:{i}','nextStopName':'다음정류장'}
                           for i,sid in [(1,'206000305'),(2,'206000314')]]}
        catalog['routes'].append(route)
        folder=base/'routes'/rid
        csv_file(folder/'stops.csv',[{'routeId':rid,'stationId':sid,'stationSeq':i,'stationName':'정류장',
            'x':127.123,'y':37.395,'turnSeq':2,'turnYn':'N','visitKey':f'{rid}:{i}'}
            for i,sid in [(1,'206000305'),(2,'206000314'),(3,'terminal')]])
        csv_file(folder/'route-line.csv',[{'routeId':rid,'lineSeq':i,'x':127.123,'y':37.395} for i in [1,2]])
        csv_file(folder/'landmarks/candidates-500m.csv',[{'facility_id':'f1','name':'학교','category':'학교',
            'source_url':'https://www.data.go.kr/','reference_date':'2026-01-01','latitude':37.395,'longitude':127.123}])
        csv_file(folder/'display-review.csv',[{'facility_id':'f1','name':'학교','category':'학교',
            'review_status':'normal_review','review_note':'기초 검토'}])
        csv_file(folder/'landmarks/stop-facility-links-500m.csv',[{'route_id':rid,'visit_key':f'{rid}:1',
            'station_id':'206000305','station_seq':1,'facility_id':'f1','distance_m':10}])
    (base/'catalog.json').write_text(json.dumps(catalog),encoding='utf-8')
    (root/'web/kiosk').mkdir(parents=True)
    (root/'web/kiosk/index.html').write_text('public',encoding='utf-8')
    return catalog


class ImaeMapTests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.catalog=fixture(self.root)

    def test_catalog_and_selected_visit(self):
        self.assertTrue(hasattr(map_data,'load_catalog'),'Catalog reader missing')
        self.assertEqual(map_data.load_catalog(self.root)['defaultStationId'],'206000305')
        for rid,number in ROUTES:
            p=map_data.build_payload(self.root,rid,'206000305')
            self.assertEqual((p['routeNumber'],p['sampleVisitKey']), (number,f'{rid}:1'))
            self.assertEqual(map_data.build_payload(self.root,rid,'206000314')['sampleVisitKey'],f'{rid}:2')
        for rid,sid in [('999','206000305'),('../204000017','206000305'),('204000017','missing')]:
            with self.assertRaises(ValueError): map_data.build_payload(self.root,rid,sid)

    def test_missing_shape_does_not_create_line(self):
        self.catalog['routes'][0]['shapeAvailable']=False
        base=self.root/'data/processed/imae-kiosk'
        (base/'catalog.json').write_text(json.dumps(self.catalog),encoding='utf-8')
        (base/'routes/204000017/route-line.csv').write_text('routeId,lineSeq,x,y\n',encoding='utf-8')
        p=map_data.build_payload(self.root,'204000017','206000305')
        self.assertFalse(p['shapeAvailable']); self.assertEqual(p['shape'],[])

    def test_invalid_review_or_foreign_link_rejected(self):
        folder=self.root/'data/processed/imae-kiosk/routes/204000017'
        path=folder/'landmarks/stop-facility-links-500m.csv'
        text=path.read_text(encoding='utf-8-sig')
        path.write_text(text.replace('204000017,','999,'),encoding='utf-8-sig')
        with self.assertRaises(ValueError): map_data.build_payload(self.root,'204000017','206000305')
        path.write_text(text,encoding='utf-8-sig')
        (folder/'display-review.csv').write_text('facility_id,name,category,review_status,review_note\n',encoding='utf-8')
        with self.assertRaises(ValueError): map_data.build_payload(self.root,'204000017','206000305')

    def test_http_catalog_and_strict_queries(self):
        server=make_server(self.root,0); thread=Thread(target=server.serve_forever,daemon=True); thread.start()
        def request(path):
            c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:
                c.request('GET',path); r=c.getresponse(); return r.status,json.loads(r.read())
            finally: c.close()
        try:
            status,catalog=request('/api/catalog'); self.assertEqual(status,200)
            self.assertEqual(len(catalog['routes']),6)
            status,p=request('/api/map-data?routeId=204000017&stationId=206000305')
            self.assertEqual(status,200); self.assertEqual(p['sampleVisitKey'],'204000017:1')
            for path in ['/api/map-data?routeId=999','/api/map-data?routeId=../secret',
                         '/api/map-data?routeId=204000017&routeId=204000182',
                         '/api/map-data?routeId=204000017&extra=x',
                         '/api/bus-locations?routeId=999']:
                self.assertEqual(request(path)[0],400,path)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__=='__main__': unittest.main()
