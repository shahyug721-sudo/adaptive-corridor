// Scenario 3 — a single four-arm signalised junction with emergency preemption.
//
// This scenario is the one described (but not implemented) in the BE Academic
// Final Project: a Raspberry Pi reading four IR sensors, one per approach,
// classifying each arm's density and "finally providing a way to the ambulance".
// That repository senses and uploads to Firebase; it never drives a light and
// has no ambulance logic. Here the sensing model is reproduced faithfully —
// including its limitations — and the control half is actually built.
//
// PHASING
//   Four-phase, one arm at a time, matching that project's four independent
//   signals and normal practice at Indian junctions with heavy turning volumes.
//   It costs capacity compared to opposed pairs, but it buys something the
//   emergency case needs: while an arm is green, no conflicting movement exists
//   anywhere in the junction box, so an ambulance released onto its approach has
//   a genuinely clear path rather than one that merely has right of way.
//
// GEOMETRY
//   Junction centre is the origin. Each arm has an outward unit vector d.
//   Incoming vehicles travel along -d. India drives on the left, so approach
//   lanes sit on the perp(d) = (d.y, -d.x) side; exit lanes on the other.

export const JUNCTION = {
  name: 'Sector 24 Junction, Nerul',
  armLength: 190,        // m of each approach modelled
  lanes: 2,              // approach lanes per arm
  laneWidth: 3.5,
  medianHalf: 1.2,
  boxHalf: 13,           // m, half-width of the junction box
  irDistance: 32,        // m upstream of the stop line where the IR beam sits
};

/** The four arms, in the phase order the controller cycles through. */
export const ARMS = [
  { id: 'N', name: 'North — Palm Beach Rd', dx: 0,  dy: 1,  demand: 900 },
  { id: 'E', name: 'East — Sector 24 Link', dx: 1,  dy: 0,  demand: 520 },
  { id: 'S', name: 'South — Palm Beach Rd', dx: 0,  dy: -1, demand: 860 },
  { id: 'W', name: 'West — Station Road',   dx: -1, dy: 0,  demand: 640 },
];

/** Lateral unit vector for an arm: approach lanes lie on this side. */
export function perp(arm) {
  return { x: arm.dy, y: -arm.dx };
}

/** World position of a vehicle `s` metres from the junction centre, in `lane`. */
export function armPosition(arm, s, lane, offset = 0) {
  const p = perp(arm);
  const lat = JUNCTION.medianHalf + JUNCTION.laneWidth * (lane + 0.5) + offset;
  return { x: arm.dx * s + p.x * lat, y: arm.dy * s + p.y * lat };
}

/** Heading of an approaching vehicle, in radians, for rendering. */
export function armHeading(arm) {
  return Math.atan2(-arm.dy, -arm.dx);
}

// Indian urban mixed traffic. PCU factors follow IRC:106-1990.
export const VEHICLES = {
  motorcycle: { len: 1.95, wid: 0.72, pcu: 0.5, share: 0.34, v0: 13.5, a: 2.2, b: 3.0, filter: true },
  car:        { len: 4.15, wid: 1.72, pcu: 1.0, share: 0.27, v0: 13.0, a: 1.6, b: 2.4, filter: false },
  auto:       { len: 2.60, wid: 1.40, pcu: 0.8, share: 0.17, v0: 10.5, a: 1.3, b: 2.2, filter: true },
  suv:        { len: 4.70, wid: 1.88, pcu: 1.0, share: 0.08, v0: 13.5, a: 1.5, b: 2.4, filter: false },
  bus:        { len: 11.0, wid: 2.55, pcu: 3.0, share: 0.05, v0: 10.0, a: 0.9, b: 1.8, filter: false },
  lcv:        { len: 6.20, wid: 2.20, pcu: 2.0, share: 0.09, v0: 11.0, a: 1.0, b: 2.0, filter: false },
};

export const AMBULANCE = { len: 5.9, wid: 2.15, pcu: 1.6, v0: 15.0, a: 1.9, b: 2.8 };

/** Turning split. Left turns are kerb-side in India and the easiest movement. */
export const TURNS = { through: 0.58, left: 0.27, right: 0.15 };

export const SIGNAL = {
  yellow: 3.0,
  allRed: 2.0,
  minGreen: 8,
  maxGreen: 45,
  fixedGreen: 22,
  startupLost: 2.4,
  satFlowPerLane: 0.5,      // PCU/s/lane — 1800 PCU/h/lane
  pedSpeed: 1.2,
};

/**
 * Pedestrian crossing time across one approach. With four-phase operation the
 * pedestrian phase runs parallel to the arm that is stopped, so the floor
 * applies to the *red* an arm must serve, not to its green.
 */
export function pedCrossTime() {
  return (JUNCTION.laneWidth * JUNCTION.lanes * 2 + JUNCTION.medianHalf * 2) / SIGNAL.pedSpeed;
}

/**
 * IR sensor thresholds, taken verbatim from the BE project's traffic.py:
 *   count < 2  -> loose, 2..5 -> moderate, > 5 -> congested.
 * They are counts of beam interruptions, not vehicles and not PCU, which is
 * the crux of what that sensor can and cannot tell you.
 */
export const IR_TIERS = { loose: 2, moderate: 5 };
export const TIER_NAMES = ['loose', 'moderate', 'congested'];

/** Green time each density tier earns under the tier-based strategy. */
export const TIER_GREEN = { loose: 12, moderate: 22, congested: 36 };

export const STRATEGIES = {
  fixed: {
    label: 'Fixed equal green',
    blurb: 'Every arm gets the same 22 s regardless of demand. The status quo at most junctions.',
  },
  tier: {
    label: 'IR density tiers (BE project design)',
    blurb: 'Green from the loose / moderate / congested tier, exactly as that project classifies it.',
  },
  smart: {
    label: 'Smart queue-clearance control',
    blurb: 'Green sized to discharge the measured queue at saturation flow, with gap-out, max green and anti-starvation.',
  },
};

export const EMERGENCY = {
  none:    { label: 'None — the ambulance queues like everyone else' },
  preempt: { label: 'Preemption — all other arms red, ambulance arm green' },
};

export const DEFAULTS = {
  seed: 7,
  demand: 0.8,
  strategy: 'smart',
  emergency: 'preempt',
  sensor: 'ir',            // ir | camera
  evArm: 'W',
  evAt: 40,                // s into the run when the ambulance is dispatched
  detectRange: 140,        // m at which the ambulance is detected on its approach
};

export const TRAFFIC = { jamGap: 1.6, headway: 1.15 };
