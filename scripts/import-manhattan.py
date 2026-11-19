"""Import Manhattan Island from a BBBike NewYork OSM PBF extract.

Usage: python3 scripts/import-manhattan.py /path/to/NewYork.osm.pbf
Dependencies: osmium, shapely, numpy, Pillow
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import osmium
from PIL import Image, ImageDraw
from shapely import LineString, Point, Polygon, box, prepare
from shapely.ops import polygonize

OUTPUT = Path(__file__).resolve().parents[1] / "public" / "data"
LAT, LON = 40.74865, -73.98493  # match the Midtown arena
METRES_PER_DEGREE = 111320
LON_SCALE = METRES_PER_DEGREE * math.cos(math.radians(LAT))
SEARCH = box(-74.06, 40.67, -73.87, 40.92)
ROAD_KINDS = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "residential",
    "unclassified", "service", "living_street", "pedestrian", "footway",
    "cycleway", "path", "track", "motorway_link", "trunk_link", "primary_link",
    "secondary_link", "tertiary_link",
}


def project(lon, lat):
    return round((lon - LON) * LON_SCALE, 2), round((LAT - lat) * METRES_PER_DEGREE, 2)


def coordinates(nodes):
    return [(node.lon, node.lat) for node in nodes]


class Coast(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def way(self, way):
        if way.tags.get("natural") != "coastline":
            return
        try:
            line = LineString(coordinates(way.nodes))
        except (osmium.InvalidLocationError, ValueError):
            return
        if SEARCH.intersects(line):
            self.lines.append(line)


def line_parts(shape):
    if shape.geom_type == "LineString" and not shape.is_empty:
        yield shape
    elif shape.geom_type in ("MultiLineString", "GeometryCollection"):
        for part in shape.geoms:
            yield from line_parts(part)


class City(osmium.SimpleHandler):
    def __init__(self, island):
        super().__init__()
        self.island = island
        self.bounds = island.bounds
        prepare(island)
        self.roads = []
        self.buildings = []

    def way(self, way):
        tags = way.tags
        kind = tags.get("highway")
        if (kind not in ROAD_KINDS or tags.get("tunnel", "no") != "no"
                or tags.get("indoor") == "yes" or tags.get("covered") == "yes"
                or tags.get("area") == "yes" or tags.get("footway") in ("sidewalk", "crossing")):
            return
        try:
            coords = coordinates(way.nodes)
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2 or not self.in_bounds(coords):
            return
        line = LineString(coords)
        if not self.island.intersects(line):
            return
        if not self.island.covers(line):
            line = self.island.intersection(line)
        lanes = tags.get("lanes", "")
        width = tags.get("width") or (str(min(19, int(lanes) * 3.15)) if lanes.isdecimal() else None)
        for part in line_parts(line):
            points = [project(*point) for point in part.coords]
            if len(set(points)) < 2:
                continue
            self.roads.append(dict(
                id=way.id, name=tags.get("name", ""), kind=kind,
                bridge=tags.get("bridge", "no") != "no", tunnel=False,
                width=width, points=points,
            ))

    def area(self, area):
        tags = area.tags
        kind = tags.get("building")
        if not kind or kind in ("no", "roof") or tags.get("location") == "underground":
            return
        for outer in area.outer_rings():
            coords = coordinates(outer)
            if len(coords) < 4 or not self.in_bounds(coords):
                continue
            footprint = Polygon(coords)
            if not self.island.covers(footprint.representative_point()):
                continue
            footprint = Polygon([project(*point) for point in coords]).simplify(0.35)
            if footprint.is_empty or footprint.area < 8:
                continue
            self.buildings.append(dict(
                id=area.id, name=tags.get("name", ""), kind=kind, height=tags.get("height"),
                levels=tags.get("building:levels"), roof=tags.get("roof:shape", "flat"),
                points=list(footprint.exterior.coords)[:-1],
            ))

    def in_bounds(self, coords):
        west, south, east, north = self.bounds
        return any(west <= x <= east and south <= y <= north for x, y in coords)


def write_ground(island):
    # A flat land surface above the game's fixed water plane, following the real shoreline.
    cell = 10
    shore = [project(*point) for point in island.exterior.coords]
    xs, zs = zip(*shore)
    ox = math.floor((min(xs) - 1000) / cell) * cell
    oz = math.floor((min(zs) - 1000) / cell) * cell
    width = math.ceil((max(xs) + 1000 - ox) / cell)
    height = math.ceil((max(zs) + 1000 - oz) / cell)
    land = Image.new("1", (width, height))
    ImageDraw.Draw(land).polygon([((x - ox) / cell - 0.5, (z - oz) / cell - 0.5) for x, z in shore], fill=1)
    samples = np.asarray(land, dtype="<u2") * 200  # 390 m seabed, 400 m land
    samples.astype("<u2").tofile(OUTPUT / "manhattan-island-terrain.bin")
    meta = dict(width=width, height=height, cell_m=cell, min_m=390, step_m=0.05, origin_x=ox, origin_z=oz)
    (OUTPUT / "manhattan-island-terrain.json").write_text(json.dumps(meta, indent=2) + "\n")


def main(pbf):
    coast = Coast()
    coast.apply_file(pbf, locations=True)
    midtown = Point(LON, LAT)
    island = next(polygon for polygon in polygonize(coast.lines) if polygon.covers(midtown))
    city = City(island)
    city.apply_file(pbf, locations=True)
    write_ground(island)
    with (OUTPUT / "manhattan-island.json").open("w") as out:
        out.write('{"source":"© OpenStreetMap contributors · ODbL 1.0"')
        for key, records in (("roads", city.roads), ("buildings", city.buildings)):
            out.write(f',"{key}":[\n')
            out.write(",\n".join(json.dumps(record, separators=(",", ":")) for record in records))
            out.write("\n]")
        out.write("}\n")
    print(f"Imported {len(city.roads):,} roads and {len(city.buildings):,} buildings")


if __name__ == "__main__":
    main(sys.argv[1])
