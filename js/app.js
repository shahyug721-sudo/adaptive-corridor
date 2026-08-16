// Entry point: wires the Samruddhi simulation to the 3D view.
//
// The simulation runs on a fixed timestep and the renderer only reads from it,
// so speeding the display up or dropping frames changes nothing about the
// physics or the numbers — a run at 8x is the same run as at 1x.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { World } from './sim/world.js';
import { EXP, ROUTE, EMERGENCY_LANE, laneY } from './sim/config.js';
import { createScene, createFogBand } from './render/scene.js';
import { buildRoad } from './render/road.js';
import { buildGantry, updateGantry, buildScenery, buildIncident, buildAmbulancePost } from './render/props.js';
import { FleetRenderer, buildAmbulance, updateAmbulance } from './render/vehicles.js';

const $ = (id) => document.getElementById(id);
const container = $('view');
const { renderer, scene, camera, sun } = createScene(container);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 12;
controls.maxDistance = 1200;
controls.enabled = false;

let world = new World(readConfig());
// Exposed for debugging and for driving the model from the console during a demo.
window.__world = world;

buildRoad(scene);
buildScenery(scene);
buildAmbulancePost(scene);
const incident = buildIncident(scene);
const fogBand = createFogBand(scene, EXP.fogFrom, EXP.fogTo,
  EXP.medianHalf + EXP.laneWidth * EXP.lanes + 40);
const gantryViews = world.gantries.map(g => buildGantry(scene, g));
const fleet = new FleetRenderer(scene);
const ambulance = buildAmbulance(scene);

// The moving green zone, drawn over the reserved lane.
const zoneMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, EXP.laneWidth),
  new THREE.MeshBasicMaterial({ color: 0x39e07a, transparent: true, opacity: 0.2, depthWrite: false }),
);
zoneMesh.rotation.x = -Math.PI / 2;
zoneMesh.position.y = 0.34;
zoneMesh.visible = false;
scene.add(zoneMesh);

/* ---------------- camera ---------------- */

const CAMS = ['chase', 'cockpit', 'gantry', 'orbit'];
let camMode = 'chase';
let snap = true;
const camPos = new THREE.Vector3(ROUTE.postX - 40, 12, -20);
const camTgt = new THREE.Vector3(ROUTE.postX + 60, 2, 8);

function frameCamera(dt) {
  const ev = world.units[0];
  const lane0 = laneY(1, EMERGENCY_LANE);
  const focus = ev && !ev.arrived ? ev.x : ROUTE.postX;

  if (camMode === 'orbit') { controls.enabled = true; controls.update(); return; }
  controls.enabled = false;

  let want, look;
  if (camMode === 'chase') {
    want = new THREE.Vector3(focus - 34, 11, lane0 - 10);
    look = new THREE.Vector3(focus + 60, 2.5, lane0 + 3);
  } else if (camMode === 'cockpit') {
    want = new THREE.Vector3(focus + 1.4, 2.7, lane0 - 0.5);
    look = new THREE.Vector3(focus + 100, 2.2, lane0 + 0.7);
  } else {
    const g = nearestGantryAhead(focus);
    want = new THREE.Vector3(g.x - 0.6, 9.9, laneY(1, 0));
    look = new THREE.Vector3(g.x - 140, 1.2, laneY(1, 1.2));
  }

  if (snap) { camPos.copy(want); camTgt.copy(look); snap = false; }
  else {
    const a = 1 - Math.exp(-6 * dt);
    camPos.lerp(want, a);
    camTgt.lerp(look, Math.min(1, a * 1.4));
  }
  camera.position.copy(camPos);
  camera.lookAt(camTgt);
}

function nearestGantryAhead(x) {
  for (const g of world.gantries) if (g.x >= x - 40) return g;
  return world.gantries[world.gantries.length - 1];
}

/* ---------------- controls ---------------- */

let speedMul = 2;
let running = true;

$('dispatch').addEventListener('click', () => {
  world.dispatch();
  snap = true;
  $('dispatch').disabled = true;
});
$('reset').addEventListener('click', restart);
$('pause').addEventListener('click', () => {
  running = !running;
  $('pause').textContent = running ? '❚❚ Pause' : '▶ Resume';
});
$('camBtn').addEventListener('click', () => {
  camMode = CAMS[(CAMS.indexOf(camMode) + 1) % CAMS.length];
  $('camBtn').textContent = 'VIEW · ' + camMode.toUpperCase();
  snap = true;
  if (camMode === 'orbit') {
    const f = world.units[0]?.x ?? ROUTE.postX;
    camera.position.set(f - 120, 110, 180);
    controls.target.set(f, 0, 0);
  }
});
document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => {
  speedMul = +b.dataset.speed;
  document.querySelectorAll('[data-speed]').forEach(x => x.classList.toggle('on', x === b));
}));
for (const id of ['zoneMode', 'dedicated', 'demand', 'encroach', 'compliance', 'weather']) {
  $(id).addEventListener('change', restart);
}
$('demand').addEventListener('input', () => { $('demandVal').textContent = (+$('demand').value).toFixed(2); });
$('encroach').addEventListener('input', () => { $('encroachVal').textContent = Math.round(+$('encroach').value * 100) + '%'; });
$('compliance').addEventListener('input', () => { $('complianceVal').textContent = Math.round(+$('compliance').value * 100) + '%'; });

function readConfig() {
  return {
    seed: 7,
    greenZone: $('zoneMode')?.value ?? 'adaptive',
    dedicatedLane: $('dedicated') ? $('dedicated').value === 'yes' : true,
    demand: +($('demand')?.value ?? 0.7),
    encroachment: +($('encroach')?.value ?? 0.16),
    compliance: +($('compliance')?.value ?? 0.82),
    weather: $('weather')?.value ?? 'clear',
  };
}

function restart() {
  world = new World(readConfig());
  window.__world = world;
  gantryViews.forEach(v => { v.lastVms = null; v.lastAspects = ['', '', '', '']; });
  $('dispatch').disabled = false;
  $('log').innerHTML = '';
  logSeen = 0;
  snap = true;
}

/* ---------------- HUD ---------------- */

let logSeen = 0;
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function updateHud() {
  const ev = world.units[0];
  const zone = world.zone;

  $('clock').textContent = fmt(world.t);
  $('speed').textContent = ev ? Math.round(ev.v * 3.6) : 0;
  $('chainage').textContent = ev ? (ev.x / 1000).toFixed(2) : '0.00';
  $('remaining').textContent = ((ev ? Math.max(0, ROUTE.incidentX - ev.x) : ROUTE.incidentX) / 1000).toFixed(2);

  if (ev && ev.arrived) {
    const rec = world.metrics.ev;
    $('status').textContent = 'ON SCENE';
    $('status').className = 'ok';
    $('elapsed').textContent = `${rec.travelTime.toFixed(1)} s`;
    $('penalty').textContent = `+${rec.delay.toFixed(1)} s vs free-flow`;
  } else if (ev) {
    $('status').textContent = ev.blockedBy ? 'IMPEDED' : 'RESPONDING';
    $('status').className = ev.blockedBy ? 'warn' : 'ev';
    $('elapsed').textContent = `${(world.t - ev.dispatchT).toFixed(1)} s`;
    $('penalty').textContent = `${ev.slowdowns} impedance${ev.slowdowns === 1 ? '' : 's'}`;
  } else {
    $('status').textContent = 'STANDBY';
    $('status').className = '';
    $('elapsed').textContent = '—';
    $('penalty').textContent = 'awaiting dispatch';
  }

  const enc = world.encroachers(1).length;
  $('encroachers').textContent = enc;
  $('encroachers').className = 'val' + (enc > 0 ? ' warn' : '');
  $('violations').textContent = world.gantries.reduce((n, g) => n + g.violations, 0);
  $('zoneLen').textContent = zone.active ? `${Math.round(zone.length)} m` : '—';
  $('clearTime').textContent = zone.active && zone.clearTime ? `${zone.clearTime.toFixed(1)} s` : '—';
  $('laneFlow').textContent = zone.laneFlow ? `${Math.round(zone.laneFlow * 3600)} veh/h` : '—';
  $('inCorridor').textContent = zone.inCorridor ?? 0;

  while (logSeen < world.events.length) {
    const e = world.events[logSeen++];
    const row = document.createElement('div');
    row.className = 'entry ' + (e.kind || 'info');
    row.innerHTML = `<b>${fmt(e.t)}</b>${e.msg}`;
    $('log').prepend(row);
    while ($('log').children.length > 30) $('log').lastChild.remove();
  }
}

/* ---------------- loop ---------------- */

const STEP = 1 / 50;
let acc = 0;
let last = performance.now();

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const wall = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (running) {
    acc += wall * speedMul;
    let n = 0;
    while (acc >= STEP && n < 40) { world.step(STEP); acc -= STEP; n++; }
  }

  const t = world.t;
  const ev = world.units[0];

  fleet.update(world.vehicles, t, wall);
  updateAmbulance(ambulance, ev && !ev.arrived ? ev : null, t);

  const blink = Math.floor(t * 3) % 2 === 0;
  world.gantries.forEach((g, i) => updateGantry(gantryViews[i], g, blink));

  const zone = world.zone;
  if (zone.active && zone.length > 1) {
    zoneMesh.visible = true;
    zoneMesh.scale.set(zone.length, 1, 1);
    zoneMesh.position.set((zone.start + zone.end) / 2, 0.34, laneY(1, EMERGENCY_LANE));
    zoneMesh.material.opacity = 0.15 + 0.09 * Math.sin(t * 4);
  } else zoneMesh.visible = false;

  fogBand.visible = world.cfg.fog;
  incident.beacon.material.emissiveIntensity = 1.5 + 2.5 * (Math.floor(t * 5) % 2);

  // Keep the shadow frustum on the action rather than the whole 10 km.
  const focus = ev && !ev.arrived ? ev.x : ROUTE.postX;
  sun.position.set(focus - 320, 420, 260);
  sun.target.position.set(focus, 0, 0);
  sun.target.updateMatrixWorld();

  frameCamera(wall);
  updateHud();
  renderer.render(scene, camera);
}

tick();
