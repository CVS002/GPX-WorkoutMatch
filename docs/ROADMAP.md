# Roadmap — proposed features

The end goal is **matching workouts and effort to the correct segments on a route**.
Today the designer fuses L1–L6 into a per-km score and places intervals on the
highest-scoring *clean, straight, junction-free* blocks (see
[ARCHITECTURE.md](ARCHITECTURE.md)). That answers "where is the road *safe and
uninterrupted*?" — but it does not yet use the two signals a coach most wants for
placement (**wind** and **gradient**), and it can't yet *tell you why* a segment was
chosen or *fix* a route that doesn't fit. These three features close those gaps.

Each is deterministic (no LLM), fits the existing layer/score model, and is scoped so
it can ship independently.

---

## 1. Wind-aware effort placement

**Problem.** [coaching-engine.md](../engine/references/coaching-engine.md) is explicit
that *"headwind sections → threshold/tempo/VO₂; tailwind → recovery/float"* — a
headwind leg is free resistance that makes an effort's power steadier and its road
speed slower (safer). Yet nothing in the app ingests wind: placement treats a
into-the-wind straight and a tailwind straight identically. This is the single
biggest unused lever for matching effort to segment.

**Proposal.** Add a **wind layer (L7)** computed at schedule time:
- Pull an hourly wind forecast (speed + bearing) for the route's location and the
  chosen date/time from a keyless API (e.g. Open-Meteo — no key, fits the no-secrets
  model). Cache per (route, day) like the other layers.
- Compute each segment's mean **heading** from the polyline (already available in
  `mapdata._route_line` / L2's direction bins) and derive the **headwind component**
  `w·cos(Δheading)` per km.
- Feed a small, capped headwind bonus into `composite_scores` so effort placement
  prefers headwind legs, and bias recoveries/floats onto tailwind legs.
- Surface it: a wind-arrow toggle on the native map and a per-effort "🌬 headwind"
  evidence note next to the existing continuity/corridor notes.

**Touch points.** New `engine`-side scorer + cache; `server/engine.py::composite_scores`
gains a `wind` input; `server/designer.py` weights it in `_plan_placement`;
`server/mapdata.py` emits per-km headwind; `web/map.js` draws the arrows.
Because wind depends on the date, this is the one signal computed at **Step 4
(Schedule)** and fed back into a re-design — so the flow gains an optional
"re-optimise for the day's wind" step.

**Payoff.** The highest-value, currently-manual coaching rule becomes automatic and
route-specific.

---

## 2. Gradient-locked interval placement with gradient-adjusted targets

**Problem.** For climbing / VO₂ / threshold objectives, the *right* segment is a
**climb**, not merely a clean flat straight — and the power target should follow the
gradient (torque/low-cadence on a real ramp). L1 already detects climbs and per-km
gradient, but `_plan_placement` only ranks by the fused clean-road score; it has no
notion of "snap this rep onto that 2-minute climb" and every %FTP target is
gradient-blind. The coaching engine calls for exactly this reshaping
(*"objective VO₂ but only 2-min climbs → 6×3-min VO₂ on the climbs"*), done manually
today.

**Proposal.** A **climb-matching placement mode**, auto-enabled for gradient-hungry
objectives (climbing, VO₂max, threshold when climbs exist):
- Extract sustained-gradient segments from L1 (start/end km, length, avg %, VAM
  potential) as first-class placement candidates alongside the flat clean blocks.
- When the objective wants sustained power, **anchor reps to climbs**: match the
  bank session whose rep length fits the climb length (reshape 5×5 → 6×3 when only
  short ramps exist — the logic the engine already recommends in prose).
- **Gradient-adjust the target**: nudge the %FTP band and cadence guidance per the
  climb's gradient (e.g. torque/70–85 rpm on >4%), so the written target matches how
  the segment will actually ride.
- Add a climb-shading layer to the timeline/map so the anchored reps visibly sit on
  the ramps.

**Touch points.** `server/designer.py` (`_plan_placement`/`_choose_session` gain a
climb-candidate path; new `_gradient_targets` helper); `server/engine.py` exposes L1
climb + gradient arrays it already computes; `web/map.js` + timeline shading.

**Payoff.** Climbing and VO₂ sessions land on real gradient with sane targets instead
of a flat proxy — the biggest correctness gap for hilly routes.

---

## 3. Per-segment "effort-readiness" heatmap + auto GPX-modification suggestions

**Problem.** Two related gaps. (a) **Explainability**: the map colours the road by a
fused score, but a user can't see *why* a stretch scored the way it did (which layer
vetoed it) or compare candidate segments at a glance. (b) **Fit failures**: when a
route simply can't hold the objective's required interval volume on clean road, the
designer today emits an `overflow` *warning* and spills reps onto unvetted road —
[coaching-engine.md](../engine/references/coaching-engine.md) Step 5 calls for
*proposing a concrete GPX modification* (extend to a nearby climb, add a lap of the
cleanest block, reroute around a junction cluster, trim to time) but the app never
generates one.

**Proposal.**
- **Effort-readiness heatmap.** Expose the per-km score already in `mapdata._perkm`
  as a dedicated, toggle-able heatmap band with a hover breakdown ("clean L2 ✓ /
  signal at km 8.2 ✗ / effort corridor 4× ✓ / gradient +1%"). Pure surfacing of data
  the server already has — cheap, high clarity, and it makes features 1 & 2 legible.
- **Auto GPX-modification suggestions.** When `_plan_placement` can't fit the dose on
  clean blocks (the existing `overflow` path), compute a concrete, deterministic
  suggestion and offer it:
  - *Add a lap* of the single cleanest block that closes the volume gap (emit the
    extra distance as a real lap the athlete can ride).
  - *Reroute hint*: name the junction cluster breaking the best block.
  - *Trim*: identify the cool-down tail that could be cut to hit a time budget while
    preserving the effort segment.
  Present as an actionable card ("this route fits 4×8 but not 5×8; add a 3 km lap of
  km 12–15 to fit the 5th") — the athlete decides.

**Touch points.** `server/mapdata.py` already carries `perkm`; add the breakdown
fields. `server/designer.py` turns the `overflow` branch into a structured
`suggestions[]` on the design payload. `web/app.js` renders the card + heatmap toggle;
`web/map.js` draws the heatmap band.

**Payoff.** Closes the loop from *diagnosis* (why this segment) to *remedy* (how to
make the route fit) — turning the overflow warning from a dead end into a fix, which
is the last mile of "match the workout to the route."

---

### Sequencing note

They're independent, but **#3's heatmap is the cheapest** (surfaces existing data) and
makes #1 and #2 visible, so it's a natural first step. #1 (wind) has the highest
coaching payoff for this athlete's flat terrain; #2 (gradient) matters most as routes
get hillier. All three plug into the same `composite_scores` fusion point, so none
disturbs the guardrail/validation contract.
