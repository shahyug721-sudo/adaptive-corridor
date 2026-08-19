// 3D view of the four-arm junction: roads, signal heads with per-arm aspects,
// IR sensor posts, buildings, trees, and instanced vehicles.

import * as THREE from 'three';
import { JUNCTION, ARMS, perp, armPosition } from '../sim/junction/config.js';

const ARM_LEN = JUNCTION.armLength;
const HALF = JUNCTION.boxHalf;
const ROAD_HALF = JUNCTION.medianHalf + JUNCTION.laneWidth * JUNCTION.lanes;

const MAT = {
  asphalt: new THREE.MeshStandardMaterial({ color: 0x3c4045, roughness: 0.95 }),
  paint: new THREE.MeshBasicMaterial({ color: 0xeef2f4 }),
  yellow: new THREE.MeshBasicMaterial({ color: 0xe8c33c }),
  kerb: new THREE.MeshStandardMaterial({ color: 0xc9c4b6, roughness: 0.9 }),
  median: new THREE.MeshStandardMaterial({ color: 0x51702f, roughness: 1 }),
  pole: new THREE.MeshStandardMaterial({ color: 0x4a5259, roughness: 0.5, metalness: 0.6 }),
  housing: new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.8 }),
  ground: new THREE.MeshStandardMaterial({ color: 0x6d7a4a, roughness: 1 }),
  wheel: new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.95 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x2b3d4d, roughness: 0.15, metalness: 0.5 }),
};

const LAMP = {
  red: new THREE.MeshStandardMaterial({ color: 0x2a0c0c, emissive: 0xff2020, emissiveIntensity: 0, toneMapped: false }),
  yellow: new THREE.MeshStandardMaterial({ color: 0x2a230c, emissive: 0xffc020, emissiveIntensity: 0, toneMapped: false }),
  green: new THREE.MeshStandardMaterial({ color: 0x0c2a16, emissive: 0x24e06a, emissiveIntensity: 0, toneMapped: false }),
};

export function buildJunctionScene(scene) {
  const g = new THREE.Group();

  // ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), MAT.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.3;
  ground.receiveShadow = true;
  g.add(ground);

  // junction box
  const box = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2, 0.25, ROAD_HALF * 2), MAT.asphalt);
  box.position.y = 0.12;
  box.receiveShadow = true;
  g.add(box);

  const signalViews = [];

  for (const arm of ARMS) {
    const p = perp(arm);
    const len = ARM_LEN - HALF + 30;
    const midS = HALF + len / 2;

    // carriageway
    const road = new THREE.Mesh(new THREE.BoxGeometry(len, 0.25, ROAD_HALF * 2), MAT.asphalt);
    road.position.set(arm.dx * midS, 0.12, arm.dy * midS);
    road.rotation.y = Math.atan2(-arm.dy, arm.dx) + (arm.dx === 0 ? Math.PI / 2 : 0);
    road.receiveShadow = true;
    g.add(road);

    // median strip down the arm
    const med = new THREE.Mesh(new THREE.BoxGeometry(len, 0.32, JUNCTION.medianHalf * 2), MAT.median);
    med.position.set(arm.dx * midS, 0.16, arm.dy * midS);
    med.rotation.copy(road.rotation);
    g.add(med);

    // stop line across the approach lanes
    const stop = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.02, JUNCTION.laneWidth * JUNCTION.lanes),
      MAT.paint,
    );
    const stopPos = armPosition(arm, HALF + 0.6, (JUNCTION.lanes - 1) / 2);
    stop.position.set(stopPos.x, 0.26, stopPos.y);
    stop.rotation.y = Math.atan2(arm.dy, arm.dx);
    g.add(stop);

    // zebra crossing just upstream of the stop line
    for (let i = 0; i < 7; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.02, 0.45), MAT.paint);
      const bp = armPosition(arm, HALF + 3.5, 0, (i - 3) * 0.85 + JUNCTION.laneWidth);
      bar.position.set(bp.x, 0.26, bp.y);
      bar.rotation.y = Math.atan2(arm.dy, arm.dx);
      g.add(bar);
    }

    // lane divider dashes
    for (let s = HALF + 8; s < ARM_LEN; s += 9) {
      const dash = new THREE.Mesh(new THREE.BoxGeometry(4, 0.02, 0.14), MAT.paint);
      const dp = armPosition(arm, s, 0, JUNCTION.laneWidth * 0.5);
      dash.position.set(dp.x, 0.26, dp.y);
      dash.rotation.y = Math.atan2(arm.dy, arm.dx);
      g.add(dash);
    }

    // ---- signal head, on the near-left kerb facing the approach ----
    const head = buildSignalHead();
    const hp = armPosition(arm, HALF + 2.5, JUNCTION.lanes - 1, JUNCTION.laneWidth * 0.9);
    head.group.position.set(hp.x, 0, hp.y);
    head.group.rotation.y = Math.atan2(arm.dy, arm.dx) + Math.PI / 2;
    g.add(head.group);
    signalViews.push({ armId: arm.id, ...head });

    // ---- IR sensor post at the beam position ----
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 2.6, 8), MAT.pole);
    const ip = armPosition(arm, HALF + JUNCTION.irDistance, JUNCTION.lanes - 1, JUNCTION.laneWidth * 0.9);
    post.position.set(ip.x, 1.3, ip.y);
    g.add(post);
    const emitter = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x101418, emissive: 0xff3b3b, emissiveIntensity: 1.4, toneMapped: false }),
    );
    emitter.position.set(ip.x, 2.4, ip.y);
    g.add(emitter);
    // the beam itself, across the approach
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.04, JUNCTION.laneWidth * JUNCTION.lanes),
      new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.35 }),
    );
    const bmid = armPosition(arm, HALF + JUNCTION.irDistance, (JUNCTION.lanes - 1) / 2);
    beam.position.set(bmid.x, 2.4, bmid.y);
    beam.rotation.y = Math.atan2(arm.dy, arm.dx);
    g.add(beam);

    // kerbs and footpath edges
    for (const side of [-1, 1]) {
      const kerb = new THREE.Mesh(new THREE.BoxGeometry(len, 0.36, 0.4), MAT.kerb);
      kerb.position.set(
        arm.dx * midS + p.x * side * ROAD_HALF,
        0.18,
        arm.dy * midS + p.y * side * ROAD_HALF,
      );
      kerb.rotation.copy(road.rotation);
      g.add(kerb);
    }
  }

  buildSurroundings(g);
  scene.add(g);
  return { group: g, signals: signalViews };
}

function buildSignalHead() {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 4.2, 10), MAT.pole);
  pole.position.y = 2.1;
  pole.castShadow = true;
  group.add(pole);

  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.85, 0.42), MAT.housing);
  housing.position.set(0, 4.3, 0);
  group.add(housing);

  const lamps = {};
  const order = ['red', 'yellow', 'green'];
  order.forEach((key, i) => {
    const mat = LAMP[key].clone();
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 12), mat);
    lamp.position.set(0, 4.85 - i * 0.55, 0.2);
    group.add(lamp);
    lamps[key] = mat;
  });

  return { group, lamps };
}

/** Update one arm's lamps from the simulation aspect. */
export function updateSignalHead(view, aspect) {
  view.lamps.red.emissiveIntensity = aspect === 'red' ? 3.2 : 0.0;
  view.lamps.yellow.emissiveIntensity = aspect === 'yellow' ? 3.2 : 0.0;
  view.lamps.green.emissiveIntensity = aspect === 'green' ? 3.2 : 0.0;
}

/** Low-rise buildings and trees so the junction reads as a place, not a diagram. */
function buildSurroundings(g) {
  let seed = 90210;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const trunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 3, 6);
  const crownGeo = new THREE.IcosahedronGeometry(2.2, 1);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4630, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x497a30, roughness: 1, flatShading: true });

  const spots = [];
  for (const arm of ARMS) {
    const p = perp(arm);
    for (let s = HALF + 18; s < ARM_LEN; s += 16 + rnd() * 8) {
      for (const side of [-1, 1]) {
        spots.push({
          x: arm.dx * s + p.x * side * (ROAD_HALF + 4 + rnd() * 3),
          z: arm.dy * s + p.y * side * (ROAD_HALF + 4 + rnd() * 3),
          sc: 0.7 + rnd() * 0.7,
        });
      }
    }
  }
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, spots.length);
  crowns.castShadow = true;
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  spots.forEach((p, i) => {
    m.makeScale(p.sc, p.sc, p.sc).setPosition(p.x, 1.5 * p.sc, p.z);
    trunks.setMatrixAt(i, m);
    m.makeScale(p.sc, p.sc * 0.9, p.sc).setPosition(p.x, 3.9 * p.sc, p.z);
    crowns.setMatrixAt(i, m);
    col.setHSL(0.25 + rnd() * 0.05, 0.4 + rnd() * 0.2, 0.22 + rnd() * 0.1);
    crowns.setColorAt(i, col);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  g.add(trunks, crowns);

  // buildings in the four quadrants, set back from the kerb
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  const buildings = new THREE.InstancedMesh(
    bGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.85 }),
    120,
  );
  buildings.castShadow = true;
  let n = 0;
  for (const qx of [-1, 1]) {
    for (const qz of [-1, 1]) {
      for (let i = 0; i < 30 && n < 120; i++) {
        const w = 10 + rnd() * 16, d = 10 + rnd() * 16, h = 8 + rnd() * 26;
        const x = qx * (ROAD_HALF + 16 + rnd() * 130);
        const z = qz * (ROAD_HALF + 16 + rnd() * 130);
        m.makeScale(w, h, d).setPosition(x, h / 2, z);
        buildings.setMatrixAt(n, m);
        col.setHSL(0.09 + rnd() * 0.05, 0.12 + rnd() * 0.12, 0.42 + rnd() * 0.22);
        buildings.setColorAt(n, col);
        n++;
      }
    }
  }
  buildings.count = n;
  buildings.instanceMatrix.needsUpdate = true;
  g.add(buildings);
}

/* ------------------------------------------------------------------ */
/* Vehicles                                                            */
/* ------------------------------------------------------------------ */

const MAX = 200;

const SHAPES = {
  motorcycle: { bodyH: 0.55, bodyY: 0.62, cabH: 0.55, cabLen: 0.42, cabY: 1.18, wheelR: 0.28 },
  car:        { bodyH: 0.72, bodyY: 0.60, cabH: 0.56, cabLen: 0.46, cabY: 1.22, wheelR: 0.31 },
  auto:       { bodyH: 1.05, bodyY: 0.72, cabH: 0.62, cabLen: 0.55, cabY: 1.55, wheelR: 0.28 },
  suv:        { bodyH: 0.98, bodyY: 0.75, cabH: 0.60, cabLen: 0.50, cabY: 1.58, wheelR: 0.36 },
  bus:        { bodyH: 2.55, bodyY: 1.70, cabH: 0.80, cabLen: 0.88, cabY: 2.30, wheelR: 0.46 },
  lcv:        { bodyH: 1.05, bodyY: 0.82, cabH: 0.85, cabLen: 0.28, cabY: 1.80, wheelR: 0.40 },
};

export class JunctionFleet {
  constructor(scene) {
    this.classes = {};
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const cls in SHAPES) {
      const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.25 });
      const body = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bodyMat, MAX);
      const cab = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), MAT.glass, MAX);
      const wheels = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), MAT.wheel, MAX * 4);
      body.castShadow = true;
      for (const mesh of [body, cab, wheels]) {
        mesh.frustumCulled = false;
        for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, zero);
        scene.add(mesh);
      }
      this.classes[cls] = { body, cab, wheels, shape: SHAPES[cls], count: 0 };
    }
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  update(vehicles) {
    for (const cls in this.classes) this.classes[cls].count = 0;

    for (const veh of vehicles) {
      if (veh.kind === 'ev') continue;
      const c = this.classes[veh.cls];
      if (!c || c.count >= MAX) continue;
      const i = c.count++;
      const s = c.shape;
      // The simulation works in a flat XY plane; the scene maps sim y onto
      // world Z. Rotating by rotation.y = θ sends local +X to (cosθ, 0, −sinθ),
      // so reproducing a sim heading h needs θ = −h. Getting this backwards
      // makes every vehicle drive sideways through the junction.
      const yaw = -veh.heading;

      this.place(c.body, i, veh.x, s.bodyY, veh.y, veh.wid, s.bodyH, veh.len, yaw);
      this.place(c.cab, i, veh.x, s.cabY, veh.y, veh.wid - 0.2, s.cabH, veh.len * s.cabLen, yaw);

      const r = s.wheelR;
      [[-0.32, -1], [-0.32, 1], [0.32, -1], [0.32, 1]].forEach(([lz, lx], k) => {
        this._e.set(0, yaw, Math.PI / 2);
        this._q.setFromEuler(this._e);
        const a = lz * veh.len, b = lx * (veh.wid / 2 - 0.05);
        const ox = a * Math.cos(yaw) + b * Math.sin(yaw);
        const oz = -a * Math.sin(yaw) + b * Math.cos(yaw);
        this._v.set(veh.x + ox, r, veh.y + oz);
        this._s.set(r, 0.26, r);
        this._m.compose(this._v, this._q, this._s);
        c.wheels.setMatrixAt(i * 4 + k, this._m);
      });

      this._c.setHSL(veh.hue / 360, 0.34, veh.shade * 0.75 + 0.14);
      c.body.setColorAt(i, this._c);
    }

    const zero = this._m.makeScale(0, 0, 0);
    for (const cls in this.classes) {
      const c = this.classes[cls];
      for (let i = c.count; i < MAX; i++) {
        c.body.setMatrixAt(i, zero);
        c.cab.setMatrixAt(i, zero);
        for (let k = 0; k < 4; k++) c.wheels.setMatrixAt(i * 4 + k, zero);
      }
      c.body.instanceMatrix.needsUpdate = true;
      c.cab.instanceMatrix.needsUpdate = true;
      c.wheels.instanceMatrix.needsUpdate = true;
      if (c.body.instanceColor) c.body.instanceColor.needsUpdate = true;
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

/** The ambulance, built individually so it reads clearly against the fleet. */
export function buildJunctionAmbulance(scene) {
  const g = new THREE.Group();
  const L = 5.9, W = 2.15;
  const shell = new THREE.MeshStandardMaterial({ color: 0xf5f8fa, roughness: 0.35 });

  const boxBody = new THREE.Mesh(new THREE.BoxGeometry(L * 0.64, 2.2, W), shell);
  boxBody.position.set(L * 0.13, 1.45, 0);
  boxBody.castShadow = true;
  g.add(boxBody);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(L * 0.36, 1.7, W - 0.1), shell);
  cab.position.set(-L * 0.31, 1.2, 0);
  g.add(cab);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(L * 0.98, 0.4, W + 0.04),
    new THREE.MeshStandardMaterial({ color: 0xd21f26, roughness: 0.5 }));
  stripe.position.set(0, 1.05, 0);
  g.add(stripe);

  const red = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.22, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x120000, emissive: 0xff2a2a, emissiveIntensity: 4, toneMapped: false }));
  red.position.set(-L * 0.2, 2.68, -0.5);
  g.add(red);
  const blue = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.22, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x000012, emissive: 0x2f6cff, emissiveIntensity: 4, toneMapped: false }));
  blue.position.set(-L * 0.2, 2.68, 0.5);
  g.add(blue);

  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12);
  for (const [lz, lx] of [[-0.3, -1], [-0.3, 1], [0.3, -1], [0.3, 1]]) {
    const wheel = new THREE.Mesh(wheelGeo, MAT.wheel);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(lz * L, 0.42, lx * (W / 2 - 0.06));
    g.add(wheel);
  }

  const beam = new THREE.PointLight(0xff4040, 0, 50, 1.6);
  beam.position.set(0, 3.4, 0);
  g.add(beam);

  g.visible = false;
  scene.add(g);
  return { group: g, red: red.material, blue: blue.material, beam };
}

export function updateJunctionAmbulance(view, ev, t) {
  if (!ev || ev.done) { view.group.visible = false; return; }
  view.group.visible = true;
  view.group.position.set(ev.x, 0, ev.y);
  view.group.rotation.y = -ev.heading;
  const phase = Math.floor(t * 7) % 2 === 0;
  view.red.emissiveIntensity = phase ? 7 : 0.3;
  view.blue.emissiveIntensity = phase ? 0.3 : 7;
  view.beam.intensity = 22;
  view.beam.color.set(phase ? 0xff3535 : 0x3f7bff);
}
