// Who is on this floor, and when they arrive.
//
// Every guarantee about placement lives here: the shift a room is dealt, the
// corridor the first white card has to be standing in, the guaranteed holder of
// every other tier, the set pieces (the manager behind his own door, the guard
// on the cameras, the janitors on their rounds, the receptionist behind the
// counter, the contractor at the lift), and the security response that arrives
// when a camera finally calls it in.
//
// One pass plus one event, and both answer the same question — who is standing
// where — which is why the alarm is in here rather than beside the state
// machine. Nothing in this file runs per frame.

import { BODY_RADIUS as RADIUS } from './nav.js';
import {
  centreX,
  centreZ,
  CORRIDOR,
  DOOR_CLEAR,
  doorsOnRoom,
  FACING,
  FIRST_CONTACT_GAP,
  NEIGHBOURS,
  STAFF_ONLY,
} from './gen/layout.js';
import { BYSTANDERS, pickTheme, pickType, TYPES } from './enemy-types.js';
import { makeRng } from './gen/rng.js';
import { LOUNGE_STEP, LUNCH_FIRST, NUDGE_STEP, STAND_NUDGE } from './enemy-tuning.js';

const CORRIDOR_SAMPLE = 10;    // keep every Nth corridor tile as a waypoint

// How many of the staff, beyond the guaranteed holders, are carrying a spare
// keycard. Low on purpose: at seventy to two hundred people a floor even this
// leaves a dozen or so on the carpet, and a card you trip over every ten seconds
// is not a key, it is confetti.
const CARD_SPARE_CHANCE = 0.06;

// The prologue. Until the player has a white card the only people they can reach
// are the ones in the corridors, so these two numbers decide how long a floor
// takes to start: how far the first one may be, and how many there are at all.
// See _cardOutside.
const FIRST_CONTACT = 34;      // metres from the lifts

const OUTSIDE_MIN = 5;

// ...but never close enough to be there on arrival. Imported rather than
// written down again: gen/layout.js guarantees there is corridor beyond this
// distance that the player can reach with no card, and a second copy of the
// number here is how that guarantee quietly stopped being about the same thing.
const MIN_SPAWN_GAP = FIRST_CONTACT_GAP;

// How big a shift one room may be dealt.
//
// A room is staffed to the desks it HAS rather than to the flat 0-3 a storeroom draws — an open-plan farm with
// two people in it and ten empty pods is not a half-staffed office, it is a room
// somebody forgot to fill. The cap is what keeps the biggest farm on the floor
// from swallowing the roster, and it wants to stay under the 1-3 a team is (see
// spawn) times a couple, or the rest of the building empties out to fill it.
//
// Note what it does NOT decide any more: where any of them stands. A chair is for
// somebody who is not going to shoot you — the two hand-placed set pieces (see
// _manager and _security) and nobody else — so the shift a room is dealt works
// standing up and the desks in it are left empty. Counting a room's stations is
// still the right way to size that shift: a room with twelve pods in it is where
// the work is whether or not anybody is sitting down at it.
const DESK_TEAM = 5;

// The harmless staff in the hallways when you arrive, and the one place in the
// roster where two numbers next to each other are drawn on purpose differently.
//
// The toilet guy is a flat one or two whatever the floor is. He is a joke —
// announcing his problem at volume while a firefight goes on around him — and a
// joke lands once, maybe twice, and is a running gag by the sixth time you have
// heard it. The rest of them are the building's background traffic, so they scale
// with how much building there is (`layout.areaRatio`, the floor's size against
// the usual one at this depth): six people spread over a slab half again the
// normal size is an empty office, and the same six over a small one is a crowd.
// Same reasoning as the cameras and the roster itself, which both ask that
// question — see PER_FLOOR in cameras.js and tuningFor in game.js.
const HALL_PANICKERS = [1, 2];

const HALL_BYSTANDERS = [4, 6];

// Metres between two of them, so a busier floor does not stand a courier inside
// a cleaner. `this.corridors` is every tenth corridor tile, which is a fine
// sample for picking somewhere to walk to and a coarse one for putting a dozen
// bodies down without collisions.
const NEUTRAL_GAP = 1.4;

// The cleaning staff. Doing rounds in the corridors, plus the two on their
// break in the broom closet. See _janitors.
const JANITORS = [1, 3];

const CLOSET_JANITORS = 2;

// The security staff, on the same shape: the ones walking the halls carry the
// blue card, and the ones in the security office are behind the door it opens.
// See _security. The office is the one room on the floor with a crowd in it —
// the wall of screens is what they are all looking at — which is why the number
// is what it is and why they are not all carrying the same thing.
const OFFICE_GUARDS = [2, 5];

const GUARD_BATON = 0.4;       // how much of the shift drew a baton instead

const GUARD_GAP = 0.8;         // metres between two men in one room

/**
 * How often the receptionist is not pleased to see you.
 *
 * Three in ten, and the number is doing a specific job: it has to be low enough
 * that walking into a lobby is not a fight you brace for, and high enough that
 * you cannot walk past one without looking at it. At one in ten the second
 * lobby teaches you to ignore them; at one in two the visor stops being news.
 *
 * Rolled once per floor and never re-rolled, so the answer for THIS lobby is
 * settled before the doors open — which matters more than it sounds, because the
 * lobby is also the room you come back to at the end of the floor.
 */

const ANGRY_RECEPTION = 0.3;

/**
 * How often a floor has somebody visiting it.
 *
 * Two floors in three, which is the same shape of number as the receptionist's
 * coin one line up and is chosen the same way: often enough that a run meets one
 * every few floors, rare enough that finding a man in a red suit walking a
 * corridor with a crate is a thing that happened rather than a thing the game
 * does. A fixture would also be a lie about him — he does not work here.
 */

const VISITOR_CHANCE = 0.66;

// How far out of a lift car a body stands, searched between these two rather
// than fixed — see `liftSpots`. Near enough to be unmistakably at the lift, far
// enough to be in the room rather than in the doorway.
//
// The far end is 5.2 m rather than the 3.2 it was, and the extra two metres are
// what let the walk get PAST the reception counter. The counter stands off its
// wall with a pocket behind it and the lift bank is on another wall, so the band
// in front of a car regularly ends in furniture — and a search that gives up at
// 3.2 m either lands in that pocket or finds nothing. It is still a lift lobby:
// `fitsLifts` asks for ten tiles of depth, so five metres is the room.
const LIFT_NEAR = 1.4;

const LIFT_FAR = 5.2;

const LIFT_STEP = 0.25;

// The canteen's own, in the room the floor arrives in — see _diners. A handful
// rather than a crowd, and that is the whole tuning: a canteen with fifteen
// people in it is a room you have to work out before you can move, and the point
// of these is that you do not have to work them out at all. Two to five at the
// tables and a couple on their feet is a late shift on its break; it also leaves
// most of the seating empty, which is the room reading as somewhere the rest of
// the floor is too busy to be.
const DINERS = [2, 5];

const DINERS_STANDING = [0, 2];

// Metres of the arrival point kept to yourself. The seats are outside it anyway
// — no table is furnished into the square kept clear where the player
// materialises — so this is only ever about the ones on their feet, who are
// placed on open floor and would otherwise be free to stand on your head.
const DINER_SPAWN_GAP = 2.5;

// The generator room's crew, in the two halves that are the point of it: the
// ones who will come at you, and the ones who will carry on with their shift
// while you shoot at them. See _generatorRoom.
const GEN_TECHS = [2, 3];

const GEN_WORKERS = [3, 5];

// The response to an alarm (see `alarm` below). Four men come up from the floor
// below — unless the security office on THIS floor is still manned, in which
// case the men in it are the response and only two more are sent. Which makes
// clearing the security office early a real decision rather than loot: it costs
// you the two easy kills you would rather not have made, and it doubles what
// turns up the first time a camera gets six seconds of you.
const RESPONSE = 4;

const RESPONSE_HELD = 2;

// How far away they come in, measured on the distance field — a walked distance,
// not a straight line, so "far" never means "one metre away through the wall".
const RESPONSE_MIN = 16;

const RESPONSE_MAX = 60;

// How far the klaxon carries to everybody else, walked rather than straight-line
// — the same measure as gunfire (see HEARING) and for the same reason, so a man
// sealed in a badged room hears nothing at all. Further than a gunshot, because
// this is the building shouting rather than one weapon going off in a room.
const ALARM_HEARING = 30;

function liftSpots(layout, nav, corridors) {
  const out = [];
  // One flood, to a corridor tile. The corridor network is connected by
  // construction and the lobby's own doorway is never badged (see the note on
  // `free` in gen/layout.js), so this reaches the lobby even with the building
  // still shut.
  const field = corridors.length ? nav.makeField() : null;
  const joined = field && nav.floodTo(field, corridors[0].x, corridors[0].z);

  for (const car of [layout?.lifts?.arrival, layout?.lifts?.departure]) {
    if (!car) continue;
    const [fx, fz] = FACING[car.facing & 3];
    for (let step = LIFT_NEAR; step <= LIFT_FAR + 1e-6; step += LIFT_STEP) {
      const x = car.x + fx * step;
      const z = car.z + fz * step;
      const tx = nav.tx(x), ty = nav.ty(z);
      if (!nav.fitsAt(tx, ty)) continue;
      if (joined && field[ty * nav.W + tx] < 0) continue;
      out.push({ x, z, rot: (car.facing + 2) & 3, car });
      break;
    }
  }
  return out;
}

/**
 * The tiles of one room that are its FLOOR rather than a pocket in it.
 *
 * FITTING IS NOT THE SAME AS BEING CONNECTED, which is the lesson `liftSpots`
 * above paid for and this pool never learned. `nav.clear` and `nav.fitsAt` both
 * ask about a single tile, and a tile can pass either and still be an island: the
 * furnisher is free to leave a pocket of floor ringed by its own props, and a
 * body put down in one stands there for the whole floor. `_spawnPoints`' own
 * comment has always described that failure exactly — "a tile an enemy can stand
 * on but never leave, and spawning there makes it a statue" — and then tested for
 * it with a point test, which cannot see it. Measured over 8 floors: 26 of 1044
 * bodies stranded, and ALL 26 on tiles that pass `fitsAt` and belong to a pocket
 * (openplan 9, storage 6, copyroom 5, the lift lobby 4, server 1, security 1).
 * Nought were the point-test case, so asking `fitsAt` instead would have bought
 * nothing.
 *
 * It is answered INSIDE the room, and the largest region wins rather than the one
 * holding a doorway — which is a decision, and the two obvious alternatives are
 * both wrong here:
 *
 *   - Flooding the whole floor from the corridors is what `liftSpots` does, and
 *     at the moment the roster is placed it refuses to staff the building. Every
 *     reader is still red and a badged door is out of the nav grid, so the flood
 *     reaches the corridors and almost nothing else. Measured: 2 rooms of 50.
 *   - Adding the doorways back to the mask does not bridge them either, and the
 *     reason is worth knowing. `fits` is `walk` eroded by a body radius, so a
 *     doorway missing from `walk` takes the tiles either side of it out of `fits`
 *     as well: opening the 3 door tiles leaves the apron blocked and the room
 *     still sealed. Measured: 266 of 269 doorways blocked, and still 2 rooms of
 *     50. Doing it properly means re-eroding a copy of `walk` — which is
 *     `setBadgeTiles` in nav.js, owned by doors.js and not yet called this early.
 *
 * So it is anchored on the room's own DOORWAYS, and the seed is walked inward
 * rather than taken beside the opening — which is the erosion above, handled
 * instead of worked around. A badged doorway takes a tile of apron either side of
 * it out of `fits`, so the tile against the opening is no seed at all; the apron
 * is reserved floor for DOOR_CLEAR tiles before a prop is placed, so stepping in
 * until a body fits finds the region the doorway really opens onto and stops well
 * before it could wander into a pocket.
 *
 * Anchoring on SIZE instead was tried first and is not good enough: it costs the
 * same and leaves a third of these standing, because a room's biggest region is
 * not always the one its door lands in — 26 stranded bodies became 19, with
 * copyrooms getting slightly worse. Every region a doorway reaches is fair game,
 * because a room with two doors has two ways in and a body by either of them can
 * leave by it.
 */
function roomFloor(room, nav, doors) {
  const { W } = nav;
  const w = room.x1 - room.x0, h = room.y1 - room.y0;
  if (w <= 0 || h <= 0) return null;
  const seen = new Uint8Array(w * h);
  const q = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = y * w + x;
    if (seen[i] || !nav.fitsAt(room.x0 + x, room.y0 + y)) return false;
    seen[i] = 1;
    q.push(i);
    return true;
  };

  // One seed per doorway, stepped inward until a body fits.
  for (const d of doorsOnRoom(doors, room)) {
    const cx = Math.floor((d.x0 + d.x1) / 2), cy = Math.floor((d.y0 + d.y1) / 2);
    // Which side of the opening this room is on, and so which way is inward.
    const dir = d.vertical
      ? (d.x0 - 1 >= room.x0 && d.x0 - 1 < room.x1 ? [-1, 0] : [1, 0])
      : (d.y0 - 1 >= room.y0 && d.y0 - 1 < room.y1 ? [0, -1] : [0, 1]);
    const from = d.vertical
      ? [dir[0] < 0 ? d.x0 - 1 : d.x1, cy]
      : [cx, dir[1] < 0 ? d.y0 - 1 : d.y1];
    for (let step = 0; step < DOOR_CLEAR; step++) {
      const tx = from[0] + dir[0] * step - room.x0;
      const ty = from[1] + dir[1] * step - room.y0;
      if (push(tx, ty)) break;
    }
  }
  if (!q.length) return null;

  for (let head = 0; head < q.length; head++) {
    const i = q[head], x = i % w, y = (i - x) / w;
    for (const [dx, dy] of NEIGHBOURS) push(x + dx, y + dy);
  }

  // Handed back as a test rather than as a set: the caller has a room and a tile,
  // and every other spawn test in there is a predicate.
  return (tx, ty) => {
    const x = tx - room.x0, y = ty - room.y0;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    return seen[y * w + x] === 1;
  };
}

/**
 * The floor's desks, bucketed by the room each one is in.
 *
 * Shuffled inside each bucket, because the furnisher lays a cubicle farm out row
 * by row: taken in order, the desk the Manager is found at is the pod nearest
 * one corner of his office every single time.
 *
 * The rest of a room's stations are counted rather than taken — how many there
 * are is what sizes the shift the room is dealt (see DESK_TEAM), and the shift
 * works standing up.
 *
 * Keyed on the room object itself. Both browsers in a co-op session generated
 * the same floor from the same seed, so these are the same desks in the same
 * order on both ends and the two bodies that do sit down sit in the same chairs.
 */

function deskPool(workstations, nav, rng, at, nudge = 0, onto = 0) {
  const by = new Map();
  for (const w of workstations) {
    // Desks and canteen tables come through the same call and are pooled apart,
    // because what they mean is different: a desk is a job and a table is lunch.
    // Mixed, a cafeteria's ten chairs would read to _spawnPoints as a room with
    // ten jobs going in it and it would be dealt a shift to match.
    if (w.at !== at) continue;
    // A desk the furnisher could not attribute to a room — nothing in the
    // catalogue places one outside a room today, and a corridor full of unowned
    // workstations would be dealt to whoever asked first.
    if (!w.room) continue;
    // A chair a whole body does not fit in front of, which is a third of the
    // pods in a cubicle farm: the pitch is tight, and the nav grid holds a body
    // to whole tiles. Dropped here rather than refused at the door, because how
    // many desks a room has is what decides how big a shift it is dealt (see
    // _spawnPoints) — counting stations nobody can sit at deals a farm five
    // people and then stands all five of them up.
    //
    // Asked of `fits` rather than with `nav.clear`, and the difference is the
    // whole bug. `clear` is a point test: can a body of this radius stand at
    // this exact spot. `fits` is that same test taken at the TILE CENTRE, and it
    // is what every flood and every `descendOn` runs on — so a chair tucked into
    // the corner of a tile passes `clear` and fails `fits`, and a body seated
    // there can stand up perfectly well and then never route anywhere for the
    // rest of the run. Measured on a canteen chair that a player shot: 400
    // destination picks, 0 accepted, 101 of them refused at `descendOn` because
    // the body's own tile was not on the field. He stood at the table walking on
    // the spot until the floor ended.
    //
    // It costs seats — a chair that only just fits is now no chair at all — and
    // that is the right trade in both directions: the two set pieces this pool
    // has always fed (the Manager, the guard on the cameras) get up to FIGHT
    // you, and one that cannot leave its desk is worse than one that never sat
    // at it.
    const spot = onto ? sittable(w, nav, onto) : standable(w, nav, nudge);
    if (!spot) continue;
    const list = by.get(w.room);
    if (list) list.push(spot);
    else by.set(w.room, [spot]);
  }
  for (const list of by.values()) rng.shuffle(list);
  return by;
}

/**
 * Where a body actually stands at this station, or null if it cannot stand there.
 *
 * A CHAIR may not move: the pose is drawn relative to the seat under it, so a
 * station that fails is simply not a seat. A place to STAND may, and that is the
 * whole of what `nudge` is — the caller says which kind it is asking about.
 *
 * It exists because of an off-by-a-tile that made two of the six jobs in
 * chores.js impossible. `fits` is the walk grid eroded by a body's radius, and
 * with a 0.5 m tile against a 0.4 m radius that erosion takes every tile
 * ORTHOGONALLY ADJACENT to a blocked one — so whether a body fits in front of a
 * copier is not really a question about how far in front it is standing, it is a
 * question about which tile that lands in. Measured on one floor: every printer
 * station and every vending station on it failed, and moving the point 0.2 m
 * further out recovered all six vending machines and six of ten copiers. The
 * four that never recover are machines in rooms with genuinely nowhere to stand,
 * and dropping those is correct.
 *
 * Backwards, never sideways, and capped at NUDGE_MAX — about one tile. Backwards
 * keeps the body square to the thing it came to use, which is what the pose is
 * drawn for, and the cap is what stops "somewhere to stand at the copier" from
 * quietly becoming "somewhere in the room".
 *
 * A third kind of station — one you sit ON TOP of rather than at — is
 * `sittable` below, and `onto` is what asks for it.
 *
 * The moved station is a COPY. The raw list is shared between every pool built
 * off it, and a desk whose chair sits somewhere else because a standing job
 * nudged the record is the kind of bug that only shows up two features later.
 */

function standable(w, nav, nudge) {
  if (nav.fitsAt(nav.tx(w.x), nav.ty(w.z))) return w;
  if (nudge <= 0) return null;
  const [fx, fz] = FACING[w.rot & 3];
  for (let back = NUDGE_STEP; back <= nudge + 1e-6; back += NUDGE_STEP) {
    const x = w.x - fx * back;
    const z = w.z - fz * back;
    if (nav.fitsAt(nav.tx(x), nav.ty(z))) return { ...w, x, z };
  }
  return null;
}

/**
 * Where a body gets OFF a seat it is sitting on top of, or null if it cannot.
 *
 * The seat pools have always asked `fitsAt` at the station itself, and for a
 * chair that is exactly right: a chair is LOOSE, so it is not on the nav grid at
 * all (see the note on cardboard in CLAUDE.md) and its own tile is ordinary
 * walkable floor. A sofa is fitted. Its tile is blocked by construction, every
 * tile orthogonally adjacent to it is eroded out of `fits`, and no amount of
 * nudging along the cushion will ever find floor — measured, 5 of 85 lounge
 * seats survived `standable`, and the five that did were stools, which are
 * loose.
 *
 * So the question is asked the other way round. A seat on a sofa is usable if
 * there is somewhere to STEP OFF IT, and the station carries that spot: the
 * nearest tile out in front that a body fits in. The break's last act is to put
 * the body there before handing it back to the state machine — because the tile
 * it has been sitting on is one it cannot route away from, which is the canteen
 * chair bug (`fitsAt` in deskPool) in a room with better furniture.
 */

function sittable(w, nav, reach) {
  const [fx, fz] = FACING[w.rot & 3];
  for (let out = NUDGE_STEP; out <= reach + 1e-6; out += NUDGE_STEP) {
    const x = w.x + fx * out;
    const z = w.z + fz * out;
    if (nav.fitsAt(nav.tx(x), nav.ty(z))) return { ...w, step: { x, z } };
  }
  return null;
}

// Corridor waypoints for the panicking staffer. Sampled rather than exhaustive:
// he only needs somewhere to be running to, and a floor holds thousands of
// corridor tiles.
function collectCorridors(layout, nav) {
  const spots = [];
  const { W, H, tiles } = layout;
  let n = 0;
  for (let ty = 1; ty < H - 1; ty++) {
    for (let tx = 1; tx < W - 1; tx++) {
      if (tiles[ty * W + tx] !== CORRIDOR) continue;
      if (n++ % CORRIDOR_SAMPLE) continue;
      const x = centreX(layout, tx);
      const z = centreZ(layout, ty);
      if (nav.clear(x, z, RADIUS)) spots.push({ x, z });
    }
  }
  return spots;
}

/**
 * Mixed onto `Enemies.prototype` by enemies.js — see the note beside
 * `Object.defineProperties` at the bottom of that file for why these are
 * methods in an object rather than functions taking the roster.
 */

export const rosterMethods = {
    setColliders(statics, loose) {
      this.colliders = statics ?? [];
      this.loose = loose ?? [];
    }

    /**
     * Populates a floor. `tuning` scales with depth — see game.js.
     *
     * The shift is handed in rather than drawn here, and that is not tidiness: it
     * decides what is fitted to the BUILDING as well as who is standing in it
     * (see `conveyors` on THEMES), so it has to be known before the floor's
     * colliders go to the solver — which is well before this runs. It is still
     * the first draw off the floor's rng, exactly where it was, so nothing after
     * it moved. Left off, it is drawn here as before.
     */,

    spawn(layout, nav, rng, tuning, workstations = [], theme = null) {
      this.clear();
      this.nav = nav;
      this.tuning = tuning;
      // Held for the things that happen to a floor after it has been populated —
      // the alarm response, which needs the roster's own dice and the floor's own
      // locks to decide who turns up carrying what.
      this.layout = layout;
      this.rng = rng;
      this.shoutTimer = 0;
      this.theme = theme ?? pickTheme(layout.floorNumber, rng);
      this.corridors = collectCorridors(layout, nav);
      this.desks = deskPool(workstations, nav, rng, 'desk');
      // The canteen's chairs, pooled apart from the desks because they are not
      // jobs: see `at` on sink.workstation in gen/sink.js.
      this.tables = deskPool(workstations, nav, rng, 'table');
      // ...and a meeting room's, which are a third thing again and are kept BY
      // ROOM rather than flattened, because that is the whole of what a meeting
      // is: everybody in the same room. Un-nudged like the other two seat pools —
      // `stations` moves a record back off its furniture so a body fits in front
      // of it, and a chair may never be moved, because the seated pose is drawn
      // relative to the seat. See `standable`.
      this.meetingSeats = deskPool(workstations, nav, rng, 'meeting');
      // ...and the fourth seat pool: the sofas, armchairs and stools in the
      // building's break rooms. Kept by room like the meeting chairs, because a
      // break taken here has to know which room to be out of before it counts as
      // over (see the `leave` stage).
      this.lounges = deskPool(workstations, nav, rng, 'lounge', 0, LOUNGE_STEP);
      // Where you queue and where the trays go back, both registered by the
      // furnisher because it is the only thing that knows where the counter
      // actually landed (see `cafeteria` in gen/rooms.js). Unlike a chair these
      // are shared and never taken out of the pool: a serving hatch is somewhere
      // you stand for four seconds, not somewhere you sit for a minute.
      this.servery = deskPool(workstations, nav, rng, 'servery').get(layout.cafeteriaRoom) ?? [];
      // Behind the counter in the lift lobby, and there is exactly one of them on
      // the floor. Kept BY ROOM rather than flattened into `stations` below — for
      // the reason the servery is kept by room: it is a fact about one room, and a
      // station some other room happened to publish under the same name would put
      // the receptionist in somebody's office. Left as the map `deskPool` returns
      // rather than reduced to the lobby's list here, because `_takeDesk` is what
      // reads it and `_takeDesk` takes a map — handing it an array throws, which
      // is what it did, and the throw took `spawn` down with it: no diners, no
      // janitors, no manager and no cards on the first floor of every run.
      this.reception = deskPool(workstations, nav, rng, 'reception', STAND_NUDGE);
      // Every OTHER kind of station the furnisher published, pooled by what it is
      // a place to work at and flattened the same way — a printer is a printer
      // whosever office it is in, so unlike a chair it does not matter which room
      // it came out of. Built generically rather than one line per kind, so this
      // file does not have to learn the vocabulary of the module that reads them:
      // `chores.js` asks for what it wants by name and gets nothing if the floor
      // has none.
      this.stations = new Map();
      for (const at of new Set(workstations.map((w) => w.at))) {
        this.stations.set(at,
          [...deskPool(workstations, nav, rng, at, STAND_NUDGE).values()].flat());
      }
      // Where a box comes off a rack, for the parcel runs (see jobs.js). Flattened
      // out of the by-room map, because unlike a chair or a serving hatch it does
      // not matter WHOSE storeroom it is — a run wants any rack anybody can walk
      // to. Shared and never taken out of the pool, like the servery: it is
      // somewhere a machine stands for two seconds, and one of the pools above
      // rather than a pool of its own because it is the same question.
      this.shelves = this.stations.get('shelf') ?? [];
      // Where a body stands with the lift doors in front of it. Two things want
      // it — the errands that leave by a lift (chores.js) and `_visitor`, which
      // stands a man there when the floor is generated — so it is derived here
      // once rather than in either of them.
      this.lifts = liftSpots(layout, nav, this.corridors);
      // ...and where they go back. Falling back to the counter itself is not a
      // fudge: a rack that a body cannot stand at is dropped like any other
      // station, and handing your tray back across the counter you took it from is
      // what you would do in a canteen that has no rack. What it buys is that the
      // cycle can always be finished — a break with nowhere to put the tray down
      // is a body stuck holding it for the rest of the floor.
      this.trayRack = (deskPool(workstations, nav, rng, 'trays').get(layout.cafeteriaRoom) ?? [])[0]
        ?? this.servery[0] ?? null;
      this.lunchTimer = LUNCH_FIRST;

      const spots = this._spawnPoints(layout, nav, rng, tuning.count);
      // A room holds a team, not a headcount. Whoever is in a room is in it
      // together — same type, working the same job — because a room of one intern,
      // one manager and one sentry is a spawn list, and a room of three interns is
      // a room. Some rooms get nobody, which is what makes the occupied ones feel
      // deliberate rather than sprinkled.
      let team = null;
      let left = 0;
      for (const spot of spots) {
        if (left <= 0 || spot.room !== team?.room) {
          team = { room: spot.room, type: pickType(layout.floorNumber, rng, this.theme) };
          left = rng.chance(0.45) ? 1 : (rng.chance(0.72) ? 2 : 3);
        }
        left--;
        // On their feet, wherever they were put down. Nobody who is going to fight
        // you is found sitting in a chair — a seated body on this floor means a
        // harmless one, and the only exceptions are the two placed by hand, which
        // are worth it: the Manager at his own desk and one guard on the cameras.
        this._add(spot.x, spot.z, rng, tuning, team.type);
      }

      this._security(layout, nav, rng, tuning);

      // A handful of neutrals on every floor, placed rather than rolled: they are
      // a fixture of the building, not a difficulty ingredient, and leaving them
      // to the weighted draw would mean floors without any. They all start in a
      // corridor because that is where the point of them is — you are supposed to
      // see one cross the end of a hallway and have to decide, quickly, whether it
      // mattered.
      const neutrals = [];
      for (let i = rng.int(HALL_PANICKERS[0], HALL_PANICKERS[1]); i > 0; i--) {
        neutrals.push(TYPES.panicker);
      }
      // Scaled by the size of the slab rather than fixed — see HALL_BYSTANDERS.
      // Rounded, and never to nothing: a floor with no harmless staff on it at all
      // is a floor where every silhouette down a corridor is a target, which is the
      // decision these exist to make you keep having to take.
      const crowd = Math.max(1, Math.round(
        rng.int(HALL_BYSTANDERS[0], HALL_BYSTANDERS[1]) * (layout.areaRatio ?? 1)));
      // Who that crowd IS is the theme's, because the background traffic is a fact
      // about the building rather than about the roster: a floor run by machines
      // has its errands run by the people who maintain them, and a night cleaner
      // walking a corridor of Welder Units is somebody who did not get the memo.
      // Named by key and resolved here so a theme stays pure data.
      const kinds = this.theme.bystanders?.map((k) => TYPES[k]).filter(Boolean);
      const bystanders = kinds?.length ? kinds : BYSTANDERS;
      // ONE OF EACH FIRST, and the rest of the crowd rolled.
      //
      // This is the same "set a floor of one" the security office and the broom
      // closet both make, and it is here for the same kind of reason rather than
      // for tidiness. A theme that names its own traffic is saying these are the
      // people in its halls — so a floor that happens to roll none of one of them
      // has quietly lost half of what the theme said, and on an Automated floor it
      // loses a feature outright: a parcel run needs a Maintenance Worker to take
      // the box at the belt, and with `rng.pick` alone a crowd of three or four
      // draws zero workers often enough to matter. Found by trying to watch one —
      // 3 porters, 0 workers, and jobs.js correctly refusing to cast a run it
      // could not finish, which is silent by design and so says nothing.
      //
      // Capped at the crowd, so a small floor still gets a small crowd rather than
      // one of everything on top of it.
      for (let i = 0; i < Math.min(crowd, bystanders.length); i++) neutrals.push(bystanders[i]);
      for (let i = crowd - bystanders.length; i > 0; i--) neutrals.push(rng.pick(bystanders));

      for (let i = 0; i < neutrals.length; i++) {
        // A few tries at somewhere nobody is already standing, and the last pick
        // regardless if the floor is too busy to find one: a body a metre inside
        // another body is bad, and a floor quietly one courier short of what it
        // rolled is worse — nothing downstream would ever say so.
        let spot = null;
        for (let tries = 0; tries < 8; tries++) {
          spot = this.corridors.length ? rng.pick(this.corridors) : spots[i];
          if (!spot) break;
          if (!this.items.some((e) => Math.hypot(e.x - spot.x, e.z - spot.z) < NEUTRAL_GAP)) break;
        }
        if (spot) this._add(spot.x, spot.z, rng, tuning, neutrals[i]);
      }

      // And the rats, which go anywhere rather than starting in a corridor: the
      // point of the staff is that you see them cross a hallway and have to
      // decide, and the point of a rat is that it is already in the room with you.
      const [ratMin, ratMax] = this.theme.rats ?? [1, 1];
      for (const spot of this._loose(layout, nav, rng, rng.int(ratMin, ratMax))) {
        this._add(spot.x, spot.z, rng, tuning, TYPES.rat);
      }

      // And the floor cleaners. One is the joke — an office with a robot vacuum
      // in it, bumping off a skirting board while a firefight goes on over its
      // head. A theme may ask for a fleet instead (`cleaners` on THEMES), which
      // is the same joke told about the building rather than about one machine:
      // on a floor run by machines the cleaning is done by machines too, and
      // several of them crossing a corridor is what says so before you have met
      // anything that shoots. They are neutral and `offMap`, so a fleet costs
      // the floor no difficulty and the minimap no clutter.
      const [cleanMin, cleanMax] = this.theme.cleaners ?? [1, 1];
      for (const spot of this._loose(layout, nav, rng, rng.int(cleanMin, cleanMax))) {
        this._add(spot.x, spot.z, rng, tuning, TYPES.roomba);
      }

      this._cardOutside(layout, nav, rng, tuning);
      this._receptionist(layout, nav, rng, tuning);
      this._visitor(layout, nav, rng, tuning);
      this._diners(layout, nav, rng, tuning);
      this._janitors(layout, nav, rng, tuning);
      this._manager(layout, nav, rng, tuning);
      this._generatorRoom(layout, nav, rng, tuning);
      this._dealCards(layout, rng);
    }

    /**
     * Security: the shift walking the halls, and the ones sat in their own office.
     *
     * Same shape as the janitors and the broom closet one tier along, and for the
     * same reason. The blue card comes off security and off nobody else, so where
     * they stand is a correctness question: the ones on rounds are in the
     * corridors, outside every lock, which is what guarantees the card is
     * reachable with nothing in your pocket. The two-to-five in the security
     * office are marked `behindLock` and dealt nothing, because men sitting in the
     * room their own key opens, holding that key, is the failure the whole system
     * exists to prevent.
     *
     * The one place it differs is that a patrol is not just a card holder. Every
     * other hostile is found where they work, which makes a floor a series of
     * rooms you clear; a patrol is the one thing that comes to YOU, down a hallway
     * you have already been down. That is what `patrols` on a theme tunes — except
     * that a theme is allowed to say nobody is doing rounds tonight, and a floor
     * with a security office and nobody outside it is a door with no key. So the
     * theme sets the number and the office sets the floor under it.
     */,

    _security(layout, nav, rng, tuning) {
      const office = layout.locks?.find((l) => l.tier === 'blue');

      // Corridors outside every lock, preferring the ones that are not on top of
      // the lifts — being close to where the player arrives is fine, standing on
      // it is not.
      const free = this.corridors.filter((s) => !this._behindALock(layout, s.x, s.z));
      const away = free.filter((s) =>
        Math.hypot(s.x - layout.spawn.x, s.z - layout.spawn.z) > MIN_SPAWN_GAP);
      const halls = away.length ? away : free;

      const [patMin, patMax] = this.theme.patrols ?? [1, 3];
      const wanted = Math.max(rng.int(patMin, patMax), office ? 1 : 0);

      let onRounds = 0;
      for (let i = wanted; i > 0 && halls.length; i--) {
        const spot = rng.pick(halls);
        this._add(spot.x, spot.z, rng, tuning, this._guardType(rng));
        onRounds++;
      }

      // And the office. Only if somebody outside is carrying the key to it: these
      // count toward clearing the floor, so posting them behind a door with no
      // reachable blue card anywhere is a floor that cannot be finished.
      if (!office || !onRounds) return;

      const room = office.room;
      let posted = 0;
      const want = rng.int(OFFICE_GUARDS[0], OFFICE_GUARDS[1]);

      // One of them is on the cameras, which is the only reason this room is here.
      // The camera desk goes in first and unconditionally when the room is
      // furnished (securityOffice in gen/rooms.js), so the chair in front of the
      // wall of screens is the one desk on the floor that is certain to exist —
      // and a bank of monitors with nobody watching it is a worse room than one
      // with five men standing around in it.
      const cams = this._takeDesk(room, (x, z) => nav.clear(x, z, RADIUS));
      if (cams) {
        const watcher = this._add(cams.x, cams.z, rng, tuning, this._guardType(rng));
        watcher.behindLock = true;
        this._seat(watcher, cams);
        posted++;
      }

      for (let tries = 0; tries < 120 && posted < want; tries++) {
        const tx = rng.int(room.x0, room.x1 - 1);
        const ty = rng.int(room.y0, room.y1 - 1);
        if (!nav.walkable(tx, ty)) continue;
        const x = nav.wx(tx), z = nav.wz(ty);
        if (!nav.clear(x, z, RADIUS)) continue;
        // Five men in one small room will otherwise be dealt the same two tiles.
        if (this.items.some((e) => Math.hypot(e.x - x, e.z - z) < GUARD_GAP)) continue;

        const e = this._add(x, z, rng, tuning, this._guardType(rng));
        e.behindLock = true;
        posted++;
      }
    }

    /**
     * A camera got six seconds of you, or you walked through a laser. Security
     * responds.
     *
     * Three things happen, and which of the first two dominates is decided by
     * something the player did ten minutes ago:
     *
     *  - **The office comes out.** Anybody still sitting in the security office
     *    unlocks their own door and leaves through it. This is the one place in
     *    the game where the lock rule is bypassed, and it is bypassed for exactly
     *    these men: they are `keyed` from here on, which means a badge at the
     *    door's sensor (doors.js) and a second distance field at the nav grid
     *    (nav.setBadgeTiles). The keyring is the shift's real one — white and blue
     *    — so the broom closet, the back-of-house rooms and the manager's office
     *    are as shut to them as they were before, and nothing about when the black
     *    card drops moves. Clearing the office early stops all of this happening,
     *    which is what makes clearing it early a trade.
     *  - **The rest are sent up.** Four of them, in the corridors, out of sight,
     *    at a walked distance rather than a straight-line one — nobody appears in
     *    a doorway you were looking at. If the office is still manned it is only
     *    two, because the men in it are already part of the answer. Same badge:
     *    they are the same shift, and a response that stops at the first white
     *    door between it and you is not one.
     *  - **And the floor hears it.** Everybody idle with a route to you starts
     *    walking it. They are NOT keyed — they are staff who heard a klaxon, not
     *    men who were sent — so they come the way the building lets them and a
     *    locked door ends the walk. `pathDistance` is what says so, coming back -1
     *    across a lock, which is the same rule that already governs hearing a gun.
     *
     * The first two arrive angry, which here means `chase` with your last position
     * already in hand: an alarm response that has to find you by walking into your
     * line of sight is not a response, it is more staff.
     *
     * Returns what happened, because the toast that says so belongs to game.js —
     * and the meshes, because bullets have to be told about anybody who was not on
     * the floor when it was generated.
     */,

    alarm(px, pz) {
      if (!this.nav || !this.rng) return { spawned: [], meshes: [], roused: 0, heard: 0 };

      // The office. Guards specifically: the janitors on their break are behind a
      // door too and an alarm is not their problem.
      const held = this.items.filter((e) => e.alive && e.behindLock && e.type.guard);
      for (const e of held) {
        this._keyed(e);
        // They are not men behind a lock any more, and that is not bookkeeping:
        // `behindLock` is what keeps somebody out of openHostileCount, and the
        // black card drops when that reaches zero. Leave it set and a floor could
        // hand you the last card while four guards are still walking at you.
        e.behindLock = false;
        this._rouse(e, px, pz);
      }

      const wanted = held.length ? RESPONSE_HELD : RESPONSE;
      const spawned = [];
      const meshes = [];
      for (const spot of this._responseSpots(px, pz, wanted)) {
        const baton = this.rng.chance(GUARD_BATON);
        // A seed of this body's own, drawn from the floor's stream so the host's
        // dice roll on exactly as they did before. It exists so a co-op joiner can
        // build the SAME man: these four are not in the seeded roster — they were
        // sent up after the floor was generated — so the only way both browsers
        // get one person rather than two is to share what he was rolled from.
        const seed = this.rng.int(0, 0x7fffffff);
        const type = baton ? TYPES.guardBaton : TYPES.security;
        const e = this._add(spot.x, spot.z, makeRng(seed), this.tuning, type);
        // Security carries blue and nobody else does, and that stays true for the
        // ones who arrive late — otherwise an alarm on a floor whose only blue
        // holder you already shot would be four men carrying the wrong card.
        e.card = this.layout?.locks?.some((l) => l.tier === 'blue') ? 'blue' : 'white';
        this._keyed(e);
        this._rouse(e, px, pz);
        // What the other end needs to build him. Held on the body rather than
        // returned separately so it cannot get out of step with who was spawned.
        e.netSpawn = { x: spot.x, z: spot.z, baton, seed, card: e.card };
        spawned.push(e);
        meshes.push(...e.hitboxes);
      }

      // And everybody else on the floor with ears. Only the idle ones: anybody
      // already coming for you does not need telling twice, and a klaxon is not a
      // reason for a man in a firefight to go and look somewhere else.
      let heard = 0;
      for (const e of this.items) {
        if (!e.alive || e.neutral || e.state !== 'idle') continue;
        const along = this.nav.pathDistance(e.x, e.z, e.layer);
        if (along < 0 || along > ALARM_HEARING) continue;
        // Same shape as noticing a gunshot, deliberately: told roughly where, and
        // taking the same moment to decide anything about it. Clearing `contact`
        // is what makes it stick — it is seconds since the last contact, and
        // somebody who has been sitting in an office all floor is well past
        // GIVE_UP, so without this they would drop back to idle on arrival.
        e.state = 'alert';
        e.timer = this.tuning.reaction;
        e.contact = 0;
        e.lastSeen = { x: px, z: pz };
        heard++;
      }

      return { spawned, meshes, roused: held.length, heard };
    },

    // Somebody who now knows exactly where you are. Not `alert` — that is the
    // reaction delay of a man looking up from a desk, and this one was told.
    _rouse(e, px, pz) {
      if (!e.alive || e.neutral) return;
      e.state = 'chase';
      e.timer = 0;
      e.contact = 0;
      e.lastSeen = { x: px, z: pz };
    },

    // Somebody a locked door does not stop. One flag, read in the two places that
    // have to agree about it — the door's sensor, and the route into that door —
    // and counted once a frame in _rebuildNeighbours, because the second distance
    // field is only worth flooding while one of them is alive to walk it.
    _keyed(e) { e.keyed = true; }

    /**
     * Where the response comes in. Corridors, because that is what a floor's
     * circulation is and because it is the one part of it no card shuts them out
     * of; far enough away to be a response rather than an ambush; and never
     * anywhere you can see, because a man fading in at the end of a hallway you
     * are looking down is the one thing that would make the whole system read as
     * cheating.
     *
     * Each of those is dropped in turn if the floor cannot satisfy it. A response
     * that arrives closer than it should is a worse alarm; a response that never
     * arrives is a broken one.
     */,

    _responseSpots(px, pz, want) {
      const out = [];
      // Three passes over the same pool: the full test, then without the sight
      // test, then with only "is there a route to the player at all".
      for (let pass = 0; pass < 3 && out.length < want; pass++) {
        for (const s of this.rng.shuffle([...this.corridors])) {
          if (out.length >= want) break;
          if (this._behindALock(this.layout, s.x, s.z)) continue;
          if (!this.nav.clear(s.x, s.z, RADIUS)) continue;
          if (out.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < 1.6)) continue;

          // Negative means no route from here to the player at all, which is the
          // one condition no pass may drop.
          const along = this.nav.pathDistance(s.x, s.z);
          if (along < 0) continue;
          if (pass < 2 && (along < RESPONSE_MIN || along > RESPONSE_MAX)) continue;
          if (pass < 1 && this.nav.losClear(s.x, s.z, px, pz)) continue;

          out.push(s);
        }
      }
      return out;
    },

    // Which half of the shift this one is. A room of guards is meant to come at
    // you as a room rather than as a firing line: whoever drew a baton is the one
    // closing the distance while the rest of them shoot over him.
    _guardType(rng) {
      return rng.chance(GUARD_BATON) ? TYPES.guardBaton : TYPES.security;
    }

    /**
     * The cleaning staff: a few doing rounds, and the two in the cupboard.
     *
     * They are the only source of the yellow card, so where they stand is a
     * correctness question rather than a flavour one. The ones on rounds go in the
     * corridors — outside every lock, which is what guarantees the card is
     * reachable with nothing in your pocket — and the two in the broom closet are
     * marked `behindLock` so they are not dealt one. Two men standing in the room
     * their own key opens, holding that key, is the exact failure the whole
     * keycard system is built to avoid.
     *
     * So the closet is the same shape as the manager's office one tier down: you
     * take the card off somebody in a hallway, and it buys you a door with two
     * more of them behind it who did not hear you coming.
     *
     * They used to be found sitting on the floor of it, on their break, and that is
     * gone for one reason: they are hostile, they carry a mop that hits harder than
     * most things on the floor, and they count toward clearing it — so a body
     * sitting down was the one tell in the building that meant "harmless" and also
     * meant nothing. Everything that sits now is something you can walk past.
     */,

    _janitors(layout, nav, rng, tuning) {
      // On rounds. Corridors, because a mop is used in corridors and because that
      // is the one place on the floor no card can shut you out of.
      const free = this.corridors.filter((s) => !this._behindALock(layout, s.x, s.z));
      const away = free.filter((s) =>
        Math.hypot(s.x - layout.spawn.x, s.z - layout.spawn.z) > MIN_SPAWN_GAP);
      // Standing on the lift lobby is worse than being close to it, so the
      // distance filter is a preference rather than a requirement.
      const spots = away.length ? away : free;

      let onRounds = 0;
      for (let i = rng.int(JANITORS[0], JANITORS[1]); i > 0 && spots.length; i--) {
        const spot = rng.pick(spots);
        this._add(spot.x, spot.z, rng, tuning, TYPES.janitor);
        onRounds++;
      }

      // And the two on their break, sitting it out behind their own door.
      //
      // They only exist if somebody outside is carrying the key to it. The two of
      // them count toward clearing the floor, so seating them behind a door with
      // no reachable yellow card anywhere would be a floor that cannot be
      // finished — the one bug this whole system is arranged to make impossible.
      const closet = layout.locks?.find((l) => l.tier === 'yellow');
      if (!closet || !onRounds) return;

      const room = closet.room;
      const placed = [];
      for (let tries = 0; tries < 60 && placed.length < CLOSET_JANITORS; tries++) {
        const tx = rng.int(room.x0, room.x1 - 1);
        const ty = rng.int(room.y0, room.y1 - 1);
        if (!nav.walkable(tx, ty)) continue;
        const x = nav.wx(tx), z = nav.wz(ty);
        if (!nav.clear(x, z, RADIUS)) continue;
        // Spaced like the men in the security office, and for the same reason: a
        // broom closet is a small room and two tries can otherwise land on tiles a
        // shoulder apart.
        if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < GUARD_GAP)) continue;

        const e = this._add(x, z, rng, tuning, TYPES.janitor);
        e.behindLock = true;
        placed.push({ x, z });
      }
    }

    /**
     * The manager, in the manager's office, behind the manager's door.
     *
     * He is the only person on the floor who works behind a real lock, and he is
     * the reason the black card is worth having: every other badged room is loot
     * you can walk past, and this one is the last thing between you and the lift.
     *
     * That inverts the usual rule — the black room IS on the critical path, where
     * grey, blue and yellow never are — and it only works because of when his card
     * arrives. The black card comes off the last hostile OUTSIDE this room (see
     * game.js), so by the time he is the only one left you are already holding the
     * key to his door. There is no order of events in which the floor locks up.
     *
     * He is a Manager whatever floor this is, `unlockFloor` notwithstanding. A
     * manager's office with an intern in it is a joke that only works once, and
     * the room is announced by a black keycard — it has to be worth the walk back.
     */,

    _manager(layout, nav, rng, tuning) {
      const lock = layout.locks?.find((l) => l.tier === 'black');
      if (!lock) return;

      const room = lock.room;
      // At his desk, which is the one in this building that faces a wall with a
      // bookcase behind it (see managerOffice in gen/rooms.js). No distance rule
      // on it: his office is wherever the black lock landed, and the man works
      // where he works. Nobody else can have taken it — the room is staff-only, so
      // `_spawnPoints` never staffed it.
      const desk = this._takeDesk(room, (x, z) => nav.clear(x, z, RADIUS));
      if (desk) {
        const boss = this._add(desk.x, desk.z, rng, tuning, TYPES.manager);
        boss.behindLock = true;
        this._seat(boss, desk);
        return;
      }

      for (let tries = 0; tries < 40; tries++) {
        const tx = rng.int(room.x0, room.x1 - 1);
        const ty = rng.int(room.y0, room.y1 - 1);
        if (!nav.walkable(tx, ty)) continue;
        const x = nav.wx(tx), z = nav.wz(ty);
        if (!nav.clear(x, z, RADIUS)) continue;

        const boss = this._add(x, z, rng, tuning, TYPES.manager);
        // What keeps him out of openHostileCount, and out of _dealCards — a card
        // in his pocket is a card behind his own door.
        boss.behindLock = true;
        return;
      }
    }

    /**
     * The receptionist, behind the counter in the lift lobby.
     *
     * The first person on the floor, and the only body ever placed in the arrival
     * room — `_spawnPoints` skips that room entirely, so the lobby is empty apart
     * from this one. That is what makes them worth having: you step out of the
     * car, and there is somebody looking at you across a counter before you have
     * gone through a door.
     *
     * And three times in ten they are not pleased to see you (`ANGRY`). The two
     * types are the same person in the same clothes at the same counter and differ
     * in one thing, which is the visor — so this is the game's oldest tell put to
     * the only use it has never been put to: not "what is this" but "is this one
     * going to be a problem", asked of a room you cannot avoid walking into.
     * Violet means walk past; a grey off the hostile ramp means it is about to
     * stand up. Nothing else about them says which, on purpose.
     *
     * Standing rather than seated, and that is not an oversight. A chair in this
     * building means "has not noticed you yet" (see the note on it in CLAUDE.md),
     * and this one has: they watched the doors open. What they do about it is the
     * coin, and a seated pose would be promising the wrong thing about both halves
     * of it.
     *
     * Taken out of the pool like a desk, so nothing else can be dealt the spot.
     * A lobby that could not fit a counter publishes no station and has nobody at
     * one, which is an ordinary answer: see the `behind` option on `edgeProp` in gen/placement.js.
     */,

    _receptionist(layout, nav, rng, tuning) {
      const room = layout.spawnRoom;
      if (!room) return;
      const at = this._takeDesk(room, (x, z) => nav.clear(x, z, RADIUS), this.reception);
      if (!at) return;

      const e = this._add(at.x, at.z, rng, tuning,
        rng.chance(ANGRY_RECEPTION) ? TYPES.angryReceptionist : TYPES.receptionist);
      // Facing whoever comes out of the lift, which is what the counter faces.
      // Same conversion `_seat` makes and for the same reason — a prop's turns
      // rotate its front from -Z toward +X, which is a negative rotation about Y.
      e.yaw = -at.rot * Math.PI / 2;
      e.group.rotation.y = e.yaw;
    }

    /**
     * The man in the coloured suit, standing in the other lift.
     *
     * He does not work here. He came up to collect something, and what he does
     * about it is `collection` in chores.js: walk to a storage rack, take a crate
     * off it, carry it back to a lift and go down with it. The errand itself is
     * two legs of the routine table and nothing new — what is new is at the ends
     * of it, which is this method and `showOut` below.
     *
     * PLACED AT FLOOR GENERATION, and that is a co-op decision rather than a
     * convenience. A body's index in `items` is its name on the wire, so the
     * roster is only ever APPENDED to and both browsers have to build it in the
     * same order from the same seed. The alarm response is the one thing that adds
     * to it mid-floor and it pays for that with a packet per man; a visitor rolled
     * on the host alone would leave the two rosters different lengths and every
     * index after his landing on the wrong person.
     *
     * So he is dealt with the floor and simply starts somewhere else: AT a lift,
     * on the spot a body stands with the doors in front of it, which is the same
     * spot he will come back to. The doors have just closed behind him.
     *
     * At it rather than IN it, and that is a fact about the building rather than a
     * preference. A lift opening is 1.0 m and a body is 0.8 m across on a 0.5 m
     * grid, so both of the car's door tiles are eroded out of `fits` and the
     * interior is an island — the player walks in and out of one because their
     * collision is continuous, and nobody else can. Placed inside the car he
     * reached 2 tiles of a 14,759-tile floor and stood in them for the whole level.
     * See `liftSpots`, which is where that is written down and where the spot
     * comes from.
     *
     * The DEPARTURE car if the floor has one, because that is the one the player
     * is not standing in before they have moved — you come up in one lift and
     * somebody else has come up in the other.
     *
     * Not every floor gets one. He is a thing you come across rather than a
     * fixture, which is the argument `postrun` makes about itself one line up in
     * the routine table.
     */,

    _visitor(layout, nav, rng, tuning) {
      if (!rng.chance(VISITOR_CHANCE)) return;
      // The lift he came up in: the departure car's spot if there is one, and the
      // arrival's if the floor only managed one car. Either is somewhere a body
      // provably fits, which is the whole reason the list is derived rather than
      // measured here.
      const at = this.lifts.find((l) => l.car === layout.lifts?.departure) ?? this.lifts[0];
      if (!at || !nav.clear(at.x, at.z, RADIUS)) return;

      // His own suit, off the floor's rng so both browsers roll the same one. The
      // type is CLONED rather than tinted, because `TYPES` entries are shared: one
      // contractor changing colour would change every contractor on every floor
      // still standing in memory.
      // The type as it stands: his clothes are a uniform now rather than a
      // colour rolled per visit, so there is nothing to override and nothing
      // drawn off the floor's rng to override it with.
      const e = this._add(at.x, at.z, rng, tuning, TYPES.contractor);
      // Facing the doors, which is where `rot` already points — he has just turned
      // round out of the car. Same conversion `_seat` makes: a quarter turn is a
      // negative rotation about Y.
      e.yaw = -at.rot * Math.PI / 2;
      e.group.rotation.y = e.yaw;
      this.visitor = e;
    }

    /**
     * ...and he is gone.
     *
     * The last leg of a collection ends at a lift, and what happens then is the one
     * thing on the chore table that outlives its errand: the body stops being on
     * the floor. He steps into the car, the doors close, and that is the end of it.
     *
     * HE KEEPS HIS SLOT, and that is the whole reason this is four lines rather
     * than a splice. `index` is a body's name on the wire and every index after a
     * removed one would shift, so `items` is only ever appended to — which is
     * stated on `index` itself in `_add`. What "gone" means instead is exactly
     * what a corpse already means minus the corpse: not drawn, not on the minimap,
     * not anybody's target, and not ticked.
     *
     * The hitboxes are left where they are with their back-reference cleared,
     * which is `_die`'s own mechanism and is here for its reason as well as its
     * own: a round should pass through a man who is not there, and the meshes are
     * the level's to dispose of rather than this method's.
     *
     * One way only. Nothing brings him back, on the wire or off it.
     */,

    _generatorRoom(layout, nav, rng, tuning) {
      const room = layout.rooms.find((r) => r.role === 'generator');
      if (!room) return;

      const techs = rng.int(GEN_TECHS[0], GEN_TECHS[1]);
      const want = techs + rng.int(GEN_WORKERS[0], GEN_WORKERS[1]);
      const spots = [];
      for (let tries = 0; tries < 300 && spots.length < want; tries++) {
        const tx = rng.int(room.x0, room.x1 - 1);
        const ty = rng.int(room.y0, room.y1 - 1);
        if (!nav.walkable(tx, ty)) continue;
        const x = nav.wx(tx), z = nav.wz(ty);
        if (!nav.clear(x, z, RADIUS)) continue;
        // The generator and its clutter already took a chunk of this room; the
        // spacing check is what stops the tries that are left crowding onto the
        // same free tile instead of spreading through the rest of it.
        if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < GUARD_GAP)) continue;
        spots.push({ x, z });
      }

      // Whatever the spacing check could not find room for comes off the workers
      // rather than off the technicians: the hostile half is what makes the room a
      // fight at all, and a tight room that only fitted four people should still be
      // the plant room rather than four men ignoring you.
      const angry = Math.min(techs, spots.length);
      for (let i = 0; i < spots.length; i++) {
        this._add(spots[i].x, spots[i].z, rng, tuning, i < angry ? TYPES.technician : TYPES.worker);
      }
    }

    /**
     * The staff already on their break when the floor is generated.
     *
     * They are the beat the whole lunch cycle opens on: a canteen with people
     * eating in it rather than an empty room with a counter, so the first person
     * to walk down for lunch is joining something rather than starting it. All of
     * them are harmless, none counts toward clearing the floor, and walking past
     * the lot of them costs nothing.
     *
     * The canteen is no longer the room the floor arrives in — that is the
     * reception outside the lifts now (see pickSpawnRoom in gen/layout.js) — so
     * this is a room the player FINDS rather than one they are put down in, and
     * the diners are no longer the only people in it: `_spawnPoints` skips the
     * arrival room and nothing else, so the canteen is staffed like any other
     * room. That is the right way round. A canteen you walk into is a room with
     * its own staff in it and four people at their lunch among them; the version
     * where it was the arrival needed everybody in it to be harmless because the
     * player was standing in the middle of it holding nothing.
     */,

    _diners(layout, nav, rng, tuning) {
      const room = layout.cafeteriaRoom;
      if (!room) return;

      // Seated first, and only into a chair a whole body fits in front of — the
      // pool has already dropped the ones nav cannot stand anybody at (see
      // deskPool). Taking a seat REMOVES it, so two people can never be dealt the
      // same chair, which would be one body inside another eating the same lunch.
      for (let i = rng.int(DINERS[0], DINERS[1]); i > 0; i--) {
        const seat = this._takeDesk(room, (x, z) => nav.clear(x, z, RADIUS), this.tables);
        if (!seat) break;
        const diner = this._add(seat.x, seat.z, rng, tuning, TYPES.diner);
        this._seat(diner, seat, 'table');
        // Half way through the cycle rather than at the start of it: they are
        // already eating when the floor opens, because that is the picture the
        // arrival is for. Everything after this beat is the same cycle any
        // employee who comes down for lunch later will walk. See _lunch.
        this._lunchSeated(diner, seat, rng);
      }

      // And a couple on their feet: at the counter, in a gangway, wherever the room
      // has floor left. A canteen where every single person is seated in a row
      // reads as a waiting room — and somebody standing is also what makes the
      // seated ones read as people who chose to sit rather than as furniture with
      // heads on.
      for (let i = rng.int(DINERS_STANDING[0], DINERS_STANDING[1]); i > 0; i--) {
        let spot = null;
        for (let tries = 0; tries < 60 && !spot; tries++) {
          const tx = rng.int(room.x0, room.x1 - 1);
          const ty = rng.int(room.y0, room.y1 - 1);
          if (!nav.walkable(tx, ty)) continue;
          const x = nav.wx(tx), z = nav.wz(ty);
          if (!nav.clear(x, z, RADIUS)) continue;
          // Off the arrival point, and off each other. The seats need neither —
          // no table is furnished into the square kept clear where the player
          // materialises, and a chair can only be dealt once.
          if (Math.hypot(x - layout.spawn.x, z - layout.spawn.z) < DINER_SPAWN_GAP) continue;
          if (this.items.some((e) => Math.hypot(e.x - x, e.z - z) < NEUTRAL_GAP)) continue;
          spot = { x, z };
        }
        if (!spot) break;
        this._add(spot.x, spot.z, rng, tuning, TYPES.diner);
      }
    }

    /**
     * The people with a badge who are standing where no badge is needed to reach
     * them.
     *
     * This is the load-bearing guarantee of the whole keycard system, and it falls
     * out of one decision: white is on every door. Every employee is carrying a
     * white card and nearly every employee is behind a white door, so until you
     * have taken one off somebody the floor is a corridor network with two hundred
     * shut rooms off it. Nobody comes out to meet you either — a badged door is
     * shut to the staff as well, at the nav grid.
     *
     * So the opening of a floor is a short prologue, and this decides how short.
     * One hostile in a corridor would technically satisfy the invariant and would
     * make every floor start with a five-minute walk looking for one man. A
     * handful, with at least one close enough to walk into, makes it thirty
     * seconds: find somebody, take the badge, and the building comes on.
     *
     * Security patrols usually cover this already — they are in the corridors by
     * construction — but there may be as few as one of them, and on a floor with
     * no security office to guard there may be none at all. So the top-up is
     * whatever is working this floor rather than more security. On an Infestation
     * that is something shambling down a hallway, which is what an Infestation
     * looks like anyway.
     */,

    _cardOutside(layout, nav, rng, tuning) {
      // "Outside a lock" is not enough on its own any more: the corridors have
      // readers on them too, so a corridor can be outside every ROOM lock and
      // still be on the far side of a hall door the player has no badge for.
      // `layout.prologue` is what they can actually walk to on arrival holding
      // nothing, and the generator guarantees there is room out there to stand in
      // (see hallLocks).
      const free = (x, z) => !this._behindALock(layout, x, z) && this._reachable(layout, x, z);
      let have = 0;
      let nearest = Infinity;
      for (const e of this.items) {
        if (e.neutral || !free(e.x, e.z)) continue;
        have++;
        nearest = Math.min(nearest, Math.hypot(e.x - layout.spawn.x, e.z - layout.spawn.z));
      }

      // Every corridor tile they can reach, sorted by how far it is — the top-up
      // fills in from the near end, because the point is the first contact rather
      // than the head count.
      //
      // Taken off the tile grid rather than off `this.corridors`, which is every
      // tenth tile: sampling is fine for picking a patrol route and is not fine
      // here, because ten qualifying tiles can sample down to one and then lose
      // that one to a filing cabinet. This is the guarantee, so it looks at all of
      // them.
      const all = this._prologueSpots(layout, nav);
      const far = all.filter((e) => e.d > MIN_SPAWN_GAP);
      // The gap is a preference, not a requirement. gen/layout.js guarantees there
      // is corridor beyond it, but furniture is placed after that promise is made
      // and could in principle fill every last standable tile — and a body on the
      // doormat is a worse floor, while a body nowhere at all is not a floor.
      const spots = far.length ? far : all;
      if (!spots.length) return;

      // Somebody inside FIRST_CONTACT of the lifts, and OUTSIDE_MIN of them in
      // total. Both are floors, not targets: a floor that already has a patrol
      // walking past the lobby gets nothing added.
      if (nearest > FIRST_CONTACT && spots[0].d <= FIRST_CONTACT) {
        this._add(spots[0].s.x, spots[0].s.z, rng, tuning, pickType(layout.floorNumber, rng, this.theme));
        have++;
      }
      for (let i = 1; have < OUTSIDE_MIN && i < spots.length; i++, have++) {
        const spot = rng.pick(spots.slice(0, Math.max(8, (spots.length * 0.4) | 0)));
        this._add(spot.s.x, spot.s.z, rng, tuning, pickType(layout.floorNumber, rng, this.theme));
      }
    }

    /**
     * Every standable corridor tile the player can reach holding nothing, nearest
     * to the lifts first.
     *
     * This is the enemies-side half of the prologue guarantee, and it is written
     * against the tile grid on purpose — see the note where it is called. The
     * layout counts these same tiles before any furniture exists (prologueRoom in
     * gen/layout.js); this counts what is actually left standable once the floor
     * is furnished, which is always the smaller number and is the one that decides
     * whether a floor can be started.
     */,

    _prologueSpots(layout, nav) {
      const { W, H, tiles } = layout;
      const out = [];
      for (let ty = 0; ty < H; ty++) {
        for (let tx = 0; tx < W; tx++) {
          const i = ty * W + tx;
          if (tiles[i] !== CORRIDOR) continue;
          if (layout.locked?.[i]) continue;
          if (layout.prologue && layout.prologue[i] < 0) continue;
          const x = nav.wx(tx), z = nav.wz(ty);
          if (!nav.clear(x, z, RADIUS)) continue;
          out.push({ s: { x, z }, d: Math.hypot(x - layout.spawn.x, z - layout.spawn.z) });
        }
      }
      return out.sort((a, b) => a.d - b.d);
    },

    // Can the player get here before they have badged anything at all? Only the
    // first white card cares — everything else on the floor is placed for a player
    // who is already holding one.
    _reachable(layout, x, z) {
      if (!layout.prologue) return true;
      const tx = Math.floor((x - layout.ox) / layout.TILE);
      const ty = Math.floor((z - layout.oz) / layout.TILE);
      if (tx < 0 || ty < 0 || tx >= layout.W || ty >= layout.H) return false;
      return layout.prologue[ty * layout.W + tx] >= 0;
    },

    _behindALock(layout, x, z) {
      if (!layout.locked) return false;
      const tx = Math.floor((x - layout.ox) / layout.TILE);
      const ty = Math.floor((z - layout.oz) / layout.TILE);
      if (tx < 0 || ty < 0 || tx >= layout.W || ty >= layout.H) return true;
      return layout.locked[ty * layout.W + tx] !== 0;
    }

    /**
     * Who is carrying a keycard.
     *
     * Everybody is carrying the white one, because everybody who works here has a
     * staff badge — that is what makes white on every door fair rather than
     * cruel. The real cards replace the white they would otherwise have had
     * (there are a hundred and forty others carrying that), and they go to
     * specific people: grey to whoever the shuffle turns up, but yellow and blue
     * to the two trades that own a room on this floor.
     *
     * Dealt after everyone is placed rather than during placement, because the
     * question it has to answer is about the floor as a whole: every lock on it
     * needs a holder who is not behind it. For grey, blue and yellow that is free
     * — nobody is placed inside a staff-only room at all — and for white it is
     * _cardOutside above.
     *
     * Only hostiles carry. The neutrals are the people you are explicitly allowed
     * to walk past, and putting the security card in a cleaner's pocket turns
     * "you never have to shoot these" into a lie told once per floor.
     *
     * Black is not dealt at all. It comes off the last hostile standing, which is
     * both why the manager's office is the last room on the floor and why it can
     * be a skeleton key without unlocking the floor early.
     */,

    _dealCards(layout, rng) {
      // `behindLock` is excluded: the manager's pockets are behind the manager's
      // door, so anything dealt to him is a key locked in with its own lock. The
      // same goes for the two janitors sitting in the broom closet.
      const hostiles = rng.shuffle(this.items.filter((e) => !e.neutral && !e.behindLock));
      for (const e of hostiles) e.card = 'white';

      const tiers = [...new Set((layout.locks ?? []).map((l) => l.tier))]
        .filter((t) => t !== 'black' && t !== 'white');

      // Two of them are not dealt with the rest, because they belong to a trade
      // rather than to whoever came up first in the shuffle: yellow is the
      // cleaning staff's and blue is security's, and every one of them on rounds
      // is carrying it. Which makes the broom closet and the security office rooms
      // you open because of who you shot, not because of what happened to fall out
      // of a body.
      const OWNED = { yellow: (e) => e.type === TYPES.janitor, blue: (e) => e.type.guard };
      for (const [tier, owns] of Object.entries(OWNED)) {
        if (!tiers.includes(tier)) continue;
        for (const e of hostiles) if (owns(e)) e.card = tier;
      }

      let i = 0;
      for (const tier of tiers) {
        if (OWNED[tier]) continue;
        // Never take a card off a janitor or a guard to hand out somebody else's.
        while (i < hostiles.length && hostiles[i].card !== 'white') i++;
        if (i >= hostiles.length) break;
        hostiles[i++].card = tier;
      }
      // Spares for the tiers that have more than one door, so a grey card is
      // something the floor hands you on the way past rather than one specific
      // body among a hundred and forty. Only ever over a white card: the shuffle
      // interleaves the owners with everybody else, so a spare pass that wrote
      // over whatever it landed on would quietly take the yellow off a janitor.
      const spares = tiers.filter((t) => t === 'grey');
      if (!spares.length) return;
      for (; i < hostiles.length; i++) {
        if (hostiles[i].card === 'white' && rng.chance(CARD_SPARE_CHANCE)) {
          hostiles[i].card = rng.pick(spares);
        }
      }
    },

    // Walkable spots anywhere on the floor, spawn included — used for things that
    // are scenery rather than opposition.
    _loose(layout, nav, rng, count) {
      const spots = [];
      for (let tries = 0; spots.length < count && tries < count * 40; tries++) {
        const tx = rng.int(0, layout.W - 1);
        const ty = rng.int(0, layout.H - 1);
        if (!nav.walkable(tx, ty)) continue;
        if (layout.locked?.[ty * layout.W + tx] === STAFF_ONLY) continue;
        const x = nav.wx(tx), z = nav.wz(ty);
        if (!nav.clear(x, z, RADIUS)) continue;
        spots.push({ x, z });
      }
      return spots;
    }

    /**
     * Walkable tiles well away from where the player arrives.
     *
     * Room by room rather than scattered, and each spot remembers which room it
     * came from, because who ends up standing together is decided from that (see
     * spawn). Rooms are visited in a shuffled order and a random number of spots
     * are taken from each, so the floor gets crowded rooms, quiet rooms and empty
     * ones instead of an even sprinkle of exactly one person everywhere.
     */,

    _spawnPoints(layout, nav, rng, count) {
      const spots = [];
      // Nobody works behind a REAL lock — grey, blue, yellow, black. That is the
      // rule that makes those four survivable: the card is never on the wrong side
      // of the door it opens. It costs half a dozen rooms of headcount out of a
      // hundred and forty, which is nothing next to a floor that cannot be
      // finished.
      //
      // White rooms are the opposite case and are staffed normally. White is on
      // every door in the building and on every employee in it, so a white room is
      // a room with the key to itself standing in it — and the guarantee that
      // makes the FIRST one openable is _cardOutside below, not this.
      // Nor in the room the player is standing in when the floor starts, whatever
      // that room is this time. Keyed off `spawnRoom` rather than off the 'lobby'
      // role, because the floor now arrives in its canteen when it has one (see
      // pickCafeteria in gen/roles.js) — and a role name is a fact about how a
      // room is FURNISHED, while "do not put anybody here" is a fact about where
      // the player materialises. Left as the role test, a cafeteria floor would
      // have opened with a dozen people standing around the arrival point.
      const rooms = rng.shuffle(
        layout.rooms.filter((r) => r !== layout.spawnRoom && !r.staffOnly));
      if (!rooms.length) return spots;

      // The same rooms, workplaces first. The roster is spread over a hundred-odd
      // rooms and runs out long before all of them have had a turn, so which rooms
      // get served BEFORE it runs out is the whole of where a floor's staff are —
      // and left to the shuffle that came out as six people at a desk on a floor
      // of a hundred and six, with two thirds of the building's desks empty and
      // the same headcount standing about in storerooms. A floor is staffed from
      // the rooms with desks in them outward, and the archive gets whoever is
      // left.
      //
      // First pass only. Held for every pass it would fill five rooms and empty
      // the rest of a floor that has few enough rooms to come round again.
      const deskless = (r) => (this.desks.get(r)?.length ? 0 : 1);
      const workFirst = [...rooms].sort((a, b) => deskless(a) - deskless(b));

      const minDist = 14;
      // A room's main floor, worked out once per room the first time it is asked
      // for. See `roomFloor`: fitting is not the same as being connected, and
      // this is the pool that stands most of a floor's staff up.
      const floors = new Map();
      const onFloor = (room, tx, ty) => {
        if (!floors.has(room)) floors.set(room, roomFloor(room, nav, layout.doors));
        const test = floors.get(room);
        return !test || test(tx, ty);
      };

      // Where a body may be put down at all. A single walkable tile is not enough:
      // movement tests a whole body radius, so a tile wedged against furniture is
      // one an enemy can stand on but never leave, and spawning there makes it a
      // statue. Every spot on the floor is held to this. `spots` is read live, which
      // is what keeps two bodies from being put down on top of each other.
      //
      // A room's own desks are not candidates at all — see DESK_TEAM.
      const ok = (x, z) => nav.clear(x, z, RADIUS)
        && Math.hypot(x - layout.spawn.x, z - layout.spawn.z) >= minDist
        && !spots.some((s) => Math.hypot(s.x - x, s.z - z) < 1.6);

      // One group per room per pass, so the passes have to outnumber the enemies
      // per room — at seventy-plus on a twenty-room floor, eight passes ran out
      // long before the roster did and every floor quietly shipped half of it.
      const passes = Math.max(8, Math.ceil(count / Math.max(1, rooms.length)) + 4);

      for (let pass = 0; spots.length < count && pass < passes; pass++) {
        for (const room of pass === 0 ? workFirst : rooms) {
          if (spots.length >= count) break;
          // How many this room takes this time round. Most of the floor's empty
          // rooms come from here rather than from being skipped outright: a room
          // that draws nobody on every pass simply never gets anybody.
          //
          // Except a room with desks in it, which is dealt a shift instead: as
          // many as it has stations, capped, and never nobody. That is the other
          // half of staffing the workplaces first — order alone got the desks
          // visited, and then handed a twelve-pod farm the same one or two bodies
          // it handed the stationery cupboard next door.
          const desks = this.desks.get(room)?.length ?? 0;
          const want = desks
            ? rng.int(1, Math.min(desks, DESK_TEAM))
            : (rng.chance(0.28) ? 0 : rng.int(1, 3));

          for (let placed = 0; placed < want && spots.length < count; placed++) {
            // A patch of the room's carpet, and never one of its chairs. The desks
            // stay in the pool for the two bodies that are allowed to sit in one:
            // somebody dealt a station they are not going to sit at is standing
            // inside the chair rather than working at the desk.
            for (let tries = 0; tries < 14; tries++) {
              const tx = rng.int(room.x0, room.x1 - 1);
              const ty = rng.int(room.y0, room.y1 - 1);
              if (!nav.walkable(tx, ty)) continue;

              const x = nav.wx(tx), z = nav.wz(ty);
              if (!ok(x, z) || !onFloor(room, tx, ty)) continue;

              spots.push({ x, z, room });
              break;
            }
          }
        }
      }
      return spots;
    }

    /**
     * The next free desk in a room that the caller is willing to stand somebody
     * at, or null.
     *
     * `ok(x, z)` is the caller's own test, because who may sit where is not one
     * rule: a body found working has to pass everything an ordinary spawn spot
     * passes, while the manager sits at his own desk however close to the lifts
     * his office happens to be.
     *
     * Taking one REMOVES it, so two bodies can never be dealt the same chair —
     * which would be one body inside another, both of them facing the same
     * monitor. A desk the test refuses is left in the pool: the next caller asks a
     * different question of it.
     */,

    addResponders(list) {
      const meshes = [];
      for (const d of list ?? []) {
        const type = d.baton ? TYPES.guardBaton : TYPES.security;
        const e = this._add(d.x, d.z, makeRng(d.seed), this.tuning, type);
        e.card = d.card ?? null;
        this._keyed(e);
        e.state = 'chase';
        e.contact = 0;
        e.lastSeen = { x: d.x, z: d.z };
        meshes.push(...e.hitboxes);
      }
      return meshes;
    },
};
