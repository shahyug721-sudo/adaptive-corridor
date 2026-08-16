# Emergency Corridor — Samruddhi Mahamarg

A microscopic traffic simulation of a **dedicated emergency corridor lane** on the
Mumbai–Nagpur Samruddhi Mahamarg, with an **adaptive ITS green zone** that clears
the lane ahead of a responding ambulance.

Runs in the browser. No build step, no install.

```bash
npm run serve     # then open http://localhost:8123
npm test          # simulation self-test
npm run experiment # four-arm comparison table
```

---

## The problem

The Samruddhi Mahamarg is 701 km of access-controlled expressway with a single
speed limit for the whole carriageway (120 km/h light, 80 km/h heavy) and
ambulance posts roughly every 50 km. A unit is routinely twenty minutes from a
casualty before traffic is even considered — and then it has to overtake through
general traffic on its siren alone.

## The proposal

Re-stripe each carriageway as three running lanes with **lane-wise speed
segregation** — 100 / 90 / 80 km/h, heavy vehicles confined to the slowest —
plus a fourth lane against the median kept permanently clear as an emergency
corridor, driven by gantry lane-control signals.

```
        median barrier
  ═══════════════════════════
   lane 0   EMERGENCY    ← reserved, red-X on every gantry
   lane 1   100 km/h
   lane 2   90 km/h
   lane 3   80 km/h      ← heavy vehicles
  ───────────────────────────
        paved shoulder
```

India drives on the left, so the median-adjacent lane is the overtaking lane and
the natural place for a corridor: an ambulance in it never crosses a slower lane,
and vehicles clearing it merge **left**, away from the unit.

## The control problem

A reserved lane on paper is not a reserved lane in practice — drivers use an
empty lane. The system therefore opens a **moving green zone** ahead of the unit
in which gantries order the corridor cleared and drop lane 1 to 80 km/h.

The only real question is *how far ahead*. Too short, and a driver sitting
illegally in the corridor gets four seconds of warning at 33 m/s, cannot find a
gap, and the ambulance brakes behind them. Too long, and you have restricted
several kilometres of expressway for one vehicle.

The zone length comes from gap-acceptance theory:

```
T_clear = t_react + W(q, τ) + t_manoeuvre
W(q, τ) = (e^(q·τ) − 1) / q − τ
L = v_unit · T_clear + buffer
```

`W` is the expected wait for a gap of at least the critical headway `τ` in a
Poisson stream of flow `q`. It is almost free at low flow and blows up
superlinearly as lane 1 fills — which is precisely why no single fixed number is
right. `τ` is set by **what** the detector sees in the corridor, not just how
much: a car merging out at 105 km/h takes a 3 s gap, a truck at 80 joining
100 km/h traffic needs closer to 5.5 s.

---

## Results

Eight seeded replications per arm at 0.9 × design flow, 16 % lane indiscipline,
82 % gantry compliance. Free-flow benchmark is 299.6 s.

| Arm | EV travel time (s) | Delay vs free-flow (s) | Impedances | Mean speed (km/h) | Zone length (m) | Lane-1 vehicles slowed |
|---|---|---|---|---|---|---|
| Today — no reserved lane, siren only | 372.7 ± 12.5 | 73.1 ± 12.5 | 1.9 | 90.4 | — | 0 |
| Reserved lane painted, no ITS warning | 318.1 ± 6.9 | 18.5 ± 6.9 | 1.1 | 105.9 | — | 0 |
| Reserved lane + fixed 500 m green zone | 314.3 ± 0.1 | 14.7 ± 0.1 | 1.0 | 107.1 | 500 | 17 |
| **Reserved lane + adaptive green zone** | **314.7 ± 0.4** | **15.1 ± 0.4** | **1.0** | **107.0** | **289** | **16** |

**15.6 % faster response** overall (Welch's t = 13.10, df = 7, significant).

Read the table honestly, because it does not say what a first guess would:

- **The reserved lane does almost all the work** — 14.7 of the 15.6 points. Most
  of the benefit is geometric, not algorithmic.
- **At these demands the green zone adds little to travel time.** The corridor is
  10 km long and closing speeds are low, so encroachers usually clear before the
  unit reaches them whether they were warned at 500 m or 289 m.
- **The adaptive zone's real gain is efficiency.** It achieves the same response
  time as the fixed zone while restricting **42 % less carriageway** (289 m vs
  500 m). That is the result worth defending: not a faster ambulance, but the
  same ambulance for materially less disruption.
- The variance column matters too — the status-quo arm has ± 12.5 s, the
  controlled arms ± 0.1–0.4 s. **Predictability** is its own clinical argument.

Reproduce with `npm run experiment`.

---

## What is modelled

Real failure modes, not an idealised road:

- **Lane indiscipline as a hazard rate** — drivers drift into a conspicuously
  empty lane over time, sooner if something slow is ahead. An "only when blocked"
  rule produced almost no encroachment, which is not what the lane looks like in
  practice.
- **Heavy-vehicle encroachment** — the case that actually hurts. A car in the
  corridor costs the ambulance seconds; a truck sitting there at 80 km/h costs it
  forty.
- **Detector degradation** — gantry cameras lose accuracy in rain, at night, and
  in the Igatpuri ghat fog section. Detection quality and driver compliance
  collapse in the same place, not independently.
- **Gap acceptance** — an ordered vehicle cannot leave the corridor until a gap
  exists in lane 1. Merging is emergent, not scripted.
- **Compliance** — a configurable fraction ignore the gantry entirely and react
  only to the unit in their mirror, at roughly 150 m.

## Architecture

```
web/js/sim/config.js     corridor geometry, fleet, lane limits, experiment arms
web/js/sim/core.js       seeded RNG, IDM car-following, lane arrays, metrics
web/js/sim/greenzone.js  gantry signals, camera enforcement, adaptive zone sizing
web/js/sim/world.js      the simulation: spawning, lane discipline, the unit
web/js/sim/runner.js     headless replication, aggregation, Welch's t-test
web/js/render/           three.js scene, road, gantries, instanced fleet
web/js/app.js            fixed-timestep loop, camera modes, HUD
scripts/selftest.js      physics-integrity and result-ordering checks
```

The simulation is seeded and deterministic. The renderer only reads from it, so
running at 8× is the same run as at 1×, and the browser and the headless runner
produce identical numbers.

---

## Related work

Three public implementations were reviewed. Each solves one part of the problem;
none closes the loop, which is the gap this project targets.

**[mihir-m-gandhi/Adaptive-Traffic-Signal-Timer](https://github.com/mihir-m-gandhi/Adaptive-Traffic-Signal-Timer)**
— YOLO vehicle detection plus a Pygame intersection simulation. The two halves
are not connected: the detection script writes annotated images to disk, and the
simulation's `setTime()` counts vehicles from its own internal state (the import
is commented out). Its per-class discharge model —
`(cars·2 + rickshaws·2.25 + buses·2.5 + trucks·2.5 + bikes·1) / (lanes+1)` — is a
useful Indian-context calibration and is effectively PCU weighting in disguise.
Built on darkflow (YOLOv2 / TensorFlow 1.x), which is unmaintained.

**[moralesangel/emergency-vehicle-detection](https://github.com/moralesangel/emergency-vehicle-detection)**
— the most rigorous of the three: a BS thesis with a published paper, doing
audio-based emergency-vehicle detection on AudioSet with MFCC / LFCC / Chroma
features, feed-forward / CNN / LSTM classifiers and convolutional autoencoders
for feature compression. Ships trained models and a serving API. Detection only;
no signal or lane control.

**[Onabanjomicheal/Emergency-Vehicle-Preemption](https://github.com/Onabanjomicheal/Emergency-Vehicle-Preemption)**
— SUMO + TraCI single-junction preemption. Conceptually closest to this project,
and a useful baseline. Two limitations shaped decisions here: it reads vehicle
positions from `traci.vehicle.getNextTLS()`, i.e. simulation ground truth rather
than a detector, so no perception problem is solved; and it forces phase changes
with `setPhaseDuration(tlsID, 0.1)`, skipping yellow and all-red clearance — a
shortcut this project deliberately refuses, since a preemption that drops a green
straight to red is not certifiable.

The gap: repo 1 detects and never acts, repo 3 acts on information it could not
have in the field, repo 2 detects well and controls nothing.

## Status

Working simulation and 3D visualisation of the expressway scenario. Planned:
a signalised urban-arterial scenario, a Python perception package (YOLOv8
lane-wise PCU counting and acoustic siren detection), and an in-browser
experiment dashboard.

## Licence

MIT
