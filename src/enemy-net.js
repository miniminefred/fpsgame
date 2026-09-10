// The roster, over the wire.
//
// A floor is REBUILT on the far end rather than sent, so both browsers hold the
// same roster in the same order and a body's index in `items` is its name (see
// Co-op in CLAUDE.md). What crosses is a correction to a simulation the joiner is
// already running: positions and states at 12 Hz, plus the handful of bits it has
// no way to derive — in a chair, on a break, gone home, and whatever is in its
// hands.
//
// The joiner runs no AI at all. `_poseAll` is the whole of what it does with a
// snapshot: lerp each body toward where it was said to be, and animate it.

import { applyHeld, packHeld } from './held.js';
import { animate, die, HIT_FLASH } from './enemy-anim.js';
import { angleLerp, smoothTo } from './util.js';

// --- what crosses the wire in a co-op session --------------------------------
//
// The joiner's roster is not a second simulation, it is the SAME roster: same
// seed, same floor, so the same two hundred people in the same rooms, indexed
// the same way. All the host has to send is where each of them now is, which is
// why the message is a flat run of numbers rather than a list of objects — six
// slots a body, in this order, written by `snapshot` and read by
// `applySnapshot` and by nothing else.
const SNAP_STRIDE = 6;

// Positions go over as hundredths of a metre in whole numbers: a centimetre is
// far below what anybody can see on a walking body, and it keeps every value in
// the packet a short integer.
const SNAP_UNIT = 100;

// The state machine, as an index. Order is the wire format and must not be
// rearranged — `animate` reads the name back off it to decide whether a body is
// walking, and getting that wrong is a floor of people sliding about with still
// legs.
const SNAP_STATES = ['idle', 'alert', 'chase', 'fight', 'wander'];

// The flags that ride in the same slot, above the three bits the state takes.
// A break has to cross because the VISOR is on the other side of it: it is the
// game's one universal tell, and a joiner looking at an employee with its own
// colour on that is not going to shoot back is being lied to. The tray goes with
// it rather than being derived from the break, because a body walks the first
// and last beat of a lunch without one.
const SNAP_SEAT = 8;

const SNAP_BREAK = 16;

// ...and whether this body has left the building, which is the one flag here
// that is not about what somebody is holding.
//
// A contractor walks into a lift and stops being on the floor (`showOut` below).
// The errand that does it is a chore, and chores are host-only and cross
// nothing — so without this bit the host has a man who has gone home and the
// joiner has one standing in a lift car for the rest of the floor. It is a bit
// rather than a message for the reason all six above are: it is a fact about a
// body, and the body is already being sent.
const SNAP_GONE = 512;

// How far from either player a body has to be before it is worth sending. Well
// beyond SIGHT, because the joiner can watch somebody walk up a corridor long
// before that body could see them back, and a body that pops into motion at 22 m
// reads as the floor being drawn in front of you.
const SYNC_RANGE = 34;

// Bodies per packet. A deep floor has two hundred people on it and a firefight
// can legitimately have forty of them moving, so the cap is not a limit on how
// many can be synced — `snapshot` walks the roster round-robin, so everything in
// range is covered within a few packets. It is a bound on what one packet costs.
const SNAP_CAP = 48;

// How hard a posed body is pulled toward the position the last packet gave it,
// and how far out of date it has to be before it is moved there outright rather
// than walked there. The snap threshold is what stops a body that has been out
// of range for ten seconds sprinting across the building to catch up.
const POSE_RATE = 14;

const POSE_SNAP = 3;

// The people still working here.
//
// Movement is grid-based (see nav.js): everyone walks downhill on one shared
// distance field flooded from the player, so a whole floor of them routes
// through doorways correctly without per-enemy pathfinding. Combat is
// probabilistic but geometric — a shot's spread is sampled as a real angle and
// converted into a miss distance at the player's range, so backing off actually
// makes you harder to hit instead of just changing a magic number.

/**
 * Mixed onto `Enemies.prototype` by enemies.js — see the note beside
 * `Object.defineProperties` at the bottom of that file for why these are
 * methods in an object rather than functions taking the roster.
 */

export const netMethods = {
    netDie(i, hit = null) {
      const e = this.items[i];
      if (!e?.alive) return null;
      e.health = 0;
      this._die(e, hit);
      return e;
    }

    /**
     * The host says index `i` was hit but is still up. Joiner side only.
     *
     * Returns the body, so the caller can give it a voice — this is only ever sent
     * for damage the JOINER did not cause, because a shot fired at this keyboard
     * has already flashed and grunted on its way out through `hit`.
     */,

    netHurt(i, health = null) {
      const e = this.items[i];
      if (!e?.alive) return null;
      if (health !== null) e.health = health;
      e.hitFlash = HIT_FLASH;
      return e;
    }

    /**
     * An explosion. Everyone inside `radius` takes damage falling off to nothing
     * at the rim, and the neutrals who live through it take the hint and run.
     *
     * Distance is straight-line and ignores walls, which is wrong and stays wrong:
     * the blast that reaches through a partition is a smaller lie than the one
     * that goes off at somebody's feet and leaves them standing because the tile
     * they are on belongs to the next room.
     */,

    snapshot(out, targets) {
      const n = this.items.length;
      if (!n) return 0;

      let written = 0;
      let scanned = 0;
      let i = this._snapCursor % n;

      while (scanned < n && written < SNAP_CAP * SNAP_STRIDE) {
        const e = this.items[i];
        scanned++;
        i = (i + 1) % n;
        if (!e.alive) continue;

        let near = false;
        for (const t of targets) {
          if (Math.hypot(t.x - e.x, t.z - e.z) < SYNC_RANGE) { near = true; break; }
        }
        if (!near) continue;

        out[written++] = e.index;
        out[written++] = Math.round(e.x * SNAP_UNIT);
        out[written++] = Math.round(e.z * SNAP_UNIT);
        out[written++] = Math.round(e.y * SNAP_UNIT);
        out[written++] = Math.round(e.yaw * SNAP_UNIT);
        // One slot for everything that is not a coordinate, three bits of state
        // and three flags. `animate` poses off all of them and none is worth a
        // number of its own.
        out[written++] = SNAP_STATES.indexOf(e.state)
          + (e.seat ? SNAP_SEAT : 0)
          + (e.break ? SNAP_BREAK : 0)
          + packHeld(e)
          + (e.gone ? SNAP_GONE : 0);
      }

      this._snapCursor = i;
      return written;
    },

    /** Takes one of those. Joiner side only. */
    applySnapshot(a) {
      for (let k = 0; k + SNAP_STRIDE <= a.length; k += SNAP_STRIDE) {
        const e = this.items[a[k]];
        // A packet from a floor we have already left, or from one we have not
        // built yet. Dropping it is right: `netplay.js` stamps every snapshot with
        // its floor and only hands over the ones that match, so anything that gets
        // this far is a body that has since been cleared away.
        if (!e || !e.alive) continue;

        e.netX = a[k + 1] / SNAP_UNIT;
        e.netZ = a[k + 2] / SNAP_UNIT;
        e.netY = a[k + 3] / SNAP_UNIT;
        e.netYaw = a[k + 4] / SNAP_UNIT;
        const packed = a[k + 5];
        // Whether they are still sitting is the host's; WHICH seat it is is a fact
        // about the floor. A chair a body was placed in came from the same seed on
        // both ends — but a chair it WALKED to did not, because whose turn it is
        // at the counter is decided at runtime and only the host decides it. So
        // the break bit answers that: on a break, the seat is a canteen table by
        // construction, since that is the only seat a break ever ends at.
        if (!(packed & SNAP_SEAT)) e.seat = null;
        // `|| e.type.dines` used to be the other half of this, for the arrival
        // canteen's own type — which was seated by the SEED rather than by a
        // runtime decision, so the break bit was not on the wire for it. That
        // type is gone (see `_dinerType` in roster.js): the diners are ordinary
        // staff on an ordinary break now, so they carry the break bit like
        // everybody else and it answers for them too.
        else e.seat ??= (packed & SNAP_BREAK) ? 'table' : 'desk';

        // The break itself, which is the visor and the empty hands. Kept as a
        // plain flag rather than the host's own `break` object: the joiner runs no
        // part of the cycle, it only has to draw the body correctly, and giving it
        // a half-populated stage machine is how it would end up trying to.
        const onBreak = !!(packed & SNAP_BREAK);
        if (onBreak !== !!e.break) {
          e.break = onBreak ? { stage: 'net', at: null, seat: null, timer: 0 } : null;
          this._lunchLook(e, onBreak);
        }
        // ...and everything in its hands, which used to be four of these blocks —
        // a crate, a tray, a can and a bundle of paper, each with its own bit and
        // its own pair of methods. `applyHeld` walks the table instead. Each is
        // the MESH alone with no errand behind it: a joiner runs no part of a
        // parcel run for the same reason it runs no part of a lunch, and half a
        // stage machine is how it would end up trying to do more than draw.
        applyHeld(e, packed, e.index + 1);
        // One way only, and deliberately: nothing brings somebody back.
        if ((packed & SNAP_GONE) && !e.gone) this.showOut(e);
        e.state = SNAP_STATES[packed & 7] ?? 'idle';
      }
    }

    /**
     * A frame of a posed roster: walk everybody toward where the last packet put
     * them, and animate them there. Joiner side only.
     *
     * The lerp is the whole reason this looks like a game rather than like a
     * network trace. Packets arrive a dozen times a second and frames happen sixty
     * times a second, so a body written straight to its last reported position
     * steps five times a second and stands still in between. Pulled toward it
     * instead, it walks — and `animate` is already reading `state` to decide
     * whether the legs should be moving, so a body that is chasing you looks like
     * it is chasing you even between packets.
     */,

    _poseAll(dt, audio) {
      const k = smoothTo(POSE_RATE, dt);

      for (const e of this.items) {
        if (!e.alive) { die(e, dt); continue; }

        // Somebody who has been out of range and is now back is not somebody who
        // ran here — put them where they are.
        if (Math.hypot(e.netX - e.x, e.netZ - e.z) > POSE_SNAP) {
          e.x = e.netX; e.z = e.netZ; e.y = e.netY; e.yaw = e.netYaw;
        } else {
          e.x += (e.netX - e.x) * k;
          e.z += (e.netZ - e.z) * k;
          e.y += (e.netY - e.y) * k;
          e.yaw = angleLerp(e.yaw, e.netYaw, k);
        }

        e.group.position.set(e.x, e.y, e.z);
        e.group.rotation.y = e.yaw;
        animate(e, dt, audio);
        if (!e.neutral) this._mutter(e, dt, audio);
      }
    }

    /**
     * The four the host sent up after an alarm, rebuilt here. Joiner side only.
     *
     * They are the one part of the roster the seed cannot produce, because they
     * did not exist when the floor was generated — so the host shares what each of
     * them was rolled from and this builds the same man from it. Returns their
     * hitboxes, which the caller has to hand to `shooting`: an enemy that arrived
     * after the floor did is not in the raycast list, and bullets go straight
     * through him.
     */,
};
