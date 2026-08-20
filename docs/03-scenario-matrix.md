# 3. Scenario matrix

§13 requires ~60 **structured** scenarios, not 60 random ones. A full factorial
over the eight factors in the brief is 5×4×3×3×4×4×3×3 = **25,920 cells**, so
selection is mandatory and must be principled.

---

## 3.1 Design

**Core grid — full factorial on the three dominant factors:**

| Factor | Levels |
|---|---|
| Traffic density | very low, low, medium, high, very high (5) |
| EV approach direction | N→S, S→N, E→W, W→E (4) |
| Signal phase on EV arrival | EV green, EV red, conflicting green (3) |

5 × 4 × 3 = **60 scenarios**, every combination present exactly once.

These three are chosen as the core because they are the factors most likely to
change the *sign* of the result: density governs whether a queue can clear at
all, direction tests that the controller is not accidentally tuned to one arm,
and arrival phase governs whether preemption is needed at all.

**Overlay factors — balanced, not confounded.** The remaining factors are
assigned by index so each level appears 20 times and no overlay aligns with a
core factor. With scenarios numbered `i = 0..59`:

| Factor | Rule | Levels |
|---|---|---|
| EV speed | `i mod 3` | low / medium / high |
| Queue condition | `(i div 3) mod 3` | short / medium / long |
| EV priority | `(i div 9) mod 3` | ambulance / fire / police |
| Approach loading | `(i div 5) mod 4` | balanced / heavy-on-EV / heavy-on-conflicting / heavy-all |

Because 3, 3, 9 and 5 are chosen against the core strides (density stride 12,
direction stride 3, phase stride 1), no overlay is constant within any core
level. **This must be asserted in code**, not assumed — a balance check that
prints the cross-tabulation is part of the generator's test.

**Seeds.** Each of the 60 runs uses seeds from a *training* pool. Evaluation
repeats every scenario over a disjoint *test* seed pool (§22).

---

## 3.2 The 60 core scenarios

`D` density · `Dir` EV direction · `Ph` phase on arrival · `V` EV speed ·
`Q` queue · `Pr` priority · `L` approach loading

| # | D | Dir | Ph | V | Q | Pr | L |
|---|---|---|---|---|---|---|---|
| 1 | very low | N→S | EV green | low | short | amb | balanced |
| 2 | very low | N→S | EV red | med | short | amb | balanced |
| 3 | very low | N→S | conf green | high | short | amb | balanced |
| 4 | very low | S→N | EV green | low | med | amb | balanced |
| 5 | very low | S→N | EV red | med | med | amb | balanced |
| 6 | very low | S→N | conf green | high | med | amb | heavy-EV |
| 7 | very low | E→W | EV green | low | long | amb | heavy-EV |
| 8 | very low | E→W | EV red | med | long | amb | heavy-EV |
| 9 | very low | E→W | conf green | high | long | amb | heavy-EV |
| 10 | very low | W→E | EV green | low | short | fire | heavy-EV |
| 11 | very low | W→E | EV red | med | short | fire | heavy-conf |
| 12 | very low | W→E | conf green | high | short | fire | heavy-conf |
| 13 | low | N→S | EV green | low | med | fire | heavy-conf |
| 14 | low | N→S | EV red | med | med | fire | heavy-conf |
| 15 | low | N→S | conf green | high | med | fire | heavy-conf |
| 16 | low | S→N | EV green | low | long | fire | heavy-all |
| 17 | low | S→N | EV red | med | long | fire | heavy-all |
| 18 | low | S→N | conf green | high | long | fire | heavy-all |
| 19 | low | E→W | EV green | low | short | police | heavy-all |
| 20 | low | E→W | EV red | med | short | police | heavy-all |
| 21 | low | E→W | conf green | high | short | police | balanced |
| 22 | low | W→E | EV green | low | med | police | balanced |
| 23 | low | W→E | EV red | med | med | police | balanced |
| 24 | low | W→E | conf green | high | med | police | balanced |
| 25 | medium | N→S | EV green | low | long | police | balanced |
| 26 | medium | N→S | EV red | med | long | police | heavy-EV |
| 27 | medium | N→S | conf green | high | long | police | heavy-EV |
| 28 | medium | S→N | EV green | low | short | amb | heavy-EV |
| 29 | medium | S→N | EV red | med | short | amb | heavy-EV |
| 30 | medium | S→N | conf green | high | short | amb | heavy-EV |
| 31 | medium | E→W | EV green | low | med | amb | heavy-conf |
| 32 | medium | E→W | EV red | med | med | amb | heavy-conf |
| 33 | medium | E→W | conf green | high | med | amb | heavy-conf |
| 34 | medium | W→E | EV green | low | long | amb | heavy-conf |
| 35 | medium | W→E | EV red | med | long | amb | heavy-conf |
| 36 | medium | W→E | conf green | high | long | amb | heavy-all |
| 37 | high | N→S | EV green | low | short | fire | heavy-all |
| 38 | high | N→S | EV red | med | short | fire | heavy-all |
| 39 | high | N→S | conf green | high | short | fire | heavy-all |
| 40 | high | S→N | EV green | low | med | fire | heavy-all |
| 41 | high | S→N | EV red | med | med | fire | balanced |
| 42 | high | S→N | conf green | high | med | fire | balanced |
| 43 | high | E→W | EV green | low | long | fire | balanced |
| 44 | high | E→W | EV red | med | long | fire | balanced |
| 45 | high | E→W | conf green | high | long | fire | balanced |
| 46 | high | W→E | EV green | low | short | police | heavy-EV |
| 47 | high | W→E | EV red | med | short | police | heavy-EV |
| 48 | high | W→E | conf green | high | short | police | heavy-EV |
| 49 | very high | N→S | EV green | low | med | police | heavy-EV |
| 50 | very high | N→S | EV red | med | med | police | heavy-EV |
| 51 | very high | N→S | conf green | high | med | police | heavy-conf |
| 52 | very high | S→N | EV green | low | long | police | heavy-conf |
| 53 | very high | S→N | EV red | med | long | police | heavy-conf |
| 54 | very high | S→N | conf green | high | long | police | heavy-conf |
| 55 | very high | E→W | EV green | low | short | amb | heavy-conf |
| 56 | very high | E→W | EV red | med | short | amb | heavy-all |
| 57 | very high | E→W | conf green | high | short | amb | heavy-all |
| 58 | very high | W→E | EV green | low | med | amb | heavy-all |
| 59 | very high | W→E | EV red | med | med | amb | heavy-all |
| 60 | very high | W→E | conf green | high | med | amb | heavy-all |

The table above is **illustrative of the rule**; the generator in
`scenarios/generate.py` is the source of truth and emits this deterministically
from a seed, together with the balance cross-tabulation.

---

## 3.3 Coverage against §14's required groups

| §14 group | Covered by |
|---|---|
| A — easy cases | 1–12 (very low/low × near/far via speed+queue) |
| B — direction | every direction appears 15× across the grid |
| C — signal phase | phase is a core factor; every level appears 20× |
| D — queue | overlay Q, 20× per level; **spillback** in stress set |
| E — speed | overlay V, 20× per level; accel/decel profiles in stress set |
| F — density | core factor, 12× per level |
| G — multiple approaches | overlay L (heavy-EV / heavy-conf / heavy-all) |
| H — priority | overlay Pr, 20× per level |
| I — complex junction | emerges from high-density × conflicting-green × long-queue cells (e.g. 51, 54, 57) |
| J — stress tests | **separate set below** |

---

## 3.4 Stress and failure set (12 scenarios, run separately)

These are deliberately **not** in the core 60. They vary things the core grid
holds fixed, so mixing them in would break the factorial balance and corrupt the
overlay statistics.

| ID | Scenario | What it tests |
|---|---|---|
| S1 | Two EVs, N and E, simultaneous | conflicting requests — arbitration must be a model output, not hard-coded (§15) |
| S2 | Two EVs, same approach, 20 s apart | queued requests, no double-preemption |
| S3 | Two EVs, opposing (N→S and S→N) | non-conflicting movements — can both be served? |
| S4 | **False positive**: horn clip from D2 | preemption on a phantom; cost measured in cross-street vehicle-seconds |
| S5 | **False positive**: street music / jackhammer | harder negative |
| S6 | **Weak confidence**: p(siren) just above τ | should route to PREPARE, not full PREEMPT |
| S7 | **Missed detection**: siren clip the model gets wrong | EV queues; cost measured |
| S8 | **Noisy environment**: siren mixed at 0 dB SNR | degraded p(siren), degraded timing |
| S9 | EV decelerates unexpectedly mid-approach | ETA estimate invalidated after trigger |
| S10 | EV accelerates; arrives earlier than predicted | trigger was too late |
| S11 | Severe spillback from downstream J2 | preemption at J1 cannot help; must not make it worse |
| S12 | Cycle nearly complete on arrival | transition timing edge case |

S4–S8 are only meaningful because of the closed-loop design in doc 01 §1.5 —
they use **real classifier outputs on held-out clips**, not injected flags.

---

## 3.5 Corridor scenarios (Net 2)

The 60 core scenarios run on Net 1 (isolated junction). A reduced set of
**15** runs on Net 2 (three junctions) — one per density × direction-pair ×
phase combination — to answer §12 and §30:

- Does preemption at J1 help or hurt at J2?
- Does preparing J2/J3 in advance beat treating each junction independently?
- What does the cross street at J2 pay for a unit that has not arrived yet?

This is the difference between *preemption* and a *corridor*, and it should be
reported as its own result rather than folded into the junction numbers.
