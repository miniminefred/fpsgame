import * as THREE from 'three';
import { TYPES } from './enemy-types.js';

/**
 * Parcel runs: the building's own work, done by the things that work in it.
 *
 * An Automated floor says it is being worked by being full of machines, and
 * until this existed that was the whole of the claim — a hundred and fifty
 * bodies standing about in an office, plus a belt on the wall with boxes on it
 * that came from nowhere and went nowhere. The point of this module is the
 * sentence in the middle: a box comes off a rack in the storeroom, a machine
 * carries it out, a porter takes it up the corridor, and somebody uses it to fix
 * the belt. Three bodies, one box, one errand.
 *
 * WHY IT IS ITS OWN FILE. All of this could have gone in enemies.js beside the
 * lunch cycle, which is the closest existing thing and which this is
 * unashamedly modelled on. It did not, for the reason that file is already the
 * biggest in the tree: a run is self-contained and has its own vocabulary, and
 * the only part of it enemies.js has to know is that a body with `e.job` on it
 * is being walked by somebody else this frame. That is two branches in `update`
 * and two hooks — `jobTick` and `jobLost`.
 *
 * WHAT IT REUSES is the half worth reading. The walking is not new:
 * `routeTo` / `advanceTo` / `standAt` in enemies.js are the lunch cycle's own
 * primitives, lifted out from under it and renamed off it, because "flood a
 * field to a point, walk down it, give up if there is no route" was never about
 * lunch. Every hard-won thing in them applies here unchanged: both halves of the
 * reachability check, the once-only re-flood on a wedge, and the unhurried pace
 * that keeps a body walking to a job from reading as a body that has noticed you.
 *
 * THE THREE ROLES are hard-cast rather than picked by capability, because the
 * chain is a specific piece of theatre and it does not play with the wrong cast:
 *
 *   fetch   a Welder Unit        takes the box off the rack
 *   port    a Porter Unit        carries it, on the deck it already has
 *   fix     a Maintenance Worker puts it into the belt, at length, with sparks
 *
 * All three are NEUTRAL, and that is not incidental — it is what makes the thing
 * legible. The player is meant to be able to stand in a doorway and watch it
 * happen, which they cannot do if any of the three would rather be shooting
 * them. It is also what makes it cheap to abort: damage anywhere ends the run
 * (see `lost`), so the first shot of a firefight stops the building working,
 * which is the right thing for the first shot of a firefight to do.
 *
 * HOST ONLY, like the lunch cycle and for its reason: a run is a runtime
 * decision, so two browsers deciding it would be two different runs. The crate
 * crosses as one bit in the snapshot's sixth slot (`SNAP_BOX` in enemies.js) and
 * the bodies cross as the positions they already crossed as, so a joiner watches
 * the same three machines do the same errand without running a line of this.
 */

// How long before the first run of a floor, and between one and the next. The
// first is short: this is the theme's own flavour, and a player who clears a
// machine floor in ninety seconds should still have seen one.
const JOB_FIRST = 14;
const JOB_GAP = [20, 44];

// Runs at once. Two, because one is an incident and four is a logistics
// simulation — and because each takes three bodies out of the wander loop, and a
// corridor of machines standing still while six of them run errands reads as the
// floor having stopped rather than started.
const JOB_MAX = 2;

// The per-stage backstop. Nothing should reach it — a run that quietly never
// ends is three bodies frozen mid-errand for the rest of the floor — and it is
// generous for the reason lunch's is: a walk from one end of a deep floor to the
// other took a body fifty seconds at errand pace.
const STAGE_CAP = 100;

// Metres: close enough to pass a box to somebody. Deliberately loose, because
// both bodies are standing where the flow field left them and neither is going
// to line up prettily — and a handoff that will not fire is a run that times out
// with a box still in it.
const HANDOFF = 1.75;

// How long each beat takes. `FIX_TIME` is by far the longest and that is the
// point of it: the repair is the one stage the player is meant to walk up to and
// watch, and the two carries are only how the box got there.
const TAKE_TIME = [1.4, 2.4];    // reaching it off the rack
const PASS_TIME = [0.7, 1.3];    // ...and reaching it across to somebody
const FIX_TIME = [10, 17];       // working on the belt
// ...and how often that throws a spark. Tightened from [0.45, 1.05] once the
// body had a work STROKE to go with it: at the old rate a spark landed about
// every three strokes, so most of the motion made nothing happen and the two did
// not read as the same event.
const FIX_TICK = [0.30, 0.70];

// Where the second body of a handoff stands: far enough off the first that they
// are not inside one another, near enough that the pass fires.
const MEET_MIN = 1.1;
const MEET_MAX = 2.5;
const MEET_RINGS = 15;

// How far off the wall a body stands to work on a belt. The belt is fitted above
// head height (see CLEAR_Y in conveyors.js) so a body can stand right underneath
// one; this is only far enough out that it is not inside the plaster.
const BELT_STANDOFF = 0.5;
// ...and how high the sparks come off it, which is under the deck rather than at
// the floor: what is being worked on is the machine, not the carpet.
const SPARK_Y = 1.95;

// Which roster entry plays each part. A table rather than three lookups inline,
// so a theme could one day run its parcels with a different set of machines.
const CAST = { fetch: TYPES.welder, port: TYPES.porter, fix: TYPES.worker };
const ROLES = ['fetch', 'port', 'fix'];

export class Jobs {
  constructor({ enemies, effects, audio }) {
    this.enemies = enemies;
    this.effects = effects;
    this.audio = audio;
    this.nav = null;

    this.shelves = [];      // where a box comes from
    this.belts = [];        // ...and where it goes
    this.runs = [];         // live chains
    this.timer = JOB_FIRST;
    this.enabled = false;

    // The seam between this file and enemies.js, and the whole of it: a body
    // with `e.job` on it is walked by `_tick` instead of by `_wander`, and
    // `lost` is how `_damage` and `_die` say the run is off.
    enemies.jobTick = (e, dt, audio) => this._tick(e, dt, audio);
    enemies.jobLost = (e) => this.lost(e);

    // `descendOn`'s output, and it has to be a real Vector3 — that method ends
    // in `out.set(...)`, so a plain {x, z} throws. Nothing here reads it: the
    // step it names is thrown away and only the true/false is wanted.
    this._v = new THREE.Vector3();
    this._field = null;         // the casting flood, one at a time
  }

  /**
   * Collects the two kinds of place a run needs, for this floor.
   *
   * Called after `enemies.spawn` — the shelf pool comes through the same
   * `nav.fitsAt` filter every other station pool does — and after
   * `conveyors.spawn`. Without both a shelf and a belt there is nothing to do
   * and `enabled` stays false, which is MOST floors: a parcel run wants a
   * storeroom and a parcel line, and only a theme that asked for conveyors has
   * the second. That is the intended shape — this is the machine floor's own
   * business, not a thing every office does.
   */
  spawn(nav, enemies, conveyors) {
    this.clear();
    this.nav = nav;
    this._field = null;
    this.shelves = enemies.shelves ?? [];
    this.belts = (conveyors?.runs ?? []).map((r) => this._beltSpot(r)).filter(Boolean);
    this.enabled = this.shelves.length > 0 && this.belts.length > 0;
    this.timer = JOB_FIRST;
  }

  /**
   * Where somebody stands to work on a belt, and which way they face.
   *
   * The run knows the direction it travels and which side the wall is on
   * (`wallSign`), which is enough for both: step off the belt's centre line away
   * from the plaster, and turn back to face it. Derived here rather than stored
   * on the run, because conveyors.js has no business knowing anybody was ever
   * going to stand here.
   */
  _beltSpot(run) {
    // The wall, in world terms. `wallSign` is that direction dotted with the
    // run's own local +X, which is world (-dz, dx) — see where it is built in
    // conveyors.js. Undoing that dot is multiplying back through.
    const wx = -run.dz * run.wallSign;
    const wz = run.dx * run.wallSign;
    const x = run.midX - wx * BELT_STANDOFF;
    const z = run.midZ - wz * BELT_STANDOFF;
    if (!this._fits(x, z)) return null;
    return { x, z, rot: rotToward(wx, wz), run };
  }

  /**
   * Whether a body can stand here AND route away from here.
   *
   * `fitsAt` rather than `clear`, which is the distinction `deskPool` in
   * enemies.js paid for: `clear` is a point test, `fitsAt` is that test at the
   * TILE CENTRE, and the tile centre is what every flood and every `descendOn`
   * runs on. A spot that passes one and fails the other is a spot a body walks
   * to and then cannot leave.
   */
  _fits(x, z) {
    const nav = this.nav;
    return !!nav && nav.fitsAt(nav.tx(x), nav.ty(z));
  }

  /**
   * The nearest sampled corridor tile to somewhere, which is where the FIRST
   * handoff happens.
   *
   * This is the fix to the bug that stopped any run ever starting, and it is
   * also the better staging, which is the pleasant part. A storeroom is
   * back-of-house: `GREY_ROLES` in gen/locks.js lists `storage`, and every room
   * with a door gets white on top of that — and a badged door is out of the nav
   * grid entirely, so nothing can route into a storeroom until the player has
   * opened it. The first version had the porter collect at the RACK, which meant
   * the porter had to get into that room too. Measured on floor 3: 20 free
   * welders, 2 free porters, 6 belts every porter could reach, and **1 of 25
   * shelves** anybody could reach at all — so the porter cast failed on
   * essentially every attempt, silently, and the whole feature never ran.
   *
   * Meeting in the corridor fixes it and is what a delivery looks like anyway:
   * the machine brings the box OUT, and the porter is waiting in the hall with
   * its deck. Only one of the three now has to be able to get into the
   * storeroom, which is one constraint instead of two.
   *
   * `enemies.corridors` is a sample of every tenth corridor tile — coarse, and
   * coarse is fine here: what is wanted is somewhere in the hall near the door,
   * not the exact tile outside it.
   */
  _corridorNear(at) {
    let best = null;
    let bestD = Infinity;
    for (const c of this.enemies.corridors ?? []) {
      const dd = (c.x - at.x) ** 2 + (c.z - at.z) ** 2;
      if (dd >= bestD || !this._fits(c.x, c.z)) continue;
      best = c;
      bestD = dd;
    }
    if (!best) return null;
    // Facing back toward the room the box is coming out of.
    return { x: best.x, z: best.z, rot: rotToward(at.x - best.x, at.z - best.z) };
  }

  /**
   * A spot to stand near `at` but not on top of it, for the second body of a
   * handoff. Rings outward rather than throwing darts, for the reason
   * `cameras.js` walks a shuffled list: a spot that survives every test is a few
   * percent of the floor around a point, so darts deliver one handoff on this
   * floor and none on the next.
   */
  _meetSpot(at) {
    const start = Math.random() * Math.PI * 2;
    for (let i = 0; i < MEET_RINGS; i++) {
      const a = start + i * (Math.PI * 2 / MEET_RINGS);
      const r = MEET_MIN + (MEET_MAX - MEET_MIN) * ((i % 3) / 2);
      const x = at.x + Math.cos(a) * r;
      const z = at.z + Math.sin(a) * r;
      if (!this._fits(x, z)) continue;
      // Facing whoever they are taking it from, which is the one thing a handoff
      // has to look like.
      return { x, z, rot: rotToward(at.x - x, at.z - z) };
    }
    return null;
  }

  // ------------------------------------------------------------------ casting

  update(dt) {
    if (!this.enabled || this.enemies.puppet) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = JOB_GAP[0] + Math.random() * (JOB_GAP[1] - JOB_GAP[0]);
    if (this.runs.length < JOB_MAX) this._start();
  }

  /**
   * Casts and launches one run, or does not. Every failure here is silent and
   * costs nothing but this turn.
   *
   * ORDER MATTERS: the places are chosen first and the bodies second, because a
   * body is only a candidate if it can REACH its part of the run — and that is
   * asked before anything is committed, exactly as `_sendToLunch` learned to. A
   * half-created run would leave bodies flagged busy with no chain walking them.
   */
  _start() {
    const shelf = pick(this.shelves);
    const belt = pick(this.belts);
    if (!shelf || !belt) return;

    // Where the two handoffs happen. The first is out in the hall by the
    // storeroom (see `_corridorNear` — it is what makes a run possible at all)
    // and the second is beside the belt, which is already in a corridor. Neither
    // is half way between anything: a box passed in the middle of a corridor is
    // two bodies meeting nowhere, and a box passed at the storeroom door and
    // again at the belt is a delivery.
    const meetShelf = this._corridorNear(shelf);
    const meetBelt = this._meetSpot(belt);
    if (!meetShelf || !meetBelt) return;

    // EVERY LEG, not just the first. This is the lesson `_cardOutside` and
    // `_sendToLunch` both paid for, and it bit again here in a form worth
    // recording: casting the fetcher against the shelf alone picked a welder
    // that was already INSIDE the storeroom — which is the only kind of welder
    // that can reach a rack behind a shut door — and it walked to the rack, took
    // the box, and then could not get out to the corridor to hand it over. The
    // run died at the first step past the pickup, every time, in 4.7 simulated
    // seconds. A body that can reach the first stop and not the second is worse
    // than no body at all, because it has already been committed.
    const fetcher = this._cast('fetch', [shelf, meetShelf]);
    if (!fetcher) return;
    const porter = this._cast('port', [meetShelf, meetBelt], fetcher);
    if (!porter) return;
    const fixer = this._cast('fix', [belt], fetcher, porter);
    if (!fixer) return;

    const chain = { fetcher, porter, fixer, shelf, belt, meetShelf, meetBelt, over: false };
    this.runs.push(chain);

    // Each of the three sets off for its own end of the errand at once, which is
    // what makes the handoffs work at all: a porter that only started walking
    // once the box was off the rack would be two corridors away when it was
    // wanted, and the fetcher would stand at the meeting point for the length of
    // the stage cap.
    this._give(fetcher, chain, 'fetch', 'toShelf', shelf);
    this._give(porter, chain, 'port', 'toMeet', meetShelf);
    this._give(fixer, chain, 'fix', 'toWork', belt);
  }

  /**
   * Finds one body of a role's type that can get to where its part starts.
   *
   * Flooded ONCE from the destination into a field of this module's own and then
   * read per candidate, which is `_sendToLunch`'s lesson taken directly: the
   * field from a fixed point is the same field whoever is asking, and two dozen
   * floods of a ten thousand tile floor to answer one question is the shape of
   * loop this game has been caught writing three times.
   *
   * It also matters that the probe touches NOTHING on the candidate. Routing a
   * body to find out whether it could be routed leaves `e.field` flooded to a
   * place it was not chosen to go, and `_wander` walks down `e.field` — so every
   * rejected candidate would wander off toward a storeroom it has no business in.
   *
   * CANDIDATES ARE FILTERED, NOT DARTED AT, and that is a fix rather than a
   * preference. `_sendToLunch` may throw darts at the whole roster because any
   * employee will do — seventy-nine of them on a floor. These three roles are
   * RARE: a porter and a maintenance worker are hand-placed corridor traffic,
   * one to a handful each, so darting twenty-six times at two hundred bodies
   * misses a two-body type about two thirds of the time. Measured before this
   * changed: 6 attempts in a row on a floor that had two welders, one porter and
   * two workers standing in it, and not one of them cast a single role. The
   * feature was silently never running.
   */
  _cast(role, tos, ...taken) {
    if (!this.nav) return null;
    const want = CAST[role];
    if (!want) return null;

    // One pass over the roster. A run is cast every twenty seconds at the most,
    // so this is nothing next to the floods below it.
    let pool = [];
    for (const e of this.enemies.items) {
      if (e.type === want && !taken.includes(e) && this._free(e)) pool.push(e);
    }
    if (!pool.length) return null;

    this._field ??= this.nav.makeField();
    // One flood per stop, narrowing the pool each time, rather than one flood
    // per candidate: the field from a fixed point is the same field whoever is
    // asking. Reachability on this grid is symmetric, so a body on the field
    // flooded from every stop can walk between those stops in any order — which
    // is what makes checking the body's own tile enough.
    for (const to of tos) {
      if (!this.nav.floodTo(this._field, to.x, to.z)) return null;
      pool = pool.filter((e) => this.nav.descendOn(this._field, e.x, e.z, this._v));
      if (!pool.length) return null;
    }

    // Picked at random out of whoever is left, so the same welder is not always
    // the one that goes and a floor's runs are spread over whoever is about.
    return pool[(Math.random() * pool.length) | 0];
  }

  /**
   * Whether this body is available.
   *
   * `layer === 0` is the same limitation the lunch cycle documents, inherited
   * from the same place: the walk is a field flooded to a point, which is
   * ground-floor shaped. Somebody in an attic stays in their attic, which is the
   * honest answer rather than a body that sets off downstairs and wedges on a
   * landing.
   */
  _free(e) {
    return e.alive && e.neutral && !e.job && !e.chore && !e.break && !e.seat
      && !e.behindLock && !e.offMap
      && e.flee <= 0              // not somebody who has just been shot at
      && e.layer === 0;
  }

  /**
   * Puts a body on the run.
   *
   * `timer` is the stage CAP and ticks in every stage; `work` is how long a
   * standing stage is meant to take and ticks only in those. Two numbers rather
   * than one, and the first draft had one: the repair takes up to seventeen
   * seconds, so a single timer doing both jobs meant the stage cap either fired
   * during the repair or stopped protecting the walks.
   */
  _give(e, chain, role, stage, to) {
    e.job = { chain, role, stage, at: null, timer: STAGE_CAP, work: 0, beat: 0, tick: 0 };
    e.jobRole = role;
    this.enemies.routeTo(e, e.job, to, STAGE_CAP);
  }

  // ------------------------------------------------------------------- a frame

  /**
   * One frame of one body's run. Called from enemies.js's `update` in place of
   * `_wander`, so this owns the body's movement for as long as the run lasts.
   */
  _tick(e, dt, audio) {
    const j = e.job;
    if (!j) return;

    // The backstop, in one place so no stage can forget it. It is also how a
    // failed flood reports itself — `routeTo` and `advanceTo` both spend the
    // timer when there is no route (see enemies.js).
    j.timer -= dt;
    if (j.timer < 0) { this.lost(e); return; }
    if (j.work > 0) j.work -= dt;
    if (j.beat > 0) j.beat -= dt;

    switch (j.stage) {
      // --- the fetcher: a Welder Unit --------------------------------------
      case 'toShelf':
        if (this._walk(e, dt)) this._work(e, j.chain.shelf, 'taking', TAKE_TIME);
        return;

      case 'taking':
        if (j.work > 0) return;
        // The box is off the rack. It arrives at the END of the stage, because
        // what was being waited for is the reaching and the lifting.
        this.enemies.giveCrate(e);
        this._go(e, j.chain.meetShelf, 'toPass');
        return;

      case 'toPass':
        if (this._walk(e, dt)) this._wait(e, j.chain.meetShelf, 'passing');
        return;

      case 'passing':
        // Holding the box out, waiting for the porter — which may be a while, so
        // this is a WAITING stage on the full stage cap rather than a timed one.
        this._pass(j.chain, 'fetch', 'port', 'waiting', 'toBelt');
        return;

      // --- the porter: a Porter Unit ---------------------------------------
      case 'toMeet':
        if (this._walk(e, dt)) this._wait(e, j.chain.meetShelf, 'waiting');
        return;

      case 'waiting':
        // At the storeroom with an empty deck. Nothing to do but be there; the
        // fetcher's `passing` is what moves this on.
        return;

      case 'toBelt':
        if (this._walk(e, dt)) this._wait(e, j.chain.meetBelt, 'delivering');
        return;

      case 'delivering':
        this._pass(j.chain, 'port', 'fix', 'expecting', 'fixing');
        return;

      // --- the fixer: a Maintenance Worker ---------------------------------
      case 'toWork':
        if (this._walk(e, dt)) this._wait(e, j.chain.belt, 'expecting');
        return;

      case 'expecting':
        // At the belt, waiting for the box. Same shape as the porter's
        // `waiting`: the other body's stage is what fires the handoff.
        return;

      case 'fixing':
        this._fix(e, dt, audio);
        return;

      default:
        this.lost(e);
    }
  }

  /** A walking stage: one step, and true once they are there. */
  _walk(e, dt) {
    return this.enemies.advanceTo(e, e.job, dt, e.job.at);
  }

  /** Stop, face the thing, and take a while over it. */
  _work(e, at, stage, span) {
    this.enemies.standAt(e, at);
    e.job.stage = stage;
    e.job.timer = STAGE_CAP;
    e.job.work = span[0] + Math.random() * (span[1] - span[0]);
  }

  /**
   * Stop, face the thing, and wait for somebody. `beat` is the reach across,
   * which has to elapse before a handoff fires — without it the box teleports
   * the instant two bodies are in range, and a delivery with no pause in it does
   * not read as one.
   */
  _wait(e, at, stage) {
    this.enemies.standAt(e, at);
    e.job.stage = stage;
    e.job.timer = STAGE_CAP;
    e.job.beat = PASS_TIME[0] + Math.random() * (PASS_TIME[1] - PASS_TIME[0]);
  }

  /** Point somebody at their next stop. */
  _go(e, to, stage) {
    e.job.stage = stage;
    this.enemies.routeTo(e, e.job, to, STAGE_CAP);
  }

  /**
   * The box changes hands, if both bodies are there and ready.
   *
   * ONE function for both handoffs, driven from the GIVER's frame only: two
   * bodies each asking "is the other one here yet" is two chances to transfer
   * the same box, and the box is the entire state of the run. The receiver is
   * never ticked into this — it sits in its waiting stage until this moves it,
   * and `waitStage` is checked rather than assumed because a receiver still
   * walking up would otherwise be handed the box in the middle of a corridor and
   * sent straight to `fixing` there.
   */
  _pass(chain, fromRole, toRole, waitStage, nextStage) {
    const from = chain[FIELD[fromRole]];
    const to = chain[FIELD[toRole]];
    if (!from?.alive || !to?.alive || !from.job || !to.job) return;
    if (!from.carry) return;
    if (to.job.stage !== waitStage) return;
    if (from.job.beat > 0) return;
    if (Math.hypot(to.x - from.x, to.z - from.z) > HANDOFF) return;

    this.enemies.takeCrate(from);
    this.enemies.giveCrate(to);

    // The giver is done with the run. Released rather than left standing there,
    // because a machine that has handed its box over and then watches the rest
    // of the errand is a machine with nothing to do.
    this._release(from);

    if (nextStage === 'fixing') {
      // Turned to the belt for the whole repair, and `work` IS the repair.
      this.enemies.standAt(to, chain.belt);
      to.job.stage = 'fixing';
      to.job.timer = STAGE_CAP;
      to.job.work = FIX_TIME[0] + Math.random() * (FIX_TIME[1] - FIX_TIME[0]);
      to.job.tick = 0;
      // Both hands go up into the machine and the box goes down at his feet —
      // see animateFixing in enemy-anim.js. Without this the repair was a man
      // standing perfectly still holding a box for fifteen seconds, which is the
      // clearest possible statement that he is NOT working.
      this.enemies.setWorking(to, true);
    } else {
      this._go(to, chain.meetBelt, nextStage);
    }
  }

  /**
   * Working on the belt: the one stage of a run the player is meant to stop and
   * watch, so it is the one with anything to look at.
   *
   * The spark is `effects.impact` at the belt's underside — the pooled flash
   * every bullet already uses, so this allocates nothing — and the noise is
   * `audio.generatorArc`, which is a reuse and a deliberate one. It is the only
   * clip in the set built to be asked for two or three times a second at close
   * range and to sit UNDER a fight rather than on top of it: four takes at the
   * widest pitch jitter in the set, mixed down to 0.45, with the shortest
   * audible range of anything placed (18 m against the usual 26). A repair is
   * exactly that shape of sound. The alternative was a new clip, and a new clip
   * that has to repeat is the hardest thing in the set to get right.
   */
  _fix(e, dt, audio) {
    const j = e.job;
    if (j.work <= 0) {
      // Done, and the box has gone into the machine. Nothing marks the belt as
      // fixed because nothing ever marked it broken: what the player saw was
      // three machines doing an errand, and the errand is over.
      this.enemies.takeCrate(e);
      this._finish(j.chain);
      return;
    }

    j.tick -= dt;
    if (j.tick > 0) return;
    j.tick = FIX_TICK[0] + Math.random() * (FIX_TICK[1] - FIX_TICK[0]);

    // At the BELT's own centre line rather than at the spot he is standing on,
    // which is BELT_STANDOFF back from it: the sparks want to be where his hands
    // are, and his hands are up and forward, in the machine. Off the run because
    // that is the only thing that knows where the belt actually is.
    const run = j.chain.belt.run;
    SPARK.x = run ? run.midX : j.chain.belt.x;
    SPARK.z = run ? run.midZ : j.chain.belt.z;
    this.effects?.impact(SPARK, DOWN, 0xfff0c0, 0.7);
    (audio ?? this.audio)?.generatorArc?.(SPARK);
  }

  // ------------------------------------------------------------------ endings

  /**
   * This body is out — shot, killed, wedged, or timed out. Called from `_damage`
   * and `_die` in enemies.js as well as from here.
   *
   * The WHOLE run ends, not just this body's part of it, and that is the design
   * rather than laziness: the other two are waiting on a handoff that is never
   * coming, and the stage cap would leave them standing in a corridor for a
   * minute and a half before working it out. It reads correctly too — you shot
   * one of them, and the job stopped.
   */
  lost(e) {
    const chain = e.job?.chain;
    if (!chain) { this._release(e); return; }
    this._finish(chain);
  }

  /** Ends a run and hands all three bodies back, exactly once. */
  _finish(chain) {
    if (chain.over) return;
    chain.over = true;
    for (const role of ROLES) this._release(chain[FIELD[role]]);
    const i = this.runs.indexOf(chain);
    if (i >= 0) this.runs.splice(i, 1);
  }

  /**
   * One body back to its own day.
   *
   * The crate goes wherever it was, which is the one thing that must not be
   * skipped: a box parented to a body that has gone back to wandering walks
   * around the floor for the rest of the run, and a box parented to a corpse
   * rides the ragdoll down.
   *
   * `wander` with a spent timer rather than `idle`, because everybody on a run is
   * neutral and that is what makes the next tick pick somewhere new — the same
   * thing `_repick` does for a neutral that has been shot at.
   */
  _release(e) {
    if (!e) return;
    // Before the crate, because this is what puts the arms back down — and a
    // body released mid-stroke would otherwise keep the pose for the rest of the
    // floor. It is a no-op for the two who were never working.
    this.enemies.setWorking(e, false);
    this.enemies.takeCrate(e);
    e.job = null;
    e.jobRole = null;
    if (!e.alive) return;
    e.state = 'wander';
    e.wanderTimer = 0;
    e.stuck = 0;
  }

  clear() {
    // Copied, because `_finish` splices the list it is walking.
    for (const chain of [...this.runs]) this._finish(chain);
    this.runs.length = 0;
    this.shelves = [];
    this.belts = [];
    this.enabled = false;
  }
}

const FIELD = { fetch: 'fetcher', port: 'porter', fix: 'fixer' };

const pick = (a) => (a.length ? a[(Math.random() * a.length) | 0] : null);

// Scratch for the spark, module-level and reused. Safe because both consumers
// read it synchronously and copy out of it — `effects.impact` does
// `position.copy(point)` and `audio._placed` reads the three components. It is
// deliberately NOT a shared THREE.Vector3: destruction.js documents a real bug
// caused by two call sites sharing one of those, and this one has exactly one
// caller.
const SPARK = { x: 0, y: SPARK_Y, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };

/**
 * The quarter turn that faces a direction.
 *
 * `standAt` in enemies.js turns a station's `rot` into a yaw with
 * `-rot * PI / 2`, and a body at yaw 0 faces -Z (props are authored the same way
 * — see `edgeProp` in gen/rooms.js). So the four rotations point -Z, +X, +Z, -X
 * in order, and this is that table read backwards. A function rather than four
 * cases at each call site for the reason `edgeProp` documents at length: written
 * out by hand it is four coordinates and half of them come out backwards.
 */
function rotToward(dx, dz) {
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 2 : 0;
}
