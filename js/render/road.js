// The carriageway: asphalt, lane markings, the hatched emergency lane, the
// depressed median with its barrier, shoulders and surrounding landscape.
//
// The corridor axis is world +X, lateral is world Z (a vehicle's simulation `y`),
// and world Y is up.

import * as THREE from 'three';
import { EXP, EMERGENCY_LANE, laneY } from '../sim/config.js';

const PAD = 400;      // m of road drawn beyond each end so it never just stops
export const ROAD_PAD = PAD;

export function buildRoad(scene) {
  const group = new THREE.Group();
  const from = -PAD, to = EXP.length + PAD, len = to - from, mid = (from + to) / 2;
  const carriage = EXP.laneWidth * EXP.lanes;

  // ---- landscape ----
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(len + 2600, 2800),
    new THREE.MeshStandardMaterial({ color: 0x6d7845, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(mid, -0.35, 0);
  ground.receiveShadow = true;
  group.add(ground);

  const fieldMats = [0x8a8b46, 0x7c8a4a, 0x9a9558, 0x6d7d42]
    .map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let x = from; x < to;) {
    const w = 120 + rnd() * 260;
    for (const side of [-1, 1]) {
      const d = 90 + rnd() * 240;
      const patch = new THREE.Mesh(new THREE.PlaneGeometry(w, d), fieldMats[Math.floor(rnd() * fieldMats.length)]);
      patch.rotation.x = -Math.PI / 2;
      patch.position.set(x + w / 2, -0.3, side * (95 + d / 2));
      group.add(patch);
    }
    x += w;
  }

  // ---- carriageways ----
  const asphalt = new THREE.MeshStandardMaterial({
    map: asphaltTexture(len), roughness: 0.92, metalness: 0.02,
  });
  for (const dir of [1, -1]) {
    const inner = EXP.medianHalf;
    const width = carriage + EXP.shoulder;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(len, 0.28, width), asphalt);
    slab.position.set(mid, 0.14, dir * (inner + width / 2));
    slab.receiveShadow = true;
    group.add(slab);
  }

  // ---- median ----
  const med = new THREE.Mesh(
    new THREE.BoxGeometry(len, 0.16, EXP.medianHalf * 2),
    new THREE.MeshStandardMaterial({ color: 0x5c6b3a, roughness: 1 }),
  );
  med.position.set(mid, 0.08, 0);
  med.receiveShadow = true;
  group.add(med);

  const kerbMat = new THREE.MeshStandardMaterial({ color: 0xcfcabb, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(len, 0.34, 0.35), kerbMat);
    kerb.position.set(mid, 0.17, side * EXP.medianHalf);
    kerb.castShadow = true;
    group.add(kerb);
  }
  const barrier = new THREE.Mesh(
    new THREE.BoxGeometry(len, 0.95, 0.55),
    new THREE.MeshStandardMaterial({ color: 0xd6d2c6, roughness: 0.85 }),
  );
  barrier.position.set(mid, 0.6, 0);
  barrier.castShadow = true;
  barrier.receiveShadow = true;
  group.add(barrier);

  // ---- markings ----
  for (const m of laneMarkings(from, to)) group.add(m);
  for (const dir of [1, -1]) group.add(emergencySurface(from, to, dir));

  scene.add(group);
  return group;
}

function laneMarkings(from, to) {
  const out = [];
  const len = to - from, mid = (from + to) / 2;
  const white = new THREE.MeshBasicMaterial({ color: 0xf2f4f2 });
  const yellow = new THREE.MeshBasicMaterial({ color: 0xf0c23a });

  for (const dir of [1, -1]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, 0.15), white);
    edge.position.set(mid, 0.29, dir * (EXP.medianHalf + EXP.laneWidth * EXP.lanes + 0.25));
    out.push(edge);

    // Solid double line beside the corridor — you may not cross it.
    for (const off of [-0.09, 0.09]) {
      const solid = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, 0.13), yellow);
      solid.position.set(mid, 0.29, dir * (EXP.medianHalf + EXP.laneWidth * (EMERGENCY_LANE + 1)) + off);
      out.push(solid);
    }

    const dashes = [];
    for (let lane = EMERGENCY_LANE + 2; lane < EXP.lanes; lane++) {
      const z = dir * (EXP.medianHalf + EXP.laneWidth * lane);
      for (let x = from; x < to; x += 15) {
        const g = new THREE.BoxGeometry(6, 0.02, 0.15);
        g.translate(x + 3, 0.29, z);
        dashes.push(g);
      }
    }
    if (dashes.length) out.push(new THREE.Mesh(mergeGeometries(dashes), white));
  }
  return out;
}

/**
 * The reserved lane's surface: green-tinted asphalt with white chevrons and a
 * repeated legend. On real installations the colour does most of the compliance
 * work — a lane that is merely reserved on paper gets used anyway.
 */
function emergencySurface(from, to, dir) {
  const len = to - from;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(len, EXP.laneWidth),
    new THREE.MeshStandardMaterial({ map: emergencyTexture(len), roughness: 0.88 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  if (dir < 0) mesh.rotation.z = Math.PI;
  mesh.position.set((from + to) / 2, 0.30, laneY(dir, EMERGENCY_LANE));
  return mesh;
}

function asphaltTexture(len) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3b3f44';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 40 + Math.random() * 42;
    g.fillStyle = `rgba(${v},${v + 2},${v + 5},0.55)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6);
  }
  g.strokeStyle = 'rgba(28,30,33,0.5)';
  g.lineWidth = 3;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.moveTo(Math.random() * 256, 0);
    g.lineTo(Math.random() * 256, 256);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(len / 26, 1.4);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function emergencyTexture(len) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#2f4a3a';
  g.fillRect(0, 0, 128, 512);
  for (let i = 0; i < 2600; i++) {
    const v = 34 + Math.random() * 30;
    g.fillStyle = `rgba(${v},${v + 18},${v + 8},0.5)`;
    g.fillRect(Math.random() * 128, Math.random() * 512, 1.6, 1.6);
  }
  g.strokeStyle = 'rgba(238,244,238,0.6)';
  g.lineWidth = 7;
  for (let y = -40; y < 512; y += 96) {
    g.beginPath();
    g.moveTo(12, y + 70);
    g.lineTo(64, y);
    g.lineTo(116, y + 70);
    g.stroke();
  }
  g.save();
  g.translate(64, 300);
  g.rotate(-Math.PI / 2);
  g.fillStyle = 'rgba(238,244,238,0.85)';
  g.font = 'bold 34px Arial';
  g.textAlign = 'center';
  g.fillText('EMERGENCY LANE', 0, 12);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, len / 42);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Minimal geometry merge — avoids pulling in the addons build for this alone. */
export function mergeGeometries(geos) {
  const merged = new THREE.BufferGeometry();
  let vCount = 0, iCount = 0;
  for (const g of geos) { vCount += g.attributes.position.count; iCount += g.index ? g.index.count : 0; }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(idx, 1));
  return merged;
}
