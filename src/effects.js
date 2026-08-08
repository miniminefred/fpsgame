import * as THREE from 'three';

// Pooled, GC-free bullet visuals: tracers, impact flashes and scorch decals.
// Every pool is a fixed-size ring buffer — the oldest entry is recycled when
// the pool wraps, so sustained automatic fire never allocates.

const TRACER_COUNT = 24;
const TRACER_LIFE = 0.05;   // seconds
const TRACER_WIDTH = 0.012;

const FLASH_COUNT = 24;
const FLASH_LIFE = 0.09;

const DECAL_COUNT = 48;
const DECAL_LIFE = 8;       // seconds before a bullet hole is fully faded
const DECAL_FADE = 2;       // final seconds spent fading out

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this._scratch = new THREE.Vector3();

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

    // --- impact flashes: a small additive sphere that expands and fades.
    const flashGeo = new THREE.SphereGeometry(0.05, 8, 6);
    this.flashes = makePool(scene, FLASH_COUNT, () => new THREE.Mesh(
      flashGeo,
      new THREE.MeshBasicMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    ));

    // --- decals: a dark disc laid flat on the surface that was hit.
    const decalGeo = new THREE.CircleGeometry(0.07, 12);
    this.decals = makePool(scene, DECAL_COUNT, () => new THREE.Mesh(
      decalGeo,
      new THREE.MeshBasicMaterial({
        color: 0x14100e, transparent: true, depthWrite: false, polygonOffset: true,
        polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      })
    ));
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

  // Flash at the point of impact. `color` distinguishes flesh from concrete.
  impact(point, normal, color = 0xffe0a0) {
    const f = next(this.flashes);
    f.mesh.position.copy(point).addScaledVector(normal, 0.02);
    f.mesh.material.color.setHex(color);
    f.mesh.scale.setScalar(0.6);
    f.mesh.visible = true;
    f.life = FLASH_LIFE;
  }

  // A lasting bullet hole, oriented to the surface normal.
  decal(point, normal) {
    const d = next(this.decals);
    d.mesh.position.copy(point).addScaledVector(normal, 0.012);
    // A circle faces +Z; look back along the normal to lie flat on the surface.
    d.mesh.lookAt(this._scratch.copy(point).add(normal));
    d.mesh.material.opacity = 0.85;
    d.mesh.visible = true;
    d.life = DECAL_LIFE;
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
      const k = f.life / FLASH_LIFE;
      f.mesh.material.opacity = k;
      f.mesh.scale.setScalar(0.6 + (1 - k) * 1.8);
    }

    for (const d of this.decals.items) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) { d.mesh.visible = false; continue; }
      d.mesh.material.opacity = 0.85 * Math.min(1, d.life / DECAL_FADE);
    }
  }
}

// Builds a ring-buffer pool of hidden meshes already parented to the scene.
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
