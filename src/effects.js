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
  }

  /** The floor's geometry, so a scorch mark can find the edges of it. */
  setSurfaces(list) {
    this.surfaces = list;
  }

  // A bullet streak from the muzzle to wherever the shot landed.
  tracer(from, to) {
    const t = next(this.tracers);
    const len = from.distanceTo(to);
    if (len < 0.01) return;
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
