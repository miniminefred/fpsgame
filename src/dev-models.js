import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MODEL_TABLE, MODEL_REJECTS, MODEL_DIR } from './gen/model-table.js';

// Contact-sheet harness for tuning src/gen/model-table.js. Every model is loaded,
// normalized exactly the way the game will do it (yaw -> uniform scale -> centre
// in X/Z with min Y on the floor) and drawn in its own scissored viewport with a
// 1 m grid and a 1 m reference cube, so scale and facing can be judged by eye.
//
// Not part of the shipped game — served only at /dev-models.html.
//
//   ?i=0&n=12       batch: first index and count
//   ?cols=4         columns in the contact sheet
//   ?mode=front     fixed camera 4.6 m out, identical for every tile
//                   -> tiles are directly comparable in size (default)
//        fit        camera pulled back to frame each model individually
//                   -> best for judging shape and spotting broken models
//        straight   dead-on view of the -Z face -> decides facing outright
//        top        straight down, -Z is screen-up
//        under      worm's-eye view, for ceiling fixtures
//   ?keys=desk,mug  render only these table keys (comma separated)
//   ?spin=desk      one model four times at table yaw +0/90/180/270
//   ?dy=180         extra yaw in degrees on top of the table value
//   ?raw=1          ignore the table: scale 1, yaw 0 (shows the raw GLB)
//
// window.__report() dumps measured raw + normalized sizes as JSON, which is how
// the table's foot/height values were cross-checked against reality.

const qs = new URLSearchParams(location.search);
const MODE = qs.get('mode') || 'front';
const RAW = qs.get('raw') === '1';
const COLS = +(qs.get('cols') || 4);
const START = +(qs.get('i') || 0);
const COUNT = +(qs.get('n') || 12);
const ONLY = (qs.get('keys') || '').split(',').filter(Boolean);
// Extra yaw in degrees added on top of the table value — screenshot the same
// prop at dy=0/90/180/270 to find which side is really the front.
const DY = (+(qs.get('dy') || 0)) * Math.PI / 180;

// ---------------------------------------------------------------- model list
const MANIFESTS = ['manifest-tech.json', 'manifest-store.json', 'manifest-furn.json'];

async function buildList() {
  const tabled = new Set(Object.values(MODEL_TABLE).map((e) => e.file));
  const entries = [];
  for (const [key, e] of Object.entries(MODEL_TABLE)) entries.push({ key, ...e });
  // Anything in a manifest that the table does not cover: show it raw so it can
  // either be measured or consciously rejected.
  for (const m of MANIFESTS) {
    const list = await fetch(MODEL_DIR + m).then((r) => r.json());
    for (const it of list) {
      if (tabled.has(it.file)) continue;
      const rejected = Object.keys(MODEL_REJECTS).some((k) => it.file.includes(k));
      entries.push({
        key: it.key + (rejected ? ' (rejected)' : ''),
        file: it.file, scale: 1, yaw: 0, foot: [0, 0], height: 0,
        tags: [], mount: '?', untabled: true, rejected,
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------- three setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2e34);
scene.add(new THREE.HemisphereLight(0xffffff, 0x50565e, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-3, 6, -4);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.7);
fill.position.set(4, 3, 5);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 200);

const loader = new GLTFLoader();
const tiles = [];

// ------------------------------------------------------------- tile scaffold
function scaffold(group, size) {
  const w = Math.max(size?.x || 0, size?.z || 0);
  const big = w > 1.7 || (size?.y || 0) > 1.7;
  const span = Math.max(2, Math.ceil(w + 2.4));
  if (MODE === 'under') return; // the floor would occlude a worm's-eye view
  const grid = new THREE.GridHelper(span, span, 0x7f8894, 0x474d55);
  grid.position.y = 0.001;
  group.add(grid);
  if (!big) { // 10 cm sub-grid for small props
    const fine = new THREE.GridHelper(1, 10, 0x3d444c, 0x3d444c);
    fine.position.y = 0.0005;
    group.add(fine);
  }
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(span, span),
    new THREE.MeshStandardMaterial({ color: 0x53595f, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  // 1 m reference cube, parked behind the model (+Z) and to the +X side so it
  // never sits between the camera (which is on -Z) and the prop.
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.8 }),
  );
  cube.position.set((size?.x || 0) / 2 + 0.62, 0.5, (size?.z || 0) / 2 + 0.62);
  group.add(cube);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(cube.geometry),
    new THREE.LineBasicMaterial({ color: 0x1a1d20 }),
  );
  edges.position.copy(cube.position);
  group.add(edges);

  // Forward marker: fat red arrow along -Z, the direction every model's front
  // is supposed to point. Blue strip marks the -Z edge of the tile.
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.28, 4),
    new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
  );
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.02, -span / 2 + 0.16);
  group.add(arrow);
  const shaft = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.01, span * 0.3),
    new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
  );
  shaft.position.set(0, 0.02, -span / 2 + 0.16 + span * 0.15 + 0.14);
  group.add(shaft);
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(span, 0.012, 0.07),
    new THREE.MeshBasicMaterial({ color: 0x3aa8ff }),
  );
  strip.position.set(0, 0.02, -span / 2 + 0.035);
  group.add(strip);
}

function normalize(root, scale, yaw) {
  root.rotation.set(0, 0, 0);
  root.scale.setScalar(1);
  root.position.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(root);
  const rawSize = rawBox.getSize(new THREE.Vector3());

  root.rotation.y = yaw;          // 1. yaw
  root.scale.setScalar(scale);    // 2. uniform scale
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.set(-c.x, -box.min.y, -c.z); // 3. centre X/Z, sit on floor
  root.updateMatrixWorld(true);
  const finalBox = new THREE.Box3().setFromObject(root);
  return { rawSize, size: finalBox.getSize(new THREE.Vector3()) };
}

async function load(entry, index) {
  const group = new THREE.Group();
  const tile = { ...entry, index, group, status: 'loading' };
  const extra = entry.spin || 0;
  scene.add(group);
  tiles.push(tile);
  try {
    const gltf = await loader.loadAsync(MODEL_DIR + entry.file);
    const root = gltf.scene;
    const scale = RAW ? 1 : entry.scale;
    const yaw = (RAW ? 0 : entry.yaw) + DY + extra;
    const m = normalize(root, scale, yaw);
    tile.rawSize = m.rawSize;
    tile.size = m.size;
    let meshes = 0, tris = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
      }
    });
    tile.meshes = meshes;
    tile.tris = Math.round(tris);
    tile.status = meshes === 0 || m.size.length() < 1e-4 ? 'degenerate' : 'ok';
    scaffold(group, m.size);
    group.add(root);
  } catch (err) {
    tile.status = 'error';
    tile.error = String(err?.message || err);
    scaffold(group, new THREE.Vector3(1, 1, 1));
  }
  layout();
}

// ------------------------------------------------------------------- layout
const labels = document.getElementById('labels');
const bar = document.getElementById('bar');
let shown = [];

function layout() {
  shown = tiles.slice().sort((a, b) => a.index - b.index);
  // Park tiles far apart so a stray draw cannot bleed into a neighbour cell.
  shown.forEach((t, i) => t.group.position.set(i * 60, 0, 0));
  labels.innerHTML = '';
  const rows = Math.ceil(shown.length / COLS);
  const cw = innerWidth / COLS, ch = innerHeight / rows;
  shown.forEach((t, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    t.cell = { x: col * cw, y: row * ch, w: cw, h: ch };
    const d = document.createElement('div');
    d.className = 'tile';
    d.style.left = `${col * cw}px`;
    d.style.top = `${row * ch}px`;
    d.style.width = `${cw}px`;
    const f = (v) => v.toFixed(2);
    let html = `<b>${t.key}</b>`;
    if (t.status === 'ok') {
      html += `<br><span class="dim">${f(t.size.x)} w x ${f(t.size.z)} d x ${f(t.size.y)} h</span>`
        + `<br>s=${t.scale.toPrecision(4)} yaw=${(t.yaw / Math.PI * 180).toFixed(0)}&deg;`
        + ` ${t.tris} tri`;
      if (t.untabled) html += `<br><span class="${t.rejected ? 'warn' : 'miss'}">`
        + `${t.rejected ? 'REJECTED' : 'NOT IN TABLE'} (raw)</span>`;
    } else if (t.status === 'loading') html += '<br>loading...';
    else html += `<br><span class="miss">${t.status.toUpperCase()} ${t.error || ''}</span>`;
    d.innerHTML = html;
    labels.appendChild(d);
    const b = document.createElement('div');
    b.className = 'cellborder';
    b.style.cssText = `left:${col * cw}px;top:${row * ch}px;width:${cw}px;height:${ch}px`;
    labels.appendChild(b);
  });
  bar.textContent = `mode=${MODE}${RAW ? ' RAW' : ''}  i=${START} n=${COUNT} cols=${COLS}`
    + `${DY ? `  dy=${(DY * 180 / Math.PI).toFixed(0)}deg` : ''}`
    + `  showing ${shown.length}  |  camera views the -Z (front) side; red arrow = -Z`;
}

function aim(t) {
  const s = t.size || new THREE.Vector3(1, 1, 1);
  const cx = t.group.position.x;
  const maxd = Math.max(s.x, s.y, s.z, 0.05);
  if (MODE === 'top') {
    const d = Math.max(s.x, s.z, 0.05) * 2.2 + 0.4;
    camera.up.set(0, 0, -1);
    camera.position.set(cx, d, 0);
    camera.lookAt(cx, 0, 0);
    return;
  }
  if (MODE === 'under') {
    // Worm's-eye view: checks that ceiling fixtures have a lit underside.
    const d = Math.max(s.x, s.z, 0.05) * 1.6 + 0.5;
    camera.up.set(0, 0, 1);
    camera.position.set(cx, -d, 0);
    camera.lookAt(cx, s.y * 0.5, 0);
    return;
  }
  camera.up.set(0, 1, 0);
  if (MODE === 'straight') {
    // Dead-on view of the -Z face: whatever is visible IS the declared front.
    const d = Math.max(s.x, s.y) * 2.1 + s.z * 0.5 + 0.3;
    camera.position.set(cx, s.y * 0.5, -d);
    camera.lookAt(cx, s.y * 0.5, 0);
    return;
  }
  if (MODE === 'fit') {
    const d = maxd * 2.0 + 0.25;
    camera.position.set(cx + d * 0.42, s.y * 0.62 + d * 0.34, -d);
    camera.lookAt(cx, s.y * 0.45, 0);
    return;
  }
  // front: identical camera for every tile, so sizes are comparable at a glance
  const d = 4.6;
  camera.position.set(cx + 1.7, 1.75, -d);
  camera.lookAt(cx, 0.75, 0);
}

function render() {
  renderer.setScissorTest(false);
  renderer.clear();
  for (const t of shown) {
    if (!t.cell) continue;
    for (const o of tiles) o.group.visible = o === t;
    const { x, y, w, h } = t.cell;
    const vy = innerHeight - y - h;
    renderer.setViewport(x, vy, w, h);
    renderer.setScissor(x, vy, w, h);
    renderer.setScissorTest(true);
    camera.aspect = w / h;
    aim(t);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(render);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  layout();
});

window.__report = () => JSON.stringify(shown.map((t) => ({
  key: t.key, file: t.file, status: t.status, scale: t.scale, yaw: t.yaw,
  raw: t.rawSize ? [+t.rawSize.x.toFixed(4), +t.rawSize.y.toFixed(4), +t.rawSize.z.toFixed(4)] : null,
  out: t.size ? [+t.size.x.toFixed(3), +t.size.y.toFixed(3), +t.size.z.toFixed(3)] : null,
  tris: t.tris, meshes: t.meshes, error: t.error,
})));

const all = await buildList();
let list = ONLY.length
  ? all.filter((e) => ONLY.includes(e.key))
  : all.slice(START, START + COUNT);
// ?spin=key1,key2 — each named model four times, at table yaw +0/90/180/270,
// so the real front can be picked out of a single screenshot.
const SPIN = (qs.get('spin') || '').split(',').filter(Boolean);
if (SPIN.length) {
  list = [];
  for (const key of SPIN) {
    const e = all.find((x) => x.key === key);
    if (!e) continue;
    for (let q = 0; q < 4; q++) {
      list.push({ ...e, key: `${key} +${q * 90}`, spin: q * Math.PI / 2 });
    }
  }
}
window.__count = all.length;
window.__keys = all.map((e) => e.key);
for (const [i, e] of list.entries()) await load(e, i);
render();
