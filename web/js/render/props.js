// Gantries with their lane-control signals, roadside scenery, the ambulance
// post and the incident scene.

import * as THREE from 'three';
import { EXP, ROUTE, LANE_LABEL, laneY } from '../sim/config.js';
import { mergeGeometries, ROAD_PAD } from './road.js';

const STEEL = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.5, metalness: 0.7 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.8 });

/**
 * A lane-control gantry. Each lane gets its own signal head — green arrow,
 * amber "merge left" diagonal, or red cross — plus a speed plate, a VMS, and
 * the AI camera watching the reserved lane. This is the physical thing the
 * green-zone controller commands, so it is worth drawing properly: the demo
 * only lands if you can read which lane you must not be in.
 */
export function buildGantry(scene, spec) {
  const g = new THREE.Group();
  const carriage = EXP.laneWidth * EXP.lanes;
  const span = EXP.medianHalf + carriage + EXP.shoulder + 1.5;

  const legZ = EXP.medianHalf + carriage + EXP.shoulder + 0.8;
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 9.4, 12), STEEL);
  leg.position.set(0, 4.7, legZ);
  leg.castShadow = true;
  g.add(leg);
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.6),
    new THREE.MeshStandardMaterial({ color: 0xb9b3a5, roughness: 1 }));
  base.position.set(0, 0.25, legZ);
  g.add(base);

  const innerLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 9.4, 12), STEEL);
  innerLeg.position.set(0, 4.7, 0.9);
  innerLeg.castShadow = true;
  g.add(innerLeg);

  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, span), STEEL);
  beam.position.set(0, 9.1, span / 2 + 0.4);
  beam.castShadow = true;
  g.add(beam);

  const heads = [];
  for (let lane = 0; lane < EXP.lanes; lane++) {
    const z = laneY(1, lane);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.5, 1.5), DARK);
    box.position.set(0, 7.9, z);
    g.add(box);
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(1.32, 1.32),
      new THREE.MeshBasicMaterial({ map: aspectTexture('closed', LANE_LABEL[lane], false), toneMapped: false }),
    );
    face.position.set(-0.19, 7.9, z);
    face.rotation.y = -Math.PI / 2;
    g.add(face);
    heads.push(face);
  }

  const vmsCanvas = document.createElement('canvas');
  vmsCanvas.width = 1024; vmsCanvas.height = 160;
  const vmsTex = new THREE.CanvasTexture(vmsCanvas);
  vmsTex.colorSpace = THREE.SRGBColorSpace;
  const vms = new THREE.Mesh(
    new THREE.PlaneGeometry(carriage * 0.8, 1.9),
    new THREE.MeshBasicMaterial({ map: vmsTex, toneMapped: false }),
  );
  vms.position.set(-0.5, 10.6, EXP.medianHalf + carriage * 0.5);
  vms.rotation.y = -Math.PI / 2;
  g.add(vms);

  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.6), DARK);
  cam.position.set(-0.4, 9.9, laneY(1, 0));
  g.add(cam);

  g.position.x = spec.x;
  scene.add(g);
  return { group: g, heads, vmsCanvas, vmsTex, lastAspects: ['', '', '', ''], lastVms: null };
}

export function updateGantry(view, gantry, blink) {
  for (let lane = 0; lane < EXP.lanes; lane++) {
    const key = `${gantry.aspects[lane]}|${Math.round(gantry.vsl[lane] * 3.6)}|${gantry.alerting && blink ? 1 : 0}`;
    if (view.lastAspects[lane] === key) continue;
    view.lastAspects[lane] = key;
    view.heads[lane].material.map = aspectTexture(
      gantry.aspects[lane], String(Math.round(gantry.vsl[lane] * 3.6)), gantry.alerting && blink,
    );
    view.heads[lane].material.needsUpdate = true;
  }
  const msg = gantry.vms || '';
  if (view.lastVms !== msg) {
    view.lastVms = msg;
    const g = view.vmsCanvas.getContext('2d');
    g.fillStyle = '#0a0d10';
    g.fillRect(0, 0, 1024, 160);
    g.strokeStyle = '#2a3138'; g.lineWidth = 8; g.strokeRect(4, 4, 1016, 152);
    if (msg) {
      g.fillStyle = '#ffb300';
      g.font = 'bold 70px Arial';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(msg, 512, 84);
    }
    view.vmsTex.needsUpdate = true;
  }
}

const aspectCache = new Map();
function aspectTexture(aspect, label, flash) {
  const key = `${aspect}|${label}|${flash}`;
  const hit = aspectCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0d10';
  g.fillRect(0, 0, 128, 128);
  g.lineWidth = 12;
  g.lineCap = 'round';
  if (aspect === 'closed') {
    g.strokeStyle = '#ff2f2f';
    g.beginPath();
    g.moveTo(28, 28); g.lineTo(100, 100);
    g.moveTo(100, 28); g.lineTo(28, 100);
    g.stroke();
  } else if (aspect === 'merge') {
    g.strokeStyle = flash ? '#ffe27a' : '#ffb300';
    g.beginPath(); g.moveTo(96, 26); g.lineTo(40, 82); g.stroke();
    g.beginPath();
    g.moveTo(40, 82); g.lineTo(40, 52);
    g.moveTo(40, 82); g.lineTo(70, 82);
    g.stroke();
    g.fillStyle = '#e9eef2'; g.font = 'bold 22px Arial'; g.textAlign = 'center';
    g.fillText(label, 64, 116);
  } else {
    g.strokeStyle = '#37d67a';
    g.beginPath(); g.moveTo(64, 100); g.lineTo(64, 34); g.stroke();
    g.beginPath(); g.moveTo(40, 56); g.lineTo(64, 32); g.lineTo(88, 56); g.stroke();
    g.fillStyle = '#e9eef2'; g.font = 'bold 26px Arial'; g.textAlign = 'center';
    g.fillText(label, 64, 122);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (aspectCache.size > 240) aspectCache.clear();
  aspectCache.set(key, tex);
  return tex;
}

/* ------------------------------------------------------------------ */

/** Avenue trees, median planting, boundary fence and chainage stones. */
export function buildScenery(scene) {
  const from = -ROAD_PAD, to = EXP.length + ROAD_PAD;
  const kerb = EXP.medianHalf + EXP.laneWidth * EXP.lanes + EXP.shoulder;
  const rnd = Math.random;
  const m = new THREE.Matrix4();
  const col = new THREE.Color();

  const spots = [];
  for (let x = from; x < to; x += 26 + rnd() * 20) {
    for (const side of [-1, 1]) {
      if (rnd() < 0.22) continue;
      spots.push({ x: x + rnd() * 8, z: side * (kerb + 7 + rnd() * 16), s: 0.75 + rnd() * 0.85 });
    }
  }
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.22, 0.34, 3.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }), spots.length);
  const crowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(2.5, 1),
    new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), spots.length);
  crowns.castShadow = true;
  spots.forEach((p, i) => {
    m.makeScale(p.s, p.s, p.s).setPosition(p.x, 1.7 * p.s, p.z);
    trunks.setMatrixAt(i, m);
    m.makeScale(p.s, p.s * 0.85, p.s).setPosition(p.x, 4.4 * p.s, p.z);
    crowns.setMatrixAt(i, m);
    col.setHSL(0.24 + rnd() * 0.06, 0.42 + rnd() * 0.2, 0.22 + rnd() * 0.12);
    crowns.setColorAt(i, col);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  scene.add(trunks, crowns);

  // Median oleander hedge — the real one is there to kill headlight glare.
  const shrubMax = Math.floor((to - from) / 3);
  const shrubs = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.95, 0),
    new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), shrubMax);
  let si = 0;
  for (let x = from; x < to && si < shrubMax; x += 6) {
    for (const side of [-1, 1]) {
      if (si >= shrubMax) break;
      const s = 0.8 + rnd() * 0.5;
      m.makeScale(s, s * 1.25, s).setPosition(x + rnd() * 2, 0.85, side * (EXP.medianHalf * 0.55));
      shrubs.setMatrixAt(si, m);
      col.setHSL(0.28 + rnd() * 0.05, 0.4, 0.2 + rnd() * 0.1);
      shrubs.setColorAt(si, col);
      si++;
    }
  }
  shrubs.count = si;
  shrubs.instanceMatrix.needsUpdate = true;
  scene.add(shrubs);

  const posts = [];
  for (let x = from; x < to; x += 12) for (const side of [-1, 1]) posts.push([x, side * (kerb + 26)]);
  const fence = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.12, 1.8, 0.12),
    new THREE.MeshStandardMaterial({ color: 0xb0b6ba, roughness: 0.9 }), posts.length);
  posts.forEach(([x, z], i) => { m.makeScale(1, 1, 1).setPosition(x, 0.9, z); fence.setMatrixAt(i, m); });
  fence.instanceMatrix.needsUpdate = true;
  scene.add(fence);

  const stones = [];
  for (let x = 0; x <= EXP.length; x += 500) {
    const g = new THREE.BoxGeometry(0.35, 1.0, 0.5);
    g.translate(x, 0.5, kerb + 2.4);
    stones.push(g);
  }
  scene.add(new THREE.Mesh(mergeGeometries(stones),
    new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 1 })));
}

export function buildIncident(scene) {
  const g = new THREE.Group();
  const z = laneY(1, EXP.lanes - 1);

  const wreck = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.5, 1.9),
    new THREE.MeshStandardMaterial({ color: 0x8d3b32, roughness: 0.8 }));
  wreck.position.set(0, 1.0, z + 1.2);
  wreck.rotation.set(0, 0.5, Math.PI * 0.62);
  wreck.castShadow = true;
  g.add(wreck);

  const patrol = new THREE.Mesh(new THREE.BoxGeometry(4.8, 1.4, 1.9),
    new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.45, metalness: 0.2 }));
  patrol.position.set(-16, 0.85, z);
  patrol.castShadow = true;
  g.add(patrol);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 1.5),
    new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff3020, emissiveIntensity: 3, toneMapped: false }));
  bar.position.set(-16, 1.68, z);
  g.add(bar);

  const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(0.3, 0.75, 8),
    new THREE.MeshStandardMaterial({ color: 0xff6a1f, roughness: 0.9 }), 14);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 14; i++) {
    m.makeScale(1, 1, 1).setPosition(-60 + i * 4.4, 0.38, z + 1.6 - i * 0.06);
    cones.setMatrixAt(i, m);
  }
  cones.instanceMatrix.needsUpdate = true;
  g.add(cones);

  g.position.x = ROUTE.incidentX;
  scene.add(g);
  return { group: g, beacon: bar };
}

export function buildAmbulancePost(scene) {
  const g = new THREE.Group();
  const z = laneY(1, EXP.lanes - 1) + 11;
  const shed = new THREE.Mesh(new THREE.BoxGeometry(14, 4, 9),
    new THREE.MeshStandardMaterial({ color: 0xe4e0d4, roughness: 0.95 }));
  shed.position.set(0, 2, z);
  shed.castShadow = true;
  g.add(shed);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(15.5, 0.4, 10.4),
    new THREE.MeshStandardMaterial({ color: 0x2f6ea8, roughness: 0.6, metalness: 0.2 }));
  roof.position.set(0, 4.2, z);
  g.add(roof);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 1.5),
    new THREE.MeshBasicMaterial({ map: textTexture('108  AMBULANCE POST', '#0d3b6f', '#ffffff'), toneMapped: false }));
  sign.position.set(0, 4.9, z - 4.7);
  sign.rotation.y = Math.PI;
  g.add(sign);
  g.position.x = ROUTE.postX;
  scene.add(g);
  return g;
}

function textTexture(text, bg, fg) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 1024, 192);
  g.strokeStyle = fg; g.lineWidth = 8; g.strokeRect(10, 10, 1004, 172);
  g.fillStyle = fg; g.font = 'bold 92px Arial';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 512, 100);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
