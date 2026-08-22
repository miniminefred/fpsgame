import * as THREE from 'three';
import { getAssets } from './textures.js';

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

// Rest levels for the three fill lights. A floor's theme scales all three (see
// setMood), so they have to be recorded rather than read back off the lights.
const BASE_HEMI = 0.82;
const BASE_AMBIENT = 0.36;
const BASE_SUN = 0.85;

// The two unlit materials the ceiling tubes are drawn with (see
// buildCeilingLights in gen/build.js — `panel` front of house, `panelWarm`
// back). setPower tints them, which is what makes a floor on quarter power
// read as one: they are the only part of the lighting the player looks
// straight at, and a tube burning at full while the room under it is dark
// says the lights are fine and the renderer is broken.
//
// They are drawn from getAssets(), which is built once and shared by EVERY
// floor and never disposed — so a tint is not scoped to the floor that applied
// it, and the rest level has to be recorded and put back. setFixtures (a new
// floor) and dispose both do that by way of setPower(1).
const PANEL_KEYS = ['panel', 'panelWarm'];

// Below this the fill stops being moody and starts being a bug report; it is
// the darkest the engine supports, whether that darkness came from a theme, a
// dead generator, or the two of them at once.
const MIN_FILL = 0.15;

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
  const hemi = new THREE.HemisphereLight(0xe8f0f8, 0x484c52, BASE_HEMI);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xc6cfd8, BASE_AMBIENT);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff4e2, BASE_SUN);
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
  let dim = 1;                   // this floor's mood, see setMood
  let power = 1;                 // what the building is supplying, see setPower
  const best = [];

  // The tubes' rest colour, taken once so a tint can always be undone against
  // the material as it was authored rather than against whatever it currently
  // happens to be — scaling in place would compound every call.
  const panelRest = PANEL_KEYS.map((key) => {
    const material = getAssets().materials[key];
    return { material, color: material.color.clone() };
  });

  function setFixtures(list) {
    fixtures = list ?? [];
    sinceRehome = REHOME_INTERVAL;
    for (const l of lights) l.intensity = 0;
    // A new floor has its own supply, and the materials are shared with the
    // one that just ended.
    setPower(1);
  }

  // The fill is the theme and the supply together, which is why it is not
  // written from either setter directly.
  function applyFill() {
    const k = Math.max(MIN_FILL, dim * power);
    hemi.intensity = BASE_HEMI * k;
    ambient.intensity = BASE_AMBIENT * k;
    sun.intensity = BASE_SUN * (0.45 + k * 0.55);
  }

  /**
   * How lit this floor is, as a multiplier on everything that is not a fixture.
   * The tubes themselves keep their own brightness — a dark floor with dark
   * ceiling panels reads as a rendering fault rather than as a dark floor. What
   * comes down is the fill: the hemisphere, the ambient and the contact sun, so
   * the pools under the fixtures stay put and everything between them goes.
   *
   * Which is exactly what a floor that has half its lights off looks like, and
   * it costs nothing — no lights are added or removed, so nothing recompiles.
   */
  function setMood(level = 1) {
    dim = Math.max(MIN_FILL, level);
    applyFill();
  }

  /**
   * How hard the building is driving its own lights, as a fraction of normal —
   * 1 until this floor's generator is shot, then a quarter of everything (see
   * POWER_CUT_POWER in game.js).
   *
   * This is a different question from setMood above and multiplies with it. A
   * theme says how much of the floor is lit and how bright the fill between the
   * fixtures is; the supply says how hard each tube that IS lit burns. So it is
   * the one thing here that dims the tubes themselves, and it dims all three
   * halves of a lit floor at once — the emissive panels you look at, the pool
   * lights they cast, and the fill. Dimming any two of the three reads as a
   * render fault rather than as a brownout: dark rooms under bright tubes says
   * the lighting is broken, and bright rooms under dark tubes says the tubes
   * are.
   *
   * Nothing is added or removed, so nothing recompiles — this is a colour write
   * on two shared materials plus three intensities.
   */
  function setPower(level = 1) {
    power = Math.max(0, level);
    for (const { material, color } of panelRest) {
      material.color.copy(color).multiplyScalar(power);
    }
    applyFill();
  }

  // A shot-out ceiling tube or a broken window. Dropping it from the candidate
  // list is not enough on its own — a pool light may already be sitting on it,
  // and would keep burning there until the next re-home — so any light standing
  // on the dead fixture is killed on the spot.
  function removeFixture(fixture) {
    const i = fixtures.indexOf(fixture);
    if (i === -1) return;
    fixtures.splice(i, 1);
    for (const l of lights) {
      if (l.position.distanceToSquared(fixture) < 1e-6) l.intensity = 0;
    }
    sinceRehome = REHOME_INTERVAL;
  }

  // The pool lights cast no shadows — twelve shadowed point lights would cost
  // six cube faces each — so on their own they shine straight through walls and
  // light up the ceiling of the room next door. Filtering candidates by line of
  // sight fixes that far more cheaply than shadow maps: a fixture you cannot
  // see cannot light you. Pass a (ax,az,bx,bz) => boolean clear-line test.
  function setOcclusion(losClear) {
    visible = losClear ?? null;
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
      // Fixtures dim with the floor's MOOD only halfway: the tubes are the last
      // thing to go, and a room with no pools of light in it at all is not
      // moody, it is broken. The SUPPLY is not hedged like that — a tube on
      // quarter power puts out a quarter, and the pool under it has to agree
      // with the panel overhead or one of them is lying.
      light.intensity = f.intensity * (0.5 + dim * 0.5) * power
        * Math.max(0, 1 - pick.d2 / (edge * 2.5));
    }
  }

  function dispose() {
    // The tubes' materials outlive this lighting rig — see PANEL_KEYS.
    setPower(1);
    scene.remove(hemi, ambient, sun, sun.target);
    for (const l of lights) scene.remove(l);
    sun.dispose();
  }

  return { setFixtures, removeFixture, setOcclusion, setMood, setPower, update, dispose, sun };
}
