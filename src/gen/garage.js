// A floor of the building that is a car park.
//
// One floor in ten comes out of the lift into concrete instead of carpet: the big
// rooms are parking decks with rows of cars in painted bays and pillars down the
// middle, the corridors are asphalt lanes, and the attics and basements the stairs
// already reach (gen/stairs.js) are split-level decks of their own, reached up a
// concrete ramp and parked full of more cars.
//
// It is a REFIT of an office floor rather than a generator of its own, and that is
// the whole reason it is safe: the corridor spine, the BSP, the doors, the locks,
// the lifts and the stairs are all planned exactly as on any other floor, so every
// invariant the three validators prove about a floor is still proved about this
// one. What changes is what a room is FOR and what the building is made of — both
// facts the builder already asks about by name.
//
// The back of house stays: the security office, the manager, the broom closet, a
// storeroom, a break room and the canteen. The keycards, the lunch cycle and the
// restock all need them, and a car park with a staff room off it is a car park.

import * as THREE from 'three';
import { makeRng } from './rng.js';
import { tryPlace } from './props.js';
import { edgeProp, ALL_SIDES } from './placement.js';
import { RAMP_RUN, RAMP_SLOPE, RISER, rampSpec } from './stairs.js';

// TEST: 1.0 while garage floors are being looked at. The design value is 0.1.
export const GARAGE_CHANCE = 1.0;

/**
 * Whether this floor is a car park. Its own stream, mixed with the floor number,
 * for `floorSpans`'s two reasons: drawing it from the floor's rng would re-roll
 * the whole building off a die that has nothing to do with it, and a stream of
 * the seed alone would make every floor of one seed the same kind.
 */
export function rollGarage(seed, floorNumber) {
  const rng = makeRng((seed ^ 0x6a4a7a9e) + Math.imul(floorNumber, 0x2545f491));
  return rng() < GARAGE_CHANCE;
}

// The rooms a car park keeps as what they were. Everything the roster, the locks
// or the chore table is built around: see the note at the top of this file.
const KEEP = new Set([
  'exit', 'cafeteria', 'generator', 'security', 'manager', 'closet',
  'storage', 'breakroom', 'server', 'mailroom', 'archive',
]);

// How big a room has to be to be worth parking in: a single row of bays and the
// lane in front of it, across its short side.
const MIN_SHORT = 8.5;     // metres

/**
 * Hands the parking decks out. No dice: every room that is big enough and is not
 * one of the kept roles becomes one, so nothing downstream of the planner moves.
 * Runs after locks and stairs, so it can never take a room those passes needed
 * for something else.
 */
export function makeParking(rooms) {
  for (const r of rooms) if (willPark(r)) r.role = 'parking';
}

/** Whether a room is going to be a parking deck. Asked by the stair planner too. */
export function willPark(r) {
  if (KEEP.has(r.role)) return false;
  return Math.min(r.wTiles, r.hTiles) * 0.5 >= MIN_SHORT;
}

// --- the deck ----------------------------------------------------------------

const BAY_W = 2.5;        // one bay across, which is the `car` prop's footprint
const BAY_D = 5.0;        // ...and one bay deep
const LANE = 3.2;         // the drive aisle in front of a row
const STRIP = 0.8;        // between two rows parked back to back: the pillars
const GANG = 1.2;         // clear at both ends of every row, so no row is a wall
const PILLAR_EVERY = 3;   // bays between two pillars down a strip

/**
 * Rows of bays across the room's short side with a lane in front of each, the
 * way a car park is laid out: a row backed onto the wall, a lane, then two rows
 * parked back to back with pillars between them, a lane, and so on.
 *
 * Bays are placed SNAPPED to the tile grid, and that is load-bearing rather than
 * neat: a footprint is rounded outward to whole tiles, so two bays at an honest
 * 2.5 m pitch but off the grid each claim a sliver of the other's tile and the
 * second one is refused. Snapped, they share an edge exactly.
 */
export function parkingDeck(sink, bounds, rng) {
  // Rows run along one axis and stack across the other, and which way round is
  // whichever parks more cars: a 12 x 14 m room holds one row across its short
  // side and two across its long one.
  const plans = [true, false].map((alongX) => planDeck(bounds, alongX));
  const plan = plans[0].bays * plans[0].rows.length >= plans[1].bays * plans[1].rows.length
    ? plans[0] : plans[1];
  if (!plan.rows.length || !plan.bays) {
    // Too shallow for a row and its lane either way: park along the walls.
    for (let i = 0; i < 4; i++) edgeProp(sink, bounds, 'car', rng, ALL_SIDES);
    return;
  }
  const { alongX, rows, strips } = plan;
  const { x0, z0, x1, z1 } = bounds;
  const [a0, a1, b0] = alongX ? [x0, x1, z0] : [z0, z1, x0];

  // Bays along each row, snapped: the width axis centres on a tile centre (5
  // tiles across, odd) and the depth axis on a tile boundary (10 deep, even).
  const snapA = (a) => {
    const [sx, sz] = alongX ? sink.snap(a, b0) : sink.snap(b0, a);
    return alongX ? sx : sz;
  };
  const snapB = (b) => {
    const [sx, sz] = alongX ? sink.snap(a0, b) : sink.snap(b, a0);
    return (alongX ? sz : sx) - 0.25;
  };

  const first = snapA(a0 + GANG + BAY_W / 2);
  const bays = [];
  for (let a = first; a + BAY_W / 2 <= a1 - GANG + 1e-6; a += BAY_W) bays.push(a);

  for (const row of rows) {
    const b = snapB(row.c + 0.25);
    // A prop is authored facing -Z, so a car on the x axis nosing toward +z is a
    // half turn, and one on the z axis nosing toward +x is a quarter turn.
    const rot = alongX ? (row.face > 0 ? 2 : 0) : (row.face > 0 ? 3 : 1);
    for (const a of bays) {
      const [cx, cz] = alongX ? [a, b] : [b, a];
      tryPlace(sink, 'car', cx, cz, rot, rng);
    }
  }

  // Pillars down each strip, on the line between two bays.
  for (const s of strips) {
    for (let i = PILLAR_EVERY; i < bays.length; i += PILLAR_EVERY) {
      const a = bays[i] - BAY_W / 2;
      const [cx, cz] = alongX ? [a, s] : [s, a];
      tryPlace(sink, 'pillar', cx, cz, 0, rng);
    }
  }
}

/**
 * Where the rows go across the room and which way each faces, for rows running
 * along one axis. `face` is +1 for a car whose nose points toward +b.
 */
function planDeck({ x0, z0, x1, z1 }, alongX) {
  const [a0, a1, b0, b1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const rows = [];
  const strips = [];
  const bays = Math.max(0, Math.floor((a1 - a0 - GANG * 2) / BAY_W));
  let y = b0;
  if (y + BAY_D + LANE > b1) return { alongX, rows, strips, bays };
  rows.push({ c: y + BAY_D / 2, face: 1 });
  y += BAY_D + LANE;
  for (;;) {
    if (y + BAY_D > b1) break;
    rows.push({ c: y + BAY_D / 2, face: -1 });
    y += BAY_D;
    // Another pair needs the strip, a row, and a lane in front of that row.
    if (y + STRIP + BAY_D + LANE > b1) break;
    strips.push(y + STRIP / 2);
    y += STRIP;
    rows.push({ c: y + BAY_D / 2, face: 1 });
    y += BAY_D + LANE;
  }
  return { alongX, rows, strips, bays };
}

// --- what it is made of --------------------------------------------------------

// The shell's materials, swapped for a car park's. Read by the shell and by the
// stair builder through `garageKey`, so a building pass asks for `wall` and gets
// concrete on this floor without knowing why.
const GARAGE_MATERIAL = {
  wall: 'concreteWall',
  carpet: 'concrete',
  vinyl: 'asphalt',
  ceiling: 'soffit',
};

export function garageKey(layout, key) {
  return layout?.garage ? (GARAGE_MATERIAL[key] ?? key) : key;
}

// --- the ramp ----------------------------------------------------------------

const RAMP_T = 0.28;      // the slab's own thickness

/**
 * A flight as a concrete ramp: one sloped slab over the whole run, in place of
 * the treads and their nosing.
 *
 * Only the PICTURE changes. The treads are still the colliders (stairBoxes), and
 * that is deliberate: nav, the player's step test and both validators already
 * agree about them, and a sloped collider is a thing this engine has never had.
 * The slab is laid half a riser above the line through the tread nosings, so
 * wherever a foot is on a tread it is within a tenth of a metre of the concrete.
 */
export function rampGeometry(layout, plan) {
  const spec = rampSpec(layout, plan);
  const alongX = spec.alongX;
  const c0 = alongX ? layout.oz + plan.y0 * 0.5 : layout.ox + plan.x0 * 0.5;
  const c1 = alongX ? layout.oz + plan.y1 * 0.5 : layout.ox + plan.x1 * 0.5;
  const across = c1 - c0;

  const rise = RAMP_RUN * RAMP_SLOPE * spec.dir;
  const len = Math.hypot(RAMP_RUN, rise);
  const geo = new THREE.BoxGeometry(alongX ? len : across, RAMP_T, alongX ? across : len);

  // Tilt it about the across axis so it climbs `up` along the run.
  const angle = Math.atan2(rise, RAMP_RUN) * spec.up;
  if (alongX) geo.rotateZ(angle);
  else geo.rotateX(-angle);

  const mid = spec.foot + spec.up * RAMP_RUN / 2;
  // Half a riser toward the treads: they stand ABOVE the nosing line going up
  // and hang BELOW it going down, so the offset follows the flight's direction.
  const y = rise / 2 + spec.dir * RISER / 2 - RAMP_T / 2;
  const cMid = (c0 + c1) / 2;
  geo.translate(alongX ? mid : cMid, y, alongX ? cMid : mid);
  return geo;
}
