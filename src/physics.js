import {
  Body, Box, ConeTwistConstraint, ContactMaterial, Material, ObjectCollisionMatrix,
  Plane, Quaternion, SAPBroadphase, Vec3, World,
} from 'cannon-es';

// Rigid-body simulation for loose office props — the chairs, cardboard boxes,
// monitors, coffee cups and bins that should skid, tumble and settle when they
// are shot. Nothing else in the game is solver-driven: the player and the
// enemies stay hand-rolled kinematic movers, because a constraint-solved FPS
// character feels floaty and is far harder to tune than a capsule with a ground
// clamp. Physics here is reactive set-dressing, so it can be cheap and
// forgiving where a character controller could not be.
//
// The module owns a cannon-es World and nothing else — no DOM, no scene graph,
// no Three.js import. `syncMesh()` is the single seam where a simulated
// transform is copied onto a THREE.Object3D, which keeps rendering and
// simulation independent and makes this file testable in bare Node.
//
// Three things keep a whole floor affordable:
//   * Sleeping. A settled prop leaves the solver entirely, so a room of
//     undisturbed furniture costs almost nothing until a bullet lands.
//   * Sweep-and-prune broadphase. A floor registers ~600-1000 static collider
//     boxes plus up to ~80 dynamic props; all-pairs would be hopeless there.
//   * A fixed 1/60 timestep behind an accumulator with a hard substep cap, so a
//     GC pause or a tab switch can never make the sim try to "catch up" and
//     spiral into a slideshow.

const FIXED_DT = 1 / 60;        // simulation tick; never varies with framerate
const MAX_SUBSTEPS = 4;         // at most 4 ticks per frame — the anti-spiral cap
const MAX_FRAME_DT = 0.1;       // a frame longer than this is treated as a stall

// Slightly heavier than Earth. Real gravity at first-person scale reads as
// slow-motion; ~1.6g keeps a knocked-over chair looking like a chair.
const GRAVITY = -16;

// Sleep thresholds. sleepSpeedLimit is compared against
// |velocity|^2 + |angularVelocity|^2, so it covers spin as well as drift.
const SLEEP_SPEED_LIMIT = 0.18; // m/s (and rad/s)
const SLEEP_TIME_LIMIT = 0.5;   // seconds below the limit before a body sleeps

// Damping bleeds off the residual energy the solver leaves behind. Without it
// props creep for several seconds and never reach the sleep threshold.
const LINEAR_DAMPING = 0.05;
const ANGULAR_DAMPING = 0.2;

// Explosion guards. Nothing in this game legitimately moves this fast, so any
// body that does has been wedged into a corner by the solver.
const MAX_LINEAR_SPEED = 40;    // m/s
const MAX_ANGULAR_SPEED = 25;   // rad/s
const KILL_Y = -40;             // fell out of the world (should be impossible)

// Collision filtering. Props collide with the world and with each other; the
// static world never needs to be told it is touching itself.
//
// Jointed bodies — the limbs of a ragdoll — are their own group, and the group
// deliberately does NOT collide with itself. A chain of boxes held together by
// constraints that is also being pushed apart by its own contacts is the classic
// way to make a ragdoll vibrate itself across a room: the shoulder constraint
// pulls the arm into the torso, the contact solver shoves it back out, and the
// two fight at 60 Hz forever. Every part still collides with the building and
// with the furniture, which is all you actually look at. The cost is that two
// corpses lie through each other, which is a far smaller lie than a corpse
// having a seizure.
const GROUP_WORLD = 1;
const GROUP_PROP = 2;
const GROUP_JOINTED = 4;

/**
 * Stock SAPBroadphase tests `needBroadphaseCollision` *before* the sorted-axis
 * bounds check, and a rejected pair `continue`s instead of breaking. Every
 * static-vs-static pair is rejected, so with a floor's worth of static boxes
 * each static ends up scanning the entire remaining list every tick — O(n^2).
 * Swapping the two tests restores the early break that makes sweep-and-prune
 * worth using: the filter still runs, just after the pair has survived the
 * sweep, so the pair set is unchanged (measured bit-identical over 900 frames)
 * while the cost at 1100 bodies drops from ~2.1ms to ~0.26ms per frame.
 */
class SweepBroadphase extends SAPBroadphase {
  collisionPairs(world, p1, p2) {
    const bodies = this.axisList;
    const N = bodies.length;
    const axisIndex = this.axisIndex;

    if (this.dirty) {
      this.sortList();
      this.dirty = false;
    }

    for (let i = 0; i !== N; i++) {
      const bi = bodies[i];
      for (let j = i + 1; j < N; j++) {
        const bj = bodies[j];
        if (!SAPBroadphase.checkBounds(bi, bj, axisIndex)) break;
        if (!this.needBroadphaseCollision(bi, bj)) continue;
        this.intersectionTest(bi, bj, p1, p2);
      }
    }
  }
}

export class Physics {
  constructor() {
    // Surface materials are created once and reused across floors: contact
    // materials are looked up by material id, so recreating them per floor
    // would leak entries into the world's lookup table.
    this._propMat = new Material('prop');
    this._worldMat = new Material('world');

    // Scratch vectors — impulses happen on every bullet hit, so they must not
    // allocate.
    this._imp = new Vec3();
    this._rel = new Vec3();
    this._zero = new Vec3();

    this.world = null;
    this.props = [];
    // The suspended ceiling, as far as the solver is concerned. Mirrors CEIL_H
    // in gen/layout.js; kept as a field so nothing here has to import the
    // floorplan to know how tall a room is.
    this.ceilingY = 3.0;
    // Static bodies, keyed by the level collider they were built from, so a
    // destroyed prop can take its own collision away with it.
    this._statics = new Map();
    this._accum = 0;
    this._hasGround = false;

    this.reset();
  }

  /**
   * Drop everything and start a fresh world. Called on every new floor, before
   * that floor's bodies are added. Building a new World is cheaper and far
   * safer than removing bodies one at a time — stale contacts, broadphase axis
   * entries and sleep timers all go away with the old object.
   */
  reset() {
    const world = new World({
      gravity: new Vec3(0, GRAVITY, 0),
      allowSleep: true,
    });
    world.broadphase = new SweepBroadphase(world);
    world.broadphase.axisIndex = 0; // floors are wide in X and Z; either works

    // cannon's default collision matrix is a dense triangular array that is
    // zeroed in full every tick — n^2/2 writes, which at ~1000 bodies is 450k
    // writes per tick and dwarfs the actual simulation (measured ~4ms/frame on
    // an idle floor). The sparse variant stores only pairs that are actually
    // touching, so an asleep room costs nothing. Same interface, same events.
    world.collisionMatrix = new ObjectCollisionMatrix();
    world.collisionMatrixPrevious = new ObjectCollisionMatrix();

    // 10 iterations is plenty for shallow piles of boxes. The loose tolerance
    // lets the solver bail early on the common case of a nearly-settled room.
    world.solver.iterations = 10;
    world.solver.tolerance = 0.001;

    // Fallback for anything without an explicit pairing.
    world.defaultContactMaterial.friction = 0.4;
    world.defaultContactMaterial.restitution = 0.02;

    // Props against the level: enough friction that a shoved box slides a
    // little and then topples rather than skating, almost no bounce so a
    // dropped monitor lands dead instead of pinging around like rubber.
    world.addContactMaterial(new ContactMaterial(this._propMat, this._worldMat, {
      friction: 0.45,
      restitution: 0.04,
      contactEquationStiffness: 1e7,
      contactEquationRelaxation: 3,
      frictionEquationStiffness: 1e7,
      frictionEquationRelaxation: 3,
    }));

    // Props against each other: slightly slicker so piles spread and settle
    // instead of locking into a jittering stack.
    world.addContactMaterial(new ContactMaterial(this._propMat, this._propMat, {
      friction: 0.35,
      restitution: 0.03,
      contactEquationStiffness: 1e7,
      contactEquationRelaxation: 3,
      frictionEquationStiffness: 1e7,
      frictionEquationRelaxation: 3,
    }));

    this.world = world;
    this.props = [];
    this._statics.clear();
    this._accum = 0;
    this._hasGround = false;
  }

  /**
   * Register the level's static collision. `boxes` is the array of level AABBs,
   * each `{ minX, maxX, minZ, maxZ, top }` with y spanning 0..top. Also creates
   * the ground: an infinite plane at y=0, so a prop punted off a balcony can
   * never leak out of the world no matter how big the floor is.
   */
  addStatics(boxes) {
    if (!this.world) return;

    // Callers may hand over a floor's colliders in more than one batch, so the
    // ground is created once per world rather than once per call.
    if (!this._hasGround) {
      const ground = new Body({
        mass: 0,
        type: Body.STATIC,
        shape: new Plane(),
        material: this._worldMat,
        collisionFilterGroup: GROUP_WORLD,
        collisionFilterMask: GROUP_PROP | GROUP_JOINTED,
      });
      // A cannon Plane faces +Z; tip it to face +Y.
      ground.quaternion.setFromAxisAngle(new Vec3(1, 0, 0), -Math.PI / 2);
      this.world.addBody(ground);

      // And a lid. Nothing the player can throw gets near the ceiling, but a
      // holed extinguisher is not thrown — it flies, and without this it leaves
      // through the roof and goes off somewhere over the car park.
      const ceiling = new Body({
        mass: 0,
        type: Body.STATIC,
        shape: new Plane(),
        material: this._worldMat,
        position: new Vec3(0, this.ceilingY, 0),
        collisionFilterGroup: GROUP_WORLD,
        collisionFilterMask: GROUP_PROP | GROUP_JOINTED,
      });
      ceiling.quaternion.setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2);
      this.world.addBody(ceiling);

      this._hasGround = true;
    }

    if (!boxes) return;
    for (const b of boxes) {
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      // `base` is the underside, which almost nothing has: a wall, a desk and a
      // door panel all start at the floor. A second storey's slab does (see
      // gen/stairs.js), and the solver has to know, or debris rests on the ground
      // floor's ceiling. Absent, this is `b.top - 0` and the box is what it was.
      const base = b.base ?? 0;
      const h = b.top - base;
      // Zero-thickness colliders have no volume for the narrowphase to work
      // with and would only pollute the broadphase list.
      if (!(w > 1e-4) || !(d > 1e-4) || !(h > 1e-4)) continue;

      const body = new Body({
        mass: 0,
        type: Body.STATIC,
        shape: new Box(new Vec3(w / 2, h / 2, d / 2)),
        position: new Vec3((b.minX + b.maxX) / 2, base + h / 2, (b.minZ + b.maxZ) / 2),
        material: this._worldMat,
        collisionFilterGroup: GROUP_WORLD,
        collisionFilterMask: GROUP_PROP | GROUP_JOINTED,
      });
      this.world.addBody(body);
      this._statics.set(b, body);
    }
  }

  /**
   * Drop a piece of static collision. Needed because the level's furniture is
   * destructible: retiring the collider the PLAYER sees is not enough on its
   * own, because the solver has its own copy, and debris left resting on the
   * ghost of a desk that has just been shot apart hangs in mid-air.
   */
  removeStatic(box) {
    const body = this._statics.get(box);
    if (!body) return;
    this._statics.delete(box);
    this.world?.removeBody(body);
  }

  /**
   * Add a loose prop as a dynamic box and return an opaque handle. `size` is the
   * full extent in metres, `position` the centre of the box, `yaw` a rotation
   * about Y. Returns null if the description is unusable, so a bad prop can
   * never take the whole floor down with it.
   */
  addBox({ size, position, yaw = 0, mass = 1, jointed = false, angularDamping }) {
    if (!this.world || !size || !position) return null;
    const sx = size.x, sy = size.y, sz = size.z;
    if (!(sx > 1e-4) || !(sy > 1e-4) || !(sz > 1e-4)) return null;
    if (!isFiniteVec(position)) return null;

    const quaternion = new Quaternion();
    quaternion.setFromAxisAngle(new Vec3(0, 1, 0), Number.isFinite(yaw) ? yaw : 0);

    const body = new Body({
      mass: Math.max(0.05, Number.isFinite(mass) ? mass : 1),
      shape: new Box(new Vec3(sx / 2, sy / 2, sz / 2)),
      position: new Vec3(position.x, position.y, position.z),
      quaternion,
      material: this._propMat,
      linearDamping: LINEAR_DAMPING,
      angularDamping: Number.isFinite(angularDamping) ? angularDamping : ANGULAR_DAMPING,
      allowSleep: true,
      sleepSpeedLimit: SLEEP_SPEED_LIMIT,
      sleepTimeLimit: SLEEP_TIME_LIMIT,
      collisionFilterGroup: jointed ? GROUP_JOINTED : GROUP_PROP,
      // cannon pairs two bodies only when EACH one's group is in the other's
      // mask, so leaving GROUP_JOINTED out of a jointed part's own mask is what
      // stops any two of them ever reaching the narrowphase — while a prop,
      // which does list it, still gets knocked over by a falling body.
      collisionFilterMask: jointed
        ? (GROUP_WORLD | GROUP_PROP)
        : (GROUP_WORLD | GROUP_PROP | GROUP_JOINTED),
    });
    this.world.addBody(body);

    // The spawn transform doubles as a recovery point: if the solver ever
    // produces a NaN, the prop is teleported back here rather than vanishing.
    const handle = {
      body,
      spawn: {
        x: position.x, y: position.y, z: position.z,
        qx: quaternion.x, qy: quaternion.y, qz: quaternion.z, qw: quaternion.w,
      },
    };
    this.props.push(handle);
    return handle;
  }

  /**
   * Pin two bodies together at a shared point, with a limit on how far the joint
   * may bend and twist.
   *
   * `pivotA` and `pivotB` are the SAME world point expressed in each body's own
   * local frame, which is what makes an elbow an elbow rather than two boxes
   * agreeing to be near each other. `angle` is the half-cone the child may swing
   * through and `twist` how far it may rotate about its own axis, both radians —
   * without them a shoulder is a ball joint and an arm rotates through its own
   * chest, which is the difference between a body and a bag of sticks.
   *
   * Returns a handle for unjoin(), or null if the world is gone.
   */
  join(a, b, pivotA, pivotB, { angle = Math.PI / 3, twist = Math.PI / 6, axis } = {}) {
    if (!this.world || !a || !b) return null;
    const opts = {
      pivotA: new Vec3(pivotA.x, pivotA.y, pivotA.z),
      pivotB: new Vec3(pivotB.x, pivotB.y, pivotB.z),
      angle,
      twistAngle: twist,
    };
    if (axis) {
      opts.axisA = new Vec3(axis.x, axis.y, axis.z);
      opts.axisB = new Vec3(axis.x, axis.y, axis.z);
    }
    const c = new ConeTwistConstraint(a.body, b.body, opts);
    // Constraints are not contacts: a joint that gives way under its own limb's
    // weight reads as a dislocation, so it is allowed as much force as it needs.
    c.collideConnected = false;
    this.world.addConstraint(c);
    return c;
  }

  unjoin(c) {
    if (!this.world || !c) return;
    this.world.removeConstraint(c);
  }

  /** Straight linear velocity, for a body that has just been thrown. */
  setVelocity(h, v) {
    if (!h || !isFiniteVec(v)) return;
    h.body.wakeUp();
    h.body.velocity.set(v.x, v.y, v.z);
    clampBody(h.body);
  }

  /**
   * Advance the simulation by a frame delta. Time is consumed in whole 1/60
   * ticks so behaviour is identical at 30 and 240 fps; leftover time carries to
   * the next frame. A frame longer than MAX_FRAME_DT, or a backlog deeper than
   * MAX_SUBSTEPS, is discarded outright: after a stall the right answer is to
   * lose a little simulated time, not to burn a second of CPU replaying it.
   */
  step(dt) {
    if (!this.world) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    this._accum += Math.min(dt, MAX_FRAME_DT);

    let substeps = 0;
    while (this._accum >= FIXED_DT && substeps < MAX_SUBSTEPS) {
      this.world.step(FIXED_DT);
      this._accum -= FIXED_DT;
      substeps++;
    }
    if (substeps === MAX_SUBSTEPS) this._accum = 0;

    if (substeps > 0) this._sanitize();
  }

  /** Copy a handle's simulated transform onto a THREE.Object3D. */
  syncMesh(mesh, h) {
    if (!mesh || !h) return;
    const p = h.body.position;
    const q = h.body.quaternion;
    mesh.position.set(p.x, p.y, p.z);
    mesh.quaternion.set(q.x, q.y, q.z, q.w);
  }

  /**
   * A bullet hit. `dir` is a unit direction, `point` the world contact point,
   * `strength` an impulse magnitude in N·s. Applying at the contact point is
   * what makes a corner hit spin a chair instead of just sliding it.
   */
  impulse(h, dir, strength, point) {
    if (!h || !dir || !Number.isFinite(strength)) return;
    const body = h.body;

    // Defensive normalise: callers pass unit vectors, but a denormalised one
    // would silently scale the shove by an arbitrary factor.
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 1e-6)) return;
    const k = strength / len;
    this._imp.set(dir.x * k, dir.y * k, dir.z * k);

    if (point && isFiniteVec(point)) {
      // cannon-es wants the application point relative to the centre of mass.
      // Clamping the lever arm to the body's own radius stops a stray hit point
      // (a ray that grazed something else) from generating absurd torque.
      this._rel.set(point.x - body.position.x, point.y - body.position.y, point.z - body.position.z);
      const r = Math.hypot(this._rel.x, this._rel.y, this._rel.z);
      const maxR = body.boundingRadius || 0;
      if (r > maxR && r > 1e-6) this._rel.scale(maxR / r, this._rel);
    } else {
      this._rel.set(0, 0, 0);
    }

    body.wakeUp();
    body.applyImpulse(this._imp, this._rel);
    clampBody(body);
  }

  /**
   * Everything loose within `radius` of `point`, thrown away from it. The falloff
   * is linear rather than inverse-square on purpose: the honest curve puts almost
   * all of the impulse into whatever was touching the blast and leaves the rest
   * of the room politely undisturbed, which is not what a room looks like after
   * an explosion.
   */
  blast(point, radius, strength) {
    if (!this.world || !isFiniteVec(point) || !(radius > 0)) return;
    for (const h of this.props) {
      const p = h.body.position;
      const dx = p.x - point.x, dy = p.y - point.y, dz = p.z - point.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;

      const k = 1 - dist / radius;
      // Straight up for anything sitting exactly on the blast, and biased upward
      // for everything else — furniture that only slides looks like it was
      // pushed, not blown.
      this._imp.set(dx, dy + radius * 0.35, dz);
      const len = this._imp.length();
      if (!(len > 1e-6)) this._imp.set(0, 1, 0);
      else this._imp.scale(1 / len, this._imp);

      const mass = h.body.mass || 1;
      this._imp.scale(strength * k * Math.sqrt(mass), this._imp);
      h.body.wakeUp();
      h.body.applyImpulse(this._imp, this._zero);
      clampBody(h.body);
    }
  }

  /** True once the body has come to rest, so callers can stop syncing it. */
  isSleeping(h) {
    return !!h && h.body.sleepState === Body.SLEEPING;
  }

  /**
   * Take a prop out of the world. Needed because props are destructible: the
   * intact body is removed and replaced by one body per fragment, and the
   * fragments are themselves removed once they have settled and timed out.
   * Without this the body count would only ever grow over a run.
   */
  remove(h) {
    if (!this.world || !h) return;
    const i = this.props.indexOf(h);
    if (i === -1) return;
    this.props.splice(i, 1);
    this.world.removeBody(h.body);
  }

  /** Release everything. The world and its bodies are dropped together. */
  dispose() {
    this.world = null;
    this.props = [];
    this._statics.clear();
    this._accum = 0;
    this._hasGround = false;
  }

  // Post-step safety net. Only awake props are inspected, so a settled room
  // costs a single sleepState read per prop per frame.
  _sanitize() {
    for (const h of this.props) {
      const body = h.body;
      if (body.sleepState === Body.SLEEPING) continue;

      const p = body.position;
      const q = body.quaternion;
      if (!isFiniteVec(p) || !isFiniteVec(body.velocity) || !isFiniteVec(body.angularVelocity) ||
          !Number.isFinite(q.x + q.y + q.z + q.w) || p.y < KILL_Y) {
        // Unrecoverable: put the prop back where it started and park it.
        p.set(h.spawn.x, h.spawn.y, h.spawn.z);
        q.set(h.spawn.qx, h.spawn.qy, h.spawn.qz, h.spawn.qw);
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        body.force.set(0, 0, 0);
        body.torque.set(0, 0, 0);
        body.sleep();
        continue;
      }

      clampBody(body);
    }
  }
}

export default Physics;

// Caps linear and angular speed in place. Cheap enough to run on every awake
// body every frame, and it turns a solver blow-up into a merely ugly frame
// instead of a prop leaving the building at Mach 3.
function clampBody(body) {
  const v = body.velocity;
  const vs = v.x * v.x + v.y * v.y + v.z * v.z;
  if (vs > MAX_LINEAR_SPEED * MAX_LINEAR_SPEED) {
    v.scale(MAX_LINEAR_SPEED / Math.sqrt(vs), v);
  }

  const w = body.angularVelocity;
  const ws = w.x * w.x + w.y * w.y + w.z * w.z;
  if (ws > MAX_ANGULAR_SPEED * MAX_ANGULAR_SPEED) {
    w.scale(MAX_ANGULAR_SPEED / Math.sqrt(ws), w);
  }
}

function isFiniteVec(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
