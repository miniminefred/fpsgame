import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry helpers shared by the level builder: world-space UVs and a batcher
// that merges everything sharing a material into a single mesh.

// One texture repeat covers this many world units. Floors, walls and ceilings
// all use it, so a texture never stretches differently on a long wall than on a
// short one.
const UV_SCALE = 1 / 2;

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
//
// Batching and destruction pull in opposite directions: once a desk's triangles
// are merged into a chunk they have no identity left to remove. Spans are the
// bridge. Anything added between beginSpans() and endSpans() remembers WHERE it
// landed in the merge — which mesh, and which run of vertices — so a single prop
// can later be erased from a shared buffer without unpicking the batch. The
// offsets can only be read while the source geometries are still alive, which is
// why build() records them before merging rather than after.
export class Batcher {
  constructor() {
    this.groups = new Map();
    this._spans = [];        // every span recorded so far, patched up by build()
    this._recording = null;  // the span list currently being collected, if any
  }

  // Start attributing everything added from here on to one destructible unit.
  // Returns the array build() will fill in with { mesh, start, count }.
  beginSpans() {
    this._recording = [];
    return this._recording;
  }

  endSpans() {
    const spans = this._recording;
    this._recording = null;
    return spans ?? [];
  }

  // `opts` is taken from the first add() for a given key.
  add(key, material, geometry, opts) {
    geometry.computeBoundingBox();
    const c = geometry.boundingBox.getCenter(_center);
    const chunkKey = `${key}|${Math.floor(c.x / CHUNK)},${Math.floor(c.z / CHUNK)}`;

    let group = this.groups.get(chunkKey);
    if (!group) {
      group = { key, material, geos: [], opts: opts ?? {}, mesh: null, offsets: null };
      this.groups.set(chunkKey, group);
    }
    group.geos.push(geometry);

    if (this._recording) {
      const span = {
        mesh: null,
        start: 0,
        count: geometry.attributes.position.count,
        _group: group,
        _index: group.geos.length - 1,
      };
      this._recording.push(span);
      this._spans.push(span);
    }
  }

  // Merges every group into the scene. Returns the created meshes; the caller
  // owns them (and their merged geometries) for disposal.
  build(scene) {
    const meshes = [];

    for (const [key, group] of this.groups) {
      if (!group.geos.length) continue;

      // mergeGeometries concatenates vertices in order, so each source
      // geometry's run starts at the total count of everything before it. This
      // has to be tallied now: the sources are disposed a line later.
      let n = 0;
      group.offsets = group.geos.map((g) => {
        const at = n;
        n += g.attributes.position.count;
        return at;
      });

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
      scene.add(mesh);
      meshes.push(mesh);
      group.mesh = mesh;
    }

    // A group whose merge failed leaves its spans pointing at no mesh, which
    // callers must treat as "already gone" rather than as an error.
    for (const span of this._spans) {
      span.mesh = span._group.mesh;
      span.start = span._group.offsets?.[span._index] ?? 0;
      span._group = null;
    }

    this._spans.length = 0;
    this._recording = null;
    this.groups.clear();
    return meshes;
  }
}

// Collapses a span's vertices onto its first one, which leaves every triangle in
// it degenerate: nothing is rasterized, nothing casts a shadow, and a ray can no
// longer intersect it (a zero-area triangle fails the barycentric test). Cheaper
// and far simpler than rebuilding the merged buffer, and the vertex count never
// changes so no other span's offsets move.
export function eraseSpan(span) {
  if (!span?.mesh || span.count <= 1) return;
  const pos = span.mesh.geometry.attributes.position;
  const x = pos.getX(span.start);
  const y = pos.getY(span.start);
  const z = pos.getZ(span.start);
  for (let i = span.start + 1; i < span.start + span.count; i++) pos.setXYZ(i, x, y, z);
  pos.needsUpdate = true;
}
