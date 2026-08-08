import * as THREE from 'three';

// The sun: a directional light whose shadow frustum follows the player.
//
// Shadow crispness is entirely a matter of world-units-per-texel. A static
// frustum big enough to cover the map (±80) spread over a 2048² map gives
// ~8 cm texels, which is what produces stair-stepped shadow edges — and it
// still drops all shadows the moment you walk outside it. Instead we keep a
// small frustum (±RADIUS) parked on the player: ~2 cm texels, everywhere.
const SUN_DIR = new THREE.Vector3(0.5, 0.9, 0.35).normalize();
const SUN_DIST = 60; // how far up along SUN_DIR the light sits
const RADIUS = 20; // half-size of the shadowed region around the player
const MAP = 4096; // ~1 cm texels at RADIUS 20 — fine enough that shadow edges
// read as straight lines instead of a sawtooth when you stand next to a box.

export function createSunlight(scene) {
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(MAP, MAP);

  const cam = sun.shadow.camera;
  cam.left = -RADIUS;
  cam.right = RADIUS;
  cam.top = RADIUS;
  cam.bottom = -RADIUS;
  cam.near = 0.5;
  cam.far = SUN_DIST + RADIUS * 2;
  cam.updateProjectionMatrix();

  // Softness: PCFShadowMap filters with a Vogel disk spanning shadow.radius
  // texels. Widening it smooths the edge, but the disk also straddles the
  // occluder silhouette where a box meets the ground, so part of the disk misses
  // the caster and leaks light — a bright hairline tracing the base of every
  // box, between it and its own shadow. Measured on the ground pixel at a box
  // base (shadowed ground reads rgb 24,51,29):
  //   radius 0 -> 24,51,29   radius 1 -> 29,56,32   radius 3 -> 46,74,42
  // radius 1 is the sweet spot: the leak stays under one pixel while still
  // taking the hard sawtooth off the edge. The small texel size does the rest.
  sun.shadow.radius = 1;

  // No depth bias. Bias exists to stop surfaces self-shadowing ("acne"), but a
  // negative bias pulls the receiver towards the light and so widens the contact
  // leak above (bias -0.001 pushed that same pixel to rgb 63,94,54). This scene
  // doesn't need any: the only shadow casters are boxes and drones, and three
  // renders casters back-face-first into the shadow map, so a lit front face is
  // always compared against the far side of its own geometry. The big ground
  // plane never casts at all, so it cannot self-shadow.
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 0;

  scene.add(sun);
  scene.add(sun.target); // target must be in the graph for its matrix to update

  // Basis perpendicular to the light, used to snap the frustum to whole shadow
  // texels — without this the whole map re-rasterises every frame as you walk
  // and shadow edges visibly crawl/shimmer.
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
  const up = new THREE.Vector3().crossVectors(SUN_DIR, right).normalize();
  const texel = (RADIUS * 2) / MAP;
  const center = new THREE.Vector3();

  function update(position) {
    center.set(position.x, 0, position.z);
    const u = Math.round(center.dot(right) / texel) * texel;
    const v = Math.round(center.dot(up) / texel) * texel;
    const d = center.dot(SUN_DIR);
    center.set(0, 0, 0).addScaledVector(right, u).addScaledVector(up, v).addScaledVector(SUN_DIR, d);

    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(SUN_DIR, SUN_DIST);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  update(new THREE.Vector3());
  return { sun, update };
}
