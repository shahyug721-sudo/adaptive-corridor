"""Trace the EV against the signal, including teleport counters.

The EV appeared to move ~58 m in one second, which is impossible at its speed.
This traces every step around the junction and counts SUMO teleports so the
cause is observed rather than guessed at.
"""
from __future__ import annotations
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import traci
import traci_env as env
from demand import write_routes

NET = HERE / "nets" / "junction4" / "net.net.xml"
ROU = HERE / "nets" / "junction4" / "debug.rou.xml"

write_routes(ROU, demand_vph=900, duration=400, seed=7, ev_arm="S",
             ev_type="ambulance", ev_depart=150.0, loading="heavy_all")
env.start(str(NET), str(ROU), gui=False, seed=7)

tls = traci.trafficlight.getIDList()[0]
plan = env.discover_plan(tls)
ctl = env.SignalController(plan)
jx, jy = traci.junction.getPosition("C")

print("phase plan:", dict(plan.green_to_approach))
print(f"{'t':>5} {'edge':>10} {'lanepos':>8} {'dist':>7} {'spd':>6} {'wait':>6} "
      f"{'faces':>5} {'ctl':>7} {'tp_start':>8} {'tp_end':>7}")

t = 0.0
tp_start = tp_end = 0
crossed_at = None
while t < 320:
    traci.simulationStep()
    t = traci.simulation.getTime()
    ctl.step(env.STEP, t)
    tp_start += traci.simulation.getStartingTeleportNumber()
    tp_end += traci.simulation.getEndingTeleportNumber()
    if "EV" not in traci.vehicle.getIDList():
        continue
    edge = traci.vehicle.getRoadID("EV")
    ev = env.ev_state("EV", (jx, jy))
    nxt = traci.vehicle.getNextTLS("EV")
    faces = nxt[0][3] if nxt else "-"
    if t >= 150:
        print(f"{t:5.0f} {edge:>10} {traci.vehicle.getLanePosition('EV'):8.1f} "
              f"{ev['distance']:7.1f} {ev['speed']:6.2f} "
              f"{traci.vehicle.getAccumulatedWaitingTime('EV'):6.1f} {faces:>5} "
              f"{ctl.state:>7} {tp_start:8d} {tp_end:7d}")
    if edge.startswith("C2") and crossed_at is None:
        crossed_at = t
        print(f"  -> crossed at {t:.0f}s")
        break

print(f"\ntotal teleports: starting={tp_start} ending={tp_end}")
env.close()
