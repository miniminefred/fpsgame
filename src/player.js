import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { setupPointerLock } from './input.js';

const EYE = 1.7;           // eye height above the player's feet (units)
const MOVE_SPEED = 8;      // units / second
const GRAVITY = 26;        // units / second^2
const JUMP_SPEED = 9;      // initial upward velocity (~1.55 units of jump height)
const RADIUS = 0.4;        // player horizontal collision radius
const STEP_EPS = 0.25;     // box tops within this of the feet count as "stood on", not a wall

// First-person player: pointer-lock camera controls + WASD movement + jump,
// with AABB collision against the world's boxes (walk into them, jump on top).
export class Player {
  constructor(camera, domElement, keys, colliders = []) {
    this.keys = keys;
    this.colliders = colliders;
    this.velocityY = 0;
    this.canJump = true;

    // Newer three (>=~0.156) PointerLockControls moves the camera directly;
    // controls.object === camera. There's no getObject() wrapper anymore.
    this.controls = new PointerLockControls(camera, domElement);
    this.object = this.controls.object;
    this.object.position.set(0, EYE, 8);

    setupPointerLock(this.controls, domElement);

    // scratch vectors reused each frame
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
  }

  update(dt, camera) {
    const pos = this.object.position;

    if (this.controls.isLocked) {
      // Horizontal movement in camera-facing space (pitch ignored so
      // looking up/down doesn't change walk speed).
      camera.getWorldDirection(this._forward);
      this._forward.y = 0;
      this._forward.normalize();
      this._right.crossVectors(this._forward, camera.up).normalize();

      this._move.set(0, 0, 0);
      if (this.keys.forward) this._move.add(this._forward);
      if (this.keys.back)    this._move.sub(this._forward);
      if (this.keys.right)   this._move.add(this._right);
      if (this.keys.left)    this._move.sub(this._right);
      if (this._move.lengthSq() > 0) this._move.normalize().multiplyScalar(MOVE_SPEED * dt);

      this._moveHorizontal(pos, this._move.x, this._move.z);

      if (this.keys.jump && this.canJump) {
        this.velocityY = JUMP_SPEED;
        this.canJump = false;
      }
    }

    // Gravity + landing on whatever surface is under the feet (ground or box top).
    this.velocityY -= GRAVITY * dt;
    pos.y += this.velocityY * dt;

    const groundY = this._supportHeight(pos);
    if (pos.y - EYE <= groundY && this.velocityY <= 0) {
      pos.y = groundY + EYE;
      this.velocityY = 0;
      this.canJump = true;
    }
  }

  // Move one axis at a time and push back out of any box that rises above the
  // feet, resolving in the direction opposite to travel.
  _moveHorizontal(pos, dx, dz) {
    const feetY = pos.y - EYE;

    pos.x += dx;
    if (dx !== 0) {
      for (const b of this.colliders) {
        if (b.top <= feetY + STEP_EPS) continue; // standing on/above it — not a wall
        if (this._overlapsXZ(pos, b)) pos.x = dx > 0 ? b.minX - RADIUS : b.maxX + RADIUS;
      }
    }

    pos.z += dz;
    if (dz !== 0) {
      for (const b of this.colliders) {
        if (b.top <= feetY + STEP_EPS) continue;
        if (this._overlapsXZ(pos, b)) pos.z = dz > 0 ? b.minZ - RADIUS : b.maxZ + RADIUS;
      }
    }
  }

  _overlapsXZ(pos, b) {
    return pos.x > b.minX - RADIUS && pos.x < b.maxX + RADIUS &&
           pos.z > b.minZ - RADIUS && pos.z < b.maxZ + RADIUS;
  }

  // Highest surface directly beneath the player (0 = ground). Only boxes at or
  // below the feet (plus a small tolerance) can support you.
  _supportHeight(pos) {
    const feetY = pos.y - EYE;
    let groundY = 0;
    for (const b of this.colliders) {
      if (b.top > feetY + STEP_EPS) continue; // its top is above the feet — can't stand on it yet
      if (pos.x > b.minX - RADIUS && pos.x < b.maxX + RADIUS &&
          pos.z > b.minZ - RADIUS && pos.z < b.maxZ + RADIUS) {
        if (b.top > groundY) groundY = b.top;
      }
    }
    return groundY;
  }
}
