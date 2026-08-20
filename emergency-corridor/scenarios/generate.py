"""Deterministic scenario matrix generator.

The specification asks for ~60 *structured* scenarios, not 60 random ones. A
full factorial over the eight factors in the brief is 5 x 4 x 3 x 3 x 4 x 4 x 3
x 3 = 25,920 cells, so selection is mandatory and has to be principled.

DESIGN
------
Core grid: full factorial on the three factors most likely to change the *sign*
of the result --

    density (5) x EV approach direction (4) x signal phase on arrival (3) = 60

Density governs whether a queue can clear at all; direction checks the
controller is not accidentally tuned to one arm; arrival phase governs whether
preemption is needed in the first place.

The remaining factors are overlaid so that each level appears equally often and
none of them lines up with a core factor.

Decompose the scenario index into its core coordinates:

    i = n*12 + d*3 + p     with  p = phase(3), d = direction(4), n = density(5)

The obvious approach -- a plain stride such as `EV_SPEED[i % 3]` -- is wrong,
and the balance check below caught it. `i % 3` *is* p, so that overlay would be
perfectly confounded with phase: every ev_green scenario would be a slow EV and
every conflicting_green scenario a fast one, and no analysis could ever separate
the two effects. Likewise `(i // 3) % 3` and `(i // 9) % 3` do not divide 60
evenly and come out unbalanced (21/21/18 and 24/18/18).

Instead each overlay is a linear combination of all three core coordinates:

    ev_speed = (p + d + n)   mod 3
    queue    = (p + 2d + n)  mod 3
    priority = (p + d + 2n)  mod 3
    loading  = (d + n)       mod 4

For any fixed (d, n) the phase p runs 0,1,2, so each 3-level overlay takes all
three values exactly once -- 20 occurrences each over the 60 cells. For loading,
each (d, n) pair occurs three times and (d + n) mod 4 covers all four levels
once per density, giving 15 each. Within any single level of any core factor
every overlay still varies, so nothing is confounded.

The three 3-level overlays differ from each other by a multiple of d or n, so
they are not copies of one another; they are not *mutually* orthogonal either,
which is the accepted cost of a fractional design at this size. The mutual
cross-tabulation is printed so the residual correlation is visible rather than
hidden.

All of this is *asserted*, not assumed -- `check_balance()` fails loudly if an
overlay ever becomes confounded with a core factor. A confounded matrix silently
attributes one factor's effect to another, which would invalidate every result
computed from it.
"""

from __future__ import annotations

import argparse
import csv
import itertools
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict, fields
from pathlib import Path

# ---------------------------------------------------------------- factors

DENSITY = ["very_low", "low", "medium", "high", "very_high"]
DIRECTION = ["N2S", "S2N", "E2W", "W2E"]
PHASE = ["ev_green", "ev_red", "conflicting_green"]

EV_SPEED = ["low", "medium", "high"]
QUEUE = ["short", "medium", "long"]
PRIORITY = ["ambulance", "fire", "police"]
LOADING = ["balanced", "heavy_ev", "heavy_conflicting", "heavy_all"]

# Demand in vehicles/hour per approach, and the EV's desired speed in m/s.
DENSITY_VPH = {"very_low": 180, "low": 360, "medium": 620, "high": 900, "very_high": 1200}
EV_SPEED_MS = {"low": 8.0, "medium": 13.0, "high": 18.0}
# Ambulance, fire appliance and police car differ in size and acceleration, which
# changes how long they take to clear the junction box once released.
PRIORITY_SPEC = {
    "ambulance": {"length": 6.1, "accel": 1.9, "decel": 4.0},
    "fire": {"length": 10.5, "accel": 1.1, "decel": 3.5},
    "police": {"length": 4.8, "accel": 2.6, "decel": 4.5},
}


@dataclass(frozen=True)
class Scenario:
    sid: str
    kind: str            # "core" | "stress" | "corridor"
    density: str
    direction: str
    phase: str
    ev_speed: str
    queue: str
    priority: str
    loading: str
    demand_vph: int
    ev_speed_ms: float
    audio_clip: str      # which held-out clip class drives detection
    note: str = ""


# ---------------------------------------------------------------- core 60

def build_core() -> list[Scenario]:
    """Full factorial on (density, direction, phase); overlays by index stride."""
    out: list[Scenario] = []
    for i, (density, direction, phase) in enumerate(
        itertools.product(DENSITY, DIRECTION, PHASE)
    ):
        # core coordinates: i = n*12 + d*3 + p
        p = i % 3
        d = (i // 3) % 4
        n = i // 12
        speed = EV_SPEED[(p + d + n) % 3]
        queue = QUEUE[(p + 2 * d + n) % 3]
        priority = PRIORITY[(p + d + 2 * n) % 3]
        loading = LOADING[(d + n) % 4]
        out.append(
            Scenario(
                sid=f"C{i + 1:02d}",
                kind="core",
                density=density,
                direction=direction,
                phase=phase,
                ev_speed=speed,
                queue=queue,
                priority=priority,
                loading=loading,
                demand_vph=DENSITY_VPH[density],
                ev_speed_ms=EV_SPEED_MS[speed],
                audio_clip="siren_heldout",
            )
        )
    return out


# ---------------------------------------------------------------- stress 12

STRESS = [
    ("S01", "two_ev_conflicting", "Two EVs, N and E simultaneously — arbitration must be a model output"),
    ("S02", "two_ev_same_approach", "Two EVs same approach, 20 s apart — queued requests, no double preemption"),
    ("S03", "two_ev_opposing", "Two EVs N->S and S->N — non-conflicting, can both be served?"),
    ("S04", "false_positive_horn", "Car horn from UrbanSound8K — phantom preemption, cost measured"),
    ("S05", "false_positive_music", "Street music / jackhammer — harder negative"),
    ("S06", "weak_confidence", "p(siren) just above threshold — should PREPARE, not PREEMPT"),
    ("S07", "missed_detection", "Siren clip the classifier gets wrong — EV queues, cost measured"),
    ("S08", "noisy_0db", "Siren mixed with road noise at 0 dB SNR"),
    ("S09", "ev_decelerates", "EV slows mid-approach — ETA invalidated after trigger"),
    ("S10", "ev_accelerates", "EV arrives earlier than predicted — trigger was too late"),
    ("S11", "downstream_spillback", "Severe spillback from downstream — preemption must not worsen it"),
    ("S12", "cycle_nearly_complete", "Cycle almost finished on arrival — transition edge case"),
]

# Which audio class each stress case draws from. This is what makes the
# false-alarm scenarios real rather than a scripted flag: the clip goes through
# the actual trained classifier and whatever it decides is what the controller
# acts on.
STRESS_AUDIO = {
    "S04": "horn_heldout",
    "S05": "music_heldout",
    "S06": "siren_lowconf",
    "S07": "siren_heldout",
    "S08": "siren_noisy_0db",
}


def build_stress() -> list[Scenario]:
    out = []
    for idx, (sid, name, note) in enumerate(STRESS):
        out.append(
            Scenario(
                sid=sid,
                kind="stress",
                density="high" if idx % 2 == 0 else "very_high",
                direction=DIRECTION[idx % 4],
                phase=PHASE[idx % 3],
                ev_speed="medium",
                queue="long",
                priority="ambulance",
                loading="heavy_conflicting",
                demand_vph=DENSITY_VPH["high" if idx % 2 == 0 else "very_high"],
                ev_speed_ms=EV_SPEED_MS["medium"],
                audio_clip=STRESS_AUDIO.get(sid, "siren_heldout"),
                note=f"{name}: {note}",
            )
        )
    return out


# ---------------------------------------------------------------- corridor 15

def build_corridor() -> list[Scenario]:
    """Reduced set for the three-junction network (spec sections 12 and 30)."""
    out = []
    combos = list(itertools.product(DENSITY, PHASE))  # 5 x 3 = 15
    for i, (density, phase) in enumerate(combos):
        out.append(
            Scenario(
                sid=f"K{i + 1:02d}",
                kind="corridor",
                density=density,
                direction="S2N",
                phase=phase,
                ev_speed=EV_SPEED[i % 3],
                queue=QUEUE[i % 3],
                priority="ambulance",
                loading=LOADING[i % 4],
                demand_vph=DENSITY_VPH[density],
                ev_speed_ms=EV_SPEED_MS[EV_SPEED[i % 3]],
                audio_clip="siren_heldout",
                note="three signalised junctions; measures downstream effect",
            )
        )
    return out


# ---------------------------------------------------------------- balance

CORE_FACTORS = ["density", "direction", "phase"]
OVERLAY_FACTORS = ["ev_speed", "queue", "priority", "loading"]


def check_balance(core: list[Scenario]) -> list[str]:
    """Verify the overlays are balanced and not confounded with any core factor.

    Two properties are checked:

    1. each overlay level appears equally often overall;
    2. within every level of every core factor, an overlay takes more than one
       value -- if it took only one, that overlay would be perfectly confounded
       with the core factor and their effects could never be separated.
    """
    problems: list[str] = []

    for f in OVERLAY_FACTORS:
        counts = Counter(getattr(s, f) for s in core)
        if len(set(counts.values())) != 1:
            problems.append(f"{f} is unbalanced overall: {dict(counts)}")

    for cf in CORE_FACTORS:
        for of in OVERLAY_FACTORS:
            grouped: dict[str, set[str]] = defaultdict(set)
            for s in core:
                grouped[getattr(s, cf)].add(getattr(s, of))
            for level, values in grouped.items():
                if len(values) == 1:
                    problems.append(
                        f"{of} is confounded with {cf}={level}: only ever {values.pop()!r}"
                    )
    return problems


def coverage_report(core: list[Scenario]) -> str:
    lines = ["Factor coverage across the core grid:"]
    for f in CORE_FACTORS + OVERLAY_FACTORS:
        counts = Counter(getattr(s, f) for s in core)
        pretty = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        lines.append(f"  {f:10s} {pretty}")

    # Residual correlation between overlays is the accepted cost of a fractional
    # design; print it so it is visible rather than hidden.
    lines.append("")
    lines.append("Overlay cross-tabulation (min/max cell count, ideal is equal):")
    for a, b in itertools.combinations(OVERLAY_FACTORS, 2):
        cells = Counter((getattr(s, a), getattr(s, b)) for s in core)
        levels = len({getattr(s, a) for s in core}) * len({getattr(s, b) for s in core})
        missing = levels - len(cells)
        lines.append(
            f"  {a:9s} x {b:18s} min={min(cells.values())} max={max(cells.values())}"
            f" cells={len(cells)}/{levels}" + (f"  MISSING {missing}" if missing else "")
        )
    return "\n".join(lines)


# ---------------------------------------------------------------- io

def write_csv(path: Path, rows: list[Scenario]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = [f.name for f in fields(Scenario)]
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow(asdict(r))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(Path(__file__).parent), help="output directory")
    args = ap.parse_args()
    out = Path(args.out)

    core = build_core()
    stress = build_stress()
    corridor = build_corridor()

    assert len(core) == 60, f"expected 60 core scenarios, got {len(core)}"
    assert len(stress) == 12, f"expected 12 stress scenarios, got {len(stress)}"
    assert len(corridor) == 15, f"expected 15 corridor scenarios, got {len(corridor)}"

    problems = check_balance(core)
    print(coverage_report(core))
    print()
    if problems:
        print("BALANCE CHECK FAILED:")
        for p in problems:
            print("  -", p)
        return 1
    print("Balance check passed: no overlay is confounded with a core factor.")

    write_csv(out / "core60.csv", core)
    write_csv(out / "stress12.csv", stress)
    write_csv(out / "corridor15.csv", corridor)
    print(f"\nWrote {len(core)} core, {len(stress)} stress, {len(corridor)} corridor "
          f"scenarios to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
