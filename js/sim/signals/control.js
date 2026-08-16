// Signal control: one safety-critical state machine, four strategies that
// decide only *when a green may end*, and a corridor coordinator that lets the
// junctions agree on a plan instead of each guessing alone.
//
// The state machine owns yellow, all-red and the pedestrian minimum. No
// strategy and no emergency request can shorten those. A preemption that drops
// a green straight to red is not certifiable, and a model that allows it would
// report response times that could never be achieved.

import { ART, SIGNAL, TRAFFIC, JUNCTIONS, crossFloor, pedMinGreen } from './config.js';

const CLEARANCE = { ART_Y: SIGNAL.yellow, AR_A: SIGNAL.allRed, CROSS_Y: SIGNAL.yellow, AR_C: SIGNAL.allRed };
const NEXT = { ART_G: 'ART_Y', ART_Y: 'AR_A', AR_A: 'CROSS_G', CROSS_G: 'CROSS_Y', CROSS_Y: 'AR_C', AR_C: 'ART_G' };
const GREEN_OF = { art: 'ART_G', cross: 'CROSS_G' };

/* ------------------------------------------------------------------ */
/* Webster                                                             */
/* ------------------------------------------------------------------ */

/**
 * Webster's optimum cycle:  C = (1.5L + 5) / (1 - Y)
 * L is total lost time per cycle, Y the sum of critical flow ratios.
 * Flows are PCU/hour for the whole approach group.
 */
export function websterPlan(artFlow, crossFlow) {
  const satArt = TRAFFIC.satFlowPerLane * 3600 * ART.lanes;
  const satCross = TRAFFIC.satFlowPerLane * 3600 * ART.crossLanes;
  const yArt = artFlow / satArt;
  const yCross = crossFlow / satCross;
  const Y = Math.min(0.88, yArt + yCross);
  const L = 2 * (SIGNAL.yellow + SIGNAL.allRed) + 2 * TRAFFIC.startupLost;
  const cycle = Math.min(150, Math.max(60, (1.5 * L + 5) / (1 - Y)));
  const effective = cycle - L;
  let crossGreen = Math.max(crossFloor(), (yCross / Y) * effective);
  let artGreen = Math.max(SIGNAL.minGreenArterial, effective - crossGreen);
  return { cycle: artGreen + crossGreen + L, artGreen, crossGreen, offset: 0, Y, yArt, yCross, lost: L };
}

/* ------------------------------------------------------------------ */
/* Junction signal                                                     */
/* ------------------------------------------------------------------ */

export class JunctionSignal {
  constructor(junction, plan) {
    this.j = junction;
    this.plan = plan;
    this.phase = 'ART_G';
    this.t = 0;
    this.greenTarget = plan.artGreen;
    this.preempt = null;
    this.owedCross = 0;
    this.recovering = false;
    this.preemptCount = 0;
    this.spuriousCount = 0;
    this.cyclesServed = 0;
  }

  mayGo(road) {
    if (road === 'art') return this.phase === 'ART_G' || (this.phase === 'ART_Y' && this.t < SIGNAL.yellow * 0.5);
    return this.phase === 'CROSS_G' || (this.phase === 'CROSS_Y' && this.t < SIGNAL.yellow * 0.5);
  }

  aspect(road) {
    const g = GREEN_OF[road], y = road === 'art' ? 'ART_Y' : 'CROSS_Y';
    if (this.phase === g) return 'green';
    if (this.phase === y) return 'yellow';
    return 'red';
  }

  /**
   * Earliest legal time from now at which `road` can be green, honouring the
   * pedestrian minimum and both clearance intervals. This is the number the
   * corridor engine schedules against — it is why a preemption request cannot
   * simply be issued at the last second.
   */
  timeToGreen(road) {
    const want = GREEN_OF[road];
    if (this.phase === want) return 0;
    let t = 0, phase = this.phase, first = true;
    for (let guard = 0; guard < 8; guard++) {
      if (phase === want) return t;
      if (CLEARANCE[phase] !== undefined) t += CLEARANCE[phase] - (first ? this.t : 0);
      else t += Math.max(0, (phase === 'ART_G' ? SIGNAL.minGreenArterial : crossFloor()) - (first ? this.t : 0));
      first = false;
      let next = NEXT[phase];
      if ((next === 'ART_G' || next === 'CROSS_G') && next !== want && this.preempt) next = want;
      phase = next;
    }
    return t;
  }

  /**
   * Predicted transition time if green were needed in `eta` seconds.
   *
   * The engine cannot use timeToGreen() for this: that answers "how long from
   * now", and a junction on arterial green right now may well be mid-cross-green
   * by the time the ambulance arrives. Because coordinated junctions share one
   * background cycle and a known offset, the engine can work out which phase
   * will be running at the arrival instant and schedule against that.
   */
  predictTransition(road, t, eta) {
    const C = this.plan.cycle;
    const pos = ((((t + eta) - this.plan.offset) % C) + C) % C;
    const artWindow = C - (this.plan.crossGreen + 2 * (SIGNAL.yellow + SIGNAL.allRed));
    const artGreenThen = pos < artWindow;
    const worst = crossFloor() + SIGNAL.yellow + SIGNAL.allRed;
    if (road === 'art') return artGreenThen ? SIGNAL.yellow : worst;
    return artGreenThen ? SIGNAL.minGreenArterial + SIGNAL.yellow + SIGNAL.allRed : SIGNAL.yellow;
  }

  requestPreempt(tag, road, t) {
    if (this.preempt) return false;
    this.preempt = { tag, road, since: t };
    this.preemptCount++;
    return true;
  }

  releasePreempt() {
    if (!this.preempt) return;
    this.preempt = null;
    this.recovering = this.owedCross > 0.5;
  }

  step(dt, t, strategy, cams) {
    this.t += dt;
    if (this.preempt) { this.stepPreempted(t, strategy, cams); return; }
    if (CLEARANCE[this.phase] !== undefined) {
      if (this.t >= CLEARANCE[this.phase]) this.advance(t, strategy, cams);
      return;
    }
    if (strategy.shouldEnd(this, cams, t)) this.advance(t, strategy, cams);
  }

  stepPreempted(t, strategy, cams) {
    const want = GREEN_OF[this.preempt.road];
    if (this.phase === want) return;
    if (CLEARANCE[this.phase] !== undefined) {
      if (this.t >= CLEARANCE[this.phase]) this.advance(t, strategy, cams);
      return;
    }
    // We are in the other green. Truncate it — but never below its minimum.
    const floor = this.phase === 'ART_G' ? SIGNAL.minGreenArterial : crossFloor();
    if (this.t >= floor) {
      if (this.phase === 'CROSS_G') this.owedCross += Math.max(0, this.greenTarget - this.t);
      this.advance(t, strategy, cams);
    }
  }

  advance(t, strategy, cams) {
    let next = NEXT[this.phase];
    if (this.preempt) {
      const want = GREEN_OF[this.preempt.road];
      if ((next === 'ART_G' || next === 'CROSS_G') && next !== want) next = want;
    }
    this.phase = next;
    this.t = 0;
    if (next === 'ART_G') { this.greenTarget = strategy.greenFor(this, 'art', cams, t); this.cyclesServed++; }
    if (next === 'CROSS_G') {
      let g = strategy.greenFor(this, 'cross', cams, t);
      // Repay the cross street the green a preemption took from it, rather than
      // simply resuming the plan and pretending nothing happened.
      if (this.recovering && this.owedCross > 0) {
        const repay = Math.min(this.owedCross, 22);
        g += repay;
        this.owedCross -= repay;
        if (this.owedCross <= 0.5) this.recovering = false;
      }
      this.greenTarget = Math.min(g, SIGNAL.maxGreenCross + 24);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Strategies                                                          */
/* ------------------------------------------------------------------ */

export class FixedTime {
  constructor(name) { this.name = name; }
  greenFor(sig, which) { return which === 'art' ? sig.plan.artGreen : sig.plan.crossGreen; }
  shouldEnd(sig) { return sig.t >= sig.greenTarget; }
}

/**
 * Vehicle-actuated control at a single junction, with no reference to what any
 * other junction is doing. Gap-out when the served approach empties, hand over
 * when the waiting side is clearly busier.
 */
export class Isolated {
  constructor() { this.name = 'isolated'; }
  greenFor(sig, which) { return which === 'art' ? SIGNAL.minGreenArterial : crossFloor(); }

  shouldEnd(sig, cams) {
    const served = sig.phase === 'ART_G' ? 'art' : 'cross';
    const minG = served === 'art' ? SIGNAL.minGreenArterial : crossFloor();
    const maxG = served === 'art' ? SIGNAL.maxGreenArterial : SIGNAL.maxGreenCross;
    if (sig.t < minG) return false;
    if (sig.t >= maxG) return true;
    const servedPcu = cams.demand(sig.j.id, served);
    const waitingPcu = cams.demand(sig.j.id, served === 'art' ? 'cross' : 'art');
    if (servedPcu < 1.2) return true;                                  // gap-out
    const lanesServed = served === 'art' ? ART.lanes * 2 : ART.crossLanes * 2;
    const lanesWaiting = served === 'art' ? ART.crossLanes * 2 : ART.lanes * 2;
    return (waitingPcu / lanesWaiting) > (servedPcu / lanesServed) * 1.35;
  }
}

/**
 * Coordinated-actuated control — what a real urban ATCS (SCATS, SCOOT, and the
 * ATCS deployments in Indian cities) does.
 *
 * The split floats with measured demand, but the arterial green always ends at
 * the same point in a common background cycle — the *yield point*. That is what
 * preserves the green band. Without it, a locally optimal controller releases
 * every platoon out of phase with the next junction and ends up slower overall,
 * which is exactly what the `isolated` arm demonstrates.
 */
export class SmartCoordinated {
  constructor() { this.name = 'smart'; }

  greenFor(sig, which, cams) {
    return which === 'art' ? SIGNAL.minGreenArterial : this.crossSplit(sig, cams);
  }

  /** Cross split from the online degree of saturation y = q / s. */
  crossSplit(sig, cams) {
    const effective = sig.plan.cycle - sig.plan.lost;
    const yArt = cams.flow(sig.j.id, 'art') / (TRAFFIC.satFlowPerLane * ART.lanes * 2);
    const yCross = cams.flow(sig.j.id, 'cross') / (TRAFFIC.satFlowPerLane * ART.crossLanes * 2);
    const share = yCross / Math.max(yArt + yCross, 1e-3);
    return Math.min(SIGNAL.maxGreenCross, Math.max(crossFloor(), share * effective));
  }

  shouldEnd(sig, cams, t) {
    const C = sig.plan.cycle;
    const pos = (((t - sig.plan.offset) % C) + C) % C;
    if (sig.phase === 'ART_G') {
      if (sig.t < SIGNAL.minGreenArterial) return false;
      if (sig.t >= SIGNAL.maxGreenArterial) return true;
      if (cams.demand(sig.j.id, 'cross') < 0.8) return false;          // nobody waiting
      const yieldPoint = C - (this.crossSplit(sig, cams) + 2 * (SIGNAL.yellow + SIGNAL.allRed));
      return pos >= yieldPoint;
    }
    if (sig.t < crossFloor()) return false;
    if (sig.t >= sig.greenTarget) return true;
    return cams.demand(sig.j.id, 'cross') < 1.2;                       // early gap-out
  }
}

export function makeStrategy(name) {
  if (name === 'isolated') return new Isolated();
  if (name === 'smart') return new SmartCoordinated();
  return new FixedTime(name);
}

/* ------------------------------------------------------------------ */
/* Corridor coordinator                                                */
/* ------------------------------------------------------------------ */

/**
 * The piece that makes the junctions a *system* rather than six independent
 * controllers. Once per cycle it:
 *
 *   1. asks every junction what it is actually seeing (measured PCU/s per road);
 *   2. finds the **critical junction** — the one with the highest sum of flow
 *      ratios — and derives one common cycle length from it, because a
 *      coordinated arterial can only run at the cycle its worst junction needs;
 *   3. gives every junction its own split from its own demand, so a quiet cross
 *      street does not get the busy one's timing;
 *   4. re-cuts the offsets from the platoon speed actually being achieved, not
 *      the design speed — congested links progress slower, and an offset plan
 *      built on a design-speed assumption drifts out of band exactly when it is
 *      needed most.
 *
 * Recomputing every cycle rather than continuously matters: signal plans that
 * change mid-cycle strand platoons, and drivers stop trusting the corridor.
 */
export class CorridorCoordinator {
  constructor(strategyName, signals, cams, log) {
    this.strategyName = strategyName;
    this.signals = signals;
    this.cams = cams;
    this.log = log ?? (() => {});
    this.cycle = 0;
    this.critical = null;
    this.measuredSpeed = TRAFFIC.progressionSpeed;
    this.nextReview = 20;
    this.reviews = 0;
  }

  get coordinates() { return this.strategyName === 'smart' || this.strategyName === 'coordinated'; }

  update(t, world) {
    if (this.strategyName !== 'smart') return;
    if (t < this.nextReview) return;
    this.nextReview = t + Math.max(45, this.cycle);
    this.reviews++;

    // 1-2. one cycle from the critical junction
    let worstY = 0, critical = null;
    const demands = new Map();
    for (const j of JUNCTIONS) {
      const artFlow = this.cams.flow(j.id, 'art') * 3600;
      const crossFlow = this.cams.flow(j.id, 'cross') * 3600;
      const plan = websterPlan(Math.max(artFlow, 200), Math.max(crossFlow, 120));
      demands.set(j.id, { artFlow, crossFlow, plan });
      if (plan.Y > worstY) { worstY = plan.Y; critical = j; }
    }
    if (!critical) return;
    this.critical = critical;
    // Webster's formula grows without bound as Y approaches 1, and a saturated
    // junction will happily ask for a 150 s cycle. Long cycles raise delay for
    // everyone and are not run in practice — IRC guidance keeps urban arterials
    // at or below about 120 s — so the corridor caps it and lets the critical
    // junction stay slightly oversaturated instead.
    const common = Math.min(120, demands.get(critical.id).plan.cycle);
    this.cycle = common;

    // 3. per-junction splits at the common cycle
    for (const j of JUNCTIONS) {
      const sig = this.signals.get(j.id);
      const { plan } = demands.get(j.id);
      const effective = common - plan.lost;
      const total = plan.artGreen + plan.crossGreen;
      const crossGreen = Math.max(crossFloor(), (plan.crossGreen / total) * effective);
      const artGreen = Math.max(SIGNAL.minGreenArterial, effective - crossGreen);
      sig.plan = { ...plan, cycle: common, artGreen, crossGreen, offset: sig.plan.offset };
    }

    // 4. offsets from the speed platoons are actually achieving
    this.measuredSpeed = world.platoonSpeed() || TRAFFIC.progressionSpeed;
    for (const j of JUNCTIONS) {
      const sig = this.signals.get(j.id);
      sig.plan.offset = (((j.x / this.measuredSpeed) % common) + common) % common;
    }

    this.log(
      `Coordination review ${this.reviews}: critical ${critical.id} (Y=${worstY.toFixed(2)}), ` +
      `cycle ${common.toFixed(0)} s, offsets re-cut for ${(this.measuredSpeed * 3.6).toFixed(0)} km/h`,
      'info',
    );
  }
}

/** Static offsets for the fixed coordinated baseline. */
export function progressionOffsets(plans, speed = TRAFFIC.progressionSpeed) {
  return JUNCTIONS.map((j, i) => {
    const c = plans[i].cycle;
    return (((j.x / speed) % c) + c) % c;
  });
}

export { pedMinGreen };
