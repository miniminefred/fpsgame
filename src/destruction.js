import * as THREE from 'three';
import { eraseSpan } from './gen/geom.js';
import { BodyPool } from './body-pool.js';
// The can a machine was stocked with. rigs.js because that is where the can was
// already built for the hand of whoever bought one, and it is the same can: a
// drink that comes out of a wrecked machine looking different from the one the
// man at the keypad is holding is two drinks.
import { buildCan } from './rigs.js';
import { CAN_R, CAN_H } from './drinks.js';
// ...and the generator's wreck, which is a method of this class in a file of
// its own. See the note beside `Object.defineProperties` at the bottom.
import { wreckMethods } from './wreck.js';

// Everything on the floor coming apart.
//
// There are two kinds of destructible and they are destroyed by opposite means,
// which is the whole reason this module exists:
//
//   * Loose props (chairs, crates) are already their own mesh and their own
//     rigid body. Breaking one is "delete the mesh, re-emit its boxes".
//   * Everything else — desks, shelving, vending machines, window glazing,
//     ceiling tubes — was merged into a batched chunk at generation time and has
//     no mesh of its own to delete. Breaking one means erasing its vertices in
//     place (see `eraseSpan`) and then re-emitting the boxes it was authored
//     from, which the generator captured for exactly this purpose.
//
// Both paths converge on the same debris pool: a capped, timed-out set of loose
// boxes, so a long run can never accumulate rubble until the frame rate dies.
//
// Routing a bullet to the right destructible is the other half of the problem. A
// raycast against a batched chunk hits a mesh shared by a hundred props, so the
// mesh identity tells us nothing. What it does give us is `faceIndex`, and a
// prop's vertices are a contiguous run inside that buffer — so a binary search
// over the runs on that mesh names the prop exactly. No spatial guessing, no
// tolerance to tune, and it stays correct for a pane of glass sitting three
// centimetres in front of a wall.

// --- what a machine was holding ---------------------------------------------
//
// Stock gets a pool of its OWN rather than going in with the debris, and both
// halves of that are requirements rather than tidiness.
//
// A can's geometry is shared and module-level (see `buildCan`), and the debris
// pool disposes the geometry of whatever it retires — one can timing out in
// there would take every can on the floor with it, and every machine that had
// not been shot yet along with them. `ownGeometry: false` is the brass case,
// which is exactly what this is.
//
// And stock must not compete for MAX_FRAGMENTS. `_scatter` keeps the biggest
// pieces and drops the rest, so a full machine and an empty one would throw
// different amounts of CABINET — the drinks crowding out the panels — while a
// can is nowhere near the biggest thing in a vending machine, so most of them
// would be dropped anyway.
const CAN_MAX = 32;            // about two machines' worth loose at once
const CAN_LIFETIME = 30;       // longer than a fragment: a can on the carpet is a mark
const CAN_MASS = 0.38;         // 330 ml of drink and the aluminium round it
const CAN_THROW = [1.4, 3.0];  // N.s per kg, well under a fragment's 2.2-4.6
const CAN_SPIN = 0.6;          // how far off its own centre a can is hit, as a share of it

const DEBRIS_LIFETIME = 16;    // seconds a fragment lies around before it fades
const MAX_DEBRIS = 120;        // hard cap on live fragments, oldest recycled first
const MAX_FRAGMENTS = 14;      // pieces one prop may break into, largest first

// A fragment is judged on its LONGEST side, not its shortest. Office furniture
// is panel goods — a desktop, a monitor, a shelf, a pane of glass are all a
// centimetre or two thick — so a filter that wanted every dimension to clear a
// threshold threw away almost everything worth watching fall.
const MIN_FRAGMENT = 0.06;     // metres, longest side
// Thin slabs are given a little body to collide with. Cannon will happily
// simulate a 2 mm box, but it tunnels and jitters through the floor; the visible
// mesh keeps its real thickness, only the collision box is padded.
const MIN_BODY = 0.03;

// Effective density for a fragment whose prop never declared a mass. Office
// furniture is mostly air and thin panel, so this is far below solid timber.
const DENSITY = 300;
const MAX_FRAGMENT_MASS = 40;

// How long the ceiling keeps coming down after the generator goes. See
// blackoutPanels: this is a budget for the WORK, not a delay on the sound, and
// that is the whole point of it. Long enough that two hundred tubes are two
// hundred tubes rather than one crack, short enough to still read as one event.
const BLACKOUT_RAIN = 1.2;
// And a ceiling on how much of that budget one frame may spend, so a frame that
// was already long cannot cash in the whole backlog and undo the spreading.
const BLACKOUT_MAX_PER_FRAME = 8;

// How many of those panels are allowed to make a NOISE, and this is the number
// the whole bug came down to. Two hundred tubes and two hundred falls of glass
// is ~400 voices, each with a panner and most with a lowpass, all started inside
// a second and all lasting longer than that — and a measurement taken while
// somebody was hearing the fault found 388 of them live at once and the audio
// clock 2.7 SECONDS behind the wall clock. A WebAudio context that far behind
// real time has stopped being able to render, which is the floor going silent.
//
// The engine is right not to have a voice cap (see sfx.js) and this is the other
// half of that bargain: deciding a sound should not have been ASKED for belongs
// to whoever understands the event. Two hundred tubes going across a whole
// building is one ceiling coming down to a player standing in one room of it,
// and the tubes out of earshot were never audible — the panner's falloff and the
// occlusion filter had already taken them to nothing. They were pure cost.
const BLACKOUT_VOICES = 16;

// Where a fitted prop is asked whether the room is on this side, and how big a
// space is asked for. See `_roomSide`.
//
// Both are smaller than the obvious answer, and the obvious answer was measured
// first: a body's own 0.4 m at 0.4 m past the corner found an open side on only
// **31 of 78** machines. A vending machine's nav footprint rounds outward to
// whole tiles, so a disc that wide pressed against the machine's own blocked
// ground and every side answered no. What is being asked here is "is the room
// this way", not "can somebody stand exactly here" — 0.25 m answers it on 76 of
// the 78, and it stays close enough in not to reach past the half-metre wall
// behind the machine and find the next room through it.
// How far a prop has to have fallen over before what is in it comes out: the
// cosine of the angle its own up-axis makes with the world's, so 0.57 is 55
// degrees. A cooler rocked by somebody walking into it rights itself; one past
// this is lying down. See `spillTipped`.
const TIP_COS = 0.57;
const _tipUp = new THREE.Vector3();

const SIDE_STAND = 0.4;
const SIDE_ROOM = 0.25;

const _spikeQ = new THREE.Quaternion();
const _spikeM = new THREE.Matrix4();
const _spikeOne = new THREE.Vector3(1, 1, 1);

/**
 * A small bar rooted at `at` and pointing along `dir`, as a stamp for
 * stampBoxes: a shard of torn plating, or one straight run of a hanging wire.
 *
 * Rotated, unlike everything else the wreck is built from — the bays are all
 * axis-aligned because they are cut out of axis-aligned boxes, and a rim of
 * axis-aligned spikes would be a row of little pillars rather than metal that
 * was ripped.
 *
 * `thickY` defaults to a random squash, which is what makes a shard read as
 * peeled sheet rather than as a rod; a wire passes its own thickness to get a
 * square section back.
 */
// The net path's own two scratch vectors. Not borrowed from the ones above:
// this file carries a comment about a real bug caused by two call sites sharing
// one Vector3, and a message arriving mid-frame is exactly a second call site.
const _netDir = new THREE.Vector3();
const _netAt = new THREE.Vector3();

export class Destruction {
  /**
   * `onShatter` and `onBreakProp` are co-op's, and they are fired from the two
   * places a PLAYER destroyed something rather than from `_shatter` itself. That
   * distinction is the whole point of them: a blackout breaks two hundred ceiling
   * panels and a blast takes the furniture around it, and both of those are
   * consequences the other browser is already deriving from the one event it was
   * told about. Announcing every knock-on as well would be two hundred messages
   * saying what the first one implied.
   */
  constructor({ scene, physics, effects, audio, shooting, lighting, spills }) {
    this.onShatter = null;
    this.onBreakProp = null;
    this.scene = scene;
    this.physics = physics;
    this.effects = effects;
    this.audio = audio;
    this.shooting = shooting;
    this.lighting = lighting;
    // Water on the floor. Optional like extinguishers: a build with no spills is
    // a build where a shot cooler simply breaks, which is what it did before.
    this.spills = spills ?? null;

    this.level = null;
    // The ceiling still coming down from a power cut, if one is — see
    // blackoutPanels. Null the rest of the time, which is almost always.
    this._blackout = null;
    // Electricity crawling over a wreck, once there is one on this floor.
    this.arcs = null;
    // Every fragment builds its own geometry, so the pool disposes it on retire.
    this.debris = new BodyPool({
      scene, physics, max: MAX_DEBRIS, life: DEBRIS_LIFETIME, ownGeometry: true,
    });
    // ...and what a machine was stocked with, which shares one geometry per
    // shape with every other can in the building and so must NOT be disposed.
    // See the CAN_* block above.
    this.stock = new BodyPool({
      scene, physics, max: CAN_MAX, life: CAN_LIFETIME, ownGeometry: false,
    });
  }

  // Called once per floor, after the level's meshes exist. Indexes each
  // destructible's vertex runs onto the mesh they ended up in, so a hit can be
  // traced back in a binary search rather than a scan.
  setLevel(level) {
    this.level = level;
    // A floor you left takes its unfinished ceiling with it. Without this, taking
    // the exit while the glass is still coming down would go on shattering the
    // OLD floor's panels against the new floor's nav grid and physics world.
    this._blackout = null;
    // And its wreck, which the level teardown has already taken out of the
    // scene — leaving the arcs behind would go on flickering a light over an
    // empty patch of the floor you just walked onto.
    this.arcs?.dispose();
    this.arcs = null;

    // Numbered, because a thing that can be destroyed needs a name a second
    // browser can use. Both lists come out of the generator in one order from one
    // seed, so static entry 412 is the same filing cabinet in both browsers and
    // loose prop 33 is the same chair — which is the whole of how a shattered
    // prop crosses the wire. See netplay.js.
    let loose = 0;
    for (const dyn of level.dynamics ?? []) dyn.index = loose++;

    const touched = new Set();
    let index = 0;
    for (const entry of level.destructibles ?? []) {
      entry.index = index++;
      for (const span of entry.spans) {
        if (!span.mesh) continue;
        const runs = span.mesh.userData.runs ??= [];
        runs.push({ start: span.start, end: span.start + span.count, entry });
        touched.add(span.mesh);
      }
    }
    for (const mesh of touched) mesh.userData.runs.sort((a, b) => a.start - b.start);
  }

  // --- co-op ------------------------------------------------------------------

  /**
   * The other player shot something apart. Both of these are the replay half of
   * `onShatter` / `onBreakProp`, and both are idempotent: a thing already broken
   * is left alone, which is what makes a duplicated or out-of-order message
   * harmless rather than a second explosion.
   *
   * The direction and the point come off the wire because they are what the
   * pieces are thrown by and where the wreck is carved from — a prop that comes
   * apart symmetrically on one screen and away from the shooter on the other is
   * two different events. Everything downstream then follows on its own: a
   * volatile prop launches its cylinder, the generator cuts the power, and the
   * nav grid and the collider list are given back their tiles — on both
   * browsers, from one message.
   */
  netShatter(i, dir, point) {
    const entry = this.level?.destructibles?.[i];
    if (!entry || entry.broken) return;
    this._shatter(entry, _netDir.set(dir.x, dir.y, dir.z), _netAt.set(point.x, point.y, point.z));
  }

  netBreakProp(i, dir, point) {
    const dyn = this.level?.dynamics?.[i];
    if (!dyn || dyn.broken) return;
    this._breakProp(dyn, _netDir.set(dir.x, dir.y, dir.z), _netAt.set(point.x, point.y, point.z));
  }

  // --- damage -----------------------------------------------------------------

  /**
   * A bullet landed on world geometry. Returns true if it landed on something
   * destructible, so the caller can skip the scorch decal — a hole in a desk
   * that is about to stop existing is wasted, and a decal left floating where
   * the desk used to be is worse.
   */
  /**
   * Whether a raycast hit landed on a destructible at all, asked WITHOUT
   * damaging it.
   *
   * The spray can needs to tell the building from the furniture and has nothing
   * to do about it either way (see `_trace` in shooting.js: only the building
   * keeps a mark, because a splat on a desk outlives the desk). It cannot ask
   * `damageSurface` with nothing in it -- that is the damage path, and it voices
   * the prop's own impact clip on the way past. Same `resolve` underneath, so
   * the two can never disagree about which faces belong to a prop.
   */
  owns(hit) {
    return !!resolve(hit);
  }

  damageSurface(hit, dir, damage) {
    const entry = resolve(hit);
    if (!entry) return false;
    if (entry.broken) return true;

    // Glass, a steel tube and a pot plant are all "world geometry" to the
    // raycast, and all sound completely different when you shoot them.
    this.audio.bulletHitMaterial(entry.kind, entry.substance, hit.point);

    entry.hp -= damage;
    if (entry.hp <= 0) {
      this._shatter(entry, dir, hit.point);
      this.onShatter?.(entry, dir, hit.point);
    }
    return true;
  }

  /** A bullet landed on a loose prop that is already its own body. */
  damageProp(dyn, dir, point, damage) {
    if (dyn.broken) return;
    // Ahead of the hp check: a prop you cannot destroy still answers when shot.
    this.audio.bulletHitMaterial('prop', dyn.substance, point);
    if (!dyn.hp) return;
    dyn.hp -= damage;
    // A round into something with water in it opens it, whether or not that round
    // was the one that finished it — the difference between the two is how much
    // comes out, and `_breakProp` below asks for the bigger one.
    if (dyn.spills && dyn.hp > 0) this._spill(dyn, point, false);
    if (dyn.hp <= 0) {
      this._breakProp(dyn, dir, point);
      this.onBreakProp?.(dyn, dir, point);
    }
  }

  /**
   * A prop with liquid in it that has been knocked OVER pours it out.
   *
   * Everything else about spills is damage: a round opens a bottle, and killing
   * the cooler bursts it. Neither is what happens when you walk into one hard
   * enough to put it on its side, and a 19-litre bottle lying on the carpet with
   * the carpet dry is the same lie the dry carpet told when a cooler was shot —
   * the player did a thing, they can see where the water should be, and it is
   * not there.
   *
   * IT ASKS THE PROP'S OWN UP-AXIS, not the solver. A loose prop's mesh is
   * synced from its rigid body every frame (see `_syncCollider` in game.js), so
   * the group's rotation IS the body's, and the one number that says "over" is
   * how far its own +Y has fallen away from the world's. `TIP_COS` is 55
   * degrees: a cooler rocked by a shove comes back, and one past 55 is on its
   * side and staying there.
   *
   * Once only, and that is `dyn.tipped` rather than the puddle's own liveness: a
   * bottle empties once, and a prop that rolls about afterwards must not go on
   * topping the patch up for the rest of the floor. It is emptied as a BURST
   * rather than fed slowly, because that is what a bottle on its side does, and
   * because `_spill` already puts the patch where the prop is now standing —
   * which for a tipped cooler is where it rolled to.
   */
  spillTipped(dyn) {
    if (!dyn?.spills || dyn.broken || dyn.tipped) return false;
    _tipUp.set(0, 1, 0).applyQuaternion(dyn.group.quaternion);
    if (_tipUp.y > TIP_COS) return false;
    dyn.tipped = true;
    // Poured from where the neck of it now is rather than from a hit point:
    // nothing hit it. `_spill` clamps this into the prop's own height.
    const p = dyn.group.position;
    this._spill(dyn, { x: p.x, y: p.y, z: p.z }, true);
    this.audio.waterGush({ x: p.x, y: p.y, z: p.z });
    return true;
  }

  /**
   * What comes out of a prop that had liquid in it.
   *
   * The patch belongs to the PROP rather than to the shot, so a cooler hit three
   * times spreads one puddle instead of stacking three on the same tile — which
   * is what `dyn.puddle` is for. Water lands on whatever floor the prop is
   * standing on, which is its own underside and not y = 0: a cooler shot in an
   * attic wets the attic.
   */
  _spill(dyn, point, burst) {
    if (!this.spills) return;
    const floor = dyn.group.position.y - dyn.size.y / 2;
    const from = Math.max(floor + 0.15, Math.min(point?.y ?? 0, floor + dyn.size.y));
    if (dyn.puddle?.live) {
      this.spills.feed(dyn.puddle, { burst });
      return;
    }
    dyn.puddle = this.spills.start(dyn.group.position.x, floor, dyn.group.position.z,
      { from, burst, liquid: dyn.spills,
        atX: point?.x ?? dyn.group.position.x, atZ: point?.z ?? dyn.group.position.z });
  }

  /**
   * ...and out of a FITTED prop that had liquid in it, which is the vending
   * machine and only it.
   *
   * A separate method rather than a branch in `_spill` because the two have
   * nothing in common but the call at the end: a loose prop is a group with a
   * position and a size, and a fitted one is a list of world-space boxes and no
   * transform at all. So the centre and the floor are MEASURED off the boxes
   * here, which also means they are right for a machine standing in an attic —
   * the same property `_spill` gets from reading the group's own underside.
   *
   * Burst only, and that falls out rather than being decided: a static prop has
   * no `damageProp` path, so there is no such thing as a round that opens one.
   * Which is the honest reading anyway — the drinks in a vending machine are in
   * sealed cans behind a steel door, so one round through the front does not
   * make it leak, and the machine coming apart lets go of all of them at once.
   */
  _spillStatic(entry, point) {
    if (!this.spills || !entry.spills) return;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxZ = -Infinity, maxY = -Infinity;
    for (const b of entry.parts ?? []) {
      minX = Math.min(minX, b.x0); maxX = Math.max(maxX, b.x1);
      minY = Math.min(minY, b.y0); maxY = Math.max(maxY, b.y1);
      minZ = Math.min(minZ, b.z0); maxZ = Math.max(maxZ, b.z1);
    }
    // No boxes is not a case that should happen — endStatic refuses a prop with
    // no spans — and it is cheap to be right about: a spill at the origin is a
    // puddle in the corner of the building.
    if (!Number.isFinite(minX)) return;

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Where it comes OUT of, clamped into the machine the way `_spill` clamps
    // it: the collection slot is near the bottom of a vending machine, so the
    // stream starts low whatever height the killing round landed at.
    const from = Math.max(minY + 0.15, Math.min(point?.y ?? 0, maxY));
    return this.spills.start(cx, minY, cz, {
      from, burst: true, liquid: entry.spills,
      atX: point?.x ?? cx, atZ: point?.z ?? cz,
      away: this._roomSide(cx, cz, (maxX - minX) / 2, (maxZ - minZ) / 2, point),
    });
  }

  /**
   * Which way is OUT of a fitted prop — the side the room is on.
   *
   * This is the whole of whether a burst out of a vending machine is visible,
   * and it was measured rather than guessed at. A machine is 1.04 m wide, as
   * wide as the patch it lets go of, and it is backed against a wall: over 38
   * machines on three floors, a patch centred on one put **67%** of the drink
   * inside the machine's own footprint — under the debris that lands there a
   * frame later — and **30%** inside the wall, leaving 3% of it on floor the
   * player can see. Which reads exactly like nothing having spilled at all.
   *
   * The floor is what answers it, the way `_wreck` asks the same question about
   * the generator: the open side is the one a body can stand on, and two nav
   * lookups cannot be wrong the way the hit point can. The point is only a
   * PREFERENCE between sides — the side the round came in on is the side the
   * player is standing on and the one they are looking at — and it is only ever
   * a preference because a prop caught in somebody else's explosion has its
   * "hit point" somewhere inside itself.
   *
   * Null when nothing is open, which is not a failure: a machine in a cupboard
   * spills where it stands, as it did before.
   */
  _roomSide(cx, cz, halfX, halfZ, point) {
    const nav = this.level?.nav;
    if (!nav) return null;
    const px = (point?.x ?? cx) - cx;
    const pz = (point?.z ?? cz) - cz;
    const sides = [
      { x: 1, z: 0, half: halfX }, { x: -1, z: 0, half: halfX },
      { x: 0, z: 1, half: halfZ }, { x: 0, z: -1, half: halfZ },
    ];
    sides.sort((a, b) => (b.x * px + b.z * pz) - (a.x * px + a.z * pz));
    for (const s of sides) {
      if (nav.clear(cx + s.x * (s.half + SIDE_STAND), cz + s.z * (s.half + SIDE_STAND), SIDE_ROOM)) {
        return { x: s.x, z: s.z };
      }
    }
    return null;
  }

  /**
   * A cardboard box gone flat under somebody who did not stop for it.
   *
   * The same path a shot takes, with a different noise on the end and no impact
   * flash: nothing struck it, it was simply stood on. Silent about who did it —
   * whoever walks over one flattens it, and that includes the staff going about
   * their day, which is most of what makes it worth having.
   */
  crush(dyn, at) {
    if (!dyn || dyn.broken) return;
    const point = at ?? dyn.group.position;
    this._breakProp(dyn, _up.set(0, -1, 0), point, 'crush');
    this.onBreakProp?.(dyn, { x: 0, y: -1, z: 0 }, point);
  }

  // --- breaking ---------------------------------------------------------------

  /**
   * Everything within `radius` of an explosion takes `damage`, falling off to
   * nothing at the rim. Distance is measured to the nearest point of a
   * destructible's own footprint rather than its centre, so a three-metre
   * meeting table is inside a blast that touches any part of it.
   *
   * This is what lets one extinguisher set off the next one across the room.
   */
  blast(point, radius, damage) {
    if (!this.level) return;
    for (const entry of this.level.destructibles ?? []) {
      if (entry.broken || !entry.colliders?.length) continue;

      let near = Infinity;
      for (const c of entry.colliders) {
        const dx = Math.max(c.minX - point.x, 0, point.x - c.maxX);
        const dz = Math.max(c.minZ - point.z, 0, point.z - c.maxZ);
        near = Math.min(near, Math.hypot(dx, dz));
      }
      if (near > radius) continue;

      entry.hp -= damage * (1 - near / radius);
      // Its own scratch vector: _shatter hands the point straight on to
      // _scatter, which measures every fragment against it while using _away
      // itself. Passing that one in would have it subtracted from itself.
      if (entry.hp <= 0) this._shatter(entry, _up.set(0, 1, 0), _blast.copy(point));
    }
  }

  /**
   * Scatter a set of boxes as debris from `point`, with nothing being destroyed
   * to produce them. The extinguisher uses this for its own remains: by the time
   * it goes off it has not been part of the floor for over a second.
   */
  scatter(parts, point) {
    this._scatter(parts, null, _up.set(0, 1, 0), point);
  }

  // Static destructible: erase it from the batch it was merged into, hand back
  // the floor it was standing on, and scatter the boxes it was authored from.
  // `silent` is for a caller breaking many things at once that has decided this
  // particular one is not one of the sounds — see blackoutPanels. Everything
  // else about the destruction is unchanged: it still goes, still throws debris,
  // still gives back its collider and its light.
  _shatter(entry, dir, point, silent = false) {
    entry.broken = true;

    for (const span of entry.spans) eraseSpan(span);

    // A prop that declared welded structure does not vanish — it is redrawn as
    // a burnt-out hulk standing where it stood. The spans are erased either way
    // and the survivors are RE-DRAWN rather than left in the batch, because a
    // batched chunk is one shared material and there is no way to scorch part
    // of it in place; see `_wreck`.
    const wrecked = entry.hulkSpans ? this._wreck(entry, point) : false;

    // A retired collider is left in the array rather than spliced out of it:
    // the player is holding that array, and `top` below the floor is already
    // how a collider says "walk through me" (see player.js). The solver keeps
    // its own static body per collider, and that has to go too or the debris
    // lands on the shape of the thing it just came out of.
    //
    // A wreck gives back NEITHER, and that is the whole difference between it
    // and everything else here: it is still standing, so it still blocks, and
    // the nav grid must go on routing round it. Which is also why nothing has
    // to be re-measured — the hulk keeps the machine's own full-height housing,
    // so the collider that was over it is still the right shape and the debris
    // that lands on it lands on the thing you can see.
    if (!wrecked) {
      for (const collider of entry.colliders) {
        collider.top = -1;
        this.physics?.removeStatic(collider);
      }
      this.level?.nav?.openTiles(entry.navTiles);
    }

    for (const fixture of entry.fixtures) this.lighting?.removeFixture(fixture);

    // A volatile prop does not break where it stands. It takes its own boxes
    // with it and comes apart somewhere else, loudly — see extinguishers.js.
    if (entry.volatile && this.extinguishers?.launch(entry, dir, point)) return;

    // Everything it was holding ends up on the floor. Before the debris, so the
    // gush is under the sound of the cabinet rather than after it — the same
    // ordering `_breakProp` uses, and for the same reason. Not for a wreck: a
    // hulk is still standing, so nothing has been let go of.
    if (!wrecked) this._spillStatic(entry, point);

    // ...and the solid half of what it was holding, which is the whole of what a
    // drinks machine is for. Stock does not come APART with the cabinet, it comes
    // OUT: as the drink it always was, from the slot it was standing in. So it is
    // split off the fragment list here rather than filtered inside `_scatter` -
    // these are two different lists, not one list with a flag on it. A hulked
    // prop keeps its stock, for `_spillStatic`'s reason one line up: it is still
    // standing, so it has not let go of anything.
    // A number is a drink, 'trim' is the label on one, and neither is a
    // fragment — so the two filters are not complements of each other, and the
    // label band belongs to neither pass. See `stock` on the sink.
    const held = entry.stock
      ? entry.parts.filter((p) => typeof p.stock === 'number') : null;
    const solid = entry.stock ? entry.parts.filter((p) => p.stock == null) : entry.parts;
    if (held?.length && !wrecked) this._spillStock(held, dir, point);

    // Only what came OFF is thrown, which for a wreck is the bays the blast tore
    // out of it and nothing else — `_wreck` hands them back for exactly this.
    // Throwing anything still standing would have the hulk stand there while a
    // copy of it tumbles across the room, and `_scatter` keeps the biggest
    // fragments, which is the housing and the plinth, so it would have been the
    // whole machine twice.
    this._scatter(
      wrecked ? [...solid.filter((p) => !p.hulk), ...wrecked] : solid,
      null, dir, point,
    );

    const glassy = entry.kind !== 'prop';
    this.effects.impact(point, _up.set(0, 1, 0), glassy ? 0xdff0ff : 0xffe4b0);
    if (!silent) this.audio.breakThing(entry.kind, entry.substance, point);

    // The one destructible that fans its own kill out floor-wide, the same
    // shape as `volatile` above: one flag on the entry, read here, handed to
    // whoever wants to do something about it — see game.js's `_onPowerCut`.
    if (entry.powerCore) this.onPowerCut?.(entry, point);
  }

  /**
   * Redraws a destroyed prop's welded structure as a burnt-out hulk, and
   * returns whether one was actually raised.
   *
   * The survivors cannot simply be left in the batch. A batched chunk is one
   * mesh sharing one material with a hundred other props, so there is nothing
   * to scorch that would not scorch every desk on the floor with it — and a
   * machine that loses its pipework and its lights but keeps its factory finish
   * reads as unfinished rather than as burnt. So the whole prop is erased as
   * usual and the structure comes back as a mesh of its own, in charred
   * variants of its own materials, at exactly the coordinates it already had:
   * `parts` are world-space, so nothing has to be transformed.
   *
   * One mesh per material, merged, so a wreck is two or three draw calls rather
   * than the twenty-odd boxes it is made of. It joins the floor's `objects` for
   * teardown (geometry only — see `charOf` on why the materials are shared and
   * must outlive the level), its `meshes` so decals clip against it, and the
   * hittable list so a bullet stops on it like any other part of the building.
   *
   * What is left is not the whole structure: it is cut into bays (see bayFor)
   * and then damaged, in the several ways a machine that has actually blown up
   * is damaged rather than in one: an upper corner blown clean off, the plating
   * around it dished by the same blast, shrapnel pocks scattered over the rest
   * of it, and the crater from the round that finished it. Only the corner goes
   * THROUGH — everything else is a bite out of the near face, because a machine
   * you can see daylight through in six places is a colander, not a wreck.
   *
   * The damage is the point twice more: it is where the arcs are struck from,
   * because electricity crawling out of unbroken plating looks painted on, and
   * the bays it took are handed back to the caller to be thrown, so the plating
   * that left the machine is the plating lying on the carpet.
   */
  blackoutPanels(fraction) {
    if (!this.level) return;
    const panels = (this.level.destructibles ?? []).filter((e) => e.kind === 'panel' && !e.broken);
    const n = Math.round(panels.length * fraction);
    if (!n) return;

    // Shuffled, so the ceiling fails all over the floor at once rather than
    // sweeping across it in whatever order the builder happened to emit it.
    for (let i = panels.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [panels[i], panels[j]] = [panels[j], panels[i]];
    }
    this._blackout = {
      queue: panels.slice(0, n), rate: n / BLACKOUT_RAIN, owed: 0, voices: BLACKOUT_VOICES,
    };
  }

  // Spends the blackout budget for one frame. `owed` carries the fraction of a
  // panel between frames, so the rate does not quietly depend on the frame rate.
  _drainBlackout(dt) {
    const b = this._blackout;
    if (!b) return;

    b.owed += b.rate * dt;
    let take = Math.min(Math.floor(b.owed), BLACKOUT_MAX_PER_FRAME);
    b.owed -= take;

    while (take-- > 0 && b.queue.length) {
      const entry = b.queue.pop();
      // It may have been shot, or caught by the blast, since it was queued.
      if (entry.broken) continue;
      const f = entry.fixtures[0];
      // Near enough to hear, and there is still a voice left for it. Both halves
      // matter: the range test alone still leaves a hundred tubes in earshot on a
      // big floor, and a budget alone would spend itself on the far side of the
      // building. Everything else breaks in silence — see BLACKOUT_VOICES.
      const heard = b.voices > 0 && this.audio.audibleAt(f.x, f.z);
      if (heard) b.voices--;
      this._shatter(entry, _up.set(0, -1, 0), _blast.set(f.x, f.y, f.z), !heard);
    }
    if (!b.queue.length) this._blackout = null;
  }

  // Loose prop: retire the intact body and re-emit its boxes as independent
  // ones, thrown outward from the shot that finished it.
  _breakProp(dyn, dir, point, how = 'shot') {
    dyn.broken = true;

    if (dyn.handle) this.physics?.remove(dyn.handle);
    dyn.handle = null;
    this.scene.remove(dyn.group);
    this.shooting.removeHittables(dyn.group.children);
    this.effects.removeSurfaces(dyn.group.children);

    // Retire its collider without disturbing the array the player is holding.
    if (dyn.collider) {
      dyn.collider.push = null;
      dyn.collider.top = -1;
    }

    // Everything it was holding ends up on the floor. Before the debris, so the
    // gush is under the sound of the plastic rather than after it.
    if (dyn.spills) this._spill(dyn, point, true);

    this._scatter(dyn.parts, dyn, dir, point);

    // A crushed box was not hit by anything, so there is nothing to flash and the
    // noise is the flattening rather than the breaking.
    if (how === 'crush') {
      this.audio.crushProp(point);
    } else {
      this.effects.impact(point, _up.set(0, 1, 0), 0xffe4b0);
      this.audio.breakThing('prop', dyn.substance, point);
    }
  }

  /**
   * Turns a list of boxes into debris. `dyn` is the loose prop they came from,
   * whose parts are in ITS local space and have to be brought into the world;
   * for a static destructible it is null and the boxes are already in world
   * space, because a static prop never moved from where it was generated.
   */
  _scatter(parts, dyn, dir, point) {
    if (!parts?.length) return;

    const volume = dyn ? Math.max(1e-4, dyn.size.x * dyn.size.y * dyn.size.z) : 0;
    const yaw = dyn ? new THREE.Euler().setFromQuaternion(dyn.group.quaternion, 'YXZ').y : 0;

    // A shelving unit is authored from forty boxes and a ceiling tube from two.
    // Capping by size keeps the big, readable pieces and drops the ring binders,
    // so one shot can't spend the whole debris budget.
    const chosen = parts
      .filter((p) => longestSide(p) >= MIN_FRAGMENT)
      .sort((a, b) => longestSide(b) - longestSide(a))
      .slice(0, MAX_FRAGMENTS);

    for (const part of chosen) {
      const sx = part.x1 - part.x0, sy = part.y1 - part.y0, sz = part.z1 - part.z0;

      _local.set((part.x0 + part.x1) / 2, (part.y0 + part.y1) / 2, (part.z0 + part.z1) / 2);
      const world = dyn
        ? _local.applyQuaternion(dyn.group.quaternion).add(dyn.group.position).clone()
        : _local.clone();

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), part.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.copy(world);
      this.scene.add(mesh);

      // A loose prop knows what it weighed, so its pieces share that out by
      // volume and a chair's base still outweighs its arm. A static one never
      // had a mass, so its pieces are weighed from their own size instead.
      const mass = dyn
        ? Math.max(0.4, dyn.mass * ((sx * sy * sz) / volume))
        : THREE.MathUtils.clamp(sx * sy * sz * DENSITY, 0.4, MAX_FRAGMENT_MASS);

      const handle = this.physics?.addBox({
        size: {
          x: Math.max(sx, MIN_BODY), y: Math.max(sy, MIN_BODY), z: Math.max(sz, MIN_BODY),
        },
        position: world, yaw, mass,
      });

      if (handle) {
        // Blown away from the impact and slightly upward; the impulse is
        // applied at the hit point rather than the centre, so pieces spin.
        _away.copy(world).sub(point);
        if (_away.lengthSq() < 1e-6) _away.copy(dir);
        _away.normalize();
        _away.y += 0.75;
        _away.normalize();
        this.physics.impulse(handle, _away, mass * (2.2 + Math.random() * 2.4), point);
      }

      this.debris.add(mesh, handle);
    }
  }

  /**
   * What a machine was stocked with, on the carpet.
   *
   * One real can per facing, at the facing's own position, so the drinks that
   * come out are the drinks that were in the window and they come out of the
   * slots they were standing in. `part.stock` is the seed the generator drew for
   * that slot and `buildCan` is the only thing that reads it, which is what makes
   * the two ends agree: the orange can behind the glass is an orange can on the
   * floor, and the one in twenty that was already shot through comes out shot.
   *
   * Thrown much more gently than a fragment (see CAN_THROW). A cabinet panel is
   * being torn off something while a can is merely being let go of — and a
   * full-strength shove on 0.38 kg puts the whole shelf through the far wall,
   * which reads as the machine having fired them rather than dropped them.
   */
  _spillStock(parts, dir, point) {
    for (const part of parts) {
      _local.set(
        (part.x0 + part.x1) / 2, (part.y0 + part.y1) / 2, (part.z0 + part.z1) / 2);

      // The facing is a shallow plate against the glass; the can it stands for
      // is a whole can, so the body is sized off the CAN and not off the box.
      const can = buildCan(part.stock);
      can.position.copy(_local);
      can.receiveShadow = true;
      this.scene.add(can);

      const handle = this.physics?.addBox({
        size: { x: CAN_R * 2, y: CAN_H, z: CAN_R * 2 },
        position: _local, mass: CAN_MASS,
      });

      if (handle) {
        _away.copy(_local).sub(point);
        if (_away.lengthSq() < 1e-6) _away.copy(dir);
        _away.normalize();
        _away.y += 0.55;
        _away.normalize();

        // Applied off the can's own centre, or two dozen cans leave the machine
        // dead upright and in step, which reads as a shelf being slid out rather
        // than as a cabinet coming apart. `impulse` clamps the lever arm to the
        // body's own radius, so an off-centre point here cannot be made absurd.
        _canAt.copy(_local);
        _canAt.x += (Math.random() - 0.5) * CAN_R * 2 * CAN_SPIN;
        _canAt.y += (Math.random() - 0.5) * CAN_H * CAN_SPIN;
        _canAt.z += (Math.random() - 0.5) * CAN_R * 2 * CAN_SPIN;

        this.physics.impulse(handle, _away,
          CAN_MASS * (CAN_THROW[0] + Math.random() * (CAN_THROW[1] - CAN_THROW[0])),
          _canAt);
      }

      this.stock.add(can, handle);
    }
  }

  // --- debris lifecycle -------------------------------------------------------

  update(dt) {
    this._drainBlackout(dt);
    this.debris.update(dt);
    this.stock.update(dt);
    this.arcs?.update(dt);
  }

  // Must run while the physics world the handles belong to is still alive.
  clear() {
    this.debris.clear();
    this.stock.clear();
    this._blackout = null;
    this.arcs?.dispose();
    this.arcs = null;
    this.level = null;
  }
}

// Names the destructible a raycast hit landed on, or null for plain scenery.
// `faceIndex` counts triangles in the merged buffer; the first vertex of that
// triangle is what the vertex runs are indexed by.
function resolve(hit) {
  const runs = hit.object.userData.runs;
  if (!runs || hit.faceIndex == null) return null;

  const index = hit.object.geometry.index;
  const vertex = index ? index.getX(hit.faceIndex * 3) : hit.faceIndex * 3;

  let lo = 0, hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid];
    if (vertex < run.start) hi = mid - 1;
    else if (vertex >= run.end) lo = mid + 1;
    else return run.entry;
  }
  return null;
}

function longestSide(p) {
  return Math.max(p.x1 - p.x0, p.y1 - p.y0, p.z1 - p.z0);
}

const _local = new THREE.Vector3();
// Its own, and not a second use of _local: this file already documents a real
// bug caused by two call sites sharing one scratch Vector3.
const _canAt = new THREE.Vector3();
const _away = new THREE.Vector3();
const _up = new THREE.Vector3();
const _blast = new THREE.Vector3();

/**
 * ...and the wreck, which is a method of this class living in wreck.js.
 *
 * A thousand of this file's lines were the generator coming apart, and they
 * shared nothing with the rest of it: sixty constants and a dozen helpers that
 * nothing else in the game reads, behind one method that `_shatter` calls on the
 * one prop in the catalogue that leaves something behind. So they are a file, and
 * the method goes back on here.
 *
 * MIXED ON RATHER THAN PASSED THE INSTANCE, for the reason enemies.js states at
 * greater length: `_wreck` reads six of this class's collaborators and moving it
 * verbatim is what lets `tools/baseline/damage.txt` say the split changed
 * nothing — which is the whole value of a split. Rewriting every line to take
 * an explicit `dest` would have thrown that away to no end.
 */
for (const name of Object.keys(wreckMethods)) {
  if (Object.hasOwn(Destruction.prototype, name)) {
    throw new Error(`destruction.js: two definitions of ${name}`);
  }
}
Object.defineProperties(Destruction.prototype,
  Object.getOwnPropertyDescriptors(wreckMethods));
