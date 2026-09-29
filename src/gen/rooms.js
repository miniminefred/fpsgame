// What each room turns out to be, and what goes in it.
//
// One function per role, plus the table that maps a role to its function. How a
// prop is actually placed is gen/placement.js's business — a recipe in here says
// "a copier against a wall and some cardboard", and nothing about coordinates.

import { footprintOf, QUARTER, tryPlace } from './props.js';
import { doorSide, doorsOnRoom, NAV_LANE, TILE } from './layout.js';
import { SKIRT } from './furnish.js';
import { parkingDeck } from './garage.js';
import {
  aisles,
  ALL_SIDES,
  area,
  centreProp,
  edgeProp,
  lounge,
  scatter,
  SEAT_PITCH,
  seatFacing,
  wall,
  wallClutter,
  wallSpanProp,
} from './placement.js';

// Fills a room according to its role. Room bounds arrive in world metres,
// already shrunk by the wall clearance the builder wants to keep. `doors` is
// the floor's whole list, not just this room's own — only generatorRoom needs
// it (see doorsOnRoom there), and every other role ignores the extra argument.
export function furnish(sink, room, bounds, rng, doors, theme = null) {
  const { x0, z0, x1, z1 } = bounds;
  if (x1 - x0 < 1.5 || z1 - z0 < 1.5) return;

  // ...and it may turn out not to be that kind of room at all. See DEFINES.
  const role = fits(sink, bounds, room.role) ? room.role : 'utility';
  room.role = role;
  const fill = ROLES[role] ?? privateOffice;
  fill(sink, bounds, rng, room, doors, theme);
  cartons(sink, bounds, rng);
}

/**
 * The one prop that makes a room what it is.
 *
 * A copy room is a room with copiers in it. Take the copiers out — because the
 * doorway aprons and the through-route lane between two openings have eaten the
 * only walls it had — and what is left is not a copy room with less in it, it is
 * a cupboard the generator has labelled a copy room. Which is what `utility` is,
 * and why it is not on any of the pick lists in gen/layout.js: it is not rolled,
 * it is what a room falls back to.
 *
 * Only the roles with a defining prop are here. A lobby is a lobby with nothing
 * in it, a generator room and a cafeteria have already been proved to fit what
 * they are composed around (see fitsGenerator and pickCafeteria), and the three
 * behind a card are chosen from rooms big enough by `assignLocks`.
 */
const DEFINES = {
  openplan: 'desk',
  office: 'desk',
  meeting: 'smallMeetingTable',
  presentation: 'presentationScreen',
  breakroom: 'armchair',
  storage: 'shelving',
  archive: 'bookshelf',
  copyroom: 'printer',
  server: 'serverRack',
  itbay: 'workbench',
  mailroom: 'shelving',
  reception: 'receptionDesk',
  parking: 'car',
};

/**
 * Whether a room could actually take the prop its role is about.
 *
 * Asked of the SINK rather than of the room's size, and that is the whole value
 * of it: a 40 m² copy room whose every wall is inside a doorway apron has plenty
 * of square metres and nowhere to put a copier. `canPlace` is the same test
 * `tryPlace` is about to run, so this cannot certify a placement that then fails.
 *
 * Every wall in turn, at the same standoff `edgeProp` would use — nothing is
 * placed and nothing is reserved, so a room that passes is furnished exactly as
 * it was before.
 */
function fits(sink, bounds, role) {
  const kind = DEFINES[role];
  if (!kind) return true;
  const { x0, z0, x1, z1 } = bounds;
  const { w: fw, d: fd } = footprintOf(sink, kind);
  const standoff = fd / 2;
  const margin = fw / 2;

  for (const side of ALL_SIDES) {
    const w = wall(side, bounds);
    if (w.a1 - w.a0 < margin * 2) continue;
    // Both ends of the wall and its middle. A wall with a doorway in the middle
    // of it still takes a copier at one end, and a wall with aprons at both ends
    // still takes one in the middle.
    for (const t of [0.5, 0.15, 0.85]) {
      const [cx, cz] = w.seat(w.a0 + margin + (w.a1 - w.a0 - margin * 2) * t, standoff);
      if (sink.canPlace(cx - margin, cz - standoff, cx + margin, cz + standoff)) return true;
    }
  }
  return false;
}

// How much of the building has cardboard lying about in it, and how much.
//
// Every role gets this on top of its own recipe, which is the point: a delivery
// that never got put away is not a kind of room, it is a thing that has happened
// in three rooms out of five. Rolled per room rather than spread evenly, so some
// rooms are clear and some have a small pile — and the pile is what makes an
// office readable as somewhere people work rather than somewhere props were
// placed. They are the one prop the player can shove out of the way, shoot to
// nothing, or walk through the middle of while the staff flatten them (see
// `crushable` in props.js).
const CARTON_CHANCE = 0.62;

const CARTON_PER_M2 = 11;      // one carton per this much floor, where they land

const CARTON_MAX = 7;

function cartons(sink, bounds, rng) {
  if (!rng.chance(CARTON_CHANCE)) return;
  const { x0, z0, x1, z1 } = bounds;
  const n = Math.min(CARTON_MAX, 1 + Math.floor(area(bounds) / CARTON_PER_M2));
  for (let i = 0; i < n; i++) {
    // Against a wall about half the time. A carton in the middle of the carpet
    // reads as dropped; one against the skirting reads as stacked and left, and a
    // room wants some of each.
    if (rng.chance(0.5)) {
      edgeProp(sink, bounds, 'carton', rng);
    } else {
      tryPlace(sink, 'carton', rng.range(x0 + 0.4, x1 - 0.4), rng.range(z0 + 0.4, z1 - 0.4),
        rng.int(0, 3), rng);
    }
  }
}

// Cubicle farm: pods on a 3.7 x 3.0 m pitch, each a desk backed by an L of
// partitions, with the whole grid facing a consistent direction like real ones.

// Cubicle farm: pods on a 3.7 x 3.0 m pitch, each a desk backed by an L of
// partitions, with the whole grid facing a consistent direction like real ones.
function openPlan(sink, { x0, z0, x1, z1 }, rng) {
  // The cross aisle is what is left of the pitch after a 1.6 m desk and the side
  // partition, and the player is 0.8 m across. At the old 3.4 m pitch that aisle
  // came to 0.79 m — a centimetre too narrow to walk down, which is how a whole
  // cubicle farm ends up with a quarter of it shut off from the doorway.
  const PITCH_X = 3.7;
  const PITCH_Z = 3.0;
  const cols = Math.floor((x1 - x0) / PITCH_X);
  const rows = Math.floor((z1 - z0) / PITCH_Z);
  if (cols < 1 || rows < 1) return privateOffice(sink, { x0, z0, x1, z1 }, rng);

  const padX = (x1 - x0 - cols * PITCH_X) / 2;
  const padZ = (z1 - z0 - rows * PITCH_Z) / 2;
  const rot = rng.chance(0.5) ? 0 : 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x0 + padX + (c + 0.5) * PITCH_X;
      const cz = z0 + padZ + (r + 0.5) * PITCH_Z;
      const facing = rot === 0 ? 1 : -1;

      // ONLY IF THE DESK ACTUALLY WENT DOWN. `tryPlace` returns false whenever
      // the pod's spot is spoken for — a doorway apron, a reserved through-lane,
      // a neighbour rounded outward to whole tiles — and this ignored the answer
      // and seated the pod regardless. Three things came of that, and a player
      // reported the first: a chair pulled up to NOTHING with a desk job
      // registered at it, so a body was sent to sit there and type at a PC that
      // does not exist; `seatFacing` naming the wrong prop, because it reads
      // `sink.placed()` and the last prop the sink really stood up is the pod
      // next door's desk or a partition (measured 3.7 m to 11 m away), so
      // `_gone` in chores.js was watching furniture on the other side of the
      // room; and `_spawnPoints` sizing the room's shift off desks that are not
      // there. The other three callers of `seatFacing` in this file have always
      // guarded it. Measured: 10 of 174 seated workers, all of them here.
      //
      // Through `seatFacing`, which is the same 0.85 m in front of the desk this
      // used to place by hand and one quarter turn different: a chair at the
      // DESK's rotation has its back to the desk, so every pod in the building
      // was a chair somebody would have to sit in backwards. Invisible while
      // they were empty; the moment there was a body in one it was the only
      // thing in the room.
      if (tryPlace(sink, 'desk', cx, cz, rot, rng)) {
        seatFacing(sink, 'desk', cx, cz, rot, rng, 0.85);
      }
      tryPlace(sink, 'partition', cx, cz + facing * 0.62, 0, rng);
      if (c < cols - 1) tryPlace(sink, 'partition', cx + PITCH_X / 2 - 0.05, cz, 1, rng);
      // No cabinet in the pod. Wherever it went it stood in the cross aisle, and
      // a 0.52 m cabinet in a 0.94 m aisle leaves less than the 0.8 m the player
      // needs — which sealed off part of the farm from its own doorway. They go
      // along the walls instead, which is where they are in a real one anyway.
    }
  }

  // A shared printer and a sad plant, as is traditional — but only against a
  // wall with a lane left in front of it. The pods are a fixed pitch and the
  // room is not, so the leftover between the last desk and the wall is known
  // exactly: a prop deeper than that lane minus a body's width doesn't sit
  // against the wall, it closes the room off from its own doorway.
  //
  // The desk's real width, not the catalogue's: it is drawn as a model, so what
  // eats into the lane is the model's footprint (1.84 m, against the 1.6 m the
  // fallback boxes are authored at). The partitions stand 0.62 m behind the pod
  // centre and are 0.12 deep, so they reach 0.68 — further back than either
  // desk does — and the chairs are loose and collide with nothing, so they
  // don't enter into it.
  const bounds = { x0, z0, x1, z1 };
  const desk = footprintOf(sink, 'desk');
  const laneX = padX + (PITCH_X - desk.w) / 2;
  const laneZ = padZ + (PITCH_Z / 2 - Math.max(0.68, desk.d / 2));
  // And the same for the prop being offered the wall. Asking the catalogue how
  // deep a printer is answered 0.88 m for a machine that ships at 1.13 — so a
  // lane this test had just certified as leaving a body's width came out 0.55 m
  // wide, which is the exact failure it exists to prevent.
  const walls = (kind) => {
    const need = footprintOf(sink, kind).d + 0.8;
    return [...(laneZ >= need ? [0, 2] : []), ...(laneX >= need ? [1, 3] : [])];
  };

  if (rng.chance(0.75)) edgeProp(sink, bounds, 'cabinet', rng, walls('cabinet'));
  edgeProp(sink, bounds, 'printer', rng, walls('printer'));
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'plant', rng, walls('plant'));
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'waterCooler', rng, walls('waterCooler'));
}

function meetingRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  const rot = alongX ? 0 : 1;

  // The board goes first and unconditionally, and both halves of that are the
  // argument `securityOffice` makes about its camera desk. It is the FRONT of
  // the room — the table is laid along it and every chair looks at it — so it
  // has to get a wall before the clutter does. And it is where the person
  // running the meeting stands (`meetings.js` reads the `board` station
  // `edgeProp` publishes for it), so a room that rolled it away at 20% was one
  // meeting room in five with nowhere to hold a meeting.
  edgeProp(sink, bounds, 'whiteboard', rng);

  // The table, as near the middle of the room as will take one. The full one
  // first and the four-seater after it — and both are real meeting tables, at
  // 0.75 m with the same dark top. A coffee table used to stand in here when the
  // big one would not fit, and a coffee table is 0.42 m high: what that came out
  // as was four office chairs drawn up round something you would put a magazine
  // on, which is a waiting room, in the one room type whose whole job is to be
  // recognisable from its doorway.
  const table = centreProp(sink, ['meetingTable', 'smallMeetingTable'], bounds, rot, rng);
  if (!table) return;

  const { cx, cz, kind } = table;
  // Half the table's real depth — measured across its short axis whichever way
  // round it went in, which is what `footprintOf` answers in the prop's own
  // frame — plus room for a chair to be pushed under it.
  const half = footprintOf(sink, kind).d / 2 + 0.42;
  // How many a side, off the TABLE's own length rather than the room's. It used
  // to come off the room, which put chairs a metre and a half past both ends of
  // the table with nothing in front of them — eight of them a room, sitting at
  // thin air. `SEAT_PITCH` is what a meeting table actually seats people at:
  // tighter than the 0.85 m a rank of desks uses, because chairs at a table are
  // nearly touching, and it is what gets three a side out of the 1.88 m the
  // meeting table really measures (see gen/model-table.js — the catalogue's 3.1
  // is the fallback boxes, not the model the game ships).
  const seats = Math.max(2, Math.round(footprintOf(sink, kind).w / SEAT_PITCH));
  // Inside the table's own reservation, which is what `lend` is for and is not
  // optional: floor is claimed by whole tiles, so a table's claim reaches a good
  // way past its own edge and a chair pulled up to it lands inside that claim
  // whatever the arithmetic says. It is the trap `seatFacing` and the cafeteria
  // both document, and it was costing this room 1768 refused chairs against 1274
  // placed.
  const { w: tw, d: td } = footprintOf(sink, kind, rot);
  sink.lend(cx - tw / 2, cz - td / 2, cx + tw / 2, cz + td / 2, () => {
    for (let i = 0; i < seats; i++) {
      const t = (i - (seats - 1) / 2) * SEAT_PITCH;
      // Both long sides, each chair turned to face the table. Derived rather
      // than written out, and it is a FIX rather than a tidy-up: written out it
      // was four coordinates and four turns, and the two for a table running
      // east-west were backwards — every meeting room on that half of the roll
      // sat its whole meeting facing the walls. Measured off the geometry rather
      // than argued about: the backrest of every chair was the box nearest the
      // table. `side` is the quarter turn naming which way the chair is offset
      // and (side + 2) is what brings its front back round, exactly as
      // seatFacing has always done it for a desk.
      for (const side of [rot, (rot + 2) & 3]) {
        const [ox, oz] = QUARTER[side](0, -half);
        const [ax, az] = QUARTER[side](t, 0);
        const x = cx + ox + ax, z = cz + oz + az;
        const seat = (side + 2) & 3;
        // Registered as somewhere to SIT IN A MEETING, which is neither a job
        // nor lunch. A meeting chair in the desk pool would have this room
        // dealt a shift of six people typing at a table with no desks on it,
        // and in the canteen pool it would send people here for their break.
        if (tryPlace(sink, 'chair', x, z, seat, rng)) {
          sink.workstation(x, z, seat, 'meeting');
        }
      }
    }
    // ...and one at each END of the table, which is where a meeting table seats
    // its last two and is also the difference between a room that can hold a
    // meeting of five and one that can hold seven (`MEETING` in chores.js wants
    // up to six seated). `(rot + 1)` is the table's long axis, so the offset is
    // half its LENGTH rather than half its depth.
    const ends = footprintOf(sink, kind).w / 2 + 0.42;
    for (const side of [(rot + 1) & 3, (rot + 3) & 3]) {
      const [ox, oz] = QUARTER[side](0, -ends);
      const x = cx + ox, z = cz + oz;
      const seat = (side + 2) & 3;
      if (tryPlace(sink, 'chair', x, z, seat, rng)) {
        sink.workstation(x, z, seat, 'meeting');
      }
    }
  });
}

/**
 * The first of these props that will stand somewhere near the middle of a room.
 *
 * Placed at the centre and then walked outward from it, which is the cafeteria's
 * lesson in a smaller room: on a fixed spot a placement is all or nothing, and
 * the middle of a room is exactly where a doorway apron, a through-route lane
 * and a reserved arrival square all get stamped. A meeting room only has one
 * thing in it, so losing that one thing to a reservation two tiles wide leaves a
 * whiteboard and some chairs — measured, **16 of 207 meeting rooms had no table
 * of any kind**, and dropping in a smaller one recovered exactly one of them,
 * because the problem was never the size.
 *
 * Rings rather than a scan, so a table that cannot have the middle still ends up
 * as near it as the room allows and the room still reads as laid out around it.
 */

function breakRoom(sink, bounds, rng, room, doors, theme) {
  const { x0, z0, x1, z1 } = bounds;

  // Seating FIRST, and that ordering is the whole of whether this room has any.
  // A sofa is 1.8 m and the machines below are 2.2, 1.29 and 0.4 — so by the
  // time the counter, the vending machine and the cooler had taken their walls
  // there was nowhere left to put one, and it showed: 279 sofas placed against
  // 2184 refused, which is a break room with nothing to sit on six times in ten.
  // An armchair is the fallback rather than a second choice; it is 1.25 m and
  // fits where a sofa cannot.
  //
  // Every seat is published as a `lounge` station, which is what makes this room
  // the second place on the floor somebody can take their break (see the break
  // cycle in enemies.js). A sofa gets two, because it is 1.8 m and one body on
  // it is somebody sitting alone on a sofa.
  const sofas = rng.chance(0.55) ? 2 : 1;
  for (let i = 0; i < sofas; i++) {
    const sofa = edgeProp(sink, bounds, 'sofa', rng);
    if (sofa) lounge(sink, 'sofa', sofa, rng, 2);
    else lounge(sink, 'armchair', edgeProp(sink, bounds, 'armchair', rng), rng, 1);
  }
  if (rng.chance(0.7)) lounge(sink, 'armchair', edgeProp(sink, bounds, 'armchair', rng), rng, 1);

  // What a break is made of.
  edgeProp(sink, bounds, 'counter', rng);
  edgeProp(sink, bounds, 'vending', rng);
  edgeProp(sink, bounds, 'waterCooler', rng);
  // ...and the dock, on the one shift that has anything to plug into it. It is
  // the only thing a theme does to the FURNITURE rather than to the finished
  // floor, which is why the shift is rolled before the building is furnished
  // (see game.js). A charging point in an office where nothing charges is a prop
  // raising a question the floor does not answer — and there is nothing to
  // charge anywhere else now, because the Sentry Unit came off the roll and
  // every machine in the game is an Automated floor's.
  if (theme?.chargers) edgeProp(sink, bounds, 'charger', rng);

  // Low tables through the middle with a stool or two pulled up to them. Stools
  // rather than the office chairs that used to be here: a task chair in a break
  // room is somebody who brought their work with them.
  const tables = Math.max(1, Math.floor(((x1 - x0) * (z1 - z0)) / 11));
  for (let i = 0; i < tables; i++) {
    const cx = rng.range(x0 + 1.2, x1 - 1.2);
    const cz = rng.range(z0 + 1.2, z1 - 1.2);
    if (!tryPlace(sink, 'coffeeTable', cx, cz, rng.int(0, 3), rng)) continue;
    // A stool round a low table is somewhere to sit too, so it is registered
    // like the sofas — facing the table, which is what makes two of them read as
    // two people having a coffee rather than two people facing a wall.
    for (const [sx, sz, rot] of [[0, -1.0, 0], [1.0, 0, 3]]) {
      if (!rng.chance(sz ? 0.7 : 0.5)) continue;
      if (tryPlace(sink, 'stool', cx + sx, cz + sz, rot, rng)) {
        sink.workstation(cx + sx, cz + sz, (rot + 2) & 3, 'lounge');
      }
    }
  }
  wallClutter(sink, bounds, ['trashCan', 'recyclingBin'], 45, rng);
}

// Shelving in aisles, the cabinets the overflow goes in, and the boxes that
// never made it onto either.

// Shelving in aisles, the cabinets the overflow goes in, and the boxes that
// never made it onto either.
function storage(sink, bounds, rng) {
  // `'shelf'` is where the parcel runs start and where the stocktaking routine
  // takes a box off a rack: a machine comes in here, takes a box, and hands it
  // to a porter (jobs.js) or carries it to another rack (chores.js). Only the
  // STORAGE room offers them — `aisles` also ranks a server room's racks, and
  // that is not somewhere the building's stock is kept. The archive's shelves
  // are their own kind for the same reason; see there.
  aisles(sink, bounds, 1.9, 2.0, 'shelving', rng, 'shelf');
  // The archive half of a storeroom: what will not go on a shelf goes in a
  // cabinet against the wall.
  for (let i = 0; i < 2; i++) edgeProp(sink, bounds, 'cabinet', rng);
  // Pallets and crates are static and a metre across; loose cartons are neither.
  // Only a room with floor to spare gets the heavy goods left out on it.
  scatter(sink, bounds, area(bounds) > 55
    ? ['crateStack', 'crateStack', 'crate', 'pallet']
    : ['crateStack'], 12, rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'extinguisher', rng);
}

// Paper, in every form the building keeps it: binders on shelves, the cabinets
// nobody has opened this decade, and the bench where it is actually dealt with —
// a small printer, a calculator and the trays it comes in and goes out of.
function archive(sink, bounds, rng) {
  // `'files'` rather than `'shelf'`, and the difference is what a rack is FOR.
  // A storeroom's shelving is where the building's stock lives, so a parcel run
  // starts at one; an archive's shelves hold paperwork, and a porter fetching a
  // ring binder to put it on a conveyor is not a thing that happens. The box
  // errand in chores.js reads both, because taking something off a shelf and
  // putting it back somewhere else is the same errand in either room.
  // The bench first, and the copy room's shelf makes the same argument: an
  // archive is long and thin and its walls are gone by the time three cabinets
  // and a rank of bookshelves have been down them, so offered last a 1.6 m bench
  // landed in fewer than half the rooms it is the point of. It is the only thing
  // in here that is not storage — what makes the room read as one somebody works
  // in rather than one nobody has been into since the nineties.
  sortingStation(sink, bounds, rng);
  if (rng.chance(0.45)) edgeProp(sink, bounds, 'printer', rng);
  aisles(sink, bounds, 1.7, 1.15, 'bookshelf', rng, 'files');
  for (let i = 0; i < 3; i++) edgeProp(sink, bounds, 'cabinet', rng);
  edgeProp(sink, bounds, 'trashCan', rng);
  wallClutter(sink, bounds, ['recyclingBin', 'trashCan'], 42, rng);
  scatter(sink, bounds, ['crateStack'], 16, rng);
}

// Machines, and the paper going into and out of them.

// Machines, and the paper going into and out of them.
function copyRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  // The shelf first, for the break room's reason: it is 1.96 m and the copiers
  // are 1.13, so offered last it was refused nineteen times in twenty — 82
  // shelving units across 470 copy rooms. The paper has to live somewhere.
  edgeProp(sink, bounds, 'shelving', rng);
  // ...and then as many copiers as the longest wall will take. A 1.3 m pitch
  // rather than 1.6: a copy room is a row of machines, and two of them with a
  // gap between is a room that happens to have copiers in it.
  const count = Math.max(2, Math.floor(Math.max(x1 - x0, z1 - z0) / 1.3));
  for (let i = 0; i < count; i++) edgeProp(sink, bounds, 'printer', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'cabinet', rng);
  // Boxes of paper, stacked where the delivery was put down.
  scatter(sink, bounds, ['crateStack', 'crateStack', 'carton'], 11, rng);
  wallClutter(sink, bounds, ['recyclingBin', 'trashCan'], 40, rng);
}

// Racks in ranks, tight enough that the aisles between them are the only floor —
// and one terminal, because somebody has to be able to sit down and talk to all
// of this.
function serverRoom(sink, bounds, rng) {
  // The terminal first, before the ranks have taken the floor — the archive's
  // bench lesson in a second room, and a sharper one here because a rack aisle
  // eats the whole middle of a server room and a 1.84 m desk needs a wall with
  // nothing already on it.
  //
  // A `desk` IS the catalogue's computer: it comes with a monitor and a keyboard
  // on it, and `seatFacing` pulls a chair up to it and registers the job. So the
  // room gets somebody sitting at a screen in among the racks rather than a
  // machine room nobody has any reason to be in.
  //
  // "Maybe" a computer, and the roll is arithmetic rather than flavour: going in
  // before the ranks is what gets the desk placed at all, and it costs the room
  // a rank — measured at 3.4 racks a room without it and 2.5 with it in every
  // room. Two rooms in three is a terminal you find often enough to expect one
  // and a rack count that still reads as stacks of servers.
  const desk = rng.chance(0.65) ? edgeProp(sink, bounds, 'desk', rng) : null;
  if (desk) seatFacing(sink, 'desk', desk.cx, desk.cz, desk.rot, rng);
  aisles(sink, bounds, 2.2, 0.85, 'serverRack', rng, 'server');
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'workbench', rng);
  edgeProp(sink, bounds, 'extinguisher', rng);
}

// Where the hardware comes to be fixed: a row of benches down a wall, half of
// them with something open on them (see `workbench` in gen/props.js), somewhere
// to put the parts, and the boxes they came in.
function itBay(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  // A ROW rather than two benches and a shelf of odds and ends. A bench is 2 m,
  // so this is as many as the longest wall will take — which is what makes the
  // room read as a workshop from its doorway instead of as an office with a
  // bench in it.
  const count = Math.max(2, Math.floor(Math.max(x1 - x0, z1 - z0) / 2.2));
  for (let i = 0; i < count; i++) edgeProp(sink, bounds, 'workbench', rng);
  edgeProp(sink, bounds, 'shelving', rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'printer', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'trashCan', rng);
  scatter(sink, bounds, ['crateStack', 'carton', 'crate'], 14, rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'extinguisher', rng);
}

// Goods in, goods out: shelves of parcels, and the crates they came in stacked
// where the trolley stopped.
//
// The shelves publish a `mail` station, which is where the post is collected
// from — see the `postrun` routine in chores.js. It is its own kind rather than
// the storeroom's `shelf` or the archive's `files`, because what comes off one
// of these is somebody's parcel and it leaves the building: a stocktake that
// took a box off the mailroom rack and put it on another one would be the post
// being filed instead of sent.
function mailRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  // The bench FIRST, and for the archive's reason: it is 1.6 m long, the racks
  // below take a wall each, and offered last it lands in a fraction of the rooms
  // it is the point of. A mailroom is where the post is sorted and it had nothing
  // to sort it on — the one room in the building named after a job whose job
  // nothing could be seen doing. See `packing` in chores.js.
  sortingStation(sink, bounds, rng);
  const racks = Math.max(2, Math.floor(Math.max(x1 - x0, z1 - z0) / 2.4));
  for (let i = 0; i < racks; i++) edgeProp(sink, bounds, 'shelving', rng, ALL_SIDES, 'mail');
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'recyclingBin', rng);
  scatter(sink, bounds, area(bounds) > 55
    ? ['crateStack', 'crateStack', 'crate', 'pallet', 'carton']
    : ['crateStack', 'crateStack', 'carton'], 9, rng);
}


/**
 * A sorting bench with a crate on the floor at the end of it.
 *
 * The bench alone has been in the archive for a long time and published a
 * `sorting` station that nothing ever read. `packing` in chores.js reads it now
 * — take a parcel off the bench, stoop, drop it in the crate — and the crate is
 * the half that makes the stoop mean anything: a body bending down beside a
 * bench with nothing beside it is a body bending down.
 *
 * The offset is `QUARTER`'s, like every other prop placed relative to another in
 * this file, and it is deliberately PAST THE BENCH END rather than tucked in
 * beside the standing spot. A crate against the body would be inside the tile
 * the station needs — `canPlace` rounds a footprint outward to whole tiles, so a
 * prop that merely looks clear of a station regularly eats it, and a station a
 * body does not fit at is dropped from the pool with nothing to say it was ever
 * there (`standable` in enemies.js). At 1.15 m along the wall the station is
 * 1.48 m away, which no rounding can reach.
 *
 * Either half may fail and both failures are ordinary. No bench is a room with
 * no sorting station in it, which is what every room in the building except two
 * already is; no crate is a bench with the boxes going somewhere off camera.
 */
const CRATE_ALONG = 1.15;   // metres from the bench's middle, along its wall

function sortingStation(sink, bounds, rng) {
  const bench = edgeProp(sink, bounds, 'sortingBench', rng);
  if (!bench) return null;
  // Either end, so a room does not always have it on the same side. The crate
  // stands at the bench's own standoff from the wall, which is what puts it
  // against the wall beside the bench rather than out in the room.
  const { d } = footprintOf(sink, 'sortingBench');
  for (const along of rng.shuffle([CRATE_ALONG, -CRATE_ALONG])) {
    const [ox, oz] = QUARTER[bench.side](along, 0);
    if (tryPlace(sink, 'crate', bench.cx + ox, bench.cz + oz, bench.side, rng)) break;
  }
  return bench;
}

// The room the building would rather you didn't see: lockers, cleaning kit and
// the spares that have no other home.
function utilityRoom(sink, bounds, rng) {
  edgeProp(sink, bounds, 'lockers', rng);
  edgeProp(sink, bounds, 'extinguisher', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'mopBucket', rng);
  wallClutter(sink, bounds, ['shelving', 'lockers', 'recyclingBin'], 26, rng);
  scatter(sink, bounds, ['crateStack', 'trashCan'], 14, rng);
}

// Rows of seats facing a big screen at the front, with an aisle up the middle so
// the room reads as a room somebody presents in rather than a furniture
// warehouse — and so it reads that way from the doorway, before anything in it
// has moved.
//
// A screen rather than a whiteboard, and the difference is that it is ON: a lit
// 2.4 m rectangle is the one thing in a grey office that says LOOK HERE, which
// is what the whole seating plan is pointed at. The whiteboard stays where it
// belongs, in the meeting room, where somebody writes on it.
//
// The screen publishes a `board` station like a whiteboard does (see WORK_AT),
// and every chair here is registered as a `meeting` seat — so a meeting can be
// held in this room too, with one body at the screen and the rest sitting in the
// rows. Same cast, same poses; see `_tryMeeting` in chores.js.
function presentationRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  // Seats look at the front wall: rows run across the room, ranked back from it.
  const [f0, f1, a0, a1] = alongX ? [z0, z1, x0, x1] : [x0, x1, z0, z1];
  const at = (across, along) => (alongX ? [along, across] : [across, along]);

  // The screen decides which wall is the front, not the die: a doorway keeps
  // four tiles of floor clear on both sides, so a screen centred on the wall the
  // door is in never lands — and rows of chairs facing a blank wall is not a
  // presentation room, it is a waiting room. Try both walls and a few positions
  // along each, and rank the seats at whichever one took it.
  // `outward` is the quarter turn whose FRONT faces into the room, which is what
  // the screen and the presenter want; `(outward + 2) & 3` faces the front wall,
  // which is what the rows want. Naming it for the direction it points is the
  // whole of the fix here: it was called "facing the front wall" and was the
  // opposite, so all three read it with the wrong sign and every presentation
  // room in the building was inside out — the picture buried in the plaster
  // with its bracket standing 0.16 m out into the room, the presenter looking at
  // the wall, and the rows watching the back of the room. Measured over 245
  // rooms: 0 screens against their wall (median 0.310 m off it), 0 presenters
  // facing the room, 0 of 5,008 chairs facing the screen. It is the same trap
  // `edgeProp` documents at length and the same one that seated every chair in
  // the cafeteria backwards — a side number is a direction, so a variable
  // holding one has to say which.
  let front = null, dir = 1, outward = 0, placed = false;
  for (const flip of rng.chance(0.5) ? [false, true] : [true, false]) {
    front = flip ? f1 : f0;
    dir = flip ? -1 : 1;                                   // deeper into the room
    outward = alongX ? (flip ? 0 : 2) : (flip ? 3 : 1);
    for (const t of [0.5, 0.3, 0.7, 0.18, 0.82]) {
      const [bx, bz] = at(front + dir * 0.14, a0 + (a1 - a0) * t);
      if (tryPlace(sink, 'presentationScreen', bx, bz, outward, rng)) {
        // Where the person running it stands: to one side of the screen, out of
        // its way, facing the room. Registered here rather than through
        // `edgeProp`'s WORK_AT table because the screen is not placed by
        // `edgeProp` — it is put on the wall the ROWS decide, not on a wall of
        // its own choosing.
        const [sx, sz] = at(front + dir * 0.9, a0 + (a1 - a0) * t + 1.5);
        sink.workstation(sx, sz, outward, 'board', sink.placed());
        placed = true;
        break;
      }
    }
    if (placed) break;
  }

  const seats = Math.floor((a1 - a0) / 0.8);
  const ranks = Math.floor((f1 - f0 - 1.6) / 1.1);
  for (let r = 0; r < ranks; r++) {
    for (let s = 0; s < seats; s++) {
      // The gangway: nothing in the middle column of a wide enough room.
      if (seats >= 5 && s === (seats >> 1)) continue;
      const along = a0 + (a1 - a0) * ((s + 0.5) / seats);
      const [cx, cz] = at(front + dir * (1.6 + r * 1.1), along);
      const facing = (outward + 2) & 3;
      if (tryPlace(sink, 'chair', cx, cz, facing, rng)) {
        sink.workstation(cx, cz, facing, 'meeting');
      }
    }
  }
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'cabinet', rng);
}

// The front of house on a floor that has one: a counter to be greeted at, and
// seating for the meeting you are not here for.

// The front of house on a floor that has one: a counter to be greeted at, and
// seating for the meeting you are not here for.
function reception(sink, bounds, rng) {
  edgeProp(sink, bounds, 'receptionDesk', rng);
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'armchair', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'armchair', rng);
  if (rng.chance(0.7)) {
    const { x0, z0, x1, z1 } = bounds;
    tryPlace(sink, 'coffeeTable', (x0 + x1) / 2, (z0 + z1) / 2, rng.int(0, 3), rng);
  }
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'plant', rng);
}

// A desk in the dead centre of a 4.5 m room leaves only ~0.65 m of standable
// floor either side once the player's radius is taken off both edges, and a
// single cabinet dropped at a random wall then closes one of them and cuts the
// room in half. So the desk goes against a wall like a real one, and only rooms
// with space to spare get a free-standing island.
function privateOffice(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const roomy = Math.min(x1 - x0, z1 - z0) > 6;

  let seated = false;
  if (roomy && rng.chance(0.5)) {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const rot = rng.int(0, 3);
    if (tryPlace(sink, 'desk', cx, cz, rot, rng)) {
      seatFacing(sink, 'desk', cx, cz, rot, rng);
      seated = true;
    }
  }
  if (!seated) seated = deskAgainstWall(sink, bounds, rng);

  if (rng.chance(0.8)) edgeProp(sink, bounds, 'cabinet', rng);
  if (rng.chance(0.45)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.3)) edgeProp(sink, bounds, 'bookshelf', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'trashCan', rng);
}

// Desk backed onto a wall with its chair tucked in front of it.

// Desk backed onto a wall with its chair tucked in front of it.
function deskAgainstWall(sink, bounds, rng) {
  // The footprint the placer will actually reserve — the desk's model is
  // 1.84 x 0.97 where its fallback boxes are 1.6 x 0.8, so seating it off the
  // catalogue's numbers put its back 8.5 cm through the wall inset and its
  // chair 8.5 cm too close to it.
  const { w: fw, d: fd } = footprintOf(sink, 'desk');
  const standoff = fd / 2;
  const margin = fw / 2;

  for (let tries = 0; tries < 10; tries++) {
    const w = wall(rng.int(0, 3), bounds);
    if (w.a1 - w.a0 < margin * 2) continue;

    const [cx, cz] = w.seat(rng.range(w.a0 + margin, w.a1 - margin), standoff);
    if (!tryPlace(sink, 'desk', cx, cz, w.side, rng)) continue;

    seatFacing(sink, 'desk', cx, cz, w.side, rng);
    return true;
  }
  return false;
}

/**
 * A wall, resolved into the two numbers everything that backs a prop against one
 * actually needs: which way is INTO the room, and which axis runs ALONG it.
 *
 * Four sites used to answer this for themselves — `edgeProp`, `wallSpanProp`,
 * the reception counter and the mezzanine's own arithmetic — and every one of
 * them was a four-case switch or a chain of ternaries over the same side number.
 * `edgeProp` documents at length what happens when that is written out by hand:
 * it comes out as four pairs of coordinates and half of them are backwards, and
 * for a long time the two even sides WERE swapped, which stood every vending
 * machine and reception desk on the ±z walls with its front to the plaster.
 *
 * `alongX` says which of `bounds`' two axes runs along the wall; `into` is +1 or
 * -1 on the other one; `edge` is where that other axis starts from. So a prop
 * standing `standoff` off this wall at position `at` along it is at `seat(at,
 * standoff)`, whichever wall it is.
 */

// Corner office. A desk you sit BEHIND with the visitor's chairs in front of it,
// which is the whole silhouette — nobody else on the floor gets seating that
// faces the wrong way.
function managerOffice(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  if (!deskAgainstWall(sink, bounds, rng)) {
    tryPlace(sink, 'desk', (x0 + x1) / 2, (z0 + z1) / 2, rng.int(0, 3), rng);
  }
  edgeProp(sink, bounds, 'bookshelf', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'cabinet', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'armchair', rng);
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) {
    tryPlace(sink, 'coffeeTable', (x0 + x1) / 2, (z0 + z1) / 2, rng.int(0, 3), rng);
  }
}

// The room the cameras come back to: a bank of screens against one wall, racks
// and lockers against the others, and nothing in the middle to walk into.

// The room the cameras come back to: a bank of screens against one wall, racks
// and lockers against the others, and nothing in the middle to walk into.
function securityOffice(sink, bounds, rng) {
  // The camera desk goes in first and unconditionally, before the room has been
  // filled with anything that could take its wall. It is what the room IS — you
  // needed a blue card to stand here, and the payoff for that has to be visible
  // from the doorway rather than rolled for.
  const desk = edgeProp(sink, bounds, 'cameraDesk', rng);
  // And the chair somebody watched them from, facing the screens.
  if (desk) seatFacing(sink, 'cameraDesk', desk.cx, desk.cz, desk.rot, rng, 1.0);

  edgeProp(sink, bounds, 'serverRack', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'workbench', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'lockers', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'cabinet', rng);
  edgeProp(sink, bounds, 'extinguisher', rng);
  wallClutter(sink, bounds, ['shelving', 'trashCan'], 30, rng);
}

// A broom closet is small, and the point of it is that the walls are the room:
// everything against them and one body's width of floor down the middle.

// A broom closet is small, and the point of it is that the walls are the room:
// everything against them and one body's width of floor down the middle.
function broomCloset(sink, bounds, rng) {
  edgeProp(sink, bounds, 'mopBucket', rng);
  edgeProp(sink, bounds, 'shelving', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'lockers', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'recyclingBin', rng);
  edgeProp(sink, bounds, 'trashCan', rng);
  scatter(sink, bounds, ['crateStack'], 11, rng);
}

// The generator room: a big double-height plant room (see generatorRoomCut in
// gen/build.js) built around the one prop that matters. It goes in FIRST and
// against a wall like anything else load-bearing in here — same reasoning as
// the camera desk in securityOffice: a room this size open in the middle
// reads as a hangar with a box in it, not a plant room, and every other item
// below is placed against whatever wall it left. The rest reads as the crew
// that works this room: monitoring terminals rather than desks, and the
// crates and spares an industrial space accumulates.
function generatorRoom(sink, bounds, rng, room, doors) {
  // Dead opposite the room's one door (see the `generator` fits predicate in
  // gen/layout.js, which guarantees there's exactly one) — walk in and it's
  // the first thing you see, on the far wall rather than tucked to one side.
  // `doorsOnRoom` rather than `room.doors[0]`: the fits predicate already had
  // to use it instead of `room.doors.length` for the same reason — the room's
  // own list only holds doors IT cut, and its one real doorway may have been
  // cut by the room next door into their shared wall, which would leave
  // `room.doors` empty and `room.doors[0]` undefined.
  const door = doorsOnRoom(doors, room)[0];
  const oppositeWall = (doorSide(door, room) + 2) % 4;
  // Corner to corner, not a five-metre cabinet parked against the middle of a
  // fifteen-metre wall: the machine IS the far end of the room, and the whole
  // composition of the space — walk in, and it is in front of you, floor to
  // roof and wall to wall — depends on it reaching both sides.
  if (!wallSpanProp(sink, bounds, 'generator', rng, oppositeWall)) {
    // The one wall it wants can, rarely, be unavailable even at the catalogue
    // width. A generator on the wrong wall beats a generator room with no
    // generator in it, so this falls back to whichever wall will take it.
    edgeProp(sink, bounds, 'generator', rng);
  }

  edgeProp(sink, bounds, 'workbench', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'workbench', rng);
  edgeProp(sink, bounds, 'serverRack', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'serverRack', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'cabinet', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'lockers', rng);
  edgeProp(sink, bounds, 'extinguisher', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'extinguisher', rng);
  scatter(sink, bounds, ['crateStack', 'crate', 'pallet'], 26, rng);
}

// The staff canteen, and the room the floor puts you down in — see
// pickCafeteria in gen/roles.js, which is what makes it the spawn room.
//
// It is a set piece the way the plant room is, and the composition is the whole
// of it: the servery runs the far wall corner to corner, the strip in front of
// it is left clear because that is where a queue would stand, and the seating
// behind that is laid in ROWS facing the counter. Rows rather than the `canteen`
// role's scatter of round tables, because rows are what make the servery the END
// of the room instead of one wall of four — the same argument the generator's
// wall-to-wall placement rests on.
//
// It is the ONLY canteen now. There used to be a mid-sized `canteen` role as
// well — round tables and stools, somewhere on the floor to eat — and having
// both meant a floor with two rooms making the same statement, one of them
// composed and one of them scattered. This is the composed one, so it is the one
// that stayed.
function cafeteria(sink, bounds, rng, room, doors) {
  const { x0, z0, x1, z1 } = bounds;

  // Dead opposite the door you come in by, so the counter is the first thing in
  // front of you. `doorsOnRoom` rather than `room.doors`, for the reason
  // generatorRoom gives: a room's own list holds only the doors IT cut, and a
  // room this big usually has neighbours who cut theirs into a shared wall. A
  // room with no doorway at all falls back to a long wall, which is where a
  // serving line would go anyway.
  const door = doorsOnRoom(doors, room)[0];
  const alongX = (x1 - x0) >= (z1 - z0);
  const facing = door ? (doorSide(door, room) + 2) % 4 : (alongX ? 0 : 1);

  // Corner to corner if that wall will take it. The wall it wants can be
  // unavailable — a doorway apron across it, or another room's door in it — and
  // a servery on the wrong wall beats a cafeteria with no counter in it, so
  // edgeProp is the fallback. It may land the thing somewhere else entirely,
  // which is why everything below measures off where the counter ACTUALLY went
  // rather than off where it was asked for.
  const line = wallSpanProp(sink, bounds, 'servery', rng, facing)
    ?? edgeProp(sink, bounds, 'servery', rng);
  const side = line ? line.side : facing;

  // Where you stand to be served, and where the trays go back.
  //
  // The furnisher is the only thing that knows where the counter actually
  // landed — it may have missed the wall it asked for entirely — so it is the
  // only thing that can say where the queue is, exactly the argument
  // `seatFacing` makes about a chair. They go down the same `sink.workstation`
  // pipe under names of their own, so nothing that reads the desk pool or the
  // table pool can ever see one: a serving hatch is not a job and it is not
  // lunch, it is somewhere on the way to lunch. See _lunch in enemies.js.
  if (line) {
    // Unrotated, the way wallSpanProp measures its own standoff: a prop is
    // authored facing -Z, so `d` is its depth whichever wall it ends up on and
    // QUARTER is what turns that into a direction. Asking for the rotated
    // footprint swaps the two on the odd sides, which put the queue two and a
    // half metres out from a counter one metre deep and stacked all three
    // stations on the same tile.
    const foot = footprintOf(sink, 'servery');
    const stand = foot.d / 2 + 0.75;
    const [ox, oz] = QUARTER[side](0, -stand);
    // Facing the counter, which is a quarter turn round from the way the offset
    // points — the same derivation the chairs below use, and for the same
    // reason: written out by hand it is four coordinates and half of them come
    // out backwards.
    const face = (side + 2) & 3;
    // Three places to be served, spread down the line rather than one point in
    // the middle of it. A serving line is long on purpose (see `spanning` in
    // gen/props.js) and four people queuing at the same tile is one body inside
    // another; the tray rack takes the far end, which is where a till is anyway.
    const reachAlong = Math.max(0, (line.span ?? foot.w) / 2 - 0.9);
    for (const t of [-reachAlong * 0.6, 0, reachAlong * 0.6]) {
      const [ax, az] = QUARTER[side](t, 0);
      sink.workstation(line.cx + ox + ax, line.cz + oz + az, face, 'servery');
    }
    // The tray rack, at the till end. Pulled a little inboard of the very end of
    // the line rather than sat on it: the end of a counter is against the room's
    // own wall, and a station a body cannot stand at is dropped by deskPool —
    // measured over ten floors, one canteen in ten lost its rack that way.
    const [rx, rz] = QUARTER[side](reachAlong * 0.8, 0);
    sink.workstation(line.cx + ox + rx, line.cz + oz + rz, face, 'trays');
  }

  // The queue. Nothing is furnished into the strip in front of the counter: it
  // is where you stand to be served, and a table in it is a table that has to be
  // squeezed past to reach the one thing the room is for.
  const QUEUE = 2.4;
  const seat = { x0, z0, x1, z1 };
  if (side === 0) seat.z1 -= QUEUE;
  else if (side === 1) seat.x0 += QUEUE;
  else if (side === 2) seat.z0 += QUEUE;
  else seat.x1 -= QUEUE;

  // Rows parallel to the counter, so every table faces it and the gangways run
  // toward it.
  const rot = (side === 0 || side === 2) ? 0 : 1;
  // Across the rows: the table, a chair on each side of it, and a gangway wide
  // enough to get past the backs of two occupied chairs.
  const ROW_PITCH = 3.2;
  // Along a row, and this one is a clearance rather than a taste: a table is
  // 2.3 m and STATIC, so the gap between two of them is a gap in a wall the
  // length of the room. At the 2.9 m that looked right it was 0.6 m, which a
  // 0.8 m body does not fit through — a row would have sealed every gangway
  // behind it off from the next but for the ends.
  //
  // ...and 3.3 was the same mistake one notch smaller, which is why this is now
  // DERIVED rather than typed. A 1 m gap clears a 0.8 m body, so the player
  // walked it and it looked fine; NAV_LANE is about the grid everybody else
  // uses, where a 1 m gap survives only if the tile boundaries fall kindly in
  // it. They mostly do not, so the ranks sealed shut into parallel lanes joined
  // to nothing: 26 of the room's own chairs unreachable and 12 bodies standing
  // on floor they could not leave, which is a player reporting people stuck in
  // the cafeteria. Derived off the table's real footprint like `reach` and
  // `half` below, never off the catalogue number in the comment above.
  const TABLE_PITCH = footprintOf(sink, 'canteenTable').w + NAV_LANE * TILE;

  const [a0, a1, b0, b1] = rot === 0
    ? [seat.x0, seat.x1, seat.z0, seat.z1]
    : [seat.z0, seat.z1, seat.x0, seat.x1];
  // Half the table's real depth plus room for a chair to be pushed under it —
  // measured through footprintOf like every other placement, never off the
  // catalogue numbers.
  const reach = footprintOf(sink, 'canteenTable').d / 2 + 0.42;

  // Rows laid from the queue lane backward, and each row filled by WALKING it
  // rather than by stepping a grid.
  //
  // That is the whole difference between a canteen and an empty hall, and it was
  // measured rather than guessed. On a rigid grid a cell is all or nothing: the
  // table either fits at the one spot the arithmetic named or the room does
  // without it, and the middle of a cafeteria is the one piece of floor with a
  // doorway apron, a through-route lane and the square kept clear where the
  // player materialises all stamped across it. Six cells in an 11 x 10 m room,
  // all six touching one reservation or another, and the room came out with a
  // servery, a vending machine and nothing at all to sit at. Sliding along the
  // row instead puts tables on both sides of whatever is in the way and lands a
  // median of 5, because a row is a rank of tables at a spacing rather than
  // furniture at named coordinates.
  // Both axes are WALKED rather than stepped as a grid, and that is the whole
  // difference between a canteen and an empty hall. It was measured, not
  // guessed. On a grid a cell is all or nothing — the table fits at the one spot
  // the arithmetic named or the room does without it — and the middle of a
  // cafeteria is the one piece of floor carrying a doorway apron, a through-route
  // lane and the square kept clear where the player materialises, all stamped
  // across it. Every cell in an 11 x 10 m room touched one reservation or
  // another and the room came out with nothing at all to sit at.
  //
  // Sliding puts tables on both sides of whatever is in the way: along a row for
  // an apron reaching into it, and across the rows for a band of floor that is
  // spoken for. The ranks stay parallel and evenly spaced because each axis only
  // jumps a full pitch once something has actually landed.
  const STEP = 0.25;
  const half = footprintOf(sink, 'canteenTable').w / 2;

  for (let b = b0 + reach; b <= b1 - reach; b += 0.5) {
    let landed = 0;
    for (let a = a0 + half; a <= a1 - half; a += STEP) {
      const cx = rot === 0 ? a : b;
      const cz = rot === 0 ? b : a;
      if (!tryPlace(sink, 'canteenTable', cx, cz, rot, rng)) continue;
      landed++;

      // Chairs down both long sides, most of them pushed back in.
      //
      // Inside the table's own reservation, which is what `lend` is for and is
      // not optional: floor is claimed by whole tiles, so a 0.86 m table's claim
      // reaches a good way past its own edge and a chair pulled up to it lands
      // inside that claim whatever the arithmetic says. Exactly the failure
      // seatFacing documents, and it showed here the same way — four tables in
      // the room and not one chair at any of them. Every other claim still
      // stands while the tiles are lent: the servery, the doorway aprons, the
      // vending machine on the wall behind.
      //
      // Placed directly rather than through seatFacing, though, and that is
      // deliberate: that call also registers a WORKSTATION, and a canteen chair
      // is somewhere to eat lunch rather than somewhere a body works — see
      // _takeDesk in enemies.js, which would otherwise find twenty jobs in here.
      const { w: tw, d: td } = footprintOf(sink, 'canteenTable', rot);
      sink.lend(cx - tw / 2, cz - td / 2, cx + tw / 2, cz + td / 2, () => {
        // Which way round a chair goes is the one thing in a seating plan that
        // is easy to get backwards, and this file has now done it twice — a
        // cubicle pod's chair with its back to its own desk, and every chair in
        // here facing away from the table it belongs to. Written out by hand it
        // is four coordinates and four turns and half of them were wrong, so the
        // turn is DERIVED the way seatFacing derives it: `side` is the quarter
        // turn naming which way the chair is offset, and the chair is turned the
        // opposite way, (side + 2), which brings its front back round to face
        // the table. The same QUARTER rotates the offset ALONG the side, so a
        // table running north-south needs no second set of coordinates.
        for (const side of [rot, (rot + 2) & 3]) {
          const [ox, oz] = QUARTER[side](0, -reach);
          for (const t of [-0.62, 0.62]) {
            if (!rng.chance(0.72)) continue;
            const [ax, az] = QUARTER[side](t, 0);
            const x = cx + ox + ax, z = cz + oz + az;
            const seat = (side + 2) & 3;
            // Registered as a seat at a TABLE, not as a workstation. Same record
            // and the same one call that puts the chair down — the furnisher is
            // the only thing that knows a chair is here and which way it is
            // turned — but `at` keeps it out of the desk pool, so nobody is ever
            // dealt a job in here and _diners has somewhere to sit people.
            if (tryPlace(sink, 'chair', x, z, seat, rng)) {
              sink.workstation(x, z, seat, 'table');
            }
          }
        }
      });
      // Only after one lands: the next along starts a full pitch away, so the
      // rank keeps the gap a body walks through between two tables (see
      // TABLE_PITCH) rather than having it eroded by the sliding.
      a += TABLE_PITCH - STEP;
    }
    if (landed) b += ROW_PITCH - 0.5;
  }

  // And what a canteen keeps round its edges. The counter is the set piece;
  // these are what make the room read as one people use.
  edgeProp(sink, bounds, 'vending', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'vending', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'counter', rng);      // the coffee run
  edgeProp(sink, bounds, 'waterCooler', rng);
  edgeProp(sink, bounds, 'recyclingBin', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'trashCan', rng);
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'plant', rng);
  // A kitchen has one on the wall, and this is the room the player starts in —
  // the secondary is worth having within reach of the first doorway.
  edgeProp(sink, bounds, 'extinguisher', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'extinguisher', rng);
}

function lobby(sink, bounds, rng) {
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'coffeeTable', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'armchair', rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'extinguisher', rng);
}

/**
 * Where the receptionist stands, and how much floor the counter leaves past
 * them. Both measured out from the room's furnishing bounds, which are already
 * 0.15 m off the plaster.
 *
 * These are NAV numbers rather than a look, and they are the tile grid rather
 * than a taste. `standable` in enemies.js holds a station to a whole tile of
 * `fits`, and `fits` is the walk grid eroded by a body's radius — a 0.4 m body
 * on a 0.5 m tile reaches 0.15 m into each neighbour, so a tile orthogonally
 * touching a blocked one is not somewhere a body can be put. The receptionist's
 * tile therefore needs an open tile on BOTH sides of it, the wall on one hand
 * and the counter on the other, which makes three tiles the shallowest pocket
 * there is: [wall][open][body][open][counter]. 1.25 m off the plaster is the
 * middle of the third tile, and the counter's back face lands at 2.05, which is
 * inside the fifth.
 *
 * Cut to two tiles it does not merely get tight, it gets SILENT. `standable`
 * nudges a station backwards to find floor and backwards here is into the wall,
 * so nothing recovers it: the station is dropped from the pool and the lobby
 * comes out with a counter and nobody behind it. Measured at 2 floors in 13
 * before the pocket was widened, with the counter standing there perfectly.
 */
const COUNTER_STAND = 1.25 - 0.15;

const COUNTER_CLEAR = 0.8;

/**
 * ...and the same arithmetic turned ninety degrees, which is what a PENINSULA
 * counter needs.
 *
 * The counter juts out of the wall now rather than standing along it, so the
 * body is beside it instead of behind it — and the pocket it needs is the same
 * three tiles read the other way: [counter][open][body], plus [wall][open][body]
 * out from the plaster. `COUNTER_STAND` is still what puts the body in the
 * middle of the third tile from the wall; this is the clearance from the
 * counter's own FACE, so `edgeProp` adds the prop's half width to it.
 *
 * One open tile plus half of the body's own is 0.75, and it is measured off the
 * face rather than the centre line for the reason `footprintOf` exists: the
 * counter's width is a fact about the prop and this number is a fact about the
 * tile grid, so adding them at the call site is how they stay independent.
 */
const COUNTER_ASIDE = 1.0;

/**
 * The lift lobby: the room the floor arrives in, leaves by, and is greeted in.
 *
 * Both cars are already standing in it before this runs — they are shell, cut
 * into the floorplan itself (see gen/lifts.js) — so what the furnisher adds is
 * the front of house around them: a counter to be greeted at, a plant, and
 * somewhere to wait that you are not going to wait in.
 *
 * `room.liftSide` is which wall the bank took, and the counter keeps off it: a
 * reception desk backed against the lifts is a desk with its back to the only
 * thing in the room. It goes on one of the two walls beside them first, which is
 * where a real one is — you come out of the car, and it is on your left or your
 * right — and only then on the wall opposite, which is the one the doors out are
 * usually cut in.
 */
function liftLobby(sink, bounds, rng, room, doors) {
  const bank = room?.liftSide ?? 0;
  // The two walls beside the lifts first, then the one opposite, and the lifts'
  // own wall last of all. A counter backed against the bank is a desk with its
  // back to the only thing in the room — but it is a real arrangement in a real
  // lobby, and a lobby with nobody in it is worse than one whose counter is off
  // to the side of the doors.
  //
  // An ordinary `edgeProp` with the two options a counter needs: it stands OFF
  // its wall so there is a behind to stand in, and its position is swept along
  // the wall rather than thrown at it, because by the time the furnisher reaches
  // the lobby the doorway aprons and the clear square at each car have taken the
  // whole band in front of the bank.
  // A PROJECTION OF THE WALL, in the wall's own paint: `receptionCounter` is
  // authored with its long axis through its depth, so `edgeProp`'s ordinary
  // standoff — half the depth, which is what backing a prop against a wall means
  // — runs 2.2 m of it out into the lobby. The whole peninsula is that one fact
  // about the prop plus where the station goes.
  //
  // AND THE COUNTER IS THE HALF THAT IS OUT THERE, with the body behind it. The
  // two Ls run their long leg the whole way out and close its nose with a short
  // return, so `corner` is what finds the station: the pocket
  // between the counter and the wall (see `lCounter` in gen/props.js and
  // `standableCorner`). Only the STUB is stood at from the side — one leg has no
  // behind, so its body goes in the crook, which is `aside` and COUNTER_ASIDE.
  const walls = rng.shuffle([(bank + 1) & 3, (bank + 3) & 3]).concat((bank + 2) & 3, bank);
  // BY THE DOOR. The lobby has one way in (see `oneWayIn` in gen/lifts.js), and
  // a reception you walk past on your way in is a reception where one across the
  // room is a desk somebody put there. `near` orders the walls and the slots
  // along them by distance to it rather than restricting either, so a lobby
  // whose doorway end is spoken for still gets a counter further along.
  // The doorway's middle in world metres. A role is handed `bounds` in metres
  // and its room in tiles, so this is the one conversion it needs — and `SKIRT`
  // is imported rather than written down again, because it is the number
  // furnish.js insets those bounds by and the two have to agree.
  const door = doorsOnRoom(doors, room).find((d) => !d.lift) ?? null;
  const near = door ? {
    x: bounds.x0 - SKIRT + ((door.x0 + door.x1) / 2 - room.x0) * TILE,
    z: bounds.z0 - SKIRT + ((door.y0 + door.y1) / 2 - room.y0) * TILE,
  } : null;
  // `flush` on all three: a counter drawn in the wall's own paint has to TOUCH
  // the wall, and without it every one of them stood 15 cm off the plaster with
  // a strip of carpet behind it — which cancels the one thing the prop is for and
  // left the pocket open along its back as well as at its end. Flush, the only
  // way into it is the one walk gap at the flank, which is what a reception is.
  // The two Ls carry that 0.15 m in their own depth now (see gen/props.js), so
  // the pocket is exactly as deep as it was.
  const counter = edgeProp(sink, bounds, 'receptionCounter', rng, walls, 'reception',
    { corner: true, sweep: true, near, flush: true })
    // ...and the same L one size down where the big one will not fit, which is
    // the retreat `wallSpanProp` makes for the generator: ask for the thing that
    // reads best, take the thing the room can hold. Both are the same shape, so
    // what a small lobby loses is the room to stand in the middle of the square
    // rather than the square itself.
    ?? edgeProp(sink, bounds, 'receptionCounterSmall', rng, walls, 'reception',
      { corner: true, sweep: true, near, flush: true })
    // ...and one leg on its own for a lobby with no square patch anywhere, where
    // the body stands beside it instead. See `receptionCounterStub`.
    // The stub keeps its own depth: nobody stands behind it (`aside` puts the
    // body in the crook), so there is no pocket to preserve — only the back face
    // to put on the plaster.
    ?? edgeProp(sink, bounds, 'receptionCounterStub', rng, walls, 'reception',
      { aside: COUNTER_ASIDE, stand: COUNTER_STAND, sweep: true, near, flush: true });
  // A plant beside a counter that landed and a plant anywhere at all if it did
  // not — the room still has to read as a lobby rather than as an empty box with
  // two lifts in it.
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'armchair', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'coffeeTable', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'extinguisher', rng);
  if (!counter && rng.chance(0.5)) edgeProp(sink, bounds, 'plant', rng);
}

const ROLES = {
  openplan: openPlan,
  meeting: meetingRoom,
  breakroom: breakRoom,
  storage,
  archive,
  copyroom: copyRoom,
  server: serverRoom,
  itbay: itBay,
  mailroom: mailRoom,
  utility: utilityRoom,
  presentation: presentationRoom,
  cafeteria,
  reception,
  office: privateOffice,
  manager: managerOffice,
  security: securityOffice,
  closet: broomCloset,
  generator: generatorRoom,
  // A car park's deck (gen/garage.js). Only ever handed out on a garage floor.
  parking: parkingDeck,
  lobby,
  // The floor arrives in the exit room and leaves by it — they are one room now
  // (see pickLobbyRoom in gen/roles.js), so `exit` is the lift lobby.
  exit: liftLobby,
};

// Every role the generator is allowed to hand out. layout.js picks from this by
// size; anything it picks that isn't here would silently come out as an office.

// Every role the generator is allowed to hand out. layout.js picks from this by
// size; anything it picks that isn't here would silently come out as an office.
export const ROOM_ROLES = Object.keys(ROLES);

// --- placement helpers ------------------------------------------------------

// Ranks of a repeated unit with a walking aisle between the ranks. The ranks
// run along the room's LONG axis, so the aisles are short hops across it rather
// than a trek from one end to the other — and there is always an aisle mouth on
// the long wall, which is where the doors mostly are.
// A rank stops short of both end walls by GANGWAY, which is not decoration: an
// aisle is a dead end if the only way out is the way you came, so one dropped
// pallet in the middle of one seals off everything past it. With a gangway
// round the ends every aisle has two mouths and no single blockage can shut a
// room's floor away from its own doorway.
