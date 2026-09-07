// How a prop gets put somewhere in a room.
//
// gen/rooms.js decides WHICH props a room gets; this is every way there is of
// putting one down — against a wall, out in the middle, in ranks with an aisle
// between them, scattered where somebody left it — plus the workstations that
// come with them, which is how enemies.js learns where the building's work
// happens.
//
// It is its own file for the reason `wall` gives at length: a side number is a
// quarter turn, and four sites answering "which way is into the room" for
// themselves is four chances to get it backwards. Half of them once were.

import { footprintOf, PROPS, QUARTER, tryPlace } from './props.js';
import { TILE } from './layout.js';
import { PLAYER_RADIUS } from '../metrics.js';

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
export const SEAT_PITCH = 0.66;   // metres between two people at a meeting table

const CENTRE_RINGS = [0, 0.55, 1.1, 1.65];

const CENTRE_DIRS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

export function centreProp(sink, kinds, bounds, rot, rng) {
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cz = (bounds.z0 + bounds.z1) / 2;
  for (const kind of kinds) {
    for (const r of CENTRE_RINGS) {
      for (const [dx, dz] of CENTRE_DIRS) {
        if (r === 0 && (dx || dz)) continue;
        const x = cx + dx * r, z = cz + dz * r;
        if (x < bounds.x0 || x > bounds.x1 || z < bounds.z0 || z > bounds.z1) continue;
        if (tryPlace(sink, kind, x, z, rot, rng)) return { kind, cx: x, cz: z };
      }
    }
  }
  return null;
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
export function wall(side, bounds) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = side === 0 || side === 2;
  const into = (side === 0 || side === 3) ? -1 : 1;
  const edge = side === 0 ? z1 : side === 1 ? x0 : side === 2 ? z0 : x1;
  const [a0, a1] = alongX ? [x0, x1] : [z0, z1];
  return {
    side, alongX, into, edge, a0, a1,
    // `at` runs along the wall, `standoff` runs into the room from it.
    seat(at, standoff) {
      const off = edge + into * standoff;
      return alongX ? [at, off] : [off, at];
    },
    // ...and the rectangle between the wall and something standing `depth` off
    // it, `width` across. What is behind a counter, in other words.
    pocket(at, depth, width) {
      const [p, q] = [edge, edge + into * depth].sort((m, n) => m - n);
      return alongX
        ? [at - width / 2, p, at + width / 2, q]
        : [p, at - width / 2, q, at + width / 2];
    },
  };
}

/**
 * Where along a wall to try, in the order to try them.
 *
 * Two answers, and which one a caller wants is about how spoken-for the room
 * is. A filing cabinet against the wall of an ordinary office wants ONE random
 * point, because almost any point will do and a swept prop lands in the same
 * corner of every room on the floor. A prop going into a room whose floor is
 * mostly reserved wants every position on the wall, walked from a random start
 * so it is still not in the same place twice — the lift lobby's counter found a
 * spot on about half of floors with ten darts and on nearly all of them with a
 * sweep, and the half that missed came out with nobody behind the counter.
 */

/**
 * Where along a wall to try, in the order to try them.
 *
 * Two answers, and which one a caller wants is about how spoken-for the room
 * is. A filing cabinet against the wall of an ordinary office wants ONE random
 * point, because almost any point will do and a swept prop lands in the same
 * corner of every room on the floor. A prop going into a room whose floor is
 * mostly reserved wants every position on the wall, walked from a random start
 * so it is still not in the same place twice — the lift lobby's counter found a
 * spot on about half of floors with ten darts and on nearly all of them with a
 * sweep, and the half that missed came out with nobody behind the counter.
 */
function* wallOrder(sides, rng, sweep) {
  if (sweep) { yield* sides; return; }
  for (let i = 0; i < 12; i++) yield rng.pick(sides);
}

function* wallSlots(w, margin, rng, sweep) {
  const lo = w.a0 + margin, hi = w.a1 - margin;
  if (hi < lo) return;
  if (!sweep) { yield rng.range(lo, hi); return; }
  const n = Math.max(1, Math.floor((hi - lo) / TILE) + 1);
  const from = rng.int(0, n - 1);
  for (let i = 0; i < n; i++) yield lo + ((from + i) % n) * TILE;
}

// Backs a `spanning` prop against one whole wall, corner to corner, and returns
// where it landed (or null). The prop is built to the length it is given rather
// than to a catalogue width — see `spanning` in gen/props.js.
//
// The retreat is the point of having a helper at all. Reaching both corners
// means reserving every tile across the room, and the furnisher is not the only
// thing with a claim on them: reserveClearances in gen/furnish.js stamps doorway
// aprons into the shared grid without regard for whose room the tile is in, so
// one unrelated doorway on the other side of that wall can veto the full span.
// Giving up there would leave the room without the one thing it is named for,
// so it steps in half a metre a side and asks again, and only then falls back
// to the catalogue size somewhere else on the wall.

// Backs a `spanning` prop against one whole wall, corner to corner, and returns
// where it landed (or null). The prop is built to the length it is given rather
// than to a catalogue width — see `spanning` in gen/props.js.
//
// The retreat is the point of having a helper at all. Reaching both corners
// means reserving every tile across the room, and the furnisher is not the only
// thing with a claim on them: reserveClearances in gen/furnish.js stamps doorway
// aprons into the shared grid without regard for whose room the tile is in, so
// one unrelated doorway on the other side of that wall can veto the full span.
// Giving up there would leave the room without the one thing it is named for,
// so it steps in half a metre a side and asks again, and only then falls back
// to the catalogue size somewhere else on the wall.
export function wallSpanProp(sink, bounds, kind, rng, side) {
  const { x0, z0, x1, z1 } = bounds;
  const { d: fd } = footprintOf(sink, kind);
  const standoff = fd / 2;
  const w = wall(side, bounds);
  const full = w.a1 - w.a0;
  const mid = (w.a0 + w.a1) / 2;

  // Starting a hair inside the bounds rather than exactly on them. `bounds` is
  // already the 0.15 m wall inset every prop in the building is held to, and a
  // prop whose edge lands exactly on it is one rounding error from being
  // reported as through the plaster (9.inset in tools/validate-props.mjs).
  for (let span = full - 0.04; span >= full - 1.5 && span > 2; span -= 0.5) {
    const [cx, cz] = w.seat(mid, standoff);
    if (tryPlace(sink, kind, cx, cz, side, rng, span)) {
      return { cx, cz, rot: side, side, span };
    }
  }
  return null;
}

// The chair that goes with whatever was just backed against a wall: a body's
// width out in front of it, turned round to face it.
//
// And the one place in the furnisher that says where somebody WORKS. A desk with
// a monitor on it and a chair pulled up to it is a job, and the chair is where
// the body doing it sits — so the same call that puts the chair down registers
// the workstation, and a room cannot end up with a seated body facing the wrong
// way or sitting on nothing. `sink.workstation` decides whether it is worth
// keeping (see makeSink in gen/sink.js); everything downstream is enemies.js's.

// The chair that goes with whatever was just backed against a wall: a body's
// width out in front of it, turned round to face it.
//
// And the one place in the furnisher that says where somebody WORKS. A desk with
// a monitor on it and a chair pulled up to it is a job, and the chair is where
// the body doing it sits — so the same call that puts the chair down registers
// the workstation, and a room cannot end up with a seated body facing the wrong
// way or sitting on nothing. `sink.workstation` decides whether it is worth
// keeping (see makeSink in gen/sink.js); everything downstream is enemies.js's.
/**
 * A body-sized square of free floor beside a prop, on either flank.
 *
 * The crook of a peninsula: one open tile out from the prop's face and one out
 * from the wall, which is where somebody stands at a counter that juts into the
 * room. Returns where to stand and the rectangle to claim, or null if neither
 * flank is free.
 */
function freeAside(sink, w, along, off, out, first) {
  // Two distances out from the wall, not one. The nearest tile a body fits in is
  // the third from the plaster (see COUNTER_STAND), and by the time the
  // furnisher reaches the lobby that whole band is regularly spoken for by the
  // doorway apron and the square kept clear at each car — so the next tile out
  // is tried as well, which is still beside a counter this long. It is worth 8
  // lobbies in 60.
  // ...and the far END of it last of all, which is on the prop's own centre line
  // rather than off to one side. A body there is standing at the end of the
  // counter, which is a real place to be greeted from and is regularly the only
  // tile of the four that is free: it is the one furthest into the room, and
  // what takes the others is the band of floor kept clear along the wall.
  let fallback = null;
  for (const [sign, depth] of [[first, out], [-first, out], [first, out + TILE],
    [-first, out + TILE]]) {
    const [x, z] = w.seat(along + sign * off, depth);
    // A whole TILE rather than a body's own square. `fits` in nav.js refuses any
    // tile orthogonally touching a blocked one, so proving 0.4 m of clearance
    // here published stations a body could not stand in — 8 of 40 before this.
    const spot = [x - TILE, z - TILE, x + TILE, z + TILE];
    if (sink.canPlace(...spot)) return { x, z, spot };
    fallback ??= { x, z, spot };
  }
  // NOTHING FREE, and the answer is still a station rather than no counter.
  // `standable` in enemies.js nudges a station that is a place to STAND
  // backwards along its own facing to find floor — which here is further out
  // into the room, down the flank of the counter — so a crook that this pass
  // cannot prove is regularly one the roster can still use. Refusing the
  // placement instead cost 7 lobbies in 60 their receptionist, which is worse
  // than a counter whose body ends up half a metre further out.
  return fallback;
}

export function seatFacing(sink, kind, cx, cz, rot, rng, gap = 0.95) {
  // The DESK, taken before the chair goes in. Every caller places the desk and
  // seats it on the very next line, so the last prop through the sink is that
  // desk — and it has to be read here rather than after, because `tryPlace`
  // below stands a chair up and a chair is loose, which would leave `placed()`
  // holding whatever static prop happened to precede it.
  const desk = sink.placed();
  const out = QUARTER[rot & 3](0, -gap);
  const x = cx + out[0];
  const z = cz + out[1];
  const seat = (rot + 2) & 3;

  // Placed inside the desk's own reservation, because a chair pulled up to a
  // desk is inside it whatever the arithmetic says: floor is reserved by whole
  // tiles and a 0.97 m desk reaches half a metre past its own front face. That
  // is what `lend` is for, and without it this failed on all 16 wall-backed
  // desks of the floor it was measured on. Every other claim on the floor still
  // stands while the tiles are lent — the wall behind, the doorway apron, the
  // cabinet beside it.
  const { w, d } = footprintOf(sink, kind, rot);
  const placed = sink.lend(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2,
    () => tryPlace(sink, 'chair', x, z, seat, rng));
  if (!placed) return false;

  // Both stations are AT the desk, which is what ends the job when the desk is
  // shot apart. The chair is not named: it is loose and contributes no static
  // collider, and a chair going out from under a body is `_seatGone`'s.
  sink.workstation(x, z, seat, 'desk', desk);

  // ...and the two places somebody can stand at this desk without standing in
  // its chair. Offered on every desk in the building and mostly refused: they
  // are what the standing "work on a computer" job is done at (see chores.js and
  // DESK_ASIDE), and a chair that only just fits has no room either side of it.
  // Nothing here reserves a tile — a workstation is an offer, and this one is
  // taken up by at most one body at a time.
  for (const aside of [DESK_ASIDE, -DESK_ASIDE]) {
    const [ax, az] = QUARTER[rot & 3](aside, 0);
    sink.workstation(x + ax, z + az, seat, 'computer', desk);
  }
  return true;
}

/**
 * Registers a seat somebody can spend a break in.
 *
 * A sofa and an armchair are not chairs: nothing pulls them up to anything, so
 * they never came down the `seatFacing` pipe and the game had no idea they were
 * places to sit. `edgeProp` hands back where the prop landed and which wall it
 * is against, and a prop backed against side `s` faces FACING[s] into the room —
 * so the body sits at the prop's own position facing the way the prop does,
 * which is the same line `_seat` uses to turn a station's rot into a yaw.
 *
 * `seats` is how many bodies fit on it, spread along its width: one on an
 * armchair, two on a sofa. Spread by a third of the prop's width either side of
 * centre rather than by half, so two people on a sofa are sitting on it rather
 * than perched on its arms.
 */

/**
 * Registers a seat somebody can spend a break in.
 *
 * A sofa and an armchair are not chairs: nothing pulls them up to anything, so
 * they never came down the `seatFacing` pipe and the game had no idea they were
 * places to sit. `edgeProp` hands back where the prop landed and which wall it
 * is against, and a prop backed against side `s` faces FACING[s] into the room —
 * so the body sits at the prop's own position facing the way the prop does,
 * which is the same line `_seat` uses to turn a station's rot into a yaw.
 *
 * `seats` is how many bodies fit on it, spread along its width: one on an
 * armchair, two on a sofa. Spread by a third of the prop's width either side of
 * centre rather than by half, so two people on a sofa are sitting on it rather
 * than perched on its arms.
 */
export function lounge(sink, kind, at, rng, seats) {
  if (!at) return;
  const { w } = footprintOf(sink, kind);
  for (let i = 0; i < seats; i++) {
    const t = seats === 1 ? 0 : (i - (seats - 1) / 2) * (w / 3) * 2;
    const [ax, az] = QUARTER[at.side](t, 0);
    sink.workstation(at.cx + ax, at.cz + az, at.side, 'lounge');
  }
}

// --- the three rooms you need a card for ------------------------------------
//
// All three are behind a badge reader (see assignLocks in gen/layout.js), so
// each one is a room you had to work to stand in. That buys them the right to
// look like somewhere: the payoff for a keycard is seeing the room, so none of
// them may furnish as "a private office with a different label on the door".

// Corner office. A desk you sit BEHIND with the visitor's chairs in front of it,
// which is the whole silhouette — nobody else on the floor gets seating that
// faces the wrong way.

// Ranks of a repeated unit with a walking aisle between the ranks. The ranks
// run along the room's LONG axis, so the aisles are short hops across it rather
// than a trek from one end to the other — and there is always an aisle mouth on
// the long wall, which is where the doors mostly are.
// A rank stops short of both end walls by GANGWAY, which is not decoration: an
// aisle is a dead end if the only way out is the way you came, so one dropped
// pallet in the middle of one seals off everything past it. With a gangway
// round the ends every aisle has two mouths and no single blockage can shut a
// room's floor away from its own doorway.
const GANGWAY = 0.9;   // metres — the player is 0.8 m across

export function aisles(sink, bounds, aislePitch, unitPitch, kind, rng, station = null) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  const [a0, a1, b0, b1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const rot = alongX ? 0 : 1;

  // Too short to hold a rank and its gangways: leave it to the clutter.
  if (a1 - a0 < 2 * GANGWAY + unitPitch) return;

  // How far the last rank may stand from the far wall, which is half of what
  // the rank is actually DEEP — the same footprint tryPlace will reserve, so a
  // model-backed rack is measured at the size it ships at. This was a flat
  // 0.4 m, which happened to suit a 1.06 m server rack and not the 1.31 m one
  // the model turned out to be, and the last rank in every server room stood a
  // couple of centimetres into the wall inset because of it. `b` is the aisle
  // axis, and a rank presents its depth along it whichever way round the room
  // is, which is why this asks in the prop's own frame.
  const half = footprintOf(sink, kind).d / 2;
  // Where a body stands to take something off a rack, if this caller wants one.
  // Same derivation and the same reasons as the servery's queue below: the
  // furnisher is the only thing that knows where a rack actually landed, a prop
  // is authored facing -Z so QUARTER turns its own depth into a direction, and
  // the body faces back the other way — `(rot + 2) & 3`. Written out by hand
  // this is four coordinates and half of them come out backwards.
  //
  // Offered on EVERY unit rather than a chosen few, and most of them are
  // rubbish: the first rank of an aisle faces the wall it is nearest, so its
  // spot is inside the plaster. That is fine and is why the offer goes down the
  // `sink.workstation` pipe — `deskPool` in enemies.js drops any station a body
  // cannot stand at, exactly as it already does for one canteen tray rack in ten.
  const front = half + RACK_REACH;
  const place = (cx, cz) => {
    if (!tryPlace(sink, kind, cx, cz, rot, rng)) return;
    if (!station) return;
    const [ox, oz] = QUARTER[rot](0, -front);
    sink.workstation(cx + ox, cz + oz, (rot + 2) & 3, station);
  };
  for (let b = b0 + aislePitch * 0.3; b < b1 - half; b += aislePitch) {
    for (let a = a0 + GANGWAY + unitPitch / 2; a < a1 - GANGWAY - unitPitch / 2 + 0.05; a += unitPitch) {
      if (alongX) place(a, b);
      else place(b, a);
    }
  }
}

// How far in front of a rack a body stands to reach it. Under storage's 1.9 m
// aisle pitch, so the spot lands in the gangway rather than inside the next rank.

// How far in front of a rack a body stands to reach it. Under storage's 1.9 m
// aisle pitch, so the spot lands in the gangway rather than inside the next rank.
const RACK_REACH = 0.65;

export const ALL_SIDES = [0, 1, 2, 3];

export const area = ({ x0, z0, x1, z1 }) => (x1 - x0) * (z1 - z0);

// Optional props along the walls, as many as the room has floor to carry. A
// 34 m2 break room and a 120 m2 one must not both get one of everything: a prop
// against a wall is cheap on its own and expensive in company, because three of
// them in a line across a narrow room close the room in half. `kinds` is in
// priority order — the first is the one the room most wants.

// Optional props along the walls, as many as the room has floor to carry. A
// 34 m2 break room and a 120 m2 one must not both get one of everything: a prop
// against a wall is cheap on its own and expensive in company, because three of
// them in a line across a narrow room close the room in half. `kinds` is in
// priority order — the first is the one the room most wants.
export function wallClutter(sink, bounds, kinds, perM2, rng) {
  const n = Math.min(kinds.length, Math.floor(area(bounds) / perM2));
  for (let i = 0; i < n; i++) edgeProp(sink, bounds, kinds[i], rng);
}

// Clutter dropped where it was put down. `perM2` is one item per that many
// square metres — the room's own size decides how littered it is.
//
// A STATIC prop dropped in the middle of the floor is the one thing the furnisher
// does that can wall a room off, so it has to leave a body's width around it.
//
// This is the copyroom bug in a second room type (see reserveThroughRoutes in
// gen/build.js): `canPlace` rounds a footprint outward to whole tiles, so two
// props in diagonally adjacent tile blocks can pass that test and still leave a
// gap no body can get through — two 0.8 m crates a tile apart on the diagonal
// have about 0.53 m of perpendicular clearance against a 0.8 m body. Measured in
// an itbay on one floor in three hundred: 2266 cells of its own floor cut off
// behind exactly two scattered crates, with a two-cell neck between them.
//
// Asking for the footprint plus a body's radius on every side is the whole fix,
// and it costs a little density in a busy room: a crate that cannot leave a lane
// beside it is a crate that does not land. Loose props are exempt because they are
// not obstacles — you walk into a carton and it moves.

// Clutter dropped where it was put down. `perM2` is one item per that many
// square metres — the room's own size decides how littered it is.
//
// A STATIC prop dropped in the middle of the floor is the one thing the furnisher
// does that can wall a room off, so it has to leave a body's width around it.
//
// This is the copyroom bug in a second room type (see reserveThroughRoutes in
// gen/build.js): `canPlace` rounds a footprint outward to whole tiles, so two
// props in diagonally adjacent tile blocks can pass that test and still leave a
// gap no body can get through — two 0.8 m crates a tile apart on the diagonal
// have about 0.53 m of perpendicular clearance against a 0.8 m body. Measured in
// an itbay on one floor in three hundred: 2266 cells of its own floor cut off
// behind exactly two scattered crates, with a two-cell neck between them.
//
// Asking for the footprint plus a body's radius on every side is the whole fix,
// and it costs a little density in a busy room: a crate that cannot leave a lane
// beside it is a crate that does not land. Loose props are exempt because they are
// not obstacles — you walk into a carton and it moves.
const SCATTER_LANE = PLAYER_RADIUS;

export function scatter(sink, bounds, kinds, perM2, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const n = 1 + Math.floor(((x1 - x0) * (z1 - z0)) / perM2);
  for (let i = 0; i < n; i++) {
    const kind = rng.pick(kinds);
    const x = rng.range(x0 + 0.5, x1 - 0.5);
    const z = rng.range(z0 + 0.5, z1 - 0.5);
    const rot = rng.int(0, 3);
    if (!PROPS[kind]?.mass) {
      const foot = footprintOf(sink, kind, rot);
      const w = foot.w / 2 + SCATTER_LANE, d = foot.d / 2 + SCATTER_LANE;
      if (!sink.canPlace(x - w, z - d, x + w, z + d)) continue;
    }
    tryPlace(sink, kind, x, z, rot, rng);
  }
}

// Tries to seat a prop against a random wall, back to the wall, a few times.
//
// Every side uses HALF THE DEPTH as the standoff and HALF THE WIDTH as the
// along-wall margin, with no special case. That is the whole point of backing a
// prop against a wall: its depth always faces the wall, and the quarter-turn
// each side applies is exactly what maps `d` onto the axis perpendicular to it.
// Swapping the two here pushed wide props (counters, meeting tables) up to a
// metre out into the room and shoved narrow ones into the wall.
//
// Sides, throughout: 0 = the +z wall, 1 = -x, 2 = -z, 3 = +x — and the side IS
// the quarter turn, which is not a coincidence and took a wall of dark monitors
// to notice. A prop is authored facing -z (see gen/props.js), so the turn that
// puts its face into the room is exactly the one that maps -z onto the direction
// away from the wall: rot 0 for the +z wall, rot 1 for -x, and so on. The two
// even sides used to be the other way round, which stood every vending machine,
// whiteboard and reception desk on the +z and -z walls with its front to the
// plaster — invisible on a grey box, and instantly obvious on eight lit screens.
// It also aimed `deskAgainstWall`'s chair at the wall, so those desks silently
// came out with nobody sitting at them.
//
// `sides` narrows which walls are on offer. A room that knows something about
// its own layout — a cubicle farm knows exactly how much lane it left between
// the desks and each wall — uses it to keep a prop off the wall where it would
// close that lane, instead of leaving it to a die roll.
//
// Returns WHERE it landed, or null. Almost every caller only wants to know
// whether it did, and an object is as truthy as `true` — but a room that has to
// put a chair in front of the thing it just placed has no other way to find out
// which wall the die picked.
// Which machines somebody can be found working AT, and what the station is
// called when it goes down the `sink.workstation` pipe. See chores.js.
//
// A table read by `edgeProp` rather than an argument threaded through its
// fifteen call sites, and that is the same argument `aisles` already makes about
// a rack: whether a printer is somewhere to stand is a fact about printers, not
// about the copy room. So every vending machine, printer, workbench and server
// rack backed against a wall anywhere in the building offers a place to stand,
// for free, and the ones that are no good are dropped at the other end —
// `deskPool` in enemies.js refuses any station a whole body does not fit at,
// exactly as it already does for one canteen tray rack in ten.

// Tries to seat a prop against a random wall, back to the wall, a few times.
//
// Every side uses HALF THE DEPTH as the standoff and HALF THE WIDTH as the
// along-wall margin, with no special case. That is the whole point of backing a
// prop against a wall: its depth always faces the wall, and the quarter-turn
// each side applies is exactly what maps `d` onto the axis perpendicular to it.
// Swapping the two here pushed wide props (counters, meeting tables) up to a
// metre out into the room and shoved narrow ones into the wall.
//
// Sides, throughout: 0 = the +z wall, 1 = -x, 2 = -z, 3 = +x — and the side IS
// the quarter turn, which is not a coincidence and took a wall of dark monitors
// to notice. A prop is authored facing -z (see gen/props.js), so the turn that
// puts its face into the room is exactly the one that maps -z onto the direction
// away from the wall: rot 0 for the +z wall, rot 1 for -x, and so on. The two
// even sides used to be the other way round, which stood every vending machine,
// whiteboard and reception desk on the +z and -z walls with its front to the
// plaster — invisible on a grey box, and instantly obvious on eight lit screens.
// It also aimed `deskAgainstWall`'s chair at the wall, so those desks silently
// came out with nobody sitting at them.
//
// `sides` narrows which walls are on offer. A room that knows something about
// its own layout — a cubicle farm knows exactly how much lane it left between
// the desks and each wall — uses it to keep a prop off the wall where it would
// close that lane, instead of leaving it to a die roll.
//
// Returns WHERE it landed, or null. Almost every caller only wants to know
// whether it did, and an object is as truthy as `true` — but a room that has to
// put a chair in front of the thing it just placed has no other way to find out
// which wall the die picked.
// Which machines somebody can be found working AT, and what the station is
// called when it goes down the `sink.workstation` pipe. See chores.js.
//
// A table read by `edgeProp` rather than an argument threaded through its
// fifteen call sites, and that is the same argument `aisles` already makes about
// a rack: whether a printer is somewhere to stand is a fact about printers, not
// about the copy room. So every vending machine, printer, workbench and server
// rack backed against a wall anywhere in the building offers a place to stand,
// for free, and the ones that are no good are dropped at the other end —
// `deskPool` in enemies.js refuses any station a whole body does not fit at,
// exactly as it already does for one canteen tray rack in ten.
const WORK_AT = {
  vending: 'vending',
  printer: 'printer',
  workbench: 'bench',
  serverRack: 'server',
  // The front of a room rather than a machine, and it is the same fact: a
  // whiteboard is somewhere a body stands. Meetings hold their board here (see
  // meetings.js). A presentation room registers its own `board` beside its
  // screen rather than coming through here, because that screen goes on the wall
  // the seating picked rather than on a wall of its own choosing.
  whiteboard: 'board',
  sortingBench: 'sorting',
  charger: 'charge',
};

// ...except where the ROOM decides what a prop is a place to do. A shelving unit
// is `shelf` in a storeroom and `mail` in a mailroom, and the difference is not
// about shelving, it is about what is on it — so it cannot come off the table
// above, which is keyed on the prop. `edgeProp` takes it as an override.


// How far in front of a machine a body stands to use it. A shade under the
// rack's 0.65 because these are reached with the hands rather than leaned into,
// and a body standing a full arm's length off a vending machine reads as
// somebody who has decided against it.

// How far in front of a machine a body stands to use it. A shade under the
// rack's 0.65 because these are reached with the hands rather than leaned into,
// and a body standing a full arm's length off a vending machine reads as
// somebody who has decided against it.
const WORK_REACH = 0.58;

// ...and how far to one side of a desk's own chair the standing job goes.
//
// A desk station is where the CHAIR is, and a body standing there is standing
// in the chair. Offset along the desk instead and they are at the end of it,
// still in front of the monitor and facing the same way — which is what
// somebody who has come over to check something on your machine actually does,
// and it is the only reading of "work on a computer" that does not sit a body
// down. Both sides are offered; the nav filter keeps whichever the room has
// room for, and a pod on a tight pitch loses both.

// ...and how far to one side of a desk's own chair the standing job goes.
//
// A desk station is where the CHAIR is, and a body standing there is standing
// in the chair. Offset along the desk instead and they are at the end of it,
// still in front of the monitor and facing the same way — which is what
// somebody who has come over to check something on your machine actually does,
// and it is the only reading of "work on a computer" that does not sit a body
// down. Both sides are offered; the nav filter keeps whichever the room has
// room for, and a pod on a tight pitch loses both.
const DESK_ASIDE = 0.62;

export function edgeProp(sink, bounds, kind, rng, sides = ALL_SIDES, as = null, opts = {}) {
  // Asked in the prop's OWN frame, where `d` is always the dimension that faces
  // the wall and `w` the one that runs along it — which is the whole reason the
  // side is the quarter turn. The numbers come from the model when there is
  // one, because that is the footprint tryPlace is about to reserve; taking
  // them from the catalogue instead stood a copier 0.44 m off a wall it is
  // 0.565 m deep from the middle of, and a server rack likewise.
  const { w: fw, d: fd } = footprintOf(sink, kind);
  // How far the prop's own middle stands off the wall. Half its depth puts its
  // back on the plaster, which is what backing something against a wall means
  // and what all but one prop in the building wants. `behind` is the exception
  // and is the whole of what a COUNTER is: a reception desk is the one prop
  // somebody stands behind, and the model is 0.55 m deep, so with its back on
  // the wall the entire pocket is the 0.15 m of skirting clearance. See
  // COUNTER_STAND for what the number has to be and why it is a nav number.
  const standoff = fd / 2 + (opts.behind ?? 0);
  const margin = fw / 2;   // so a 3 m table can't hang off the end of the wall
  if (!sides.length) return null;
  // Which side of a peninsula the body is tried on first. Drawn ONCE, out here:
  // the sweep tries a great many positions and a die inside the loop would
  // spend a number a floor for each of them — which is the argument `wallOrder`
  // makes about being a generator rather than an array.
  const asideFirst = opts.aside != null && rng.chance(0.5) ? 1 : -1;

  // One random point on a random wall, twelve times over — or every point on
  // every offered wall in turn. See `wallSlots`: which a caller wants is about
  // how spoken-for the room is, and the lift lobby is the room where it matters.
  //
  // A GENERATOR rather than a list, and that is not style. Drawing the twelve
  // sides up front would take twelve numbers off the floor's rng before the
  // first `tryPlace` took any, which re-rolls the contents of every room after
  // this one — the same argument `assignLocks` makes about spending the floor's
  // stream out of order, one scale down.
  for (const side of wallOrder(sides, rng, opts.sweep)) {
    const w = wall(side, bounds);
    // A prop wider than the wall it was offered simply doesn't fit there.
    if (w.a1 - w.a0 < margin * 2) continue;

    for (const along of wallSlots(w, margin, rng, opts.sweep)) {
      const [cx, cz] = w.seat(along, standoff);
      // The pocket behind a counter has to be free BEFORE it goes in and claimed
      // after, and neither is `tryPlace`'s business — it proves the prop's own
      // tiles and nothing else, so a counter standing across the corner of a lift
      // block or across a doorway apron places perfectly and has no floor behind
      // it. Claiming matters just as much: everything else in a room is placed
      // after, and a lobby whose receptionist was displaced by its own pot plant
      // is a lobby with a counter and nobody behind it. Both were missing once
      // and both are silent — all that happens is `standable` in enemies.js drops
      // the station from the pool.
      const pocket = opts.behind ? w.pocket(along, standoff - fd / 2, fw) : null;
      if (pocket && !sink.canPlace(...pocket)) continue;
      // ...and the CROOK, for a prop that is stood at from the side. Proved
      // before the prop goes in and for the pocket's exact reason: a wall
      // position whose crook is already spoken for has to be skipped rather
      // than taken, or the sweep delivers a counter with nobody at it. It cost
      // 17 lobbies in 60 to find that out.
      const crook = opts.aside == null ? null
        : freeAside(sink, w, along, margin + opts.aside, opts.stand ?? WORK_REACH, asideFirst);
      if (!tryPlace(sink, kind, cx, cz, side, rng)) continue;
      if (pocket) sink.occupy(...pocket);
      // Claimed only if it was free to begin with: `occupy` on ground another prop
      // already holds would take it away from whatever is standing there.
      if (crook && sink.canPlace(...crook.spot)) sink.occupy(...crook.spot);

      // Somewhere to stand and use it, if it is that kind of machine. Derived the
      // way the rack fronts and the servery queue are: a prop is authored facing
      // -Z, so QUARTER turns its own depth into a direction.
      //
      // IN FRONT for a machine, and BEHIND for a counter — one sign, and it is
      // the whole difference. A body at a copier faces back at the thing it is
      // working on; a receptionist stands on the wall side and faces the way the
      // counter faces, because what they are looking at is whoever walked in.
      const at = as ?? WORK_AT[kind];
      if (at) {
        // IN FRONT for a machine, BEHIND for a counter, and BESIDE for one that
        // juts out of the wall. The third is the lift lobby's, and it is the
        // only one where the body does not stand on the prop's own axis at all:
        // a peninsula is stood at from the side, in the crook between it and
        // the wall it grows out of.
        //
        // Which side is whichever one is free, proved and then CLAIMED — the
        // same bargain the pocket behind a counter makes, and for the same
        // reason: everything else in the room is placed after this, and a lobby
        // whose receptionist was displaced by its own pot plant is a lobby with
        // a counter and nobody at it.
        if (crook) {
          sink.workstation(crook.x, crook.z, side, at, sink.placed());
        } else {
          const reach = opts.behind ? (standoff - opts.stand) : -(standoff + WORK_REACH);
          const [ox, oz] = QUARTER[side](0, reach);
          // `sink.placed()` is the prop on the line above, which is what makes a
          // job at this station end when that prop is destroyed rather than
          // leaving somebody pressing the buttons on a heap of debris.
          sink.workstation(cx + ox, cz + oz, opts.behind ? side : (side + 2) & 3, at,
            sink.placed());
        }
      }
      return { cx, cz, rot: side, side };
    }
  }
  return null;
}
