// Getting a body to a place, and settling it there.
//
// Four errands walk somewhere and stop — a lunch, a rest, a parcel run, an
// ordinary chore — and all four go through the same three calls: `routeTo` floods
// a field to the place, `advanceTo` walks it, `standAt` turns the body to face
// what it came for and hands the field back. None of them owns the walk, because
// the walk is not any of their business.
//
// The rest is what a body does once it has arrived: sit down, get back up with
// its joints where the rig left them, strike a working pose and put it back.
// Every one of those is a PAIR that has to stay a single operation — clearing a
// seat without restoring the pose leaves a body walking the floor with its hips
// in a chair that is not there — and this file carries three separate monuments
// to that bug (`_standUp`, `setWorking`, `setChorePose`).

import { FACING } from './gen/layout.js';
import { stand } from './enemy-anim.js';
import { LUNCH_ARRIVE, LUNCH_PACE, SEAT_DRIFT } from './enemy-tuning.js';

// How far in front of the seat the table is, and the band a table top can be in.
// The gap is `seatFacing`'s own — a chair is placed a body's width out from the
// prop's CENTRE, so the probe lands inside the table rather than at its edge —
// and the band is what keeps the scan from matching the wall behind it or the
// floor plate under it.
const TABLE_AHEAD = 0.9;

const TABLE_LOW = 0.35;

const TABLE_HIGH = 1.4;

// ...and the same three for a CHORE station's machine — see `machineAhead`. The
// depths are probed outward from the body in order, because a station stands off
// a wall-backed machine by WORK_REACH and stands along a desk by DESK_ASIDE, and
// no one number lands inside both. The ceiling is under WALL_H so the wall the
// machine is backed against can never be mistaken for the machine.
const MACHINE_AHEAD = [0.55, 0.8, 1.05];

const MACHINE_LOW = 0.3;

const MACHINE_HIGH = 2.6;

/**
 * Mixed onto `Enemies.prototype` by enemies.js — see the note beside
 * `Object.defineProperties` at the bottom of that file for why these are
 * methods in an object rather than functions taking the roster.
 */

export const stationMethods = {
    _takeDesk(room, ok, pool = this.desks) {
      const free = pool.get(room);
      if (!free) return null;
      for (let i = 0; i < free.length; i++) {
        if (ok(free[i].x, free[i].z)) return free.splice(i, 1)[0];
      }
      return null;
    }

    /**
     * Puts a body in a chair, at work, facing what it is working on.
     *
     * Being at a desk is a state of the BODY and not of the AI — the state machine
     * is untouched, `idle` still means idle, and the pose is stood down the frame
     * anything happens (see `animate` in enemy-anim.js). So nothing downstream of
     * here — hearing, sight, pathing, the card in their pocket, the ragdoll —
     * needs to know this was ever a thing.
     */,

    _seat(e, station, at = 'desk') {
      e.seat = at;
      // ON the chair, not near it. Every other caller placed the body at the
      // station to begin with so this is a no-op for them; for somebody who WALKED
      // here it is the last few centimetres `_settleOnto` could not close, and it
      // is what makes "is the chair still under me" a question with an exact
      // answer rather than one with a metre of slack in it.
      e.x = station.x;
      e.z = station.z;
      e.group.position.set(e.x, e.y, e.z);
      // What the pose is drawn relative to, looked up ONCE here rather than
      // searched for every frame. A seat is up to three props: the chair holding
      // them up, the table a tray is on, and the DESK somebody at a desk is
      // typing at. Any of them can be destroyed and the chair can also be
      // shoved, so a seated body has to be able to tell.
      //
      // Null is a perfectly ordinary answer and means "do not check": a lookup
      // that comes back empty must never be read as the chair having gone, or a
      // seat the scan simply could not attribute would stand its body up on the
      // first frame it ever sat down.
      e.chair = this._looseAt(station.x, station.z);
      e.table = at === 'table' ? this._surfaceAhead(station) : null;
      // THE DESK, for the bodies that sit at one without a chore to their name:
      // the Manager at his own desk and the guard on the cameras. A body on
      // `deskWork` is covered by `c.prop` in chores.js and stood up 80 times out
      // of 80 when its desk was shot apart; these two are placed by the roster
      // and have no chore at all, so nothing was asking — measured at 16 of 22
      // still sitting there typing at the debris.
      //
      // `station.prop` first, which is what the FURNISHER said this station is at
      // (see `workstation` in gen/sink.js), and the probe only where nothing
      // said. Same order `_propFor` in chores.js asks in, and for the same
      // reason: a probe that misses reads as "do not check".
      e.desk = at === 'desk'
        ? (station.prop ?? this.machineAhead(station) ?? null)
        : null;
      // The chair's quarter turn, converted the one way it can be: a prop's turns
      // rotate the front from -Z toward +X, which is a negative rotation about Y.
      // Same line as tryPlace's, because a body and the chair under it face the
      // same way for the same reason.
      e.yaw = -station.rot * Math.PI / 2;
      e.group.rotation.y = e.yaw;
    }

    /**
     * Whatever a body was sitting on has gone. Stands them up, and this is the one
     * place that decides so.
     *
     * The pose is the problem it solves: a seated body is drawn hips-down into a
     * chair that is a separate prop, and that prop is loose — one round ends it,
     * and walking into it moves it. Neither used to reach the body, so the canteen
     * could be blown apart and leave four people sitting in mid-air, which is what
     * a player reported.
     *
     * The chair is checked for EVERY seat and the table only for a canteen one,
     * because they fail differently. Losing the chair is the body sitting on
     * nothing, which is wrong wherever it happens; losing the table leaves the
     * chair doing its job and only the tray hanging in the air, so it ends the
     * lunch rather than being a general rule about desks — a Manager at a desk
     * that has been shot out from under his monitor is still sitting on his chair.
     */,

    _seatGone(e) {
      const chair = e.chair;
      // Null means the scan could not attribute one, which is not the same as the
      // chair having gone — see the note in _seat.
      const lost = chair && (chair.top < 0
        || Math.abs((chair.minX + chair.maxX) / 2 - e.x) > SEAT_DRIFT
        || Math.abs((chair.minZ + chair.maxZ) / 2 - e.z) > SEAT_DRIFT);
      const noTable = e.seat === 'table' && e.table && e.table.top < 0;
      // ...and the desk out from under somebody who was working at it, which is
      // the same sentence as the table: the chair is still holding them up and
      // the thing the pose is ABOUT has gone.
      const noDesk = e.seat === 'desk' && e.desk && e.desk.top < 0;
      if (!lost && !noTable && !noDesk) return;

      // A break ends the way it ends anywhere else — the chair goes back to the
      // pool, the tray goes, the visor comes back — and `_lunchEnd` stands them up
      // on its way past. Anything else is on its feet and back on the clock.
      if (e.break) this._lunchEnd(e);
      else this._standUp(e);
    }

    /**
     * Out of the chair, joints and all.
     *
     * Clearing `e.seat` and calling `stand` are ONE operation and this is the only
     * place either happens deliberately: `stand` in enemy-anim.js puts the hips and
     * shoulders back where rigs.js left them, and nothing else in that file ever
     * moves a limb's position, so a body that left its chair any other way carried
     * the chair's joints round the floor for the rest of the run. The animator's
     * own stand-up — a seated body whose state is no longer idle or alert — is the
     * same operation reached the other way round, and does the same two things.
     */,

    _standUp(e) {
      if (!e.seat) return;
      e.seat = null;
      e.chair = null;
      e.table = null;
      e.desk = null;
      stand(e);
    },

    // The loose prop standing at a point — the chair under a seat. Bounds rather
    // than a radius, because a collider is what the rest of the game collides
    // against and its footprint is the honest answer to "is there one here".
    _looseAt(x, z) {
      for (const b of this.loose ?? []) {
        if (b.top < 0) continue;
        if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return b;
      }
      return null;
    },

    // ...and the fitted one a body's width in front of a seat, which is the desk
    // or the table it is pulled up to. Static, so it never moves and only `top`
    // can change.
    _surfaceAhead(station) {
      const yaw = -station.rot * Math.PI / 2;
      const x = station.x - Math.sin(yaw) * TABLE_AHEAD;
      const z = station.z - Math.cos(yaw) * TABLE_AHEAD;
      for (const b of this.colliders ?? []) {
        if (b.top < TABLE_LOW || b.top > TABLE_HIGH) continue;
        if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return b;
      }
      return null;
    }

    /**
     * The machine a chore station is a place to stand AT, or null.
     *
     * Same probe as `_surfaceAhead` one method up and the same reason for
     * existing: a working pose is drawn relative to a prop, that prop can be shot
     * apart, and nothing used to tell the body. A man goes on typing at a desk
     * that is no longer there, pressing a copier that has been blown into the
     * corridor — which is what a player reported, and it is `_seatGone`'s bug in
     * the room next door.
     *
     * Three differences from the seat version, and each one is the difference
     * between a chair and a machine:
     *
     *   - THE BAND IS TALLER, because the props are. A copier tops out at 1.13,
     *     a bench at 0.9, a vending machine at 1.9 and a server rack at 2.05, so
     *     a table's 1.4 ceiling would silently miss half the catalogue. The top of
     *     it is what keeps the WALL out: a machine is backed against one, and a
     *     wall's collider tops out at WALL_H — far above anything that can be
     *     stood at, so excluding it costs nothing and including it would make
     *     every station in the building indestructible.
     *   - SEVERAL DEPTHS, not one. A seat is placed a known width from its table;
     *     these come from two different offsets — `WORK_REACH` in front of a
     *     wall-backed machine, `DESK_ASIDE` along a desk from its chair — so
     *     there is no single number that lands inside every prop. The first hit
     *     wins, and probing outward from the body means the near face of the
     *     right prop is always met before anything behind it.
     *   - IT LOOKS IN BOTH LISTS. A chair is always loose and a table always
     *     fitted; a machine can be either — the copier and the rack are static,
     *     and a bench somebody shoved is not. Both retire the same way (`top` goes
     *     negative), which is the whole reason one test serves both.
     *
     * Null is an ordinary answer and means DO NOT CHECK, exactly as it does for a
     * seat: a mop station is a patch of corridor and a wall panel has no collider
     * at all by design (see panels.js). A probe that simply failed to attribute a
     * prop must never read as the prop having gone, or every job on the floor ends
     * on the frame it starts.
     */,

    machineAhead(station) {
      const [fx, fz] = FACING[station.rot & 3];
      for (const ahead of MACHINE_AHEAD) {
        const x = station.x + fx * ahead;
        const z = station.z + fz * ahead;
        const hit = this._boxAt(x, z, MACHINE_LOW, MACHINE_HIGH);
        if (hit) return hit;
      }
      return null;
    },

    /** Whatever fitted or loose box is over this point inside a height band. */
    _boxAt(x, z, low, high) {
      for (const list of [this.colliders, this.loose]) {
        for (const b of list ?? []) {
          if (b.top < low || b.top > high) continue;
          if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return b;
        }
      }
      return null;
    },

    // Stopped at a station and turned to face it. The station's own quarter turn
    // is converted the one way it can be — the same line `_seat` uses, because a
    // body standing at a counter and a chair pulled up to a desk are facing what
    // they are facing for the same reason.
    standAt(e, at) {
      e.state = 'idle';
      e.moving = false;
      e.yaw = -at.rot * Math.PI / 2;
      e.group.rotation.y = e.yaw;
      // Arrived, so the route is spent. Every errand in the game comes to rest
      // here, which is why the field goes back here and nowhere else — see
      // `dropField`.
      this.dropField(e);
    }

    /**
     * Hands this one's distance field back to nav.
     *
     * A field is 548 KB on a deep floor and a body keeps the one it was given for
     * the rest of its life, which cost nothing while a handful of people were
     * walking anywhere. Now that everybody has somewhere to be it is the difference
     * between a few megabytes and a hundred: it is the WALKERS that need a route,
     * and a man standing at a copier for half a minute is holding directions he
     * has already followed. `??=` at every take site means the next walk simply
     * draws another one out of the free list.
     */,

    dropField(e) {
      if (!e.field) return;
      this.nav?.freeField(e.field);
      e.field = null;
    }

    /**
     * Points this one at somewhere and floods the field that walks them there.
     * False (and a spent timer, which every walking stage reads as "give it up")
     * if there is no route.
     *
     * BOTH halves are checked and the second one is the whole of it: a flood that
     * reaches the destination says nothing about whether it reached HERE. Most of
     * the staff are behind a badged door, which is out of the nav grid entirely
     * (see the note about hearing in the header), so before the player has taken a
     * white card the only bodies that can get anywhere are the ones already in the
     * corridors — and once one is taken, ~190 doors hand their openings back and
     * the whole building can. Checked rather than assumed, because a body that
     * sets off for somewhere it cannot reach spends the whole stage cap
     * re-flooding the floor from a tile it is not standing on.
     */,

    routeTo(e, errand, to, cap) {
      errand.at = to;
      errand.timer = cap;
      e.state = 'wander';
      e.stuck = 0;
      e.field ??= this.nav.makeField();
      if (!to || !this.nav.floodTo(e.field, to.x, to.z)
        || !this.nav.descendOn(e.field, e.x, e.z, this._v)) {
        errand.timer = -1;
        return false;
      }
      return true;
    },

    /** One step of a walk with a destination. True once they are there. */
    advanceTo(e, errand, dt, to) {
      if (!to) return true;
      if (Math.hypot(to.x - e.x, to.z - e.z) < LUNCH_ARRIVE) return true;

      // Unhurried on purpose. Somebody walking to their lunch — or wheeling a box
      // down a corridor — at chase speed is somebody who has noticed you.
      const speed = this.tuning.speed * e.type.speed * LUNCH_PACE;
      if (this._stroll(e, dt, speed) !== 'moved') {
        // Wedged, or off the field. Re-flooding is the only recovery there is —
        // the floor changes shape as furniture is destroyed — and it is done ONCE
        // and then checked, rather than retried every frame: a body that is not on
        // the field will not be on the re-flooded one either, and left to try
        // again it floods the whole floor thirty times a second for the length of
        // the stage cap. `e.stuck` is reset so a sidestep gets its chance first.
        e.stuck = 0;
        if (!this.nav.floodTo(e.field, to.x, to.z)
          || !this.nav.descendOn(e.field, e.x, e.z, this._v)) errand.timer = -1;
      }
      return false;
    }

    /**
     * The last stretch onto a station, walked in a straight line rather than on
     * the field. True once they are on it.
     *
     * `_tryMove` rather than an assignment, so the same collision the rest of the
     * walk uses still applies — and if it cannot make ground the caller settles
     * anyway, because a body wedged beside the thing it was walking to for the
     * length of the stage cap is the worse outcome.
     */,

    closeOnto(e, dt, at) {
      return this._settleOnto(e, dt, at);
    },

    setWorking(e, on) {
      if (!e || !!e.working === !!on) return;
      e.working = !!on;
      if (!on && e.alive) stand(e);
    }

    /**
     * Which working pose a body at a machine is holding, or null for none.
     *
     * The same bargain `setWorking` makes one method up, and it is the third time
     * this file has had to make it: nothing but `stand` puts a hinged limb back or
     * lifts a stooped body out of the carpet, so clearing the pose and restoring
     * it have to be ONE operation. Left as a field anybody may write, a man who
     * stops working walks off the rest of the floor bent over a bench that is no
     * longer in front of him. `_standUp` is the same promise for a chair.
     */,

    setChorePose(e, pose) {
      if (!e?.chore || e.chore.pose === (pose ?? null)) return;
      e.chore.pose = pose ?? null;
      if (!pose && e.alive) stand(e);
    }

    // A chair back into the pool it came out of. The room is the canteen's,
    // because that is the only room this pool ever holds.
    /**
     * Sits a body down at a chair it has walked to, and stands it back up.
     *
     * Thin wrappers, and they exist so `chores.js` never touches `e.seat` itself.
     * That is the bargain `_standUp` already documents: clearing the seat and
     * restoring the pose are ONE operation, and a caller that does the first
     * without the second leaves a body walking the floor with its hips in a chair
     * that is not there. Same rule as `setChorePose`, and the same bug.
     */,

    // `at` is which KIND of chair it is, and it is what the animator dispatches on:
    // a desk is typed at, a canteen table is eaten at, and a meeting is sat
    // through. Defaulted rather than required, because every caller but the
    // meeting means a desk.
    sitAt(e, station, at = 'desk') {
      this._seat(e, station, at);
    },

    standUp(e) {
      this._standUp(e);
    }

    /**
     * A seat back into the pool it came out of.
     *
     * `room` says which: a break room's, or the canteen's when it is absent. It is
     * passed rather than looked up off the station because the two pools are keyed
     * by room and a lounge seat put back on the canteen's list would be a sofa
     * somebody is sent across the floor to sit on in a room it is not in.
     */,

    _inRoom(room, x, z) {
      if (!room) return false;
      const tx = this.nav.tx(x), ty = this.nav.ty(z);
      return tx >= room.x0 && tx < room.x1 && ty >= room.y0 && ty < room.y1;
    },
};
