import { TILE, CEIL_H, DOOR, DOOR_CLEAR, worldX, worldZ } from './tiles.js';
import { STEP_EPS } from '../metrics.js';

// A flight of stairs up a room's wall, and the room it arrives in.
//
// The loft is a room in the building that is not on the floorplan: a box up under
// a raised ceiling with no door, no corridor and no second way out — you climb the
// stairs or you never see inside it. So it is worth putting something in, and what
// it gets is the stock nobody could be bothered to carry back down.
//
// Everything about how it is built falls out of the engine being 2.5D, and it is
// worth stating plainly because it is what shapes the thing:
//
//  - A collider is a pillar from the floor up to a `top`, with no underside. So a
//    loft's floor makes the space BENEATH it solid, and a loft is not a mezzanine
//    you can walk under — it is a block standing in the room with a room on top.
//    That is a real building: the mezzanine store bolted into the corner of a
//    warehouse, stairs up the side.
//  - The suspended ceiling is at 3.0 m, which is under the loft's own floor, so
//    the ceiling is CUT over the whole strip and the volume runs up to the loft's
//    own lid instead. `ceilingCut` is what tells the shell that.
//  - Nav, sight and hearing are one tile grid per floor, and no grid can say
//    "walkable, but two metres up". The strip is out of the nav grid entirely, so
//    nobody follows you up — which does not make the loft a place to hide from a
//    fight, because there is nothing to shoot at from inside a sealed box, and
//    `_flood` in nav.js seeds from the nearest tile a body fits in, so a shot
//    fired up there is heard as if it came from the bottom of the stairs.
//
// This file is the PLANNING half and is free of Three.js like the rest of the
// floorplan, so `planStairs` can run inside generateLayout and the layout sweep
// sees the strip on every floor. `buildStairs` in gen/build.js draws it, and every
// number the two halves must agree on is exported from here — see
// FIRST_CONTACT_GAP in gen/locks.js for what one copied constant cost.

// A tread has to be a step rather than a wall, which is the player's own step
// tolerance and nothing else. Derived from it with a margin rather than written
// down, because a riser that quietly exceeds STEP_EPS is not a slightly worse
// staircase, it is a wall with a room stranded on top of it.
export const RISER = Math.min(0.2, STEP_EPS * 0.8);
const GOING = 0.3;                     // how deep one tread is, front to back

export const LOFT_Y = 2.2;             // the loft's floor
const INNER_H = 2.2;                   // ...and the headroom above it
export const TOP_Y = LOFT_Y + INNER_H; // its lid, well over the building's own
const WALL_T = 0.12;
const LID_T = 0.08;

export const TREADS = Math.round(LOFT_Y / RISER);
// The flight's run in whole tiles, because everything the generator reserves is
// tiles. Rounded up, so the treads always finish inside the strip.
export const FLIGHT_TILES = Math.ceil((TREADS * GOING) / TILE);

const DEPTH = 4;                       // tiles of strip against the wall — 2 m
const LOFT_TILES = [5, 9];             // ...and how much loft past the top tread
const ROOM_LEFT = 5;                   // tiles of ordinary floor the room keeps
// Tiles of room floor at the BOTTOM of the flight, which is the one thing a
// staircase cannot do without. Two things were getting it wrong at once and both
// ended the same way, with a loft nobody could reach: the strip was allowed to sit
// flush against the room's far wall with the flight climbing away from it, so the
// bottom step had plaster in front of it — and where it wasn't, the furnisher put
// a filing cabinet there, because the approach was ordinary room floor. So the
// planner proves the floor exists and `approachTiles` has the builder reserve it.
const APPROACH = 2;

// How many a floor gets. Zero is a perfectly good answer: a building where every
// floor has one is a building with a feature rather than a surprise.
const PER_FLOOR = [0, 2];

/**
 * Picks the rooms that get one, and where in them it goes.
 *
 * Never the lift lobby and never the exit room: the spawn point and the exit pad
 * are both authored at y = 0, and a loft's block standing on either would bury it.
 *
 * The strip always hugs a wall for its whole length — a flight in the middle of a
 * room is a stage, and an office does not have one. Which wall is whichever has
 * the room for it, tried in a shuffled order so a floor's stairs are not all
 * against their room's north wall.
 */
export function planStairs(tiles, W, H, rooms, spawnRoom, exitRoom, rng) {
  const want = rng.int(PER_FLOOR[0], PER_FLOOR[1]);
  if (want <= 0) return [];

  const pool = rooms.filter((r) => r !== spawnRoom && r !== exitRoom);
  rng.shuffle(pool);

  const out = [];
  for (const room of pool) {
    if (out.length >= want) break;
    const plan = fitStrip(room, tiles, W, H, rng);
    if (plan) out.push(plan);
  }
  return out;
}

/** Every tile a strip covers, for the masks that have to keep off it. */
export function stripTiles(plan, W, into = []) {
  for (let ty = plan.y0; ty < plan.y1; ty++) {
    for (let tx = plan.x0; tx < plan.x1; tx++) into.push(ty * W + tx);
  }
  return into;
}

/**
 * The floor at the bottom of the flight, which stays ordinary room floor.
 *
 * It is reserved from the furnisher but NOT taken out of the nav grid, unlike the
 * strip itself: this is where you stand to start climbing and where anybody
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

function approachRect(plan) {
  const alongX = plan.axis === 'x';
  if (alongX) {
    return plan.up > 0
      ? { x0: plan.x0 - APPROACH, x1: plan.x0, y0: plan.y0, y1: plan.y1 }
      : { x0: plan.x1, x1: plan.x1 + APPROACH, y0: plan.y0, y1: plan.y1 };
  }
  return plan.up > 0
    ? { x0: plan.x0, x1: plan.x1, y0: plan.y0 - APPROACH, y1: plan.y0 }
    : { x0: plan.x0, x1: plan.x1, y0: plan.y1, y1: plan.y1 + APPROACH };
}

/**
 * Which tiles the suspended ceiling must not be drawn over.
 *
 * A loft's floor is at 2.2 m and its lid at 4.4, both above the 3.0 m ceiling, so
 * a ceiling over the strip would be a sheet of tiles through the middle of it —
 * and the head of anybody on the top tread. Returned as a mask rather than
 * stamped into `tiles`, because these are still perfectly ordinary room tiles for
 * every other purpose.
 */
export function ceilingCut(layout) {
  const cut = new Uint8Array(layout.W * layout.H);
  for (const plan of layout.stairs) {
    for (const i of stripTiles(plan, layout.W)) cut[i] = 1;
  }
  return cut;
}

/**
 * Every solid the stair and its loft are made of, in world space.
 *
 * One function so the picture, the player's collision and the solver cannot
 * disagree about where a tread is. Each box carries what it is (`part`, which
 * picks the material), how tall it stands, and whether it COLLIDES — and that
 * last one is the whole 2.5D constraint in one flag. A collider here is a pillar
 * from the floor, so only the boxes with solid ground all the way down may be
 * one: the treads, the loft's block, and the loft's own walls, which stand on it.
 * The walls closing the void above the FLIGHT have open air beneath them, so they
 * are drawn and not collided — a collider there would brick up the stairs.
 */
export function stairBoxes(layout, plan) {
  const alongX = plan.axis === 'x';
  const sx0 = worldX(layout, plan.x0), sx1 = worldX(layout, plan.x1);
  const sz0 = worldZ(layout, plan.y0), sz1 = worldZ(layout, plan.y1);

  const a0 = alongX ? sx0 : sz0, a1 = alongX ? sx1 : sz1;
  const c0 = alongX ? sz0 : sx0, c1 = alongX ? sz1 : sx1;

  // `plan.up` is the direction the flight climbs along the axis: the bottom tread
  // is at that end, the loft fills what is left.
  const foot = plan.up > 0 ? a0 : a1;
  const far = plan.up > 0 ? a1 : a0;
  const head = foot + plan.up * TREADS * GOING;

  // Which cross edge is the room's own wall — the other one faces the room and
  // has to be closed, or the loft is a shelf.
  const wallHigh = plan.side === 0 || plan.side === 3;
  const openEdge = wallHigh ? c0 : c1;                  // the room-facing side
  const inward = wallHigh ? 1 : -1;

  const box = (part, lo, hi, y0, y1, collide, cLo = c0, cHi = c1) => ({
    part,
    minX: alongX ? Math.min(lo, hi) : cLo, maxX: alongX ? Math.max(lo, hi) : cHi,
    minZ: alongX ? cLo : Math.min(lo, hi), maxZ: alongX ? cHi : Math.max(lo, hi),
    y0, y1, collide,
  });
  // A wall running the length of the strip, set into whichever cross edge.
  const sideWall = (part, lo, hi, y0, y1, collide, at) => box(
    part, lo, hi, y0, y1, collide,
    Math.min(at, at + inward * WALL_T), Math.max(at, at + inward * WALL_T));

  const out = [];
  for (let i = 0; i < TREADS; i++) {
    out.push(box('tread', foot + plan.up * i * GOING, foot + plan.up * (i + 1) * GOING,
      0, (i + 1) * RISER, true));
  }
  // The loft's floor is the top of a solid block, out to the reserved tile edge so
  // no sliver of room floor is left stranded behind it.
  out.push(box('block', head, far, 0, LOFT_Y, true));

  // The loft: three walls and a lid. The fourth side is the top of the stairs,
  // left open — it is the only way in and there is no door on it.
  out.push(sideWall('wall', head, far, LOFT_Y, TOP_Y, true, openEdge));
  out.push(box('wall', far, far - plan.up * WALL_T, LOFT_Y, TOP_Y, true));

  // ...and the same void closed above the FLIGHT, from the building's own ceiling
  // up to the lid. Nothing here may collide: the stairs are underneath it.
  out.push(sideWall('wall', foot, head, CEIL_H, TOP_Y, false, openEdge));
  out.push(box('wall', foot, foot + plan.up * WALL_T, CEIL_H, TOP_Y, false));
  // The room's wall is only 3.2 m tall, so the strip needs its own above that.
  out.push(sideWall('wall', a0, a1, CEIL_H, TOP_Y, false, wallHigh ? c1 : c0));

  out.push(box('lid', a0, a1, TOP_Y, TOP_Y + LID_T, false));

  return out;
}

/** The loft's own floor area, for whatever is going to be stacked on it. */
export function loftFloor(layout, plan) {
  const block = stairBoxes(layout, plan).find((b) => b.part === 'block');
  const inset = WALL_T + 0.02;
  return {
    minX: block.minX + inset, maxX: block.maxX - inset,
    minZ: block.minZ + inset, maxZ: block.maxZ - inset,
  };
}

// --- placement ---------------------------------------------------------------

/**
 * The four sides of a room, as the tile rect a strip along each would take.
 *
 * `axis` is the direction the strip RUNS, which is along the wall it backs onto: a
 * strip against the +x wall runs in z. Kept in one place because the rest of this
 * file only ever wants the rect and the axis, and `side` is what stairBoxes reads
 * to know which way is into the room.
 */
function sideRects(room) {
  return [
    { axis: 'x', x0: room.x0, x1: room.x1, y0: room.y1 - DEPTH, y1: room.y1, cross: room.y1 - room.y0 },
    { axis: 'z', x0: room.x0, x1: room.x0 + DEPTH, y0: room.y0, y1: room.y1, cross: room.x1 - room.x0 },
    { axis: 'x', x0: room.x0, x1: room.x1, y0: room.y0, y1: room.y0 + DEPTH, cross: room.y1 - room.y0 },
    { axis: 'z', x0: room.x1 - DEPTH, x1: room.x1, y0: room.y0, y1: room.y1, cross: room.x1 - room.x0 },
  ];
}

function fitStrip(room, tiles, W, H, rng) {
  const zone = doorZone(room, tiles, W, H);
  const sides = sideRects(room);

  for (const s of rng.shuffle([0, 1, 2, 3])) {
    const side = sides[s];
    // The room has to be left being a room rather than a landing.
    if (side.cross < DEPTH + ROOM_LEFT) continue;

    const along = side.axis === 'x' ? side.x1 - side.x0 : side.y1 - side.y0;
    const len = FLIGHT_TILES + rng.int(LOFT_TILES[0], LOFT_TILES[1]);
    if (along < len) continue;

    const from = side.axis === 'x' ? side.x0 : side.y0;
    const starts = [];
    for (let i = 0; i <= along - len; i++) starts.push(from + i);
    rng.shuffle(starts);

    for (const start of starts) {
      const rect = side.axis === 'x'
        ? { x0: start, x1: start + len, y0: side.y0, y1: side.y1 }
        : { x0: side.x0, x1: side.x1, y0: start, y1: start + len };
      if (hits(zone, W, rect)) continue;

      // Which end the flight climbs from is not a free choice: the bottom step
      // needs room floor in front of it, and at one end of the strip that floor
      // may be the room's own wall.
      for (const up of rng.shuffle([1, -1])) {
        const plan = { room, side: s, axis: side.axis, up, ...rect };
        if (!approachInside(room, plan)) continue;
        return plan;
      }
    }
  }
  return null;
}

// Is the floor at the bottom of the flight actually the room's floor, rather than
// the room's wall? Measured against the room's interior, which is what `approachTiles`
// will hand the builder to reserve.
function approachInside(room, plan) {
  const r = approachRect(plan);
  return r.x0 >= room.x0 && r.x1 <= room.x1 && r.y0 >= room.y0 && r.y1 <= room.y1;
}

/**
 * Tiles of the room a strip must not touch, because an opening is that close.
 *
 * A strip runs the length of a wall, so a doorway anywhere in that wall would be
 * bricked up by it — and one round the corner would be half blocked by the
 * strip's end. Both are the same test at DOOR_CLEAR tiles, which is the same
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
