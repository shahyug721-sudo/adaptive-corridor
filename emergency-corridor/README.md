# Emergency corridor — audio detection + SUMO preemption

Software-only. No hardware, no microphone, no roadside sensor. Siren detection
from public audio datasets; traffic state from SUMO/TraCI.

Design docs are in [`../docs`](../docs) (01–04).

## Setup

SUMO must go in a venv on a **short path** — see `requirements.txt` for why.

```bash
python -m venv C:\ecv
C:\ecv\Scripts\python.exe -m pip install -r requirements.txt
```

## What runs today

```bash
# scenario matrix: 60 core + 12 stress + 15 corridor, with a balance check
C:\ecv\Scripts\python.exe scenarios/generate.py

# build the SUMO networks
C:\ecv\Scripts\python.exe sumo/build_nets.py

# end-to-end gate: does the junction work, and does preemption help?
C:\ecv\Scripts\python.exe sumo/smoke_test.py
```

Current smoke-test result (seed 7, 900 veh/h all approaches, EV on the south arm
arriving against a red):

```
no preemption 114.0s (waited 84.0s) | preemption 37.0s (waited 8.0s) | +67.5%
```

## Status

| Block | State |
|---|---|
| 0 Setup | done — SUMO 1.27.1 via pip |
| 1 Junction network + traffic + EV + TraCI | done |
| 2 Rule-based preemption (Model B) | done |
| 3 Audio pipeline | features written, model not trained |
| 4 Closed-loop coupling | not started |
| 5 Learned controller (Model C) | not started |
| 6 Corridor (3 junctions) | network built, experiments not run |
| 7–8 Evaluation, ablations, dashboard | not started |

**No accuracy or traffic result is reported anywhere except the smoke-test
number above, which was measured.** Nothing is carried over from the literature
as if it were ours.

## Three things worth knowing

**Teleports had to be disabled explicitly.** SUMO's default
`--collision.action` is `teleport`, and `--time-to-teleport -1` does not cover
it. The ambulance rear-ended the queue it was braking into and got relocated
past the junction in one step, which erased the delay being measured and made
preemption look worth 0%. Runs now abort on any teleport
(`--max-num-teleports 0`) rather than producing quietly wrong numbers.

**The EV may cross a red, and preemption still helps.** The bluelight device
gives it SUMO speed mode 7, so it can proceed against a red — as ambulances do
in India. It is still blocked by the standing queue. The gain comes from
discharging that queue, which is the Obrusník et al. (IFAC 2020) result.

**The scenario matrix's first design was confounded.** `EV speed = i mod 3` is
the phase index, so speed and signal phase were perfectly correlated. The
generator's balance check caught it; overlays are now combinations of all three
core coordinates.
