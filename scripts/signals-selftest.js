// Invariants for the signalised-arterial scenario.

import { SignalWorld } from '../js/sim/signals/world.js';
import { websterPlan, JunctionSignal } from '../js/sim/signals/control.js';
import { SIGNAL, crossFloor, pedMinGreen, JUNCTIONS } from '../js/sim/signals/config.js';

let failures = 0;
const check = (n, c, d = '') => {
  if (c) console.log(`  ok   ${n}`);
  else { failures++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

console.log('\nWebster plan');
{
  const light = websterPlan(900, 400), heavy = websterPlan(2900, 1200);
  check('cycle grows with demand', heavy.cycle > light.cycle, `${light.cycle.toFixed(0)} vs ${heavy.cycle.toFixed(0)} s`);
  check('cycle stays within IRC bounds', heavy.cycle >= 60 && heavy.cycle <= 150, `${heavy.cycle.toFixed(0)} s`);
  check('cross green respects the pedestrian floor', heavy.crossGreen >= crossFloor() - 1e-6);
  check('arterial takes the larger share', heavy.artGreen > heavy.crossGreen);
}

console.log('\nSignal state machine');
{
  const sig = new JunctionSignal(JUNCTIONS[0], websterPlan(2000, 800));
  const strat = { greenFor: () => 20, shouldEnd: (s) => s.t >= 20 };
  const cams = { demand: () => 5, flow: () => 0.3 };
  const seen = new Set();
  let prev = sig.phase, prevAt = 0, minYellow = Infinity, illegal = 0;
  for (let i = 0; i < 40000; i++) {
    sig.step(0.02, i * 0.02, strat, cams);
    if (sig.phase !== prev) {
      const dur = i * 0.02 - prevAt;
      if (prev === 'ART_Y' || prev === 'CROSS_Y') minYellow = Math.min(minYellow, dur);
      if ((prev === 'ART_G' && sig.phase !== 'ART_Y') || (prev === 'CROSS_G' && sig.phase !== 'CROSS_Y')) illegal++;
      prev = sig.phase; prevAt = i * 0.02;
    }
    seen.add(sig.phase);
  }
  check('all six phases are reached', seen.size === 6, [...seen].join(','));
  check('a green never goes straight to red', illegal === 0, `${illegal}`);
  check('yellow is never shortened', minYellow >= SIGNAL.yellow - 0.03, `${minYellow.toFixed(2)} s`);

  // A preemption request must still pay the pedestrian minimum and clearance.
  const s2 = new JunctionSignal(JUNCTIONS[0], websterPlan(2000, 800));
  while (s2.phase !== 'CROSS_G') s2.step(0.02, 0, strat, cams);
  s2.t = 0;
  const predicted = s2.timeToGreen('art');
  s2.requestPreempt('EMS-108', 'art', 0);
  let el = 0;
  while (s2.phase !== 'ART_G' && el < 200) { s2.step(0.02, el, strat, cams); el += 0.02; }
  check('preemption honours the predicted transition', Math.abs(el - predicted) < 0.5,
    `predicted ${predicted.toFixed(2)} s, took ${el.toFixed(2)} s`);
  check('transition is at least ped-min + yellow + all-red',
    el >= pedMinGreen() + SIGNAL.yellow + SIGNAL.allRed - 0.1, `${el.toFixed(1)} s`);
}

console.log('\nCorridor behaviour');
{
  const w = new SignalWorld({ seed: 4, demand: 0.85, strategy: 'smart', emergency: 'corridor' });
  w.dispatch();
  let bad = 0, overlaps = 0;
  for (let i = 0; i < 15000 && !w.finished; i++) {
    w.step(1 / 25);
    if (i % 60) continue;
    for (const v of w.vehicles) if (!Number.isFinite(v.x) || !Number.isFinite(v.v)) bad++;
    for (const [, arr] of w.laneArrays) {
      for (let k = 1; k < arr.length; k++) {
        const a = arr[k - 1], b = arr[k];
        if ((a.x - b.x) * a.dir < -(a.len + b.len) / 2) overlaps++;
      }
    }
  }
  check('no NaN state', bad === 0, `${bad}`);
  check('no vehicles pass through each other', overlaps === 0, `${overlaps}`);
  check('the ambulance reaches the hospital', w.units[0].arrived);
  check('the coordinator settled on a common cycle', w.coordinator.cycle > 0, `${w.coordinator.cycle.toFixed(0)} s`);
  check('the coordinator identified a critical junction', !!w.coordinator.critical);
  check('cross streets were still served', (w.metrics.crossDelay ?? []).length > 20);

  const mean = (cfg) => {
    const out = [];
    for (let s = 1; s <= 5; s++) {
      const x = new SignalWorld({ ...cfg, seed: s, demand: 0.85 });
      x.dispatch();
      let g = 0;
      while (!x.finished && x.t < 900 && g < 2e6) { x.step(1 / 25); g++; }
      out.push(x.metrics.ev.travelTime);
    }
    return out.reduce((a, b) => a + b, 0) / out.length;
  };
  const none = mean({ strategy: 'coordinated', emergency: 'none' });
  const local = mean({ strategy: 'coordinated', emergency: 'local' });
  const corridor = mean({ strategy: 'coordinated', emergency: 'corridor' });
  console.log(`       siren only ${none.toFixed(1)}s | local preemption ${local.toFixed(1)}s | corridor scheduling ${corridor.toFixed(1)}s`);
  check('preemption beats siren alone', local < none, `${local.toFixed(1)} vs ${none.toFixed(1)}`);
  check('corridor scheduling beats acting locally', corridor < local, `${corridor.toFixed(1)} vs ${local.toFixed(1)}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
