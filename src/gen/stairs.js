import { TILE, WALL_H, CEIL_H, DOOR, DOOR_CLEAR, worldX, worldZ } from './tiles.js';
import { STEP_EPS } from '../metrics.js';

// A staircase up a room's wall, and the storey it climbs to.
//
// Zero to two rooms a floor get one. The room above is the room below with its
// ceiling for a floor: the same footprint, its own walls standing over the walls
// downstairs, its own roof over that, and no way in or out except the hole its
// stairs come up through. Nothing else on the floor loses anything to it, because
// it is built on the roof rather than on a block in somebody's office.
//
// **A second storey is possible at all because a collider now has an underside.**
// Everything in this engine is a box from the floor up to a `top` — which is why
// the ceiling never had to be collided with and why the first version of this was a
// block in the corner of a room with a room on top. A slab at head height with no
// underside blocks the room beneath it. So colliders carry `base`, and the two
// tests that ask "is this in my way" ask about a body's height rather than its
// feet: see _moveHorizontal in player.js and addStatics in physics.js. Everything
// on the floorplan leaves `base` alone and behaves exactly as it always did.
//
// What is still 2.5D, and shapes the rest of this:
//
//  - Nav, sight and hearing are one tile grid per floor, and no grid can say
//    "walkable, but a storey up". The stairwell is out of the nav grid, so nobody
//    follows you and nothing spawns upstairs. That is not a place to hide from a
//    fight: there is nothing to shoot at from inside a sealed room, and `_flood` in
//    nav.js seeds from the nearest tile a body fits in, so a shot fired up there is
//    heard as if it came from the bottom of the stairs.
//  - The suspended ceiling and the storey's floor slab are both CUT over the
//    stairwell (`ceilingCut`), or the stairs would come up into a sheet of ceiling
//    tiles and the head of whoever was climbing them.
//
// This file is the PLANNING half and is free of Three.js like the rest of the
// floorplan, so `planStairs` runs inside generateLayout and the layout sweep sees
// the stairwell on every floor. `buildStairs` in gen/build.js draws it, and every
// number the two must agree on is exported from here — see FIRST_CONTACT_GAP in
// gen/locks.js for what one copied constant cost.

// A tread has to be a step rather than a wall, which is the player's own step
// tolerance and nothing else. Derived from it with a margin rather than written
// down: a riser that quietly exceeds STEP_EPS is not a slightly worse staircase,
// it is a wall with a whole storey stranded on top of it.
export const RISER = Math.min(0.2, STEP_EPS * 0.8);
const GOING = 0.3;                        // how deep one tread is, front to back

// The storey above stands on the structural deck, which is the top of the walls
// downstairs — that is the whole idea, so it is WALL_H and not a number of its own.
// Its own headroom is the same as the floor below's.
export const UPPER_Y = WALL_H;
export const UPPER_CEIL = UPPER_Y + CEIL_H;
const SLAB_T = UPPER_Y - CEIL_H;          // deck thickness: over the ceiling tiles
const WALL_T = 0.14;
const ROOF_T = 0.12;

export const TREADS = Math.round(UPPER_Y / RISER);
// The flight's run in whole tiles, because everything the generator reserves is
// tiles. Rounded up, so the treads always finish inside the stairwell.
export const FLIGHT_TILES = Math.ceil((TREADS * GOING) / TILE);

const DEPTH = 3;                          // tiles of stairwell across — 1.5 m
const ROOM_LEFT = 5;                      // tiles of floor the room downstairs keeps
// Tiles of room floor at the BOTTOM of the flight, the one thing a staircase cannot
// do without. Two things were getting it wrong at once and both ended with a storey
// nobody could reach: the stairwell was allowed to sit flush against the room's far
// wall with the flight climbing away from it, so the bottom step had plaster in
// front of it — and where it did not, the furnisher put a filing cabinet there,
// because the approach was ordinary room floor. So the planner proves the floor is
// there and `approachTiles` has the builder reserve it.
const APPROACH = 2;

// How many a floor gets. Zero is a perfectly good answer: a building where every
// floor has one is a building with a feature rather than a surprise.
const PER_FLOOR = [0, 2];

// Testing only: give a staircase to EVERY room that can hold one.
//
// One or two staircases a floor is the game, and it is also a miserable rate to
// test against — most floors have none, and the ones that do put the thing in one
// room out of two hundred. With this on, a single floor exercises the planner, the
// geometry, the storey's furnishing and the collision against every room shape the
// generator makes, which is how the flight-behind-a-filing-cabinet bug turned up.
//
// Off by default and it stays off in a shipped floor: nothing reads it, nothing
// sets it from a query string, and the only ways in are `dev.stairsEverywhere()` in
// the browser console and `--stairs-all` on either validator. It is deliberately a
// module flag rather than an argument to `planStairs`, so turning it on does not
// change one line of the generator's own signature.
let everyRoom = false;

export function setStairsEverywhere(on = true) { everyRoom = !!on; }
export function stairsEverywhere() { return everyRoom; }

/**
 * Picks the rooms that get one, and where in them the stairs run.
 *
 * Never the lift lobby and never the exit room — not because of the storey, which
 * costs the room nothing, but because the stairwell does take a strip of floor and
 * the spawn point and the exit pad both need theirs.
 *
 * The flight always hugs a wall for its whole length: a staircase in the middle of
 * a room is a stage, and an office does not have one. Which wall is whichever has
 * the room for it, tried in a shuffled order so a floor's stairs are not all
 * against their room's north wall.
 */
export function planStairs(tiles, W, H, rooms, spawnRoom, exitRoom, rng) {
  // `everyRoom` is the testing flag — see setStairsEverywhere. The lobby and the
  // exit room stay excluded even then: a storey costs the room below nothing, but
  // the stairwell does take a strip of its floor, and those two need theirs.
  const want = everyRoom ? rooms.length : rng.int(PER_FLOOR[0], PER_FLOOR[1]);
  if (want <= 0) return [];

  const pool = rooms.filter((r) => r !== spawnRoom && r !== exitRoom);
  rng.shuffle(pool);

  const out = [];
  for (const room of pool) {
    if (out.length >= want) break;
    const plan = fitStairwell(room, tiles, W, H, rng);
    if (plan) out.push(plan);
  }
  return out;
}

/** Every tile the stairwell covers, for the masks that have to keep off it. */
export function stripTiles(plan, W, into = []) {
  for (let ty = plan.y0; ty < plan.y1; ty++) {
    for (let tx = plan.x0; tx < plan.x1; tx++) into.push(ty * W + tx);
  }
  return into;
}

/**
 * The floor at the bottom of the flight, which stays ordinary room floor.
 *
 * Reserved from the furnisher but NOT taken out of the nav grid, unlike the
 * stairwell itself: this is where you stand to start climbing and where anybody
 * chasing you ends up, so it has to be walkable — it just must not have a desk on
 * it. Same rect the planner proved was inside the room, from one function, so the
 * proof and the reservation cannot come to different answers.
 */
export function approachTiles(plan, W, into = []) {
  const r = approachRect(plan);
  for (let ty = r.y0; ty < r.y1; ty++) {
    for (let tx = r.x0; tx < r.x1; tx++) into.push(ty * W + tx);
  }
  return into;
}

/**
 * Which tiles get no suspended ceiling and no floor slab over them.
 *
 * The stairwell, and only the stairwell. A ceiling across it would be a sheet of
 * tiles through the middle of the flight and through the head of anybody climbing
 * — the body is BODY_H tall and clears the ceiling from about the fifth tread up.
 * Returned as a mask rather than stamped into `tiles`, because these are perfectly
 * ordinary room tiles for every other purpose.
 */
export function ceilingCut(layout) {
  const cut = new Uint8Array(layout.W * layout.H);
  for (const plan of layout.stairs) {
    for (const i of stripTiles(plan, layout.W)) cut[i] = 1;
  }
  return cut;
}

/**
 * Every solid the stairs and the storey above are made of, in world space.
 *
 * One function, so the picture, the player's collision, the solver and the
 * validators cannot come to different conclusions about where a tread is. Each box
 * says what it is (`part`, which picks the material) and how it stands (`base` to
 * `y1`) — and a `base` above the floor is exactly what lets the storey exist
 * without taking the room underneath away.
 */
export function stairBoxes(layout, plan) {
  const room = plan.room;
  const alongX = plan.axis === 'x';
  const sx0 = worldX(layout, plan.x0), sx1 = worldX(layout, plan.x1);
  const sz0 = worldZ(layout, plan.y0), sz1 = worldZ(layout, plan.y1);

  const a0 = alongX ? sx0 : sz0, a1 = alongX ? sx1 : sz1;
  const c0 = alongX ? sz0 : sx0, c1 = alongX ? sz1 : sx1;

  // `plan.up` is the direction the flight climbs: the bottom tread is at that end.
  const foot = plan.up > 0 ? a0 : a1;

  const box = (part, x0, z0, x1, z1, base, y1) => ({
    part, base, y1,
    minX: Math.min(x0, x1), maxX: Math.max(x0, x1),
    minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1),
  });
  const acrossBox = (part, lo, hi, base, y1) => (alongX
    ? box(part, lo, c0, hi, c1, base, y1)
    : box(part, c0, lo, c1, hi, base, y1));

  const out = [];
  for (let i = 0; i < TREADS; i++) {
    out.push(acrossBox('tread',
      foot + plan.up * i * GOING, foot + plan.up * (i + 1) * GOING, 0, (i + 1) * RISER));
  }

  // The storey: a deck over the room's whole footprint with the stairwell left
  // out of it, a wall ring standing over the walls downstairs, and a roof.
  const f = upperFloor(layout, plan);
  for (const r of slabRects(f, { x0: sx0, x1: sx1, z0: sz0, z1: sz1 })) {
    out.push(box('deck', r.x0, r.z0, r.x1, r.z1, CEIL_H, UPPER_Y));
  }
  out.push(box('wall', f.minX - WALL_T, f.minZ - WALL_T, f.minX, f.maxZ + WALL_T, UPPER_Y, UPPER_CEIL));
  out.push(box('wall', f.maxX, f.minZ - WALL_T, f.maxX + WALL_T, f.maxZ + WALL_T, UPPER_Y, UPPER_CEIL));
  out.push(box('wall', f.minX, f.minZ - WALL_T, f.maxX, f.minZ, UPPER_Y, UPPER_CEIL));
  out.push(box('wall', f.minX, f.maxZ, f.maxX, f.maxZ + WALL_T, UPPER_Y, UPPER_CEIL));
  out.push(box('roof', f.minX - WALL_T, f.minZ - WALL_T, f.maxX + WALL_T, f.maxZ + WALL_T,
    UPPER_CEIL, UPPER_CEIL + ROOF_T));

  return out;
}

/** The storey's floor, which is the room below's footprint. */
export function upperFloor(layout, plan) {
  const room = plan.room;
  return {
    minX: worldX(layout, room.x0), maxX: worldX(layout, room.x1),
    minZ: worldZ(layout, room.y0), maxZ: worldZ(layout, room.y1),
  };
}

// The deck with the stairwell missing, as up to four rectangles. The hole is
// against one wall for its whole width, so this is never more than three of them in
// practice — but the general split is no harder to write than the special case and
// cannot be wrong for a stairwell that sits somewhere unexpected.
function slabRects(f, hole) {
  const out = [];
  const push = (x0, z0, x1, z1) => {
    if (x1 - x0 > 1e-6 && z1 - z0 > 1e-6) out.push({ x0, z0, x1, z1 });
  };
  push(f.minX, f.minZ, f.maxX, Math.max(f.minZ, hole.z0));            // before
  push(f.minX, Math.min(f.maxZ, hole.z1), f.maxX, f.maxZ);            // after
  const z0 = Math.max(f.minZ, hole.z0), z1 = Math.min(f.maxZ, hole.z1);
  push(f.minX, z0, Math.max(f.minX, hole.x0), z1);                    // left of it
  push(Math.min(f.maxX, hole.x1), z0, f.maxX, z1);                    // right of it
  return out;
}

// --- placement ---------------------------------------------------------------

/**
 * The four sides of a room, as the tile rect a stairwell along each would take.
 *
 * `axis` is the direction the flight RUNS, which is along the wall it backs onto: a
 * flight against the +x wall runs in z. Kept in one place because the rest of this
 * file only ever wants the rect and the axis.
 */
function sideRects(room) {
  return [
    { axis: 'x', x0: room.x0, x1: room.x1, y0: room.y1 - DEPTH, y1: room.y1, cross: room.y1 - room.y0 },
    { axis: 'z', x0: room.x0, x1: room.x0 + DEPTH, y0: room.y0, y1: room.y1, cross: room.x1 - room.x0 },
    { axis: 'x', x0: room.x0, x1: room.x1, y0: room.y0, y1: room.y0 + DEPTH, cross: room.y1 - room.y0 },
    { axis: 'z', x0: room.x1 - DEPTH, x1: room.x1, y0: room.y0, y1: room.y1, cross: room.x1 - room.x0 },
  ];
}

function fitStairwell(room, tiles, W, H, rng) {
  const zone = doorZone(room, tiles, W, H);
  const sides = sideRects(room);

  for (const s of rng.shuffle([0, 1, 2, 3])) {
    const side = sides[s];
    // The room below has to be left being a room rather than a stairwell.
    if (side.cross < DEPTH + ROOM_LEFT) continue;

    const along = side.axis === 'x' ? side.x1 - side.x0 : side.y1 - side.y0;
    if (along < FLIGHT_TILES) continue;

    const from = side.axis === 'x' ? side.x0 : side.y0;
    const starts = [];
    for (let i = 0; i <= along - FLIGHT_TILES; i++) starts.push(from + i);
    rng.shuffle(starts);

    for (const start of starts) {
      const rect = side.axis === 'x'
        ? { x0: start, x1: start + FLIGHT_TILES, y0: side.y0, y1: side.y1 }
        : { x0: side.x0, x1: side.x1, y0: start, y1: start + FLIGHT_TILES };
      if (hits(zone, W, rect)) continue;

      // Which end the flight climbs from is not a free choice: the bottom step
      // needs room floor in front of it, and at one end of the stairwell that
      // floor may be the room's own wall.
      for (const up of rng.shuffle([1, -1])) {
        const plan = { room, side: s, axis: side.axis, up, ...rect };
        if (approachInside(room, plan)) return plan;
      }
    }
  }
  return null;
}

// Is the floor at the bottom of the flight the room's floor, rather than its wall?
// Measured against the room's interior, which is what `approachTiles` hands the
// builder to reserve.
function approachInside(room, plan) {
  const r = approachRect(plan);
  return r.x0 >= room.x0 && r.x1 <= room.x1 && r.y0 >= room.y0 && r.y1 <= room.y1;
}

function approachRect(plan) {
  if (plan.axis === 'x') {
    return plan.up > 0
      ? { x0: plan.x0 - APPROACH, x1: plan.x0, y0: plan.y0, y1: plan.y1 }
      : { x0: plan.x1, x1: plan.x1 + APPROACH, y0: plan.y0, y1: plan.y1 };
  }
  return plan.up > 0
    ? { x0: plan.x0, x1: plan.x1, y0: plan.y0 - APPROACH, y1: plan.y0 }
    : { x0: plan.x0, x1: plan.x1, y0: plan.y1, y1: plan.y1 + APPROACH };
}

/**
 * Tiles of the room a stairwell must not touch, because an opening is that close.
 *
 * The flight runs the length of a wall, so a doorway anywhere in that wall would be
 * bricked up by it — and one round the corner would be half blocked by the
 * stairwell's end. Both are the same test at DOOR_CLEAR tiles, which is the same
 * clearance the furnisher keeps (gen/tiles.js), and it is measured against the
 * finished floorplan rather than against `room.doors`: a room only lists the doors
 * it CUT, and the one its neighbour cut into it is in the wall all the same. See
 * cutDoor in gen/layout.js.
 */
function doorZone(room, tiles, W, H) {
  const zone = new Uint8Array(W * H);

  for (let ty = room.y0 - 1; ty <= room.y1; ty++) {
    for (let tx = room.x0 - 1; tx <= room.x1; tx++) {
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      if (tiles[ty * W + tx] !== DOOR) continue;
      for (let dy = -DOOR_CLEAR; dy <= DOOR_CLEAR; dy++) {
        for (let dx = -DOOR_CLEAR; dx <= DOOR_CLEAR; dx++) {
          const nx = tx + dx, ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          zone[ny * W + nx] = 1;
        }
      }
    }
  }
  return zone;
}

function hits(zone, W, rect) {
  for (let ty = rect.y0; ty < rect.y1; ty++) {
    for (let tx = rect.x0; tx < rect.x1; tx++) if (zone[ty * W + tx]) return true;
  }
  return false;
}
