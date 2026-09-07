// Lunch, and the other kind of break.
//
// A canteen break is a queue, a tray and a meal; a break room is ten minutes on
// a sofa. The second is the first with three stages taken out of it, and both are
// walked with the primitives in stations.js — `routeTo`, `advanceTo`, `standAt` —
// which the parcel runs and the chores share.
//
// What makes it more than scenery is who joins. An ordinary employee downs tools,
// its visor goes to the canteen blue, it walks the whole cycle, and its own colour
// comes back as it leaves the room. That is the only thing in this game that
// recolours a visor at runtime, so the promise it makes has to stay exactly true
// in both directions — see `_lunchLook`, and `_damage`, which ends a break on the
// frame somebody stops being harmless.

import { BODY_RADIUS as RADIUS } from './nav.js';
import { isMachine, TYPES } from './enemy-types.js';
import { angleLerp, smoothTo } from './util.js';
import { LUNCH_PACE, SEAT_HIGH, SEAT_LOW } from './enemy-tuning.js';

// Lunch, and the shape of a break. See the block above `_sendToLunch`.
//
// LUNCH_MAX is employees away from their post at once, and it is deliberately a
// handful: the point of a break is that you catch somebody at one, and a canteen
// with a queue out of the door is a floor that has stopped being an office. What
// bounds the total in the room is the chairs — `_lunchStart` takes one out of
// the same pool the arrival diners came from and cannot start without it.
const LUNCH_MAX = 4;

const LUNCH_DARTS = 24;        // tries at finding a willing body — see _sendToLunch

// How often a break is taken in a BREAK ROOM rather than the canteen.
//
// A little over half, and it is a coin rather than a preference for two reasons.
// There are many more break rooms than canteens on a floor — measured at
// fourteen against one — so a break room is the nearer of the two for almost
// everybody, and weighting by distance would empty the canteen. And the two are
// different lengths: lunch is a queue, a tray and a meal, where a rest is ten
// minutes on a sofa, so an even-ish split is what keeps both rooms occupied.
const REST_SHARE = 0.55;

// ...but NOT near enough to a chair, and that is a different number for a
// reason. A flow field walks to tile centres and a chair is not at one, so the
// walk finishes wherever the last tile put them — measured over 46 seatings,
// EVERY body that walked to lunch sat down 0.98 to 1.09 m from its chair, which
// is a metre of daylight between somebody and the thing they are sitting on.
// The field gets them to the chair and `_settleOnto` takes the last metre in a
// straight line, which is open room floor by construction: the furnisher only
// offers a station a whole body fits in front of (see deskPool).
const SEAT_SNAP = 0.06;

// Any walking stage that takes longer than this is abandoned and the body goes
// back to work where it stands. It is a backstop rather than a timeout anybody
// should reach: a break that quietly never ends is a body that is harmless for
// the rest of the floor and still has to be killed to clear it.
//
// Generous on purpose. Measured on a deep floor, a walk from an office at one
// end of the building to the counter took a Security fifty seconds at lunch
// pace — so a cap that merely looked comfortable was cutting real journeys
// short, and a body that gives up half way to the canteen goes back to work in
// the middle of a corridor for no reason the player can see.
const LUNCH_STAGE_CAP = 100;

const SERVE_TIME = [2.5, 5];   // at the counter, being served

const EAT_TIME = [40, 90];     // at the table

const EAT_FIRST = [70, 150];   // ...and the arrival canteen's longer first sitting

const DROP_TIME = [1.5, 3];    // putting the tray back

// The canteen blue, taken off the type that wears it permanently rather than
// written down twice: what "on a break" looks like is one colour in this
// building, and a second copy of it is a second colour within a week.
const BREAK_VISOR = TYPES.diner.visor;

/**
 * Mixed onto `Enemies.prototype` by enemies.js — see the note beside
 * `Object.defineProperties` at the bottom of that file for why these are
 * methods in an object rather than functions taking the roster.
 */

export const breakMethods = {
    get _atLunch() {
      let n = 0;
      for (const e of this.items) if (e.alive && e.break && !e.neutral) n++;
      return n;
    }

    /**
     * Somebody decides it is lunchtime BECAUSE there is nothing else to do.
     *
     * chores.js calls this when it could not put anybody to work — every machine
     * of every kind taken, or nobody left standing about who can reach one. That
     * is the only difference from the clock below: the office empties into the
     * canteen when the office is full, rather than only on the timer. Everything
     * that bounds a break still bounds this one, and the chairs are the real
     * bound — `_lunchStart` cannot start without one, so a floor never puts more
     * people in the canteen than the canteen has seats, and anybody it turns away
     * goes on standing where they were.
     */,

    sendToBreak() {
      if (this.puppet) return;
      this._sendToLunch();
    }

    /**
     * Every so often, somebody decides it is lunchtime.
     *
     * Sampled rather than filtered: the roster is two hundred people and this runs
     * every twenty seconds or so, so a couple of dozen darts at it is both cheaper
     * and no worse — failing simply means nobody went this time, and somebody goes
     * on the next one.
     *
     * Runtime dice are `Math.random`, never the floor's own seeded stream, for the
     * reason `_repick` and `_damage` already are: that stream is what the floor was
     * built from and what an alarm response still rolls off, and spending it on
     * whose turn it is at the counter would move both.
     */,

    _sendToLunch() {
      if (this._atLunch >= LUNCH_MAX) return;
      // TWO PLACES TO TAKE A BREAK, and which one is a coin rather than a
      // preference: a canteen is a meal and a break room is ten minutes on a sofa,
      // and a floor where everybody does the same one is a floor with one of them
      // standing empty. The break room is tried first when the coin says so and
      // both fall through to the other, so a floor with no canteen still sends
      // people for a break and a floor with no break room still feeds them.
      const rest = this.lounges?.size && Math.random() < REST_SHARE;
      if (rest && this._sendToRest()) return;
      if (this._sendToCanteen()) return;
      if (!rest) this._sendToRest();
    }

    /**
     * A break in a break room: walk in, sit down, sit there, walk out.
     *
     * The same cycle as lunch with the counter and the tray taken out of it, which
     * is why it is the same stage machine and not a second one — `toseat`, `eat`
     * and `leave` are already exactly this, and every hard-won thing in them
     * applies unchanged: the last metre walked straight onto the chair, the seat
     * handed back the moment they stand, the visor, and `_seatGone` standing them
     * up if somebody shoots the sofa.
     *
     * What it is NOT is a chore. A break means a specific thing in this game —
     * the body stops being able to fight you and its visor says so — and that is
     * as true of ten minutes on a sofa as it is of lunch. The machines' version of
     * the same room is the dock, and that one IS a chore, for the opposite reason:
     * see `charge` in chores.js.
     */,

    _sendToRest() {
      // One room, chosen first, because everybody in the field has to be able to
      // reach the SAME sofa — the flood is to a point, not to a room.
      const rooms = [...this.lounges.keys()];
      if (!rooms.length) return false;
      const room = rooms[(Math.random() * rooms.length) | 0];
      const free = this.lounges.get(room);
      if (!free?.length) return false;
      const seat = free[(Math.random() * free.length) | 0];

      // Flooded to where they get OFF the sofa rather than to the sofa, because a
      // seat you sit on top of is a blocked tile and there is no route to one. The
      // last half metre onto the cushion is `_settleOnto`'s, exactly as the last
      // metre onto a canteen chair is.
      const to = seat.step ?? seat;
      this._lunchField ??= this.nav.makeField();
      if (!this.nav.floodTo(this._lunchField, to.x, to.z)) return false;

      const n = this.items.length;
      for (let tries = 0; tries < LUNCH_DARTS && n; tries++) {
        const e = this.items[(Math.random() * n) | 0];
        if (!this._lunchOk(e)) continue;
        if (!this.nav.descendOn(this._lunchField, e.x, e.z, this._v)) continue;
        // Claimed here, for `_lunchStart`'s reason: two people dealt one sofa is
        // two bodies sitting in each other.
        // IS THE SOFA STILL THERE, and nothing else — which is two departures from
        // the canteen's version of this test and both are about sitting ON a thing
        // rather than at one.
        //
        // `_looseAt` is what a canteen chair is checked with, and a sofa is a
        // FITTED prop, so it would never find one and every seat in the building
        // would be refused. `_boxAt` asks both lists, which is what `machineAhead`
        // already does for the same reason.
        //
        // And `nav.clear` is dropped. It asks whether a body can stand at this
        // exact point, and the point is on top of a sofa — so it is false for every
        // lounge seat there has ever been. What has to be walkable is where they
        // get OFF, and `sittable` proved that when the pool was built.
        const took = this._takeDesk(room,
          (x, z) => !!this._boxAt(x, z, SEAT_LOW, SEAT_HIGH), this.lounges);
        if (!took) return false;
        e.break = { rest: true, stage: 'toseat', at: took, seat: took, room, timer: LUNCH_STAGE_CAP };
        this._lunchLook(e, true);
        // Walked to the step-off tile, not to the cushion: `routeTo` floods to the
        // point it is given and there is no route to a tile inside a sofa. The
        // last half metre onto the seat is `_settleOnto`'s, which is the same
        // division of labour a canteen chair already has — the field gets you to
        // the tile, the straight walk gets you onto the furniture.
        this._lunchGo(e, took.step ?? took, 'toseat');
        return true;
      }
      return false;
    },

    _sendToCanteen() {
      if (!this.servery?.length || !this.trayRack) return false;

      // Can anybody get there, and who? Flooded ONCE from the counter into a
      // field of the module's own and then read for each candidate, rather than
      // per dart: the field from a fixed point is the same field whoever is
      // asking, and two dozen floods of a ten thousand tile floor every twenty
      // seconds to answer one question is the shape of loop this file has been
      // caught writing three times.
      //
      // The answer moves over a floor, and that is the interesting part. Measured
      // on floor 3: with nothing in your pocket **5 of 79** staff can reach the
      // canteen — the ones already in the corridors — because a badged door is out
      // of the nav grid entirely. Take one white card, 170 doorways hand their
      // openings back, and it is **77 of 79**. So the building goes to lunch once
      // the building has been opened, which is not a rule anybody wrote.
      const counter = this.servery[(Math.random() * this.servery.length) | 0];
      this._lunchField ??= this.nav.makeField();
      if (!this.nav.floodTo(this._lunchField, counter.x, counter.z)) return false;

      const n = this.items.length;
      for (let tries = 0; tries < LUNCH_DARTS && n; tries++) {
        const e = this.items[(Math.random() * n) | 0];
        if (!this._lunchOk(e)) continue;
        // Asked BEFORE anything is committed. A body that cannot reach the canteen
        // today may well be able to in a minute, so it must not be marked as
        // having had its break — which is what starting one and failing would do,
        // and it would quietly take nine tenths of the floor out of the running
        // before the player had opened a single door.
        if (!this.nav.descendOn(this._lunchField, e.x, e.z, this._v)) continue;
        if (this._lunchStart(e, counter)) return true;
      }
      return false;
    }

    /**
     * Whether this one may go for lunch at all.
     *
     * `layer === 0` is the sharp one and it is a limit rather than an oversight:
     * the walk is `_stroll` on a field flooded to a point, which is the neutrals'
     * own machinery and has always been ground-floor shaped. Somebody in an attic
     * stays in their attic, which is the honest answer rather than a body that
     * sets off downstairs and gets stuck on a landing.
     */,

    _lunchOk(e) {
      return e.alive && !e.neutral && !e.behindLock && !e.break && !e.seat
        && !e.lunchDone              // one break a floor
        && !e.chore                  // ...and nor is anybody already at a machine
        && !isMachine(e.type)        // a machine has nowhere to put it
        && !e.type.undead            // ...and this one is off the payroll
        && !e.keyed                  // an alarm response is not going for lunch
        && e.state === 'idle'        // ...and neither is anybody already in a fight
        && e.layer === 0;
    }

    /**
     * Sends one body off on the cycle. Returns false if the canteen cannot take
     * them, which is a perfectly ordinary answer: every chair may be full.
     *
     * The seat is claimed HERE rather than when they arrive at the table, and that
     * is the same argument `_takeDesk` makes for everybody else — two people dealt
     * one chair is two bodies eating the same lunch. It costs a chair being held
     * by somebody still queueing, which is what a tray on a table means anyway.
     */,

    _lunchStart(e, counter) {
      const room = this.layout?.cafeteriaRoom;
      if (!room) return false;

      // A chair that has been shot apart or shoved across the room is not a free
      // seat, and this is the one place to say so: the station goes back into the
      // pool when a break ends whatever became of the chair, so it is on the way
      // OUT that it has to be checked rather than on the way in. Without it the
      // next person to come down for lunch sits in the hole the last one's chair
      // left.
      const seat = this._takeDesk(room,
        (x, z) => this.nav.clear(x, z, RADIUS) && !!this._looseAt(x, z), this.tables);
      if (!seat) return false;

      e.break = { stage: 'go', at: null, seat, timer: LUNCH_STAGE_CAP };
      this._lunchLook(e, true);
      this._lunchGo(e, counter, 'go');
      return true;
    },

    /** Already at a table with their lunch in front of them: the arrival canteen. */
    _lunchSeated(e, seat, rng) {
      e.break = {
        stage: 'eat', at: null, seat,
        // A longer first sitting than anybody who arrives later gets. The room the
        // floor opens in is a picture before it is a process, and four people who
        // stand up and file out inside a minute is the picture gone before the
        // player has finished reading it.
        timer: rng.range(EAT_FIRST[0], EAT_FIRST[1]),
      };
      // `idle` is what keeps them in the chair, and it has to be said HERE as well
      // as at the end of the walk: every neutral is spawned into `wander`, and the
      // animator stands up any seated body whose state is anything else. Without
      // it the whole canteen was out of its chairs on the first frame — which is
      // the same bug `_wander` documents, one caller further along.
      e.state = 'idle';
      this._lunchLook(e, true);
      this._giveTray(e);
    }

    /**
     * One frame of somebody's break. Runs instead of the state machine, not
     * beside it — see the note above.
     */,

    _lunch(e, dt, audio) {
      const b = e.break;
      b.timer -= dt;

      // Lunch is where the building does its talking. Same cadence as the idle
      // grumble everywhere else, off the same timer.
      e.voiceTimer -= dt;
      if (e.voiceTimer <= 0) {
        e.voiceTimer = 7 + Math.random() * 11;
        audio.enemyIdle(e);
      }

      switch (b.stage) {
        case 'go':
          // Out of the office and into the queue.
          if (b.timer < 0) { this._lunchEnd(e); return; }
          if (this._lunchWalk(e, dt, b.at)) {
            this._lunchStand(e, b.at, 'collect', SERVE_TIME);
          }
          return;

        case 'collect':
          // Being served. The tray arrives at the END of it, because what is being
          // waited for is the food.
          if (b.timer > 0) return;
          this._giveTray(e);
          this._lunchGo(e, b.seat, 'toseat');
          return;

        case 'toseat':
          if (b.timer < 0) { this._lunchEnd(e); return; }
          // Two legs to it: the field to the chair, then the last metre onto it.
          // `b.at` is where the WALK ends and `b.seat` is what they sit on, and for
          // every seat but a sofa they are the same point (see `_sendToRest`).
          //
          // Both the field and the straight walk end at `b.at`, and that is not an
          // oversight: a body is 0.8 m across and a sofa is 0.9 m deep, so a
          // kinematic body can never occupy one — `_settleOnto` moves through
          // `_tryMove`, which the sofa's own collider stops dead, and it would
          // slide along the front of it until the stage cap ran out. Which is
          // exactly what it did: eight rest breaks walked to a sofa and not one of
          // them sat down. So the walk finishes on the floor in front and `_seat`
          // closes the last half metre by putting them on the cushion, which is
          // both what sitting down is and the one move in this file that is
          // allowed to ignore a collider.
          if (this._lunchWalk(e, dt, b.at) && this._settleOnto(e, dt, b.at)) {
            this._seat(e, b.seat, b.rest ? 'lounge' : 'table');
            // `idle` is what keeps them in the chair: the animator stands up any
            // seated body whose state is anything else (see `animate` in
            // enemy-anim.js), which is the same trap `_wander` documents.
            e.state = 'idle';
            b.stage = 'eat';
            b.timer = EAT_TIME[0] + Math.random() * (EAT_TIME[1] - EAT_TIME[0]);
          }
          return;

        case 'eat':
          if (b.timer > 0) return;
          // Up, and the chair goes back in the pool for the next one. Setting
          // `wander` is the whole of standing up and this must not clear `e.seat`
          // itself: `stand` in enemy-anim.js is the only thing that puts the hips
          // and shoulders back, and a body that left its chair any other way
          // carries the chair's joints around the floor for the rest of the run.
          e.state = 'wander';
          this._stepOffSeat(e, b.seat);
          this._freeDesk(b.seat, b.room);
          b.seat = null;
          // A rest break has no tray to take back, so the two stages that are
          // about one are skipped entirely and it goes straight out of the room.
          if (b.rest) {
            this._repick(e);
            this._lunchGo(e, { x: e.wanderX, z: e.wanderZ }, 'leave');
            return;
          }
          this._lunchGo(e, this.trayRack, 'return');
          return;

        case 'return':
          if (b.timer < 0) { this._lunchEnd(e); return; }
          if (this._lunchWalk(e, dt, this.trayRack)) {
            this._lunchStand(e, this.trayRack, 'drop', DROP_TIME);
          }
          return;

        case 'drop':
          if (b.timer > 0) return;
          this._takeTray(e);
          // Somewhere out of the canteen. `_repick` is the neutrals' own pick and
          // it prefers corridors, which is exactly right here: the canteen is a
          // room, so every corridor tile on the floor is out of it.
          this._repick(e);
          this._lunchGo(e, { x: e.wanderX, z: e.wanderZ }, 'leave');
          return;

        case 'leave':
        default:
          // Back on the clock the moment they are out of the room, which is the
          // one thing about this that had to be true: the eyes change where the
          // player can see it happen, and never in the room they arrived in.
          if (b.timer < 0 || !this._inRoom(b.room ?? this.layout.cafeteriaRoom, e.x, e.z)) {
            this._lunchEnd(e);
            return;
          }
          this._lunchWalk(e, dt, b.at);
      }
    }

    /**
     * ------------------------------------------------------------------------
     * The errand primitives, shared by the lunch cycle and by jobs.js.
     * ------------------------------------------------------------------------
     *
     * A break and a parcel run are the same shape of thing: a body that is out of
     * the state machine entirely, walking a list of places and pausing at each.
     * The WALKING half of that was written for lunch and is not about lunch, so it
     * lives here under names that do not mention it and both callers drive it.
     *
     * An errand is any object carrying `{ at, timer }`. Stages belong to the
     * caller, because that is the only part that differs — and deliberately so:
     * one shared stage machine with two vocabularies in it is how the next thing
     * that walks somewhere ends up with a `stage: 'eat'` in it.
     */,

    // Standing at the counter for a moment, turned to face it.
    _lunchStand(e, at, stage, span) {
      this.standAt(e, at);
      e.break.stage = stage;
      e.break.timer = span[0] + Math.random() * (span[1] - span[0]);
    },

    // Points this one at their next stop. The stage is the lunch cycle's own; the
    // routing is `routeTo` above.
    _lunchGo(e, to, stage) {
      e.break.stage = stage;
      this.routeTo(e, e.break, to, LUNCH_STAGE_CAP);
    },

    _lunchWalk(e, dt, to) {
      return this.advanceTo(e, e.break, dt, to);
    }

    /**
     * The last metre onto a chair, walked in a straight line rather than on the
     * field. True once they are on it.
     *
     * `_tryMove` rather than an assignment, so the same collision the rest of the
     * walk uses still applies — and if it cannot make ground the body sits anyway,
     * because `_seat` puts it exactly on the station regardless and a body wedged
     * beside its own chair for the length of the stage cap is the worse outcome.
     */,

    _settleOnto(e, dt, at) {
      const dx = at.x - e.x, dz = at.z - e.z;
      const gap = Math.hypot(dx, dz);
      if (gap < SEAT_SNAP) return true;

      const step = this.tuning.speed * e.type.speed * LUNCH_PACE * dt;
      const k = Math.min(1, step / gap);
      const moved = this._tryMove(e, dx * k, 0) | this._tryMove(e, 0, dz * k);
      e.group.position.set(e.x, e.y, e.z);
      e.yaw = angleLerp(e.yaw, Math.atan2(-dx, -dz), smoothTo(9, dt));
      e.group.rotation.y = e.yaw;
      return !moved;
    }

    /**
     * The break is over, however it ended: finished, given up on, or shot at.
     *
     * Everything it hands back has to be handed back exactly once — the chair, the
     * tray, the visor and the sidearm — which is why every path out of a break
     * goes through here rather than unwinding itself.
     */,

    _lunchEnd(e) {
      if (!e.break) return;
      e.lunchDone = true;
      // Off the sofa before anything else looks at where they are. A break that
      // ends early — shot at, or simply run out of time in the chair — leaves a
      // body standing on a tile it cannot route away from, and the next thing that
      // happens to it is a chase.
      if (e.break.seat) {
        this._stepOffSeat(e, e.break.seat);
        this._freeDesk(e.break.seat, e.break.room);
      }
      e.break = null;
      this._takeTray(e);
      this._lunchLook(e, false);

      // Out of the chair if they were still in one, joints and all — see
      // `_standUp`. It used to be done by leaving them in a state the animator
      // would stand them up out of, which worked for every way a break could end
      // until one of them was "the chair is not there any more": that path has to
      // stand somebody up who is `idle` and staying `idle`, and idle is exactly
      // the state the animator holds the pose through.
      if (e.seat) { this._standUp(e); e.state = e.neutral ? 'wander' : 'idle'; }
      else if (e.state === 'wander' && !e.neutral) e.state = 'idle';
    }

    /**
     * Off a seat that is sitting ON something, onto floor a body can walk from.
     *
     * Only a lounge seat carries a `step` — see `sittable`, which is what proved
     * there is one — so this is a no-op for a chair, and that is right: a chair is
     * loose, its own tile is walkable, and moving a body off one would be a foot
     * of teleport nobody asked for.
     *
     * It is a step rather than a route because it is a step: half a metre out from
     * a sofa a body has just stood up off, over floor `sittable` has already proved
     * a body fits in.
     */,

    _stepOffSeat(e, station) {
      const step = station?.step;
      if (!step) return;
      e.x = step.x;
      e.z = step.z;
      e.group.position.set(e.x, e.y, e.z);
    },

    // Blue eyes and empty hands, or their own colour and whatever they carry.
    // Both at once, always, because they are one statement: this one is not
    // fighting you at the moment.
    _lunchLook(e, on) {
      e.mats?.visor?.color.setHex(on ? BREAK_VISOR : e.type.visor);
      // Same test the rig builds the sidearm's visibility from (see rigs.js), with
      // the break on top of it — so a type that never had one does not acquire one
      // at the end of its lunch.
      if (e.gun) e.gun.visible = !on && !e.type.melee && !e.type.neutral;
      if (e.blunt) e.blunt.visible = !on;
    }

    /**
     * The crate, on and off. Public because jobs.js is what hands it along the
     * run, and the joiner's snapshot path uses the same two — a box appearing in
     * somebody's hands has to happen exactly one way whoever decided it.
     *
     * Geometry and materials are shared and module-level (see buildCrate), so
     * there is nothing here to dispose either.
     */
    /**
     * What a body is carrying, and it is one table now — see `HELD` in held.js.
     *
     * These four pairs stay as named methods rather than becoming `give(e, 'can')`
     * at every call site, because there are a dozen of those across chores.js,
     * jobs.js and this file and `enemies.giveCrate(e)` says what it means. What
     * moved out is the four near-identical BODIES, the wire bits and the four
     * branches of `applySnapshot` that went with them.
     */,

    _freeDesk(station, room = null) {
      if (room) {
        this.lounges?.get(room)?.push(station);
        return;
      }
      const canteen = this.layout?.cafeteriaRoom;
      const free = canteen && this.tables?.get(canteen);
      if (free) free.push(station);
    },
};
