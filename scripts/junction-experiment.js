// Four-arm junction: control strategies and emergency preemption.
// Produces the tables in the README.

import { JunctionWorld } from '../js/sim/junction/world.js';
import { STRATEGIES, EMERGENCY, ARMS } from '../js/sim/junction/config.js';

const SEEDS = Number(process.argv[2] ?? 8);
const DEMAND = Number(process.argv[3] ?? 0.85);

function run(cfg) {
  const w = new JunctionWorld(cfg);
  let guard = 0;
  while (!w.finished && w.t < 400 && guard < 2e6) { w.step(1 / 25); guard++; }
  // let the network keep running a while after the unit clears, so the
  // recovery cost lands in the delay figures rather than being cut off
  const until = w.t + 120;
  while (w.t < until && guard < 2e6) { w.step(1 / 25); guard++; }
  return w;
}

const agg = (rows, pick) => {
  const v = rows.map(pick).filter(Number.isFinite);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
  return { m, sd };
};
const f = (a) => `${a.m.toFixed(1)} ± ${a.sd.toFixed(1)}`;

console.log(`\n## Junction control strategies (demand ${DEMAND}, ${SEEDS} seeds, no ambulance)\n`);
console.log('| Strategy | Mean delay (s/veh) | Stops/veh | Throughput (veh) | IR undercount |');
console.log('|---|---|---|---|---|');
for (const key of Object.keys(STRATEGIES)) {
  const rows = [];
  for (let s = 1; s <= SEEDS; s++) {
    const w = run({ strategy: key, emergency: 'none', seed: s, demand: DEMAND, evAt: 1e9 });
    const under = ARMS.reduce((n, a) => n + w.sensors.get(a.id).missed, 0);
    const total = ARMS.reduce((n, a) => n + w.sensors.get(a.id).trueCrossings, 0);
    rows.push({ ...w.summary(), under: total ? (100 * under / total) : 0 });
  }
  console.log(`| ${STRATEGIES[key].label} | ${f(agg(rows, r => r.delay.mean))} | ${agg(rows, r => r.delay.n ? 0 : 0).m.toFixed(1)} | ${agg(rows, r => r.throughput).m.toFixed(0)} | ${agg(rows, r => r.under).m.toFixed(0)}% |`);
}

console.log(`\n## Ambulance through the junction\n`);
console.log('| Strategy | Emergency layer | Ambulance time (s) | Stops | Transition (s) | Other-arm delay (s/veh) |');
console.log('|---|---|---|---|---|---|');
for (const key of Object.keys(STRATEGIES)) {
  for (const em of Object.keys(EMERGENCY)) {
    const rows = [];
    for (let s = 1; s <= SEEDS; s++) rows.push(run({ strategy: key, emergency: em, seed: s, demand: DEMAND }).summary());
    const ok = rows.filter(r => r.ev);
    if (!ok.length) { console.log(`| ${STRATEGIES[key].label} | ${EMERGENCY[em].label} | — | — | — | — |`); continue; }
    console.log(`| ${STRATEGIES[key].label} | ${EMERGENCY[em].label} | ${f(agg(ok, r => r.ev.travelTime))} | ${agg(ok, r => r.ev.stops).m.toFixed(1)} | ${em === 'preempt' ? agg(ok, r => r.ev.transition).m.toFixed(1) : '—'} | ${agg(ok, r => r.delay.mean).m.toFixed(1)} |`);
  }
}
console.log('');
