# Coaching engine — how to choose the workout

This is the decision logic that stops the app from proposing the same session
every time. Work through it in order **before** writing any steps. Pick the
`workout-library.md` type that the objective, phase, load, and terrain point to
— not a favourite template. If two prior proposals would come out identical,
you skipped this file.

## Inputs to gather first

1. **Recent load — last 14 days, non-GPX** (`icu_get_recent_activities`,
   `days_back=14`): per day the type, duration, TSS/load, IF. Note the last
   *hard* day (Threshold/VO₂/Anaerobic) and what stimulus it was.
2. **Form** (`icu_get_fitness_summary`): CTL, ATL, **TSB**. Ramp rate.
3. **FTP/FTHR** (`icu_get_sport_settings`) — never guess.
4. **The route** — terrain class from `analyze_gpx.py` + Layers 2/3/known-roads.
5. **Athlete-stated intent, time available, weather/wind** — if given.

## Step 1 — One objective for the day

Every ride answers **"what adaptation are we creating today?"** Choose exactly
one primary objective (endurance / FTP / VO₂max / repeatability / fatigue
resistance / sprint / race pacing / climbing / cadence / recovery). Do not stack
two quality objectives unless deliberately building a race-simulation.

Drivers, in priority order:
- **Stated intent wins.** "Threshold day" → threshold. Fill in the rest.
- **Form (TSB):** TSB < −20 → recovery/endurance only. −20…−10 → endurance,
  tempo, or moderate SS. −10…+5 → any quality session. > +5 (fresh) → the key
  hard session (VO₂/threshold/race) or openers if tapering. **Freshness is
  permission, not an obligation: fatigue gates always win, and the phase still
  rules** — fresh in Base means tempo/SS, fresh in a Recovery week still means
  endurance (being fresh is the point of that week).
- **Phase** (see below) biases which quality objective is appropriate.
- **Novelty:** avoid repeating the last hard stimulus. If the last quality day
  was 4×8 threshold, don't propose threshold again — rotate to VO₂, SS, or
  fatigue-resistance. Vary interval *shape* week to week.

## Step 2 — Phase bias

Infer phase from the calendar / goal event, else ask.

| Phase | Favour | Avoid |
|---|---|---|
| **Base** | endurance, tempo, low-cadence climbs, long steady, cadence drills | VO₂, anaerobic, sprints |
| **Build** | threshold, sweet spot, over-unders, VO₂ (5×5), progressive overload | pure sprint days |
| **Peak** | race simulation, anaerobic repeats, attacks, sprint, specificity | high volume, junk tempo |
| **Taper** | openers, short sharp efforts, recovery — maintain, shed fatigue | long or high-TSS days |
| **Recovery week** | easy endurance, recovery rides | almost all intensity |

Increase **specificity** as a target event approaches (train the demands of the
event: TT → long threshold/TT; Gran Fondo → fatigue resistance + climbing;
racing → race sim + anaerobic).

## Step 3 — Match to terrain (from Layer 1 + 2 + 3)

| Terrain | Natural fits | If objective needs something else |
|---|---|---|
| **Flat** | threshold, TT, tempo, endurance, SS | ideal for steady work |
| **Rolling** | over-unders, SS, race sim, group-ride surges | poor for long steady threshold — use over-unders |
| **Long climbs** | threshold, VO₂, climbing repeats | best for sustained quality |
| **Short punchy climbs** | anaerobic, 30/30, punchy VO₂, sprints | no room for 20-min efforts → break into 3-min VO₂ |
| **Urban / many junctions** | endurance, recovery | do NOT place efforts — see interval placement |
| **Wind-exposed** | headwind legs = free resistance for threshold/VO₂ | tailwind legs = recovery/float |

**When terrain and objective conflict, reshape the workout to the terrain**
rather than forcing it (that reshaping is the app's edge). Examples:
- Objective VO₂ but only 2-min climbs → `6×3-min VO₂` on the climbs, not 5×5.
- Objective threshold but rolling → `over-unders` so the surges ride the risers.
- Objective TT but route is twisty → move the effort to the one straight block
  Layers 2/3 identify, or **suggest a GPX modification** (below).

## Step 4 — Interval placement

Efforts start **after** an adequate warm-up and on **effort-ready** road:
straight, stable gradient, low traffic, no known stop/junction (cross Layers
4→2→3→1). Never start an effort on a descent, a busy intersection, or a Layer-2
stop hotspot / Layer-3 signal. Put recoveries over the messy bits.

## Step 5 — Suggested GPX modifications

If the route doesn't fit the day's objective, propose an edit (and say why):
- **Extend** to reach a nearby sustained climb (climbing/threshold days).
- **Add a lap** of the cleanest block to fit the required interval volume.
- **Reroute** around a junction cluster that would break an effort.
- **Trim** to fit the available time while preserving the effort segment.
State it as a concrete suggestion; the athlete decides.

## Step 6 — Weather & fuelling

- **Wind:** headwind sections → threshold/tempo/VO₂; tailwind → recovery/float.
- **Rain:** cut descending intensity; keep efforts on safe straights.
- **Heat:** drop power targets ~5%, add hydration note.
- **Cold:** longer warm-up.
- **Fuel the quality:** for sessions >2 h or with hard blocks, suggest carbs
  (≈60–90 g/h) and pre-ride fuelling. Recovery/short Z2 need little.

## Coaching heuristics (guardrails — apply to every recommendation)

- Consistency over hero sessions. Progress overload gradually.
- **≤2–3 high-intensity days/week** for most athletes.
- No Threshold/VO₂/Anaerobic on **consecutive** days unless race-specific.
- Schedule recovery **before** performance drops, not after.
- Time-limited (<75 min) → Sweet Spot, Threshold, or VO₂ (best ROI).
- Adapt to accumulated fatigue (TSB) and time since last hard day.
- One clear physiological objective per ride.

## Output the design must contain

Training objective · detailed structure · power targets (%FTP) · HR guidance
(%FTHR/RPE) · cadence guidance · terrain recommendations · suggested GPX
modifications · a suitable calendar day (given yesterday/today/tomorrow + next
race — **choose it internally; only surface/ask the date after the map is
finalized**) · exportable intervals.icu workout. Present it on the map,
finalize, then **the date and the event creation come last**.
