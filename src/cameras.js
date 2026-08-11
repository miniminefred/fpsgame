import * as THREE from 'three';
import { CEIL_H, CORRIDOR, ROOM, SOLID, worldX, worldZ } from './gen/layout.js';
import { angleLerp, clamp, clamp01, smoothTo } from './util.js';
import { EYE, JUMP_APEX } from './metrics.js';

// Building security: the things on the walls that are watching the floor.
//
// Every floor gets five to ten of them, in two trades that ask completely
// different questions of the player:
//
//   WATCHERS  swing a slow arc across a corridor or a room. Walk into the cone
//             and the lamp goes amber, and it stays on you for as long as it can
//             see you. Six seconds of that and it calls it in. You can break the
//             look — round a corner, through a door, back out of range — and the
//             count bleeds back down, so being seen is a timer rather than a
//             verdict.
//   TRIPWIRES are a laser across a doorway or a hallway at hip height, and they
//             have no timer at all: the beam is either unbroken or the alarm is
//             already going. They are mounted low and drawn bright on purpose —
//             a tripwire you cannot see before you cross it is not a hazard, it
//             is a tax.
//
// So the two of them are a warning you can react to and a line you must not
// cross, and both have the same answer: shoot the unit. They are small, fragile
// and one round each, which is the reward for having noticed one before it
// noticed you.
//
// What an alarm MEANS — who turns up and how many — is enemies.js's business
// (see `alarm` there), because it is a fact about the roster. This file only
// knows that one went off.

// How many are fitted per floor. Deliberately not scaled with depth: the floors
// grow, so the same count is already thinner cover further down.
const PER_FLOOR = [5, 10];
// Roughly how many of them are tripwires rather than watchers. Both are always
// represented when the count allows — a floor of one kind is a floor with one
// idea on it.
const LASER_SHARE = 0.4;

// --- watchers ---------------------------------------------------------------

const WATCH_RANGE = 16;        // metres it can make you out at
const WATCH_CONE = 0.60;       // radians either side of where it is pointed
const ALARM_TIME = 6;          // seconds in the cone before it calls it in
// Breaking the look does not reset the count, it drains it. A hard reset makes
// stepping behind a doorframe for one frame a full pardon; draining means the
// second time it sees you, it has less patience.
const COOL_RATE = 0.55;        // seconds of count lost per second out of sight
const SWEEP_ARC = 0.85;        // radians either side of its rest bearing
const SWEEP_RATE = 0.4;        // radians a second on the idle sweep
const TRACK_K = 7;             // how hard it snaps onto you once it has you
const SWEEP_K = 1.8;           // ...and how lazily it goes back to sweeping

// --- tripwires --------------------------------------------------------------

const BEAM_MAX = 14;           // metres before the emitter gives up
const BEAM_MIN = 2;            // ...and the shortest span worth fitting one to
// Hip height, and crossable only by jumping it. The number is chosen against
// JUMP_APEX (~1.36 m) rather than picked to look right: a tripwire you cannot
// clear is a tax, and one you clear by accident is not a hazard. Deriving the
// apex from the jump means retuning the jump moves this rather than silently
// invalidating it — which is why BEAM_Y is stated as a fraction of it.
const BEAM_Y = JUMP_APEX * 0.7;   // 0.95 m at the current jump
const BEAM_R = 0.34;           // how close the beam gets to you before it trips

// --- both -------------------------------------------------------------------

const MOUNT_Y = CEIL_H - 0.5;  // watchers ride high, where nobody knocks them
const MIN_VIEW = 5;            // metres of clear run a watcher wants ahead of it
const MIN_GAP = 9;             // metres between two units
const MIN_FROM_SPAWN = 11;     // ...and from the lifts, so arrival is not a cone
// After an alarm every unit on the floor is stood down for a while. Without it
// the three cameras that all had you in view at the six second mark each call in
// their own response, and the floor answers a single sighting with twelve men.
const REARM = 30;

const IDLE_LAMP = 0x2fbf6a;    // green: it has not got anything
const SEEN_LAMP = 0xffb020;    // amber: it has, and it is counting
const FIRED_LAMP = 0xff2a24;   // red: it called it in
const BEAM_COLOR = 0xff2a2a;

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Cameras {
  constructor({ scene, audio, effects }) {
    this.scene = scene;
    this.audio = audio;
    this.effects = effects;
    this.items = [];
    this.meshes = [];          // what bullets test against
    this.cooldown = 0;
    this._t = 0;

    // Set by game.js. `onSpotted` is the moment a unit gets you — one beep, not
    // a state; `onAlarm` is the thing itself.
    this.onSpotted = null;
    this.onAlarm = null;

    // Geometry is shared by every unit ever built and released only on dispose;
    // materials that are written to at runtime (the lamp, the beam) are per
    // unit, because a lamp shared between ten cameras is one camera.
    this.geo = {
      body: new THREE.BoxGeometry(0.2, 0.17, 0.34),
      hood: new THREE.BoxGeometry(0.23, 0.03, 0.24),
      bracket: new THREE.BoxGeometry(0.16, 0.16, 0.16),
      lens: new THREE.CylinderGeometry(0.055, 0.055, 0.04, 12),
      lamp: new THREE.BoxGeometry(0.055, 0.035, 0.03),
      emitter: new THREE.BoxGeometry(0.14, 0.18, 0.12),
      plate: new THREE.BoxGeometry(0.1, 0.16, 0.05),
      beam: new THREE.BoxGeometry(1, 1, 1),
    };
    this.mats = {
      shell: new THREE.MeshStandardMaterial({ color: 0x30353c, roughness: 0.55, metalness: 0.35 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x0a0c0f, roughness: 0.25, metalness: 0.6 }),
      plate: new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.7, metalness: 0.2 }),
    };
  }

  /** The highest count on the floor, 0..1 — what the HUD draws. */
  get watch() {
    let worst = 0;
    for (const c of this.items) {
      if (!c.dead && c.count > worst) worst = c.count;
    }
    return Math.min(1, worst / ALARM_TIME);
  }

  /**
   * Fits this floor with cameras.
   *
   * Every tile with a wall beside it is collected first and then shuffled,
   * rather than darts thrown at the grid until enough of them stick. The
   * difference is not speed, it is whether the count is honest: a wall-adjacent
   * tile that survives all of the tests below is a few percent of a floor, so
   * dart-throwing quietly delivered four cameras on one floor and ten on the
   * next. Walking the list means a floor comes up short only if it genuinely
   * has nowhere left to put one.
   */
  spawn(layout, nav, rng) {
    this.clear();
    this.layout = layout;
    this.nav = nav;
    this.cooldown = 0;

    const want = rng.int(PER_FLOOR[0], PER_FLOOR[1]);
    // How many of them are tripwires, decided up front and then shuffled in
    // among the rest, so a floor always gets some of each rather than however
    // the coin happened to land ten times running.
    const lasers = clamp(Math.round(want * LASER_SHARE), 1, want - 1);
    const kinds = rng.shuffle([
      ...new Array(lasers).fill(true),
      ...new Array(want - lasers).fill(false),
    ]);

    const sites = this._sites(layout, rng);
    let next = 0;
    for (const laser of kinds) {
      while (next < sites.length) {
        const spot = this._mount(layout, nav, sites[next++], laser, rng);
        if (spot) { this._build(spot, laser, rng); break; }
      }
    }
  }

  // Every open tile with a wall beside it, shuffled. The wall is what a camera
  // hangs off, so a tile in the middle of the floor is not a candidate however
  // good the view from it would be.
  _sites(layout, rng) {
    const { W, H, tiles } = layout;
    const out = [];
    for (let ty = 1; ty < H - 1; ty++) {
      for (let tx = 1; tx < W - 1; tx++) {
        const i = ty * W + tx;
        const t = tiles[i];
        if (t !== CORRIDOR && t !== ROOM) continue;
        // Never inside a badged room. A camera you cannot walk up to is a
        // camera that can neither catch you nor be shot out, which is two
        // thirds of what one is for.
        if (layout.locked?.[i]) continue;
        if (tiles[i - 1] === SOLID || tiles[i + 1] === SOLID
          || tiles[i - W] === SOLID || tiles[i + W] === SOLID) out.push(i);
      }
    }
    return rng.shuffle(out);
  }

  // Can this site take one, and if so, which wall does it hang off and which
  // way does it look? Null if the site is no good for this kind of unit.
  _mount(layout, nav, i, laser, rng) {
    const { W, tiles } = layout;
    const tx = i % W, ty = (i / W) | 0;

    const cx = worldX(layout, tx + 0.5);
    const cz = worldZ(layout, ty + 0.5);
    if (Math.hypot(cx - layout.spawn.x, cz - layout.spawn.z) < MIN_FROM_SPAWN) return null;
    if (this.items.some((c) => Math.hypot(c.x - cx, c.z - cz) < MIN_GAP)) return null;

    // The wall it backs onto. Started at a random side so a floor's cameras are
    // not all mounted on their tiles' east wall.
    const start = rng.int(0, 3);
    let wall = null;
    for (let k = 0; k < 4 && !wall; k++) {
      const [dx, dy] = DIRS[(start + k) % 4];
      if (tiles[(ty + dy) * W + tx + dx] === SOLID) wall = [dx, dy];
    }
    if (!wall) return null;

    // Which way it looks. A camera bolted to a wall does not have to look
    // straight off it — the bracket is there precisely so it can look ALONG the
    // corridor it is in, which is where the traffic is. So all three facings
    // that are not into the wall are measured and the longest run wins; in a
    // 3 m corridor that reliably turns the camera down the hall instead of at
    // the plaster opposite.
    let best = null;
    for (const [dx, dy] of DIRS) {
      if (dx === wall[0] && dy === wall[1]) continue;
      // A tripwire wants to cross the space, not run down it — and it is
      // mounted at hip height where a bracket cannot reach past furniture, so
      // it only ever fires straight off its own wall.
      if (laser && (dx !== -wall[0] || dy !== -wall[1])) continue;

      const from = { x: cx + wall[0] * 0.24, z: cz + wall[1] * 0.24 };
      const run = this._run(layout, from.x, from.z, dx, dy, laser ? BEAM_MAX : WATCH_RANGE);
      if (!best || run > best.run) best = { dx, dy, run, from };
    }
    if (!best || best.run < (laser ? BEAM_MIN : MIN_VIEW)) return null;
    // Not buried behind a filing cabinet. Only the first stride is tested: the
    // run itself is measured against the shell, because a beam at hip height
    // and a lens at two and a half metres both clear a desk, and demanding an
    // empty floor all the way to the far wall would leave a furnished office
    // with nowhere to fit one.
    if (!nav.clear(best.from.x + best.dx * 0.8, best.from.z + best.dy * 0.8, 0.3)) return null;

    return {
      x: best.from.x, z: best.from.z,
      dx: best.dx, dz: best.dy, run: best.run,
      // Which way the wall it hangs on faces, which is NOT where it looks: a
      // watcher is usually turned along the corridor rather than off the wall.
      wallYaw: Math.atan2(wall[0], wall[1]),
    };
  }

  // How far a straight line gets from here before the building stops it. Walls
  // and shut-able doorways only — see the note in _findMount about furniture.
  _run(layout, x, z, dx, dz, max) {
    const { W, H, tiles, TILE, ox, oz } = layout;
    const step = TILE * 0.5;
    for (let d = step; d <= max; d += step) {
      const tx = Math.floor((x + dx * d - ox) / TILE);
      const ty = Math.floor((z + dz * d - oz) / TILE);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return d - step;
      const t = tiles[ty * W + tx];
      // A doorway stops a beam even standing open: it is where a door lives,
      // and a laser drawn through a shut panel is a laser drawn through a door.
      if (t !== CORRIDOR && t !== ROOM) return d - step;
    }
    return max;
  }

  _build(spot, laser, rng) {
    // Two nested frames, because the two halves of a camera do different
    // things: the plate is bolted to the wall and never moves, and everything
    // above it turns. Hanging the lot off one group would swing the bracket
    // round with the lens, which is a camera that has come off its own mount.
    const group = new THREE.Group();
    // Same convention as everything else that faces somewhere in this game
    // (see enemies.js): a frame's local -Z is its forward.
    const yaw = Math.atan2(-spot.dx, -spot.dz);
    group.position.set(spot.x, laser ? BEAM_Y : MOUNT_Y, spot.z);

    const pivot = new THREE.Group();
    pivot.rotation.y = yaw;
    group.add(pivot);

    const cam = {
      laser,
      group,
      pivot,
      x: spot.x, z: spot.z,
      y: laser ? BEAM_Y : MOUNT_Y,
      at: new THREE.Vector3(spot.x, laser ? BEAM_Y : MOUNT_Y, spot.z),
      rest: yaw,                 // the bearing it sweeps around
      aim: yaw,                  // ...and where it is actually pointed
      phase: rng.range(0, 6.283),
      count: 0,                  // seconds of you it has banked
      seen: false,
      dead: false,
      // Tripwires only: where the beam ends, in world space.
      endX: spot.x + spot.dx * spot.run,
      endZ: spot.z + spot.dz * spot.run,
      lampMat: new THREE.MeshBasicMaterial({ color: laser ? FIRED_LAMP : IDLE_LAMP }),
      beamMat: null,
    };

    const add = (geo, mat, x, y, z, hittable = true, onto = pivot) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      onto.add(mesh);
      if (hittable) {
        // How a bullet gets from a mesh back to the unit it belongs to. Every
        // solid piece carries it, because at fifteen metres the difference
        // between the body and the hood is not a decision the player made.
        mesh.userData.cctv = cam;
        this.meshes.push(mesh);
      }
      return mesh;
    };

    if (laser) {
      add(this.geo.emitter, this.mats.shell, 0, 0, -0.06);
      add(this.geo.lens, this.mats.dark, 0, 0, -0.13).rotation.x = Math.PI / 2;
      // The receiver on the far wall. It is what makes the beam read as
      // equipment spanning a gap rather than as a light somebody left on.
      add(this.geo.plate, this.mats.plate, 0, 0, -spot.run - 0.02);

      cam.beamMat = new THREE.MeshBasicMaterial({
        color: BEAM_COLOR, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      // Not a hittable: you shoot the emitter, not the light coming out of it.
      const beam = add(this.geo.beam, cam.beamMat, 0, 0, -spot.run / 2, false);
      beam.scale.set(0.016, 0.016, spot.run);
      cam.beam = beam;
      // The emitter lamp is the beam's own colour and never changes — a
      // tripwire has no states to report.
      add(this.geo.lamp, cam.lampMat, 0.06, 0.08, -0.1, false);
    } else {
      // The wall plate: on the group rather than the pivot, and turned to face
      // the wall rather than the view.
      const plate = add(this.geo.bracket, this.mats.plate, 0, 0, 0, true, group);
      plate.rotation.y = spot.wallYaw;
      plate.position.set(-Math.sin(spot.wallYaw) * 0.08, 0, -Math.cos(spot.wallYaw) * 0.08);

      add(this.geo.body, this.mats.shell, 0, 0, -0.24);
      add(this.geo.hood, this.mats.shell, 0, 0.1, -0.28);
      add(this.geo.lens, this.mats.dark, 0, 0, -0.42).rotation.x = Math.PI / 2;
      // On the FRONT, beside the lens, and big enough to read across a room.
      // It is the entire warning the game gives you, and a tell you can only
      // see from beside the thing is a tell for somebody else.
      add(this.geo.lamp, cam.lampMat, 0.08, 0.05, -0.4, false);
    }

    this.scene.add(group);
    this.items.push(cam);
    return cam;
  }

  /**
   * A bullet landed on one. Returns true if that was the shot that killed it,
   * which is what earns the hitmarker — a dead unit is ordinary scenery and
   * shooting it again should read like shooting a wall.
   *
   * One round from anything, like the window glazing and the ceiling tubes: it
   * is a plastic box on a bracket, and making the player empty a magazine into
   * one would turn every camera into a noise complaint.
   */
  damage(cam, _damage, point, normal) {
    if (!cam || cam.dead) return false;
    cam.dead = true;
    cam.count = 0;
    cam.seen = false;

    // Hanging off its own bracket. Left in the world rather than deleted,
    // because "I already did that one" is worth being able to see from down the
    // corridor.
    cam.pivot.rotation.x = 1.15;
    cam.pivot.position.y -= 0.05;
    cam.lampMat.color.setHex(0x181a1d);
    if (cam.beam) { cam.beam.visible = false; }

    if (point && normal) this.effects?.impact(point, normal, 0xffd08a, 1.4);
    this.audio?.breakThing('prop', 'electronic', point ?? cam.at);
    return true;
  }

  update(dt, player) {
    if (!this.items.length) return;
    this._t += dt;
    if (this.cooldown > 0) this.cooldown -= dt;

    const px = player.object.position.x;
    const pz = player.object.position.z;
    const feet = player.object.position.y - EYE;

    for (const cam of this.items) {
      if (cam.dead) continue;
      const was = cam.seen;

      if (cam.laser) {
        // No cone, no aiming, no patience. Either the beam is unbroken or the
        // alarm is already going.
        const across = segmentDistance(px, pz, cam.x, cam.z, cam.endX, cam.endZ);
        cam.seen = across < BEAM_R && feet < BEAM_Y && feet + EYE > BEAM_Y;
        // The beam brightens with the player's own footsteps, so a corridor
        // with one in it announces itself before you are on top of it.
        cam.beamMat.opacity = 0.4 + Math.sin(this._t * 3 + cam.phase) * 0.12;
        if (cam.seen && !was) {
          this.onSpotted?.(cam);
          this._raise(cam);
        }
        continue;
      }

      this._look(cam, dt, px, pz);
      if (cam.seen && !was) this.onSpotted?.(cam);

      if (cam.seen && this.cooldown <= 0) cam.count = Math.min(ALARM_TIME, cam.count + dt);
      else cam.count = Math.max(0, cam.count - COOL_RATE * dt);

      // The lamp is the only warning there is, so it says both things at once:
      // amber means it has you, and the blink runs faster the closer the count
      // is to being spent.
      const k = cam.count / ALARM_TIME;
      if (k > 0) {
        const blink = Math.sin(this._t * (5 + k * 22)) > -0.2 ? 1 : 0.18;
        cam.lampMat.color.setHex(SEEN_LAMP).multiplyScalar(blink);
      } else {
        cam.lampMat.color.setHex(IDLE_LAMP);
      }

      if (cam.count >= ALARM_TIME) this._raise(cam);
    }
  }

  // Where it is pointed, and whether you are in front of it. The cone is tested
  // against where the camera is ACTUALLY looking rather than where it would like
  // to be, which is what gives you the moment between walking into a corridor
  // and the thing swinging onto you.
  _look(cam, dt, px, pz) {
    const dx = px - cam.x;
    const dz = pz - cam.z;
    const dist = Math.hypot(dx, dz) || 0.001;

    const fx = -Math.sin(cam.aim);
    const fz = -Math.cos(cam.aim);
    cam.seen = dist < WATCH_RANGE
      && (dx * fx + dz * fz) / dist > Math.cos(WATCH_CONE)
      && this.nav.losClear(cam.x, cam.z, px, pz);

    const want = cam.seen
      ? Math.atan2(-dx, -dz)
      : cam.rest + Math.sin(this._t * SWEEP_RATE + cam.phase) * SWEEP_ARC;
    cam.aim = angleLerp(cam.aim, want, smoothTo(cam.seen ? TRACK_K : SWEEP_K, dt));
    cam.pivot.rotation.y = cam.aim;
  }

  _raise(cam) {
    if (this.cooldown > 0) return;
    this.cooldown = REARM;
    // Everything on the floor is stood down together — see REARM. They stay
    // red for as long as the response is out, which is the honest readout: the
    // building already knows, and another six seconds of being looked at is not
    // going to make it worse.
    for (const c of this.items) {
      c.count = 0;
      if (!c.dead && !c.laser) c.lampMat.color.setHex(FIRED_LAMP);
    }
    this.onAlarm?.(cam);
  }

  /** Everything on this floor goes with the floor. */
  clear() {
    for (const cam of this.items) {
      this.scene.remove(cam.group);
      cam.lampMat.dispose();
      cam.beamMat?.dispose();
    }
    this.items.length = 0;
    this.meshes.length = 0;
    this.cooldown = 0;
  }

  dispose() {
    this.clear();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}

// Distance from a point to a segment, on the floor plane.
function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0
    ? clamp01(((px - ax) * dx + (pz - az) * dz) / len2)
    : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
