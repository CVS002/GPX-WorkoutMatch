# Workout library

The catalogue the designer picks from. Each type has **one physiological
objective**. Select by objective → phase → terrain → recent load (see
`coaching-engine.md`); do not default to the same template every time.

All intensities are **% of the athlete's current FTP** (read it at runtime —
`icu_get_sport_settings`). HR is **% of FTHR** (also read at runtime from sport
settings — never reuse a number found in these files) as a cross-check; on
efforts ≤3 min HR lags, so **pace by power/RPE, not HR**.
Cadence is a target, not a hard rule. Syntax follows `workout-syntax.md`
(distance-based, ranges, `power=3s`, buffer-pad structural sections ~5 km).

## Zone reference

| Zone | % FTP | % FTHR | RPE | Feel |
|---|---|---|---|---|
| Z1 Recovery | <55 | <81 | 1–2 | easy spin |
| Z2 Endurance | 56–75 | 81–89 | 3–4 | all-day, can talk |
| Z3 Tempo | 76–87 | 90–93 | 5 | purposeful, sentences |
| Sweet Spot | 88–94 | 92–95 | 6 | comfortably hard |
| Z4 Threshold | 95–105 | 96–102 | 7–8 | 1-hr max, short phrases |
| Z5 VO₂max | 106–120 | >102 (lags) | 9 | can't talk, 3–8 min max |
| Z6 Anaerobic | 121–150 | n/a | 10 | 30–90 s burning |
| Z7 Neuromuscular | 150+ | n/a | max | seconds, all-out |

---

## Endurance family

**Recovery ride** — flush fatigue. 30–90 min @ 40–55%, HR <81%, cadence 85–95,
easy spin. Any terrain, avoid climbs. `- Recovery 30km 45-55% power=3s`

**Endurance (steady)** — aerobic base / fat oxidation. 60–240 min @ 60–72%,
HR 81–89%, cadence 85–95. Flat/rolling, minimal stops.
`- Endurance Z2 60km 62-72% power=3s`

**Progressive endurance** — same but ramp each third: 62–66 → 66–70 → 70–75%.
Good when TSB is neutral and you want a little more without going hard.

**Endurance + cadence drills** — base ride with 6–10× 1 min @ 100–110 rpm (same
Z2 power). Cadence efficiency inside an easy ride. Flat.

**Fatigue resistance** — durability. 90–150 min Z2, **then** threshold work on
tired legs: `2x` `- Thr tired 6km 95-100% power=3s` / `- Float 2km 70% power=3s`.
Do the intervals in the last third. Build/Peak only.

---

## Tempo / Sweet Spot

**Tempo** — sustainable pace, aerobic strength. 2×20 or 3×15 @ 76–85%, HR
90–93%, cadence 85–95. Flat or steady false-flat.
`2x` `- Tempo 20 8km 78-85% power=3s` / `- Easy 3km 60% power=3s`

**Sweet Spot** — best fitness-per-hour; go-to when time <75 min. 3×12–20 @
88–94%, HR 92–95%, cadence 85–95. Flat or long steady climb.
`3x` `- SS 12 6km 88-93% power=3s` / `- Rec 2km 65% power=3s`

---

## Threshold (raise FTP)

**Classic**: 2×20 / 3×15 / 4×10 / 4×8 @ 95–105%, HR 96–102%, cadence 85–95.
Flat or long climb, uninterrupted. Repeatable weekly in Build.
`3x` `- Thr 15 5km 96-102% power=3s` / `- Rec 2km 65% power=3s`

**Over-unders** — lactate clearance. Alternate under/over inside each rep, e.g.
per 5 km rep: 2 km 90% / 1 km 105% / 1 km 90% / 1 km 105%. HR rides high
throughout. Rolling terrain suits it. Build.

---

## VO₂max & above

**VO₂max** — raise aerobic ceiling. 5×5 / 6×3 @ 108–118%, RPE 9 (ignore HR),
cadence 95–105, equal or slightly shorter recovery. Long climb or flat into
headwind. Max ~2×/week.
`5x` `- VO2 3min 1.5km 108-118% power=3s` / `- Rec 3min 1.5km 55% power=3s`

**Short VO₂ (30/30, 40/20)** — more time at VO₂ with less suffering. 2–3 sets of
8–10× 30 s @ 115–125% / 30 s @ 50%. Rolling or flat. Great when only short
climbs exist.

**Anaerobic capacity** — 30–90 s @ 130–150%, full recovery (3–5 min), cadence
100+. Short punchy climbs or flat. Peak phase / race prep.

**Neuromuscular / sprint** — max sprint power. 6–10× 10–15 s all-out (standing
starts, flying, seated jumps), 3–5 min easy between. Flat, safe, low-traffic.
Freshness required.

---

## Specific / race

**Climbing repeats** — sustained climbing strength. 3–5× 6–12 min @ 90–100% on
gradient, cadence 70–85 (torque). Needs long climbs; sub for low-cadence Sweet
Spot on false-flats if none.

**Time trial** — pacing + aero. 1–2× 10–20 km @ 100–105% neg-split, aero
position, cadence 88–95. Flat, straight, uninterrupted (use Layer 2/3/known-roads
to find it).
`- TT 15k aero 15km 100-105% power=3s`

**Race simulation** — specificity. Mixed: Z2 base + surges (30–60 s @ 120%+),
a threshold block, a sprint. Rolling / varied. Peak only, sparingly.

**Group-ride prep** — repeated accelerations. 10–15× 20–40 s @ 120–140% off low
speed, short recovery, on rolling terrain / after corners.

---

## Concrete workout bank (`data/cache/workout_bank.json`)

Beyond the templates above, a bank of real interval structures parsed from open
Zwift `.zwo` files ships in `data/cache/workout_bank.json` — grouped into the
seven buckets (sprint, anaerobic, vo2max, threshold, sweetspot, tempo,
endurance). Each entry is `{name, category, duration_min, structure, source}`,
e.g. `{"category":"vo2max","structure":"5x 3min @ 115% FTP",...}`.

Use it to add **variety of shape**: once the coaching engine has chosen the
objective and phase, pull 2–3 structures from that category as candidates,
pick the one whose interval length fits the terrain, then convert it to
distance-based intervals.icu syntax (`workout-syntax.md`) mapped onto the route.
The bank supplies the *structure*; power/HR/cadence/terrain rules come from the
tables above. Categories and the `structure` line are auto-derived and disagree
for ~49% of entries, so **only use entries that pass
`scripts/workout_windows.py` validation** (`suggest_workout.py` and the map
widget's picker already filter through it); if picking manually, sanity-check
against the zone table. Refresh/extend the bank per `references/maintenance.md`.

## Structural template (every workout)

```
- Warm-up ramp   (pad +5 km)   50→70%
- [main set from above]
- (long recoveries between blocks: pad +5 km)
- Cool-down      (pad +5 km)   60→50%
```
Warm-up length scales with intensity: 15–20 min easy for VO₂/anaerobic (add more
when cold), 10 min for endurance. Openers/short sharp efforts in taper.
