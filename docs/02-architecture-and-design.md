# 2. Architecture, dataset plan, models, SUMO design and control formulation

---

## 2.1 Environment status (checked 2026-08-20)

| Component | State | Action |
|---|---|---|
| SUMO / sumo-gui / netedit | **not installed**, `SUMO_HOME` unset | must install — blocks phases 1–5 |
| PyTorch | 2.4.1 ✅ | — |
| numpy 1.24.3, pandas 2.2.2, scikit-learn 1.3.0, scipy 1.15.3, matplotlib 3.7.2, seaborn 0.13.2, streamlit 1.38.0 | ✅ | — |
| librosa, soundfile | **missing** | `pip install librosa soundfile` |
| traci, sumolib | **missing** | ship with SUMO; also `pip install traci sumolib` |
| xgboost | **missing** | `pip install xgboost` |
| tensorflow | absent | not needed — we standardise on PyTorch |

Nothing in phases 1–5 can start until SUMO is installed. That is the first task.

---

## 2.2 System architecture

```
        AUDIO (held-out clip: siren, or horn/music for false-alarm scenarios)
                              |
                     preprocess: resample 22.05 kHz, mono, 3 s window
                              |
              +---------------+---------------+
              |                               |
        MFCC + spectral/temporal        log-Mel spectrogram
        (RMS, ZCR, centroid,            (128 mels x ~130 frames)
         bandwidth, roll-off, flux)
              |                               |
        SVM / RandomForest                CNN  /  CNN+BiLSTM
        (Baseline 1)                      (Baseline 2 / Advanced)
              +---------------+---------------+
                              |
                    p(siren), latency_ms
                              |
                 threshold tau -> DETECT / NO DETECT
                              |
     +------------------------+------------------------+
     | decision, probability and latency are injected   |
     | into the simulation as-is, errors included       |
     +------------------------+------------------------+
                              |
                    SUMO / TraCI simulation
                              |
      +-----------------------+------------------------+
      |                                                |
  EV state from TraCI                        Junction state from TraCI
  (edge, lane, position,                     (phase, elapsed, queue per
   speed, distance, ETA)                      approach, density, flow)
      |                                                |
      +-----------------------+------------------------+
                              |
                  observable feature vector x(t)
                              |
        +---------------------+---------------------+
        |                     |                     |
   Model A               Model B                Model C
   fixed-time         rule-based EVP        learned controller
   (no preemption)    (queue-discharge,     (regression on trigger
                       P5 formula)           lead time; optional RL)
        +---------------------+---------------------+
                              |
                    preemption action
                              |
              TraCI setPhase / setPhaseDuration
             (clearance intervals always honoured)
                              |
                    emergency corridor active
                              |
                    EV traverses junction(s)
                              |
                    recovery controller
                              |
                    normal cycle resumes
```

---

## 2.3 Dataset plan

### Primary — P3 / D1 (figshare `10.6084/m9.figshare.19291472`)

- 1800 WAV clips: **900 siren**, **900 road noise**.
- Siren subtypes per the paper: wail, yelp, two-tone.
- Published CSVs of pre-extracted features exist; **we do not use them**. We
  extract from the WAVs ourselves so the pipeline is under our control and the
  same code runs at inference time.

### False-positive corpus — D2 UrbanSound8K (+ D3 ESC-50 optional)

Confusable negatives for §16: `car_horn`, `jackhammer`, `drilling`,
`engine_idling`, `street_music`, `air_conditioner`. UrbanSound8K's own `siren`
class is **excluded from negatives** (it contains emergency sirens) and is
instead reserved as a *cross-corpus positive* test.

### Splits — leakage control (§22, §23)

| Split | Source | Purpose |
|---|---|---|
| Train 70 % | D1 | fit |
| Val 15 % | D1 | threshold + early stopping |
| Test-in 15 % | D1 | in-corpus metrics |
| **Test-cross** | D2/D3 negatives + D2 `siren` positives | generalisation + false-positive rate |

Rules:
- Split by **source file before augmentation**. Augmented copies of a clip must
  never straddle the split — this is the single easiest way to leak.
- UrbanSound8K has 10 predefined folds; respect them, do not reshuffle.
- Fixed seed, split manifest written to disk and committed.

### Augmentation (train only)

Small corpus (900/class) with a CNN needs it: time shift, time stretch
(0.9–1.1), pitch shift (±2 semitones), noise mixing at **controlled SNR
(20/10/5/0 dB)** using D2 road noise, and SpecAugment time/frequency masking.

Controlled-SNR mixing is not only augmentation — it produces the **noisy road
environment** axis for scenario 59, with a known SNR rather than a vague label.

---

## 2.4 Model choices

### Audio (§17)

| ID | Features | Model | Role |
|---|---|---|---|
| A1 | MFCC (40) + Δ + ΔΔ, mean/std pooled | SVM (RBF) | Baseline 1 |
| A2 | Same + P2 spectral/temporal battery | Random Forest | Baseline 1b, feature-importance |
| A3 | log-Mel 128×~130 | 4-block 2-D CNN | Baseline 2 |
| A4 | log-Mel | CNN + BiLSTM | Advanced — sirens are *sweeps*; recurrence over time frames is the justified addition |
| A5 | A1+A3+A4 soft-vote | Ensemble | Ablation only (P1's idea) |

Reported per model: accuracy, precision, recall, F1, ROC-AUC, confusion matrix,
**inference latency (ms, CPU)**, on both Test-in and Test-cross.

**On §3 — why not fixed-frequency.** A wail siren sweeps roughly 500–1800 Hz at
about 0.2–1.5 Hz; a yelp does the same faster; a two-tone alternates discrete
pitches. A car horn is a *steady* harmonic stack in the same band. A
single-frequency detector cannot separate them — it fires on the horn. What
separates them is the **trajectory of energy through the time–frequency plane**,
which is exactly what a Mel spectrogram represents and a CNN/BiLSTM learns. This
is the argument for A3/A4 over any threshold rule, and it should be stated in
the report in these terms.

### Traffic controller (§9)

Three models, per §27:

- **Model A — fixed-time.** Standard SUMO `tls` program, no preemption. Floor.
- **Model B — rule-based queue-discharge EVP.** P5's concept:
  `t_start = ETA − (transition + startup_lost + queue_discharge + safety)`.
  This is a *strong* baseline, not a straw man, and beating it is the real test.
- **Model C — learned controller.** Primary formulation **regression on the
  optimal trigger lead time τ\*** (following P6, which is verified to do exactly
  this). Models: RandomForest → XGBoost → MLP, with LSTM only if a temporal
  state window demonstrably helps.

RL (§9 option C) is deferred to an optional phase. §9 says *choose the simplest
approach that produces a credible prototype* and *prefer supervised first* —
regression labelled by oracle search satisfies that, and RL adds a large tuning
burden for uncertain gain at this scope.

---

## 2.5 SUMO network design

### Net 1 — isolated four-arm junction (`nets/junction4/`)

- Four arms, **3 lanes** each way, 250 m approaches.
- `traffic_light` node, four-phase program (one arm at a time) with 3 s yellow
  and 2 s all-red, matching the phasing already validated in this repo.
- Right-hand traffic is SUMO's default; India drives on the left. Set
  `--lefthand` at netconvert time and keep it consistent, or state plainly that
  the network is right-hand and the result is direction-agnostic. **Decide once
  and document** — silently mixing conventions invalidates turning movements.
- EV as `vClass="emergency"` with `guiShape="emergency"`.

### Net 2 — arterial corridor (`nets/corridor3/`)

```
EV start ──▶ J1 ──▶ J2 ──▶ J3 ──▶ Hospital
            600 m   550 m   700 m
```

Three signalised junctions, cross traffic at each. This is where §30's
distinction lives: preemption at one junction is *EVP*; preparing J2 and J3
before the unit arrives is a **corridor**.

### Emergency vehicle handling

SUMO's emergency documentation (https://sumo.dlr.de/docs/Simulation/Emergency.html)
covers `vClass="emergency"`, blue-light behaviour and rescue-lane formation
(`--device.bluelight`). Worth investigating for realism of *lane clearance*, but
note it is **not** signal preemption — that remains ours via TraCI.

> **Verification required** — exact option names and their SUMO version
> dependence must be confirmed against the installed build.

---

## 2.6 Control formulation

### Observable state (feature whitelist)

Everything below is obtainable at decision time from TraCI. **This list is the
leakage boundary** (§23) — nothing outside it may reach the model.

| Group | Features |
|---|---|
| EV | distance to stop line, speed, mean speed over last 5 s, ETA (= distance / max(speed, ε)), approach ID, priority class |
| Signal | current phase index, elapsed time in phase, time since cycle start, cycle length, min-green remaining |
| Queue per approach (×4) | halting vehicle count, queue length (m), mean speed, occupancy |
| Junction | total approaching vehicles, arrival flow per approach (veh/s, EWMA), number of lanes served |
| Derived | estimated discharge time = queue_PCU / (sat_flow × lanes), estimated transition time |
| Audio | p(siren), detection latency, priority class |

**Forbidden as features** (they encode the answer): the oracle τ\*, any future
queue state, the EV's realised arrival time, anything from a completed run.

### Target for Model C

For each scenario state, run SUMO repeatedly over a sweep of trigger lead times
τ ∈ {0, 2, 4, …, 60} s, compute the objective J(τ), and label
**τ\* = argmin J(τ)**.

The label uses future information — that is legitimate, because it is an
*oracle* label. The model never sees it; it sees only the whitelist above. This
distinction must be documented explicitly (§23).

### Objective function (§20)

```
J = w1·D_ev_norm + w2·D_normal_norm + w3·S_spill_norm + w4·T_preempt_norm
```

Each term is **normalised by its Model-A (fixed-time) value in the same
scenario**, making them dimensionless and comparable across densities. Without
normalisation, w-values silently become density-dependent.

Proposed starting weights **w = (0.50, 0.30, 0.10, 0.10)**.

These are a **policy choice, not an empirical finding**, and must be presented
as such. The justification is ordinal, not numeric: emergency delay dominates
because it carries life-safety consequence; normal delay is next because an
unusable cross street is how preemption gets switched off in practice; spillback
and preemption duration are guards against degenerate solutions (hold green
forever). §20 requires a **sensitivity analysis** — sweep w1 ∈ {0.3 … 0.7} with
the remainder rescaled, and report how τ\* and the ranking of Models A/B/C move.
If the ranking flips inside a plausible weight range, say so.

### Actions

Model C predicts τ\*; the executor converts it to phase commands, and **the
executor owns safety**:

- yellow and all-red are never shortened, by any model;
- min-green on the running phase is served before it is cut;
- a preemption that cannot be granted before the EV arrives is still granted
  (late is better than never) and logged as a **late trigger**;
- recovery resumes from the phase after the interrupted one, which is credited
  the green it lost.

These are the same invariants already enforced and unit-tested in the JS
junction model in this repo, and they carry over directly.
