"""TraCI environment: state extraction, safe signal actuation, scenario setup.

This module is the substitution the whole project rests on. Obrusník et al.
(IFAC 2020) obtain emergency-vehicle position and queue state over **V2I radio**;
Roy et al. (arXiv:2605.13814) obtain it from **physical detectors** in Vissim.
We obtain the equivalent state from SUMO/TraCI. No hardware is modelled and none
is required -- but the substitution must be stated wherever the method is
described, because it is an assumption about information availability, not a
free simplification.

SAFETY
------
`SignalController` owns the clearance intervals. No strategy, and no preemption
request, can shorten a yellow or an all-red, or cut a green below its minimum.
This is enforced here rather than trusted to callers, because every controller
in the study writes through this one class and a controller that could skip
clearance would report response times that are unachievable in practice.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from build_nets import sumo_tool  # noqa: E402  (same directory)

import traci  # noqa: E402

HERE = Path(__file__).resolve().parent

YELLOW = 3.0
ALL_RED = 2.0
MIN_GREEN = 8.0
STEP = 1.0            # s of simulated time per TraCI step

# Vehicle classes. PCU factors follow IRC:106-1990 for urban roads.
PCU = {"car": 1.0, "moto": 0.5, "auto": 0.8, "bus": 3.0, "lcv": 2.0}


# ------------------------------------------------------------------ mapping

@dataclass
class PhasePlan:
    """The junction's phase structure, discovered from the network."""

    tls_id: str
    # green phase index -> approach edge id it serves
    green_to_approach: dict[int, str] = field(default_factory=dict)
    approach_to_green: dict[str, int] = field(default_factory=dict)
    n_phases: int = 0

    def yellow_of(self, green_idx: int) -> int:
        return green_idx + 1

    def allred_of(self, green_idx: int) -> int:
        return green_idx + 2


def discover_plan(tls_id: str) -> PhasePlan:
    """Work out which phase serves which approach, by reading the link topology.

    Hard-coding "phase 0 is north" is the classic way this breaks: netconvert
    chooses the link ordering, and it changes if the geometry or the netconvert
    version changes. Deriving it means the controller keeps working when the
    network is rebuilt.
    """
    logic = traci.trafficlight.getAllProgramLogics(tls_id)[0]
    links = traci.trafficlight.getControlledLinks(tls_id)
    plan = PhasePlan(tls_id=tls_id, n_phases=len(logic.phases))

    for idx, phase in enumerate(logic.phases):
        state = phase.state
        if "G" not in state and "g" not in state:
            continue
        approaches = set()
        for link_i, ch in enumerate(state):
            if ch not in "Gg":
                continue
            if link_i < len(links) and links[link_i]:
                from_lane = links[link_i][0][0]
                approaches.add(from_lane.rsplit("_", 1)[0])
        if len(approaches) != 1:
            raise RuntimeError(
                f"phase {idx} of {tls_id} serves {len(approaches)} approaches "
                f"({sorted(approaches)}). This module assumes one arm at a time; "
                f"rebuild the network with --tls.layout incoming."
            )
        edge = approaches.pop()
        plan.green_to_approach[idx] = edge
        plan.approach_to_green[edge] = idx
    return plan


# ------------------------------------------------------------------ control

class SignalController:
    """Drives one traffic light, and owns the clearance intervals."""

    def __init__(self, plan: PhasePlan, green_duration: float = 25.0):
        self.plan = plan
        # Background green time, used when the caller does not name a successor
        # phase. Without it the controller has no reason to ever leave its first
        # green and the junction silently stops cycling -- which is exactly what
        # happened before this parameter existed, and it made every clearance
        # assertion pass on an empty list.
        self.green_duration = green_duration
        self.greens = sorted(plan.green_to_approach)
        self.current = self.greens[0]
        self.state = "green"           # green | yellow | allred
        self.elapsed = 0.0
        self.target_green: int | None = None
        self.preempt_arm: str | None = None
        self.preempt_since: float | None = None
        self.transition_time: float | None = None
        self.log: list[tuple[float, str]] = []
        traci.trafficlight.setPhase(plan.tls_id, self.current)
        traci.trafficlight.setPhaseDuration(plan.tls_id, 1e6)

    # -- queries -------------------------------------------------------

    @property
    def served_approach(self) -> str:
        return self.plan.green_to_approach[self.current]

    def aspect(self, approach: str) -> str:
        if self.plan.approach_to_green.get(approach) != self.current:
            return "red"
        return {"green": "green", "yellow": "yellow", "allred": "red"}[self.state]

    def time_to_green(self, approach: str) -> float:
        """Earliest legal time from now at which `approach` can show green.

        This is the number a preemption scheduler must plan against. It is not
        "switch immediately": the running arm still owes its minimum green, its
        yellow, and the all-red that clears the box.
        """
        target = self.plan.approach_to_green.get(approach)
        if target is None:
            return float("inf")
        if target == self.current and self.state == "green":
            return 0.0
        if self.state == "green":
            return max(0.0, MIN_GREEN - self.elapsed) + YELLOW + ALL_RED
        if self.state == "yellow":
            return max(0.0, YELLOW - self.elapsed) + ALL_RED
        return max(0.0, ALL_RED - self.elapsed)

    # -- commands ------------------------------------------------------

    def request_preempt(self, approach: str, t: float) -> bool:
        if self.preempt_arm is not None:
            return False
        if approach not in self.plan.approach_to_green:
            return False
        self.preempt_arm = approach
        self.preempt_since = t
        self.target_green = self.plan.approach_to_green[approach]
        self.log.append((t, f"preempt requested for {approach}"))
        return True

    def release_preempt(self, t: float) -> None:
        if self.preempt_arm is None:
            return
        self.log.append((t, f"preempt released for {self.preempt_arm}"))
        self.preempt_arm = None
        self.preempt_since = None
        self.target_green = None

    def step(self, dt: float, t: float, next_green: int | None = None) -> None:
        """Advance the phase machine by `dt`.

        `next_green` is the phase the *background* plan would like to serve next;
        it is ignored while a preemption is active.
        """
        self.elapsed += dt

        if self.state == "yellow":
            if self.elapsed >= YELLOW:
                self._enter("allred", self.plan.allred_of(self.current), t)
            return
        if self.state == "allred":
            if self.elapsed >= ALL_RED:
                nxt = self.target_green
                if nxt is None:
                    nxt = next_green if next_green is not None else self._cycle_next()
                self.current = nxt
                self._enter("green", nxt, t)
                if self.preempt_arm is not None and self.transition_time is None:
                    self.transition_time = t - (self.preempt_since or t)
                    self.log.append(
                        (t, f"{self.preempt_arm} green for EV after "
                            f"{self.transition_time:.1f}s transition")
                    )
            return

        # green
        if self.preempt_arm is not None:
            if self.current == self.target_green:
                if self.transition_time is None:
                    self.transition_time = t - (self.preempt_since or t)
                return                       # hold green for the unit
            if self.elapsed >= MIN_GREEN:     # clear the running arm down
                self._enter("yellow", self.plan.yellow_of(self.current), t)
            return

        if self.elapsed < MIN_GREEN:
            return
        wants_change = next_green is not None and next_green != self.current
        if wants_change or self.elapsed >= self.green_duration:
            self._enter("yellow", self.plan.yellow_of(self.current), t)

    def _cycle_next(self) -> int:
        i = self.greens.index(self.current) if self.current in self.greens else -1
        return self.greens[(i + 1) % len(self.greens)]

    def _enter(self, state: str, phase_idx: int, t: float) -> None:
        self.state = state
        self.elapsed = 0.0
        traci.trafficlight.setPhase(self.plan.tls_id, phase_idx)
        traci.trafficlight.setPhaseDuration(self.plan.tls_id, 1e6)


# ------------------------------------------------------------------ state

def approach_state(edge: str) -> dict:
    """Everything observable about one approach. This is the leakage boundary."""
    n = traci.edge.getLastStepVehicleNumber(edge)
    halting = traci.edge.getLastStepHaltingNumber(edge)
    mean_speed = traci.edge.getLastStepMeanSpeed(edge)
    occupancy = traci.edge.getLastStepOccupancy(edge)
    pcu = 0.0
    for vid in traci.edge.getLastStepVehicleIDs(edge):
        vtype = traci.vehicle.getTypeID(vid)
        pcu += PCU.get(vtype.split("@")[0], 1.0)
    return {
        "vehicles": n,
        "halting": halting,
        "queue_pcu": pcu,
        "mean_speed": mean_speed,
        "occupancy": occupancy,
    }


def ev_state(ev_id: str, junction_pos: tuple[float, float]) -> dict | None:
    """Emergency-vehicle state: the TraCI substitute for a V2I feed."""
    if ev_id not in traci.vehicle.getIDList():
        return None
    x, y = traci.vehicle.getPosition(ev_id)
    speed = traci.vehicle.getSpeed(ev_id)
    jx, jy = junction_pos
    dist = ((x - jx) ** 2 + (y - jy) ** 2) ** 0.5
    return {
        "edge": traci.vehicle.getRoadID(ev_id),
        "x": x, "y": y,
        "speed": speed,
        "distance": dist,
        # ETA on current speed. Deliberately naive: a smarter estimate would
        # need the queue ahead, which is exactly what the controller is being
        # asked to reason about. Giving it a pre-solved ETA would leak.
        "eta": dist / max(speed, 0.5),
    }


# ------------------------------------------------------------------ session

def start(net: str, route: str, gui: bool = False, seed: int = 1,
          step_length: float = STEP, extra: list[str] | None = None) -> None:
    binary = sumo_tool("sumo-gui" if gui else "sumo")
    cmd = [
        binary,
        "-n", net,
        "-r", route,
        "--step-length", str(step_length),
        "--seed", str(seed),
        "--no-step-log", "true",
        "--no-warnings", "true",
        # Teleports must be off, and "--time-to-teleport -1" alone is not
        # enough. SUMO's default --collision.action is *teleport*, so a single
        # rear-end shunt relocates the vehicle downstream. That is catastrophic
        # here: the first version of this file lost the ambulance out of a
        # standing queue and past the junction in one step, which erased exactly
        # the delay the experiment exists to measure and made preemption look
        # worth 0%. Any teleport invalidates a run, so they are disabled on
        # every trigger and counted as an assertion.
        "--time-to-teleport", "-1",
        "--time-to-teleport.disconnected", "-1",
        "--collision.action", "warn",
        "--collision.check-junctions", "true",
        # Belt and braces: abort rather than continue if any teleport trigger
        # fires that the options above have not covered. An aborted run is
        # obvious; a silently teleported ambulance is not.
        "--max-num-teleports", "0",
        "--waiting-time-memory", "10000",
    ]
    if gui:
        cmd += ["--start", "true", "--quit-on-end", "true"]
    if extra:
        cmd += extra
    traci.start(cmd)


def close() -> None:
    try:
        traci.close()
    except Exception:
        pass
