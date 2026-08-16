// Urban arterial scenario — Palm Beach Road, Nerul → Vashi (Navi Mumbai).
//
// A divided six-lane arterial with signalised cross streets at irregular
// spacing. The irregular spacing is the point: a single cycle length cannot
// give every link a perfect green band, so coordination is a compromise that
// has to be computed rather than assumed.

export const ART = {
  name: 'Palm Beach Road — Nerul → Vashi',
  length: 1900,          // m of arterial modelled
  lanes: 3,              // per direction
  laneWidth: 3.5,
  medianHalf: 1.9,
  shoulder: 0.8,
  footpath: 3.0,
  crossLanes: 2,
  crossHalf: 150,        // m of cross street modelled either side
  junctionHalf: 11,
};

// Six junctions. Cross demand is the design flow in PCU/h for both approaches.
export const JUNCTIONS = [
  { id: 'J1', name: 'Sector 19A Chowk',     x: 210,  crossDemand: 620 },
  { id: 'J2', name: 'Nerul Station Road',   x: 500,  crossDemand: 980 },
  { id: 'J3', name: 'Sector 24 Junction',   x: 760,  crossDemand: 540 },
  { id: 'J4', name: 'Seawoods Grand Chowk', x: 1080, crossDemand: 1150 },
  { id: 'J5', name: 'Sector 30 Crossing',   x: 1360, crossDemand: 470 },
  { id: 'J6', name: 'Sanpada Link Road',    x: 1680, crossDemand: 860 },
];

/** Lateral centre of an arterial lane. India drives on the left, dir +1 uses +y. */
export function laneY(dir, lane) {
  return dir * (ART.medianHalf + ART.laneWidth * (lane + 0.5));
}

/** The emergency corridor runs against the median — the overtaking side. */
export function corridorY(dir) {
  return dir * (ART.medianHalf + 1.15);
}

/** Cross-street lane centre in world x, at a junction. */
export function crossLaneX(junctionX, dir, lane) {
  return junctionX - dir * ART.laneWidth * (lane + 0.5);
}

// Indian urban mixed traffic. PCU factors follow IRC:106-1990.
// `filter` marks vehicles that creep between lanes in stopped queues — the
// two-wheeler behaviour that breaks lane discipline, causes camera occlusion,
// and re-fills a corridor that has just been opened.
export const VEHICLES = {
  motorcycle: { len: 1.95, wid: 0.72, pcu: 0.5, share: 0.32, v0: 15.5, a: 2.2, b: 3.0, filter: true,  detect: 0.80 },
  car:        { len: 4.15, wid: 1.72, pcu: 1.0, share: 0.28, v0: 15.0, a: 1.6, b: 2.4, filter: false, detect: 0.95 },
  auto:       { len: 2.60, wid: 1.40, pcu: 0.8, share: 0.16, v0: 11.5, a: 1.3, b: 2.2, filter: true,  detect: 0.88 },
  suv:        { len: 4.70, wid: 1.88, pcu: 1.0, share: 0.09, v0: 15.5, a: 1.5, b: 2.4, filter: false, detect: 0.96 },
  bus:        { len: 11.0, wid: 2.55, pcu: 3.0, share: 0.06, v0: 11.0, a: 0.9, b: 1.8, filter: false, detect: 0.98 },
  lcv:        { len: 6.20, wid: 2.20, pcu: 2.0, share: 0.09, v0: 12.5, a: 1.0, b: 2.0, filter: false, detect: 0.94 },
};

export const AMBULANCE = { len: 5.9, wid: 2.15, pcu: 1.6, v0: 18.0, a: 1.9, b: 2.8 };

export const TRAFFIC = {
  satFlowPerLane: 0.5,     // PCU/s/lane — 1800 PCU/h/lane, the urban design value
  startupLost: 2.4,        // s of lost time at green onset
  jamGap: 1.6,
  headway: 1.15,
  progressionSpeed: 12.5,  // m/s, the design speed a green wave is cut for
};

export const SIGNAL = {
  yellow: 3.0,
  allRed: 2.0,
  minGreenArterial: 12,
  minGreenCross: 14,
  maxGreenArterial: 65,
  maxGreenCross: 45,
  pedSpeed: 1.2,           // m/s, IRC design walking speed
};

export const ROUTE = {
  startX: 40,
  hospitalX: 1860,
  hospitalName: 'MGM Hospital, Vashi',
  incidentName: 'RTA — Palm Beach Rd, Nerul',
};

/**
 * Pedestrian crossing time — the hard floor on cross-street green.
 *
 * The arterial has a planted median wide enough to stand in, so pedestrians
 * cross in two stages using it as a refuge, as they actually do on Palm Beach
 * Road. The floor is therefore half the carriageway, not the whole 25 m. A
 * single-stage assumption would force a 25 s cross green at every junction and
 * quietly cripple every adaptive strategy in the comparison.
 */
export function pedMinGreen() {
  const stage = ART.laneWidth * ART.lanes + ART.medianHalf;
  return stage / SIGNAL.pedSpeed + 4;
}

export const crossFloor = () => Math.max(SIGNAL.minGreenCross, pedMinGreen());

/**
 * The four control scenarios, in the order they should be read.
 *
 * `isolated` exists because it is the intuitive answer and it is wrong. Making
 * every junction individually responsive measures better at each junction and
 * worse end-to-end, because each one releases platoons out of step with the
 * next. That result is the argument for `smart`.
 */
export const STRATEGIES = {
  fixed: {
    label: 'Fixed-time, uncoordinated',
    blurb: 'Webster plan per junction, no offsets. What most Indian arterials run today.',
  },
  coordinated: {
    label: 'Fixed-time, coordinated green wave',
    blurb: 'Same plans, offsets cut for a 45 km/h platoon. A fair, non-trivial baseline.',
  },
  isolated: {
    label: 'Adaptive, each junction alone',
    blurb: 'Vehicle-actuated on camera demand, gap-out, no common cycle. Locally optimal, globally worse.',
  },
  smart: {
    label: 'Smart coordinated adaptive (this project)',
    blurb: 'Junctions share measured flow: one cycle from the critical junction, per-junction splits from local demand, offsets from measured platoon speed.',
  },
};

export const EMERGENCY = {
  none:     { label: 'None — siren only' },
  local:    { label: 'Local preemption at each junction' },
  corridor: { label: 'Corridor-wide just-in-time scheduling' },
};

export const DEFAULTS = {
  seed: 7,
  demand: 0.8,
  compliance: 0.78,
  strategy: 'smart',
  emergency: 'corridor',
  weather: 'clear',
  noiseFloor: 68,
};

export const WEATHER = {
  clear: { detect: 1.00, vmax: 1.00, label: 'Clear' },
  rain:  { detect: 0.84, vmax: 0.88, label: 'Heavy rain' },
  fog:   { detect: 0.66, vmax: 0.80, label: 'Fog' },
};

export const ARTERIAL_DESIGN_FLOW = 2900;   // PCU/h per direction at demand 1.0

export function freeFlowTime() {
  const d = ROUTE.hospitalX - ROUTE.startX;
  return d / AMBULANCE.v0 + AMBULANCE.v0 / AMBULANCE.a;
}
