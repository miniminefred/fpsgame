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

const templates = new Map();

// Attributes we keep. Merging requires every geometry in a group to carry the
// same set, and glTF exporters sprinkle in tangents, second UV sets and skin
// weights that nothing here uses.
const KEEP = ['position', 'normal', 'uv', 'color'];

export function modelInfo(key) {
  return templates.get(key) ?? null;
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
    if (merged) parts.push({ geometry: merged, material });
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
