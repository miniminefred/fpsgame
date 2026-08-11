import * as THREE from 'three';
import { BodyPool } from './body-pool.js';

// Spent brass.
//
// Purely cosmetic, and the cheapest possible version of itself: one shared
// geometry and one shared material, a rigid body per casing, and a hard cap with
// the oldest recycled first. A casing is a few grams of metal that lands, rings
// once and is never looked at again — it does not deserve a pool of meshes with
// custom shading, and it must never be the reason a firefight drops frames.
//
// They eject from the gun rather than from the camera. The player's viewmodel
// sits below and right of centre, so brass thrown from the camera origin appears
// to come out of the player's forehead; thrown from the muzzle with a rightward
// impulse it arcs out past your shoulder, which is the whole effect.

const LIFETIME = 10;      // seconds before it is taken away
const MAX_LIVE = 90;      // hard cap, oldest recycled first

// The visible shell. Small enough to read as brass, not so small it disappears.
const SHELL = { w: 0.012, h: 0.012, l: 0.038 };
// Cannon tunnels and jitters on bodies this thin, so the body it simulates is a
// fatter cube than the mesh it carries. Nobody can tell at this size.
const BODY = 0.03;
const MASS = 0.02;

// Ejection. Mostly right and up, with enough spread that no two shots throw the
// same arc, and a backward component so it clears the gun.
const EJECT_RIGHT = 1.9;
const EJECT_UP = 1.5;
const EJECT_BACK = 0.5;
const EJECT_JITTER = 0.5;
const SPIN = 5;

export class Casings {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    // Geometry and material are shared across every casing, so the pool must not
    // dispose them with the mesh.
    this.pool = new BodyPool({ scene, physics, max: MAX_LIVE, life: LIFETIME });

    this.geometry = new THREE.BoxGeometry(SHELL.w, SHELL.h, SHELL.l);
    this.material = new THREE.MeshStandardMaterial({
      color: 0xc9a227, metalness: 0.9, roughness: 0.35,
    });

    this._v = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  /**
   * Throws one casing out of the gun. `camera` supplies the ejection frame and
   * `from` the muzzle position — see the note above about why it is not the
   * camera position.
   */
  eject(camera, from) {
    if (!this.physics) return;

    // The gun's right and up in world space, so the arc follows where you aim.
    this._right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this._up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    camera.getWorldDirection(this._v);

    // Start it beside the muzzle rather than inside the barrel.
    const x = from.x + this._right.x * 0.06 - this._v.x * 0.1;
    const y = from.y + this._right.y * 0.06 - this._v.y * 0.1;
    const z = from.z + this._right.z * 0.06 - this._v.z * 0.1;

    const handle = this.physics.addBox({
      size: { x: BODY, y: BODY, z: BODY },
      position: { x, y, z },
      yaw: Math.random() * Math.PI * 2,
      mass: MASS,
    });
    if (!handle) return;

    const jitter = () => (Math.random() * 2 - 1) * EJECT_JITTER;
    const dir = {
      x: this._right.x * (EJECT_RIGHT + jitter()) + this._up.x * (EJECT_UP + jitter()) - this._v.x * EJECT_BACK,
      y: this._right.y * (EJECT_RIGHT + jitter()) + this._up.y * (EJECT_UP + jitter()) - this._v.y * EJECT_BACK + 0.4,
      z: this._right.z * (EJECT_RIGHT + jitter()) + this._up.z * (EJECT_UP + jitter()) - this._v.z * EJECT_BACK,
    };
    // Applied off-centre so it tumbles instead of sailing out flat.
    this.physics.impulse(handle, dir, MASS * SPIN, {
      x: x + 0.01, y: y + 0.01, z: z + 0.01,
    });

    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.castShadow = false;      // far too small to read as a shadow
    mesh.position.set(x, y, z);
    this.scene.add(mesh);

    this.pool.add(mesh, handle);
  }

  update(dt) {
    this.pool.update(dt);
  }

  // Must run while the physics world the handles belong to is still alive.
  clear() {
    this.pool.clear();
  }

  dispose() {
    this.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
