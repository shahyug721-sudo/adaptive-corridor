// Scenario 3 entry point: the four-arm junction with emergency preemption.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { JunctionWorld } from './sim/junction/world.js';
import { ARMS, JUNCTION, STRATEGIES } from './sim/junction/config.js';
import { createScene } from './render/scene.js';
import {
  buildJunctionScene, updateSignalHead, JunctionFleet,
  buildJunctionAmbulance, updateJunctionAmbulance,
} from './render/junction3d.js';

const $ = (id) => document.getElementById(id);

const container = document.getElementById('view');
const { renderer, scene, camera, sun } = createScene(container);
scene.fog = new THREE.Fog(0xbfd4e0, 260, 900);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 30;
controls.maxDistance = 420;
controls.target.set(0, 0, 0);
camera.position.set(95, 78, 105);

sun.position.set(-120, 190, 110);
sun.target.position.set(0, 0, 0);
sun.target.updateMatrixWorld();
Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160 });
sun.shadow.camera.updateProjectionMatrix();

const junction = buildJunctionScene(scene);
const fleet = new JunctionFleet(scene);
const ambulance = buildJunctionAmbulance(scene);

let world = new JunctionWorld(readConfig());
window.__world = world;

/* ---------------- controls ---------------- */

let speedMul = 1;
let running = true;
let logSeen = 0;

function readConfig() {
  return {
    seed: 7,
    demand: +($('demand')?.value ?? 0.85),
    strategy: $('strategy')?.value ?? 'smart',
    emergency: $('emergency')?.value ?? 'preempt',
    evArm: $('evArm')?.value ?? 'W',
    evAt: 1e9,                       // dispatched by the button, not on a timer
  };
}

function restart() {
  world = new JunctionWorld(readConfig());
  window.__world = world;
  logSeen = 0;
  $('log').innerHTML = '';
  $('dispatch').disabled = false;
}

$('dispatch').addEventListener('click', () => {
  world.cfg.evAt = world.t;
  world.dispatchEv();
  $('dispatch').disabled = true;
});
$('reset').addEventListener('click', restart);
$('pause').addEventListener('click', () => {
  running = !running;
  $('pause').textContent = running ? '❚❚ Pause' : '▶ Resume';
});
document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => {
  speedMul = +b.dataset.speed;
  document.querySelectorAll('[data-speed]').forEach(x => x.classList.toggle('on', x === b));
}));
for (const id of ['strategy', 'emergency', 'evArm', 'demand']) {
  $(id).addEventListener('change', restart);
}
$('demand').addEventListener('input', () => { $('demandVal').textContent = (+$('demand').value).toFixed(2); });
$('strategy').addEventListener('change', () => {
  $('strategyBlurb').textContent = STRATEGIES[$('strategy').value].blurb;
});
$('strategyBlurb').textContent = STRATEGIES[$('strategy').value].blurb;

/* ---------------- HUD ---------------- */

const TIER_CLASS = { loose: 'ok', moderate: 'warn', congested: 'bad' };

function updateHud() {
  const rows = world.sensorReadings();
  const body = $('arms');
  if (body.children.length !== rows.length) {
    body.innerHTML = rows.map(() => '<tr><td></td><td></td><td></td><td></td><td></td></tr>').join('');
  }
  rows.forEach((r, i) => {
    const tr = body.children[i];
    tr.className = r.green ? 'green' : '';
    tr.children[0].innerHTML = `<span class="dot ${r.aspect}"></span>${r.arm}`;
    tr.children[1].textContent = r.aspect.toUpperCase();
    tr.children[2].innerHTML = `<span class="tier ${TIER_CLASS[r.tier]}">${r.tier}</span>`;
    tr.children[3].textContent = r.count;
    tr.children[4].textContent = r.truePcu.toFixed(1);
  });

  $('phase').textContent = `${world.greenArm.id} · ${world.state.toUpperCase()}`;
  $('phaseT').textContent = `${world.phaseT.toFixed(1)} s`;
  $('clock').textContent = fmt(world.t);

  const ev = world.ev;
  const p = world.preempt;
  if (p) {
    $('evState').textContent = p.grantedAt === null ? 'CLEARING JUNCTION' : 'AMBULANCE HAS GREEN';
    $('evState').className = p.grantedAt === null ? 'warn' : 'ev';
    $('transition').textContent = p.grantedAt === null
      ? `${(world.t - p.requestedAt).toFixed(1)} s elapsed`
      : `${world.stats.transitionTime.toFixed(1)} s`;
  } else if (ev && ev.arrivedT !== null) {
    $('evState').textContent = 'CLEARED';
    $('evState').className = 'ok';
    $('transition').textContent = `${world.stats.transitionTime.toFixed(1)} s`;
  } else if (ev) {
    $('evState').textContent = ev.detected ? 'APPROACHING' : 'EN ROUTE';
    $('evState').className = 'ev';
    $('transition').textContent = '—';
  } else {
    $('evState').textContent = 'STANDBY';
    $('evState').className = '';
    $('transition').textContent = '—';
  }

  if (ev) {
    const done = ev.arrivedT !== null;
    $('evTime').textContent = `${((done ? ev.arrivedT : world.t) - ev.dispatchT).toFixed(1)} s`;
    $('evStops').textContent = ev.stops;
  } else {
    $('evTime').textContent = '—';
    $('evStops').textContent = '—';
  }

  const under = ARMS.reduce((n, a) => n + world.sensors.get(a.id).missed, 0);
  const total = ARMS.reduce((n, a) => n + world.sensors.get(a.id).trueCrossings, 0);
  $('undercount').textContent = total ? `${Math.round(100 * under / total)}%` : '—';
  $('delay').textContent = world.metrics.mainlineDelay.n
    ? `${world.metrics.mainlineDelay.mean.toFixed(1)} s`
    : '—';

  while (logSeen < world.events.length) {
    const e = world.events[logSeen++];
    const div = document.createElement('div');
    div.className = 'entry ' + (e.kind || 'info');
    div.innerHTML = `<b>${fmt(e.t)}</b>${e.msg}`;
    $('log').prepend(div);
    while ($('log').children.length > 30) $('log').lastChild.remove();
  }
}

function fmt(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/* ---------------- loop ---------------- */

const STEP = 1 / 50;
let acc = 0, last = performance.now();

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const wall = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (running) {
    acc += wall * speedMul;
    let n = 0;
    while (acc >= STEP && n < 30) { world.step(STEP); acc -= STEP; n++; }
  }

  for (const view of junction.signals) updateSignalHead(view, world.aspect(view.armId));
  fleet.update(world.vehicles.filter(v => v.kind !== 'ev'));
  updateJunctionAmbulance(ambulance, world.ev && world.ev.arrivedT === null ? world.ev : null, world.t);

  controls.update();
  updateHud();
  renderer.render(scene, camera);
}

tick();
