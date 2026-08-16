// Renderer, sky, lighting and the ghat fog band.
//
// Materials are physically-based and lit by an environment map generated from
// the sky gradient at runtime. That matters more than polygon count for how
// "real" the scene reads: without an env map, metal and glass have nothing to
// reflect and every surface looks like flat plastic. Generating it in-engine
// keeps the repo free of a 20 MB HDRI while still getting most of the benefit.

import * as THREE from 'three';

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const sky = skyTexture();
  scene.background = sky;
  scene.fog = new THREE.Fog(0xc3d6e2, 500, 2400);

  // Environment map for reflections, baked once from the sky.
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromEquirectangular(sky).texture;

  const camera = new THREE.PerspectiveCamera(55, 2, 0.5, 7000);

  scene.add(new THREE.HemisphereLight(0xdcecff, 0x53583a, 0.7));

  const sun = new THREE.DirectionalLight(0xfff1d8, 2.4);
  sun.position.set(-320, 420, 260);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.7;
  Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 170, bottom: -170, near: 1, far: 1200 });
  scene.add(sun, sun.target);

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  return { renderer, scene, camera, sun, resize };
}

/** Vertical gradient sky with the hazy Deccan-plateau horizon. */
function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#2d6cb4');
  grad.addColorStop(0.34, '#6aa3d8');
  grad.addColorStop(0.66, '#a8c8e4');
  grad.addColorStop(0.85, '#d9e4e7');
  grad.addColorStop(1.00, '#e7e3d3');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

/**
 * The Igatpuri-side fog band, drawn as stacked translucent planes rather than
 * by changing scene.fog — only part of the corridor is in it, and the whole
 * reason it is modelled is that the ambulance drives *into* it.
 */
export function createFogBand(scene, fromX, toX, halfWidth) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xe2e9ec, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide,
  });
  const len = toX - fromX;
  for (let i = 0; i < 8; i++) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(len, 30), mat);
    plane.position.set(fromX + len / 2, 4 + i * 3.2, -halfWidth + (i / 7) * halfWidth * 2);
    group.add(plane);
  }
  scene.add(group);
  return group;
}
