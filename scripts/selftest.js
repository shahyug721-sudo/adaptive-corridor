// Sanity invariants for the simulation core. Run with `npm test`.
//
// These are not a proof of realism. They catch the failures that silently
// poison a traffic model — NaNs, vehicles passing through each other, an
// ambulance that never arrives, a "result" that is really just one lucky seed.

import { World } from '../web/js/sim/world.js';
import { runScenario, aggregate, welch } from '../web/js/sim/runner.js';
import { EXP, ROUTE, EMERGENCY_LANE, freeFlowTime } from '../web/js/sim/config.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

/* ---------------- physics integrity ---------------- */
section('World integrity over a full run');
{
  const w = new World({ seed: 3, demand: 0.8 });
  w.dispatch();
  let bad = 0, reversed = 0, overlaps = 0, illegalLane = 0;
  for (let i = 0; i < 15000 && !w.finished; i++) {
    w.step(1 / 25);
    if (i % 40) continue;
    for (const v of w.vehicles) {
      if (!Number.isFinite(v.x) || !Number.isFinite(v.v)) bad++;
      if (v.v < -1e-6) reversed++;
      if (v.lane < 0 || v.lane >= EXP.lanes) illegalLane++;
    }
    for (const [, arr] of w.laneArrays) {
      for (let k = 1; k < arr.length; k++) {
        const a = arr[k - 1], b = arr[k];
        if ((a.x - b.x) * a.dir < -(a.len + b.len) / 2) overlaps++;
      }
    }
  }
  check('no NaN state', bad === 0, `${bad}`);
  check('no vehicle drives backwards', reversed === 0, `${reversed}`);
  check('no vehicles pass through each other', overlaps === 0, `${overlaps}`);
  check('every vehicle stays on the carriageway', illegalLane === 0, `${illegalLane}`);
  check('the ambulance reaches the incident', w.units[0].arrived, `stopped at ch. ${(w.units[0].x / 1000).toFixed(2)}`);
  check('run terminates within the horizon', w.t < 600, `${w.t.toFixed(0)} s`);
}

/* ---------------- lane discipline ---------------- */
section('Reserved lane discipline');
{
  const strict = new World({ seed: 5, demand: 0.8, encroachment: 0.0 });
  for (let i = 0; i < 3000; i++) strict.step(1 / 25);
  check('with zero encroachment the corridor stays empty',
    strict.encroachers(1).length === 0, `${strict.encroachers(1).length} vehicles`);

  const loose = new World({ seed: 5, demand: 0.8, encroachment: 0.5, greenZone: 'none' });
  let peak = 0;
  for (let i = 0; i < 6000; i++) { loose.step(1 / 25); peak = Math.max(peak, loose.encroachers(1).length); }
  check('encroachment actually populates the corridor', peak > 0, `peak ${peak}`);
  check('gantry cameras log the violations',
    loose.gantries.reduce((n, g) => n + g.violations, 0) > 0);

  const open = new World({ seed: 5, demand: 0.8, dedicatedLane: false });
  for (let i = 0; i < 2000; i++) open.step(1 / 25);
  check('without a reserved lane, lane 0 carries ordinary traffic',
    open.encroachers(1).length > 0, `${open.encroachers(1).length}`);
}

/* ---------------- green zone sizing ---------------- */
section('Adaptive green zone');
{
  const w = new World({ seed: 9, demand: 0.9, greenZone: 'adaptive' });
  w.dispatch();
  const lengths = [];
  for (let i = 0; i < 6000 && !w.finished; i++) {
    w.step(1 / 25);
    if (w.zone.active) lengths.push(w.zone.length);
  }
  const min = Math.min(...lengths), max = Math.max(...lengths);
  check('zone length responds to conditions', max - min > 20, `${min.toFixed(0)}–${max.toFixed(0)} m`);
  check('zone stays within its bounds', min >= 250 - 1e-6 && max <= 1500 + 1e-6, `${min.toFixed(0)}–${max.toFixed(0)} m`);

  // The zone reaches 500 m *ahead* of the unit; its total span also covers the
  // 40 m behind, which is why this checks the forward reach rather than length.
  const fixed = new World({ seed: 9, demand: 0.9, greenZone: 'static' });
  fixed.dispatch();
  for (let i = 0; i < 200; i++) fixed.step(1 / 25);
  // Tolerance covers the unit advancing within the step after the zone was set.
  const reach = fixed.zone.end - fixed.units[0].x;
  check('the fixed zone really is fixed', Math.abs(reach - 500) < 2.0, `${reach.toFixed(1)} m`);
}

/* ---------------- reproducibility and the headline result ---------------- */
section('Reproducibility and the four arms');
{
  const a = runScenario({ seed: 11, demand: 0.9 });
  const b = runScenario({ seed: 11, demand: 0.9 });
  check('same seed gives an identical result',
    Math.abs(a.ev.travelTime - b.ev.travelTime) < 1e-9);

  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const arm = (cfg) => aggregate(seeds.map(s => runScenario({ ...cfg, seed: s, demand: 0.9 })), r => r.ev.travelTime);
  const today = arm({ dedicatedLane: false, greenZone: 'none' });
  const painted = arm({ dedicatedLane: true, greenZone: 'none' });
  const adaptive = arm({ dedicatedLane: true, greenZone: 'adaptive' });
  console.log(`       today ${today.mean.toFixed(1)}s | reserved lane ${painted.mean.toFixed(1)}s | + adaptive zone ${adaptive.mean.toFixed(1)}s`);

  const test = welch(today, adaptive);
  check('the reserved lane beats the status quo', painted.mean < today.mean,
    `${painted.mean.toFixed(1)} vs ${today.mean.toFixed(1)}`);
  check('the improvement is statistically significant', test.significant,
    `t=${test.t.toFixed(2)}, df=${test.df.toFixed(1)}`);
  check('no arm beats free-flow', adaptive.mean > freeFlowTime(),
    `${adaptive.mean.toFixed(1)} vs ${freeFlowTime().toFixed(1)}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
