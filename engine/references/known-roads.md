# Known roads dossier

Confirmed, human-verified judgments about specific roads and junctions around
the athlete's usual training area. This is Layer 4: it turns the athlete's
local knowledge into a permanent asset so the skill asks fewer questions over
time.

**This athlete's home area:** Eindhoven / Son en Breugel / Waalre /
Heeze-Leende (flat — junction/light data matters more than gradient). When
filtering ride history for the road DB, prioritise rides in this area.
*(Installing for a different athlete? Reset this file to the template below.)*

## How the skill uses this file

- **Read it during Step 3 (design).** Match entries against the route's km
  positions and named roads. A confirmed "TT-grade, uninterrupted" entry lets
  you place an effort with confidence even if geometry alone looked marginal;
  a confirmed "always a light" entry vetoes an effort start there.
- **Prefer confirmed entries over inferred layers.** This file outranks the
  geometry score (Layer 1), the ride-history cache (Layer 2), and OSM
  (Layer 3) wherever they disagree — it is the athlete's own verified word.
- **Append after every ride/correction.** When the athlete corrects a
  proposal ("no, that stretch has a light") or reports back after riding,
  add or update an entry here. Over time the skill proposes and the athlete
  only confirms.

## Entry format

Each entry is a bullet with a stable road/segment label, a verdict tag, and a
short note. Verdict tags:

- `TT-grade` — long, straight, uninterrupted; safe for sustained max efforts
- `effort-ok` — usable for efforts, minor interruptions only
- `float-only` — rideable but junction/traffic-broken; use for recovery/float
- `avoid-effort` — do not place structured efforts here (lights, crossings, town)
- `note` — general context (surface, wind exposure, etc.)

Template:

```
- <Road / segment name> [<verdict>] (confirmed <YYYY-MM-DD>): <note>.
  Seen near km <range> on: <route names or activity ids where relevant>.
```

## Confirmed entries

_None yet confirmed by the athlete. Add the first one after the next ride._

## Inferred road intelligence (Layers 2+3, unconfirmed)

Auto-derived on 2026-07-12 from the ride-history cache (Layer 2, 98 rides)
cross-checked against the OSM hazard cache (Layer 3). The design step **uses
these as soft signals** (they already live in the caches); they are recorded
here for context and do not need the athlete to confirm anything. If the
athlete ever contradicts one, move a corrected version into "Confirmed entries"
above, where it outranks the inference. Evidence tags: L2 = ride-history
near-stop, L3 = OSM feature; "L2+L3 agree" is the strongest signal.

### On the EHV 40 km "Prodrive terug kort" route

- **Prodrive long straight out, km ~13.3–23** [effort-ok, not one clean run]:
  very well ridden (6–16 passes/km, 100% coverage) but broken into two clean
  sub-runs, **km 13.3–17.2 (~4 km)** and **km 17.6–23 (~5 km)**, by:
  - **Entry lights, km 11.9 and 13.2** [L3] — start sustained efforts after
    km 13.3, not at km 12.
  - **Recurring near-stop, km ~17.3** [L2] — 14% near-stop across 9 rides, no
    OSM signal; treat as a busy give-way and don't start an effort on it.
- **Railway-crossing cluster, km ~29.6–32.7** [L2+L3 agree]: OSM level crossings
  at km 29.6 / 31.6 / 32.4 / 32.7 plus signals ~km 32.4; history shows a
  near-stop across the km 27–33 band. Barrier zone before the finish — no effort
  starts across it.
- **Near-stop at km ~27.2** [L2, weak]: 36% stop-rate but only 2 rides — low
  confidence; likely just a turn.

### Home-area recurring near-stops (any route through them)

- **Level crossing ~51.4579, 5.5908 (Breugel side)** [L2+L3 agree]: 13 rides,
  ~20% near-stop, OSM level_crossing 24 m away. Reliable stop; avoid effort
  starts within ~150 m either side.
- **Junction ~51.4980, 5.4504 (Son, N-road area)** [L2]: 20 rides, ~21%
  near-stop, no OSM signal within 45 m — an unmapped busy give-way / frequently
  red side street.
- **Junction ~51.5169, 5.2855 (NW of Son)** [L2]: 14 rides, ~21% near-stop,
  nothing in OSM nearby — likely an uncontrolled crossing.

### Known false positive (do not treat as a hazard)

- **Home / front-door cluster ~51.4539, 5.4454** [note]: the single highest
  near-stop count (30 rides, 37%) is the mounting/dismounting spot at the start
  and end of nearly every ride, not a road hazard. Kept here so it is not
  re-surfaced as a candidate on future runs.
