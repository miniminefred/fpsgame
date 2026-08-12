import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { setupPointerLock } from './input.js';
import { smoothTo } from './util.js';
// The body's own dimensions live in metrics.js, because cameras.js and both
// headless validators need the same numbers and used to keep their own copies.
import { BODY_H, EYE, GRAVITY, JUMP_SPEED, PLAYER_RADIUS as RADIUS, STEP_EPS } from './metrics.js';

// Broadphase cell for the static collision boxes. 2 m is four tiles — big enough
// that a wall lands in few cells, small enough that a query rejects most of a
// floor. See setColliders.
const CELL = 2;
const CELL_BIAS = 4096;    // keeps both axes positive; the slab never gets close
const cellKey = (cx, cz) => (cx + CELL_BIAS) * 8192 + (cz + CELL_BIAS);

const MOVE_SPEED = 5.6;    // units / second — office corridors, not a racetrack
const SPRINT_SPEED = 8.4;
const ACCEL = 14;          // how fast the walk velocity chases the input

const MAX_HEALTH = 100;
const REGEN_DELAY = 6;     // seconds after being hit before healing starts
const REGEN_RATE = 7;      // health / second

// Footsteps are spaced by distance walked, not by a timer, so sprinting speeds
// the cadence up on its own and strafing round a desk doesn't pump out steps
// while you barely move. Slightly shorter under sprint for the faster patter.
const STRIDE = 2.6;
const SPRINT_STRIDE = 2.3;
const AIR_TIME_LANDING = 0.12;   // below this you were never really airborne
const HARD_LANDING = 12;         // downward speed that counts as a full-weight thump

// First-person player: pointer-lock camera + WASD + jump, with AABB collision
// against the level's boxes (walk into them, jump onto desks), plus the health
// the office takes off you.
export class Player {
  constructor(camera, domElement, keys, colliders = []) {
    this.keys = keys;
    this._near = [];          // reused by _candidates; never escapes a frame
    this.setColliders(colliders, []);
    this.velocityY = 0;
    this.canJump = true;

    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.dead = false;
    this.sinceDamage = REGEN_DELAY;
    this.onDeath = null;
    // Fired instead of blocking when the thing in the way is loose furniture:
    // (collider, dirX, dirZ) => void. The game turns it into a physics impulse.
    this.onPush = null;
    // Audio hooks, all wired by the game: (sprinting) => void, (impact 0..1) =>
    // void, (amount) => void.
    this.onStep = null;
    this.onLand = null;
    this.onHurt = null;
    this.onJump = null;
    this.onRegen = null;
    this._regenerating = false;
    this.dt = 0;

    this.airTime = 0;      // seconds since the feet last touched something
    this._strideLeft = STRIDE * 0.5;   // first step lands half a stride in

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

  // Current horizontal speed. The game reads this to know when you are working
  // hard enough to be breathing about it.
  get speed() { return Math.hypot(this._vel.x, this._vel.z); }

  // Yaw in Three.js convention (0 = looking down -Z) — the minimap wants this.
  get yaw() {
    this._euler.setFromQuaternion(this.object.quaternion);
    return this._euler.y;
  }

  /**
   * This floor's collision boxes, split by whether they hold still.
   *
   * `statics` is the building — walls, fitted furniture, door panels — and there
   * are 1000 of them on floor 1 and 2700 by floor 12, growing with every floor
   * in a game that never ends. Every one was tested three times a frame (once
   * per axis, once for the ground), which measured 1.25% of the frame budget at
   * floor 12 and climbing linearly, so they are bucketed by position instead.
   *
   * The bucket stays valid for the whole floor because a static box never MOVES:
   * a destroyed prop and a retracted door panel both retire by setting `top`,
   * which the scans already test and which the index does not care about. That
   * is the only reason indexing them is safe.
   *
   * `movers` is the loose furniture, whose boxes are re-derived from the physics
   * bodies every frame — those genuinely cannot be indexed, and there are only a
   * couple of hundred, so they stay a linear scan.
   */
  setColliders(statics, movers = []) {
    this.statics = statics;
    this.movers = movers;
    this.colliders = statics.length && movers.length ? [...statics, ...movers] : (statics.length ? statics : movers);

    this._grid = new Map();
    for (const b of statics) {
      // Inflated by RADIUS on the way in, because every test below compares
      // against `minX - RADIUS`, so that is the box's real reach.
      const x0 = Math.floor((b.minX - RADIUS) / CELL), x1 = Math.floor((b.maxX + RADIUS) / CELL);
      const z0 = Math.floor((b.minZ - RADIUS) / CELL), z1 = Math.floor((b.maxZ + RADIUS) / CELL);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const key = cellKey(cx, cz);
          const bucket = this._grid.get(key);
          if (bucket) bucket.push(b);
          else this._grid.set(key, [b]);
        }
      }
    }
  }

  /**
   * Boxes that could possibly matter at this point: the 3x3 block of cells
   * around it, plus every mover.
   *
   * Three cells rather than one, and a 2 m cell, because resolving a collision
   * moves the player mid-loop — `pos.x` is written inside the very loop that is
   * still testing against it. One frame of walking is under 0.15 m and a resolve
   * pushes to a box edge, so 2 m of slack on every side is far more than the
   * point can drift while the list is being used.
   *
   * Returns a reused array. Do not hold on to it.
   */
  _candidates(x, z) {
    const out = this._near;
    out.length = 0;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const bucket = this._grid.get(cellKey(gx, gz));
        if (bucket) for (const b of bucket) out.push(b);
      }
    }
    for (const b of this.movers) out.push(b);
    return out;
  }

  // Drops the player onto a new floor, nudging out of anything they'd overlap.
  placeAt(x, z) {
    this.object.position.set(x, EYE, z);
    this.velocityY = 0;
    this._vel.set(0, 0, 0);
    // Arriving on a new floor is not a fall, and must not sound like one.
    this.airTime = 0;
    this._strideLeft = STRIDE * 0.5;

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
    this._regenerating = false;
    this.onHurt?.(amount);
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
    this.dt = dt;

    // `engaged` rather than `isLocked`: if the browser refused mouse capture the
    // game still has to be playable (see setupPointerLock's fallback look).
    if ((this.controls.isLocked || this.controls.engaged) && !this.dead) {
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
      const k = smoothTo(ACCEL, dt);
      this._vel.x += (this._wish.x - this._vel.x) * k;
      this._vel.z += (this._wish.z - this._vel.z) * k;

      if (this.keys.jump && this.canJump) {
        this.velocityY = JUMP_SPEED;
        this.canJump = false;
        this.onJump?.();
      }
    } else {
      this._vel.multiplyScalar(Math.max(0, 1 - dt * 10));
    }

    const fromX = pos.x;
    const fromZ = pos.z;
    this._moveHorizontal(pos, this._vel.x * dt, this._vel.z * dt);

    this.velocityY -= GRAVITY * dt;
    pos.y += this.velocityY * dt;

    // A ceiling stops the rise before gravity gets a chance to: nothing else in
    // this controller collides on the way up, so without this a jump — or just
    // standing on tall furniture — passes straight through a roof rather than
    // bumping it.
    const ceilY = this._headroom(pos, pos.y - EYE);
    if (pos.y - EYE + BODY_H > ceilY) {
      pos.y = ceilY - BODY_H + EYE;
      if (this.velocityY > 0) this.velocityY = 0;
    }

    const groundY = this._supportHeight(pos);
    if (pos.y - EYE <= groundY && this.velocityY <= 0) {
      // Standing still still resolves here every frame, one frame of gravity at
      // a time, so a landing is only a landing if you were up there a while.
      if (this.airTime > AIR_TIME_LANDING) {
        this.onLand?.(Math.min(1, -this.velocityY / HARD_LANDING));
        this._strideLeft = STRIDE;   // no footstep on top of the thump
      }
      pos.y = groundY + EYE;
      this.velocityY = 0;
      this.canJump = true;
      this.airTime = 0;
      this._trackStride(pos.x - fromX, pos.z - fromZ);
    } else {
      this.airTime += dt;
    }

    if (!this.dead) {
      this.sinceDamage += dt;
      if (this.sinceDamage > REGEN_DELAY && this.health < this.maxHealth) {
        // Announced once, on the frame it starts — not every frame it runs.
        if (!this._regenerating) { this._regenerating = true; this.onRegen?.(); }
        this.heal(REGEN_RATE * dt);
      }
    }
  }

  // Counts down the distance to the next footfall. Fed the distance actually
  // covered after collision, so grinding against a wall is silent.
  _trackStride(dx, dz) {
    const moved = Math.hypot(dx, dz);
    if (moved < 1e-4) return;

    const sprinting = this.keys.sprint && this._vel.lengthSq() > 16;
    this._strideLeft -= moved;
    if (this._strideLeft > 0) return;

    this._strideLeft += sprinting ? SPRINT_STRIDE : STRIDE;
    this.onStep?.(sprinting);
  }

  /**
   * Move one axis at a time and push back out of any box that stands in the way,
   * resolving opposite to the direction of travel.
   *
   * A box is only in the way if it overlaps the body VERTICALLY as well: low
   * enough to be stepped onto is `top <= feet + STEP_EPS`, and high enough to walk
   * under is `base >= feet + BODY_H`. That second test is what a second storey
   * needs — its floor slab has to stop whoever is standing on it and nobody at
   * all downstairs — and it is written `b.base ?? 0` because almost nothing has an
   * underside: a wall, a desk and a door panel all start at the floor. With `base`
   * absent the test reads `0 >= feet + 1.82`, which is false for any body above
   * ground, so every collider the game had before this behaves exactly as it did.
   *
   * `b.ceiling` gets a different resolution, not just a different test: snapping
   * to the box's OWN far face is right for a wall, which you approach from outside
   * it and only ever touch near that face. A roof or a storey's deck is a slab you
   * are already standing well inside the footprint of the moment your climbing (or
   * a jump) lifts your head into it — "push to the far face" is a same-frame
   * teleport to the edge of the room, or the floor, whatever the slab spans.
   * Cancelling the frame's own (small) delta instead just stops you, which is what
   * bumping your head on a ceiling should feel like.
   */
  _moveHorizontal(pos, dx, dz) {
    const feetY = pos.y - EYE;
    const overhead = (b) => (b.base ?? 0) >= feetY + BODY_H;

    pos.x += dx;
    if (dx !== 0) {
      for (const b of this._candidates(pos.x, pos.z)) {
        if (b.top <= feetY + STEP_EPS || overhead(b)) continue;
        if (!this._overlapsXZ(pos, b)) continue;
        // Loose furniture gets shoved aside rather than stopping you dead —
        // a chair blocking a corridor you can't move would be miserable.
        if (b.push) { this.onPush?.(b, Math.sign(dx), 0); continue; }
        if (b.ceiling) { pos.x -= dx; this._vel.x = 0; continue; }
        pos.x = dx > 0 ? b.minX - RADIUS : b.maxX + RADIUS;
        this._vel.x = 0;
      }
    }

    pos.z += dz;
    if (dz !== 0) {
      for (const b of this._candidates(pos.x, pos.z)) {
        if (b.top <= feetY + STEP_EPS || overhead(b)) continue;
        if (!this._overlapsXZ(pos, b)) continue;
        if (b.push) { this.onPush?.(b, 0, Math.sign(dz)); continue; }
        if (b.ceiling) { pos.z -= dz; this._vel.z = 0; continue; }
        pos.z = dz > 0 ? b.minZ - RADIUS : b.maxZ + RADIUS;
        this._vel.z = 0;
      }
    }
  }

  /**
   * The lowest ceiling directly overhead — the mirror of `_supportHeight`, and
   * only ever asked about `b.ceiling` boxes. A wall has an underside too once a
   * storey stands on it (`base`), but a wall is meant to push you back side-on,
   * not cap how high you can raise your feet a room away from it; `ceiling` is
   * what tells the two apart. Infinity means nothing is overhead at all.
   */
  _headroom(pos, feetY) {
    let ceilY = Infinity;
    for (const b of this._candidates(pos.x, pos.z)) {
      if (!b.ceiling || b.base <= feetY) continue;
      if (!this._overlapsXZ(pos, b)) continue;
      if (b.base < ceilY) ceilY = b.base;
    }
    return ceilY;
  }

  _overlapsXZ(pos, b) {
    return pos.x > b.minX - RADIUS && pos.x < b.maxX + RADIUS &&
           pos.z > b.minZ - RADIUS && pos.z < b.maxZ + RADIUS;
  }

  _blocked(x, z, feetY) {
    for (const b of this._candidates(x, z)) {
      // Same two tests as _moveHorizontal: too low to stop you, or overhead.
      if (b.top <= feetY + STEP_EPS || (b.base ?? 0) >= feetY + BODY_H) continue;
      if (x > b.minX - RADIUS && x < b.maxX + RADIUS &&
          z > b.minZ - RADIUS && z < b.maxZ + RADIUS) return true;
    }
    return false;
  }

  /**
   * Highest surface directly beneath the player.
   *
   * This used to start at 0, because the floor was an assumption rather than a
   * thing: y = 0 was where the building was and there was nothing underneath it.
   * A basement needs the opposite — the floor is now GEOMETRY (`buildShell` emits a
   * plate collider for the slab, with a hole where a staircase goes down), so the
   * ground is simply the highest top under you and the plate is usually it.
   *
   * The fallback when nothing at all is underfoot is still 0, and that is what
   * makes the change exactly equivalent everywhere else: on a floor with no room
   * below it, the highest top under the player is either the plate at 0 or a prop
   * above it, and the only positions the fallback can be reached from are ones the
   * old code would also have answered 0 for. Falling out of the world is worse than
   * being stood on the floor you should have been on.
   */
  _supportHeight(pos) {
    const feetY = pos.y - EYE;
    let groundY = -Infinity;
    for (const b of this._candidates(pos.x, pos.z)) {
      if (b.top > feetY + STEP_EPS) continue;
      if (pos.x > b.minX - RADIUS && pos.x < b.maxX + RADIUS &&
          pos.z > b.minZ - RADIUS && pos.z < b.maxZ + RADIUS) {
        if (b.top > groundY) groundY = b.top;
      }
    }
    return Number.isFinite(groundY) ? groundY : 0;
  }
}
