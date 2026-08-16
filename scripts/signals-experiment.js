// Four signal-control scenarios x three emergency layers, on the urban arterial.
// Prints the tables used in the README.

import { SignalWorld } from '../js/sim/signals/world.js';
import { STRATEGIES, EMERGENCY } from '../js/sim/signals/config.js';

const SEEDS = Number(process.argv[2] ?? 6);
const DEMAND = Number(process.argv[3] ?? 0.85);

function run(cfg) {
  const w = new SignalWorld(cfg);
  w.dispatch();
  let guard = 0;
  while (!w.finished && w.t < 900 && guard < 2e6) { w.step(1 / 25); guard++; }
  return w.summary();
}

function agg(rows, pick) {
  const v = rows.map(pick).filter(Number.isFinite);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
  return { m, sd };
}
const f = (a) => `${a.m.toFixed(1)} ± ${a.sd.toFixed(1)}`;

console.log(`\n## Signal coordination — no emergency vehicle (demand ${DEMAND}, ${SEEDS} seeds)\n`);
console.log('| Scenario | Arterial delay (s/veh) | Cross delay (s/veh) | Throughput (PCU/h) | Cycle (s) |');
console.log('|---|---|---|---|---|');
const noEv = {};
for (const key of Object.keys(STRATEGIES)) {
  const rows = [];
  for (let s = 1; s <= SEEDS; s++) rows.push(run({ strategy: key, emergency: 'none', seed: s, demand: DEMAND }));
  noEv[key] = rows;
  const cyc = agg(rows, r => r.cycle || 0);
  console.log(`| ${STRATEGIES[key].label} | ${f(agg(rows, r => r.arterialDelay.mean))} | ${f(agg(rows, r => r.crossDelay.mean))} | ${agg(rows, r => r.pcuPerHour).m.toFixed(0)} | ${cyc.m > 0 ? cyc.m.toFixed(0) : '—'} |`);
}

console.log(`\n## Ambulance response, by signal scenario and emergency layer\n`);
console.log('| Signal scenario | Emergency layer | Response (s) | Stops | Cross delay (s/veh) | Preemptions |');
console.log('|---|---|---|---|---|---|');
for (const key of ['coordinated', 'smart']) {
  for (const em of Object.keys(EMERGENCY)) {
    const rows = [];
    for (let s = 1; s <= SEEDS; s++) rows.push(run({ strategy: key, emergency: em, seed: s, demand: DEMAND }));
    console.log(`| ${STRATEGIES[key].label} | ${EMERGENCY[em].label} | ${f(agg(rows, r => r.ev.travelTime))} | ${agg(rows, r => r.ev.stops).m.toFixed(1)} | ${agg(rows, r => r.crossDelay.mean).m.toFixed(1)} | ${agg(rows, r => r.preemptions).m.toFixed(1)} |`);
  }
}
console.log('');
