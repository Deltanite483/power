"""Convert a local Overpass `out geom` extract into Power's LV95-relative scene data.
Usage: python3 scripts/import-scenery.py /path/to/overpass.json
Source projection: swisstopo's published WGS84 -> LV95 approximation (navigation accuracy).
Geometry remains OpenStreetMap data, © OpenStreetMap contributors, ODbL 1.0.
"""
import json, math, sys
from pathlib import Path
try:
    from pyproj import Transformer
    transformer = Transformer.from_crs(4326,2056,always_xy=True)
except ImportError:
    transformer = None
root = Path(__file__).resolve().parent.parent
origin = json.loads((root / 'public/data/terrain.json').read_text())['lv95_origin']
def project(p):
    if transformer:
        e,n=transformer.transform(p['lon'],p['lat'])
        return [round(e-origin[0],2),round(origin[1]-n,2)]
    lat = (p['lat'] * 3600 - 169028.66) / 10000
    lon = (p['lon'] * 3600 - 26782.5) / 10000
    e = 2600072.37 + 211455.93*lon - 10938.51*lon*lat - .36*lon*lat*lat - 44.54*lon**3
    n = 1200147.07 + 308807.95*lat + 3745.25*lon*lon + 76.63*lat*lat - 194.56*lon*lon*lat + 119.79*lat**3
    return [round(e-origin[0], 2), round(origin[1]-n, 2)]
if sys.argv[1].endswith('.pbf'):
    import osmium
    class Extract(osmium.SimpleHandler):
        def __init__(self):
            super().__init__(); self.elements=[]
        def way(self,w):
            tags=dict(w.tags)
            if not ('highway' in tags or 'building' in tags): return
            try: geometry=[dict(lat=n.lat,lon=n.lon) for n in w.nodes]
            except osmium.InvalidLocationError: return
            if not any(47.124<p['lat']<47.176 and 9.483<p['lon']<9.55 for p in geometry): return
            self.elements.append(dict(id=w.id,tags=tags,geometry=geometry))
    extract=Extract(); extract.apply_file(sys.argv[1],locations=True)
    raw=dict(elements=extract.elements)
else:
    raw = json.loads(Path(sys.argv[1]).read_text())
roads, buildings = [], []
for e in raw['elements']:
    tags, points = e.get('tags', {}), [project(p) for p in e.get('geometry', [])]
    if len(points) < 2: continue
    if 'highway' in tags:
        if tags['highway'] in ['construction','proposed','steps']: continue
        roads.append(dict(id=e['id'], name=tags.get('name',''), kind=tags['highway'], bridge=tags.get('bridge','no')!='no', tunnel=tags.get('tunnel','no')!='no', width=tags.get('width'), points=points))
    elif 'building' in tags and len(points) >= 4:
        if points[0] == points[-1]: points.pop()
        cx = sum(p[0] for p in points)/len(points); cz = sum(p[1] for p in points)/len(points)
        if math.hypot(cx,cz)>1250: continue
        area = abs(sum(p[0]*q[1]-q[0]*p[1] for p,q in zip(points, points[1:]+points[:1])))/2
        if area < 20: continue
        buildings.append(dict(id=e['id'], name=tags.get('name',tags.get('addr:street','')+' '+tags.get('addr:housenumber','')).strip(), kind=tags['building'], height=tags.get('height'), levels=tags.get('building:levels'), roof=tags.get('roof:shape'), points=points))
buildings.sort(key=lambda b: min(x*x+z*z for x,z in b['points']))
out=dict(source='© OpenStreetMap contributors', license='ODbL-1.0', attribution='https://www.openstreetmap.org/copyright', osmTimestamp=raw.get('osm3s',{}).get('timestamp_osm_base'), projection='LV95 relative to terrain.json lv95_origin; z points south', roads=roads, buildings=buildings[:240])
(root/'public/data/scenery.json').write_text(json.dumps(out,separators=(',',':')))
print(f"Imported {len(roads)} roads and {len(out['buildings'])} building footprints")
