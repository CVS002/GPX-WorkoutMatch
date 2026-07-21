#!/usr/bin/env python3
"""Extend data/cache/workout_bank.json from whatsonzwift.com.

whatsonzwift.com is a privately-run fan catalogue (not Zwift-hosted). We take
only the **numeric workout structure** — segment durations, %FTP, cadence,
repeats — which are training facts, never the site's prose descriptions. Each
plan page lists its workouts under `<h3 ... flaticon-bike>` headers, with every
segment rendered in a `.textbar` (e.g. "4x 5min @ 80% FTP, 1min @ 61% FTP").
We parse those into (duration_s, power_frac) bouts and reuse the existing bank's
classify()/summarize() so entries match the GitHub-sourced ones exactly.

Usage:
    python build_workout_bank_woz.py [--limit N] [--out <path>] [--sleep 0.25]

Merges into the existing bank (keeps prior entries, dedupes by name+duration).
Needs internet. Stdlib only.
"""
import os, re, sys, json, time, html as H, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_workout_bank import classify, summarize, CATS  # noqa: E402

UA = {"User-Agent": "gpx-workout-designer-v2/2.0 (personal training tool)"}
BASE = "https://whatsonzwift.com"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "..", "data", "cache", "workout_bank.json")

H3 = re.compile(r'<h3 class="text-3xl glyph-icon flaticon-bike">\s*([^<]+?)</h3>')
TEXTBAR = re.compile(r'<div class="textbar"[^>]*>(.*?)</div>', re.S)
SEG = re.compile(r'(\d+)\s*(min|sec)\s*(?:@\s*)?(?:(\d+)rpm,\s*)?'
                 r'(?:from\s*(\d+)\s*to\s*(\d+)|(\d+))\s*%\s*FTP')


def get(url, tries=3):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            if k == tries - 1:
                return None
            time.sleep(2)


def plan_slugs():
    idx = get(BASE + "/workouts/") or ""
    slugs = re.findall(r'href="(?:https://whatsonzwift\.com)?/workouts/([a-z0-9][a-z0-9\-]+)"', idx)
    out, seen = [], set()
    for s in slugs:
        if s in ("group-workouts",) or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def seg_to_bouts(txt):
    m = re.match(r'\s*(\d+)x\s+', txt)
    rep = int(m.group(1)) if m else 1
    body = txt[m.end():] if m else txt
    bouts = []
    for sm in SEG.finditer(body):
        d = int(sm.group(1)) * (60 if sm.group(2) == "min" else 1)
        if sm.group(4):
            p = (int(sm.group(4)) + int(sm.group(5))) / 200.0
        else:
            p = int(sm.group(6)) / 100.0
        bouts.append((d, p))
    return bouts * rep


def parse_plan(slug):
    h = get(f"{BASE}/workouts/{slug}")
    if not h:
        return []
    heads = [(m.start(), H.unescape(m.group(1)).strip()) for m in H3.finditer(h)]
    tbs = [(m.start(), H.unescape(re.sub(r'<[^>]+>', '', m.group(1))).strip())
           for m in TEXTBAR.finditer(h)]
    out = []
    for i, (pos, name) in enumerate(heads):
        end = heads[i + 1][0] if i + 1 < len(heads) else len(h)
        bouts = []
        for tp, txt in tbs:
            if pos < tp < end:
                bouts += seg_to_bouts(txt)
        total = sum(d for d, _ in bouts)
        if total < 300:            # skip freerides / run / swim / junk (<5 min of FTP work)
            continue
        out.append({
            "name": name,
            "plan": slug.replace("-", " ").title(),
            "category": classify(bouts),
            "duration_min": round(total / 60, 1),
            "structure": summarize(bouts),
            "source": f"whatsonzwift:{slug}",
        })
    return out


def main():
    argv = sys.argv[1:]
    limit = int(argv[argv.index("--limit") + 1]) if "--limit" in argv else None
    out = argv[argv.index("--out") + 1] if "--out" in argv else DEFAULT_OUT
    sleep = float(argv[argv.index("--sleep") + 1]) if "--sleep" in argv else 0.25
    out = os.path.abspath(out)

    existing = {"meta": {}, "workouts": []}
    if os.path.exists(out):
        existing = json.load(open(out, encoding="utf-8"))
    bank = list(existing.get("workouts", []))
    seen = {(w["name"].lower(), round(w["duration_min"]), w.get("structure", "")) for w in bank}
    before = len(bank)

    slugs = plan_slugs()
    if limit:
        slugs = slugs[:limit]
    print(f"{len(slugs)} plans to scan (bank starts at {before})")
    added = 0
    for n, slug in enumerate(slugs, 1):
        for w in parse_plan(slug):
            sig = (w["name"].lower(), round(w["duration_min"]), w["structure"])
            if sig in seen:
                continue
            seen.add(sig)
            bank.append(w)
            added += 1
        if n % 20 == 0:
            print(f"  {n}/{len(slugs)} plans, +{added} so far")
        time.sleep(sleep)

    meta = existing.get("meta", {})
    meta["generated"] = meta.get("generated", "")
    meta["count"] = len(bank)
    meta["woz_added"] = added
    meta.setdefault("sources", [])
    if "whatsonzwift.com (numeric structure only)" not in meta["sources"]:
        meta["sources"].append("whatsonzwift.com (numeric structure only)")
    json.dump({"meta": meta, "workouts": bank}, open(out, "w", encoding="utf-8"), indent=1)

    from collections import Counter
    c = Counter(w["category"] for w in bank)
    print(f"\nbank {before} -> {len(bank)} (+{added} from whatsonzwift) -> {out}")
    for cat in CATS:
        print(f"  {cat:10} {c.get(cat,0)}")


if __name__ == "__main__":
    main()
