import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WEAPONS, measureMuzzle, makeMuzzleFlash } from './weapons.js';

// Contact sheet for placing the muzzle flash.
//
// The game only ever shows you a gun from one angle — down the sights, in the
// corner of the screen — which is exactly the angle that hides a flash sitting
// ten centimetres left of the bore. So every gun is loaded here the way the
// viewmodel loads it, the flash is lit on it permanently, and each one is drawn
// from several directions at once. A flash that is off the barrel is obvious
// from the side and invisible from behind.
//
// Not part of the shipped game — served only at /dev-guns.html.
//
//   ?angles=side,top,back,quarter   which views to draw, in order
//   ?keys=Pistol,SMG                only these guns (matched loosely)
//   ?flash=0                        hide the flash and just look at the gun
//   ?zoom=1.4                       pull the tile cameras in or out
//
// window.__report() dumps every measured muzzle as JSON, which is what the
// `muzzle` nudges in the WEAPONS table were tuned against.

const qs = new URLSearchParams(location.search);
const ANGLES = (qs.get('angles') || 'side,quarter,top,back').split(',').filter(Boolean);
const ONLY = (qs.get('keys') || '').split(',').filter(Boolean);
const SHOW_FLASH = qs.get('flash') !== '0';
const ZOOM = +(qs.get('zoom') || 1);

// Where each named camera sits, as a direction from the gun. The gun is built
// pointing -Z, so "back" is the player's own view and "side" is the one that
// actually settles whether the flash is on the bore.
const VIEWS = {
  side: [1, 0.12, 0],
  quarter: [0.85, 0.45, 0.7],
  top: [0.02, 1, 0.02],
  back: [0.05, 0.12, 1],
  front: [0, 0.1, -1],
};

const app = document.getElementById('app');
const labels = document.getElementById('labels');
const bar = document.getElementById('bar');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setScissorTest(true);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
scene.add(new THREE.HemisphereLight(0xdfeaf6, 0x30343a, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(2, 3, 2);
scene.add(key);

const tiles = [];

// One lit flash per tile — the game's own, imported rather than rebuilt. An
// earlier version of this harness made its own copy and the two drifted inside
// a day, which meant the placement was being tuned against a flash that only
// ever existed here.
function makeFlash() {
  return makeMuzzleFlash().group;
}

// A cross at the measured muzzle point, so its position is readable even with
// the flash turned off.
function makeCross() {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0x64ffa0 });
  for (const axis of [[0.05, 0, 0], [0, 0.05, 0], [0, 0, 0.05]]) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-axis[0], -axis[1], -axis[2]),
      new THREE.Vector3(axis[0], axis[1], axis[2]),
    ]);
    g.add(new THREE.Line(geo, mat));
  }
  return g;
}

const loader = new GLTFLoader();
const report = [];

// Mirrors weapons.js `_onLoaded` exactly: centre, auto-orient the long axis to
// -Z, scale to the configured on-screen length. Any drift between the two and
// this harness is measuring a gun the game never sees.
function buildRig(cfg, model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  model.position.sub(center);

  const inner = new THREE.Group();
  inner.add(model);
  if (size.x >= size.z) inner.rotation.y = Math.PI / 2;
  if (cfg.flip) inner.rotation.y += Math.PI;
  inner.rotation.y += cfg.yaw;
  inner.scale.setScalar(cfg.length / (Math.max(size.x, size.z) || 1));

  const rig = new THREE.Group();
  rig.add(inner);
  return rig;
}

async function build() {
  const wanted = WEAPONS.filter((w) => !ONLY.length
    || ONLY.some((k) => w.name.toLowerCase().includes(k.toLowerCase())));

  for (const cfg of wanted) {
    const gltf = await loader.loadAsync(cfg.file);
    const rig = buildRig(cfg, gltf.scene);
    scene.add(rig);

    const muzzle = measureMuzzle(rig, cfg);
    report.push({
      name: cfg.name,
      muzzle: [+muzzle.x.toFixed(4), +muzzle.y.toFixed(4), +muzzle.z.toFixed(4)],
      nudge: cfg.muzzle ?? null,
    });

    if (SHOW_FLASH) {
      const flash = makeFlash();
      flash.position.copy(muzzle);
      rig.add(flash);
    }
    const cross = makeCross();
    cross.position.copy(muzzle);
    rig.add(cross);

    for (const angle of ANGLES) {
      const dir = VIEWS[angle] ?? VIEWS.side;
      const cam = new THREE.PerspectiveCamera(38, 1, 0.01, 20);
      // Framed on the gun's whole length, so guns of different sizes are
      // directly comparable tile to tile.
      const dist = (cfg.length * 2.1) / ZOOM;
      const v = new THREE.Vector3(...dir).normalize().multiplyScalar(dist);
      cam.position.copy(v);
      cam.lookAt(0, 0, 0);
      tiles.push({ cfg, angle, cam, rig, muzzle });
    }
  }

  window.__report = () => JSON.stringify(report, null, 1);
  bar.textContent =
    `${wanted.length} gun(s) x ${ANGLES.join(', ')} — green cross is the measured muzzle. `
    + 'window.__report() for numbers.';
  layout();
}

function layout() {
  labels.innerHTML = '';
  const cols = ANGLES.length;
  const rows = Math.max(1, Math.ceil(tiles.length / cols));
  const w = innerWidth / cols;
  const h = (innerHeight - 26) / rows;

  tiles.forEach((tile, i) => {
    tile.rect = {
      x: (i % cols) * w,
      y: Math.floor(i / cols) * h,
      w, h,
    };
    tile.cam.aspect = w / h;
    tile.cam.updateProjectionMatrix();

    const div = document.createElement('div');
    div.className = 'tile';
    div.style.left = `${tile.rect.x}px`;
    div.style.top = `${tile.rect.y}px`;
    div.innerHTML = `<b>${tile.cfg.name}</b> <span class="dim">${tile.angle}</span><br>`
      + `<span class="dim">muzzle ${tile.muzzle.x.toFixed(3)}, `
      + `${tile.muzzle.y.toFixed(3)}, ${tile.muzzle.z.toFixed(3)}</span>`;
    labels.appendChild(div);

    const border = document.createElement('div');
    border.className = 'cellborder';
    border.style.cssText =
      `left:${tile.rect.x}px;top:${tile.rect.y}px;width:${w}px;height:${h}px`;
    labels.appendChild(border);
  });
}

function frame() {
  requestAnimationFrame(frame);
  // Only the tile's own gun is visible while that tile renders — every rig sits
  // at the origin, so without this every tile would draw all five on top of
  // each other.
  for (const tile of tiles) {
    if (!tile.rect) continue;
    for (const other of tiles) other.rig.visible = other.rig === tile.rig;

    const { x, y, w, h } = tile.rect;
    const bottom = innerHeight - (y + h);
    renderer.setViewport(x, bottom, w, h);
    renderer.setScissor(x, bottom, w, h);
    renderer.render(scene, tile.cam);
  }
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  layout();
});

renderer.setAnimationLoop(null);
build().then(frame);
