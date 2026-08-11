import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MODEL_TABLE, MODEL_DIR } from './model-table.js';

// Downloaded office furniture, normalized and flattened for batching.
//
// The models arrive at arbitrary scales facing arbitrary directions;
// model-table.js records the yaw and scale that put each one at real-world size
// facing -Z, resting on y=0. This module applies that transform once at load,
// then bakes each model down to one merged geometry per material so a floor's
// worth of desks costs a handful of draw calls rather than one per leg.
//
// Everything here is optional: if a model is missing or fails to load, the prop
// falls back to the boxes it was authored from (see props.js).
//
// Each material group also gives up a flat colour and a scatter of surface
// points, which is what lets the debris of a model-backed prop wear the model's
// own colours instead of the procedural palette — see `paintDebris`.

const templates = new Map();

// Attributes we keep. Merging requires every geometry in a group to carry the
// same set, and glTF exporters sprinkle in tangents, second UV sets and skin
// weights that nothing here uses.
const KEEP = ['position', 'normal', 'uv', 'color'];

// What a placer needs to know about a model in order to reserve floor for it:
// its footprint and its height. Both are recorded in MODEL_TABLE for all 71
// entries, and `bake` only measures the bounding box when the table leaves one
// out — so the numbers are knowable without a GLTFLoader, a fetch or a GPU.
//
// That is what this exists for. The headless validators in tools/ run in Node,
// where `loadModels` never runs and `templates` stays empty; answering `null`
// there fit-tested every model-backed prop at its hand-authored FALLBACK size
// instead of the size it ships at — off by up to 0.25 m per prop — so the
// placement invariants were being proved against a floorplan the game does not
// build. The table is the same data the browser ends up with, so serving it
// straight is what makes the sweep measure the shipped floor.
//
// `parts` being empty is the point, not an omission: `stampModel` and
// `paintDebris` read `templates` and only `templates`, so a table-only entry
// draws nothing and paints nothing. The prop falls back to its authored boxes
// for the PICTURE (see `tryPlace`) while the FOOTPRINT stays the model's — in
// Node, and in a browser whose GLB failed to fetch, alike. Those are the same
// case and they should not disagree about where the furniture stands.
function tableInfo(key) {
  const spec = MODEL_TABLE[key];
  // No entry, or an entry with no measured footprint, means there is nothing
  // authoritative to reserve — the prop is on its own boxes, footprint included.
  if (!spec?.foot) return null;
  return {
    parts: [],
    foot: spec.foot,
    height: spec.height ?? 0,
    mount: spec.mount ?? 'floor',
    tags: spec.tags ?? [],
  };
}

export function modelInfo(key) {
  return templates.get(key) ?? tableInfo(key);
}

// Loads the given keys (defaults to every entry in the table). Anything that
// fails is simply left absent — the caller falls back to procedural geometry.
export async function loadModels(keys = Object.keys(MODEL_TABLE)) {
  const loader = new GLTFLoader();

  await Promise.all(keys.map(async (key) => {
    const spec = MODEL_TABLE[key];
    if (!spec || templates.has(key)) return;
    try {
      const gltf = await loader.loadAsync(MODEL_DIR + spec.file);
      templates.set(key, bake(gltf.scene, spec));
    } catch (err) {
      console.warn(`[models] ${key} (${spec.file}) failed to load — falling back`, err);
    }
  }));

  return templates;
}

// Applies the normalization transform and collapses the model to a flat list of
// { geometry, material } in model space, ready to be stamped into the world.
function bake(scene, spec) {
  const root = new THREE.Group();
  root.add(scene);

  // Matches the documented contract: yaw, then uniform scale, then recentre.
  scene.rotation.y = spec.yaw;
  scene.scale.setScalar(spec.scale);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  scene.position.x -= (box.min.x + box.max.x) / 2;
  scene.position.z -= (box.min.z + box.max.z) / 2;
  scene.position.y -= box.min.y;
  root.updateMatrixWorld(true);

  // Group by material, then merge — a Quaternius desk is a dozen little meshes
  // sharing two materials, and merging them here means one geometry to
  // transform per placement instead of a dozen.
  const groups = new Map();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const material = mats[0];
    if (!material) return;

    const geo = strip(o.geometry);
    geo.applyMatrix4(o.matrixWorld);

    const list = groups.get(material) ?? [];
    list.push(geo);
    groups.set(material, list);
  });

  const parts = [];
  for (const [material, geos] of groups) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (geos.length > 1) for (const g of geos) g.dispose();
    if (merged) {
      const samples = sampleSurface(merged);
      parts.push({
        geometry: merged,
        material,
        swatch: swatchFor(material, samples),
        samples,
      });
    }
  }

  const measured = new THREE.Box3().setFromObject(root);
  return {
    parts,
    foot: spec.foot ?? [measured.max.x - measured.min.x, measured.max.z - measured.min.z],
    height: spec.height ?? (measured.max.y - measured.min.y),
    mount: spec.mount ?? 'floor',
    tags: spec.tags ?? [],
  };
}

// A clone carrying only the attributes every group is guaranteed to share.
function strip(source) {
  const geo = new THREE.BufferGeometry();
  geo.index = source.index;

  for (const name of KEEP) {
    const attr = source.getAttribute(name);
    if (attr) geo.setAttribute(name, attr.clone());
  }
  if (!geo.getAttribute('position')) return geo;
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('uv')) {
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array(geo.getAttribute('position').count * 2), 2));
  }
  // The index is shared with the source, so clone it rather than aliasing it
  // into geometry that is about to be transformed and disposed.
  if (geo.index) geo.index = geo.index.clone();
  return geo;
}

// --- what the model looks like when it is in pieces --------------------------
//
// A model-backed prop is drawn as a GLB and breaks into the boxes its `build`
// authored, so without help a scarlet vending machine bursts into pale office
// laminate — the ruins read as somebody else's furniture. Slicing the model's
// triangles at runtime is the expensive answer; this is the cheap one. Each
// material group is reduced to one flat colour and a scatter of points on its
// surface, and a fragment takes the colour of whichever group it came out of.
//
// Every sample carries the surface AREA it stands for, and that is what makes
// the answer right. Counting points would let a keypad modelled out of forty
// little quads outvote the whole front panel it sits on, and a fragment the size
// of the machine would come out keypad-grey. Weighted by area, "which group is
// this fragment made of" is decided by how much of each group it actually
// contains — so the body panel wins the body and the keypad wins the keypad.

const SAMPLES = 96;          // surface points kept per material group
const PAINT_TOL = 0.1;       // metres a fragment may sit off the model and still be part of it

// A flat stand-in for a model material: its base colour, tinted by whatever its
// texture averages to over the geometry that actually uses it. Averaging over
// the group's own UVs — by area, again — matters, because most of these
// textures are palette atlases and the mean of the whole sheet is mud.
function swatchFor(material, samples) {
  const color = material.color ? material.color.clone() : new THREE.Color(0xffffff);
  const tint = material.map ? averageTexel(material.map, samples) : null;
  if (tint) color.multiply(tint);

  return new THREE.MeshStandardMaterial({
    color,
    roughness: material.roughness ?? 0.85,
    metalness: material.metalness ?? 0,
  });
}

// Mean colour of the texels the samples' UVs land on, or null if the image
// can't be read (no DOM in the headless validators, compressed formats).
function averageTexel(map, samples) {
  const image = map.image;
  if (!samples.count || !image || typeof document === 'undefined') return null;

  try {
    const w = Math.min(image.width || 0, 256);
    const h = Math.min(image.height || 0, 256);
    if (!w || !h) return null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    let r = 0, g = 0, b = 0, total = 0;
    for (let i = 0; i < samples.count; i++) {
      // glTF hands us textures with flipY off, so v runs down from the top row.
      const u = fract(samples.uv[i * 2]);
      const v = fract(samples.uv[i * 2 + 1]);
      const px = Math.min(w - 1, Math.floor(u * w));
      const py = Math.min(h - 1, Math.floor((map.flipY ? 1 - v : v) * h));
      const o = (py * w + px) * 4;
      const a = samples.area[i];
      r += data[o] * a; g += data[o + 1] * a; b += data[o + 2] * a;
      total += a;
    }
    if (!total) return null;
    // Texels are sRGB; the colour they multiply into is linear.
    return new THREE.Color().setRGB(
      r / total / 255, g / total / 255, b / total / 255, THREE.SRGBColorSpace);
  } catch (err) {
    return null;
  }
}

/**
 * Thins a material group down to at most SAMPLES points on its surface, each
 * standing for a share of its area. Triangles are bucketed in runs; the bucket
 * keeps its biggest triangle's centroid — a point that is definitely ON the
 * surface, unlike the mean of a run that straddles two ends of the model — and
 * inherits the area of the whole run.
 */
function sampleSurface(geometry) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const index = geometry.index;
  const tris = (index ? index.count : pos?.count ?? 0) / 3;
  const empty = { count: 0, pos: new Float32Array(0), uv: new Float32Array(0), area: new Float32Array(0) };
  if (!pos?.count || tris < 1) return empty;

  const stride = Math.ceil(tris / SAMPLES);
  const count = Math.ceil(tris / stride);
  const out = {
    count,
    pos: new Float32Array(count * 3),
    uv: new Float32Array(count * 2),
    area: new Float32Array(count),
  };
  const biggest = new Float32Array(count);

  for (let t = 0; t < tris; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    _a.fromBufferAttribute(pos, ia);
    _b.fromBufferAttribute(pos, ib);
    _c.fromBufferAttribute(pos, ic);
    const area = _b.clone().sub(_a).cross(_c.clone().sub(_a)).length() / 2;
    if (!(area > 0)) continue;

    const bucket = Math.floor(t / stride);
    out.area[bucket] += area;
    if (area > biggest[bucket]) {
      biggest[bucket] = area;
      out.pos[bucket * 3] = (_a.x + _b.x + _c.x) / 3;
      out.pos[bucket * 3 + 1] = (_a.y + _b.y + _c.y) / 3;
      out.pos[bucket * 3 + 2] = (_a.z + _b.z + _c.z) / 3;
      if (uv) {
        out.uv[bucket * 2] = (uv.getX(ia) + uv.getX(ib) + uv.getX(ic)) / 3;
        out.uv[bucket * 2 + 1] = (uv.getY(ia) + uv.getY(ib) + uv.getY(ic)) / 3;
      }
    }
  }
  return out;
}

/**
 * Recolours a prop's debris boxes to match the models drawn in their place.
 * `boxes` are world-space and gain a `material`; `stamps` are the models that
 * were stamped for this prop — the prop's own, plus anything standing on it, so
 * the monitor on a desk breaks into monitor colours and not desk ones.
 *
 * A box nowhere near any of them is left alone: it is something the models do
 * not include (the stock on a rack, the cartons on a pallet) and its authored
 * material is already the truth.
 */
export function paintDebris(boxes, stamps) {
  if (!boxes?.length || !stamps?.length) return;

  for (const box of boxes) {
    let best = null;
    let bestArea = 0;
    let bestDist = Infinity;

    for (const stamp of stamps) {
      const tpl = templates.get(stamp.key);
      if (!tpl) continue;
      toModelSpace(box, stamp, _box);

      for (const part of tpl.parts) {
        const s = part.samples;
        let area = 0;
        let near = Infinity;
        for (let i = 0; i < s.count; i++) {
          const d = distanceToBox(s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2], _box);
          if (d < near) near = d;
          if (d <= PAINT_TOL) area += s.area[i];
        }
        // Most surface inside the fragment wins; distance only settles the case
        // where a fragment contains none of the model at all.
        if (area > bestArea || (area === bestArea && near < bestDist)) {
          bestArea = area;
          bestDist = near;
          best = part.swatch;
        }
      }
    }

    if (best && (bestArea > 0 || bestDist <= PAINT_TOL)) box.material = best;
  }
}

// World-space box into the model's own frame. The stamp is a yaw and a
// translation, so rotating the half-extents by |R| keeps the box axis-aligned —
// exact at the quarter turns props actually use.
function toModelSpace(box, stamp, out) {
  const cx = (box.x0 + box.x1) / 2 - stamp.x;
  const cy = (box.y0 + box.y1) / 2 - stamp.y;
  const cz = (box.z0 + box.z1) / 2 - stamp.z;
  const hx = (box.x1 - box.x0) / 2;
  const hy = (box.y1 - box.y0) / 2;
  const hz = (box.z1 - box.z0) / 2;

  const c = Math.cos(-stamp.yaw), s = Math.sin(-stamp.yaw);
  const mx = c * cx + s * cz;
  const mz = -s * cx + c * cz;
  const ax = Math.abs(c) * hx + Math.abs(s) * hz;
  const az = Math.abs(s) * hx + Math.abs(c) * hz;

  out.x0 = mx - ax; out.x1 = mx + ax;
  out.y0 = cy - hy; out.y1 = cy + hy;
  out.z0 = mz - az; out.z1 = mz + az;
}

function distanceToBox(x, y, z, b) {
  const dx = Math.max(b.x0 - x, 0, x - b.x1);
  const dy = Math.max(b.y0 - y, 0, y - b.y1);
  const dz = Math.max(b.z0 - z, 0, z - b.z1);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function fract(v) {
  const f = v - Math.floor(v);
  return f < 0 ? f + 1 : f;
}

const _box = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 };
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _axis = new THREE.Vector3(0, 1, 0);

// Stamps a model into the world. `emit(geometry, material)` receives geometry
// already in world space — the caller decides whether to batch it or keep it as
// its own mesh.
export function stampModel(key, x, y, z, yaw, emit) {
  const tpl = templates.get(key);
  if (!tpl) return false;

  _q.setFromAxisAngle(_axis, yaw);
  _m.compose(_pos.set(x, y, z), _q, _one);

  for (const part of tpl.parts) {
    emit(part.geometry.clone().applyMatrix4(_m), part.material);
  }
  return true;
}
