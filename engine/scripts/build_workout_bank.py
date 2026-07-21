#!/usr/bin/env python3
"""Build data/cache/workout_bank.json from open .zwo repos on GitHub.

Parses each workout, classifies it into 7 buckets (sprint/anaerobic/vo2max/
threshold/sweetspot/tempo/endurance) by where its work-time is spent, and
stores a compact structure line. Heuristic; re-run to refresh/extend. Needs
internet. Stdlib only. Broader future source: see DEVELOPMENT.md (whatsonzwift)."""
import json, urllib.request, urllib.error, xml.etree.ElementTree as ET, time, sys

UA = {"User-Agent": "gpx-workout-designer-v2/2.0"}
CATS = ["sprint", "anaerobic", "vo2max", "threshold", "sweetspot", "tempo", "endurance"]


def get(url, is_json=True, tries=3):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
                return json.loads(data) if is_json else data.decode("utf-8", "replace")
        except Exception as e:
            if k == tries - 1:
                return None
            time.sleep(2)


def find_repos():
    queries = ["zwift+workouts", "zwo+workouts", "zwift+workout+library",
               "cycling+zwo", "trainerroad+zwo", "zwift+training+plan"]
    seen, out = set(), []
    for q in queries:
        j = get(f"https://api.github.com/search/repositories?q={q}&sort=stars&per_page=20") or {}
        for it in j.get("items", []):
            fn = it["full_name"]
            if fn in seen:
                continue
            seen.add(fn)
            out.append((fn, it["default_branch"], it["stargazers_count"]))
        time.sleep(1)
    return out


def list_zwo(full, branch):
    j = get(f"https://api.github.com/repos/{full}/git/trees/{branch}?recursive=1")
    if not j or "tree" not in j:
        return []
    return [t["path"] for t in j["tree"] if t["path"].lower().endswith(".zwo")]


def num(x, d=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def parse_zwo(text):
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None
    wk = root.find("workout")
    name_el = root.find("name")
    name = (name_el.text or "").strip() if name_el is not None else ""
    if wk is None:
        return None
    bouts = []  # (duration_s, power_frac)
    total = 0.0
    for el in wk:
        tag = el.tag
        a = el.attrib
        if tag == "IntervalsT":
            rep = int(num(a.get("Repeat"), 1))
            on_d, off_d = num(a.get("OnDuration")), num(a.get("OffDuration"))
            on_p, off_p = num(a.get("OnPower")), num(a.get("OffPower"))
            for _ in range(rep):
                bouts.append((on_d, on_p)); bouts.append((off_d, off_p))
                total += on_d + off_d
        elif tag in ("SteadyState", "Warmup", "Cooldown", "Ramp", "FreeRide", "MaxEffort"):
            d = num(a.get("Duration"))
            if "Power" in a:
                p = num(a.get("Power"))
            else:
                p = (num(a.get("PowerLow")) + num(a.get("PowerHigh"))) / 2 or num(a.get("PowerLow"))
            if tag == "MaxEffort":
                p = 1.6
            bouts.append((d, p)); total += d
    if total < 300:  # ignore junk / < 5 min
        return None
    return name, bouts, total


def classify(bouts):
    band = {c: 0.0 for c in CATS}
    for d, p in bouts:
        if p >= 1.5: band["sprint"] += d
        elif p >= 1.2: band["anaerobic"] += d
        elif p >= 1.06: band["vo2max"] += d
        elif p >= 0.95: band["threshold"] += d
        elif p >= 0.88: band["sweetspot"] += d
        elif p >= 0.76: band["tempo"] += d
    # highest-intensity band with >=90s of work; else endurance
    for c in CATS[:-1]:
        if band[c] >= 90:
            return c
    return "endurance"


def summarize(bouts):
    """Short human structure: collapse the dominant work interval."""
    work = [(d, p) for d, p in bouts if p >= 0.76 and d >= 20]
    if not work:
        return "steady aerobic"
    # find most-repeated (dur,power) rounded
    from collections import Counter
    key = Counter((round(d), round(p, 2)) for d, p in work)
    (dur, pw), n = key.most_common(1)[0]
    mins = dur / 60
    dtxt = f"{mins:.0f}min" if mins >= 1.5 else f"{dur:.0f}s"
    return f"{n}x {dtxt} @ {int(pw*100)}% FTP" if n > 1 else f"{dtxt} @ {int(pw*100)}% FTP"


def main():
    repos = find_repos()
    print("candidate repos:", [(r[0], r[2]) for r in repos[:8]])
    bank, seen = [], set()
    used = []
    for full, branch, stars in repos:
        if len(bank) >= 900:
            break
        paths = list_zwo(full, branch)
        if len(paths) < 3:
            continue
        used.append((full, len(paths)))
        for p in paths[:250]:
            if len(bank) >= 900:
                break
            raw = get(f"https://raw.githubusercontent.com/{full}/{branch}/{p}", is_json=False)
            if not raw:
                continue
            parsed = parse_zwo(raw)
            if not parsed:
                continue
            name, bouts, total = parsed
            cat = classify(bouts)
            sig = (name.lower(), round(total))
            if sig in seen:
                continue
            seen.add(sig)
            bank.append({
                "name": name or p.split("/")[-1][:-4],
                "category": cat,
                "duration_min": round(total / 60, 1),
                "structure": summarize(bouts),
                "source": full,
            })
        print(f"  {full}: {len(paths)} zwo, bank now {len(bank)}")
    import os
    here=os.path.dirname(os.path.abspath(__file__))
    out=os.path.join(here,"..","data","cache","workout_bank.json")
    payload = {"meta": {"source_repos": used, "generated": time.strftime("%Y-%m-%d"),
                        "count": len(bank), "license_note": "structures parsed from open .zwo files; training facts only"},
               "workouts": bank}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    from collections import Counter
    c = Counter(w["category"] for w in bank)
    print("\nTOTAL", len(bank), "workouts ->", out)
    for cat in CATS:
        print(f"  {cat:10} {c.get(cat,0)}")


if __name__ == "__main__":
    main()
