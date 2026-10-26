#!/usr/bin/env python3
"""Mock intervals.icu + Overpass servers for the parity test.

    python test/parity/mocks.py <fixtures_dir> <icu_port> <overpass_port>

intervals.icu: the endpoints icu.py/icu.ts call, Basic auth API_KEY:testkey.
Overpass: understands the queries the engine sends — bbox node/way selections,
`around:R,lat,lon,...` selections, `out center` / `out geom` — and answers from
the fixture OSM world (ways selected when any node is inside, sorted by id).
"""
import base64
import json
import math
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

FIX, ICU_PORT, OVP_PORT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
ICU = json.load(open(f"{FIX}/icu/world.json"))
RIDES = json.load(open(f"{FIX}/icu/rides.json"))
OSM = json.load(open(f"{FIX}/osm/world.json"))
CREATED = []


def hav(la1, lo1, la2, lo2):
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371000.0 * math.asin(math.sqrt(x))


class Icu(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        h = self.headers.get("Authorization", "")
        ok = h.startswith("Basic ") and base64.b64decode(h[6:]).decode() == "API_KEY:testkey"
        if not ok:
            self._send(401, {"error": "unauthorized"})
        return ok

    def do_GET(self):
        if not self._auth():
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path
        if re.fullmatch(r"/api/v1/athlete/\w+/activities", p):
            days = (int(q["oldest"][0][:4]) * 365 + int(q["oldest"][0][5:7]) * 31, int(q["newest"][0][:4]) * 365 + int(q["newest"][0][5:7]) * 31)
            span = days[1] - days[0]
            return self._send(200, ICU["activities_history"] if span > 100 else ICU["activities_recent"])
        if re.fullmatch(r"/api/v1/athlete/\w+/wellness", p):
            return self._send(200, ICU["wellness"])
        if re.fullmatch(r"/api/v1/athlete/\w+", p):
            return self._send(200, ICU["athlete"])
        if re.fullmatch(r"/api/v1/athlete/\w+/events", p):
            return self._send(200, ICU["events"])
        m = re.fullmatch(r"/api/v1/athlete/\w+/events/(\w+)", p)
        if m:
            return self._send(200, ICU["created_event"] if m.group(1) == str(ICU["created_event"]["id"]) else {})
        m = re.fullmatch(r"/api/v1/activity/(\w+)/(map|streams)", p)
        if m and m.group(1) in RIDES:
            return self._send(200, RIDES[m.group(1)]["map" if m.group(2) == "map" else "streams"])
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        CREATED.append(body)
        self._send(200, {"id": ICU["created_event"]["id"], **body})


BBOX = re.compile(r"\((-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\)")
AROUND = re.compile(r"around:(\d+),([-\d.,]+)\)")


def node_tags_match(stmt, tags):
    for k, v in re.findall(r"\[(\w+)=(\w+)\]", stmt):
        if tags.get(k) != v:
            return False
    return True


class Ovp(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        q = self.rfile.read(n).decode()
        if q.startswith("data="):
            from urllib.parse import unquote_plus
            q = unquote_plus(q[5:])
        out = []
        around = AROUND.search(q)
        if around:
            rad = float(around.group(1))
            c = [float(x) for x in around.group(2).split(",")]
            coords = list(zip(c[0::2], c[1::2]))

            def near(la, lo):
                return any(abs(la - a) < 0.01 and abs(lo - b) < 0.016 and hav(la, lo, a, b) <= rad for a, b in coords)
        else:
            b = BBOX.search(q)
            s, w, nn, e = (float(x) for x in b.groups())

            def near(la, lo):
                return s <= la <= nn and w <= lo <= e
        if "out geom" in q:
            rx = re.search(r'highway"?~"\^\(([^)]*)\)(\(_link\)\?)?\$"', q)
            classes = rx.group(1).split("|")
            link = bool(rx.group(2))
            for wy in OSM["streets"]:
                hw = wy["tags"].get("highway", "")
                base = hw[:-5] if link and hw.endswith("_link") else hw
                if base not in classes and hw not in classes:
                    continue
                if any(near(g["lat"], g["lon"]) for g in wy["geometry"]):
                    out.append(wy)
        else:
            stmts = [x.strip() for x in q.split(";") if x.strip().startswith(("node", "way"))]
            for nd in OSM["nodes"]:
                if any(st.startswith("node") and node_tags_match(st, nd["tags"]) for st in stmts) and near(nd["lat"], nd["lon"]):
                    out.append(nd)
            if any("junction=roundabout" in st for st in stmts):
                for wy in OSM["ways"]:
                    if near(wy["center"]["lat"], wy["center"]["lon"]):
                        out.append(wy)
            out.sort(key=lambda x: (0 if x["type"] == "node" else 1, x["id"]))
        body = json.dumps({"version": 0.6, "elements": out}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


a = ThreadingHTTPServer(("127.0.0.1", ICU_PORT), Icu)
b = ThreadingHTTPServer(("127.0.0.1", OVP_PORT), Ovp)
threading.Thread(target=a.serve_forever, daemon=True).start()
print(f"mocks: icu :{ICU_PORT}  overpass :{OVP_PORT}", flush=True)
b.serve_forever()
