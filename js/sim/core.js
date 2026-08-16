// Shared primitives: seeded randomness, car-following physics, metrics.

/** mulberry32 — every run is reproducible from its seed, which is what makes
 *  the A/B comparison meaningful: the same traffic, two control strategies. */
export class Rng {
  constructor(seed = 1) { this._s = (seed >>> 0) || 0x9e3779b9; this.seed = seed >>> 0; }

  next() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo, hi) { return lo + (hi - lo) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  chance(p) { return this.next() < p; }

  weighted(weights) {
    let total = 0;
    for (const k in weights) total += weights[k];
    let r = this.next() * total;
    for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
    return Object.keys(weights)[0];
  }
}

/**
 * Intelligent Driver Model acceleration.
 *   sStar = s0 + max(0, v*T + v*dv / (2*sqrt(a*b)))
 *   dv/dt = a * (1 - (v/v0)^4 - (sStar/gap)^2)
 * Standard, calibrated, and — importantly for this project — it produces
 * realistic queue discharge and shockwaves for free, which is what the whole
 * green-zone argument depends on.
 */
export function idm(v, v0, gap, dv, a, b, s0 = 2.2, T = 1.3) {
  const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), 4);
  const inter = Math.pow(sStar / Math.max(gap, 0.35), 2);
  return a * (free - inter);
}

/** Bumper-to-bumper gap between two vehicles travelling the same way. */
export function gapTo(veh, other) {
  return Math.abs(other.x - veh.x) - (other.len + veh.len) / 2;
}

/** Lane arrays sorted so index 0 is the most advanced vehicle. */
export function buildLaneArrays(vehicles) {
  const map = new Map();
  for (const v of vehicles) {
    const key = `${v.dir}:${v.lane}`;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(v);
  }
  for (const [key, arr] of map) {
    const dir = key.startsWith('1') ? 1 : -1;
    arr.sort((a, b) => (b.x - a.x) * dir);
  }
  return map;
}

/** Immediate leader and follower in a lane, by binary search on the sorted array. */
export function neighbours(laneArrays, veh, lane) {
  const arr = laneArrays.get(`${veh.dir}:${lane}`) ?? [];
  const p = veh.x * veh.dir;
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].x * veh.dir > p) lo = mid + 1; else hi = mid;
  }
  let lead = lo > 0 ? arr[lo - 1] : null;
  if (lead === veh) lead = lo > 1 ? arr[lo - 2] : null;
  let follow = arr[lo] ?? null;
  if (follow === veh) follow = arr[lo + 1] ?? null;
  return { lead, follow };
}

export class Accumulator {
  constructor() { this.n = 0; this.sum = 0; this.sq = 0; this.max = 0; }
  add(v) { this.n++; this.sum += v; this.sq += v * v; if (v > this.max) this.max = v; }
  get mean() { return this.n ? this.sum / this.n : 0; }
  get sd() { return this.n < 2 ? 0 : Math.sqrt(Math.max(0, this.sq / this.n - this.mean ** 2)); }
  toJSON() { return { n: this.n, mean: this.mean, sd: this.sd, max: this.max }; }
}

/**
 * Delay is always measured against the same benchmark — the time this vehicle
 * would have taken over the same distance at its own desired speed — so the
 * cost the corridor imposes on ordinary traffic shows up honestly instead of
 * disappearing into an average.
 */
export class Metrics {
  constructor() {
    this.mainlineDelay = new Accumulator();
    this.throughput = 0;
    this.pcuCleared = 0;
    this.ev = null;
  }

  depart(veh, t) {
    const travelled = Math.abs(veh.x - veh.enterPos);
    const free = travelled / Math.max(veh.v0, 1);
    this.mainlineDelay.add(Math.max(0, (t - veh.enterT) - free));
    this.throughput++;
    this.pcuCleared += veh.pcu;
  }

  recordEv(unit, t, freeFlow) {
    const travel = t - unit.dispatchT;
    this.ev = {
      tag: unit.tag,
      travelTime: travel,
      freeFlow,
      delay: travel - freeFlow,
      slowdowns: unit.slowdowns,
      stops: unit.stops,
      stoppedTime: unit.waited,
      meanSpeed: (unit.routeLength / travel) * 3.6,
      corridorClearAt: unit.corridorT === null ? null : unit.corridorT - unit.dispatchT,
    };
    return this.ev;
  }

  summary(simTime, zone, gantries) {
    return {
      simTime,
      ev: this.ev,
      mainlineDelay: this.mainlineDelay.toJSON(),
      throughput: this.throughput,
      pcuPerHour: simTime > 0 ? (this.pcuCleared / simTime) * 3600 : 0,
      zone: {
        ...zone.stats,
        meanLength: zone.meanZoneLength,
        violations: gantries.reduce((n, g) => n + g.violations, 0),
      },
    };
  }
}
