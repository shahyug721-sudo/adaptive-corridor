// Headless scenario runner — used by the Node self-test, the experiment script
// and the in-browser dashboard, so every number quoted anywhere comes from the
// same code path as the animation.

import { World } from './world.js';
import { ARMS } from './config.js';

/** Run one replication to completion (or timeout) and return its summary. */
export function runScenario(cfg, { maxTime = 900, dt = 1 / 25 } = {}) {
  const world = new World(cfg);
  world.dispatch();
  let guard = 0;
  while (!world.finished && world.t < maxTime && guard < 2e6) { world.step(dt); guard++; }
  const s = world.summary();
  s.completed = world.finished;
  return s;
}

export function aggregate(runs, pick) {
  const vals = runs.map(pick).filter(v => Number.isFinite(v));
  if (!vals.length) return { mean: NaN, sd: NaN, n: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1));
  return { mean, sd, n: vals.length };
}

/**
 * Welch's t-test. Reported alongside every comparison because a 15 % improvement
 * measured on one seed is not a result — it is an anecdote.
 */
export function welch(a, b) {
  const va = a.sd ** 2 / a.n, vb = b.sd ** 2 / b.n;
  const t = (a.mean - b.mean) / Math.sqrt(va + vb || 1e-9);
  const df = (va + vb) ** 2 / ((va ** 2) / (a.n - 1) + (vb ** 2) / (b.n - 1) || 1e-9);
  return { t, df, significant: Math.abs(t) > 2.0 && df > 5 };
}

/** Run the full four-arm grid over `seeds` replications each. */
export function runExperiment(seeds = 8, base = {}, onProgress) {
  const results = [];
  let done = 0;
  for (const arm of ARMS) {
    const runs = [];
    for (let s = 1; s <= seeds; s++) {
      runs.push(runScenario({ ...base, ...arm, seed: s }));
      onProgress?.(++done, ARMS.length * seeds, arm);
    }
    results.push({
      arm,
      label: arm.label,
      runs,
      travel: aggregate(runs, r => r.ev?.travelTime),
      delay: aggregate(runs, r => r.ev?.delay),
      slowdowns: aggregate(runs, r => r.ev?.slowdowns),
      meanSpeed: aggregate(runs, r => r.ev?.meanSpeed),
      mainlineDelay: aggregate(runs, r => r.mainlineDelay.mean),
      zoneLength: aggregate(runs, r => r.zone.meanLength),
      violations: aggregate(runs, r => r.zone.violations),
      vslVehicles: aggregate(runs, r => r.zone.vslVehicles),
    });
  }
  return results;
}
