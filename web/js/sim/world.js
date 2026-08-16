// The Samruddhi Mahamarg simulation.
//
// No signals, no junctions, no pedestrians — and therefore none of the levers an
// urban corridor engine pulls. What is left is lane discipline at 100 km/h, and
// an ambulance whose path is reserved on paper but not in practice. The result
// hinges on one thing: how much warning a driver illegally occupying the
// emergency lane gets before the unit arrives behind them.
//
// Fixed timestep, seeded, and identical whether it is driving the 3D view at
// 60 fps or being run a thousand times headless by the experiment runner. The
// renderer only ever reads this state.

import {
  EXP, VEHICLES, AMBULANCE, ROUTE, DEFAULTS, WEATHER, EMERGENCY_LANE,
  gantryPositions, laneY, laneLimit, allowedLanes, preferredLane, freeFlowTime, LANE_LIMIT,
} from './config.js';
import { Rng, idm, gapTo, buildLaneArrays, neighbours, Metrics } from './core.js';
import { Gantry, GreenZoneController } from './greenzone.js';

const ENTRY = -220;
const EXIT = EXP.length + 260;
const DESIGN_FLOW = 2400;      // PCU/h per direction at demand = 1.0
const MERGE_SAFETY = -2.6;     // m/s^2, hardest braking a merge may impose

export class World {
  constructor(cfg = {}) { this.reset(cfg); }

  reset(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.rng = new Rng(this.cfg.seed);
    this.nextId = 1;
    this.t = 0;
    this.events = [];
    this.vehicles = [];
    this.units = [];
    this.metrics = new Metrics();
    this.freeFlow = freeFlowTime();
    this.gantries = gantryPositions().map(g => new Gantry(g));
    this.zone = new GreenZoneController(this.cfg.greenZone, this.gantries, (m, k) => this.log(m, k));
    this.finished = false;
    this._spawn = { 1: 0, '-1': 0 };
    this.laneArrays = new Map();
    this.seedTraffic();
  }

  log(msg, kind = 'info') {
    this.events.push({ t: this.t, msg, kind });
    if (this.events.length > 120) this.events.shift();
  }

  /* ---------------- construction ---------------- */

  makeVehicle(x, dir, cls) {
    const spec = VEHICLES[cls];
    const v0 = spec.v0 * this.rng.range(0.86, 1.08);
    const ded = this.cfg.dedicatedLane;
    const lane = preferredLane(spec, v0, ded);
    return {
      id: this.nextId++, kind: 'traffic',
      cls, spec, dir, lane,
      x, y: laneY(dir, lane),
      v: Math.min(v0, laneLimit(lane, ded)) * 0.92,
      v0,
      len: spec.len, wid: spec.wid, pcu: spec.pcu,
      hue: this.rng.range(0, 360), shade: this.rng.range(0.3, 0.75),
      disciplined: !this.rng.chance(this.cfg.encroachment),
      heedsGantry: this.rng.chance(this.cfg.compliance),
      ordered: false, orderT: 0, reaction: 0, vslApplied: false,
      encroachedAt: -1, dwell: 0, mergeTries: 0,
      laneCooldown: this.rng.range(0, 6),
      enterT: 0, enterPos: x, stops: 0, stopped: false, waited: 0,
    };
  }

  seedTraffic() {
    const target = Math.round(this.cfg.demand * 100);
    for (const dir of [1, -1]) {
      for (let i = 0; i < target; i++) {
        const x = this.rng.range(ENTRY, EXIT);
        const veh = this.makeVehicle(x, dir, this.rng.weighted(shareTable()));
        if (this.vehicles.some(o => o.dir === dir && o.lane === veh.lane && Math.abs(o.x - x) < 30)) continue;
        this.vehicles.push(veh);
      }
    }
    // Let the fleet settle into its lanes before anything is measured.
    for (let i = 0; i < 1200; i++) this.step(1 / 15, true);
    this.t = 0;
    this.metrics = new Metrics();
    this.events.length = 0;
    for (const g of this.gantries) { g.violations = 0; g.seen.clear(); }
    for (const v of this.vehicles) { v.enterT = 0; v.enterPos = v.x; v.stops = 0; v.waited = 0; }
  }

  dispatch() {
    if (this.units.length) return;
    const ev = {
      id: this.nextId++, kind: 'ev', tag: 'EMS-108',
      cls: 'ambulance', spec: AMBULANCE,
      dir: 1, lane: EMERGENCY_LANE,
      x: ROUTE.postX, y: laneY(1, EMERGENCY_LANE),
      v: 0, v0: AMBULANCE.v0,
      len: AMBULANCE.len, wid: AMBULANCE.wid, pcu: AMBULANCE.pcu,
      dispatchT: this.t,
      routeLength: ROUTE.incidentX - ROUTE.postX,
      corridorT: null, arrived: false,
      stops: 0, stopped: false, waited: 0, slowdowns: 0, wasSlow: false,
      blockedBy: null,
    };
    this.units.push(ev);
    this.log(`${ev.tag} responding from ${ROUTE.postName} to ${ROUTE.incidentName} — ${(ev.routeLength / 1000).toFixed(1)} km`, 'ev');
  }

  /* ---------------- step ---------------- */

  step(dt, warmup = false) {
    this.t += dt;
    this.spawn(dt);
    this.laneArrays = buildLaneArrays(this.vehicles);
    if (!warmup) this.zone.update(dt, this.t, this.units[0], this.vehicles, this.cfg, this.rng);
    this.stepTraffic(dt, warmup);
    if (!warmup) this.stepUnit(dt);
  }

  spawn(dt) {
    const perDir = (DESIGN_FLOW * this.cfg.demand) / 3600 / 1.5;
    for (const dir of [1, -1]) {
      this._spawn[dir] -= dt;
      if (this._spawn[dir] > 0) continue;
      this._spawn[dir] = -Math.log(1 - this.rng.next()) / Math.max(perDir, 1e-4);
      const x0 = dir > 0 ? ENTRY : EXIT;
      const veh = this.makeVehicle(x0, dir, this.rng.weighted(shareTable()));
      const arr = this.laneArrays.get(`${dir}:${veh.lane}`) ?? [];
      const tail = arr[arr.length - 1];
      if (tail && (tail.x - x0) * dir < 45) continue;
      veh.enterT = this.t; veh.enterPos = x0;
      this.vehicles.push(veh);
    }
  }

  stepTraffic(dt, warmup) {
    const w = WEATHER[this.cfg.weather] ?? WEATHER.clear;

    for (const [key, arr] of this.laneArrays) {
      const dir = key.startsWith('1') ? 1 : -1;
      for (let i = 0; i < arr.length; i++) {
        const veh = arr[i];
        const lead = arr[i - 1];
        veh.laneCooldown = Math.max(0, veh.laneCooldown - dt);

        const gap = lead ? gapTo(veh, lead) : 1e4;
        const dv = lead ? veh.v - lead.v : 0;

        let v0 = Math.min(veh.v0, this.limitFor(veh)) * w.vmax;
        if (this.cfg.fog && veh.x > EXP.fogFrom && veh.x < EXP.fogTo) v0 = Math.min(v0, 19.5);

        veh.v = Math.max(0, veh.v + idm(veh.v, v0, gap, dv, veh.spec.a, veh.spec.b) * dt);
        veh.x += veh.v * dir * dt;
        veh.y = laneY(dir, veh.lane);

        if (veh.v < 1.0) { veh.waited += dt; if (!veh.stopped) { veh.stopped = true; veh.stops++; } }
        else if (veh.v > 4) veh.stopped = false;
      }
    }

    if (!warmup) this.updateLaneDiscipline(dt);
    for (const veh of this.vehicles) this.tryLaneChange(veh);

    const keep = [];
    for (const veh of this.vehicles) {
      const out = veh.dir > 0 ? veh.x > EXIT : veh.x < ENTRY;
      if (out) this.metrics.depart(veh, this.t);
      else keep.push(veh);
    }
    this.vehicles = keep;
  }

  /** Lane limit, overridden by the variable limit on the last gantry passed. */
  limitFor(veh) {
    let limit = laneLimit(veh.lane, this.cfg.dedicatedLane);
    let best = null, bestD = Infinity;
    for (const g of this.gantries) {
      const d = (veh.x - g.x) * veh.dir;
      if (d >= 0 && d < bestD) { bestD = d; best = g; }
    }
    if (best && bestD < EXP.gantrySpacing) limit = Math.min(limit, best.vsl[veh.lane]);
    return limit;
  }

  /**
   * Who ends up in the reserved lane, and why they leave it.
   *
   * Encroachment is a hazard rate rather than a trigger, because that is how it
   * behaves: a driver beside a conspicuously empty lane drifts into it sooner or
   * later, and sooner if something slow is in front of them. An "only when
   * blocked" rule produced almost no encroachment at all, which is not what the
   * lane would look like in practice.
   *
   * This applies to heavy vehicles too, and that is the case that matters. A car
   * in the corridor is doing 105 and costs the ambulance a few seconds; a truck
   * sits there at 80 and costs it forty. It is also the encroachment most often
   * photographed on the real Samruddhi.
   */
  updateLaneDiscipline(dt) {
    const ded = this.cfg.dedicatedLane;
    const unit = this.units[0];
    for (const veh of this.vehicles) {
      const floor = ded ? (veh.spec.heavy ? 2 : 1) : (veh.spec.heavy ? 1 : 0);

      if (!veh.disciplined && veh.lane > 0 && veh.lane - 1 < floor && veh.laneCooldown <= 0) {
        const target = veh.lane - 1;
        const warned = this.zone.active && veh.x > this.zone.start - 250 && veh.x < this.zone.end;
        if (!warned && this.laneClear(veh, target, veh.spec.heavy ? 130 : 90)) {
          const { lead } = neighbours(this.laneArrays, veh, veh.lane);
          const held = lead && gapTo(veh, lead) < (veh.spec.heavy ? 110 : 70);
          const impatient = veh.v0 > laneLimit(veh.lane, ded) * 1.02;
          const rate = (held ? 0.09 : 0.012) + (impatient ? 0.035 : 0);
          if (this.rng.chance(rate * dt)) {
            veh.lane = target;
            veh.encroachedAt = this.t;
            veh.dwell = veh.spec.heavy ? this.rng.range(45, 140) : this.rng.range(14, 55);
            veh.laneCooldown = this.rng.range(3, 7);
          }
        }
      }

      if (veh.lane >= floor) { veh.ordered = false; continue; }

      // Encroachers drift back out after overtaking, so the lane carries a
      // rolling population rather than silting up permanently.
      if (!veh.ordered && veh.encroachedAt >= 0 && this.t - veh.encroachedAt > veh.dwell) {
        veh.ordered = true; veh.orderT = this.t; veh.reaction = 0;
      }

      // Reacting to the unit directly — mirror and siren, gantry or no gantry.
      // The closing speed is only a few m/s so the unit sits in the mirror for a
      // while, but drivers register it late; 150 m is about four seconds of real
      // notice at this differential.
      if (veh.lane === EMERGENCY_LANE && unit && !unit.arrived) {
        const behind = (veh.x - unit.x) * unit.dir;
        if (behind > 0 && behind < 150 && !veh.ordered) {
          veh.ordered = true;
          veh.orderT = this.t;
          veh.reaction = this.rng.range(0.8, 2.4);
          if (!ded) this.zone.stats.ordersIssued++;
        }
      }
    }
  }

  laneClear(veh, lane, range) {
    const arr = this.laneArrays.get(`${veh.dir}:${lane}`) ?? [];
    for (const o of arr) if (Math.abs(o.x - veh.x) < range) return false;
    return true;
  }

  tryLaneChange(veh) {
    if (veh.laneCooldown > 0) return;
    const unit = this.units[0];

    // Mandatory move: get out of a lane you should not be in, one lane at a time.
    if (veh.ordered && this.t - veh.orderT > veh.reaction) {
      veh.mergeTries++;
      const target = veh.lane + 1;
      if (target < EXP.lanes && this.canEnter(veh, target, true)) {
        const wasCorridor = veh.lane === EMERGENCY_LANE;
        veh.lane = target;
        veh.encroachedAt = -1;
        veh.ordered = false;
        veh.laneCooldown = this.rng.range(4, 8);
        if (wasCorridor && unit && (veh.x - unit.x) * unit.dir > 25) this.zone.stats.clearedBeforeContact++;
      }
      return;
    }
    if (veh.lane === EMERGENCY_LANE && this.cfg.dedicatedLane) return;

    const allowed = allowedLanes(veh.spec, this.cfg.dedicatedLane);
    const here = neighbours(this.laneArrays, veh, veh.lane);
    const aHere = this.accel(veh, here.lead);
    let best = null, bestGain = 0.22;
    for (const cand of [veh.lane - 1, veh.lane + 1]) {
      if (!allowed.includes(cand)) continue;
      if (!this.canEnter(veh, cand, false)) continue;
      const n = neighbours(this.laneArrays, veh, cand);
      const gain = this.accel(veh, n.lead, cand) - aHere + (cand > veh.lane ? 0.12 : 0);
      if (gain > bestGain) { bestGain = gain; best = cand; }
    }
    if (best !== null) { veh.lane = best; veh.laneCooldown = this.rng.range(5, 11); }
  }

  canEnter(veh, lane, mandatory) {
    const { lead, follow } = neighbours(this.laneArrays, veh, lane);
    const minGap = mandatory ? veh.len * 0.35 : veh.len * 0.9;
    if (lead && gapTo(veh, lead) < minGap) return false;
    if (follow && gapTo(veh, follow) < minGap) return false;
    if (follow && this.accel(follow, veh) < (mandatory ? MERGE_SAFETY * 1.6 : MERGE_SAFETY)) return false;
    return true;
  }

  accel(veh, lead, lane = veh.lane) {
    const gap = lead ? gapTo(veh, lead) : 1e4;
    const dv = lead ? veh.v - lead.v : 0;
    return idm(veh.v, Math.min(veh.v0, laneLimit(lane, this.cfg.dedicatedLane)), gap, dv, veh.spec.a, veh.spec.b);
  }

  /* ---------------- the unit ---------------- */

  stepUnit(dt) {
    const ev = this.units[0];
    if (!ev || ev.arrived) return;
    const w = WEATHER[this.cfg.weather] ?? WEATHER.clear;

    let gap = 1e4, dv = 0, blocker = null;
    for (const veh of this.vehicles) {
      if (veh.dir !== ev.dir || veh.lane !== EMERGENCY_LANE) continue;
      if ((veh.x - ev.x) * ev.dir <= 0) continue;
      const g = gapTo(ev, veh);
      if (g < gap) { gap = g; dv = ev.v - veh.v; blocker = veh; }
    }
    ev.blockedBy = gap < 120 ? blocker : null;

    let v0 = ev.v0 * w.vmax;
    if (this.cfg.fog && ev.x > EXP.fogFrom && ev.x < EXP.fogTo) v0 = Math.min(v0, 24);

    ev.v = Math.max(0, ev.v + idm(ev.v, v0, gap, dv, ev.spec.a, ev.spec.b, 3.0, 0.8) * dt);
    ev.x += ev.v * ev.dir * dt;
    ev.y = laneY(ev.dir, EMERGENCY_LANE);

    // "Impedance", not "stop": at expressway speed an ambulance forced from 120
    // to 60 km/h has already lost the time, and it will almost never halt. The
    // first seconds are the launch from the post and do not count.
    const slow = ev.v < v0 * 0.6 && this.t - ev.dispatchT > 12;
    if (slow && !ev.wasSlow) { ev.slowdowns++; this.zone.stats.forcedSlowdowns++; }
    ev.wasSlow = slow;
    if (ev.v < 1.0) { ev.waited += dt; if (!ev.stopped) { ev.stopped = true; ev.stops++; } }
    else if (ev.v > 4) ev.stopped = false;

    if (ev.corridorT === null && this.corridorAhead(ev) > 600) {
      ev.corridorT = this.t;
      this.log(`Corridor clear for 600 m ahead of ${ev.tag}`, 'ok');
    }
    if (ev.x >= ROUTE.incidentX) {
      ev.arrived = true;
      this.finished = true;
      const rec = this.metrics.recordEv(ev, this.t, this.freeFlow);
      this.log(`${ev.tag} on scene — ${rec.travelTime.toFixed(1)} s (free-flow ${this.freeFlow.toFixed(0)} s, ${ev.slowdowns} impedances)`, 'ok');
    }
  }

  corridorAhead(ev) {
    let min = 2000;
    for (const veh of this.vehicles) {
      if (veh.dir !== ev.dir || veh.lane !== EMERGENCY_LANE) continue;
      const d = (veh.x - ev.x) * ev.dir;
      if (d > 0 && d < min) min = d;
    }
    return min;
  }

  /** Vehicles currently sitting in the reserved lane. */
  encroachers(dir = 1) {
    return this.vehicles.filter(v => v.dir === dir && v.lane === EMERGENCY_LANE);
  }

  summary() {
    const s = this.metrics.summary(this.t, this.zone, this.gantries);
    s.config = { ...this.cfg };
    return s;
  }
}

let _shares = null;
function shareTable() {
  if (_shares) return _shares;
  _shares = {};
  for (const k in VEHICLES) _shares[k] = VEHICLES[k].share;
  return _shares;
}

export { LANE_LIMIT };
