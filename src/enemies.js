import * as THREE from 'three';
import { BODY_RADIUS as RADIUS } from './nav.js';
import { buildRig } from './rigs.js';
import { give, take } from './held.js';
import { DEATH_TIME, HIT_FLASH, SWING_TIME, animate, die } from './enemy-anim.js';
import { angleDelta, angleLerp, smoothTo } from './util.js';
import { EYE } from './metrics.js';
// The rest of this class, in the four files it is split across. See the note
// beside `Object.defineProperties` at the bottom of this file.
import { rosterMethods } from './roster.js';
import { netMethods } from './enemy-net.js';
import { breakMethods } from './breaks.js';
import { stationMethods } from './stations.js';
import { LUNCH_GAP } from './enemy-tuning.js';

// How far off the ground the player's feet have to be to be on another level of the
// building rather than standing on a desk. A level's floor is LEVEL_Y up or down (see
// gen/stairs.js) and the tallest thing anybody can climb onto down here is a 2.1 m
// locker, so past this you are on another level and nothing else puts you there.
const STOREY_GAP = 2.4;

const SIGHT = 22;          // metres they can notice you at, with line of sight

// How close two bodies get before they shove each other apart. One constant,
// because the test and the push have to agree: this was written as `d2 > 0.64`
// in one line and `(0.8 - d)` in the next — the same number squared and not —
// and moving either on its own sends the shove negative, which pulls bodies
// together instead of apart.
const SEPARATION = 0.8;
// How far apart two heights have to be before they are different levels. Used by
// anyNear, whose callers are on the floor rather than in the nav grid and so have
// a height rather than a layer number.
const SAME_LEVEL = 1.2;
const SEPARATION_SQ = SEPARATION * SEPARATION;

// Packed cell key for the separation grid. The building is centred on the origin
// and never approaches half a cell-grid across, so the bias keeps both axes
// positive and the key inside the safe-integer range.
const CELL_BIAS = 4096;
const packCell = (cx, cz) => (cx + CELL_BIAS) * 8192 + (cz + CELL_BIAS);
const cellKey = (x, z) =>
  packCell(Math.floor(x / SEPARATION), Math.floor(z / SEPARATION));
// How far gunfire carries — measured *through the building*, not through its
// walls. A straight-line radius was the bug: someone one metre away through
// drywall and a thirty metre walk from the nearest door counted as right next to
// you, so firing anywhere turned the whole floor around at once. Walking the
// distance field instead means noise spreads the way it actually would, down
// corridors and out of doorways, and this can afford to be generous because it
// is now an honest number.
const HEARING = 14;
// Being heard is a real contact, so it holds them as long as you keep shooting.
// Without this an enemy who heard you two rooms away walks toward the noise for
// GIVE_UP seconds, gives up short of arriving, and goes back to work — which
// makes hearing you look broken rather than lethal.
const HEARD_MEMORY = 4;
// One of them calls it out and the rest just come. Every enemy shouting the
// instant it notices you is a chorus, and it was the single loudest thing on the
// floor.
const SHOUT_GAP = 1.8;

// The neutral staff. They pick somewhere to be, walk there, pick again — which
// is what "still going about your day" looks like without a plan, and it keeps
// them moving through doorways rather than pacing one room.
const PANIC_HOP = 30;          // metres they will commit to in one direction
const PANIC_PATIENCE = 6;      // ...and how long before they change their mind
const PANIC_SHOUT = [1.6, 3.4];
// Shoot a neutral and they do not draw a weapon they never had — they bolt.
// Fleeing is the same wander loop with the destination filtered to somewhere
// further from you, so it routes through doorways like everything else; when it
// runs out they go back to whatever they were doing.
const FLEE_TIME = 8;
const FLEE_SPEED = 1.45;
const FLEE_AWAY = 4;           // metres a flee destination must gain on you
// The beat between being seen and being shot at.
//
// Sight is line of sight and nothing else, and `fireCooldown` has been ticking
// down since the floor was generated — so before this, a body that heard a shot
// two rooms ago was standing in `chase` with its cooldown long expired, and the
// frame you crossed its door frame it fired. With its back to you, if that is how
// it happened to be standing. Rounding a corner into three of those is not a fight
// you lost, it is one you were never in.
//
// So a shooter has to HOLD you for `tuning.aim` seconds before its first round,
// and only the time it spends actually pointing at you counts (AIM_CONE) — which
// is what makes the one facing the wrong way the one you get to surprise, since
// turning round is already a real cost (the yaw smoothing in _move).
//
// It DRAINS rather than resets (AIM_DRAIN), which is the rule cameras.js already
// uses and for the same reason: one frame behind the door frame is not a pardon,
// and a player bobbing in and out of a doorway must not be permanently
// un-shootable. The second peek costs them less than the first did.
//
// Melee is exempt. A swing already lands part-way through rather than on the
// wind-up (see SWING_TIME), which is the same courtesy paid in the same coin.
const AIM_CONE = 1.05;     // radians of yaw error they will aim inside (~60°)
const AIM_DRAIN = 0.6;     // seconds of aim lost per second out of sight
// ...and how much credit one body may bank, as a multiple of what it needs. A
// body that has been shooting at you for thirty seconds must not be holding
// thirty seconds of aim, or the drain buys you nothing for the rest of the fight
// and stepping back out of a doorway is instantly fatal for ever after.
const AIM_BANK = 1.6;

const PREFERRED = 7;       // range a shooter tries to hold
const TOO_CLOSE = 3.5;
const GIVE_UP = 7;         // seconds of no contact before they settle down

// How close you can get to somebody at work before they stop working.
//
// The one trigger in this file that is not about noticing, and it is here
// because sight is not enough on its own: a body at a machine has its back to
// the room, and `losClear` samples a grid, so a player who has come through the
// doorway behind them or round the end of a rank of racks can be well inside
// arm's reach and not have been seen. Wide enough to cover the room they are
// standing in the middle of, short enough that walking past the far wall of a
// long office does not set them off. See `_choreWork` and chores.js.
const CHORE_STARTLE = 4.5;

// What an explosion is worth as a throw, at the seat of it. Above anything a gun
// can do, which is the point of standing next to one. See splash.
const BLAST_PUNCH = 3.5;
// What a round is worth by where it lands. A head is worth more than a chest and
// a chest more than a limb, which is the ordering every shooter has and the one
// the player is already aiming as if it were true.
//
// The ordering is the whole of it and the SPREAD is deliberately tiny — a nudge,
// not a rule. A head worth double turns every gun into a one-shot gun against
// anything that is not armoured, and a limb worth half turns a clean hit at
// twenty metres into a punishment for the 14 cm of arm that happened to be in
// front of the chest. Neither of those is aim, they are luck with a multiplier
// on it. At a tenth either way the head is still the shot worth taking and a
// limb still costs you something, and no single round decides a fight on
// geometry the player could not have controlled.
const HIT_ZONES = { head: 1.12, torso: 1, limb: 0.92 };

// The response was sent, and it has no desk to go back to. GIVE_UP is a clerk
// who heard a bang two rooms away and is entitled to decide he imagined it;
// these men were told over the radio, and a response that turns round after
// seven seconds and stands in a corridor is not one.
const RESPONSE_PATIENCE = 30;
export class Enemies {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.meshes = [];       // what bullets test against
    this.shoutTimer = 0;    // floor-wide, so only one of them calls you out
    this.keyedAlive = 0;    // badge holders still on their feet — see _keyed
    this.onDeath = null;    // set by game.js — see _damage
    this.ragdolls = null;   // likewise; what happens to a body after _damage

    // --- co-op, all four unused in a single-player run --------------------
    // Whether this end of the wire is allowed to decide that somebody is hurt.
    // The host is; the joiner reports its shots instead and waits to be told,
    // because two browsers each deciding when a man dies is two different men.
    this.authority = true;
    // Whether this roster is posed from the host's snapshots rather than thought
    // for. Set on the joiner; see `update` and `_poseAll`.
    this.puppet = false;
    // (enemy, muzzle, aim) — somebody fired, so the other end can draw it.
    this.onFire = null;
    // (enemy, damage, hit) — a shot landed and we are NOT the authority, so it
    // goes on the wire instead of into anybody's health.
    this.onReport = null;
    // (enemy, outcome, hit) — we ARE the authority and have just decided that
    // somebody is hurt or dead, so the other end has to be told. Deliberately
    // fired from `_damage` and not from `_die`: `_die` is also how the joiner
    // applies a death it was TOLD about, and announcing that back would be a
    // death bouncing between two browsers for ever.
    this.onDamaged = null;
    // A body on a parcel run is walked by jobs.js rather than by `_wander`, and
    // has to be told when the run is off. Both are set by jobs.js if it is
    // wired at all — with neither, nothing in this file starts a run and none of
    // this costs a branch that matters.
    this.jobTick = null;    // one frame of somebody's run
    this.jobLost = null;    // ...and the run is over, however it ended
    // The same seam a second time, for the ordinary work: a body with `e.chore`
    // on it is walked by chores.js. Two pairs of hooks rather than one, because
    // a slot has one occupant and a second consumer of a single-slot callback is
    // how one of them quietly stops being called — the note `washers.js` makes
    // about `onBreakProp`. See chores.js.
    this.choreTick = null;
    this.choreLost = null;
    // Where `snapshot` got to last time, so the roster is covered round-robin
    // rather than the first SNAP_CAP bodies being the only ones ever sent.
    this._snapCursor = 0;
    this._v = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    // Cell -> the living bodies in it, rebuilt each frame. See _rebuildNeighbours.
    this._cells = new Map();
    // Room -> the desks in it nobody has been sat at yet. Refilled per floor by
    // `spawn`, emptied as the roster is placed. See deskPool and _takeDesk.
    this.desks = new Map();
    // ...and every other kind of place the furnisher said somebody could work,
    // by station name. Shared rather than dealt out — a printer is somewhere a
    // body stands for twenty seconds. See spawn, and chores.js.
    this.stations = new Map();
  }

  // What the floor objective counts. The neutrals are alive and on the floor and
  // are deliberately not in this number — clearing a floor means clearing the
  // people shooting at you, not hunting down a cleaner.
  get hostileCount() {
    let n = 0;
    for (const e of this.items) if (e.alive && !e.neutral) n++;
    return n;
  }

  /**
   * Hostiles you can get to without opening anything you have not got the card
   * for. Everyone on the floor except the manager, sitting behind his own door.
   *
   * This is what decides when the black card drops: the moment this reaches zero
   * the player has killed everyone they are able to, and the card has to be on
   * the carpet or the floor cannot be finished. See game.js.
   */
  get openHostileCount() {
    let n = 0;
    for (const e of this.items) if (e.alive && !e.neutral && !e.behindLock) n++;
    return n;
  }

  /**
   * The floor's colliders: the building with its fitted furniture, and the loose
   * props that move. Handed over by game.js before `spawn`, and held for one
   * question only — is the thing somebody is sitting on still there.
   *
   * Both are the SAME arrays the player collides against rather than copies, so
   * they stay live: a prop that is shot apart retires its own entry by setting
   * `top = -1` (`_breakProp` in destruction.js, and the same for a static in
   * `_shatter`), and a loose prop that is shoved moves its own bounds. Those are
   * exactly the two things a seated body needs to notice, and neither of them is
   * an event anybody sends.
   */
  showOut(e) {
    if (!e || e.gone) return;
    e.gone = true;
    e.group.visible = false;
    for (const m of e.hitboxes) m.userData.enemy = null;
    // Off the map for the reason a rat is: it answers "is there somebody in that
    // room", and he is not somebody any more.
    e.offMap = true;
    if (e.carry) this.takeCrate(e);
  }

  /**
   * The generator room's crew (see the `generator` role in gen/rooms.js) —
   * opportunistic, like the room itself: a floor that didn't roll a room big
   * enough for one has nothing to place here. A handful of them, spaced the same
   * way the security office spaces its guards: 2-3 hostile technicians and 3-5
   * workers doing nothing about you — same shape as the neutral bystanders
   * elsewhere, just local to this one room instead of wandering the floor. Both
   * types are `weight: 0` (see enemy-types.js): the mix belongs here and nowhere
   * else, so a weighted roll must never produce it.
   *
   * It is a CREW and not a crowd, and the numbers are small deliberately. A dozen
   * bodies in here made the plant room the biggest fight on the floor, which is a
   * second security office by accident — the room is meant to be about the machine
   * at the end of it, and about whether you are willing to shoot the thing that
   * keeps the lights on. Five to eight people is a shift working late; fifteen is
   * an ambush that happens to have a generator in it.
   */
  _add(x, z, rng, tuning, type) {
    // The body is rigs.js's business; everything below is behaviour.
    const rig = buildRig(type, rng);
    const { group, mats, ownGeo, torso, head, armL, armR, legL, legR, gun, blunt } = rig;
    group.position.set(x, 0, z);

    const enemy = {
      group, mats, ownGeo, torso, head, armL, armR, legL, legR, gun,
      // The spare shins the seated pose bends a knee with, on the human rig only
      // (see rigs.js). Undefined everywhere else, and `sitLegs` and `stand` both
      // test for them — a machine keeps its straight-legged sit.
      shinL: rig.shinL ?? null, shinR: rig.shinR ?? null,
      blunt, bluntReach: rig.bluntReach, bluntRest: rig.bluntRest ?? 0.5,
      // Rat parts. Null on everything else, and the animation branches on the
      // rig rather than on the type, so a second four-legged thing costs a rig
      // and nothing else.
      rig: rig.rig, legs: rig.legs ?? null, tail: rig.tail ?? null,
      brush: rig.brush ?? null, motor: null,
      // Machine parts. What it gets about on, where its hand is, and the two
      // things on a chassis that never stop moving — all of it read off the rig
      // rather than assumed, which is what lets a body on wheels go through
      // every line below without one of them knowing. See CHASSIS in rigs.js.
      drive: rig.drive ?? 'legs',
      gunRest: rig.gunRest ?? null, gunAim: rig.gunAim ?? null,
      // Where this rig's shoulders and hips are. The two poses struck on every
      // body in the building — a chore and `stand` — solve their angles against
      // it, so a machine works a copier with its own arms. Copied here like
      // everything else off the rig: the enemy is built field by field rather
      // than spread, so a rig can grow a property and nothing downstream ever
      // sees it, which is exactly what happened the first time this was added.
      joints: rig.joints ?? null,
      rotors: rig.rotors ?? null, beaconMat: rig.beaconMat ?? null,
      // Where this body carries a box and whether its arms come up to hold it.
      // Same argument as the two above: a porter carries one on a deck.
      boxAt: rig.boxAt ?? null, boxArms: rig.boxArms !== false,
      // The sack truck, and the node on it a box rides. Both null on everybody
      // but the one type that brings one — see `truckOf` in rigs.js.
      truck: rig.truck ?? null, load: rig.load ?? null,
      // The crate, if this one is on a parcel run, and whether they are up to
      // the elbows in a machine. See jobs.js.
      carry: null, job: null, jobRole: null, working: false,
      // ...and the errand a body is on when it is doing the building's ordinary
      // work rather than carrying a box across it: standing at a printer, a
      // server rack, a bench. Unlike a parcel run this is walked by a HOSTILE as
      // often as by a neutral, and it is abandoned the moment they notice you.
      // See chores.js.
      chore: null,
      type,
      // Position in `items`, which is this body's name on the wire. It is stable
      // because the roster is generated from the floor's seed and appended to in
      // one order, so index 57 is the same person in both browsers.
      index: this.items.length,
      // Where the last snapshot said this body was, on a joiner. Seeded to the
      // spawn so the first frame does not lerp in from the origin.
      netX: x, netZ: z, netY: 0, netYaw: 0,
      // Whether this body can see its target, left here by `_pick` because
      // working it out is the expensive half of choosing one.
      sees: false,
      // Flat, because the minimap reads it every frame alongside `alive` and has
      // no business knowing what a type is.
      neutral: !!type.neutral,
      // The minimap answers "is there somebody in that room". A rat is not
      // somebody, so it is not on it.
      offMap: !!type.offMap,
      flee: 0,
      x, z,
      yaw: group.rotation.y,
      health: tuning.health * type.hp,
      alive: true,
      state: 'idle',
      timer: rng.range(0, 1),
      fireCooldown: rng.range(0.4, 1.6),
      // Seconds of you held in their sights. Gates the FIRST round only — it goes
      // on accumulating past the threshold, so a fight already in progress fires
      // on its ordinary cadence. See AIM_CONE.
      aim: 0,
      contact: 0,          // seconds since last seen the player
      lastSeen: null,
      walkPhase: rng.range(0, 6),
      hitFlash: 0,
      deathTime: 0,
      swing: 0,
      swingLanded: true,
      dist: Infinity,
      strafe: rng.chance(0.5) ? 1 : -1,
      // Which nav layer this body is on, and how high that puts it. Everybody
      // spawns on the ground floor; a layer is something you walk onto, up a
      // staircase. See the note at the top of nav.js.
      layer: 0,
      y: 0,
      voiceTimer: rng.range(1, 14),   // staggered, or a floor mutters in chorus
      lastStep: 0,
      // The keycard on their belt, if any. Dealt after the whole floor is
      // placed — see _dealCards.
      card: null,
      // Vermin only: bolt, stop, bolt again.
      darting: true, dartTimer: rng.range(0.2, 1), moving: true,
      // Where a neutral is currently headed — the toilet, the next corridor to
      // mop — plus their own distance field to get there. See _repick.
      wanderX: 0, wanderZ: 0, wanderTimer: 0, field: null, stuck: 0,
      // How this body comes apart when it stops working (rigs.js), and whether
      // something took that offer up. `ragdoll` is what stands the toppling
      // animation down — see _die.
      bones: rig.bones ?? null,
      ragdoll: false,
      // Set on the people who work behind a real lock — the manager, and the two
      // janitors on their break. It keeps them out of openHostileCount and out
      // of the card deal.
      behindLock: false,
      // Carrying a badge that opens doors: the security response to an alarm,
      // and nobody else on the floor. See `alarm`.
      keyed: false,
      // 'desk' for the two bodies on the floor allowed to sit in a chair — the
      // Manager at his own, one guard on the cameras — and null for everybody
      // else, which is standing up. See animateWorking in enemy-anim.js.
      seat: null,
      // ...and the two props that pose is drawn relative to, so a body can tell
      // when it is sitting on nothing. See _seatGone.
      chair: null,
      table: null,
      // Somebody's lunch: which beat of the cycle they are on, and the tray in
      // their hands while they are on it. Both null for the whole building most
      // of the time — see the block above _sendToLunch.
      break: null,
      tray: null,
      // The can somebody bought, the arm it is parented to, and how long they
      // keep it. See `giveCan` — it outlives the chore that handed it over, so
      // the clock is on the BODY rather than on the job.
      can: null, canArm: null, canTimer: 0,
      // ...and the paperwork a routine is carrying, which has no clock: the
      // errand that made it is what takes it back. See `givePapers`.
      papers: null, papersArm: null,
      // One break a floor, and this is what says so. Without it a body that has
      // just walked out of the canteen is `idle` again and eligible again, and
      // the same man queues twice while nobody else goes at all.
      lunchDone: false,
      // The materials a hit whitens: whatever this one is actually wearing.
      flash: rig.flash ?? [],
    };

    if (type.neutral) {
      enemy.state = 'wander';
      enemy.voiceTimer = type.panic ? rng.range(0.2, 2.5) : rng.range(3, 14);
    }

    // Where a bullet can land, and what it is worth there.
    //
    // Limbs used to stop nothing at all, on the grounds that the box on an arm
    // is 14 cm across and catching one instead of the chest is luck rather than
    // aim. That is true, and it is an argument for a limb hit being CHEAP, not
    // for it being nothing: a round that goes through somebody's forearm and
    // does not scratch them is the more obvious lie, and it is the one the
    // player sees, because the tracer ends on the wall behind a man who did not
    // react. So all six boxes stop a round now and the arithmetic carries the
    // meaning instead.
    enemy.hitboxes = [];
    for (const [mesh, scale] of [
      [head, HIT_ZONES.head], [torso, HIT_ZONES.torso],
      [armL, HIT_ZONES.limb], [armR, HIT_ZONES.limb],
      [legL, HIT_ZONES.limb], [legR, HIT_ZONES.limb],
    ]) {
      if (!mesh) continue;              // a rat has a body and a head and that is all
      mesh.userData.enemy = enemy;
      mesh.userData.hitScale = scale;
      mesh.userData.isEnemyPart = true;
      enemy.hitboxes.push(mesh);
      this.meshes.push(mesh);
    }

    this.scene.add(group);
    this.items.push(enemy);
    return enemy;
  }

  /**
   * A bullet landed. Returns 'kill' | 'hit' | null (already down).
   *
   * `dir`, `point` and `punch` are the shot itself, and they are carried this
   * far for one reason: if this is the killing hit, the ragdoll needs to be
   * thrown the way the bullet was going, from the part it went into, as hard as
   * the gun that fired it. A body that folds straight down whatever hit it is a
   * body that died of natural causes.
   */
  hit(mesh, damage, dir = null, point = null, punch = 1) {
    const e = mesh.userData?.enemy;
    if (!e || !e.alive) return null;
    const dealt = damage * (mesh.userData.hitScale ?? 1);
    const shot = dir ? { dir, point, mesh, punch } : null;

    // Not our call. The shot is real and the feedback is immediate — the flash,
    // the flesh impact, a hitmarker — but the health is the host's, and the kill
    // comes back as a message. Predicting the death here instead would show the
    // joiner bodies dropping that the host has not agreed are dead, and then
    // standing back up.
    if (!this.authority) {
      this.onReport?.(e, dealt, shot);
      e.hitFlash = HIT_FLASH;
      return 'hit';
    }

    return this._damage(e, dealt, shot);
  }

  // Damage from any source, once it is known who took it and how much.
  _damage(e, damage, hit = null) {
    if (!e.alive) return null;
    e.health -= damage;
    e.hitFlash = HIT_FLASH;
    // Lunch is over. This is what keeps the visor honest: a body on its break is
    // out of the state machine entirely, and the frame that stops being true is
    // the frame its eyes stop saying it. Everything below then treats them as
    // whatever they actually are — a neutral runs, an employee gets up and
    // fights — and neither branch has to know there was ever a tray.
    if (e.break) this._lunchEnd(e);
    // Being shot at is a reliable way to get someone's attention.
    // The parcel run is off, for the reason the break is: whatever this body was
    // doing, it is not doing it now. It goes before the branch below because it
    // applies to a hostile on a run as much as to a neutral on one — and a run
    // must not be left half-finished with a crate parented to somebody who has
    // started running away, which is what the box hanging in the air would look
    // like.
    if (e.job) this.jobLost?.(e);
    // ...and the ordinary job, for exactly the same reason and in the same
    // breath: nobody carries on typing while they are being shot at.
    if (e.chore) this.choreLost?.(e);
    if (e.neutral) {
      // They have nothing to fight you with and never did. Zeroing the timer
      // makes the next tick pick a destination away from you instead of
      // finishing the walk they were already on.
      e.flee = FLEE_TIME;
      e.wanderTimer = 0;
    } else if (e.state === 'idle') {
      e.state = 'alert';
      e.timer = 0.15;
    }

    if (e.health > 0) {
      this.onDamaged?.(e, 'hit', hit);
      return 'hit';
    }
    this._die(e, hit);
    this.onDamaged?.(e, 'kill', hit);
    return 'kill';
  }

  /**
   * Everything that happens once somebody is out of health.
   *
   * Split from `_damage` because in a co-op session the joiner never takes the
   * arithmetic path at all: it is told that index 57 is dead and has to do
   * exactly this to it — the same corpse, the same ragdoll, the same card on the
   * carpet. Two copies of this would be two different deaths.
   */
  _die(e, hit = null) {
    e.alive = false;
    e.deathTime = DEATH_TIME;
    // A chair nobody is ever going to sit in, and a tray that would otherwise
    // ride a ragdoll down: `_lunchEnd` hands both back. The visor it restores is
    // overwritten a few lines below for anything that ragdolls, which is right —
    // dead is a louder thing to say than off duty.
    if (e.break) this._lunchEnd(e);
    // ...and a crate that would otherwise ride a ragdoll down. `jobLost` is what
    // releases the other two bodies on the run as well, which matters more than
    // the box: a porter waiting for a handoff from somebody who is dead waits
    // out the whole stage cap.
    if (e.job) this.jobLost?.(e);
    // The knee, which is the one part of a seated pose the ragdoll cannot inherit:
    // a bone lists `legL` alone, so the shins are left standing on the group
    // exactly where the chair was while the rest of the body falls out of it.
    // Hidden here rather than in `stand` because `stand` is deliberately skipped
    // for a body that is already dead — a ragdoll should start from the pose you
    // were looking at, and these two boxes are the only part of it that lies.
    if (e.shinL) e.shinL.visible = false;
    if (e.shinR) e.shinR.visible = false;
    if (e.legL) e.legL.scale.y = 1;
    if (e.legR) e.legR.scale.y = 1;

    // ...and the drink, for exactly the tray's reason: it is parented to an ARM,
    // and an arm is about to become a ragdoll bone. A can riding a corpse across
    // the carpet is funnier than it is right, and nothing would ever clear it —
    // `canTimer` is only ticked for a body that is still alive. Deliberately not
    // done in `_damage`: somebody who is merely being shot at runs away with
    // their drink, which is the truth about people.
    if (e.can) this.takeCan(e);
    if (e.papers) this.takePapers(e);
    // The pose as much as the station: `choreLost` goes through `setWorking`,
    // which is the only thing that puts a hinged limb back, and a corpse that
    // ragdolls out of a working pose does it with its arms already above its
    // head. See chores.js.
    if (e.chore) this.choreLost?.(e);
    // Nobody is walking anywhere now. Half a megabyte a corpse, on a floor that
    // ends with two hundred of them.
    this.dropField(e);
    // A dead machine stops making machine noise. Nothing else clears this, and
    // the loop would otherwise run on out of a wreck for the rest of the floor.
    if (e.motor) { this.audio?.stopMotor(e.motor); e.motor = null; }
    // Every box this one was stopping rounds with goes quiet at once. They stay
    // in the raycast list — shooting.js walks past anything flagged as a body
    // part with nobody behind it — so the next round goes through the corpse
    // rather than being spent on it.
    for (const m of e.hitboxes) m.userData.enemy = null;
    // Hand the body to the solver. It can refuse — no physics, no skeleton, or
    // simply too many already falling — and refusing costs nothing, because the
    // animation below is still sitting there.
    e.ragdoll = !!this.ragdolls?.spawn(e, hit);
    // The visor going dark is the one bit of the death animation that survives
    // being ragdolled, because it is what says "this one is done" from across a
    // room. Everything else is now the solver's.
    if (e.ragdoll) e.mats.visor.color.setRGB(0.25, 0.05, 0.04);
    // Whatever they were carrying is now on the carpet. What that means — a
    // keycard, the black card off the last one standing — is game.js's, because
    // it is about the floor and this file is about the person.
    this.onDeath?.(e);
  }

  /**
   * The host says index `i` is dead. Joiner side only.
   *
   * `hit` is synthesised from what the wire carried rather than being the real
   * shot, because what it is for is throwing the ragdoll — and a body thrown the
   * wrong way is a worse lie than one thrown approximately the right way.
   */
  splash(x, z, radius, damage, audio) {
    // On a joiner an explosion damages nobody, and it deliberately is not
    // reported either — unlike a bullet, which is.
    //
    // The difference is where an explosion comes from. Every one of them is a
    // volatile prop coming apart (`launch` in extinguishers.js) or the generator
    // going up, and BOTH of those are shatters that already cross the wire — so
    // the host is running its own copy of the same cylinder, on the same
    // trajectory, and its blast is what the staff are hurt by. Reporting this one
    // as well would apply the same explosion twice, once per browser. The blast,
    // the gas, the debris and the noise are all still here; only the arithmetic
    // is the host's.
    if (!this.authority) return 0;

    let kills = 0;
    for (const e of this.items) {
      if (!e.alive) continue;
      const dist = Math.hypot(e.x - x, e.z - z);
      if (dist > radius) continue;

      // Thrown outward from the seat of it, and upward — a body that only slides
      // away from an explosion looks like it was pushed. Straight up for anyone
      // standing exactly on it, since there is no outward to speak of.
      const k = 1 / (dist || 1);
      const blast = {
        dir: dist > 0.05
          ? { x: (e.x - x) * k, y: 0.55, z: (e.z - z) * k }
          : { x: 0, y: 1, z: 0 },
        point: { x: e.x, y: 0.9, z: e.z },
        // An explosion is the heaviest thing that happens to anybody on this
        // floor, and it falls off the same way its damage does — everything
        // near the seat of it leaves the ground, and the ones at the rim are
        // knocked over. See _throw in ragdolls.js.
        punch: BLAST_PUNCH * (1 - dist / radius),
      };

      const outcome = this._damage(e, damage * (1 - dist / radius), blast);
      if (outcome === 'kill') { kills++; audio?.enemyDeath(e); }
      else if (outcome === 'hit') audio?.enemyPain(e);
    }
    return kills;
  }

  /**
   * One frame of the whole roster.
   *
   * `ctx.targets` is who the staff are working against: one object per player,
   * `{ x, y, z, layer, dead, hurt(amount, sx, sz) }`. Single player hands over a
   * list of one and nothing below notices; co-op hands over two, and everything
   * that used to be "the player" becomes "whichever of them this body is dealing
   * with" — see `_pick`.
   *
   * In a co-op session only the HOST runs any of this. The joiner's roster is the
   * same roster, generated from the same seed, and it is posed from the host's
   * snapshots instead — see `puppet` and `applySnapshot`. That is what makes two
   * players fight the same staff rather than two private copies of them.
   */
  update(dt, ctx) {
    const { targets, effects, audio } = ctx;
    // Held so the paths that are not the update loop can reach it — a machine
    // shot dead has to stop running, and the bullet arrives from shooting.js.
    this.audio = audio;

    // Which layer of the nav grid each player is standing on. The grid has two —
    // the ground floor, and every attic and basement — joined at the stairwells,
    // so the field is flooded from wherever they actually are and the route to
    // them goes up or down the stairs like any other route. See the note at the
    // top of nav.js. Off the ground floor it is the level's own layer; a metre up
    // a flight it is still whichever layer the field last had them on, and the
    // height comes from the ramp either way.
    for (const t of targets) t.layer = Math.abs(t.y - EYE) > STOREY_GAP ? 1 : 0;
    // A corpse is not chased. If everybody is down there is nothing to flood
    // from, and the bodies below simply lose contact and stand down.
    //
    // ...and neither is somebody who is not there. `hidden` is the T toggle (see
    // `hidden` in player.js) and it rides in on the same filter as `dead`
    // deliberately: "there is nobody to chase" is a case this file already
    // handles properly and has a whole branch for, so being unseen is not a new
    // state for the roster to know about, it is an existing one reached another
    // way. Every consequence falls out of it at once — the field is not flooded
    // from you, so nobody hears a shot; `_pick` finds nothing, so nobody sights,
    // aims or fires; and anybody mid-chase runs out `contact` and stands down.
    const live = targets.filter((t) => !t.dead && !t.hidden);
    this.playerLayer = live[0]?.layer ?? 0;

    // Bodies move during the loop below, so this is a snapshot taken at the top
    // of the frame rather than an index kept live — which is what the old
    // whole-roster scan effectively was too. It also counts the badge holders,
    // which is why it comes before the flood that depends on there being any.
    if (!this.puppet) this._rebuildNeighbours();

    // Flooded on BOTH ends of a co-op session, above the puppet check, even
    // though a posed roster does no routing with it. `soundPath` in nav.js reads
    // the same field to bend a noise round a doorway instead of through the
    // plaster, and with it never flooded it gives up and every gunshot on the
    // floor arrives through the walls. The badge field is genuinely host-only:
    // nothing but a route wants it.
    if (this.nav && live.length) {
      this.nav.updateField(dt, live, !this.puppet && this.keyedAlive > 0);
    }

    if (this.puppet) { this._poseAll(dt, audio); return; }

    // Whose turn it is at the counter. Host side only, with everything else that
    // decides what the roster does — a joiner is posed from snapshots and a
    // break arrives on the wire like every other state (see `snapshot`).
    this.lunchTimer -= dt;
    if (this.lunchTimer <= 0) {
      this.lunchTimer = LUNCH_GAP[0] + Math.random() * (LUNCH_GAP[1] - LUNCH_GAP[0]);
      this._sendToLunch();
    }
    if (this.shoutTimer > 0) this.shoutTimer -= dt;

    for (const e of this.items) {
      if (!e.alive) { die(e, dt); continue; }
      // Somebody who has left the building. Skipped whole rather than made a
      // corpse — see `showOut`. Without this he keeps his wander loop and walks
      // the floor invisibly for the rest of it, which is the sort of thing that
      // costs nothing and shows up two features later as a body opening doors.
      if (e.gone) continue;
      // Whatever they were sitting on can be shot apart or shoved out from under
      // them, and until this was here neither stood anybody up. See _seatGone.
      if (e.seat) this._seatGone(e);
      // ...and the drink they bought, which is finished with eventually. Here
      // rather than in chores.js because a can outlives the trip to the machine
      // that produced it: they buy it, and then they walk off with it.
      if (e.can) {
        e.canTimer -= dt;
        if (e.canTimer <= 0) this.takeCan(e);
      }

      // Who this one is dealing with. Everything that follows is measured against
      // them, and a body with nobody left to deal with simply loses contact and
      // stands down where it is.
      const target = this._pick(e, live);
      if (!target) {
        e.contact += dt;
        if (e.break) { this._lunch(e, dt, audio); animate(e, dt, audio); continue; }
        // On a parcel run, which is walked by jobs.js instead of by `_wander` —
        // and it is checked BEFORE `neutral` rather than inside it because the
        // run owns the body's whole movement for its duration. `animate` still
        // runs here and nowhere else, so a body gets exactly one pose a frame
        // however it is being driven.
        if (e.job) { this.jobTick?.(e, dt, audio); animate(e, dt, audio); continue; }
        // Working at a machine, with nobody on the floor to interrupt them. The
        // hostile path below still runs its `_think` — there is nothing for it
        // to notice — but `_move` is skipped, because the chore owns where this
        // body is going for as long as it lasts.
        if (e.chore) {
          // Nobody to notice, so no startle test to make: `_choreWork`'s two
          // arguments for it are both false by construction here.
          this.choreTick?.(e, dt, audio);
          animate(e, dt, audio);
          if (!e.neutral) this._mutter(e, dt, audio);
          continue;
        }
        if (e.neutral) { this._wander(e, dt, audio); animate(e, dt, audio); continue; }
        this._think(e, dt, Infinity, false, false, null);
        this._move(e, dt, 0, 0, 1, false);
        animate(e, dt, audio);
        this._mutter(e, dt, audio);
        continue;
      }

      const dx = target.x - e.x;
      const dz = target.z - e.z;
      const dist = Math.hypot(dx, dz) || 0.001;
      const sees = e.sees;
      // Hearing only matters when they cannot see you — if they can, sight has
      // already told them everything, and at a longer range. The distance is the
      // walked one: the field is flooded from the players (or from the foot of
      // their stairs, if they are off the ground floor), so it is already paid
      // for, and a negative value means there is no route at all. With two
      // players it is the walk to the NEARER of them, because the flood has both
      // of them in it at zero.
      const along = this.nav.pathDistance(e.x, e.z, e.layer);
      const hears = !sees && ctx.noise > 0 && along >= 0 && along < HEARING;

      if (sees) {
        e.contact = 0;
        e.lastSeen = { x: target.x, z: target.z };
      } else if (hears) {
        // Not a sighting, so they still do not know exactly where you are — but
        // it counts as contact, which is what keeps them walking your way
        // instead of losing interest halfway down the corridor.
        e.contact = Math.min(e.contact, HEARD_MEMORY);
        e.lastSeen = { x: target.x, z: target.z };
      } else {
        e.contact += dt;
      }

      // Neutrals are not in the state machine at all: no alert, no chase, no
      // weapon. Seeing you and hearing you change nothing — the only thing that
      // does is being shot, and that makes them run rather than fight.
      if (e.neutral || e.break) {
        // Where this one is running away FROM. `_repick` needs it and is called
        // from places with no target to hand, so it is set per body rather than
        // once per frame: with two players on the floor, "away" has to be away
        // from the one who actually shot at them.
        this.playerX = target.x;
        this.playerZ = target.z;
        // Somebody on their break is out of the state machine exactly as far as
        // a neutral is, whatever their type says — no alert, no chase, no
        // weapon. Seeing you and hearing you change nothing; being shot ends the
        // break, and `_damage` is where that happens.
        if (e.break) this._lunch(e, dt, audio);
        else if (e.job) this.jobTick?.(e, dt, audio);
        // A neutral at work is not startled by you standing next to it — that
        // is the whole of what neutral means here, and it is what makes a
        // maintenance man on a wall panel something you can walk up to and
        // watch. Being shot is the one thing that stops them, and `_damage` is
        // where that happens.
        else if (e.chore) this.choreTick?.(e, dt, audio);
        else this._wander(e, dt, audio);
        animate(e, dt, audio);
        continue;
      }

      // Somebody at work, and still at it: chores.js owns where this body goes
      // and none of the state machine runs. `_choreWork` is what decides, and it
      // is checked BEFORE `_think` rather than after because `_think` cannot be
      // what notices you here — it only ever promotes out of `idle`, and a body
      // still walking to its machine is in `wander`, which that switch has no
      // case for at all. When it hands the body back it has already dropped the
      // job and pointed them at you, and the rest of this frame is ordinary.
      if (e.chore && this._choreWork(e, dt, dist, sees, hears, target, audio)) {
        animate(e, dt, audio);
        this._mutter(e, dt, audio);
        continue;
      }

      this._think(e, dt, dist, sees, hears, target);
      this._move(e, dt, dx, dz, dist, sees);
      this._shoot(e, dt, dist, sees, target, effects, audio);
      animate(e, dt, audio);
      this._mutter(e, dt, audio);
    }
  }

  /**
   * Which player this body is dealing with this frame, leaving whether it can
   * see them on `e.sees` — because working that out is the expensive half and
   * the caller needs both answers.
   *
   * Sight beats distance: somebody who can see you at twenty metres is fighting
   * you, not the man eight metres away behind a wall. Between two it can both
   * see, or two it can see neither of, the nearer takes it.
   *
   * Sight is per layer, and across layers there is a floor slab in the way — the
   * one exception being two bodies in the same stairwell, who are looking
   * straight at each other up a flight of stairs. losClear knows; this used to be
   * a flat "nobody sees you off the ground floor", which was right about the slab
   * and wrong about the staircase.
   */
  _pick(e, live) {
    let best = null;
    let bestDist = Infinity;
    let bestSees = false;

    for (const t of live) {
      const d = Math.hypot(t.x - e.x, t.z - e.z) || 0.001;
      const sees = d < SIGHT && this.nav.losClear(e.x, e.z, t.x, t.z, e.layer, t.layer);
      if (best) {
        if (bestSees && !sees) continue;
        if (sees === bestSees && d >= bestDist) continue;
      }
      best = t; bestDist = d; bestSees = sees;
    }

    e.sees = bestSees;
    return best;
  }

  // Walks somewhere, says something about it, walks somewhere else. Deliberately
  // not pathfinding to anything real: he does not know where the bathroom is
  // either, and the cleaner is not working a route.
  //
  // Shoot one and `flee` runs for a few seconds: same loop, quicker, and only
  // picking destinations that put distance between the two of you. When it
  // expires they go back to the day they were having.
  _wander(e, dt, audio) {
    if (e.flee > 0) e.flee -= dt;

    // The toilet guy shouts constantly because that is the whole character.
    // Everyone else is quiet until you shoot them, and then they are not.
    const shouting = e.type.panic || e.flee > 0;
    e.voiceTimer -= dt;
    if (e.voiceTimer <= 0) {
      if (shouting) {
        e.voiceTimer = PANIC_SHOUT[0] + Math.random() * (PANIC_SHOUT[1] - PANIC_SHOUT[0]);
        // The type names what it screams. A cleaner running from a firefight has
        // nothing to say about the toilet, and the rat has nothing to say at all.
        audio.enemyScream(e, e.type.screams ?? 'flee');
      } else {
        e.voiceTimer = 7 + Math.random() * 11;
        audio.enemyIdle(e);
      }
    }

    // Somebody at their lunch is the one body on the floor that is already
    // where it wants to be, so the wander loop does not walk them anywhere.
    //
    // Holding `idle` is what keeps them in the chair: a seated body is stood up
    // by the animator the moment its state is anything else (see `animate` in
    // enemy-anim.js), and every neutral is spawned into `wander`, so without
    // this the whole canteen was on its feet by the first frame — five people
    // placed at five chairs and not one of them still in it.
    //
    // Being shot at is what changes their mind, and `flee` is the one flag that
    // says so. Standing up is the whole of the transition: from the next frame
    // they are an ordinary neutral on the ordinary loop, running for a door.
    if (e.seat) {
      if (e.flee <= 0) { e.state = 'idle'; return; }
      // Out of the chair — but the ANIMATOR is what stands a body up, and this
      // must not do it itself. `stand` in enemy-anim.js puts the hips and
      // shoulders back where rigs.js left them, and nothing else in that file
      // ever moves a limb: the walk cycle writes rotations only. Clearing the
      // seat here instead left a body carrying its seated joints around the
      // floor for the rest of the run, hips and shoulders still dropped into
      // the chair — which is exactly what it looks like, a man walking like an
      // alien. So all this does is stop holding `idle`; the frame ends with
      // `animate` seeing a seated body in `wander`, and it clears the seat and
      // stands them up the one way that works.
      e.state = 'wander';
      this._repick(e);
      return;
    }

    e.wanderTimer -= dt;
    const togo = Math.hypot(e.wanderX - e.x, e.wanderZ - e.z);

    if (e.wanderTimer <= 0 || togo < 0.8) {
      this._repick(e);
      return;
    }

    // Vermin do not walk anywhere. They bolt, stop dead, think about it, and
    // bolt again — and the stopping is what makes the bolting read as fast.
    if (e.type.darts) {
      e.dartTimer -= dt;
      if (e.dartTimer <= 0) {
        e.darting = !e.darting;
        e.dartTimer = e.darting ? 0.35 + Math.random() * 0.8 : 0.25 + Math.random() * 0.9;
      }
      // Frozen mid-scurry, not stuck: the stall counter has to be told, or the
      // pause gets mistaken for wedged furniture and it repicks every time.
      if (!e.darting) {
        e.stuck = 0;
        e.moving = false;
        return;
      }
    }

    const speed = this.tuning.speed * e.type.speed * (e.flee > 0 ? FLEE_SPEED : 1);
    if (this._stroll(e, dt, speed) !== 'moved') this._repick(e);
  }

  /**
   * One frame of walking downhill on this body's OWN field, not straight at
   * whatever it is heading for: the whole point of giving somebody a field is
   * that they go round the wall instead of into it.
   *
   * Returns what happened, because the two callers recover differently — a
   * neutral makes a whole new plan and somebody on their lunch re-floods to the
   * same counter, and neither wants the other's answer.
   *
   *   'moved'   made ground, or is sidestepping something and still might
   *   'stuck'   wedged for long enough that the plan is the problem
   *   'noroute' not on the field at all
   */
  _stroll(e, dt, speed) {
    const dir = this.nav.descendOn(e.field, e.x, e.z, this._v);
    if (!dir) return 'noroute';

    const movedX = this._tryMove(e, dir.x * speed * dt, 0);
    const movedZ = this._tryMove(e, 0, dir.z * speed * dt);
    // Wedged against something the grid thinks is passable. Sidestep first —
    // it is usually a doorway they are half a metre to the side of — and only
    // hand the problem back if that gets nowhere either.
    if (!movedX && !movedZ) {
      e.stuck += dt;
      const step = speed * dt;
      if (!this._tryMove(e, -dir.z * e.strafe * step, dir.x * e.strafe * step)) {
        e.strafe *= -1;
      }
    } else {
      e.stuck = 0;
    }

    e.moving = true;
    e.group.position.x = e.x;
    e.group.position.z = e.z;
    // On a staircase this is the ramp, on a level it is that level's floor, and on
    // the ground floor it is zero — one lookup rather than a special case per state.
    e.y = this.nav.heightAt(e.x, e.z, e.layer);
    e.group.position.y = e.y;
    e.yaw = angleLerp(e.yaw, Math.atan2(-dir.x, -dir.z), smoothTo(9, dt));
    e.group.rotation.y = e.yaw;
    return e.stuck > 0.6 ? 'stuck' : 'moved';
  }

  // Somewhere else, and a route to it. Sampled rather than searched: a handful
  // of tries is enough to find open floor, and failing simply means standing
  // still for a moment, which is entirely in character. Corridors are the
  // preferred destination: that is where they can actually run, and where you
  // get to watch them do it.
  //
  // While fleeing the pick also has to gain ground on the player — but only for
  // the first ten attempts, because a neutral cornered in a dead end with
  // nowhere further to go still needs to end up somewhere rather than freeze.
  _repick(e) {
    e.wanderTimer = PANIC_PATIENCE * (0.6 + Math.random() * 0.8);
    e.stuck = 0;
    e.field ??= this.nav.makeField();

    const spots = this.corridors;
    const fromPlayer = e.flee > 0
      ? Math.hypot(this.playerX - e.x, this.playerZ - e.z)
      : 0;

    for (let attempt = 0; attempt < 12; attempt++) {
      let x, z;
      if (spots?.length && attempt < 8) {
        const s = spots[(Math.random() * spots.length) | 0];
        x = s.x; z = s.z;
      } else {
        const angle = Math.random() * Math.PI * 2;
        const reach = 4 + Math.random() * 12;
        x = e.x + Math.cos(angle) * reach;
        z = e.z + Math.sin(angle) * reach;
      }

      const away = Math.hypot(x - e.x, z - e.z);
      if (away < 4 || away > PANIC_HOP) continue;
      if (!this.nav.clear(x, z, RADIUS)) continue;
      if (e.flee > 0 && attempt < 10 &&
          Math.hypot(this.playerX - x, this.playerZ - z) < fromPlayer + FLEE_AWAY) continue;

      // Flooded from the destination, so descending it walks him there. If he is
      // not on the resulting field there is no route and the pick is wasted.
      if (!this.nav.floodTo(e.field, x, z)) continue;
      if (!this.nav.descendOn(e.field, e.x, e.z, this._v)) continue;

      e.wanderX = x;
      e.wanderZ = z;
      return;
    }

    // Nowhere to go this time; stand and shout, and try again shortly.
    e.wanderX = e.x;
    e.wanderZ = e.z;
    e.wanderTimer = 0.6;
  }

  // --- lunch ------------------------------------------------------------------
  //
  // The canteen is the one room on the floor with a JOB that is not fighting
  // you, and until now the people in it did that job for ever: placed in a chair
  // at floor generation and still in it when the floor ended. A break that never
  // ends is a tableau rather than a shift.
  //
  // So there is a cycle, and both halves of the canteen run the same one: walk
  // in, queue at the counter, take a tray, find a seat, eat, take the tray back,
  // and leave. The staff the floor opens on start half way through it — already
  // seated, already eating — because that is the picture the arrival is for.
  //
  // What makes it more than scenery is who else can join. **An ordinary employee
  // takes a break**: they down tools, their visor goes to the canteen blue, they
  // walk the whole cycle, and their own colour comes back as they walk out. The
  // visor is the game's one universal tell (see the note above TYPES), and this
  // is the first thing in the building that changes it at runtime — so the rule
  // it states has to stay exactly true in both directions:
  //
  //   BLUE EYES ARE NOT FIGHTING YOU. A body on its break is out of the state
  //   machine entirely: no alert, no chase, no weapon in its hands, exactly like
  //   a neutral. Walking past one costs nothing, which is the whole promise the
  //   chair has always made.
  //
  //   ...AND THE TELL IS LIVE. Any damage ends the break on the spot (see
  //   `_damage`), so the frame a body stops being harmless is the frame its eyes
  //   stop saying it is. Shoot into a canteen and you are in a fight with
  //   whoever was in it; leave them alone and you are not.
  //
  // Two things it deliberately does NOT change. A body on break still counts
  // toward clearing the floor, because `hostileCount` reads `e.neutral`, which
  // is a fact about the TYPE and is never touched here — a count that moved
  // would make "floor cleared" fire and un-fire, and the black card is timed off
  // it. And the minimap still shows them as what they are, because the two
  // markers answer different questions: the map says whether you have to shoot
  // this eventually, and the visor says whether it is about to shoot you.
  //
  // Machines do not eat. `type.chassis` is the whole of that test.

  /** How many employees have downed tools right now — the arrival diners are not
   * counted, because they are not away from a post. */
  giveCrate(e) { give(e, 'crate', 0); }

  takeCrate(e) { take(e, 'crate'); }

  giveCan(e, key = 0) { give(e, 'can', key); }

  takeCan(e) { take(e, 'can'); }

  givePapers(e, key = 0) { give(e, 'papers', key); }

  takePapers(e) { take(e, 'papers'); }

  _giveTray(e) { give(e, 'tray', 0); }

  _takeTray(e) { take(e, 'tray'); }

  /**
   * Up to the elbows in something overhead, or not — the pose `animateFixing`
   * draws (see enemy-anim.js).
   *
   * Public because jobs.js is what decides it, and it is ONE call rather than a
   * flag anybody may set because of the rule the chair paid for: nothing but
   * `stand` puts a hinged limb back, so clearing the flag and restoring the pose
   * have to be the same operation or the body walks off the rest of the floor
   * with its arms above its head. `_standUp` makes the identical bargain for
   * `e.seat` a few lines up.
   */
  // Idle staff grumble to themselves now and then, which is what tells you a
  // room is occupied before you can see into it.
  _mutter(e, dt, audio) {
    e.voiceTimer -= dt;
    if (e.voiceTimer > 0) return;
    e.voiceTimer = 7 + Math.random() * 11;
    if (e.state === 'idle') audio.enemyIdle(e);
  }

  /**
   * One frame of somebody doing the building's ordinary work, and whether they
   * are still doing it.
   *
   * This is the whole of what a hostile at a machine promises, and the promise
   * is deliberately narrow: a chair in this building means harmless (see the
   * note on workstations in CLAUDE.md), and nothing here sits anybody down. A
   * body STANDING at a printer has made no such promise — it is somebody with
   * their back to you who has not looked up yet, and the moment they do the job
   * is off and they are an ordinary body in an ordinary fight.
   *
   * Three ways they look up, and the third is the one that needed writing:
   * sight, hearing, and you being close enough to be at their elbow. Being seen
   * is the ordinary one and costs them the usual reaction delay, because they
   * spotted you across a room. Being FOUND does not — somebody who turns round
   * into you does not take three quarters of a second to think about it — so a
   * startle goes straight into `alert` with a spent timer, which `_think` on the
   * caller's very next line turns into `chase` in the same frame.
   *
   * Returns true while the body is still at work, in which case the caller skips
   * the state machine entirely: chores.js owns where this one is going.
   */
  _choreWork(e, dt, dist, sees, hears, target, audio) {
    // A NEUTRAL DOES NOT LOOK UP, and that is the whole of what this test is
    // for. The startle exists because of what a hostile at a machine promises:
    // its back is to you and it has not noticed you YET, and the moment that
    // stops being true the job is off. Somebody who was never going to shoot you
    // makes no such promise, so interrupting them costs the promise nothing and
    // costs the errand everything — a courier walking a parcel to the lift is a
    // thing you are supposed to be able to stand and watch, and with this test
    // missing he abandoned it every time the player came within four and a half
    // metres and went back to wandering. `postrun` has had that bug since it was
    // written; `collection` is the errand that made it visible, because its whole
    // point is that you follow the man in the red suit to see where he goes.
    //
    // Damage still ends it, in `_damage`, which is the right and only trigger:
    // the first shot of a firefight stops the building working.
    const startled = !e.neutral && dist < CHORE_STARTLE;
    if (e.neutral || (!startled && !sees && !hears)) {
      this.choreTick?.(e, dt, audio);
      return true;
    }

    // `choreLost` is what puts the arms back down and hands the station back —
    // clearing the flag without it is the bug the chair documents at length.
    this.choreLost?.(e);
    if (startled) {
      e.state = 'alert';
      e.timer = 0;
      e.lastSeen = { x: target.x, z: target.z };
      // ...and they have just SEEN you, whatever the grid says about line of
      // sight. Without this the chase is over the frame after it starts: a body
      // that has been standing at a machine has been out of contact for as long
      // as it has been standing there, so `_think`'s own GIVE_UP test fires on
      // the very next tick and puts it straight back to idle. Measured: startled
      // at 2.6 m, `chase` for one frame, `idle` two seconds later, still 2.6 m
      // away and no longer interested.
      e.contact = 0;
      // Somebody who has just found you standing over them says so, on the same
      // one-at-a-time budget the rest of the floor shouts on.
      if (this.shoutTimer <= 0) {
        this.shoutTimer = SHOUT_GAP;
        this.audio?.enemyAlert(e);
      }
    }
    return false;
  }

  _think(e, dt, dist, sees, hears, target) {
    e.timer -= dt;

    switch (e.state) {
      case 'idle':
        // Noticed by sight, or by the racket you make shooting.
        if (sees || hears) {
          e.state = 'alert';
          e.timer = this.tuning.reaction;
          e.lastSeen = { x: target.x, z: target.z };
          // Whoever spots you first does the shouting. The rest of the room has
          // heard him and does not need to say it again.
          if (this.shoutTimer <= 0) {
            this.shoutTimer = SHOUT_GAP;
            this.audio.enemyAlert(e);
          }
        }
        break;

      case 'alert':
        if (e.timer <= 0) e.state = 'chase';
        break;

      case 'chase':
        if (sees && dist < e.type.range) e.state = 'fight';
        // The alarm response keeps looking for a good deal longer than a clerk
        // who heard a noise: they came up here for one reason and there is no
        // desk on this floor for them to give up and go back to.
        else if (e.contact > (e.keyed ? RESPONSE_PATIENCE : GIVE_UP)) {
          e.state = 'idle';
          e.lastSeen = null;
        }
        break;

      case 'fight':
        if (!sees || dist > e.type.range + 3) { e.state = 'chase'; }
        break;
    }
  }

  /**
   * Walk. The route comes off the shared distance field; everything here is
   * about the last metre of it, which is where a floor full of people actually
   * comes unstuck — in a doorway, behind each other.
   *
   * A doorway is 1.5 m and a body is 0.72 m across, so two of them fit through
   * it side by side with nothing to spare. That is the geometry that has to be
   * survived, and three things here do it: they stop shoving each other in tight
   * spots, they stop circling in them, and when they do get wedged they sidestep
   * along the wall instead of standing there pushing into it.
   */
  _move(e, dt, dx, dz, dist, sees) {
    const speed = this.tuning.speed * e.type.speed;
    // "Tight" is anywhere a body and a half does not fit: a doorway, the gap
    // between two desks, the corner of a stairwell.
    const tight = !this.nav.clear(e.x, e.z, RADIUS * 1.7, e.layer);
    let vx = 0, vz = 0;

    if (e.state === 'chase' && e.lastSeen) {
      // A badge holder walks the field that has the locked doorways in it. On a
      // floor with nothing locked left the two fields are the same field.
      const dir = e.keyed
        ? this.nav.descendBadge(e.x, e.z, this._v, e.layer)
        : this.nav.descend(e.x, e.z, this._v, e.layer);
      // The field's own downhill step is what takes a body onto a staircase: the
      // other layer is just another neighbour of a stairwell tile. So the layer an
      // enemy is on is not a decision made here, it is read back off the step.
      if (dir) { e.layer = dir.layer ?? e.layer; vx = dir.x * speed; vz = dir.z * speed; }
      else if (dist > 1.2) { vx = (dx / dist) * speed * 0.5; vz = (dz / dist) * speed * 0.5; }
    } else if (e.state === 'fight') {
      // Hold a firing distance and sidestep, so a firefight isn't two statues.
      // Melee types have no standoff to hold — they just keep coming.
      const nx = dx / dist, nz = dz / dist;
      let advance = 0;
      if (e.type.melee) advance = dist > 1.1 ? 1 : 0;
      else if (dist > PREFERRED + 1.5) advance = 1;
      else if (dist < TOO_CLOSE) advance = -1;

      vx = nx * advance * speed;
      vz = nz * advance * speed;
      // Circling is for open floor. In a doorway it is just grinding along the
      // jamb, and with a queue behind you it is what turns a doorway into a plug.
      const circle = tight ? 0 : (e.type.melee ? 0.15 : 0.45);
      vx += -nz * e.strafe * speed * circle;
      vz += nx * e.strafe * speed * circle;
    }

    if (vx || vz) {
      const blockedX = !this._tryMove(e, vx * dt, 0);
      const blockedZ = !this._tryMove(e, 0, vz * dt);

      if (blockedX && blockedZ) {
        // Nose-first into something. Axis-splitting already handles a wall you
        // hit at an angle; what is left is walking straight at one, which is
        // what a doorway you are half a metre to the side of looks like. So
        // sidestep — one way, then the other — and let the field take over
        // again as soon as anything opens up.
        e.stuck += dt;
        const len = Math.hypot(vx, vz) || 1;
        const px = -vz / len, pz = vx / len;
        const step = speed * dt;
        if (!this._tryMove(e, px * e.strafe * step, pz * e.strafe * step)) {
          e.strafe *= -1;
          this._tryMove(e, px * e.strafe * step, pz * e.strafe * step);
        }
      } else {
        e.stuck = 0;
        // Bounced off a wall while circling? Circle the other way instead of
        // grinding along it.
        if ((blockedX || blockedZ) && e.state === 'fight') e.strafe *= -1;
      }
    }

    // Not in a doorway. Two bodies that barely fit through one will push each
    // other into the jamb and both stop, and everyone behind them stops too —
    // so in tight spots they queue instead of jostling.
    if (!tight) this._separate(e, dt);

    e.group.position.x = e.x;
    e.group.position.z = e.z;
    // On a staircase this is the ramp, on a level it is that level's floor, and on
    // the ground floor it is zero — one lookup rather than a special case per state.
    e.y = this.nav.heightAt(e.x, e.z, e.layer);
    e.group.position.y = e.y;

    // Face the player when engaged, otherwise face where you're walking.
    const wantYaw = (e.state === 'fight' || e.state === 'alert' || sees)
      ? Math.atan2(-dx, -dz)
      : (vx || vz) ? Math.atan2(-vx, -vz) : e.yaw;
    e.yaw = angleLerp(e.yaw, wantYaw, smoothTo(9, dt));
    e.group.rotation.y = e.yaw;
  }

  _tryMove(e, dx, dz) {
    const nx = e.x + dx;
    const nz = e.z + dz;
    // Whoever routes through a locked doorway has to be allowed to stand in it
    // as well. Route on one grid and collide against another and a body grinds
    // against a panel that has already opened for it.
    const ok = e.keyed
      ? this.nav.clearBadge(nx, nz, RADIUS)
      : this.nav.clear(nx, nz, RADIUS, e.layer);
    if (!ok) return false;
    e.x = nx;
    e.z = nz;
    return true;
  }

  /**
   * Bucket every living body by cell, once per frame.
   *
   * `_separate` used to walk the whole roster for each enemy — described as
   * "cheap O(n^2), but n is small", which stopped being true: the difficulty
   * curve reaches 200 on a deep floor, and `items` keeps the dead as well, so
   * the loop was up to 40,000 distance tests a frame and growing quadratically
   * with exactly the number the game raises as you descend. Nobody more than
   * SEPARATION away can push anybody, so all but a handful of those tests were
   * arithmetic performed to reject a body in another room.
   *
   * The cell is SEPARATION across, so a query is the 3x3 block around a body and
   * cannot miss a neighbour close enough to matter. Keys are packed integers
   * rather than strings: this runs every frame and string keys would trade the
   * distance tests for allocations.
   */
  _rebuildNeighbours() {
    this._cells.clear();
    this.keyedAlive = 0;
    for (const e of this.items) {
      if (!e.alive) continue;
      if (e.keyed) this.keyedAlive++;
      const key = cellKey(e.x, e.z);
      const bucket = this._cells.get(key);
      if (bucket) bucket.push(e);
      else this._cells.set(key, [e]);
    }
  }

  /**
   * The nearest living body within `r` of a point on the same level, or null.
   *
   * Off the same per-frame bucket grid `_separate` uses, because the alternative
   * is what this file has already been caught doing three times: a loop over the
   * whole roster for every one of a growing number of things. A floor carries up
   * to 200 bodies and a room's worth of cardboard, and the crush test asks this
   * once per carton per frame.
   *
   * `y` is which level the asker is standing on, not a tolerance to be tuned: a
   * body one storey below a box in an attic is not standing on it, however exactly
   * the tiles line up.
   */
  anyNear(x, z, y, r) {
    const cx = Math.floor(x / SEPARATION), cz = Math.floor(z / SEPARATION);
    const reach = Math.ceil(r / SEPARATION);
    const r2 = r * r;
    for (let gz = cz - reach; gz <= cz + reach; gz++) {
      for (let gx = cx - reach; gx <= cx + reach; gx++) {
        const bucket = this._cells.get(packCell(gx, gz));
        if (!bucket) continue;
        for (const e of bucket) {
          if (!e.alive || Math.abs(e.y - y) > SAME_LEVEL) continue;
          const dx = e.x - x, dz = e.z - z;
          if (dx * dx + dz * dz <= r2) return e;
        }
      }
    }
    return null;
  }

  // Keep bodies from occupying the same tile.
  _separate(e, dt) {
    const cx = Math.floor(e.x / SEPARATION);
    const cz = Math.floor(e.z / SEPARATION);
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const bucket = this._cells.get(packCell(gx, gz));
        if (!bucket) continue;
        for (const other of bucket) {
          if (other === e || !other.alive) continue;
          // Two bodies on different levels are not in each other's way, however
          // exactly the tiles line up — one of them is a storey above the other.
          if (other.layer !== e.layer) continue;
          const dx = e.x - other.x;
          const dz = e.z - other.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > SEPARATION_SQ || d2 < 1e-6) continue;

          const d = Math.sqrt(d2);
          const push = (SEPARATION - d) * dt * 4;
          this._tryMove(e, (dx / d) * push, (dz / d) * push);
        }
      }
    }
  }

  _shoot(e, dt, dist, sees, target, effects, audio) {
    const px = target.x, py = target.y, pz = target.z;
    e.fireCooldown -= dt;

    // A swing already in flight connects part-way through, and only if you're
    // still inside the weapon's reach when it comes down.
    if (e.swing > 0 && !e.swingLanded && e.swing <= SWING_TIME * 0.45) {
      e.swingLanded = true;
      if (dist < e.type.range + e.bluntReach) {
        // The target owns what being hurt means. For the player at this keyboard
        // that is health, a red rim and a chevron pointing at whoever did it; for
        // the other player in a co-op session it is a message on the wire, and
        // nothing in this file has to know which of the two it is talking to.
        target.hurt(this.tuning.damage * e.type.damage, e.x, e.z);
        audio.meleeHit();
      }
    }

    // How long they have had you lined up, and how long they need. Ticked before
    // the returns below, because losing sight of you is precisely when it has to
    // start draining.
    const need = this.tuning.aim * (e.type.aimMul ?? 1);
    const onTarget = sees && e.state === 'fight'
      && Math.abs(angleDelta(e.yaw, Math.atan2(-(px - e.x), -(pz - e.z)))) < AIM_CONE;
    e.aim = onTarget
      ? Math.min(e.aim + dt, need * AIM_BANK)
      : Math.max(0, e.aim - dt * AIM_DRAIN);

    if (e.state !== 'fight' || !sees || dist > e.type.range) return;
    if (e.fireCooldown > 0) return;

    const type = e.type;
    // The aim window, and the one thing that can hold a shot back with everything
    // else about it ready. `aimMul` is how fast this type gets on target — a
    // machine built to watch a corridor against somebody who was doing a
    // spreadsheet ninety seconds ago. See enemy-types.js.
    if (!type.melee && e.aim < need) return;
    e.fireCooldown = this.tuning.fireInterval * type.rate * (0.75 + Math.random() * 0.5);

    // Melee types don't shoot: they swing, and the hit lands mid-swing rather
    // than on the wind-up, so you get a moment to back out of reach.
    if (type.melee) {
      e.swing = SWING_TIME;
      e.swingLanded = false;
      audio.enemyMeleeSwing(e);
      return;
    }

    // Muzzle in world space, from the gun the model is actually holding.
    e.gun.getWorldPosition(this._muzzle);

    // Sample the spread as a real angle, then turn it into a miss distance at
    // the player's range: distance genuinely protects you.
    const angle = this.tuning.spread * type.spread * Math.sqrt(Math.random());
    const miss = Math.tan(angle) * dist;
    const hit = miss < 0.5;

    const spin = Math.random() * Math.PI * 2;
    this._aim.set(
      px + Math.cos(spin) * miss,
      py - 0.1 + (Math.random() - 0.5) * 0.2,
      pz + Math.sin(spin) * miss
    );
    if (hit) this._aim.set(px, py - 0.15, pz);

    effects.tracer(this._muzzle, this._aim);
    // Bigger types carry bigger guns, and a flash you can size up across a room
    // is half of knowing what is shooting at you.
    effects.muzzle(this._muzzle, type.scale);
    // Heavier types fire lower, so you can hear what's shooting you.
    audio.enemyShot(e);
    // The other end of a co-op session cannot see this happen — its roster is
    // posed from snapshots and never runs `_shoot` at all — so a shot fired here
    // has to be told, or the staff over there kill the joiner in silence with
    // their arms by their sides.
    this.onFire?.(e, this._muzzle, this._aim);

    if (hit) target.hurt(this.tuning.damage * type.damage, e.x, e.z);
  }

  // --- co-op: the roster over the wire ---------------------------------------

  /**
   * Fills `out` with a snapshot of whoever is worth sending, and returns how
   * many numbers it wrote. Host side only.
   *
   * Two things bound the cost, and both are needed. The RANGE test is what makes
   * this affordable at all — a deep floor holds two hundred people and all but a
   * handful of them are sitting in offices nobody is anywhere near, and a body
   * neither player can see does not need a position. The CAP is what bounds one
   * packet, because a real firefight can legitimately have forty bodies moving
   * inside that range. Together with the round-robin cursor they mean everything
   * in range is covered within a few packets rather than the same first forty
   * being sent for ever.
   *
   * A dead body is never sent. Death is its own message — it has to carry which
   * shot did it, and it has to arrive exactly once.
   */
  // Called on every new floor. Materials are per-enemy (so a hit flash on one
  // doesn't light up the floor) and weapon geometry is per-enemy, so both have
  // to be released here or a long run bleeds GPU memory one floor at a time.
  clear() {
    for (const e of this.items) {
      // A running motor outlives its floor otherwise: the loop is held by the
      // audio engine, not by the scene graph, so removing the mesh leaves it
      // droning over the next floor from wherever this one used to be.
      if (e.motor) { this.audio?.stopMotor(e.motor); e.motor = null; }
      this.scene.remove(e.group);
      for (const m of Object.values(e.mats)) m.dispose();
      for (const g of e.ownGeo) g.dispose();
    }
    this.items.length = 0;
    this.meshes.length = 0;
    // The desks belong to the floor being torn down, and every one of them holds
    // a reference to one of its rooms. So do the canteen's chairs and its
    // counter, which is the same fact one room along.
    this.desks.clear();
    this.tables?.clear();
    this.stations?.clear();
    this.servery = [];
    this.shelves = [];
    this.trayRack = null;
  }

  dispose() { this.clear(); }
}


/**
 * Where a body stands to use a lift.
 *
 * Not furniture, so it does not come down the workstation pipe — it is derived
 * from the two cars the floorplan carved (gen/lifts.js) exactly as the mop and
 * patrol spots are derived from the corridor sample, and for the same reason: it
 * is a patch of floor rather than a thing.
 *
 * `facing` is the direction the doors open into the room, so stepping that far
 * out of the car puts a body clear of the doorway, and turning back round
 * (`+ 2`) has them facing the doors.
 *
 * WALKED OUT UNTIL A BODY FITS, rather than measured. `fits` is the walk grid
 * eroded by a body's radius, so every tile touching the car's front wall is out
 * of it — a standoff picked by eye landed one tile short and `floodTo` came back
 * false for every post run on every floor, silently, because a route to a tile
 * nothing can stand on is no route at all.
 *
 * **AND FITTING IS NOT THE SAME AS BEING CONNECTED**, which is the second half of
 * that sentence and was missing. A lift lobby's standable floor is not one
 * region: the two cars, the doorway apron and the reception counter cut it into
 * several, and the nearest fitting tile to a car front is very often in the
 * pocket BETWEEN the car and the counter — standable, and joined to nothing. So
 * the walk now also requires the tile to be on a field flooded from the corridor
 * network, which is connected by construction.
 *
 * Measured over 24 floors before it: no lobby is sealed and 80–98% of each one's
 * standable tiles are reachable from outside — so this is a handful of tiles a
 * room, and the spot picked was in them. It is the same shape of failure
 * `deskPool` fixed with `fitsAt`, one strictness further on, and it is silent in
 * the same way: a body stood at the lift for the whole floor, and a cast that can
 * find no route is indistinguishable from a cast that was never tried.
 *
 * WHICH IS ALSO WHY NOBODY STANDS INSIDE A CAR. A lift opening is 1.0 m
 * (`LIFT_DOOR_W` in gen/lifts.js, and the pocket arithmetic there is why), and a
 * body is 0.8 m across on a 0.5 m grid — so both of its door tiles are eroded
 * out of `fits` and the interior is an island of two tiles. The PLAYER walks in
 * and out of one perfectly well, because their collision is continuous; nobody
 * else can.
 *
 * No spot is an ordinary answer, and it has to be one rather than a fallback to
 * the unconnected tile: a lift nobody can reach is a post run and a collection
 * that simply do not happen on this floor, where a lift somebody is standing at
 * and cannot leave is a body wasted for the whole level.
 */

/**
 * ...and the four files the rest of this class lives in.
 *
 * enemies.js reached 4,300 lines holding ten unrelated jobs, which is the shape
 * gen/build.js was in before it became eight modules — and it cost the same
 * thing: each of the three features before this one had to work in three
 * separate places in it. So the jobs are four files now, joined back on here.
 *
 * THEY ARE METHODS IN AN OBJECT RATHER THAN FUNCTIONS TAKING THE ROSTER, and
 * that is a decision rather than a shortcut. `spawn` alone touches twenty-two
 * fields of this class and calls five methods that stayed behind; the placement
 * pass is not a component anybody could reuse, it is one job of one object.
 * Threading an explicit roster through it would be the same coupling with more
 * ceremony — and it would have rewritten every line of all four files rather
 * than moving them, so the snapshot in tools/baseline could no longer say the
 * split changed nothing, which is the one thing about a split worth having.
 *
 * What IS genuinely reusable came out as a module with a table of its own:
 * held.js, the four things a body can be carrying.
 *
 * The order they are applied in does not matter, because no two of them define
 * the same name — asserted rather than trusted, since a silently shadowed method
 * is the one failure this pattern can have.
 */
for (const part of [rosterMethods, netMethods, breakMethods, stationMethods]) {
  for (const name of Object.keys(part)) {
    if (Object.hasOwn(Enemies.prototype, name)) {
      throw new Error(`enemies.js: two definitions of ${name}`);
    }
  }
  Object.defineProperties(Enemies.prototype, Object.getOwnPropertyDescriptors(part));
}
