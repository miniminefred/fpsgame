import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { setupPointerLock } from './input.js';

const EYE = 1.7;           // eye height above the player's feet (units)
const MOVE_SPEED = 5.6;    // units / second — office corridors, not a racetrack
const SPRINT_SPEED = 8.4;
const ACCEL = 14;          // how fast the walk velocity chases the input
const GRAVITY = 26;
const JUMP_SPEED = 8.4;
const RADIUS = 0.4;        // player horizontal collision radius
const STEP_EPS = 0.25;     // surfaces within this of the feet are stood on, not walls

const MAX_HEALTH = 100;
const REGEN_DELAY = 6;     // seconds after being hit before healing starts
const REGEN_RATE = 7;      // health / second

// First-person player: pointer-lock camera + WASD + jump, with AABB collision
// against the level's boxes (walk into them, jump onto desks), plus the health
// the office takes off you.
export class Player {
  constructor(camera, domElement, keys, colliders = []) {
    this.keys = keys;
    this.colliders = colliders;
    this.velocityY = 0;
    this.canJump = true;

    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.dead = false;
    this.sinceDamage = REGEN_DELAY;
    this.onDeath = null;

    this.controls = new PointerLockControls(camera, domElement);
    this.object = this.controls.object;
    this.object.position.set(0, EYE, 0);

    setupPointerLock(this.controls, domElement);

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._vel = new THREE.Vector3();   // horizontal velocity, smoothed
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  // Yaw in Three.js convention (0 = looking down -Z) — the minimap wants this.
  get yaw() {
    this._euler.setFromQuaternion(this.object.quaternion);
    return this._euler.y;
  }

  setColliders(colliders) {
    this.colliders = colliders;
  }

  // Drops the player onto a new floor, nudging out of anything they'd overlap.
  placeAt(x, z) {
    this.object.position.set(x, EYE, z);
    this.velocityY = 0;
    this._vel.set(0, 0, 0);

    if (!this._blocked(x, z, 0)) return;
    for (let r = 0.5; r <= 6; r += 0.5) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const nx = x + Math.cos(a) * r;
        const nz = z + Math.sin(a) * r;
        if (!this._blocked(nx, nz, 0)) {
          this.object.position.set(nx, EYE, nz);
          return;
        }
      }
    }
  }

  reset() {
    this.health = this.maxHealth;
    this.dead = false;
    this.sinceDamage = REGEN_DELAY;
    this.velocityY = 0;
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.health -= amount;
    this.sinceDamage = 0;
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.onDeath?.();
    }
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  update(dt, camera) {
    const pos = this.object.position;

    if (this.controls.isLocked && !this.dead) {
      camera.getWorldDirection(this._forward);
      this._forward.y = 0;
      this._forward.normalize();
      this._right.crossVectors(this._forward, camera.up).normalize();

      this._wish.set(0, 0, 0);
      if (this.keys.forward) this._wish.add(this._forward);
      if (this.keys.back) this._wish.sub(this._forward);
      if (this.keys.right) this._wish.add(this._right);
      if (this.keys.left) this._wish.sub(this._right);

      const speed = this.keys.sprint ? SPRINT_SPEED : MOVE_SPEED;
      if (this._wish.lengthSq() > 0) this._wish.normalize().multiplyScalar(speed);

      // Ease into the target velocity so starting and stopping has some weight.
      const k = 1 - Math.exp(-ACCEL * dt);
      this._vel.x += (this._wish.x - this._vel.x) * k;
      this._vel.z += (this._wish.z - this._vel.z) * k;

      if (this.keys.jump && this.canJump) {
        this.velocityY = JUMP_SPEED;
        this.canJump = false;
      }
    } else {
      this._vel.multiplyScalar(Math.max(0, 1 - dt * 10));
    }

    this._moveHorizontal(pos, this._vel.x * dt, this._vel.z * dt);

    this.velocityY -= GRAVITY * dt;
    pos.y += this.velocityY * dt;

    const groundY = this._supportHeight(pos);
    if (pos.y - EYE <= groundY && this.velocityY <= 0) {
      pos.y = groundY + EYE;
      this.velocityY = 0;
      this.canJump = true;
    }

    if (!this.dead) {
      this.sinceDamage += dt;
      if (this.sinceDamage > REGEN_DELAY && this.health < this.maxHealth) {
        this.heal(REGEN_RATE * dt);
      }
    }
  }

  // Move one axis at a time and push back out of any box that rises above the
  // feet, resolving opposite to the direction of travel.
  _moveHorizontal(pos, dx, dz) {
    const feetY = pos.y - EYE;

    pos.x += dx;
    if (dx !== 0) {
      for (const b of this.colliders) {
        if (b.top <= feetY + STEP_EPS) continue;
        if (this._overlapsXZ(pos, b)) {
          pos.x = dx > 0 ? b.minX - RADIUS : b.maxX + RADIUS;
          this._vel.x = 0;
        }
      }
    }

    pos.z += dz;
    if (dz !== 0) {
      for (const b of this.colliders) {
        if (b.top <= feetY + STEP_EPS) continue;
        if (this._overlapsXZ(pos, b)) {
          pos.z = dz > 0 ? b.minZ - RADIUS : b.maxZ + RADIUS;
          this._vel.z = 0;
        }
      }
    }
  }

  _overlapsXZ(pos, b) {
    return pos.x > b.minX - RADIUS && pos.x < b.maxX + RADIUS &&
           pos.z > b.minZ - RADIUS && pos.z < b.maxZ + RADIUS;
  }

  _blocked(x, z, feetY) {
    for (const b of this.colliders) {
      if (b.top <= feetY + STEP_EPS) continue;
      if (x > b.minX - RADIUS && x < b.maxX + RADIUS &&
          z > b.minZ - RADIUS && z < b.maxZ + RADIUS) return true;
    }
    return false;
  }

  // Highest surface directly beneath the player (0 = floor).
  _supportHeight(pos) {
    const feetY = pos.y - EYE;
    let groundY = 0;
    for (const b of this.colliders) {
      if (b.top > feetY + STEP_EPS) continue;
      if (pos.x > b.minX - RADIUS && pos.x < b.maxX + RADIUS &&
          pos.z > b.minZ - RADIUS && pos.z < b.maxZ + RADIUS) {
        if (b.top > groundY) groundY = b.top;
      }
    }
    return groundY;
  }
}
