// Invariants for the four-arm junction scenario.
//
// The claim being tested is specific: when an ambulance is detected on one arm,
// every other arm goes red, that arm goes green, the unit passes, and normal
// cycling resumes — without any of it skipping a clearance interval.

import { JunctionWorld } from '../js/sim/junction/world.js';
import { ARMS, SIGNAL, JUNCTION, TIER_GREEN } from '../js/sim/junction/config.js';

let failures = 0;
const check = (n, c, d = '') => {
  if (c) console.log(`  ok   ${n}`);
  else { failures++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

const run = (cfg, steps = 12000) => {
  const w = new JunctionWorld(cfg);
  for (let i = 0; i < steps && !w.finished; i++) w.step(1 / 25);
  return w;
};

console.log('\nPhase machine safety');
{
  const w = new JunctionWorld({ seed: 2, emergency: 'none' });
  let conflicts = 0, shortYellow = 0, shortAllRed = 0, bad = 0;
  let prevState = w.state, prevAt = 0;
  for (let i = 0; i < 40000; i++) {
    w.step(1 / 25);
    const t = i / 25;

    // never more than one arm green at a time
    const greens = ARMS.filter(a => w.aspect(a.id) === 'green').length;
    if (greens > 1) conflicts++;

    // no two vehicles from different arms inside the box at once
    const inBox = w.vehicles.filter(v => v.inBox);
    const arms = new Set(inBox.map(v => v.arm));
    if (arms.size > 1) bad++;

    if (w.state !== prevState) {
      const dur = t - prevAt;
      if (prevState === 'yellow' && dur < SIGNAL.yellow - 0.05) shortYellow++;
      if (prevState === 'allRed' && dur < SIGNAL.allRed - 0.05) shortAllRed++;
      prevState = w.state; prevAt = t;
    }
  }
  check('only one arm is ever green', conflicts === 0, `${conflicts}`);
  check('no conflicting movements share the junction box', bad === 0, `${bad}`);
  check('yellow is never shortened', shortYellow === 0, `${shortYellow}`);
  check('all-red is never shortened', shortAllRed === 0, `${shortAllRed}`);
  check('every arm gets served', ARMS.every(a => w.lastServed.get(a.id) > 0));
}

console.log('\nEmergency preemption');
{
  const w = new JunctionWorld({ seed: 5, emergency: 'preempt', evArm: 'W', evAt: 40 });
  let sawOthersRed = false, grantedAt = null, sawAllRed = false, allRedSpan = 0;
  let inAllRed = false, span = 0;
  for (let i = 0; i < 20000 && !w.finished; i++) {
    w.step(1 / 25);
    // Track the all-red that must separate the interrupted green from the
    // ambulance's green. Asserting a fixed transition *duration* would be
    // wrong: if the request lands while the running arm is already in yellow,
    // a correct transition is legitimately shorter than yellow + all-red.
    // What must always hold is that a full all-red is served in between.
    if (w.preempt && w.preempt.grantedAt === null) {
      if (w.state === 'allRed') { inAllRed = true; span += 1 / 25; }
      else if (inAllRed) { allRedSpan = Math.max(allRedSpan, span); inAllRed = false; span = 0; }
    }
    if (w.preempt && w.preempt.grantedAt !== null && grantedAt === null) {
      grantedAt = w.preempt.grantedAt;
      if (inAllRed) allRedSpan = Math.max(allRedSpan, span);
      sawAllRed = allRedSpan >= SIGNAL.allRed - 0.08;
      // at the moment of grant, W must be green and every other arm red
      const others = ARMS.filter(a => a.id !== 'W').every(a => w.aspect(a.id) === 'red');
      if (w.aspect('W') === 'green' && others) sawOthersRed = true;
    }
  }
  check('the ambulance cleared the junction', w.finished && w.ev.arrivedT !== null);
  check('preemption fired exactly once', w.stats.preemptions === 1, `${w.stats.preemptions}`);
  check('all other arms were red when the ambulance got green', sawOthersRed);
  check('a full all-red separated the interrupted green from the ambulance green',
    sawAllRed, `longest all-red ${allRedSpan.toFixed(2)} s, floor ${SIGNAL.allRed} s`);
  check('normal cycling resumed afterwards', w.preempt === null);
  console.log(`       transition ${w.stats.transitionTime.toFixed(1)} s, ambulance through in ${(w.ev.arrivedT - w.ev.dispatchT).toFixed(1)} s`);
}

console.log('\nPreemption is worth doing');
{
  const seeds = [1, 2, 3, 4, 5, 6];
  const mean = (cfg) => {
    const out = [];
    for (const s of seeds) {
      const w = run({ ...cfg, seed: s });
      if (w.ev && w.ev.arrivedT !== null) out.push(w.ev.arrivedT - w.ev.dispatchT);
    }
    return out.reduce((a, b) => a + b, 0) / out.length;
  };
  const none = mean({ emergency: 'none', evArm: 'W' });
  const pre = mean({ emergency: 'preempt', evArm: 'W' });
  console.log(`       queues normally ${none.toFixed(1)} s | preemption ${pre.toFixed(1)} s`);
  check('preemption gets the ambulance through faster', pre < none, `${pre.toFixed(1)} vs ${none.toFixed(1)}`);
}

console.log('\nIR sensor limitations are reproduced');
{
  const w = run({ seed: 3, demand: 1.0, emergency: 'none' }, 20000);
  const missed = ARMS.reduce((n, a) => n + w.sensors.get(a.id).missed, 0);
  check('the IR beam undercounts vehicles abreast', missed > 0, `${missed} missed`);
  const tiers = new Set(ARMS.map(a => w.sensors.get(a.id).tier));
  check('tiers do not latch permanently to congested', !(tiers.size === 1 && tiers.has('congested')),
    [...tiers].join(','));
  check('tier green times are ordered', TIER_GREEN.loose < TIER_GREEN.moderate && TIER_GREEN.moderate < TIER_GREEN.congested);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
