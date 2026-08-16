# Emergency Corridor Lab 🚑

An interactive, real-time traffic simulation of **how an emergency service corridor (Rettungsgasse) forms** in congested traffic — and how much faster it forms when vehicles and traffic signals are connected via **V2X communication with signal preemption**.

Zero dependencies. Pure HTML + Canvas + vanilla JS. Deploys to Vercel as-is.

![mode](https://img.shields.io/badge/stack-vanilla%20JS%20%2B%20canvas-blue) ![deploy](https://img.shields.io/badge/deploy-vercel%20static-black)

## What it models

Two linked modules:

### 1. 3D Corridor Lab (`index.html`)

- **Microscopic traffic flow** — every vehicle runs the Intelligent Driver Model (IDM) for car-following, with a signalized intersection producing realistic queues.
- **Corridor formation rule** — the European Rettungsgasse: vehicles in the leftmost lane pull left, all other lanes pull right, opening a corridor between lanes 1 and 2. Lateral movement is animated per-vehicle.
- **Two alerting technologies (A/B lab)**
  - **Siren only** — drivers react when the unit is ~75 m behind them (audible/line-of-sight range). The corridor forms as a slow wave just ahead of the ambulance.
  - **V2X + preemption** — a V2V broadcast alerts equipped vehicles ~420 m ahead instantly (visualized as radio ripples and per-vehicle hop pulses), and the traffic signal controller preempts to green as the unit approaches.
- **Human non-compliance** — a compliance slider injects drivers who don't yield until the siren is directly behind them (they glow red while blocking the corridor). This is the dominant real-world failure mode.
- **Live telemetry** — response time, time-to-corridor, clear-corridor distance ahead, corridor integrity %, EV speed, preemption timestamp, delay vs. free-flow benchmark.
- **Run history** — every completed run is logged with its mode/density/compliance so you can compare siren-only vs V2X empirically. The verdict line quantifies seconds saved.

### 2. City Mode — acoustic signal preemption on real roads (`city.html`)

A real OpenStreetMap corridor (6th Avenue, Manhattan, W 23rd → W 42nd, north-up) with 18 signalized cross streets and an original preemption concept:

- **The siren IS the transmitter.** Each unit's siren carries a unique machine-readable ID tone (2.5–3.5 kHz). Intersection acoustic sensors matched-filter the soundscape for such tones — no radio, no GPS, no extra vehicle hardware.
- **Physical detection model** — SPL falls 20·log₁₀(r) from 120 dB @ 1 m; detection requires clearing the tunable urban noise floor. The detection-radius and noise sliders set the physics.
- **Signal preemption logic** — on detection + approach bearing, corridor phase → green, cross phase → red; after the unit passes, the cross street is repaid with the next green.
- **Live sensor scope** — a spectrum view of the next intersection's sensor: wail band, ID-tone spike, noise floor, lock indicator.
- **Audible siren** — WebAudio synthesizes the wail + the unit's actual ID tone (toggle).
- **A/B runs** — no-preemption vs acoustic, seconds saved quantified.

## Run it

No build step.

```bash
npx serve .        # or python3 -m http.server
```

Open `index.html` via any static server (opening the file directly also works in most browsers).

## Deploy to Vercel

```bash
npm i -g vercel
vercel             # from the repo root — auto-detected as a static site
```

Or push to GitHub and import the repo at vercel.com — no framework preset, no build command, output directory `.`.

## Experiments to try

1. Same density (60%), run **SIREN ONLY**, reset, run **V2X** — compare response times in Run history.
2. Crank density to 100% — the queue at the red light makes corridor formation the bottleneck; preemption drains the queue before the unit arrives.
3. Drop compliance to 40% — watch red (non-compliant) vehicles hold the corridor closed and the integrity metric fall.

## Research grounding

- Rettungsgasse rule (Austria/Germany): corridor opens between the far-left lane and the next lane; forming it is legally required whenever traffic jams.
- V2X emergency corridor: Kumar et al., *V2X Enabled Emergency Vehicle Alert System* (arXiv:2403.19402); *V2X Based Emergency Corridor for Safe and Fast Passage of Emergency Vehicle* (IEEE, 2021) — V2I preempts the signal while V2V moves vehicles aside; simulated in VEINS (SUMO + OMNeT++).
- Emergency Vehicle Preemption: FHWA-HOP-24-019 — EVP turns the signal green for the approaching unit while holding conflicting movements on red; corridor-level "green waves" via GPS/GNSS tracking.
- Measured impact: VANET studies report **12–19% ambulance transit-time reduction** with V2X assistance (Kaja et al., *SIMULATION*, 2024).

## Architecture

```
index.html       APP ENTRY — driver-view acoustic-preemption scenario (installable PWA)
lab.html         3D Corridor Lab — top-down model, A/B telemetry
city.html        City Mode — nav-style UI on real OSM roads (Leaflet)
manifest.json    PWA manifest (open-as-app) + icon.png
js/sim.js        Model: IDM physics, alert propagation, corridor logic, signal FSM, metrics
js/city.js       City model: route geometry, acoustic detection physics, signal FSM, WebAudio siren
js/drive.js      Driver-view three.js scene: city canyon, streetlights, chase/hood cameras
js/render3d.js   three.js 3D renderer (north-up: road runs vertically away from camera) —
                 modeled cars/trucks/ambulance, orbit + chase cameras, ripples, corridor glow
js/main.js       Fixed-timestep loop (90 Hz substeps), UI bindings, run history
vercel.json      Static deployment config
```

three.js is loaded from CDN via an import map — still zero build step.
```

## Ideas for extension

- Multi-intersection arterial with coordinated green wave
- Ghost-run overlay: replay the siren-only trajectory during a V2X run
- SUMO trace import for real network geometry
- WebRTC multi-player mode: humans drive the non-compliant cars

## License

MIT
