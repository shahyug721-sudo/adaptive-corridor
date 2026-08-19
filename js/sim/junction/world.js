// Four-arm junction: IR sensing, phase control, and emergency preemption.

import {
  JUNCTION, ARMS, VEHICLES, AMBULANCE, TURNS, SIGNAL, TRAFFIC, DEFAULTS,
  IR_TIERS, TIER_NAMES, TIER_GREEN, armPosition, pedCrossTime,
} from './config.js';
import { Rng, idm, Metrics } from '../core.js';

const STOP_LINE = JUNCTION.boxHalf;
const ENTRY = JUNCTION.armLength;

/* ------------------------------------------------------------------ */
/* Sensing                                                             */
/* ------------------------------------------------------------------ */

/**
 * The BE project's IR sensor, reproduced with its real limitations.
 *
 * One infrared beam spans the whole approach at a fixed distance upstream. It
 * reports *interruptions*, and that is a genuinely different quantity from
 * demand in three ways that all matter:
 *
 *   - a motorcycle and a twelve-metre bus are both one interruption, so the
 *     count carries no PCU information at all;
 *   - two vehicles crossing abreast in different lanes break the same beam once,
 *     and Indian traffic is not lane-disciplined, so this happens constantly;
 *   - a stationary queue standing over the beam holds it broken and stops
 *     producing counts precisely when the approach is most congested.
 *
 * The third is the important one. A beam-break counter measures *arrivals*, and
 * when the queue backs past the sensor there are no more arrivals to see. That
 * is why the tier strategy degrades exactly where it is needed.
 */
export class IrSensor {
  constructor(arm) {
    this.arm = arm;
    this.count = 0;
    this.tier = 'loose';
    this.beamBroken = false;
    this.window = [];
    this.truePcu = 0;
    this.missed = 0;
    this.trueCrossings = 0;
    this.crossed = new Set();
  }

  get position() { return STOP_LINE + JUNCTION.irDistance; }

  update(vehicles, t) {
    const p = this.position;
    let broken = false, crossing = 0;
    let truePcu = 0;

    for (const v of vehicles) {
      if (v.arm !== this.arm.id || v.inBox || v.exiting) continue;
      if (v.s < STOP_LINE + 65) truePcu += v.pcu;
      // the beam is broken while any part of a vehicle spans it
      if (v.s - v.len / 2 <= p && v.s + v.len / 2 >= p) {
        broken = true;
        crossing++;
        // ground truth: how many vehicles have actually gone past the beam
        if (!this.crossed.has(v.id)) { this.crossed.add(v.id); this.trueCrossings++; }
      }
    }
    this.truePcu = truePcu;

    // A count is registered on the rising edge only. While the beam stays
    // broken â€” a vehicle alongside, a following vehicle closing up, or a queue
    // standing over the sensor â€” no further counts are produced no matter how
    // many vehicles pass. The gap between trueCrossings and count is the
    // undercount the hardware actually has, and it grows with congestion.
    if (broken && !this.beamBroken) {
      this.count++;
      this.window.push(t);
    }
    this.missed = Math.max(0, this.trueCrossings - this.count);
    this.beamBroken = broken;

    // The project's thresholds are applied to a rolling window rather than a
    // free-running counter. Its own counters only reset in the congested branch,
    // so every approach eventually latches to congested and never recovers â€”
    // a bug, not a design, so it is not reproduced here.
    while (this.window.length && t - this.window[0] > 30) this.window.shift();
    const n = this.window.length;
    this.tier = n < IR_TIERS.loose ? 'loose' : n <= IR_TIERS.moderate ? 'moderate' : 'congested';
    return this.tier;
  }
}

/** A camera counting PCU over the same approach â€” the comparison case. */
export class ApproachCamera {
  constructor(arm) { this.arm = arm; this.pcu = 0; this.queue = 0; }

  update(vehicles) {
    let pcu = 0, queue = 0;
    for (const v of vehicles) {
      if (v.arm !== this.arm.id || v.inBox || v.exiting) continue;
      if (v.s > STOP_LINE + 70) continue;
      pcu += v.pcu;
      if (v.v < 1) queue = Math.max(queue, v.s - STOP_LINE);
    }
    this.pcu = pcu;
    this.queue = queue;
    return pcu;
  }
}

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

export class JunctionWorld {
  constructor(cfg = {}) { this.reset(cfg); }

  reset(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.rng = new Rng(this.cfg.seed);
    this.t = 0;
    this.nextId = 1;
    this.events = [];
    this.vehicles = [];
    this.metrics = new Metrics();
    this.finished = false;

    this.sensors = new Map();
    this.cameras = new Map();
    this.spawnClock = new Map();
    this.lastServed = new Map();
    for (const arm of ARMS) {
      this.sensors.set(arm.id, new IrSensor(arm));
      this.cameras.set(arm.id, new ApproachCamera(arm));
      this.spawnClock.set(arm.id, 0);
      this.lastServed.set(arm.id, 0);
    }

    // phase state
    this.phaseIndex = 0;
    this.state = 'green';          // green | yellow | allRed
    this.phaseT = 0;
    this.greenTarget = SIGNAL.fixedGreen;
    this.preempt = null;
    this.preemptQueue = [];
    this.owed = new Map(ARMS.map(a => [a.id, 0]));
    this.stats = { preemptions: 0, cyclesServed: 0, transitionTime: 0 };

    this.ev = null;
    this.evDispatched = false;

    this.warmup();
  }

  get greenArm() { return ARMS[this.phaseIndex]; }

  log(msg, kind = 'info') {
    this.events.push({ t: this.t, msg, kind });
    if (this.events.length > 100) this.events.shift();
  }

  /** Colour shown to an arm right now. */
  aspect(armId) {
    if (this.state === 'green' && this.greenArm.id === armId) return 'green';
    if (this.state === 'yellow' && this.greenArm.id === armId) return 'yellow';
    return 'red';
  }

  mayGo(armId) {
    return (this.state === 'green' && this.greenArm.id === armId)
      || (this.state === 'yellow' && this.greenArm.id === armId && this.phaseT < SIGNAL.yellow * 0.5);
  }

  warmup() {
    for (let i = 0; i < 1500; i++) this.step(1 / 20, true);
    this.t = 0;
    this.metrics = new Metrics();
    this.events.length = 0;
    for (const v of this.vehicles) { v.enterT = 0; v.stops = 0; v.waited = 0; }
    for (const s of this.sensors.values()) { s.count = 0; s.missed = 0; }
  }

  /* ---------------- vehicles ---------------- */

  makeVehicle(arm, cls) {
    const spec = VEHICLES[cls];
    const r = this.rng.next();
    const turn = r < TURNS.through ? 'through' : r < TURNS.through + TURNS.left ? 'left' : 'right';
    return {
      id: this.nextId++, kind: 'traffic',
      arm: arm.id, cls, spec, turn,
      lane: this.rng.int(JUNCTION.lanes),
      s: ENTRY, v: spec.v0 * 0.7, v0: spec.v0 * this.rng.range(0.85, 1.1),
      len: spec.len, wid: spec.wid, pcu: spec.pcu,
      hue: this.rng.range(0, 360), shade: this.rng.range(0.3, 0.72),
      inBox: false, exiting: false, boxT: 0, exitArm: null,
      x: 0, y: 0, heading: 0,
      enterT: this.t, travelled: 0, stops: 0, stopped: false, waited: 0,
    };
  }

  /** Which arm a vehicle leaves by, given its turn. Left is kerb-side in India. */
  exitArmOf(veh) {
    const i = ARMS.findIndex(a => a.id === veh.arm);
    if (veh.turn === 'through') return ARMS[(i + 2) % 4];
    if (veh.turn === 'left') return ARMS[(i + 1) % 4];
    return ARMS[(i + 3) % 4];
  }

  spawn(dt) {
    for (const arm of ARMS) {
      let clock = this.spawnClock.get(arm.id) - dt;
      if (clock <= 0) {
        const rate = (arm.demand * this.cfg.demand) / 3600;
        clock = -Math.log(1 - this.rng.next()) / Math.max(rate, 1e-4);
        const cls = this.rng.weighted(shares());
        const veh = this.makeVehicle(arm, cls);
        const clash = this.vehicles.some(v => v.arm === arm.id && v.lane === veh.lane && !v.inBox && Math.abs(v.s - ENTRY) < 12);
        if (!clash) this.vehicles.push(veh);
      }
      this.spawnClock.set(arm.id, clock);
    }
  }

  /* ---------------- signal control ---------------- */

  /** Green time this arm has earned, under the configured strategy. */
  greenFor(arm) {
    if (this.cfg.strategy === 'fixed') return SIGNAL.fixedGreen;
    if (this.cfg.strategy === 'tier') return TIER_GREEN[this.sensors.get(arm.id).tier];

    // smart: size the green to discharge the measured queue at saturation flow
    const pcu = this.cfg.sensor === 'camera'
      ? this.cameras.get(arm.id).pcu
      : tierToPcu(this.sensors.get(arm.id).tier);
    const need = SIGNAL.startupLost + pcu / (SIGNAL.satFlowPerLane * JUNCTION.lanes);
    let g = Math.max(SIGNAL.minGreen, Math.min(SIGNAL.maxGreen, need));
    // anti-starvation: an arm passed over for two full cycles gets its minimum
    // back plus whatever it was short-changed, so a quiet approach is never
    // held indefinitely by a permanently busy one.
    g += Math.min(this.owed.get(arm.id) ?? 0, 12);
    return g;
  }

  stepSignal(dt) {
    this.phaseT += dt;

    if (this.preempt) { this.stepPreempt(dt); return; }

    if (this.state === 'green') {
      const arm = this.greenArm;
      if (this.phaseT < SIGNAL.minGreen) return;
      if (this.phaseT >= this.greenTarget) { this.toYellow(); return; }
      // gap-out: nothing left on this approach worth holding green for
      if (this.cfg.strategy === 'smart' && this.approachEmpty(arm)) this.toYellow();
      return;
    }
    if (this.state === 'yellow' && this.phaseT >= SIGNAL.yellow) {
      this.state = 'allRed'; this.phaseT = 0; return;
    }
    if (this.state === 'allRed' && this.phaseT >= SIGNAL.allRed) {
      this.nextPhase();
    }
  }

  approachEmpty(arm) {
    return !this.vehicles.some(v => v.arm === arm.id && !v.inBox && !v.exiting && v.s < STOP_LINE + 45);
  }

  toYellow() { this.state = 'yellow'; this.phaseT = 0; }

  nextPhase() {
    const prev = this.greenArm;
    this.owed.set(prev.id, 0);
    // credit every arm that was skipped, so anti-starvation has something to act on
    for (const arm of ARMS) {
      if (arm.id === prev.id) continue;
      if (this.t - (this.lastServed.get(arm.id) ?? 0) > 120) {
        this.owed.set(arm.id, (this.owed.get(arm.id) ?? 0) + 4);
      }
    }
    this.phaseIndex = (this.phaseIndex + 1) % ARMS.length;
    this.state = 'green';
    this.phaseT = 0;
    this.greenTarget = this.greenFor(this.greenArm);
    this.lastServed.set(this.greenArm.id, this.t);
    this.stats.cyclesServed++;
  }

  /* ---------------- emergency preemption ---------------- */

  /**
   * The mechanism this scenario exists to demonstrate.
   *
   * On detection, every other arm is taken to red and the ambulance's arm is
   * given green. It cannot happen instantly: the arm currently running must be
   * given its yellow and the junction box must be cleared by an all-red before
   * a conflicting movement is released. That transition is a hard floor of
   * yellow + all-red, and if the current green has not yet reached its minimum
   * it must serve that too. Skipping any of it would put the ambulance into a
   * box that still has crossing traffic in it.
   *
   * Once the unit is through, normal cycling resumes from the arm after the one
   * that was interrupted, and the interrupted arm is credited the green it lost.
   */
  requestPreempt(armId, tag) {
    if (this.preempt) return false;
    const interrupted = this.greenArm;
    this.preempt = {
      armId, tag,
      requestedAt: this.t,
      grantedAt: null,
      resumeIndex: (ARMS.findIndex(a => a.id === interrupted.id) + 1) % ARMS.length,
    };
    if (interrupted.id !== armId && this.state === 'green') {
      this.owed.set(interrupted.id, (this.owed.get(interrupted.id) ?? 0) + Math.max(0, this.greenTarget - this.phaseT));
    }
    this.stats.preemptions++;
    this.log(`Ambulance detected on ${armId} â€” all other arms to red`, 'ev');
    return true;
  }

  stepPreempt(dt) {
    const p = this.preempt;
    const target = ARMS.findIndex(a => a.id === p.armId);

    if (p.grantedAt !== null) {
      // holding green for the unit; release once it is clear of the box
      const clear = !this.ev || this.ev.exiting || this.ev.done;
      if (clear && this.t - p.grantedAt > 2) {
        const held = this.t - p.requestedAt;
        this.log(`Ambulance clear â€” normal operation resumes (held ${held.toFixed(1)} s)`, 'ok');
        this.phaseIndex = p.resumeIndex;
        this.state = 'green';
        this.phaseT = 0;
        this.greenTarget = this.greenFor(this.greenArm);
        this.preempt = null;
      }
      return;
    }

    if (this.state === 'green') {
      if (this.phaseIndex === target) {
        p.grantedAt = this.t;
        this.stats.transitionTime = this.t - p.requestedAt;
        this.greenTarget = 999;
        this.log(`${p.armId} green for the ambulance â€” transition took ${this.stats.transitionTime.toFixed(1)} s`, 'ev');
        return;
      }
      // serve the current green's minimum, then clear it down
      if (this.phaseT >= SIGNAL.minGreen) this.toYellow();
      return;
    }
    if (this.state === 'yellow' && this.phaseT >= SIGNAL.yellow) { this.state = 'allRed'; this.phaseT = 0; return; }
    if (this.state === 'allRed' && this.phaseT >= SIGNAL.allRed) {
      // jump straight to the ambulance's arm rather than cycling round to it
      this.phaseIndex = target;
      this.state = 'green';
      this.phaseT = 0;
      p.grantedAt = this.t;
      this.stats.transitionTime = this.t - p.requestedAt;
      this.greenTarget = 999;
      this.lastServed.set(p.armId, this.t);
      this.log(`${p.armId} green for the ambulance â€” transition took ${this.stats.transitionTime.toFixed(1)} s`, 'ev');
    }
  }

  dispatchEv() {
    if (this.evDispatched) return;
    const arm = ARMS.find(a => a.id === this.cfg.evArm) ?? ARMS[3];
    this.ev = {
      id: this.nextId++, kind: 'ev', tag: 'EMS-108', primary: true,
      arm: arm.id, cls: 'ambulance', spec: AMBULANCE, turn: 'through',
      lane: 0, s: ENTRY, v: AMBULANCE.v0 * 0.8, v0: AMBULANCE.v0,
      len: AMBULANCE.len, wid: AMBULANCE.wid, pcu: AMBULANCE.pcu,
      inBox: false, exiting: false, boxT: 0, exitArm: null, done: false,
      x: 0, y: 0, heading: 0,
      dispatchT: this.t, arrivedT: null, detected: false,
      enterT: this.t, travelled: 0, stops: 0, stopped: false, waited: 0,
    };
    this.vehicles.push(this.ev);
    this.evDispatched = true;
    this.log(`EMS-108 approaching on ${arm.name}`, 'ev');
  }

  /* ---------------- dynamics ---------------- */

  step(dt, warmup = false) {
    this.t += dt;
    this.spawn(dt);

    for (const arm of ARMS) {
      this.sensors.get(arm.id).update(this.vehicles, this.t);
      this.cameras.get(arm.id).update(this.vehicles);
    }

    if (!warmup) {
      if (!this.evDispatched && this.t >= this.cfg.evAt) this.dispatchEv();
      if (this.ev && !this.ev.detected && !this.ev.done) {
        const d = this.ev.s - STOP_LINE;
        if (d <= this.cfg.detectRange) {
          this.ev.detected = true;
          if (this.cfg.emergency === 'preempt') this.requestPreempt(this.ev.arm, this.ev.tag);
          else this.log('Ambulance detected â€” no preemption configured, it waits its turn', 'warn');
        }
      }
    }

    this.stepSignal(dt);
    this.stepVehicles(dt);
  }

  stepVehicles(dt) {
    // queue order per (arm, lane), nearest the stop line first
    const groups = new Map();
    for (const v of this.vehicles) {
      if (v.inBox || v.exiting) continue;
      const k = `${v.arm}:${v.lane}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v);
    }
    for (const arr of groups.values()) arr.sort((a, b) => a.s - b.s);

    for (const [, arr] of groups) {
      for (let i = 0; i < arr.length; i++) {
        const veh = arr[i];
        const lead = arr[i - 1];
        let gap = lead ? (veh.s - lead.s) - (veh.len + lead.len) / 2 : 1e4;
        let dv = lead ? veh.v - lead.v : 0;

        const toStop = veh.s - STOP_LINE - veh.len / 2;
        const isEv = veh.kind === 'ev';
        const may = this.mayGo(veh.arm);
        if (!may && toStop > -0.5) {
          const canStop = (veh.v * veh.v) / (2 * veh.spec.b) < toStop + 1.0;
          // An ambulance may edge across a red, but only when the box is empty.
          const boxBusy = this.vehicles.some(o => o.inBox && o.id !== veh.id);
          const yields = isEv ? boxBusy : canStop;
          if (yields && toStop < gap) { gap = Math.max(toStop, -0.5); dv = veh.v; }
          else if (isEv && !boxBusy) { /* creep through */ }
        }

        const s0 = veh.spec.filter ? 0.9 : TRAFFIC.jamGap;
        const v0 = isEv && !may ? Math.min(veh.v0, 4.5) : veh.v0;
        veh.v = Math.max(0, veh.v + idm(veh.v, v0, gap, dv, veh.spec.a, veh.spec.b, s0, TRAFFIC.headway) * dt);
        veh.s -= veh.v * dt;
        veh.travelled += veh.v * dt;

        if (veh.v < 0.4) { veh.waited += dt; if (!veh.stopped) { veh.stopped = true; veh.stops++; } }
        else if (veh.v > 1.5) veh.stopped = false;

        if (veh.s <= STOP_LINE && may) {
          veh.inBox = true;
          veh.boxT = 0;
          veh.exitArm = this.exitArmOf(veh);
        }
        this.place(veh);
      }
    }

    // vehicles traversing the box, then leaving down their exit arm
    for (const veh of this.vehicles) {
      if (!veh.inBox && !veh.exiting) continue;
      const cross = JUNCTION.boxHalf * (veh.turn === 'through' ? 2 : 1.7);
      if (veh.inBox) {
        veh.v = Math.min(veh.v0 * 0.6, veh.v + veh.spec.a * dt);
        veh.boxT += veh.v * dt;
        veh.travelled += veh.v * dt;
        const u = Math.min(1, veh.boxT / cross);
        this.placeInBox(veh, u);
        if (u >= 1) { veh.inBox = false; veh.exiting = true; veh.s = JUNCTION.boxHalf; }
      } else {
        veh.v = Math.min(veh.v0, veh.v + veh.spec.a * dt);
        veh.s += veh.v * dt;
        veh.travelled += veh.v * dt;
        this.placeExit(veh);
      }
    }

    const keep = [];
    for (const veh of this.vehicles) {
      if (veh.exiting && veh.s > ENTRY) {
        if (veh.kind === 'ev') {
          veh.done = true;
          veh.arrivedT = this.t;
          this.finished = true;
          this.log(`EMS-108 cleared the junction â€” ${(this.t - veh.dispatchT).toFixed(1)} s, ${veh.stops} stop${veh.stops === 1 ? '' : 's'}`, 'ok');
        } else {
          this.metrics.depart(veh, this.t);
        }
        continue;
      }
      keep.push(veh);
    }
    this.vehicles = keep;
  }

  place(veh) {
    const arm = ARMS.find(a => a.id === veh.arm);
    const p = armPosition(arm, veh.s, veh.lane);
    veh.x = p.x; veh.y = p.y;
    veh.heading = Math.atan2(-arm.dy, -arm.dx);
  }

  placeInBox(veh, u) {
    const arm = ARMS.find(a => a.id === veh.arm);
    const from = armPosition(arm, JUNCTION.boxHalf, veh.lane);
    const to = armPosition(veh.exitArm, JUNCTION.boxHalf, veh.lane);
    // quadratic bend through the centre so turns look like turns
    const cx = (from.x + to.x) * 0.25, cy = (from.y + to.y) * 0.25;
    const m = 1 - u;
    veh.x = m * m * from.x + 2 * m * u * cx + u * u * to.x;
    veh.y = m * m * from.y + 2 * m * u * cy + u * u * to.y;
    const dx = 2 * m * (cx - from.x) + 2 * u * (to.x - cx);
    const dy = 2 * m * (cy - from.y) + 2 * u * (to.y - cy);
    veh.heading = Math.atan2(dy, dx);
  }

  placeExit(veh) {
    const arm = veh.exitArm;
    // exit lanes are on the far side of the median from the approach lanes
    const p = perpExit(arm, veh.s, veh.lane);
    veh.x = p.x; veh.y = p.y;
    veh.heading = Math.atan2(arm.dy, arm.dx);
  }

  /* ---------------- reporting ---------------- */

  sensorReadings() {
    return ARMS.map(arm => {
      const ir = this.sensors.get(arm.id);
      const cam = this.cameras.get(arm.id);
      return {
        arm: arm.id, name: arm.name,
        tier: ir.tier, count: ir.window.length,
        irMissed: ir.missed,
        truePcu: ir.truePcu, cameraPcu: cam.pcu, queue: cam.queue,
        aspect: this.aspect(arm.id),
        green: this.greenArm.id === arm.id && this.state === 'green',
      };
    });
  }

  summary() {
    const perArm = {};
    for (const arm of ARMS) {
      const ir = this.sensors.get(arm.id);
      perArm[arm.id] = { tier: ir.tier, irCount: ir.count, irMissed: ir.missed };
    }
    return {
      simTime: this.t,
      ev: this.ev && this.ev.arrivedT !== null ? {
        travelTime: this.ev.arrivedT - this.ev.dispatchT,
        stops: this.ev.stops,
        waited: this.ev.waited,
        transition: this.stats.transitionTime,
      } : null,
      delay: this.metrics.mainlineDelay.toJSON(),
      throughput: this.metrics.throughput,
      preemptions: this.stats.preemptions,
      perArm,
      config: { ...this.cfg },
    };
  }
}

/** Exit-side position, mirrored across the median from the approach lanes. */
function perpExit(arm, s, lane) {
  const p = { x: -arm.dy, y: arm.dx };
  const lat = JUNCTION.medianHalf + JUNCTION.laneWidth * (lane + 0.5);
  return { x: arm.dx * s + p.x * lat, y: arm.dy * s + p.y * lat };
}

/** A crude PCU estimate from a density tier â€” all the IR sensor can offer. */
function tierToPcu(tier) {
  return tier === 'loose' ? 3 : tier === 'moderate' ? 10 : 22;
}

let _shares = null;
function shares() {
  if (_shares) return _shares;
  _shares = {};
  for (const k in VEHICLES) _shares[k] = VEHICLES[k].share;
  return _shares;
}

export { ARMS, JUNCTION, pedCrossTime, TIER_NAMES };

