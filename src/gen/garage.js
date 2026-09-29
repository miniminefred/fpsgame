// A floor of the building that is a car park.
//
// One floor in ten comes out of the lift into concrete instead of carpet: the
// whole floor is one parking deck with rows of cars in painted bays and pillars
// down the middle, the corridors are asphalt lanes, and the attics and basements the stairs
// already reach (gen/stairs.js) are split-level decks of their own, reached up a
// concrete ramp and parked full of more cars.
//
// It is planned as an office floor and then KNOCKED THROUGH (`openGarage`): the
// corridor spine, the BSP and the lift lobby are planned exactly as on any other
// floor, which is what keeps it connected and gives it its lanes and its column
// grid, and then every partition and every door but the lobby's comes down. So
// the whole floor is the car park — one open deck, lanes where the corridors
// were, parking bays in what were rooms — and there is nothing left to lock:
// no keycard rooms, no manager, no broom closet. The roster copes with all three
// being absent, because each of them was always opportunistic.

import * as THREE from 'three';
import { makeRng } from './rng.js';
import { tryPlace } from './props.js';
import { RAMP_RUN, RAMP_SLOPE, RISER, rampSpec } from './stairs.js';
import { CORRIDOR, ROOM, SOLID } from './tiles.js';
import { doorsOnRoom } from './locks.js';

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

/**
 * Knocks the floor through. Every wall tile standing between two open tiles —
 * open on both sides across one axis — is a partition, and it comes down; so
 * does every door but the lobby's. What stays is what stands alone: the
 * building's own outside wall (open on one side only), the lobby's ring round
 * the lifts, and every tile where two partitions CROSSED, which has wall on all
 * four sides and so is left standing as a 0.5 m column. A car park has columns
 * on a grid, and the BSP's own crossings are that grid.
 *
 * Tested against the tiles as they were, so knocking one wall down cannot make
 * its neighbour look like a partition. Opening only ever adds floor, so the
 * connectivity proved before this still holds after it.
 */
export function openGarage(tiles, W, H, rooms, doors, lobby) {
  const before = Uint8Array.from(tiles);
  const open = (x, y) => x >= 0 && y >= 0 && x < W && y < H && before[y * W + x] !== SOLID;
  const ring = (x, y) => x >= lobby.x0 - 1 && x <= lobby.x1 && y >= lobby.y0 - 1 && y <= lobby.y1;

  // The doors first, as the floor either side of them: a hall door stood in a
  // corridor and becomes lane, a room's stood in a wall and becomes deck.
  const keep = new Set(doorsOnRoom(doors, lobby));
  for (let i = doors.length - 1; i >= 0; i--) {
    const d = doors[i];
    if (keep.has(d)) continue;
    for (let y = d.y0; y < d.y1; y++) {
      for (let x = d.x0; x < d.x1; x++) tiles[y * W + x] = d.hall ? CORRIDOR : ROOM;
    }
    doors.splice(i, 1);
  }
  for (const r of rooms) r.doors = r.doors.filter((d) => keep.has(d));

  // ...and the wall either side of the lobby's own doorway, for as far as its
  // leaves slide. A double door retracts into the wall beside its opening
  // (`slidePocketRun`), and the lobby's ring can end before the pocket does —
  // the wall used to carry on into the office next door. Knocked through, one
  // lobby in seven had a door with nowhere to put its leaves.
  const pocket = new Uint8Array(W * H);
  for (const d of keep) {
    const reach = Math.max(d.x1 - d.x0, d.y1 - d.y0) + 2;
    for (let y = d.y0 - reach; y < d.y1 + reach; y++) {
      for (let x = d.x0 - reach; x < d.x1 + reach; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        // Along the door's own wall line only.
        if (d.vertical ? (x >= d.x0 && x < d.x1) : (y >= d.y0 && y < d.y1)) pocket[y * W + x] = 1;
      }
    }
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (before[y * W + x] !== SOLID || ring(x, y) || pocket[y * W + x]) continue;
      if ((open(x - 1, y) && open(x + 1, y)) || (open(x, y - 1) && open(x, y + 1))) {
        tiles[y * W + x] = ROOM;
      }
    }
  }
}

/** Every room a parking deck, and the lobby the lobby. No dice. */
export function parkingRoles(rooms, lobby) {
  for (const r of rooms) { r.role = 'parking'; r.forcedRole = true; }
  lobby.role = 'exit';
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
  // Too shallow for a row and its lane either way, and it stays open concrete.
  // It used to fall back to cars along the walls, which is right for a room with
  // walls and wrong on an open deck: a room this shallow is a PASSAGE between two
  // parts of the floor, and one 4.5 m car across a 5.5 m gap shut it — sixteen
  // floors in three hundred had a bay of the deck nobody could get into.
  if (!plan.rows.length || !plan.bays) return;
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

  const [, , , bEnd] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  for (const row of rows) {
    // Snapping rounds DOWN, which near the room's first edge pushes the row out
    // of the room and half a metre into the lane beyond it. Walked back in.
    let b = snapB(row.c + 0.25);
    while (b - BAY_D / 2 < b0 - 1e-6) b += 0.5;
    while (b + BAY_D / 2 > bEnd + 1e-6) b -= 0.5;
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
