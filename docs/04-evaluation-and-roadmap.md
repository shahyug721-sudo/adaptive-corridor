# 4. Evaluation methodology, folder structure, roadmap, and changes to this repo

---

## 4.1 Evaluation methodology

### Comparison (§27)

Every scenario runs under all three models on **identical seeds**:

| Model | Description |
|---|---|
| A | Fixed-time signal, no preemption |
| B | Rule-based queue-discharge EVP (P5 concept) |
| C | Learned trigger-time controller (P6 formulation) |

Reporting A vs C alone would overstate the contribution. **B is the honest
comparator** — if C does not beat B, that is the finding, and it gets reported.

### Metrics (§19)

*Emergency vehicle:* travel time, delay vs free-flow, waiting time, stops, time
at red, junction crossing time.

*Normal traffic:* mean waiting time, mean travel time, mean delay, mean and max
queue per approach, throughput, vehicles affected.

*Controller:* trigger time, preemption duration, clearance time, recovery time,
unnecessary preemptions, late triggers, false activation rate.

*AI:* accuracy, precision, recall, F1, ROC-AUC, FPR, FNR, inference latency —
on Test-in **and** Test-cross, reported separately.

### Statistics

- **10 seeds per scenario per model** (tune to compute budget).
- Report **mean ± SD**, never a single run.
- **Paired** comparison across models on matched seeds — paired t-test or
  Wilcoxon signed-rank, since the same traffic is being compared.
- Report effect size, not just p-values. With enough seeds everything becomes
  "significant"; a 0.4 s improvement is still 0.4 s.

### Ablations (§36)

| ID | Configuration |
|---|---|
| A | MFCC only → classical ML |
| B | Mel spectrogram → CNN |
| C | Spectral + temporal battery → classical ML |
| D | CNN / CNN+BiLSTM |
| E | Rule-based preemption |
| F | ML preemption, single junction |
| G | ML corridor controller, multi-junction |

Plus **threshold sweep** on τ, tracing the FPR/FNR trade-off through to traffic
cost — the result that only the closed loop can produce.

### Failure analysis (§37)

Failures get their own section, not a footnote. For every stress case: what the
system did, why, and whether it degraded gracefully or catastrophically. A late
trigger that still helps is a different failure from one that stops the cross
street for a phantom.

---

## 4.2 Folder structure

```
emergency-corridor/
├── README.md
├── requirements.txt
├── docs/                       01–04 (these documents)
├── audio/
│   ├── data/                   download scripts, split manifests (no WAVs in git)
│   ├── features.py             MFCC, Mel, spectral/temporal battery
│   ├── augment.py              SNR mixing, SpecAugment, time/pitch
│   ├── datasets.py             torch Dataset, fold-aware splitting
│   ├── models.py               SVM/RF, CNN, CNN+BiLSTM
│   ├── train.py
│   ├── evaluate.py             metrics, ROC, confusion matrix, latency
│   └── artifacts/              trained weights, split manifests
├── sumo/
│   ├── nets/junction4/         net.xml, rou.xml, tls, sumocfg
│   ├── nets/corridor3/
│   ├── build_nets.py           netconvert wrappers
│   └── traci_env.py            state extraction, action execution, safety
├── control/
│   ├── baseline_fixed.py       Model A
│   ├── rule_evp.py             Model B
│   ├── features.py             observable whitelist (leakage boundary)
│   ├── label_oracle.py         tau sweep -> tau*
│   ├── train_controller.py     RF / XGBoost / MLP
│   └── objective.py            J, normalisation, weight sensitivity
├── scenarios/
│   ├── generate.py             deterministic matrix + balance check
│   ├── core60.csv
│   └── stress12.csv
├── experiments/
│   ├── run_matrix.py
│   ├── run_ablations.py
│   └── results/
├── analysis/
│   ├── figures.py              the 16 plots of §25
│   └── tables.py
├── dashboard/app.py            Streamlit, the 5 panels of §24
└── tests/
```

---

## 4.3 Roadmap

§35's 20 phases, grouped with explicit gates. **A phase is not done until its
gate passes.**

| Block | Phases | Gate |
|---|---|---|
| **0. Setup** | install SUMO, `SUMO_HOME`, pip deps | `sumo --version` runs; `import traci` works |
| **1. Simulation** | 1–4: junction net, traffic, EV, TraCI control | a scripted phase change is observable in sumo-gui |
| **2. Rule EVP** | 5: Model B | EV delay drops vs Model A on 3 pilot scenarios |
| **3. Audio** | 6–9: dataset, features, baselines, CNN | Test-in **and** Test-cross metrics reported; no split leakage |
| **4. Coupling** | 10: closed loop | a false positive from Test-cross produces a measurable cross-street cost |
| **5. Learned control** | 11–13: state logging, oracle labels, Model C | C beats B on held-out seeds — **or is reported as not beating it** |
| **6. Corridor** | 14: Net 2 | downstream effects quantified |
| **7. Evaluation** | 15–17: 60 + 12 + 15 scenarios, all models | full results tables |
| **8. Analysis** | 18–20: ablations, failures, dashboard | one-command demo |

Sequencing note: block 3 (audio) is independent of blocks 1–2 and can proceed in
parallel; blocks 4 onward depend on both.

---

## 4.4 What changes in this repository

**Honest assessment: this specification is a different project from what is
currently built here, in a different stack.** It should be stated plainly rather
than papered over.

| Current | Spec requires | Verdict |
|---|---|---|
| Custom JS microscopic sim in-browser | SUMO + TraCI (§29) | **Replace.** The JS sim cannot satisfy §29 and should not pretend to. |
| Analytical/heuristic controllers | ML/DL controller (§9) | **Replace as the headline**, but see below |
| No audio component | CNN siren classifier (§17) | **Build new** |
| IR-sensor junction model | audio only, no sensors (§28) | **Out of scope** |
| three.js 3D views | SUMO GUI + Streamlit (§24) | **Demote** to optional presentation layer |

**What genuinely carries over — concepts, not code:**

1. **The safety invariants.** Yellow and all-red never shortened; min-green
   served before a phase is cut; recovery from the phase after the interrupted
   one, credited its lost green. These are already implemented and unit-tested
   here, and they transfer directly to the TraCI executor (doc 02 §2.6).
2. **The queue-discharge trigger formula.** Already implemented; it becomes
   **Model B**, and §27 explicitly requires exactly such a baseline. This is
   real prior work, not wasted effort.
3. **The evaluation discipline.** Measuring what preemption *costs the cross
   street*, not only what it saves the ambulance — already the practice here
   and directly required by §19.
4. **Scenario-matrix thinking** and seeded reproducibility.
5. **The finding that coarse sensing degrades adaptive control** (the IR tier
   result). Out of scope for this spec, but a legitimate discussion point about
   why the audio path needs a real classifier rather than a threshold.

**Recommendation:** start the new work in a **separate top-level package**
(`emergency-corridor/`) rather than mutating the existing scenarios. The current
three JS scenarios stay as they are — they are working, tested and demonstrable,
and they cost nothing to keep. Deleting them to make room would trade a working
demo for an unbuilt one.

---

## 4.5 Open questions and risks

| Risk | Assessment |
|---|---|
| **SUMO not installed** | Hard blocker for phases 1–5. First task. |
| **900 clips/class is small for a CNN** | Real risk of overfitting. Mitigations: augmentation, cross-corpus test, report Test-cross separately. If Test-cross collapses, say so — that is a finding. |
| **Audio–simulation coupling is artificial** | Acknowledged and addressed by doc 01 §1.5. A panel *will* ask; the closed-loop error-propagation answer is the defence. |
| **Model C may not beat Model B** | Genuinely possible — P5's rule is good. Pre-committing to report this outcome is what keeps the study honest. |
| **Left- vs right-hand traffic in SUMO** | Decide once, document, keep consistent (doc 02 §2.5). |
| **Compute budget** | 60 scenarios × 3 models × 10 seeds = 1800 runs, plus the τ-sweep for oracle labels (×31 per state) is far larger. Oracle labelling likely needs a coarser τ grid or a subset of scenarios. **Estimate before committing.** |
| **P4 and P5 methodology unverified** | Marked *Verification required* in doc 01. Must be resolved from full text before either is described in the report. |

---

## 4.6 Standing rules for this project

- Never report a literature accuracy as our result.
- Never report any metric before the model has been trained and evaluated.
- Never invent a citation; unverifiable → **"Verification required."**
- Always separate *observable state* from *oracle target*.
- Always report the cost to normal traffic alongside the benefit to the EV.
- Always report failures.
