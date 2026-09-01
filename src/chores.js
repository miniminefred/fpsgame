import * as THREE from 'three';
import { isMachine } from './enemy-types.js';
import { FACING } from './gen/tiles.js';

/**
 * The ordinary work: one body, one machine, a few seconds of doing something.
 *
 * The building already had two pieces of visible work in it and both were
 * exceptional. A parcel run (jobs.js) is three machines and a box, and it only
 * happens on the one floor in seven that runs parcel lines. Lunch is one break
 * per body per floor, in the one room the floor arrives in. Everywhere else, an
 * office of a hundred and seventy people was a hundred and seventy people
 * standing in rooms waiting to be shot — which is what this is for. Somebody is
 * at the copier. Somebody is round the back of a rack with his arms in it.
 * Somebody is getting a can out of the machine in the corridor.
 *
 * SIX JOBS, and the six are the whole design rather than a list that grew:
 *
 *   computer  standing at somebody's monitor, typing
 *   printer   pressing the copier, then taking the paper out of it
 *   vending   pressing the keypad, then bending to the flap
 *   server    hands up among the units at the front of a rack
 *   bench     building something, in the odd shower of sparks
 *   panel     arms into a hole in the wall with the wiring hanging out of it
 *
 * The last one is the machine floor's, because a hole in the wall with the
 * building's wiring in it is a thing an Automated floor has and an ordinary
 * office does not (see panels.js). The other five are everywhere, because a
 * copier is everywhere.
 *
 * THEY ARE DOING IT, NOT PRETENDING TO. Everything here is the errand machinery
 * lunch and the parcel runs already share: `routeTo` floods a field to the
 * station, `advanceTo` walks it, `standAt` turns them to face the thing.
 * Nothing about the walk is new and none of the hard-won parts of it had to be
 * written twice — both halves of the reachability check, the once-only re-flood
 * on a wedge, and the unhurried pace that keeps somebody walking to a job from
 * reading as somebody who has noticed you.
 *
 * WHAT IS NEW IS WHO. Lunch and the parcel runs are both walked by bodies that
 * are out of the state machine — a neutral, or an employee whose visor has gone
 * blue. These are walked by ANYBODY, hostile included, and the hostile is the
 * point: you round a corner and there is a man at the printer with his back to
 * you, and he turns round and shoots. Three things make that safe to promise:
 *
 *   - NOBODY SITS DOWN. A chair in this building means harmless and it is the
 *     one tell the game states before anything is at stake (see the note on
 *     workstations in CLAUDE.md). Every pose here is standing, which is a body
 *     that has made no promise at all — and it is why "work on a computer" is
 *     somebody stood at the end of a desk rather than somebody in its chair.
 *   - THE VISOR IS UNTOUCHED. A break recolours the eyes because a break really
 *     does stop somebody fighting you; this does not, so it must not.
 *   - AND THEY LOOK UP. Sight, hearing, or you simply getting close ends the job
 *     on the spot — see `_choreWork` in enemies.js, which is the half of this
 *     feature that lives over there because it has to run before `_think`.
 *
 * HOST ONLY, like both of the others and for their reason: whose turn it is to
 * use the copier is a runtime decision, so two browsers deciding it would be two
 * different offices. Nothing about it crosses the wire, and nothing needs to —
 * the bodies cross as the positions they already crossed as, and unlike a tray
 * or a crate a working pose is not a claim about what somebody is going to do.
 * A joiner sees them standing where they are standing, which is true.
 */

// The six, and everything that differs between them.
//
//   at     the station name the furnisher publishes them under (see WORK_AT in
//          gen/rooms.js), or 'panel', which panels.js supplies instead
//   pose   the key into CHORE_POSE in enemy-anim.js
//   time   how long the job takes
//   then   an optional second beat, with its own pose and its own clock. Two of
//          them have one, and it is what turns a machine you press into a
//          machine that gives you something: the paper comes out of the copier,
//          the can comes out of the vending machine. Without it both were a man
//          standing at a box prodding it for twenty seconds.
//   spark  what comes off the work, if anything does, and how high
//   weight how often this job is the one that gets picked
//   stay   how many goes somebody has before they leave the machine. See below:
//          it is the difference between an office and a corridor full of people
//          on their way to one, and `vending` has it at 1 because you get your
//          can and you go.
//
// Weighted rather than drawn from the pooled stations, and that is a fix rather
// than a preference: a desk publishes TWO computer spots and a floor has forty
// desks, so a uniform draw over every station on the floor is eighty chances at
// a keyboard against four at a bench. Weighting by JOB asks the question that
// was meant — what is somebody doing — and then finds a machine for it.
const CHORES = {
  computer: { at: 'computer', pose: 'computer', time: [14, 30], weight: 4, stay: [3, 7] },
  printer: {
    at: 'printer', pose: 'printer', time: [8, 17], weight: 3, stay: [2, 4],
    then: { pose: 'printerTake', time: [2.2, 3.6] },
  },
  vending: {
    at: 'vending', pose: 'vending', time: [3.5, 7], weight: 2, stay: [1, 1],
    then: { pose: 'vendingTake', time: [1.8, 3.2] },
  },
  server: { at: 'server', pose: 'server', time: [12, 26], weight: 3, stay: [2, 5] },
  bench: {
    at: 'bench', pose: 'bench', time: [16, 34], weight: 3, stay: [2, 5],
    spark: { y: 1.05, out: 0.55, tick: [0.9, 2.4] },
  },
  panel: {
    at: 'panel', pose: 'panel', time: [16, 34], weight: 4, stay: [2, 5],
    spark: { y: 1.55, out: 0.6, tick: [0.45, 1.1] },
  },
};
const KINDS = Object.keys(CHORES);

// How long before the first job of a floor, and how often somebody else is put
// to work after that.
//
// The first is short because this is the floor's ordinary state rather than an
// event — an office where nobody starts working for a minute is an office that
// was empty when you arrived.
const FIRST = 6;
const TICK = 0.35;

// EVERYBODY WORKS, and this is the valve rather than the cap.
//
// It was eight at once, which was a light sprinkle over a floor of a hundred and
// seventy and was defended as one: what makes an office read as worked is
// finding somebody at a machine in the room you walked into, not finding
// everybody at one. That is a fine argument about the other hundred and sixty
// two people if they have something else to be doing, and they did not — they
// stood in their rooms waiting to be shot. So the floor now fills up: anybody
// who can reach a free machine is sent to one, and whoever is left over takes
// their break instead (see `update`). Nobody is idle who has a choice.
//
// The supply is there. Measured over floors 1, 4 and 8: 125, 109 and 246
// stations against 30, 40 and 193 bodies eligible to stand at one, so the office
// runs out of people before it runs out of machines.
//
// What is capped is the WALKING, because that is the only stage that costs
// anything. A body en route holds a distance field — 548 KB on a deep floor —
// and spends a flood to get it, while a body standing at a machine holds nothing
// (`standAt` gives the field back, see `dropField` in enemies.js). So this is
// how fast the floor fills, not how full it gets: at 24 walkers and a 15-second
// walk it puts somebody new to work about every two thirds of a second, and the
// floor is at work inside a couple of minutes without ever holding more than
// ~13 MB of routes.
// A STAY is several goes at one machine, and it is what makes the floor
// affordable rather than what makes it look busy.
//
// Keeping N people at machines needs them to arrive at N / (time per visit), and
// every one of those arrivals is a walk — so the number of people COMMUTING at
// any moment is that rate times how long a walk takes. With a visit of twenty
// seconds, keeping a floor of 194 at work means 62 of them are permanently in
// transit: measured, and it is both 45 MB of live routes and an office where a
// third of the staff is walking somewhere. Lengthening a single job would have
// fixed the arithmetic and broken the jobs — a man printing one document for a
// minute and a half. Several goes at the same machine is the same arithmetic and
// the truth about offices: you do not go to the copier once.
//
// It costs nothing at all. A repeat is a new pose and a new clock at a station
// the body is already standing at — no cast, no flood, no field, no walk.
const MAX_WALKING = 28;
const PER_TICK = 3;

// The backstop on a walking stage. Generous for the reason lunch's is: a walk
// from one end of a deep floor to the other took a body fifty seconds at errand
// pace, and a job that quietly never ends is a body standing at a copier for the
// rest of the floor.
const WALK_CAP = 100;

export class Chores {
  constructor({ enemies, effects, audio }) {
    this.enemies = enemies;
    this.effects = effects;
    this.audio = audio;
    this.nav = null;

    this.pools = new Map();   // kind -> the stations it can be done at
    this.busy = new Set();    // ...and the ones somebody is standing at
    this.live = [];           // bodies currently on one
    this.timer = FIRST;
    this.enabled = false;

    // The seam into enemies.js, and the whole of it. Two hooks rather than
    // sharing the parcel runs' pair, because a callback slot has one occupant
    // and a second consumer of one is how the first quietly stops being called.
    enemies.choreTick = (e, dt, audio) => this._tick(e, dt, audio);
    enemies.choreLost = (e) => this.lost(e);

    // `descendOn` RETURNS `out.set(...)`, so the probe below needs a real
    // Vector3 to write into even though nothing here reads what it wrote — a
    // stub whose `set` returns nothing reads back as "no route" and casts
    // nobody, silently. Same trap jobs.js documents.
    this._v = new THREE.Vector3();
    this._field = null;
  }

  /**
   * Collects this floor's machines.
   *
   * Called after `enemies.spawn`, which is what builds the station pools — every
   * one of them already filtered through `nav.fitsAt`, so a printer jammed into
   * a corner nobody can stand at was dropped before it got here (see `deskPool`
   * in enemies.js, which paid for that rule the hard way). `panels` is the one
   * source that does not come down that pipe: its openings are fitted into a
   * finished floor like the parcel lines, so it hands its own spots over.
   */
  spawn(nav, enemies, panels) {
    this.clear();
    this.nav = nav;
    this._field = null;

    for (const kind of KINDS) {
      const at = CHORES[kind].at;
      const from = at === 'panel' ? (panels?.spots ?? []) : (enemies.stations?.get(at) ?? []);
      if (from.length) this.pools.set(kind, from);
    }
    // Nothing to do on a floor with no machines anybody can stand at, which is
    // not a case that should happen and is cheap to be right about.
    this.enabled = this.pools.size > 0;
    this.timer = FIRST;
  }

  // ---------------------------------------------------------------- casting

  update(dt) {
    if (!this.enabled || this.enemies.puppet) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = TICK;

    // Only the ones still on their way count against the valve — see MAX_WALKING.
    let walking = 0;
    for (const e of this.live) if (e.chore?.stage === 'to') walking++;

    let room = Math.min(PER_TICK, MAX_WALKING - walking);
    while (room-- > 0) {
      if (this._start()) continue;
      // Nothing could be cast, which means one of two things and the same answer
      // serves both: every machine of its kind is taken, or nobody left standing
      // about can reach one. Either way the person who would have worked has
      // nothing to work at, and the honest thing for somebody with nothing to do
      // in an office is to go and have their lunch. It is the canteen that bounds
      // how many manage it — there are only so many chairs — and anybody it turns
      // away goes on standing where they are, which is the old behaviour and now
      // the last resort rather than the default.
      this.enemies.sendToBreak?.();
      break;
    }
  }

  /**
   * Sends one body to one machine, or does not. Every failure is silent and
   * costs nothing but this turn — and it is REPORTED, because `update` reads a
   * failure as "there is no work here" and sends somebody for their break
   * instead.
   *
   * The station is chosen before the body, exactly as a parcel run's stops are,
   * because the question "who can reach this" needs a this — and because it is
   * one flood of the floor rather than one per candidate. The field from a fixed
   * point is the same field whoever is asking, which is a lesson this game has
   * had to learn in three separate files.
   *
   * Worth knowing what this looks like over a floor, because it MOVES: almost
   * every machine in the building is inside a room with a badged door, and a
   * badged door is out of the nav grid entirely — so with nothing in your pocket
   * the only people who can get to a copier are the ones already in the
   * corridors, and one white card opens a hundred and ninety doorways and puts
   * the whole building back to work. The office starts working once the office
   * has been opened, which is the same property the lunch cycle turned out to
   * have and which nobody wrote either time.
   */
  _start() {
    const kind = this._pickKind();
    if (!kind) return false;
    const station = this._pickStation(kind);
    if (!station) return false;

    const worker = this._cast(station);
    if (!worker) return false;

    this.busy.add(station);
    this.live.push(worker);
    const stay = CHORES[kind].stay;
    worker.chore = {
      kind, station, stage: 'to', pose: null,
      timer: WALK_CAP, work: 0, tick: 0,
      stay: stay[0] + ((Math.random() * (stay[1] - stay[0] + 1)) | 0),
    };
    this.enemies.routeTo(worker, worker.chore, station, WALK_CAP);
    return true;
  }

  /** One of the six, by weight, out of whichever ones this floor can offer. */
  _pickKind() {
    let total = 0;
    for (const kind of KINDS) {
      if (this._free(kind)) total += CHORES[kind].weight;
    }
    if (!total) return null;
    let roll = Math.random() * total;
    for (const kind of KINDS) {
      if (!this._free(kind)) continue;
      roll -= CHORES[kind].weight;
      if (roll <= 0) return kind;
    }
    return null;
  }

  /** Whether this floor has a machine of this kind nobody is already at. */
  _free(kind) {
    const pool = this.pools.get(kind);
    if (!pool) return false;
    for (const station of pool) if (!this.busy.has(station)) return true;
    return false;
  }

  /**
   * A machine of this kind nobody is standing at.
   *
   * Walked from a random start rather than scanned from the front, so the same
   * copier is not the one everybody uses — the pool comes out of the furnisher
   * in the order the rooms were filled, and taken in order the nearest corner of
   * the building would do all the work on the floor. Same argument `deskPool`
   * makes for shuffling a room's desks.
   */
  _pickStation(kind) {
    const pool = this.pools.get(kind);
    const start = (Math.random() * pool.length) | 0;
    for (let i = 0; i < pool.length; i++) {
      const station = pool[(start + i) % pool.length];
      if (!this.busy.has(station)) return station;
    }
    return null;
  }

  /**
   * The nearest body that could actually get there.
   *
   * One flood, then one pass over the roster reading it — never a flood per
   * candidate. BOTH halves are checked, which is the whole of it: a field that
   * reached the machine says nothing about whether it reached the body, and
   * before the first white card most of the roster is behind a door that is not
   * on the grid at all.
   *
   * NEAREST, and that turned out to matter far more than it sounds. This used to
   * reservoir-sample one body uniformly out of everybody who could reach the
   * machine, which is a fine way to pick one of eight and a terrible way to pick
   * a hundred and ninety: a floor is 70 m across, so a uniform draw sends people
   * on 30-to-77 m walks at errand pace and the office fills up at about one
   * person every two and a half seconds. Measured on floor 8, 194 eligible
   * bodies: the walkers pinned the valve at 24 and THREE of them had arrived
   * anywhere after forty seconds. It also read wrong at any speed — somebody
   * marching the length of the building past four free copiers to use the fifth.
   *
   * The distance is free: it is the value already sitting in the field under the
   * body, which is why `distanceOn` exists in nav.js. Ties go to whoever is found
   * first, and the shuffled station pick above is what keeps that from always
   * being the same corner of the building.
   */
  _cast(station) {
    if (!this.nav) return null;
    this._field ??= this.nav.makeField();
    if (!this.nav.floodTo(this._field, station.x, station.z)) return null;

    let best = null;
    let bestD = Infinity;
    for (const e of this.enemies.items) {
      if (!this._eligible(e)) continue;
      // `descendOn` is the reachability half and it is asked FIRST: a distance
      // can be read off a tile a body cannot actually set off from.
      if (!this.nav.descendOn(this._field, e.x, e.z, this._v)) continue;
      const d = this.nav.distanceOn(this._field, e.x, e.z, e.layer);
      if (d < 0 || d >= bestD) continue;
      bestD = d;
      best = e;
    }
    return best;
  }

  /**
   * Whether this body is free to go and do something.
   *
   * HUMANS ONLY, and that is two rules in one test. `rig === 'human'` is about
   * the pose: every joint in CHORE_POSE is a measurement off the human rig, so a
   * chassis sent to a copier would arrive with its arms hanging off it — the
   * same guard `animateFixing` carries. `isMachine` is about the fiction, and it
   * catches the Legacy Unit, which is built on the human rig precisely so that
   * it reads as staff from the far end of a corridor and is not: a robot getting
   * a can out of a vending machine is `_lunchOk` sending one to the canteen,
   * which is the bug that put `isMachine` in the game in the first place.
   *
   * The other two exclusions are `_lunchOk`'s as well. The Reanimated are off
   * the payroll, and an Infestation floor is four fifths of them — which is the
   * right answer twice over: a floor that has been overrun is not a floor doing
   * its filing. And the toilet guy is a running gag with somewhere to be.
   *
   * The state test is what keeps this out of a fight. `idle` is a hostile
   * standing in its room and `wander` is a neutral walking the corridors; every
   * other state means they are already dealing with you.
   */
  _eligible(e) {
    return e.alive && e.rig === 'human' && !isMachine(e.type)
      && !e.type.panic             // the toilet guy has a bit, and this is not it
      && !e.type.undead            // ...and this one is off the payroll
      && !e.chore && !e.job && !e.break && !e.seat
      && !e.behindLock && !e.offMap && !e.keyed
      && e.flee <= 0
      && (e.state === 'idle' || e.state === 'wander')
      && e.layer === 0;
  }

  // ----------------------------------------------------------------- a frame

  /**
   * One frame of one body's job. Called from `update` in enemies.js in place of
   * `_move` or `_wander`, so this owns where the body goes for as long as it
   * lasts.
   */
  _tick(e, dt, audio) {
    const c = e.chore;
    if (!c) return;

    // The backstop, in one place so no stage can forget it — and also how a
    // failed flood reports itself, since `routeTo` and `advanceTo` both spend
    // the timer when there is no route (see enemies.js).
    c.timer -= dt;
    if (c.timer < 0) { this.lost(e); return; }
    if (c.work > 0) c.work -= dt;

    const job = CHORES[c.kind];
    switch (c.stage) {
      case 'to':
        if (!this.enemies.advanceTo(e, c, dt, c.station)) return;
        // The last stretch onto the spot is walked straight rather than on the
        // field, for the reason a chair needed it: a flow field walks to tile
        // centres and a machine is not at one, so arriving "close enough" left
        // every body a metre from the thing it had come to use.
        if (!this.enemies.closeOnto(e, dt, c.station)) return;
        this._begin(e, job.pose, job.time);
        return;

      case 'work':
        if (job.spark) this._spark(e, dt, job.spark, audio);
        if (c.work > 0) return;
        // The beat that says the machine did something, for the two that have
        // one. Everything else is finished the moment its clock runs out.
        if (job.then) { this._begin(e, job.then.pose, job.then.time); c.stage = 'then'; return; }
        this._done(e, job);
        return;

      case 'then':
        if (c.work <= 0) this._done(e, job);
        return;

      default:
        this.lost(e);
    }
  }

  /**
   * One go finished. Another one, or leave the machine.
   *
   * The repeat is free — the body is already standing there, so there is no
   * cast, no flood and no walk — which is the whole reason it is here. See the
   * note on `stay`.
   */
  _done(e, job) {
    const c = e.chore;
    if (--c.stay > 0) { c.stage = 'work'; this._begin(e, job.pose, job.time); return; }
    this.lost(e);
  }

  /** Stop, face the machine, hold a pose, and take a while over it. */
  _begin(e, pose, span) {
    const c = e.chore;
    this.enemies.standAt(e, c.station);
    c.stage = c.stage === 'to' ? 'work' : c.stage;
    c.timer = WALK_CAP;
    c.work = span[0] + Math.random() * (span[1] - span[0]);
    c.tick = 0;
    // Through `setChorePose` rather than by assignment, because clearing it has
    // to put the limbs and the stoop back and the two must be one operation.
    this.enemies.setChorePose(e, pose);
  }

  /**
   * What comes off a bench or a wall panel while it is being worked on.
   *
   * `effects.impact` is the pooled flash every bullet already uses, so this
   * allocates nothing, and `audio.generatorArc` is the one clip in the set built
   * to be asked for two or three times a second at close range and to sit UNDER
   * a fight rather than on top of it. Both are jobs.js's choice for the belt
   * repair and both are right here for its reasons.
   *
   * The flash goes at the MACHINE rather than at the body: the station is a
   * standoff back from the thing, and sparks coming off somebody's chest is a
   * man on fire.
   */
  _spark(e, dt, spark, audio) {
    const c = e.chore;
    c.tick -= dt;
    if (c.tick > 0) return;
    c.tick = spark.tick[0] + Math.random() * (spark.tick[1] - spark.tick[0]);

    // The direction the body is facing, off the station's own quarter turn —
    // the same conversion `standAt` makes, read back out. A station's rot names
    // which way it faces in the four-way table props are authored on, and 0
    // faces -Z.
    const [fx, fz] = FACING[c.station.rot & 3];
    AT.x = c.station.x + fx * spark.out;
    AT.y = spark.y;
    AT.z = c.station.z + fz * spark.out;
    this.effects?.impact(AT, DOWN, 0xfff0c0, 0.6);
    (audio ?? this.audio)?.generatorArc?.(AT);
  }

  // ---------------------------------------------------------------- endings

  /**
   * This body is off the job, however it happened: finished, shot, killed,
   * startled, or wedged. Called from `_damage`, `_die` and `_choreWork` in
   * enemies.js as well as from here.
   */
  lost(e) {
    const c = e?.chore;
    if (!c) return;
    // Before anything else, because it is what puts the arms down and lifts the
    // body out of its stoop — a release that skipped it would leave somebody
    // walking the rest of the floor bent over a bench that is not there.
    this.enemies.setChorePose(e, null);
    this.busy.delete(c.station);
    e.chore = null;

    const i = this.live.indexOf(e);
    if (i >= 0) this.live.splice(i, 1);
    if (!e.alive) return;

    // Back to the day they were having. A neutral goes to `wander` with a spent
    // timer so the next tick picks somewhere new — the same thing `_repick` does
    // for one that has been shot at — and a hostile goes back to standing in its
    // room, which is what `idle` is. Whoever startled them is about to have
    // `_think` run on this body anyway, and that is what turns idle into a
    // fight.
    e.state = e.neutral ? 'wander' : 'idle';
    e.wanderTimer = 0;
    e.stuck = 0;
  }

  clear() {
    for (const e of [...this.live]) this.lost(e);
    this.live.length = 0;
    this.pools.clear();
    this.busy.clear();
    this.enabled = false;
  }
}

// Scratch for the spark, module-level and reused. Safe because both consumers
// read it synchronously and copy out of it, and deliberately not a shared
// THREE.Vector3: destruction.js documents a real bug caused by two call sites
// sharing one of those, and this one has exactly one caller.
const AT = { x: 0, y: 0, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };
