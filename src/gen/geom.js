import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry helpers shared by the level builder: world-space UVs and a batcher
// that merges everything sharing a material into a single mesh.

// One texture repeat covers this many world units. Floors, walls and ceilings
// all use it, so a texture never stretches differently on a long wall than on a
// short one.
export const UV_SCALE = 1 / 2;

const _center = new THREE.Vector3();

// Rewrites a geometry's UVs from its world positions, choosing the axis pair
// from each face's normal. Vertical faces get v = height, so anything with
// vertical structure (grout lines, scuffs) stays upright and unstretched.
// Call this *after* the geometry has been moved into its final position.
export function applyWorldUVs(geo, scale = UV_SCALE) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;

  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));

    let u, v;
    if (ny > nx && ny > nz) {          // floor / ceiling: plan-view UVs
      u = pos.getX(i); v = pos.getZ(i);
    } else if (nx > nz) {              // wall facing along X
      u = pos.getZ(i); v = pos.getY(i);
    } else {                           // wall facing along Z
      u = pos.getX(i); v = pos.getY(i);
    }
    uv.setXY(i, u * scale, v * scale);
  }
  uv.needsUpdate = true;
  return geo;
}

// An axis-aligned box spanning [x0,x1] x [y0,y1] x [z0,z1] in world space.
export function boxBetween(x0, y0, z0, x1, y1, z1) {
  const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  geo.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return geo;
}

// A horizontal quad at height y, facing up (or down when `up` is false).
export function slab(x0, z0, x1, z1, y, up = true) {
  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  geo.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
  geo.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return geo;
}

// Size of a batching chunk, in metres.
//
// Merging by material alone would give a handful of draw calls but one giant
// bounding box each, so every bullet raycast would have to test every triangle
// on the floor — a shotgun blast against a fully furnished floor costs nine
// rays through tens of thousands of triangles. Splitting each material into
// spatial chunks keeps the draw calls low while letting three's bounding-box
// test reject almost everything before it looks at a triangle.
const CHUNK = 12;

// Collects geometry per material-and-chunk and merges each group into one mesh.
// Static level geometry never moves, so this is pure win.
export class Batcher {
  constructor() {
    this.groups = new Map();
  }

  // `opts` is taken from the first add() for a given key.
  add(key, material, geometry, opts) {
    geometry.computeBoundingBox();
    const c = geometry.boundingBox.getCenter(_center);
    const chunkKey = `${key}|${Math.floor(c.x / CHUNK)},${Math.floor(c.z / CHUNK)}`;

    let group = this.groups.get(chunkKey);
    if (!group) {
      group = { key, material, geos: [], opts: opts ?? {} };
      this.groups.set(chunkKey, group);
    }
    group.geos.push(geometry);
  }

  // Merges every group into the scene. Returns the created meshes; the caller
  // owns them (and their merged geometries) for disposal.
  build(scene) {
    const meshes = [];

    for (const [key, group] of this.groups) {
      if (!group.geos.length) continue;
      const merged = mergeGeometries(group.geos, false);
      for (const g of group.geos) g.dispose();
      if (!merged) {
        console.warn(`Batcher: failed to merge group "${key}"`);
        continue;
      }

      const mesh = new THREE.Mesh(merged, group.material);
      mesh.name = group.key;
      mesh.castShadow = group.opts.castShadow ?? true;
      mesh.receiveShadow = group.opts.receiveShadow ?? true;
      if (group.opts.renderOrder !== undefined) mesh.renderOrder = group.opts.renderOrder;
      scene.add(mesh);
      meshes.push(mesh);
    }

    this.groups.clear();
    return meshes;
  }
}
