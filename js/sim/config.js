// Hindu Hrudaysamrat Balasaheb Thackeray Maharashtra Samruddhi Mahamarg
// (Mumbai–Nagpur Expressway) — geometry, fleet and the proposed lane discipline.
//
// WHAT EXISTS TODAY
//   701 km, 6-lane access-controlled expressway. One speed limit for the whole
//   carriageway: 120 km/h light, 80 km/h heavy. Two- and three-wheelers and
//   tractors are banned. An ITS is already installed — CCTV, variable message
//   signs, automatic traffic counters, and ambulance posts roughly every 50 km.
//
// WHAT THIS PROJECT PROPOSES
//   Re-stripe each carriageway as three running lanes with lane-wise speed
//   segregation (100 / 90 / 80 km/h, heavy vehicles confined to the slowest),
//   plus a fourth lane against the median kept permanently clear as an
//   emergency corridor, driven by gantry lane-control signals.
//
// WHY THE MEDIAN SIDE
//   India drives on the left, so the median-adjacent lane is the overtaking
//   lane and the natural place for a corridor: an ambulance in it never crosses
//   a slower lane, and vehicles clearing it merge left, away from the unit.
//   Putting the corridor on the shoulder would place it beside the entry ramps
//   and the broken-down vehicles.

export const EXP = {
  name: 'Samruddhi Mahamarg — Shirdi → Sinnar (Package 9)',
  shortName: 'Samruddhi Mahamarg',
  length: 10000,           // m of carriageway modelled
  lanes: 4,                // including the reserved emergency lane
  laneWidth: 3.75,         // m, NHAI expressway standard
  medianHalf: 5.5,         // m, half of the depressed median
  shoulder: 3.0,           // m paved shoulder
  gantrySpacing: 1500,     // m between lane-control gantries
  fogFrom: 4200,           // ghat section where visibility collapses
  fogTo: 6100,
};

export const EMERGENCY_LANE = 0;                       // median-adjacent
export const LANE_LIMIT = [33.4, 27.8, 25.0, 22.3];    // —, 100, 90, 80 km/h
export const LANE_LABEL = ['EMERGENCY', '100', '90', '80'];

/** Lateral centre of a lane, metres from the corridor axis. dir +1 uses +y. */
export function laneY(dir, lane) {
  return dir * (EXP.medianHalf + EXP.laneWidth * (lane + 0.5));
}

/** Speed limit for a lane, given whether lane 0 is reserved. */
export function laneLimit(lane, dedicated = true) {
  if (lane === EMERGENCY_LANE) return dedicated ? LANE_LIMIT[0] : LANE_LIMIT[1];
  return LANE_LIMIT[lane];
}

/** Lanes a vehicle of this class may legally use. */
export function allowedLanes(spec, dedicated = true) {
  if (spec.heavy) return dedicated ? [2, 3] : [1, 2, 3];
  return dedicated ? [1, 2, 3] : [0, 1, 2, 3];
}

/** The lane a driver would settle in, given their desired speed. */
export function preferredLane(spec, v0, dedicated = true) {
  if (spec.heavy) return 3;
  if (!dedicated && v0 >= 28.5) return 0;
  if (v0 >= 27.0) return 1;
  if (v0 >= 24.5) return 2;
  return 3;
}

// Samruddhi fleet. No two-wheelers, no auto-rickshaws — they are banned from
// the expressway, which makes this a completely different mix from an urban
// arterial and is why the two scenarios cannot share a fleet.
export const VEHICLES = {
  car:   { len: 4.20, wid: 1.75, pcu: 1.0, share: 0.40, v0: 30.0, a: 1.8, b: 2.6, heavy: false, detect: 0.95 },
  suv:   { len: 4.80, wid: 1.90, pcu: 1.0, share: 0.24, v0: 29.0, a: 1.6, b: 2.5, heavy: false, detect: 0.96 },
  bus:   { len: 12.0, wid: 2.60, pcu: 3.0, share: 0.09, v0: 23.0, a: 0.8, b: 1.7, heavy: true,  detect: 0.98 },
  lcv:   { len: 7.00, wid: 2.30, pcu: 2.0, share: 0.12, v0: 23.5, a: 0.9, b: 1.9, heavy: true,  detect: 0.94 },
  truck: { len: 14.5, wid: 2.60, pcu: 3.5, share: 0.15, v0: 21.5, a: 0.6, b: 1.5, heavy: true,  detect: 0.97 },
};

export const AMBULANCE = { len: 6.1, wid: 2.20, pcu: 1.6, v0: 33.4, a: 1.7, b: 2.6 };

export const WEATHER = {
  clear: { detect: 1.00, vmax: 1.00, label: 'Clear' },
  rain:  { detect: 0.84, vmax: 0.88, label: 'Heavy rain' },
  fog:   { detect: 0.66, vmax: 0.80, label: 'Fog / low visibility' },
};

// Distances on the Samruddhi are the whole problem: posts sit ~50 km apart, so
// a unit is routinely twenty minutes from a casualty before traffic is even
// considered.
export const ROUTE = {
  postX: 150,
  postName: 'Ambulance post, Shirdi Interchange',
  incidentX: 9500,
  incidentName: 'Tyre-burst rollover, ch. 9.5',
};

export const DEFAULTS = {
  seed: 7,
  demand: 0.7,             // 0..1 of design flow
  dedicatedLane: true,     // false = the carriageway as built today
  encroachment: 0.16,      // fraction of drivers who will use the reserved lane
  compliance: 0.82,        // fraction who obey a gantry order promptly
  weather: 'clear',
  night: false,
  greenZone: 'adaptive',   // none | static | adaptive
  fog: true,
  enforcement: true,
};

/**
 * The four arms of the experiment, in the order they should be read. Arm 1 is
 * the Samruddhi as it exists today: no reserved corridor, an ambulance weaving
 * through general traffic on its siren alone.
 */
export const ARMS = [
  { dedicatedLane: false, greenZone: 'none',     label: 'Today — no reserved lane, siren only' },
  { dedicatedLane: true,  greenZone: 'none',     label: 'Reserved lane painted, no ITS warning' },
  { dedicatedLane: true,  greenZone: 'static',   label: 'Reserved lane + fixed 500 m green zone' },
  { dedicatedLane: true,  greenZone: 'adaptive', label: 'Reserved lane + adaptive green zone (this project)' },
];

export function gantryPositions() {
  const out = [];
  for (let x = 750; x < EXP.length; x += EXP.gantrySpacing) {
    out.push({ id: `G${out.length + 1}`, x, chainage: (x / 1000).toFixed(1) });
  }
  return out;
}

/** Free-flow benchmark for the response run. */
export function freeFlowTime() {
  const d = ROUTE.incidentX - ROUTE.postX;
  return d / AMBULANCE.v0 + AMBULANCE.v0 / AMBULANCE.a;
}
