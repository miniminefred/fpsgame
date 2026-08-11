import * as THREE from 'three';
import { clamp } from './util.js';

// What happens to a body after it stops being a person.
//
// Everything that dies on a floor falls over properly: the staff, the
// Reanimated, the machines, the rats and the floor cleaner. The skeleton — how
// many bones, where the joints are, what a limb weighs — is declared in rigs.js
// next to the geometry it describes; this file only knows how to hand that to
// the solver and hand it back.
//
// The shape of the thing is a straight copy of destruction.js, because it is the
// same problem: something that was cheap and animated becomes expensive and
// simulated, and the whole game depends on that being bounded. So a ragdoll has
// three lives and leaves each one on a timer.
//
//   ACTIVE    jointed rigid bodies, solver-driven. Expensive, and capped.
//   SETTLED   the bodies are gone and the meshes are frozen exactly where they
//             came to rest. Free, and what you are looking at most of the time.
//   SINKING   through the floor and out of the scene, because a floor holds two
//             hundred people and a building full of corpses is a building full
//             of draw calls.
//
// The cap is on ACTIVE only, and going over it does not refuse the new ragdoll —
// it settles the OLDEST one early. Whatever you just shot is the thing you are
// looking at, and it is the one that has to fall properly; the body four rooms
// back that you have already walked past can quietly stop simulating.

// Simultaneously simulated ragdolls. Six bodies and five constraints each, so
// this is the number that actually decides what a firefight costs.
const MAX_ACTIVE = 10;
// Corpses on the floor in any state. Past this the oldest starts sinking.
const MAX_CORPSES = 26;

const SETTLE_MAX = 5;          // seconds of simulation before it is frozen anyway
const SETTLE_QUIET = 0.35;     // ...or this long with every bone asleep
const LINGER = 7;              // seconds lying there once settled
const SINK_TIME = 1.1;         // and how long going through the floor takes
const SINK_DEPTH = 1.4;

// How hard the killing shot throws the bone it landed on. A body that folds
// straight down reads as fainting; the shot has to be visible in the fall, and
// it is the only part of this the player can actually attribute to their own
// aim.
//
// Both numbers are multiplied by the bone's mass before they reach the solver,
// which makes them a CHANGE IN SPEED in m/s rather than an impulse — the same
// shot moves a rat and a manager by the same amount. That is not physics and it
// is deliberate: a real bullet carries a few newton-seconds and would not visibly
// move either of them, and every game that has ever looked good has lied about
// this. What the mass scaling buys is that one number tunes the whole roster.
//
// 4 m/s is roughly the fastest a hit bone can be thrown before the body stops
// falling and starts being launched. The rest of the skeleton is dragged along by
// the joints, so a torso hit moves the WHOLE person at closer to 2 m/s.
const HIT_IMPULSE = 4;

// ...and past that is the whole point of the heavy guns. `hit.punch` is the
// shot's own weight, which is the weapon's `punch` scaled up over the weapon's
// own range as it closes (see throwPunch in shooting.js) — so a shotgun in
// somebody's chest is 2.8, a sniper round at twenty metres is 2, and a pistol is
// 0.8 wherever it was fired from. The floor matters as much as the ceiling:
// every death still has to look like being shot rather than switched off.
const THROW_MIN = 0.8;
const THROW_MAX = 2.9;

// Three things change together as a shot gets heavier, and it is all three
// together that turn a fall into a launch:
//
//  - LIFT, how much of the shove is redirected upward. A light hit spins
//    somebody where they stand; a heavy one takes them off their feet, and a
//    body that never leaves the floor cannot look thrown no matter how fast it
//    slides.
//  - SHARE, how much of it goes into the WHOLE skeleton rather than into the one
//    bone the bullet hit. This is the difference between a person being thrown
//    and an arm being yanked while the body stays put: at the light end almost
//    all of it lands on the bone that stopped the round, which whips the limb and
//    leaves the fall to gravity; at the heavy end half of it is dealt to every
//    bone at once, so the body leaves as one thing and comes apart in the air.
//
// The remainder always goes into the hit bone at the contact POINT, which is
// what puts the spin on — physics.js clamps the lever arm to the bone's own
// radius, so a heavy hit tumbles hard without the torque going to infinity.
const HIT_LIFT = 0.35;
const HIT_LIFT_HARD = 0.8;
const BODY_SHARE = 0.15;
const BODY_SHARE_HARD = 0.5;

export class Ragdolls {
  constructor({ scene, physics }) {
    this.scene = scene;
    this.physics = physics;
    this.items = [];

    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  get activeCount() {
    let n = 0;
    for (const item of this.items) if (item.state === 'active') n++;
    return n;
  }

  /**
   * Turn a dead enemy into a falling body. `hit` is how they died — a direction,
   * a world point and optionally which mesh took it — and may be null, which is
   * what an enemy who ran out of health quietly does.
   *
   * Returns false if it could not be done, which is the caller's cue to keep the
   * old toppling animation. Nothing here is allowed to be load-bearing: a
   * ragdoll is the best case, not the only one.
   */
  spawn(enemy, hit = null) {
    const bones = enemy?.bones;
    if (!bones?.length || !this.physics || !this.scene) return false;

    // Make room before building anything, so the new body is inside the cap
    // rather than one over it.
    while (this.activeCount >= MAX_ACTIVE) {
      // The oldest one that has already stopped moving, and only failing that
      // the oldest outright. Settling freezes a body exactly where it is, and
      // now that a heavy shot genuinely throws people across a room, "where it
      // is" is regularly two metres off the floor — a corpse hanging in mid-air
      // is a far worse thing to look at than one extra body simulating for
      // another second.
      const active = this.items.filter((i) => i.state === 'active');
      const oldest = active.find((i) => i.quiet > 0) ?? active[0];
      if (!oldest) break;
      this._settle(oldest);
    }
    // And the oldest corpse outright, so a long fight in one room cannot carpet
    // it. `items` is in death order, so items[0] is always the one nobody has
    // looked at for longest.
    while (this.items.length >= MAX_CORPSES) this._remove(this.items[0]);

    const group = enemy.group;
    const scale = group.scale.x || 1;
    const yaw = group.rotation.y;

    // The rig may be mid-animation — an arm swung forward, a leg mid-stride. All
    // of that is baked into child transforms which ride along with the bone, so
    // nothing has to be reset; only the group's own toppling rotation would be
    // wrong, and a ragdoll is spawned before any of that has happened.
    group.updateMatrixWorld(true);

    const parts = [];
    for (const bone of bones) {
      const holder = bone.whole ? group : new THREE.Group();
      if (!bone.whole) {
        holder.scale.setScalar(scale);
        for (const mesh of bone.parts) {
          if (mesh) holder.add(mesh);   // three detaches it from the rig for us
        }
        this.scene.add(holder);
      }

      // Where this bone's centre is in the world right now.
      const at = new THREE.Vector3(bone.at[0], bone.at[1], bone.at[2]).multiplyScalar(scale);
      const world = at.clone().applyAxisAngle(UP, yaw).add(group.position);

      const handle = this.physics.addBox({
        size: { x: bone.size[0] * scale, y: bone.size[1] * scale, z: bone.size[2] * scale },
        position: { x: world.x, y: world.y, z: world.z },
        yaw,
        mass: bone.mass * scale,
        jointed: true,
        // Limbs windmill for ages on the stock damping. This is the single
        // number that decides whether a body falls or flails.
        angularDamping: 0.45,
      });
      if (!handle) { this._bail(parts, group, bones); return false; }

      parts.push({ handle, holder, bone, at, whole: !!bone.whole });
    }

    // The joints, in the same order the bones were declared, so a bone can only
    // ever hang off one that already exists.
    const joints = [];
    for (let i = 0; i < bones.length; i++) {
      const spec = bones[i].joint;
      if (!spec) continue;
      const parent = parts[spec.to];
      if (!parent) continue;

      // The pivot is one world point written twice: once in the parent's local
      // frame and once in the child's. Both are just "pivot minus my centre",
      // because every bone starts axis-aligned in rig space.
      const pivot = new THREE.Vector3(spec.at[0], spec.at[1], spec.at[2]).multiplyScalar(scale);
      const j = this.physics.join(
        parent.handle, parts[i].handle,
        pivot.clone().sub(parent.at),
        pivot.clone().sub(parts[i].at),
        { angle: spec.angle, twist: spec.twist });
      if (j) joints.push(j);
    }

    const item = {
      enemy, parts, joints,
      state: 'active',
      timer: SETTLE_MAX,
      quiet: 0,
      sink: 0,
      // The rig group is only still ours to remove when it was not itself a
      // bone. For a rat it IS the bone, and _remove must not take it twice.
      shell: bones[0].whole ? null : group,
    };
    this.items.push(item);

    this._throw(item, hit);
    return true;
  }

  // The shove that makes it a death rather than a collapse: the shot itself,
  // shared across the skeleton and driven into whichever bone stopped it.
  _throw(item, hit) {
    // No direction to throw along — a blast handled elsewhere, or a death that
    // arrived without a bullet — so the body just falls where it stood.
    if (!hit?.dir) return;

    // How heavy this shot was, and how far up the scale from a shove to a
    // launch that puts it. Everything below is a lerp on `t`.
    const punch = clamp(hit.punch ?? 1, THROW_MIN, THROW_MAX);
    const t = (punch - THROW_MIN) / (THROW_MAX - THROW_MIN);
    const speed = HIT_IMPULSE * punch;
    const share = BODY_SHARE + (BODY_SHARE_HARD - BODY_SHARE) * t;

    // The shot, tilted upward and made a unit vector — the lift has to change
    // the direction without also lengthening it, or the heavy end would be
    // getting a quiet extra 20% it was never given.
    const lift = HIT_LIFT + (HIT_LIFT_HARD - HIT_LIFT) * t;
    let dx = hit.dir.x, dy = (hit.dir.y ?? 0) + lift, dz = hit.dir.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    // The whole skeleton leaves together. This is one setVelocity per bone
    // rather than an impulse, so it is exactly the same change in speed for a
    // 34 kg trunk and a 4 kg forearm and the body stays a body on the way out.
    const carry = speed * share;
    for (const p of item.parts) {
      this.physics.setVelocity(p.handle, {
        x: dx * carry,
        y: dy * carry,
        z: dz * carry,
      });
    }

    // And the rest of it into the bone that actually stopped the round, at the
    // point it stopped it — which is where the tumble comes from.
    const target = this._boneFor(item, hit) ?? item.parts[0];
    const rest = speed * (1 - share) * (target.bone.mass ?? 1);
    this.physics.impulse(target.handle, { x: dx, y: dy, z: dz }, rest, hit.point);
  }

  // Which bone took the shot. The hit mesh is a torso or a head — the only two
  // that stop bullets — so this is a search for whichever bone claims it, with
  // the trunk as the answer when nothing does.
  _boneFor(item, hit) {
    if (!hit.mesh) return null;
    for (const p of item.parts) {
      if (p.bone.parts?.includes(hit.mesh)) return p;
    }
    return null;
  }

  // Explosions are not handled here on purpose. A ragdoll's bones are ordinary
  // dynamic bodies as far as physics.js is concerned, so they are already in the
  // list physics.blast() sweeps — an extinguisher going off next to a body
  // scatters it without this file knowing explosions exist. What arrives through
  // spawn() is the other half: enemies.splash hands over an outward direction, so
  // a body killed BY the blast is thrown by it too rather than folding up first.

  update(dt) {
    if (!this.items.length) return;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];

      if (item.state === 'active') {
        let asleep = true;
        for (const p of item.parts) {
          this._place(p);
          if (!this.physics.isSleeping(p.handle)) asleep = false;
        }

        // Two ways out, and both are needed: a body that comes to rest should
        // stop costing anything immediately, and a body wedged half-inside a
        // desk chair will never sleep and must stop costing anything anyway.
        item.quiet = asleep ? item.quiet + dt : 0;
        item.timer -= dt;
        if (item.quiet >= SETTLE_QUIET || item.timer <= 0) this._settle(item);
        continue;
      }

      if (item.state === 'settled') {
        item.timer -= dt;
        if (item.timer <= 0) this._sink(item);
        continue;
      }

      item.sink += dt;
      const k = Math.min(1, item.sink / SINK_TIME);
      for (const p of item.parts) {
        p.holder.position.y = p.restY - k * k * SINK_DEPTH;
      }
      if (k >= 1) this._remove(item);
    }
  }

  // Copy one bone's simulated transform onto its meshes.
  //
  // The holder's origin is the rig's origin, not the bone's, so the body's
  // position has to be walked back along the bone's own offset — that is what
  // keeps the head's meshes drawn around the head's body rather than a metre and
  // a half above it.
  _place(p) {
    const body = p.handle.body;
    const q = this._q.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    p.holder.quaternion.copy(q);
    this._v.copy(p.at).applyQuaternion(q);
    p.holder.position.set(
      body.position.x - this._v.x,
      body.position.y - this._v.y,
      body.position.z - this._v.z);
  }

  // Freeze where it landed and give the solver its bodies back. This is the step
  // that makes a floor of two hundred dead people affordable: a settled corpse
  // is a handful of meshes and no simulation at all.
  _settle(item) {
    if (item.state !== 'active') return;
    // Joints first, always. A constraint left holding a body that is no longer
    // in the world is a reference the solver will still try to solve.
    for (const j of item.joints) this.physics.unjoin(j);
    item.joints.length = 0;
    for (const p of item.parts) {
      this._place(p);
      p.restY = p.holder.position.y;
      this.physics.remove(p.handle);
    }
    item.state = 'settled';
    item.timer = LINGER;
  }

  _sink(item) {
    if (item.state === 'sinking') return;
    this._settle(item);
    item.state = 'sinking';
    item.sink = 0;
    for (const p of item.parts) {
      if (p.restY === undefined) p.restY = p.holder.position.y;
    }
  }

  _remove(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);

    for (const j of item.joints) this.physics.unjoin(j);
    item.joints.length = 0;
    for (const p of item.parts) {
      if (item.state === 'active') this.physics.remove(p.handle);
      this.scene.remove(p.holder);
    }
    if (item.shell) this.scene.remove(item.shell);
  }

  // A half-built ragdoll, undone. The meshes have already been re-parented out
  // of the rig by this point, so they are put back — a body that half fell over
  // and left an arm on the floor is worse than one that never fell over at all.
  _bail(parts, group, bones) {
    for (const p of parts) {
      this.physics.remove(p.handle);
      if (!p.whole) this.scene.remove(p.holder);
    }
    for (const bone of bones) {
      if (bone.whole) continue;
      for (const mesh of bone.parts) if (mesh) group.add(mesh);
    }
  }

  /** Everything goes with the floor it died on. */
  clear() {
    for (const item of [...this.items]) this._remove(item);
    this.items.length = 0;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
