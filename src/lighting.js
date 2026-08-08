import * as THREE from 'three';

// Indoor lighting.
//
// A floor has a hundred-odd ceiling fixtures and windows, and none of them can
// be real lights — three recompiles every material when the light count
// changes, and even a dozen shadowed point lights would sink the frame rate.
// So the fixtures are just emissive panels in the batched geometry (they stay
// visible across the whole floor), and a small FIXED pool of point lights is
// re-homed every few frames onto whichever fixtures are nearest the player.
// The pool never grows or shrinks, so the shaders compile once.
//
// On top of that sits one steeply-angled directional light. It is physically
// nonsense indoors, but it is what gives props and enemies contact shadows, and
// without it a flat-lit office reads as cardboard.

const POOL = 12;
const REHOME_INTERVAL = 0.12;  // seconds between reassignments
const MAX_RANGE = 18;          // metres — beyond this a fixture never gets a light

const SUN_DIR = new THREE.Vector3(0.28, 1, 0.2).normalize();
const SUN_DIST = 30;
const RADIUS = 16;             // half-size of the shadowed region around the player
const MAP = 2048;

export function createLighting(scene) {
  // The pool only ever lights the dozen fixtures nearest the player, so the
  // fill has to carry every room you can see but aren't standing in. Erring
  // bright here is deliberate: this is a strip-lit office, not a horror game,
  // and a corridor you can't read is just frustrating.
  // Enough that no room is ever unreadable, but not so much that the fixtures
  // stop mattering — the pools of light under the ceiling tubes are what give
  // a flat white corridor any shape at all.
  const hemi = new THREE.HemisphereLight(0xe8f0f8, 0x484c52, 0.82);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xc6cfd8, 0.36);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff4e2, 0.85);
  sun.castShadow = true;
  sun.shadow.mapSize.set(MAP, MAP);

  const cam = sun.shadow.camera;
  cam.left = -RADIUS; cam.right = RADIUS;
  cam.top = RADIUS; cam.bottom = -RADIUS;
  cam.near = 0.5;
  cam.far = SUN_DIST + RADIUS * 2;
  cam.updateProjectionMatrix();

  // Same reasoning as the old outdoor sun: a small player-following frustum
  // buys crisp texels, radius 1 takes the sawtooth off without opening a
  // contact leak, and no bias is needed when nothing large self-shadows.
  sun.shadow.radius = 1;
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 0.02;

  scene.add(sun);
  scene.add(sun.target);

  const lights = [];
  for (let i = 0; i < POOL; i++) {
    const light = new THREE.PointLight(0xfff2d6, 0, 9, 2);
    light.castShadow = false;
    scene.add(light);
    lights.push(light);
  }

  // Texel-snapping basis, so shadow edges don't crawl as the player walks.
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
  const up = new THREE.Vector3().crossVectors(SUN_DIR, right).normalize();
  const texel = (RADIUS * 2) / MAP;
  const center = new THREE.Vector3();

  let fixtures = [];
  let visible = null;            // (x, z) => boolean, set per floor
  let sinceRehome = REHOME_INTERVAL;
  const best = [];

  function setFixtures(list) {
    fixtures = list ?? [];
    sinceRehome = REHOME_INTERVAL;
    for (const l of lights) l.intensity = 0;
  }

  // The pool lights cast no shadows — twelve shadowed point lights would cost
  // six cube faces each — so on their own they shine straight through walls and
  // light up the ceiling of the room next door. Filtering candidates by line of
  // sight fixes that far more cheaply than shadow maps: a fixture you cannot
  // see cannot light you. Pass a (ax,az,bx,bz) => boolean clear-line test.
  function setOcclusion(losClear) {
    visible = losClear
      ? (px, pz, fx, fz) => losClear(px, pz, fx, fz)
      : null;
  }

  function update(dt, position) {
    // --- contact-shadow light follows the player
    center.set(position.x, 0, position.z);
    const u = Math.round(center.dot(right) / texel) * texel;
    const v = Math.round(center.dot(up) / texel) * texel;
    const d = center.dot(SUN_DIR);
    center.set(0, 0, 0).addScaledVector(right, u).addScaledVector(up, v).addScaledVector(SUN_DIR, d);

    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(SUN_DIR, SUN_DIST);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();

    // --- re-home the pool onto the nearest fixtures
    sinceRehome += dt;
    if (sinceRehome < REHOME_INTERVAL || !fixtures.length) return;
    sinceRehome = 0;

    // Partial selection of the POOL nearest fixtures — cheaper than sorting
    // the whole list, and the list is rebuilt several times a second.
    best.length = 0;
    for (const f of fixtures) {
      const dx = f.x - position.x;
      const dy = f.y - position.y;
      const dz = f.z - position.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      // Distance first — it rejects most of the floor for the price of a
      // multiply, so the line-of-sight walk only runs on nearby fixtures.
      if (d2 > MAX_RANGE * MAX_RANGE) continue;
      if (visible && !visible(position.x, position.z, f.x, f.z)) continue;

      if (best.length < POOL) {
        best.push({ f, d2 });
        if (best.length === POOL) best.sort((a, b) => a.d2 - b.d2);
      } else if (d2 < best[POOL - 1].d2) {
        best[POOL - 1] = { f, d2 };
        best.sort((a, b) => a.d2 - b.d2);
      }
    }

    for (let i = 0; i < POOL; i++) {
      const light = lights[i];
      const pick = best[i];
      if (!pick) { light.intensity = 0; continue; }

      const { f } = pick;
      light.position.set(f.x, f.y, f.z);
      light.color.setHex(f.color);
      light.distance = f.distance;
      // Fade the furthest ones out so a fixture swapping in doesn't pop.
      const edge = f.distance * f.distance;
      light.intensity = f.intensity * Math.max(0, 1 - pick.d2 / (edge * 2.5));
    }
  }

  function dispose() {
    scene.remove(hemi, ambient, sun, sun.target);
    for (const l of lights) scene.remove(l);
    sun.dispose();
  }

  return { setFixtures, setOcclusion, update, dispose, sun };
}
