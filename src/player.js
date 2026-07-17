import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { setupPointerLock } from './input.js';

const EYE = 1.7;          // eye height (units)
const MOVE_SPEED = 8;     // units / second
const GRAVITY = 26;       // units / second^2
const JUMP_SPEED = 9;     // initial upward velocity

// First-person player: pointer-lock camera controls + WASD movement + jump.
export class Player {
  constructor(camera, domElement, scene, keys) {
    this.keys = keys;
    this.velocityY = 0;
    this.canJump = true;

    this.controls = new PointerLockControls(camera, domElement);
    this.object = this.controls.getObject();
    this.object.position.set(0, EYE, 8);
    scene.add(this.object);

    setupPointerLock(this.controls, domElement);

    // scratch vectors reused each frame
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
  }

  update(dt, camera) {
    const obj = this.object;

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
      obj.position.x += this._move.x;
      obj.position.z += this._move.z;

      if (this.keys.jump && this.canJump) {
        this.velocityY = JUMP_SPEED;
        this.canJump = false;
      }
    }

    // Gravity / landing (runs always so you settle even after releasing the mouse).
    this.velocityY -= GRAVITY * dt;
    obj.position.y += this.velocityY * dt;
    if (obj.position.y <= EYE) {
      obj.position.y = EYE;
      this.velocityY = 0;
      this.canJump = true;
    }
  }
}
