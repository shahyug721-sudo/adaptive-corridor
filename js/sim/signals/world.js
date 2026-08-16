// The urban arterial simulation: six coordinated junctions, mixed Indian
// traffic, cross-street demand, and an ambulance that has to get through them.

import {
  ART, JUNCTIONS, VEHICLES, AMBULANCE, TRAFFIC, SIGNAL, ROUTE, DEFAULTS, WEATHER,
  ARTERIAL_DESIGN_FLOW, laneY, corridorY, freeFlowTime, crossFloor,
} from './config.js';
import { Rng, idm, gapTo, buildLaneArrays, neighbours, Metrics } from '../core.js';
import { JunctionSignal, websterPlan, progressionOffsets, makeStrategy, CorridorCoordinator } from './control.js';

const ENTRY = -70;
const EXIT = ART.length + 130;
const ZONE = 65;            // m of approach a camera can count over
const CAM_PERIOD = 0.2;     // s between inferences — 5 fps on an edge box
const CAM_LATENCY = 0.45;   // s from photon to usable count

/* ------------------------------------------------------------------ */
/* Cameras                                                             */
/* ------------------------------------------------------------------ */

/**
 * The detection layer. Controllers never see ground truth — they see this.
 *
 * Two numbers are reported per approach and they are not interchangeable:
 * standing PCU (what is queued now) drives gap-out, and arrival flow (PCU/s
 * entering the zone) drives the splits. A fixed-length detection zone saturates
 * under congestion — once the queue fills 65 m every approach looks equally
 * busy — so a split derived from occupancy collapses to 50/50 regardless of
 * real demand. Measuring the arrival rate is what SCATS-style degree-of-
 * saturation control uses, and it keeps working when the queue is longer than
 * the camera can see.
 */
class Cameras {
  constructor() {
    this.list = [];
    for (const j of JUNCTIONS) {
      for (const road of ['art', 'cross']) {
        for (const dir of [1, -1]) {
          this.list.push({
            j, road, dir, clock: 0, pending: [],
            pcu: 0, count: 0, queue: 0, missRate: 0,
            flowEst: 0.15, recent: new Map(),
          });
        }
      }
    }
  }

  demand(junctionId, road) {
    let s = 0;
    for (const c of this.list) if (c.j.id === junctionId && c.road === road) s += c.pcu;
    return s;
  }

  flow(junctionId, road) {
    let s = 0;
    for (const c of this.list) if (c.j.id === junctionId && c.road === road) s += c.flowEst;
    return s;
  }

  sample(cam, vehicles, stopLine, cfg, rng, t, dt) {
    cam.clock -= dt;
    if (cam.clock <= 0) {
      cam.clock = CAM_PERIOD;
      const w = WEATHER[cfg.weather] ?? WEATHER.clear;
      let truePcu = 0, obsPcu = 0, obsCount = 0, queue = 0, missed = 0, seen = 0, arrived = 0;
      const ahead = new Map(), bus = new Map();

      for (const veh of vehicles) {
        const d = Math.abs(veh.x - stopLine);
        if (d > ZONE) continue;
        truePcu += veh.pcu; seen++;
        if (veh.v < 1.0) queue = Math.max(queue, d);
        const n = ahead.get(veh.lane) ?? 0;
        ahead.set(veh.lane, n + 1);
        // A bus ahead of you in the same lane is the single biggest cause of a
        // missed detection on an Indian approach.
        const shadow = (bus.get(veh.lane) ?? -999) > d - 14 ? 0.45 : 1.0;
        if (veh.cls === 'bus' || veh.cls === 'lcv') bus.set(veh.lane, d);
        const p = veh.spec.detect * w.detect * shadow * Math.exp(-0.045 * n);
        if (rng.chance(Math.min(0.995, p))) {
          obsPcu += veh.pcu; obsCount++;
          if (!cam.recent.has(veh.id)) arrived += veh.pcu;
          cam.recent.set(veh.id, t);
        } else missed++;
      }
      // Memory has to outlast a detection dropout. At 4 s a vehicle that the
      // detector loses behind a bus and re-acquires is counted as a second
      // arrival, which inflates the measured flow and pushes the coordinator's
      // Webster cycle to its cap.
      for (const [id, at] of cam.recent) if (t - at > 9) cam.recent.delete(id);

      cam.flowEst += (CAM_PERIOD / 45) * (arrived / CAM_PERIOD - cam.flowEst);
      cam.missRate = seen ? missed / seen : 0;
      cam.pending.push({ at: t + CAM_LATENCY, pcu: obsPcu, count: obsCount, queue });
    }
    while (cam.pending.length && cam.pending[0].at <= t) {
      const s = cam.pending.shift();
      cam.pcu = s.pcu; cam.count = s.count; cam.queue = s.queue;
    }
  }
}

/** Sound pressure level of a siren at range r: inverse square plus urban losses. */
export const splAt = (r) => 118 - 20 * Math.log10(Math.max(r, 1)) - 0.0075 * Math.max(r, 1);

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

export class SignalWorld {
  constructor(cfg = {}) { this.reset(cfg); }

  reset(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.rng = new Rng(this.cfg.seed);
    this.nextId = 1;
    this.t = 0;
    this.events = [];
    this.vehicles = [];
    this.cross = new Map();
    this.units = [];
    this.metrics = new Metrics();
    this.freeFlow = freeFlowTime();
    this.finished = false;
    this._spawn = { 1: 0, '-1': 0 };
    this.laneArrays = new Map();

    const artFlow = ARTERIAL_DESIGN_FLOW * this.cfg.demand;
    const plans = JUNCTIONS.map(j => websterPlan(artFlow, j.crossDemand * this.cfg.demand));
    const coordinated = this.cfg.strategy === 'coordinated' || this.cfg.strategy === 'smart';
    const offsets = coordinated ? progressionOffsets(plans) : JUNCTIONS.map(() => 0);

    this.signals = new Map();
    this.sensors = new Map();
    JUNCTIONS.forEach((j, i) => {
      const sig = new JunctionSignal(j, { ...plans[i], offset: offsets[i] });
      sig.t = offsets[i] % plans[i].artGreen;
      this.signals.set(j.id, sig);
      this.sensors.set(j.id, { spl: 0, history: [], locked: null });
      this.cross.set(j.id, { vehicles: [], spawn: { 1: 0, '-1': 0 } });
    });

    this.cams = new Cameras();
    this.strategy = makeStrategy(this.cfg.strategy);
    this.coordinator = new CorridorCoordinator(this.cfg.strategy, this.signals, this.cams, (m, k) => this.log(m, k));
    this.preemptStats = { armed: 0, spurious: 0, served: 0 };

    this.seedTraffic();
  }

  log(msg, kind = 'info') {
    this.events.push({ t: this.t, msg, kind });
    if (this.events.length > 120) this.events.shift();
  }

  makeVehicle(x, dir, cls, lane) {
    const spec = VEHICLES[cls];
    return {
      id: this.nextId++, kind: 'traffic', road: 'art',
      cls, spec, dir, lane: lane ?? this.rng.int(ART.lanes),
      x, y: 0, off: 0, offTarget: 0,
      v: spec.v0 * this.rng.range(0.5, 0.8),
      v0: spec.v0 * this.rng.range(0.85, 1.12),
      len: spec.len, wid: spec.wid, pcu: spec.pcu,
      hue: this.rng.range(0, 360), shade: this.rng.range(0.32, 0.72),
      alerted: false, compliant: true, yieldDelay: 0,
      laneCooldown: this.rng.range(0, 4),
      enterT: 0, enterPos: x, stops: 0, stopped: false, waited: 0,
    };
  }

  seedTraffic() {
    const n = Math.round(this.cfg.demand * 42 * ART.lanes);
    for (const dir of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const x = this.rng.range(0, ART.length);
        const veh = this.makeVehicle(x, dir, this.rng.weighted(shares()));
        if (this.vehicles.some(o => o.dir === dir && o.lane === veh.lane && Math.abs(o.x - x) < 12)) continue;
        this.vehicles.push(veh);
      }
    }
    for (let i = 0; i < 1400; i++) this.step(1 / 15, true);
    this.t = 0;
    this.metrics = new Metrics();
    this.events.length = 0;
    this.coordinator.nextReview = 20;
    for (const v of this.vehicles) { v.enterT = 0; v.enterPos = v.x; v.stops = 0; v.waited = 0; }
  }

  dispatch() {
    if (this.units.length) return;
    const ev = {
      id: this.nextId++, kind: 'ev', tag: 'EMS-108', road: 'art', primary: true,
      cls: 'ambulance', spec: AMBULANCE, dir: 1, lane: 0,
      x: ROUTE.startX, y: corridorY(1),
      v: 0, v0: AMBULANCE.v0,
      len: AMBULANCE.len, wid: AMBULANCE.wid, pcu: AMBULANCE.pcu,
      dispatchT: this.t, routeLength: ROUTE.hospitalX - ROUTE.startX,
      corridorT: null, arrived: false, preempted: new Set(),
      stops: 0, stopped: false, waited: 0, slowdowns: 0, wasSlow: false,
    };
    this.units.push(ev);
    this.log(`${ev.tag} responding — ${ROUTE.incidentName} → ${ROUTE.hospitalName}, ${(ev.routeLength / 1000).toFixed(1)} km`, 'ev');
  }

  /* ---------------- step ---------------- */

  step(dt, warmup = false) {
    this.t += dt;
    this.spawnArterial(dt);
    this.laneArrays = buildLaneArrays(this.vehicles);
    this.updateCameras(dt);
    if (!warmup) {
      this.coordinator.update(this.t, this);
      this.updatePreemption(dt);
    }
    for (const [, sig] of this.signals) sig.step(dt, this.t, this.strategy, this.cams);
    this.stepArterial(dt);
    this.stepCross(dt);
    if (!warmup) this.stepUnit(dt);
  }

  spawnArterial(dt) {
    const perDir = (ARTERIAL_DESIGN_FLOW * this.cfg.demand) / 3600 / 1.02;
    for (const dir of [1, -1]) {
      this._spawn[dir] -= dt;
      if (this._spawn[dir] > 0) continue;
      this._spawn[dir] = -Math.log(1 - this.rng.next()) / Math.max(perDir, 1e-4);
      const x0 = dir > 0 ? ENTRY : EXIT;
      let bestLane = 0, bestRoom = -1;
      for (let lane = 0; lane < ART.lanes; lane++) {
        const arr = this.laneArrays.get(`${dir}:${lane}`) ?? [];
        const tail = arr[arr.length - 1];
        const room = tail ? (tail.x - x0) * dir : 1e4;
        if (room > bestRoom) { bestRoom = room; bestLane = lane; }
      }
      if (bestRoom < 16) continue;
      const veh = this.makeVehicle(x0, dir, this.rng.weighted(shares()), bestLane);
      veh.enterT = this.t; veh.enterPos = x0;
      this.vehicles.push(veh);
    }
  }

  updateCameras(dt) {
    for (const cam of this.cams.list) {
      const j = cam.j;
      if (cam.road === 'art') {
        const stop = j.x - cam.dir * ART.junctionHalf;
        const list = this.vehicles.filter(v => v.dir === cam.dir && (stop - v.x) * cam.dir > -1);
        this.cams.sample(cam, list, stop, this.cfg, this.rng, this.t, dt);
      } else {
        const stop = -cam.dir * ART.junctionHalf;
        const list = this.cross.get(j.id).vehicles
          .filter(v => v.dir === cam.dir && (stop - v.u) * cam.dir > -1)
          .map(v => ({ ...v, x: v.u }));
        this.cams.sample(cam, list, stop, this.cfg, this.rng, this.t, dt);
      }
    }
  }

  /* ---------------- emergency preemption ---------------- */

  /**
   * `local` preempts the moment a junction's own microphone locks the siren —
   * which, at a 145 m detection radius, is often too late to discharge a
   * standing queue. `corridor` fuses the detections into a track and schedules
   * each junction separately for the latest instant that still works:
   *
   *     t_start(j) = ETA(j) − [ transition(j) + startup + discharge(j) ]
   *
   * Holding every junction green from first detection would be simpler and
   * would also stop the cross streets for two solid minutes. Scheduling each
   * one late is what keeps the disruption small.
   */
  updatePreemption(dt) {
    const ev = this.units[0];
    if (!ev || ev.arrived || this.cfg.emergency === 'none') return;

    for (const j of JUNCTIONS) {
      const sensor = this.sensors.get(j.id);
      const r = Math.abs(ev.x - j.x);
      sensor.spl = splAt(r);
      sensor.history.push({ t: this.t, spl: sensor.spl });
      while (sensor.history.length && this.t - sensor.history[0].t > 2.5) sensor.history.shift();
      const first = sensor.history[0];
      const rising = first && this.t - first.t > 0.8 && (sensor.spl - first.spl) / (this.t - first.t) > 0.25;
      const heard = sensor.spl - this.cfg.noiseFloor >= 6 && rising;

      const sig = this.signals.get(j.id);
      const passed = (ev.x - j.x) * ev.dir > ART.junctionHalf + 12;

      if (sig.preempt && passed) { sig.releasePreempt(); this.preemptStats.served++; continue; }
      if (sig.preempt || passed) continue;

      if (this.cfg.emergency === 'local') {
        if (heard && sig.requestPreempt(ev.tag, 'art', this.t)) {
          this.preemptStats.armed++;
          this.log(`${j.id}: local preemption — siren locked at ${Math.round(r)} m, ${Math.round(sensor.spl)} dB`, 'ev');
        }
      } else {
        // Corridor scheduling needs the unit to have been heard *somewhere*, not
        // necessarily here — that is the whole advantage over acting alone.
        if (!this.trackLive && heard) {
          this.trackLive = true;
          this.log(`Corridor track acquired at ${j.id} — scheduling ${JUNCTIONS.length} junctions just-in-time`, 'ok');
        }
        if (!this.trackLive) continue;
        const dist = (j.x - ev.x) * ev.dir;
        if (dist < -ART.junctionHalf) continue;
        const eta = dist / Math.min(Math.max(ev.v, 5), 18);
        const queuePcu = this.cams.demand(j.id, 'art');
        const discharge = queuePcu / (TRAFFIC.satFlowPerLane * ART.lanes);
        const transition = Math.max(sig.timeToGreen('art'), sig.predictTransition('art', this.t, eta));
        const lead = transition + TRAFFIC.startupLost + discharge + 2.5;
        if (eta <= lead && sig.requestPreempt(ev.tag, 'art', this.t)) {
          this.preemptStats.armed++;
          this.log(`${j.id}: preempt armed ${eta.toFixed(0)} s ahead (needs ${lead.toFixed(0)} s to clear)`, 'ev');
        }
      }
    }
  }

  /* ---------------- arterial dynamics ---------------- */

  stepArterial(dt) {
    const w = WEATHER[this.cfg.weather] ?? WEATHER.clear;
    const ev = this.units[0];

    for (const [key, arr] of this.laneArrays) {
      const dir = key.startsWith('1') ? 1 : -1;
      for (let i = 0; i < arr.length; i++) {
        const veh = arr[i];
        const lead = arr[i - 1];
        veh.laneCooldown = Math.max(0, veh.laneCooldown - dt);
        let gap = lead ? gapTo(veh, lead) : 1e4;
        let dv = lead ? veh.v - lead.v : 0;
        let v0 = veh.v0 * w.vmax;

        const j = this.nextJunction(veh.x, dir);
        if (j) {
          const sig = this.signals.get(j.id);
          const stop = j.x - dir * ART.junctionHalf;
          const toStop = (stop - veh.x) * dir - veh.len / 2;
          const canStop = (veh.v * veh.v) / (2 * veh.spec.b) < toStop + 1.0;
          if (!sig.mayGo('art') && canStop && toStop > -1 && toStop < gap) { gap = Math.max(toStop, -0.5); dv = veh.v; }
        }

        this.applyAlert(veh, ev, dt);
        if (veh.alerted && veh.compliant) v0 = Math.min(v0, 7.5);

        const s0 = veh.spec.filter ? 0.9 : TRAFFIC.jamGap;
        veh.v = Math.max(0, veh.v + idm(veh.v, v0, gap, dv, veh.spec.a, veh.spec.b, s0, TRAFFIC.headway) * dt);
        veh.x += veh.v * dir * dt;

        // lateral yield animation
        const rate = (veh.spec.filter ? 1.9 : 0.95) * (veh.v > 0.6 ? 1 : 0.45);
        if (Math.abs(veh.off - veh.offTarget) > 0.02) {
          veh.off += Math.sign(veh.offTarget - veh.off) * Math.min(rate * dt, Math.abs(veh.offTarget - veh.off));
        }
        veh.y = laneY(dir, veh.lane) + dir * veh.off;

        if (veh.v < 0.4) { veh.waited += dt; if (!veh.stopped) { veh.stopped = true; veh.stops++; } }
        else if (veh.v > 1.5) veh.stopped = false;
      }
    }

    for (const veh of this.vehicles) {
      if (veh.alerted || veh.laneCooldown > 0 || veh.v < 2.5) continue;
      const here = neighbours(this.laneArrays, veh, veh.lane);
      const aHere = this.accel(veh, here.lead);
      for (const cand of [veh.lane - 1, veh.lane + 1]) {
        if (cand < 0 || cand >= ART.lanes) continue;
        const n = neighbours(this.laneArrays, veh, cand);
        if (n.lead && gapTo(veh, n.lead) < veh.len * 0.8) continue;
        if (n.follow && gapTo(veh, n.follow) < veh.len * 0.8) continue;
        if (this.accel(veh, n.lead) - aHere > 0.2) {
          veh.lane = cand;
          veh.laneCooldown = this.rng.range(3, 8);
          break;
        }
      }
    }

    const keep = [];
    for (const veh of this.vehicles) {
      const out = veh.dir > 0 ? veh.x > EXIT : veh.x < ENTRY;
      if (out) this.metrics.depart(veh, this.t);
      else keep.push(veh);
    }
    this.vehicles = keep;
  }

  accel(veh, lead) {
    const gap = lead ? gapTo(veh, lead) : 1e4;
    return idm(veh.v, veh.v0, gap, lead ? veh.v - lead.v : 0, veh.spec.a, veh.spec.b);
  }

  /**
   * Driver alerting. A driver hears the siren through their own windscreen, not
   * a calibrated microphone: enclosed vehicles lose about 14 dB to the cabin,
   * open ones barely any. That gap — two-wheeler riders reacting long before car
   * drivers — is why a roadside sensor beats waiting for drivers to notice.
   */
  applyAlert(veh, ev, dt) {
    if (!ev || ev.arrived) { if (veh.alerted) { veh.alerted = false; veh.offTarget = 0; } return; }
    const ahead = (veh.x - ev.x) * ev.dir;
    if (veh.alerted && ahead < -35) { veh.alerted = false; veh.offTarget = 0; return; }
    if (veh.dir !== ev.dir || ahead < -8) return;

    if (!veh.alerted) {
      const insulation = veh.spec.filter ? 2 : (veh.cls === 'bus' || veh.cls === 'lcv') ? 11 : 14;
      const cabin = this.cfg.noiseFloor - (veh.spec.filter ? 0 : 8);
      if (splAt(Math.abs(veh.x - ev.x)) - insulation - cabin < 3) return;
      veh.alerted = true;
      veh.compliant = this.rng.chance(this.cfg.compliance);
      veh.yieldDelay = this.rng.range(2, 6);
      if (veh.compliant) veh.offTarget = veh.lane === 0 ? ART.laneWidth * 0.62 : ART.laneWidth * 0.34;
    } else if (!veh.compliant && ahead > 0 && ahead < 34) {
      veh.yieldDelay -= dt;
      if (veh.yieldDelay <= 0) {
        veh.compliant = true;
        veh.offTarget = veh.lane === 0 ? ART.laneWidth * 0.62 : ART.laneWidth * 0.34;
      }
    }
  }

  /* ---------------- cross traffic ---------------- */

  stepCross(dt) {
    for (const j of JUNCTIONS) {
      const cr = this.cross.get(j.id);
      const sig = this.signals.get(j.id);
      const perDir = (j.crossDemand * this.cfg.demand) / 2 / 3600;

      for (const dir of [1, -1]) {
        cr.spawn[dir] -= dt;
        if (cr.spawn[dir] <= 0) {
          cr.spawn[dir] = -Math.log(1 - this.rng.next()) / Math.max(perDir, 1e-4);
          const lane = this.rng.int(ART.crossLanes);
          const u0 = -dir * ART.crossHalf;
          if (!cr.vehicles.some(v => v.dir === dir && v.lane === lane && Math.abs(v.u - u0) < 14)) {
            const cls = this.rng.weighted(shares());
            const spec = VEHICLES[cls];
            cr.vehicles.push({
              id: this.nextId++, kind: 'traffic', road: 'cross', cls, spec, dir, lane,
              u: u0, junctionId: j.id, junctionX: j.x,
              v: spec.v0 * 0.5, v0: spec.v0 * this.rng.range(0.7, 0.95) * 0.72,
              len: spec.len, wid: spec.wid, pcu: spec.pcu,
              hue: this.rng.range(0, 360), shade: this.rng.range(0.32, 0.72),
              enterT: this.t, enterPos: u0, stops: 0, stopped: false, waited: 0,
            });
          }
        }
      }

      const groups = new Map();
      for (const v of cr.vehicles) {
        const k = `${v.dir}:${v.lane}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(v);
      }
      for (const arr of groups.values()) {
        arr.sort((a, b) => (b.u - a.u) * arr[0].dir);
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i], lead = arr[i - 1];
          let gap = lead ? Math.abs(lead.u - v.u) - (lead.len + v.len) / 2 : 1e4;
          let dv = lead ? v.v - lead.v : 0;
          const stop = -v.dir * ART.junctionHalf;
          const toStop = (stop - v.u) * v.dir;
          if (toStop > -0.5 && !sig.mayGo('cross')) {
            const canStop = (v.v * v.v) / (2 * v.spec.b) < toStop + 0.5;
            if (canStop && toStop < gap) { gap = toStop; dv = v.v; }
          }
          v.v = Math.max(0, v.v + idm(v.v, v.v0, gap, dv, v.spec.a, v.spec.b) * dt);
          v.u += v.v * v.dir * dt;
          if (v.v < 0.4) { v.waited += dt; if (!v.stopped) { v.stopped = true; v.stops++; } }
          else if (v.v > 1.5) v.stopped = false;
        }
      }

      cr.vehicles = cr.vehicles.filter(v => {
        if (Math.abs(v.u) > ART.crossHalf + 6 && v.u * v.dir > 0) {
          this.metrics.crossDelay ??= [];
          const free = Math.abs(v.u - v.enterPos) / Math.max(v.v0, 1);
          this.metrics.crossDelay.push(Math.max(0, (this.t - v.enterT) - free));
          return false;
        }
        return true;
      });
    }
  }

  /* ---------------- the unit ---------------- */

  stepUnit(dt) {
    const ev = this.units[0];
    if (!ev || ev.arrived) return;

    let gap = 1e4, dv = 0;
    for (const veh of this.vehicles) {
      if (veh.dir !== ev.dir || (veh.x - ev.x) * ev.dir <= 0) continue;
      const clear = Math.abs(veh.y - corridorY(ev.dir)) - (veh.wid + ev.wid) / 2;
      if (clear >= 0.28) continue;
      const g = gapTo(ev, veh);
      if (g < gap) { gap = g; dv = ev.v - veh.v; }
    }

    let v0 = ev.v0 * (WEATHER[this.cfg.weather] ?? WEATHER.clear).vmax;
    const j = this.nextJunction(ev.x, ev.dir);
    if (j) {
      const sig = this.signals.get(j.id);
      const stop = j.x - ev.dir * ART.junctionHalf;
      const toStop = (stop - ev.x) * ev.dir - ev.len / 2;
      if (toStop > -1 && toStop < 90 && !sig.mayGo('art')) {
        // An ambulance may cross against a red with due caution, but only into a
        // gap — and on a green cross street there usually isn't one.
        const conflict = this.cross.get(j.id).vehicles.some(v => {
          if (Math.abs(v.u) < ART.junctionHalf + 6) return true;
          const toBox = (-v.dir * ART.junctionHalf - v.u) * v.dir;
          return toBox > -6 && toBox < 42 && v.v > 1.5;
        });
        if (conflict) { if (toStop < gap) { gap = Math.max(toStop, -0.5); dv = ev.v; } }
        else v0 = Math.min(v0, 3.5);
      }
      if (sig.preempt && sig.preempt.tag === ev.tag) ev.preempted.add(j.id);
    }

    ev.v = Math.max(0, ev.v + idm(ev.v, v0, gap, dv, ev.spec.a, ev.spec.b, 1.2, 0.9) * dt);
    ev.x += ev.v * ev.dir * dt;
    ev.y = corridorY(ev.dir);

    if (ev.v < 0.5) { ev.waited += dt; if (!ev.stopped) { ev.stopped = true; ev.stops++; } }
    else if (ev.v > 2) ev.stopped = false;

    if (ev.corridorT === null && this.corridorAhead(ev) > 130) {
      ev.corridorT = this.t;
      this.log(`Emergency corridor open — ${(this.t - ev.dispatchT).toFixed(1)} s after dispatch`, 'ok');
    }
    if (ev.x >= ROUTE.hospitalX) {
      ev.arrived = true;
      this.finished = true;
      const rec = this.metrics.recordEv(ev, this.t, this.freeFlow);
      this.log(`${ev.tag} at ${ROUTE.hospitalName} — ${rec.travelTime.toFixed(1)} s, ${ev.stops} stops (free-flow ${this.freeFlow.toFixed(0)} s)`, 'ok');
    }
  }

  /* ---------------- helpers ---------------- */

  nextJunction(x, dir) {
    let best = null, bestD = Infinity;
    for (const j of JUNCTIONS) {
      const d = (j.x - dir * ART.junctionHalf - x) * dir;
      if (d > -ART.junctionHalf && d < bestD) { bestD = d; best = j; }
    }
    return best;
  }

  corridorAhead(ev) {
    let min = 400;
    for (const veh of this.vehicles) {
      if (veh.dir !== ev.dir) continue;
      const d = (veh.x - ev.x) * ev.dir;
      if (d <= 0 || d > 400) continue;
      if (Math.abs(veh.y - corridorY(ev.dir)) - (veh.wid + ev.wid) / 2 < 0.28) min = Math.min(min, d);
    }
    return min;
  }

  /** Mean speed of moving arterial traffic — what the coordinator cuts offsets for. */
  platoonSpeed() {
    let sum = 0, n = 0;
    for (const v of this.vehicles) if (v.dir > 0 && v.v > 2) { sum += v.v; n++; }
    return n > 8 ? sum / n : 0;
  }

  /** Mean cross-street delay per vehicle — the price of every preemption. */
  crossDelayMean() {
    const d = this.metrics.crossDelay ?? [];
    return d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0;
  }

  summary() {
    return {
      simTime: this.t,
      ev: this.metrics.ev,
      arterialDelay: this.metrics.mainlineDelay.toJSON(),
      crossDelay: { n: (this.metrics.crossDelay ?? []).length, mean: this.crossDelayMean() },
      throughput: this.metrics.throughput,
      pcuPerHour: this.t > 0 ? (this.metrics.pcuCleared / this.t) * 3600 : 0,
      preemptions: this.preemptStats.armed,
      cycle: this.coordinator.cycle,
      critical: this.coordinator.critical?.id ?? null,
      config: { ...this.cfg },
    };
  }
}

let _shares = null;
function shares() {
  if (_shares) return _shares;
  _shares = {};
  for (const k in VEHICLES) _shares[k] = VEHICLES[k].share;
  return _shares;
}
