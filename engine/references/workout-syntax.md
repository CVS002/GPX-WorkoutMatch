# intervals.icu structured workout syntax (distance-based)

The workout goes into the `description` field of a `WORKOUT` calendar event
(created via `icu_create_event`). intervals.icu parses it into a structured
workout with per-step targets, estimated training load, and zone coloring.

If the MCP server exposes the resource `intervals-icu://workout-syntax`, read
it — it is authoritative and more complete than this file. This file covers
the distance-based subset this skill uses.

## Step format

One step per line, starting with `- `:

```
- <name> <distance> <intensity-range> power=3s
```

- **name**: free text label shown on the head unit (keep short, it scrolls)
- **distance**: e.g. `10km`, `21km`, `800m`. Time-based also works (`20m`, `90s`)
  but this skill defaults to distance so steps map onto GPX terrain.
- **intensity**: percentage of FTP as a range, e.g. `88-92%`. A single value
  (`95%`) also works but ranges ride better outdoors.
- **`power=3s`**: target 3-second smoothed power rather than lap average.
  Recommended for outdoor distance-based steps; matches the athlete's
  existing workouts.

## Repeats

```
3x
- Effort 2km 98-102% power=3s
- Float 1km 75-80% power=3s
```

An integer + `x` on its own line repeats the indented/following steps.

## Real example (from the athlete's own calendar — "Trainingskoers Threshold+TT v3")

```
- Approach Z2 21k 21km 67-72% power=3s
- Lap 1 88-92% 10km 88-92% power=3s
- Lap 2 95-96% 10km 95-97% power=3s
- Lap 3 98-102% 10km 98-102% power=3s
- Chill eat+drink 15k 15km 60-67% power=3s
- 10k TT aero neg split 10km 100-103% power=3s
- Cooldown Z2 17k 17km 65-70% power=3s
```

Note the naming convention: the label repeats the key number ("Lap 1 88-92%")
so it is readable at a glance on the Garmin. Follow this convention.

## Event fields

When calling `icu_create_event`, set:

- `category`: `"WORKOUT"`
- `event_type`: `"Ride"`
- `name`: short workout title, versioned if it's a repeat of a known session
  (e.g. "Trainingskoers Threshold+TT v4")
- `start_date`: the user-confirmed date, `YYYY-MM-DD`
- `description`: the workout syntax above
- `distance_meters`: total planned distance (sum of steps)
- Optionally `duration_seconds` and `training_load` if you have estimated them;
  intervals.icu will also derive load from the parsed steps.

## Buffer padding (lap-button sync)

Structural non-training sections — the approach/warm-up, long recoveries
between blocks, and the cooldown — are written ~5 km LONGER than the route
segment they cover. The athlete presses the lap button to end them on
arriving at the start of the next work section. Example: if the route puts
the first effort at km 21, write the approach as `26km`, not `21km`. Short
floats inside an interval block keep their true distance.

## Sanity checks before pushing

- Step distances should sum to approximately the GPX route distance plus
  ~5 km per padded buffer section. A sum that exactly matches the route
  distance means the padding was forgotten.
- Every step has an intensity range and `power=3s`.
- Intensities are % of FTP — confirm the athlete's current FTP via
  `icu_get_sport_settings` or `icu_get_athlete_profile` rather than assuming.
