// Vehicle rendering.
//
// A busy carriageway carries 300-600 vehicles. A Group of ten meshes per
// vehicle would mean thousands of draw calls and a slideshow, so each class
// gets a small set of InstancedMeshes — body, glasshouse, a detail block for
// heavy vehicles, and wheels — and every frame writes matrices into them. That
// is about twenty draw calls for the entire fleet.

import * as THREE from 'three';
import { VEHICLES, AMBULANCE } from '../sim/config.js';

const MAX = 420;      // instances per class

const WHEEL_MAT = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.95 });
const GLASS_MAT = new THREE.MeshStandardMaterial({ color: 0x2c3d4c, roughness: 0.08, metalness: 0.6 });
const BOX_MAT = new THREE.MeshStandardMaterial({ color: 0xcfd4d8, roughness: 0.65 });

/** Per-class proportions, as fractions of the vehicle's length and width. */
const SHAPES = {
  car:   { bodyH: 0.78, bodyY: 0.62, glassH: 0.58, glassLen: 0.46, glassZ: 0.02, wheelR: 0.33, glassY: 1.24, detail: null },
  suv:   { bodyH: 1.02, bodyY: 0.78, glassH: 0.62, glassLen: 0.50, glassZ: 0.04, wheelR: 0.38, glassY: 1.60, detail: null },
  bus:   { bodyH: 2.55, bodyY: 1.75, glassH: 0.85, glassLen: 0.88, glassZ: 0.00, wheelR: 0.48, glassY: 2.35, detail: null },
  lcv:   { bodyH: 1.05, bodyY: 0.85, glassH: 0.85, glassLen: 0.26, glassZ: -0.30, wheelR: 0.42, glassY: 1.85, detail: { h: 2.0, len: 0.60, z: 0.16, y: 2.00 } },
  truck: { bodyH: 1.15, bodyY: 0.85, glassH: 1.15, glassLen: 0.17, glassZ: -0.38, wheelR: 0.50, glassY: 2.05, detail: { h: 2.7, len: 0.68, z: 0.14, y: 2.60 } },
};

export class FleetRenderer {
  constructor(scene) {
    this.classes = {};
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);

    for (const cls in VEHICLES) {
      const s = SHAPES[cls];
      const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.35 });
      const body = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bodyMat, MAX);
      const glass = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), GLASS_MAT, MAX);
      const detail = s.detail ? new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), BOX_MAT, MAX) : null;
      const wheels = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10), WHEEL_MAT, MAX * 4);

      body.castShadow = true;
      for (const mesh of [body, glass, wheels, detail]) if (mesh) mesh.frustumCulled = false;
      if (detail) detail.castShadow = true;
      for (let i = 0; i < MAX; i++) {
        body.setMatrixAt(i, hide);
        glass.setMatrixAt(i, hide);
        if (detail) detail.setMatrixAt(i, hide);
      }
      for (let i = 0; i < MAX * 4; i++) wheels.setMatrixAt(i, hide);

      scene.add(body, glass, wheels);
      if (detail) scene.add(detail);
      this.classes[cls] = { shape: s, body, glass, detail, wheels, count: 0 };
    }

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this.smooth = new Map();
  }

  /**
   * The simulation changes lane instantaneously — it is a discrete decision, and
   * making it continuous there would complicate car-following for no modelling
   * gain. So lateral position is smoothed here, and the steering angle falls out
   * of that smoothing. Without it the fleet teleports sideways, which reads as a
   * bug even though the physics underneath is right.
   */
  update(vehicles, t, dt) {
    for (const cls in this.classes) this.classes[cls].count = 0;
    const alive = new Set();
    const step = Math.max(dt || 0.016, 1e-3);

    for (const veh of vehicles) {
      const c = this.classes[veh.cls];
      if (!c || c.count >= MAX) continue;
      const i = c.count++;
      const s = c.shape;
      const L = veh.len, W = veh.wid;
      alive.add(veh.id);

      let sm = this.smooth.get(veh.id);
      if (!sm) { sm = { y: veh.y, steer: 0 }; this.smooth.set(veh.id, sm); }
      const dy = veh.y - sm.y;
      const k = Math.min(1, step * 2.6);
      sm.y += dy * k;
      const target = Math.atan2((dy * k) / step, Math.max(veh.v, 4)) * veh.dir;
      sm.steer += (target - sm.steer) * 0.25;
      const yaw = Math.max(-0.2, Math.min(0.2, sm.steer));
      const y = sm.y;

      this.place(c.body, i, veh.x, s.bodyY, y, W, s.bodyH, L, yaw);
      this.place(c.glass, i, veh.x + s.glassZ * L * veh.dir, s.glassY, y, W - 0.22, s.glassH, L * s.glassLen, yaw);
      if (c.detail) {
        this.place(c.detail, i, veh.x + s.detail.z * L * veh.dir, s.detail.y, y, W + 0.08, s.detail.h, L * s.detail.len, yaw);
      }

      const r = s.wheelR;
      const axles = [[-0.34, -1], [-0.34, 1], [0.32, -1], [0.32, 1]];
      for (let w = 0; w < 4; w++) {
        const [lz, lx] = axles[w];
        this._e.set(0, yaw, Math.PI / 2);
        this._q.setFromEuler(this._e);
        this._v.set(veh.x + lz * L * veh.dir, r, y + lx * (W / 2 - 0.05));
        this._s.set(r, 0.28, r);
        this._m.compose(this._v, this._q, this._s);
        c.wheels.setMatrixAt(i * 4 + w, this._m);
      }

      // Encroachers are flagged in red so the failure mode is visible on screen
      // and not only in the metrics.
      if (veh.lane === 0) {
        this._c.setHSL(0.02, 0.85, veh.ordered ? 0.42 + 0.16 * Math.sin(t * 9) : 0.44);
      } else {
        this._c.setHSL(veh.hue / 360, veh.spec.heavy ? 0.14 : 0.34, veh.shade * 0.72 + 0.16);
      }
      c.body.setColorAt(i, this._c);
    }

    if (this.smooth.size > vehicles.length * 2 + 64) {
      for (const id of this.smooth.keys()) if (!alive.has(id)) this.smooth.delete(id);
    }

    const hide = this._m.makeScale(0, 0, 0);
    for (const cls in this.classes) {
      const c = this.classes[cls];
      for (let i = c.count; i < MAX; i++) {
        c.body.setMatrixAt(i, hide);
        c.glass.setMatrixAt(i, hide);
        if (c.detail) c.detail.setMatrixAt(i, hide);
        for (let w = 0; w < 4; w++) c.wheels.setMatrixAt(i * 4 + w, hide);
      }
      c.body.instanceMatrix.needsUpdate = true;
      c.glass.instanceMatrix.needsUpdate = true;
      c.wheels.instanceMatrix.needsUpdate = true;
      if (c.body.instanceColor) c.body.instanceColor.needsUpdate = true;
      if (c.detail) c.detail.instanceMatrix.needsUpdate = true;
    }
  }

  place(mesh, i, x, y, z, w, h, l, yaw) {
    this._e.set(0, yaw, 0);
    this._q.setFromEuler(this._e);
    this._v.set(x, y, z);
    this._s.set(l, h, w);
    this._m.compose(this._v, this._q, this._s);
    mesh.setMatrixAt(i, this._m);
  }
}

/* ------------------------------------------------------------------ */
/* The ambulance — there is one, so it is built properly               */
/* ------------------------------------------------------------------ */

export function buildAmbulance(scene) {
  const g = new THREE.Group();
  const L = AMBULANCE.len, W = AMBULANCE.wid;
  const shell = new THREE.MeshStandardMaterial({ color: 0xf4f7f9, roughness: 0.3, metalness: 0.15 });

  const box = new THREE.Mesh(new THREE.BoxGeometry(L * 0.66, 2.25, W), shell);
  box.position.set(L * 0.14, 1.5, 0);
  box.castShadow = true;
  g.add(box);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(L * 0.36, 1.75, W - 0.08), shell);
  cab.position.set(-L * 0.32, 1.25, 0);
  cab.castShadow = true;
  g.add(cab);

  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, W - 0.3), GLASS_MAT);
  screen.position.set(-L * 0.49, 1.72, 0);
  g.add(screen);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(L * 0.98, 0.42, W + 0.04),
    new THREE.MeshStandardMaterial({ color: 0xd21f26, roughness: 0.45 }));
  stripe.position.set(0, 1.1, 0);
  g.add(stripe);

  const chevron = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, W),
    new THREE.MeshStandardMaterial({ color: 0x1f9e4d, roughness: 0.55 }));
  chevron.position.set(L * 0.47, 1.5, 0);
  g.add(chevron);

  const barBase = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, W - 0.35),
    new THREE.MeshStandardMaterial({ color: 0x22262b }));
  barBase.position.set(-L * 0.22, 2.72, 0);
  g.add(barBase);
  const red = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.24, 0.42), lampMat(0xff2a2a));
  red.position.set(-L * 0.22, 2.86, -0.55);
  g.add(red);
  const blue = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.24, 0.42), lampMat(0x2f6cff));
  blue.position.set(-L * 0.22, 2.86, 0.55);
  g.add(blue);

  const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.32, 14);
  for (const [lz, lx] of [[-0.32, -1], [-0.32, 1], [0.3, -1], [0.3, 1]]) {
    const wheel = new THREE.Mesh(wheelGeo, WHEEL_MAT);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(lz * L, 0.46, lx * (W / 2 - 0.06));
    g.add(wheel);
  }

  const beam = new THREE.PointLight(0xff4040, 0, 70, 1.6);
  beam.position.set(-L * 0.22, 3.4, 0);
  g.add(beam);

  g.visible = false;
  scene.add(g);
  return { group: g, red: red.material, blue: blue.material, beam };
}

function lampMat(color) {
  return new THREE.MeshStandardMaterial({
    color: 0x101010, emissive: new THREE.Color(color), emissiveIntensity: 3, toneMapped: false,
  });
}

export function updateAmbulance(view, unit, t) {
  if (!unit) { view.group.visible = false; return; }
  view.group.visible = true;
  view.group.position.set(unit.x, 0, unit.y);
  view.group.rotation.y = unit.dir > 0 ? 0 : Math.PI;
  const phase = Math.floor(t * 7) % 2 === 0;
  view.red.emissiveIntensity = phase ? 6 : 0.3;
  view.blue.emissiveIntensity = phase ? 0.3 : 6;
  view.beam.intensity = 28;
  view.beam.color.set(phase ? 0xff3535 : 0x3f7bff);
}
