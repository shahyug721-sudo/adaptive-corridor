# 1. Literature mapping, research gap and novelty

Every citation below was checked against CrossRef or the arXiv API on
2026-08-20. Titles, authors, venues and years are reproduced from the registered
metadata, not from memory. Where a claim about a paper's *method* could not be
confirmed from metadata or an accessible abstract, it is marked
**Verification required** rather than filled in.

Author name order follows the CrossRef record; some Indian-origin names are
registered with given/family inverted and are reproduced as registered.

---

## 1.1 Verified references

| # | Reference | Status |
|---|---|---|
| P1 | Usha Mittal, Priyanka Chawla, *"Acoustic Based Emergency Vehicle Detection Using Ensemble of deep Learning Models"*, **Procedia Computer Science 218 (2023) 227–234**. DOI `10.1016/j.procs.2023.01.005` | ✅ verified in CrossRef |
| P2 | Dontabhaktuni Jayakumar, Modugu Krishnaiah, Sreedhar Kollem, Samineni Peddakrishna, Nadikatla Chandrasekhar, Maturi Thirupathi, *"Emergency Vehicle Classification Using Combined Temporal and Spectral Audio Features with Machine Learning Algorithms"*, **Electronics 13(19) (2024) 3873**. DOI `10.3390/electronics13193873` | ✅ verified in CrossRef |
| P3 | Muhammad Asif, Muhammad Usaid, Munaf Rashid, Tabarka Rajab, Samreen Hussain, Sarwar Wasi, *"Large-scale audio dataset for emergency vehicle sirens and road noises"*, **Scientific Data 9, 599 (2022)**. DOI `10.1038/s41597-022-01727-2` | ✅ verified in CrossRef |
| P4 | R. M. Savithramma, R. Sumathi, H. S. Sudhira, *"SMART Emergency Vehicle Management at Signalized Intersection using Machine Learning"*, **Indian Journal of Science and Technology 15(35) (2022) 1754–1763**. DOI `10.17485/IJST/v15i35.1151` | ✅ verified in CrossRef |
| P5 | Vít Obrusník, Ivo Herman, Zdeněk Hurák, *"Queue discharge-based emergency vehicle traffic signal preemption"*, **IFAC-PapersOnLine 53(2) (2020) 14997–15002**. DOI `10.1016/j.ifacol.2020.12.1998` | ✅ verified in CrossRef |
| P6 | Somdut Roy, Michael Hunter, Abhilasha Saroj, Angshuman Guin, *"Emergency Vehicle Preemption Strategies using Machine Learning to Optimize Traffic Operations"*, **arXiv:2605.13814v1**, 13 May 2026 | ✅ verified via arXiv API, abstract read |
| P7 | Vijay U. Rathod, Rohit Shitole, Kirti A. Patil, Nisha D. Patil, Madhuri P. Kumbhare, Pallavi Parllewar, Jibitesh Kumar Panda, *"Multimodal emergency vehicle prioritization through vision–audio fusion and attention-enhanced deep learning for smart traffic signal control"*, **Complex & Intelligent Systems 12(7) (2026) 179**. DOI `10.1007/s40747-026-02309-0` | ✅ verified in CrossRef |

### Additional datasets proposed by us (verified)

| # | Reference | Purpose |
|---|---|---|
| D1 | Asif et al. (P3) dataset, **figshare `10.6084/m9.figshare.19291472`** — 1800 WAV files (900 siren / 900 road noise) plus CSV feature tables | Primary training data |
| D2 | Justin Salamon, Christopher Jacoby, Juan Pablo Bello, *"A Dataset and Taxonomy for Urban Sound Research"*, **ACM Multimedia 2014**. DOI `10.1145/2647868.2655045` (UrbanSound8K) | **False-positive test set** — supplies car horn, jackhammer, drilling, engine idling, street music |
| D3 | Karol J. Piczak, *"ESC: Dataset for Environmental Sound Classification"*, **ACM Multimedia 2015**. DOI `10.1145/2733373.2806390` | Secondary negatives / cross-corpus generalisation |

**Why D2 is not optional.** §16 requires the classifier to reject horns,
construction noise and music. P3's negative class is *road noise* only. Testing
false positives on P3 alone would measure nothing of the kind, and would let us
report a false-positive rate that does not describe the failure mode we claim to
handle. UrbanSound8K supplies the confusable classes.

> **Verification required** — D2/D3 download terms and current hosting must be
> re-checked at implementation time before redistribution of any derived file.

---

## 1.2 Per-paper split: Adopted / Adapted / Not implemented

§32 requires this split explicitly. "Not implemented" is not a criticism of the
paper; it marks the hardware-dependent portion we deliberately exclude.

### P1 — Mittal & Chawla (2023), ensemble deep learning on siren audio

| | |
|---|---|
| **Adopted** | The premise that siren-vs-noise is learnable from short audio clips; the use of an *ensemble* over architecturally different models as a variance-reduction strategy. |
| **Adapted** | We compare individual models first (§17) and treat ensembling as an ablation, not a headline. |
| **Not implemented** | — |
| **Do not repeat** | Its reported accuracy figure is **its** result on **its** split. We report only numbers we measure. |

### P2 — Jayakumar et al. (2024), combined temporal + spectral features

| | |
|---|---|
| **Adopted** | The feature battery: RMS, zero-crossing rate, spectral centroid / bandwidth / roll-off / flux, MFCC — this is our primary reference for the classical-ML baseline's feature engineering (§3, §17 Baseline 1). |
| **Adapted** | We add SpecAugment-style augmentation and controlled-SNR noise mixing, which the paper does not require, because our clip count is small (§5.3). |
| **Not implemented** | — |

### P3 — Asif et al. (2022), the dataset

| | |
|---|---|
| **Adopted** | The dataset itself, used as published. |
| **Adapted** | We re-split it ourselves with a fixed seed and hold out a cross-corpus test set (D2), because the published CSV features are pre-extracted and we need control of the pipeline. |
| **Not implemented** | The authors physically recorded audio. **We record nothing.** We consume the published digital files only, which is what keeps the project hardware-free. |

### P4 — Savithramma et al. (2022), ML at a signalized intersection

| | |
|---|---|
| **Adopted** | The concept of learning green-time allocation at a signalized intersection with emergency-vehicle priority. |
| **Adapted** | Reformulated into our preemption-timing regression (§8 of doc 02). |
| **Not implemented** | > **Verification required** — the paper's sensing modality and whether it uses a microscopic simulator have not been confirmed from an accessible full text. Any claim about its inputs must be checked before it appears in the report. |

### P5 — Obrusník, Herman & Hurák (2020), queue-discharge preemption

| | |
|---|---|
| **Adopted** | **The central control idea of this project**: preemption should be triggered from *queue discharge time*, not from a fixed distance. Trigger too early and the cross street is stopped for nothing; too late and the queue has not cleared when the unit arrives. |
| **Adapted** | The paper obtains vehicle state over **V2I**. We obtain the equivalent state from **SUMO/TraCI**. This substitution is the single most important adaptation in the project and must be stated wherever the method is described. |
| **Not implemented** | V2I radio, roadside units, on-board units. |
| | > **Verification required** — the user brief states this work is SUMO-based. CrossRef metadata does not establish the simulator. Confirm from full text before asserting it. |

### P6 — Roy, Hunter, Saroj & Guin (2026), MLEVP

Abstract read and confirmed. This is the closest prior work to our traffic half.

| | |
|---|---|
| **Adopted** | Formulating EVP trigger-time selection as a **regression problem** trained on simulation-generated data; targeting *multiple downstream intersections*; the dual objective of near-optimal ERV travel time **while limiting delay on conflicting movements**. |
| **Adapted** | They use **PTV Vissim** (proprietary) with a calibrated corridor testbed and real-time sensor data. We use **SUMO** (open) and derive the equivalent state from TraCI. Our networks are synthetic, not calibrated to a real testbed — this is a genuine limitation to state, not to hide. |
| **Not implemented** | Physical vehicle detectors and signal-indication feeds. |

### P7 — Rathod et al. (2026), vision–audio fusion

| | |
|---|---|
| **Adopted** | Cited as recent evidence that audio-driven EV prioritisation feeding adaptive signal control is an active research direction. |
| **Adapted** | — |
| **Not implemented** | **The entire vision branch.** Our project is deliberately audio + simulation. We do not claim multimodal fusion. |

---

## 1.3 Research gap

Stated conservatively, from what the seven verified works actually do:

1. **P1, P2, P3 stop at classification.** They produce a siren/not-siren decision
   and never touch a traffic signal. No traffic outcome is measured.
2. **P4, P5, P6 start after detection is assumed.** They take emergency-vehicle
   presence and position as given — from V2I (P5) or sensor feeds (P6) — and
   optimise the signal response. Detection error never propagates into the
   traffic result.
3. **P7 couples audio to signal control**, but through a multimodal pipeline that
   includes a vision branch and is therefore not reproducible without camera
   infrastructure.

The gap is the **seam between the two halves**. In every verified work the
detector's errors and the controller's decisions live in separate experiments.
Nobody reports what a 3 % false-positive rate *costs the cross street in
vehicle-seconds*, or what a missed detection costs the ambulance, because the
two halves are never run as one closed loop.

That seam is also where a real deployment would fail first.

---

## 1.4 Novelty statement

Wording that is defensible against the verified literature:

> The proposed framework integrates acoustic emergency-siren recognition with a
> learning-based, queue-aware traffic-signal preemption mechanism inside a
> microscopic traffic simulation, and evaluates the two as a **single closed
> loop**. Rather than relying on physical roadside sensing or fixed-distance
> preemption, emergency-vehicle state and traffic conditions are derived in
> software from SUMO/TraCI, and the classifier's own held-out decisions —
> including its false positives and missed detections — drive the corridor
> controller. This makes detection error observable as a traffic cost, measured
> in emergency-vehicle delay and in delay imposed on conflicting movements,
> across a structured matrix of junction, density, direction, signal-phase,
> queue and acoustic-noise scenarios.

**Claims we will not make:**

- that siren detection is novel (P1, P2, P3 precede us);
- that signal preemption is novel (P4, P5, P6 precede us);
- that queue-aware preemption is novel (**P5 is exactly that**);
- that ML-based trigger-time prediction is novel (**P6 is exactly that**);
- that SUMO simulation is novel;
- that this integration is *unprecedented* — we have not run a systematic
  literature review, and §33 forbids the claim without one. The honest form is
  *"not addressed in the works reviewed here."*

**What is genuinely ours:** the closed-loop error propagation (§1.5), the
software-only substitution of TraCI state for V2I/sensor feeds carried through
consistently, and the scenario matrix as an evaluation instrument.

---

## 1.5 The design decision that makes this one system

This is the most important architectural choice in the project, and it is worth
stating before any code is written.

**The problem.** A siren WAV from a public dataset has no causal connection to a
SUMO vehicle. Naively, the classifier is a gate: classify a file, and if it says
"siren", start the simulation. A reviewer will immediately observe that the two
halves could be developed, tested and reported entirely independently — which
would make this two projects stapled together, not one.

**The fix.** Bind them through *error*, not through *presence*:

1. Each scenario is assigned an audio clip drawn from the **held-out** test
   split — siren clips for genuine emergencies, and negatives from D2
   (horn / jackhammer / street music) for the false-alarm scenarios.
2. The trained classifier is run on that clip. Its **actual** output — the
   probability, the decision at the operating threshold, and the measured
   inference latency — is what the controller receives.
3. Consequently:
   - a **false positive** triggers a real preemption in SUMO and the cross
     street pays for it in measured vehicle-seconds;
   - a **false negative** means no preemption and the ambulance queues;
   - **inference latency** delays the trigger, and the vehicle keeps moving
     during it;
   - a **low-confidence** detection can be routed to a `PREPARE` action rather
     than a full `PREEMPT`.

This turns the classifier's ROC operating point into a **traffic-engineering
decision**. Sweeping the decision threshold traces a curve from "misses
ambulances" to "stops the cross street for horns", and the objective function of
doc 02 §8.4 picks the operating point. That result cannot be obtained from
either half alone, and it is what the two halves are for.

It also gives scenario group J (57–59) something real to measure instead of a
scripted flag.
