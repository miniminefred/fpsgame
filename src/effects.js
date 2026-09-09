import * as THREE from 'three';
import { getFx } from './fx-textures.js';

// Pooled, GC-free bullet visuals: tracers, muzzle flashes, impact flashes and
// scorch marks. Every pool is a fixed-size ring buffer — the oldest entry is
// recycled when the pool wraps, so sustained automatic fire never allocates.
//
// The scorch marks are the one thing here that is not simply "show a quad".
// A bullet hole is flat geometry laid on a surface, and a surface ENDS: hit the
// wall a centimetre from a door frame and half the mark hangs in the doorway,
// hit the corner of a pillar and it sticks out the side like a sticker peeling
// off. So a mark is not a fixed disc. Each of its four edges is pushed out
// independently, as far as the surface actually goes, by probing back at the
// wall from just off it — the mark fills right up to the corner and stops dead
// there. The texture is fitted to whatever rectangle survives, so a clipped mark
// is a cropped splat and never a squashed one.

const TRACER_COUNT = 24;
const TRACER_LIFE = 0.05;   // seconds
const TRACER_WIDTH = 0.012;

const FLASH_COUNT = 24;
const FLASH_LIFE = 0.09;

const MUZZLE_COUNT = 12;
const MUZZLE_LIFE = 0.055;

const DECAL_COUNT = 64;
const DECAL_LIFE = 14;      // seconds before a bullet hole is fully faded
const DECAL_FADE = 3;       // final seconds spent fading out
const DECAL_MIN = 0.052;    // metres, half-width of a mark in open wall
const DECAL_MAX = 0.086;
// How far off the surface the probe starts, and how far past it the mark is
// allowed to sit before it counts as landing on something else entirely.
const PROBE_LIFT = 0.05;
const PROBE_SLOP = 0.012;
// A mark clipped below this on either axis is not drawn at all: at that size it
// is a smudge in a crack, and it would still be paying for four raycasts.
const DECAL_MIN_SPAN = 0.02;

// --- spray paint ------------------------------------------------------------
//
// The one thing in this file that is NOT a short-lived effect: paint stays for
// the rest of the floor, because the player put it there on purpose. That is the
// whole reason it is built differently from everything above.
//
// ONE MESH FOR ALL OF IT, not a pool of meshes. Every other family here has a
// handful of quads alive at once, so a Mesh each costs nothing; paint is what
// somebody DRAWS with, so it is hundreds of quads that never retire, and
// hundreds of meshes is hundreds of draw calls. So there is one geometry with
// PAINT_QUADS quads preallocated in it, a write cursor, and `setDrawRange` to
// show only what has been written -- one draw call for a whole floor of it.
//
// ...which forces the colour into the GEOMETRY. A material carries one colour
// and every splat shares this material, so the can's colour is written as a
// vertex colour per corner and the material merely says `vertexColors`. That is
// also what would make a second colour cost nothing.
//
// It is LIT (MeshLambertMaterial) where a scorch mark is not, and that is a
// decision rather than a copy: an unlit splat is immune to the room, so a bright
// tag in a blacked-out corridor would be the brightest thing in it -- exactly
// the mistake `charOf` in destruction.js documents about leaving a dead control
// panel unlit. Paint on a wall goes dark when the lights go out. That is what
// the normal per vertex is for.
//
// A ring buffer even so, because "for the duration of the level" has to have a
// number in it somewhere: at PAINT_QUADS the oldest splat is overwritten. It is
// set well past what a can holds, so ordinary play never reaches it.
const PAINT_QUADS = 1400;
const PAINT_MIN = 0.055;    // metres, half-width of a splat in open wall
const PAINT_MAX = 0.085;
const PAINT_LIFT = 0.008;   // off the surface, a hair more than a scorch mark

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this._scratch = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._nu = new THREE.Vector3();
    this._nv = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._down = new THREE.Vector3();
    this._corner = new THREE.Vector3();
    this._normal = new THREE.Vector3();

    // What a scorch mark is allowed to lie on. Set per floor by the game, the
    // same list the bullets test against.
    this.surfaces = [];
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = PROBE_LIFT * 2;

    const fx = getFx();
    this.scorches = fx.scorch;
    this.sprays = fx.spray;

    // --- tracers: a thin cylinder whose axis runs along local Z, so it can be
    // aimed with lookAt() and stretched to the shot's length with scale.z.
    const tracerGeo = new THREE.CylinderGeometry(TRACER_WIDTH, TRACER_WIDTH, 1, 6, 1, true);
    tracerGeo.rotateX(Math.PI / 2);
    this.tracers = makePool(scene, TRACER_COUNT, () => new THREE.Mesh(
      tracerGeo,
      new THREE.MeshBasicMaterial({
        color: 0xfff0b0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    ));

    // --- impact flashes: a soft additive ball that swells and fades. A sprite
    // rather than a sphere — it is a puff of light, and light has no far side.
    this.flashes = makePool(scene, FLASH_COUNT, () => new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: fx.glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    ));

    // --- muzzle flashes for everyone who is not the player: the star, spun to a
    // new angle every shot, over a wider ball of glow.
    this.muzzles = makePool(scene, MUZZLE_COUNT, () => {
      const group = new THREE.Group();
      const star = new THREE.Sprite(new THREE.SpriteMaterial({
        map: fx.flash, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: fx.glow, color: 0xffb454, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      group.add(glow, star);
      group.userData.star = star;
      group.userData.glow = glow;
      return group;
    });

    // --- scorch marks: four vertices each, rewritten in world space every time
    // the slot is reused, so a mark can be any rectangle the surface allows.
    this.decals = makePool(scene, DECAL_COUNT, () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(8), 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: this.scorches[0], transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      // The vertices are already in world space; a transform on top would move
      // the mark off the wall it was measured against.
      mesh.matrixAutoUpdate = false;
      return mesh;
    });

    this._buildPaint(scene);
  }

  // The one batched mesh every splat on the floor is drawn as. See the note by
  // PAINT_QUADS for why it is one mesh and why the colour lives in the buffer.
  _buildPaint(scene) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PAINT_QUADS * 12), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(PAINT_QUADS * 12), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(PAINT_QUADS * 8), 2));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(PAINT_QUADS * 12), 3));

    // Every quad's six indices, written once and never touched again -- the
    // cursor moves the DRAW RANGE over them rather than rebuilding the index.
    const index = new Uint32Array(PAINT_QUADS * 6);
    for (let q = 0; q < PAINT_QUADS; q++) {
      const v = q * 4, i = q * 6;
      index[i] = v; index[i + 1] = v + 1; index[i + 2] = v + 2;
      index[i + 3] = v; index[i + 4] = v + 2; index[i + 5] = v + 3;
    }
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);

    this.paintMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      map: this.sprays[0], transparent: true, depthWrite: false, vertexColors: true,
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
    }));
    // World-space vertices, like a scorch mark and for the same reason.
    this.paintMesh.matrixAutoUpdate = false;
    this.paintMesh.frustumCulled = false;
    this.paintMesh.renderOrder = 6;
    scene.add(this.paintMesh);
    this.paintCursor = 0;
    this.paintCount = 0;
  }

  /**
   * A splat of paint on the building, kept for the rest of the floor.
   *
   * Measured and clipped exactly the way a scorch mark is -- `_reach` on all
   * four edges, so paint fills up to a door frame and stops dead there instead
   * of hanging in the opening. That reuse is the reason this lives in effects.js
   * rather than in a module of its own: the hard part of putting a flat mark on
   * a wall is knowing where the wall ENDS, and it is already solved here.
   *
   * The sprite is spun at random per splat, which is what stops a wall somebody
   * has swept the can across reading as a row of identical stamps.
   */
  paint(point, normal, colour, size = 0) {
    frame(normal, this._u, this._v, Math.random() * Math.PI * 2);
    this._nu.copy(this._u).negate();
    this._nv.copy(this._v).negate();

    const want = size || PAINT_MIN + Math.random() * (PAINT_MAX - PAINT_MIN);
    const right = this._reach(point, normal, this._u, want);
    const left = this._reach(point, normal, this._nu, want);
    const up = this._reach(point, normal, this._v, want);
    const down = this._reach(point, normal, this._nv, want);
    if (right + left < DECAL_MIN_SPAN || up + down < DECAL_MIN_SPAN) return;

    const geo = this.paintMesh.geometry;
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const col = geo.getAttribute('color');

    const q = this.paintCursor;
    this.paintCursor = (q + 1) % PAINT_QUADS;
    this.paintCount = Math.min(PAINT_QUADS, this.paintCount + 1);

    this._scratch.copy(point).addScaledVector(normal, PAINT_LIFT);
    const corners = [[-left, -down], [right, -down], [right, up], [-left, up]];
    for (let i = 0; i < 4; i++) {
      const [su, sv] = corners[i];
      const v = q * 4 + i;
      this._corner.copy(this._scratch).addScaledVector(this._u, su).addScaledVector(this._v, sv);
      pos.setXYZ(v, this._corner.x, this._corner.y, this._corner.z);
      nrm.setXYZ(v, normal.x, normal.y, normal.z);
      // The texture keeps its centre on the hit, so a clipped splat is a cropped
      // sprite and never a squeezed one -- the scorch marks' rule.
      uv.setXY(v, 0.5 + su / (want * 2), 0.5 + sv / (want * 2));
      col.setXYZ(v, colour.r, colour.g, colour.b);
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    uv.needsUpdate = true;
    col.needsUpdate = true;
    geo.setDrawRange(0, this.paintCount * 6);
  }

  /** Every splat gone, for a floor that has ended. */
  clearPaint() {
    this.paintCursor = 0;
    this.paintCount = 0;
    this.paintMesh.geometry.setDrawRange(0, 0);
  }

  /** The floor's geometry, so a scorch mark can find the edges of it. */
  setSurfaces(list) {
    this.surfaces = list;
  }

  // The mirror of shooting.removeHittables, and it has to happen at the same
  // moment for the same reason: a broken loose prop's meshes leave the scene
  // graph but keep their last matrix, so decals went on being clipped by a
  // chair that was no longer there. Filtered into a new array rather than
  // spliced, so the level's own mesh list is left alone.
  //
  // Static destructibles need no such call — their spans collapse to degenerate
  // triangles, which no ray can intersect.
  removeSurfaces(meshes) {
    if (!meshes?.length) return;
    const drop = new Set(meshes);
    this.surfaces = this.surfaces.filter((m) => !drop.has(m));
  }

  // A bullet streak from the muzzle to wherever the shot landed.
  tracer(from, to) {
    // Length first: taking a slot and then bailing spends a ring-buffer entry
    // on a streak that was never drawn, and these pools are exact by design.
    const len = from.distanceTo(to);
    if (len < 0.01) return;
    const t = next(this.tracers);
    t.mesh.position.copy(from).lerp(to, 0.5);
    t.mesh.lookAt(to);
    t.mesh.scale.set(1, 1, len);
    t.mesh.visible = true;
    t.life = TRACER_LIFE;
  }

  // Flash at the point of impact. `color` distinguishes flesh from concrete, and
  // `size` a bullet from something with a lot more to say.
  impact(point, normal, color = 0xffe0a0, size = 1) {
    const f = next(this.flashes);
    f.mesh.position.copy(point).addScaledVector(normal, 0.02);
    f.mesh.material.color.setHex(color);
    f.mesh.scale.setScalar(0.12 * size);
    f.mesh.visible = true;
    f.size = size;
    f.life = size > 2 ? FLASH_LIFE * 3 : FLASH_LIFE;
    f.span = f.life;
  }

  /**
   * Somebody else's gun going off, at `point`. The player's own flash lives on
   * the viewmodel (see weapons.js) because it has to stay welded to a barrel
   * that is swinging around in front of the camera.
   */
  muzzle(point, size = 1) {
    const m = next(this.muzzles);
    m.mesh.position.copy(point);
    const star = m.mesh.userData.star;
    const glow = m.mesh.userData.glow;
    star.material.rotation = Math.random() * Math.PI * 2;
    star.scale.setScalar(0.42 * size);
    glow.scale.setScalar(0.85 * size);
    m.mesh.visible = true;
    m.life = MUZZLE_LIFE;
  }

  /**
   * A lasting scorch mark on the surface that was hit, clipped to the extent of
   * that surface so it never overhangs an edge. `hit` is the raycast result the
   * mark came from; its object is skipped while probing, because a wall cannot
   * be used to prove its own width.
   */
  decal(point, normal, size = 0) {
    // Tangent frame, spun at random so the splat never lands the same way twice.
    frame(normal, this._u, this._v, Math.random() * Math.PI * 2);

    this._nu.copy(this._u).negate();
    this._nv.copy(this._v).negate();

    const want = size || DECAL_MIN + Math.random() * (DECAL_MAX - DECAL_MIN);
    const right = this._reach(point, normal, this._u, want);
    const left = this._reach(point, normal, this._nu, want);
    const up = this._reach(point, normal, this._v, want);
    const down = this._reach(point, normal, this._nv, want);

    if (right + left < DECAL_MIN_SPAN || up + down < DECAL_MIN_SPAN) return;

    const d = next(this.decals);
    const pos = d.mesh.geometry.getAttribute('position');
    const uv = d.mesh.geometry.getAttribute('uv');

    // Lifted off the surface by a hair as well as offset in depth — polygon
    // offset alone loses the fight on a wall seen edge-on down a corridor.
    this._scratch.copy(point).addScaledVector(normal, 0.006);

    const corners = [[-left, -down], [right, -down], [right, up], [-left, up]];
    for (let i = 0; i < 4; i++) {
      const [su, sv] = corners[i];
      this._corner.copy(this._scratch).addScaledVector(this._u, su).addScaledVector(this._v, sv);
      pos.setXYZ(i, this._corner.x, this._corner.y, this._corner.z);
      // The texture keeps its own centre on the hole: a clipped edge crops the
      // splat, it does not squeeze it.
      uv.setXY(i, 0.5 + su / (want * 2), 0.5 + sv / (want * 2));
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;

    d.mesh.material.map = this.scorches[(Math.random() * this.scorches.length) | 0];
    d.mesh.material.opacity = 0.9;
    d.mesh.visible = true;
    d.life = DECAL_LIFE;
  }

  /**
   * How far the surface under `point` carries on in direction `dir`, up to
   * `want` metres. Probed by dropping a short ray back onto the surface from
   * just off it: land on the same plane and the surface is there, miss — or land
   * on something at a different depth or angle — and it is not.
   */
  _reach(point, normal, dir, want) {
    if (!this.surfaces.length) return want;
    this._down.copy(normal).negate();

    // Full extent first, because in the middle of a wall that is the answer and
    // it costs one ray. Only an edge pays for the shorter tries.
    for (const k of REACH_STEPS) {
      const d = want * k;
      this._probe.copy(point).addScaledVector(dir, d).addScaledVector(normal, PROBE_LIFT);
      this.raycaster.set(this._probe, this._down);
      const hits = this.raycaster.intersectObjects(this.surfaces, false);
      for (const hit of hits) {
        if (Math.abs(hit.distance - PROBE_LIFT) > PROBE_SLOP) break;
        if (!hit.face) break;
        this._normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        if (this._normal.dot(normal) < 0.9) break;
        return d;
      }
    }
    return 0;
  }

  update(dt) {
    for (const t of this.tracers.items) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) { t.mesh.visible = false; continue; }
      t.mesh.material.opacity = t.life / TRACER_LIFE;
    }

    for (const f of this.flashes.items) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.mesh.visible = false; continue; }
      const k = f.life / (f.span || FLASH_LIFE);
      const size = f.size || 1;
      f.mesh.material.opacity = k;
      f.mesh.scale.setScalar((0.12 + (1 - k) * 0.36) * size);
    }

    for (const m of this.muzzles.items) {
      if (m.life <= 0) continue;
      m.life -= dt;
      if (m.life <= 0) { m.mesh.visible = false; continue; }
      // Squared, so it is at full brightness for barely an instant and then
      // gone — a flash that fades linearly reads as a lamp being switched off.
      const k = (m.life / MUZZLE_LIFE) ** 2;
      m.mesh.userData.star.material.opacity = k;
      m.mesh.userData.glow.material.opacity = k * 0.8;
    }

    for (const d of this.decals.items) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) { d.mesh.visible = false; continue; }
      d.mesh.material.opacity = 0.9 * Math.min(1, d.life / DECAL_FADE);
    }
  }
}

// Where a probe looks for the edge, as fractions of the mark's half-width.
// Three tries: the whole way, most of the way, and a stub.
const REACH_STEPS = [1, 0.55, 0.28];

// An orthonormal pair spanning the plane of `normal`, turned by `spin` about it.
function frame(normal, u, v, spin) {
  // Any axis that is not the normal; the up vector fails only on floors and
  // ceilings, which is exactly when the side vector is safe.
  const ref = Math.abs(normal.y) > 0.9 ? UNIT_X : UNIT_Y;
  u.crossVectors(ref, normal).normalize();
  v.crossVectors(normal, u).normalize();

  const c = Math.cos(spin), s = Math.sin(spin);
  const ux = u.x * c + v.x * s, uy = u.y * c + v.y * s, uz = u.z * c + v.z * s;
  v.set(v.x * c - u.x * s, v.y * c - u.y * s, v.z * c - u.z * s);
  u.set(ux, uy, uz);
}

const UNIT_X = new THREE.Vector3(1, 0, 0);
const UNIT_Y = new THREE.Vector3(0, 1, 0);

// Builds a ring-buffer pool of hidden objects already parented to the scene.
function makePool(scene, count, make) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const mesh = make();
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    scene.add(mesh);
    items.push({ mesh, life: 0 });
  }
  return { items, cursor: 0 };
}

function next(pool) {
  const item = pool.items[pool.cursor];
  pool.cursor = (pool.cursor + 1) % pool.items.length;
  return item;
}
