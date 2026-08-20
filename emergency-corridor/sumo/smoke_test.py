"""End-to-end check that the simulation, the phase machine and preemption work.

This is the gate for roadmap blocks 1 and 2. It asserts behaviour, not just that
nothing crashed:

* the network loads and the phase plan is one arm at a time;
* traffic actually flows and queues actually form;
* a preemption request brings the EV's arm to green;
* clearance intervals are never skipped, with or without preemption;
* the EV crosses faster with preemption than without, on the same seed.

Run:  C:\\ecv\\Scripts\\python.exe sumo/smoke_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import traci  # noqa: E402
import traci_env as env  # noqa: E402
from demand import write_routes  # noqa: E402

NET = HERE / "nets" / "junction4" / "net.net.xml"
ROU = HERE / "nets" / "junction4" / "smoke.rou.xml"

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        FAILURES.append(name)
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def run(preempt: bool, seed: int = 7, demand: int = 900, horizon: int = 500,
        ev_depart: float = 150.0) -> dict:
    """One run. Returns EV timings plus a record of clearance intervals seen.

    The EV departs at 150 s so that, against the 120 s background cycle, it
    reaches the stop line while its own arm is red and a queue has already
    built. A scenario where the unit arrives on a green measures nothing.
    """
    write_routes(ROU, demand_vph=demand, duration=horizon, seed=seed,
                 ev_arm="S", ev_type="ambulance", ev_depart=ev_depart,
                 loading="heavy_all")
    env.start(str(NET), str(ROU), gui=False, seed=seed)

    tls = traci.trafficlight.getIDList()[0]
    plan = env.discover_plan(tls)
    ctl = env.SignalController(plan)
    jx, jy = traci.junction.getPosition("C")

    ev_edge = "S2C"
    t = 0.0
    ev_enter = ev_cross = None
    ev_wait = 0.0
    requested = False
    green_at_request = None
    max_queue = 0.0
    departed = arrived = 0
    teleports = 0
    collisions = 0
    yellows: list[float] = []
    allreds: list[float] = []
    prev_state, state_since = ctl.state, 0.0
    multi_green = 0

    while t < horizon:
        traci.simulationStep()
        t = traci.simulation.getTime()
        # these are per-step counts, not cumulative totals
        departed += traci.simulation.getDepartedNumber()
        arrived += traci.simulation.getArrivedNumber()
        teleports += traci.simulation.getStartingTeleportNumber()
        collisions += traci.simulation.getCollidingVehiclesNumber()

        ev = env.ev_state("EV", (jx, jy))
        if ev is not None:
            if ev_enter is None:
                ev_enter = t
            ev_wait = traci.vehicle.getAccumulatedWaitingTime("EV")
            if preempt and not requested and ev["distance"] <= 200:
                green_at_request = ctl.aspect(ev_edge) == "green"
                requested = ctl.request_preempt(ev_edge, t)
            if ev["edge"].startswith("C2") and ev_cross is None:
                ev_cross = t
                ctl.release_preempt(t)
        elif ev_enter is not None and ev_cross is None:
            ev_cross = t                       # left the network

        ctl.step(env.STEP, t)

        if ctl.state != prev_state:
            dur = t - state_since
            if prev_state == "yellow":
                yellows.append(dur)
            elif prev_state == "allred":
                allreds.append(dur)
            prev_state, state_since = ctl.state, t

        if sum(1 for e in plan.approach_to_green if ctl.aspect(e) == "green") > 1:
            multi_green += 1
        max_queue = max(max_queue, env.approach_state(ev_edge)["queue_pcu"])

    env.close()
    return {
        "ev_time": (ev_cross - ev_enter) if (ev_enter and ev_cross) else None,
        "ev_wait": ev_wait,
        "transition": ctl.transition_time,
        "green_at_request": green_at_request,
        "yellows": yellows,
        "allreds": allreds,
        "multi_green": multi_green,
        "max_queue": max_queue,
        "departed": departed,
        "arrived": arrived,
        "teleports": teleports,
        "collisions": collisions,
        "n_greens": len(plan.green_to_approach),
    }


def main() -> int:
    print("\nNetwork and phase plan")
    base = run(preempt=False)
    check("network loads and runs", base["departed"] > 50, f"{base['departed']} departed")
    check("four green phases, one arm each", base["n_greens"] == 4, f"{base['n_greens']}")
    check("only one arm green at a time", base["multi_green"] == 0,
          f"{base['multi_green']} steps with >1 green")
    check("traffic queues form", base["max_queue"] > 5, f"max {base['max_queue']:.1f} PCU")
    check("vehicles clear the junction", base["arrived"] > 30, f"{base['arrived']} arrived")

    print("\nClearance intervals (no preemption)")
    # Assert the intervals were actually observed before asserting anything
    # about them. all([]) is True, so without this the two checks below pass
    # perfectly on a signal that never changed phase at all.
    check("the signal actually cycles", len(base["yellows"]) >= 3 and len(base["allreds"]) >= 3,
          f"{len(base['yellows'])} yellows, {len(base['allreds'])} all-reds observed")
    check("every yellow at least 3 s",
          bool(base["yellows"]) and all(y >= env.YELLOW - 0.51 for y in base["yellows"]),
          f"min {min(base['yellows']):.1f}s" if base["yellows"] else "none observed")
    check("every all-red at least 2 s",
          bool(base["allreds"]) and all(r >= env.ALL_RED - 0.51 for r in base["allreds"]),
          f"min {min(base['allreds']):.1f}s" if base["allreds"] else "none observed")

    print("\nSimulation integrity")
    # A teleport relocates a vehicle downstream and erases its delay. Any
    # teleport makes the run's numbers meaningless, so this is a hard gate.
    check("no vehicle teleported", base["teleports"] == 0,
          f"{base['teleports']} teleport(s) — delay measurements would be invalid")

    print("\nThe ambulance is actually obstructed without preemption")
    check("EV waits at the junction", base["ev_wait"] > 3.0,
          f"{base['ev_wait']:.1f}s waiting — if ~0 the scenario tests nothing")

    print("\nEmergency preemption")
    pre = run(preempt=True)
    check("EV crossed the junction", pre["ev_time"] is not None)
    check("preemption was granted", pre["transition"] is not None, "no transition recorded")
    if pre["transition"] is not None:
        if pre["green_at_request"]:
            # legitimate: the arm was already green, nothing to transition
            check("no transition needed when the arm was already green",
                  pre["transition"] < 0.51, f"{pre['transition']:.1f}s")
        else:
            check("transition paid yellow + all-red",
                  pre["transition"] >= env.YELLOW + env.ALL_RED - 0.51,
                  f"{pre['transition']:.1f}s")
    check("still only one arm green at a time", pre["multi_green"] == 0, f"{pre['multi_green']}")
    check("no teleport under preemption either", pre["teleports"] == 0, f"{pre['teleports']}")
    check("clearance never skipped under preemption",
          bool(pre["yellows"]) and bool(pre["allreds"])
          and all(y >= env.YELLOW - 0.51 for y in pre["yellows"])
          and all(r >= env.ALL_RED - 0.51 for r in pre["allreds"]),
          f"{len(pre['yellows'])} yellows, {len(pre['allreds'])} all-reds")

    print("\nDoes preemption help?")
    if base["ev_time"] and pre["ev_time"]:
        gain = 100 * (base["ev_time"] - pre["ev_time"]) / base["ev_time"]
        print(f"       no preemption {base['ev_time']:.1f}s (waited {base['ev_wait']:.1f}s) | "
              f"preemption {pre['ev_time']:.1f}s (waited {pre['ev_wait']:.1f}s) | {gain:+.1f}%")
        check("preemption reduces EV waiting time", pre["ev_wait"] < base["ev_wait"],
              f"{pre['ev_wait']:.1f}s vs {base['ev_wait']:.1f}s")
    else:
        check("both runs produced an EV time", False,
              f"base={base['ev_time']} pre={pre['ev_time']}")

    print(f"\n{'ALL CHECKS PASSED' if not FAILURES else str(len(FAILURES)) + ' CHECK(S) FAILED'}")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    raise SystemExit(main())
