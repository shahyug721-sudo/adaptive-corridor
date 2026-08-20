"""Route and demand generation for the four-arm junction.

Demand is written as a SUMO route file per scenario rather than generated live
through TraCI, so a scenario is fully reproducible from its seed and its route
file can be inspected when a result looks wrong.

Fleet composition is Indian urban mixed traffic. The two-wheeler share is what
makes these junctions behave differently from European ones: they are half the
vehicles by count but a fifth of the PCU, they discharge fast, and they fill
gaps that would otherwise let a larger vehicle move. Modelling them as cars
would overstate queue length and understate discharge rate at the same time.
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path

# class -> (share, length m, accel, decel, max speed m/s, PCU)
FLEET = {
    "moto": (0.34, 1.95, 2.6, 4.5, 15.5, 0.5),
    "car":  (0.27, 4.15, 2.0, 4.0, 14.0, 1.0),
    "auto": (0.17, 2.60, 1.6, 3.5, 11.0, 0.8),
    "bus":  (0.05, 11.0, 1.0, 3.0, 11.0, 3.0),
    "lcv":  (0.09, 6.20, 1.2, 3.2, 12.5, 2.0),
    "suv":  (0.08, 4.70, 1.9, 4.0, 14.5, 1.0),
}

ARMS = ["N", "E", "S", "W"]
OPPOSITE = {"N": "S", "S": "N", "E": "W", "W": "E"}
# left turn in left-hand traffic, from the perspective of each approach
LEFT_OF = {"N": "E", "E": "S", "S": "W", "W": "N"}
RIGHT_OF = {v: k for k, v in LEFT_OF.items()}

EV_TYPES = {
    "ambulance": (6.1, 1.9, 4.0),
    "fire": (10.5, 1.1, 3.5),
    "police": (4.8, 2.6, 4.5),
}


def vtypes_xml() -> str:
    out = []
    for name, (_, length, accel, decel, vmax, _) in FLEET.items():
        out.append(
            f'  <vType id="{name}" length="{length}" accel="{accel}" decel="{decel}" '
            f'maxSpeed="{vmax}" sigma="0.5" minGap="1.6" tau="1.1" '
            f'guiShape="{"motorcycle" if name == "moto" else "passenger"}"/>'
        )
    for name, (length, accel, decel) in EV_TYPES.items():
        # What actually constrains the ambulance, and why preemption helps.
        #
        # The bluelight device attached to the EV below sets SUMO speed mode 7,
        # which drops the "respect red lights" and "respect right of way" bits.
        # So the unit *may* legally proceed against a red -- which matches
        # Indian practice, where an ambulance crosses a red with due caution.
        #
        # It is still not free to move, because a red signal produces a standing
        # queue and no permission drives through stopped vehicles. Measured on
        # the smoke-test scenario, the unit waits 84 s without preemption and
        # 8 s with it. The benefit therefore comes from *discharging the queue
        # ahead of the unit*, not from granting it permission it already had.
        #
        # That is precisely the thesis of Obrusnik et al. (IFAC 2020), and it is
        # the reason preemption has to be triggered early enough for the queue
        # to clear rather than at a fixed distance.
        #
        # jmDriveAfterRedTime and jmIgnoreFoeProb are deliberately NOT set: they
        # would let the unit drive *through* conflicting traffic rather than
        # merely against a red, which is neither legal nor physical.
        out.append(
            f'  <vType id="{name}" vClass="emergency" length="{length}" accel="{accel}" '
            f'decel="{decel}" maxSpeed="25.0" sigma="0.1" minGap="1.2" tau="0.8" '
            f'guiShape="emergency" color="1,0,0" speedFactor="1.3"/>'
        )
    return "\n".join(out)


def write_routes(
    path: Path,
    demand_vph: int,
    duration: float,
    seed: int,
    ev_arm: str,
    ev_type: str = "ambulance",
    ev_depart: float = 60.0,
    loading: str = "balanced",
    ev_speed_ms: float = 13.0,
) -> None:
    """Write a route file for one scenario."""
    rng = random.Random(seed)

    # Approach loading shapes where the pressure sits, which is what makes
    # "heavy on the conflicting approach" a different problem from "heavy
    # everywhere" -- the first is a preemption cost question, the second a
    # capacity question.
    weights = {a: 1.0 for a in ARMS}
    conflicting = [a for a in ARMS if a not in (ev_arm, OPPOSITE[ev_arm])]
    if loading == "heavy_ev":
        weights[ev_arm] = 2.2
    elif loading == "heavy_conflicting":
        for a in conflicting:
            weights[a] = 2.2
    elif loading == "heavy_all":
        for a in ARMS:
            weights[a] = 1.9

    lines = ['<routes>', vtypes_xml()]

    # Every through/left/right movement as an explicit route.
    for a in ARMS:
        for dest, tag in ((OPPOSITE[a], "s"), (LEFT_OF[a], "l"), (RIGHT_OF[a], "r")):
            lines.append(f'  <route id="r_{a}{tag}" edges="{a}2C C2{dest}"/>')

    classes = list(FLEET)
    shares = [FLEET[c][0] for c in classes]

    vehicles: list[tuple[float, str]] = []
    for a in ARMS:
        rate = demand_vph * weights[a] / 3600.0
        t = 0.0
        while True:
            t += rng.expovariate(rate) if rate > 0 else 1e9
            if t >= duration:
                break
            cls = rng.choices(classes, weights=shares)[0]
            turn = rng.choices(["s", "l", "r"], weights=[0.58, 0.27, 0.15])[0]
            vid = f"{a}_{cls}_{len(vehicles)}"
            vehicles.append((t, (
                f'  <vehicle id="{vid}" type="{cls}" route="r_{a}{turn}" '
                f'depart="{t:.2f}" departLane="random" departSpeed="max"/>'
            )))

    ev_line = (
        f'  <vehicle id="EV" type="{ev_type}" route="r_{ev_arm}s" '
        f'depart="{ev_depart:.2f}" departLane="best" departSpeed="max">\n'
        f'    <param key="has.bluelight.device" value="true"/>\n'
        f'  </vehicle>'
    )
    vehicles.append((ev_depart, ev_line))

    for _, xml in sorted(vehicles, key=lambda p: p[0]):
        lines.append(xml)
    lines.append('</routes>')

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="nets/junction4/routes.rou.xml")
    ap.add_argument("--demand", type=int, default=620)
    ap.add_argument("--duration", type=float, default=600)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--ev-arm", default="S", choices=ARMS)
    ap.add_argument("--ev-type", default="ambulance", choices=list(EV_TYPES))
    ap.add_argument("--ev-depart", type=float, default=60.0)
    ap.add_argument("--loading", default="balanced")
    args = ap.parse_args()

    out = Path(__file__).resolve().parent / args.out
    write_routes(out, args.demand, args.duration, args.seed, args.ev_arm,
                 args.ev_type, args.ev_depart, args.loading)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
