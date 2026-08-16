// Gantry lane-control signals and the moving green zone.
//
// On a signalised arterial the control action is temporal — you change *when* a
// junction is green. On an expressway there is nothing to re-time: traffic runs
// continuously at 100 km/h. The control action has to be spatial instead. The
// system opens a moving window of carriageway ahead of the ambulance in which
// the gantries order the reserved lane cleared and pull the adjacent lane's
// speed limit down.
//
// The engineering question is the same one transposed: how far ahead? Too short
// and a driver sitting illegally in the corridor gets four seconds of warning at
// 33 m/s, cannot find a gap, and the ambulance brakes behind them. Too long and
// you have dropped the speed limit over several kilometres of expressway for one
// vehicle, every time a unit runs.

import { EXP, EMERGENCY_LANE, LANE_LIMIT, WEATHER } from './config.js';

const CAM_RANGE = 190;     // m either side of a gantry the camera can classify
const MIN_ZONE = 250;
const MAX_ZONE = 1500;
const STATIC_ZONE = 500;

export class Gantry {
  constructor(spec) {
    this.id = spec.id;
    this.x = spec.x;
    this.chainage = spec.chainage;
    this.aspects = ['closed', 'open', 'open', 'open'];
    this.vsl = LANE_LIMIT.slice();
    this.vms = '';
    this.alerting = false;
    this.violations = 0;
    this.seen = new Set();
  }

  /** Normal operation. Without the reserved lane, lane 0 is just a fast lane. */
  idle(dedicated = true) {
    this.aspects = [dedicated ? 'closed' : 'open', 'open', 'open', 'open'];
    this.vsl = LANE_LIMIT.slice();
    if (!dedicated) this.vsl[0] = LANE_LIMIT[1];
    this.vms = '';
    this.alerting = false;
  }

  /** Inside the green zone: warn, and take lane 1 down to the heavy-vehicle limit. */
  arm(unitTag) {
    this.aspects = ['closed', 'merge', 'open', 'open'];
    this.vsl = LANE_LIMIT.slice();
    this.vsl[1] = LANE_LIMIT[3];
    this.vms = `${unitTag} AHEAD — KEEP LEFT`;
    this.alerting = true;
  }

  /**
   * Automatic encroachment enforcement — the same detector that counts vehicles,
   * pointed at a different question: is anything in the lane that must be empty?
   * It is also the module that fails first. The ghat fog section is exactly
   * where drivers cannot see the lane markings either, so detection quality and
   * driver compliance collapse together rather than independently.
   */
  enforce(vehicles, cfg, rng) {
    if (!cfg.enforcement || !cfg.dedicatedLane) return;
    const w = WEATHER[cfg.weather] ?? WEATHER.clear;
    const fogHere = cfg.fog && this.x > EXP.fogFrom && this.x < EXP.fogTo;
    const quality = w.detect * (cfg.night ? 0.88 : 1) * (fogHere ? 0.55 : 1);
    for (const veh of vehicles) {
      if (veh.lane !== EMERGENCY_LANE || veh.kind === 'ev') continue;
      if (Math.abs(veh.x - this.x) > CAM_RANGE) continue;
      if (this.seen.has(veh.id)) continue;
      if (!rng.chance(quality * veh.spec.detect)) continue;
      this.seen.add(veh.id);
      this.violations++;
    }
  }
}

export class GreenZoneController {
  constructor(mode, gantries, log) {
    this.mode = mode;
    this.gantries = gantries;
    this.log = log ?? (() => {});
    this.active = false;
    this.start = 0;
    this.end = 0;
    this.clearTime = 0;
    this.laneFlow = 0;
    this.inCorridor = 0;
    this.worstGap = 3.0;
    this.worstHeavy = false;
    this.stats = {
      ordersIssued: 0, clearedBeforeContact: 0, forcedSlowdowns: 0,
      vslVehicles: 0, zoneLengthSum: 0, zoneSamples: 0,
    };
    this._announced = false;
  }

  get length() { return this.active ? this.end - this.start : 0; }
  get meanZoneLength() { return this.stats.zoneSamples ? this.stats.zoneLengthSum / this.stats.zoneSamples : 0; }

  update(dt, t, unit, vehicles, cfg, rng) {
    for (const g of this.gantries) g.enforce(vehicles, cfg, rng);

    if (!unit || unit.arrived || this.mode === 'none' || !cfg.dedicatedLane) {
      this.active = false;
      for (const g of this.gantries) g.idle(cfg.dedicatedLane);
      return;
    }

    this.measure(unit, vehicles);
    const L = this.mode === 'static' ? STATIC_ZONE : this.adaptiveLength(unit);
    this.active = true;
    this.start = unit.x - 40;
    this.end = unit.x + L;
    this.stats.zoneLengthSum += L;
    this.stats.zoneSamples++;

    if (!this._announced) {
      this._announced = true;
      this.log(`Green zone opened — ${Math.round(L)} m ahead of ${unit.tag}, lane 1 limited to 80 km/h`, 'ev');
    }

    for (const g of this.gantries) {
      if (g.x >= this.start && g.x <= this.end + 200) g.arm(unit.tag);
      else g.idle(cfg.dedicatedLane);
    }

    for (const veh of vehicles) {
      if (veh.kind === 'ev' || veh.dir !== unit.dir) continue;
      if (veh.x < this.start || veh.x > this.end) continue;
      if (veh.lane === EMERGENCY_LANE && !veh.ordered && veh.heedsGantry) {
        veh.ordered = true;
        veh.orderT = t;
        veh.reaction = rng.range(1.0, 3.2);
        this.stats.ordersIssued++;
      }
      if (veh.lane === 1 && !veh.vslApplied) { veh.vslApplied = true; this.stats.vslVehicles++; }
    }
  }

  /**
   * Zone length from the unit's speed and the time a driver actually needs to
   * get out of the corridor:
   *
   *   T_clear = t_react + W(q, tau) + t_manoeuvre
   *
   * W is the classic gap-acceptance waiting time for a driver seeking a gap of
   * at least the critical headway tau in a Poisson stream of flow q:
   *
   *   W = (e^(q*tau) - 1) / q  -  tau
   *
   * It is worth writing out because of how it behaves — almost free at low flow,
   * blowing up superlinearly as lane 1 fills. That is the whole argument for
   * making the zone adaptive: a fixed 500 m is generous at 400 veh/h and
   * hopeless at 1400 veh/h, and no single number is right for both.
   *
   * tau depends on *what* is in the corridor, not just how much — which is why
   * the detector's class label earns its keep. A car merging out at 105 km/h
   * takes a 3 s gap; a truck at 80 joining 100 km/h traffic needs closer to 5.5.
   */
  adaptiveLength(unit) {
    const q = this.laneFlow;
    const tau = this.worstGap;
    const manoeuvre = this.worstHeavy ? 5.0 : 3.0;
    const wait = q > 1e-3 ? (Math.exp(q * tau) - 1) / q - tau : 0;
    this.clearTime = 2.5 + Math.min(wait, 45) + manoeuvre;
    return Math.min(MAX_ZONE, Math.max(MIN_ZONE, unit.v * this.clearTime + 100));
  }

  /**
   * Flow in the lane an encroacher must merge into, measured over the kilometre
   * the unit is about to reach rather than the one it is in — by the time
   * congestion is beside you it is too late to plan for it. On the real corridor
   * this comes from the gantry ATCC counters.
   */
  measure(unit, vehicles) {
    const from = unit.x, to = unit.x + 1000;
    let n = 0, vSum = 0;
    this.worstGap = 3.0;
    this.worstHeavy = false;
    this.inCorridor = 0;
    for (const veh of vehicles) {
      if (veh.dir !== unit.dir || veh.kind === 'ev') continue;
      if (veh.lane === 1 && veh.x >= from && veh.x <= to) { vSum += veh.v; n++; }
      if (veh.lane === EMERGENCY_LANE && veh.x > unit.x && veh.x < unit.x + 2000) {
        this.inCorridor++;
        if (veh.spec.heavy) { this.worstHeavy = true; this.worstGap = 5.5; }
      }
    }
    this.laneFlow = (n / 1000) * (n ? vSum / n : 25);      // q = k * v
  }
}
