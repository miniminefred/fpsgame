import { TILE, WALL_H, CEIL_H, DOOR, DOOR_CLEAR, worldX, worldZ } from './tiles.js';
import { STEP_EPS } from '../metrics.js';

// A staircase up or down a room's wall, and the sealed level it serves.
//
// A few rooms on every floor get one, and it goes either way: up to an **attic** or
// down to a **basement**. Either is the room below it with the floor plate between
// them — the same footprint, its own walls standing over the walls of that room, its
// own lid, and no way in or out but the stairwell. They are never connected to each
// other or to anything else: one room, one staircase, one way in.
//
// **They are possible at all because a collider has an underside.** Everything in
// this engine was a box from the floor up to a `top`, which is why the ceiling never
// had to be collided with — and why the first attempt at this was a plinth in the
// corner of a room with a room on top of it, since a slab at head height with no
// underside blocks the room beneath. So colliders carry `base`, the two tests that
// ask "is this in my way" ask about a body's height rather than its feet
// (`_moveHorizontal` in player.js, `addStatics` in physics.js), and the floor plate
// itself became geometry with a thickness rather than the assumption that y = 0 is
// where the building is. That last one is what makes a basement possible:
// `_supportHeight` no longer starts at zero, so there can be a room under the floor.
//
// What is still 2.5D, and shapes the rest of this:
//
//  - Nav, sight and hearing are one tile grid per floor, and no grid can say
//    "walkable, but a storey up". The stairwell leaves the nav grid, so nobody
//    follows you and nothing spawns off the ground floor. That is not a place to hide
//    from a fight: there is nothing to shoot at from inside a sealed room, and
//    `_flood` in nav.js seeds from the nearest tile a body fits in, so a shot fired
//    up or down there is heard as if it came from the foot of the stairs.
//  - Sight needed telling too — see STOREY_GAP in enemies.js.
//  - The surface a flight passes through is CUT over the stairwell
//    (`stairwellCut`): the suspended ceiling for an attic, the floor plate for a
//    basement.
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

// A level stands on the structural deck, which is the top of the walls downstairs —
// that is the whole idea, so it is WALL_H rather than a number of its own. An attic
// is one deck up and a basement is one deck down, and both get the same headroom as
// the floor between them, which falls out for free.
export const LEVEL_Y = WALL_H;
export const UPPER_Y = LEVEL_Y;           // the attic's floor
export const LOWER_Y = -LEVEL_Y;          // ...and the basement's
export const UPPER_CEIL = UPPER_Y + CEIL_H;
// The structural deck: the slab between a ceiling and the floor standing on it. Also
// the thickness of the building's own floor plate, whose underside is a basement's
// ceiling — so the basement's headroom is CEIL_H too.
export const PLATE_T = LEVEL_Y - CEIL_H;
const WALL_T = 0.14;
const ROOF_T = 0.12;

/** The floor a plan's level sits at: an attic above, a basement below. */
export const levelY = (plan) => (plan.dir > 0 ? UPPER_Y : LOWER_Y);

export const TREADS = Math.round(LEVEL_Y / RISER);
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
// ...and tiles of the LEVEL's floor beyond the head of it, for exactly the same reason
// one turn further up. A flight whose head is flush with the room's edge has no
// landing: the tile you arrive on has the wall on one side, so a body does not fit on
// it, nav erodes it away, and the level is unreachable even though the flight plainly
// reaches it. The nav sweep found it as "no route from a level back down" on four
// floors in five.
//
// TWO tiles, not one, and the second is not slack either: the erosion test reaches a
// tile past the one it is centred on, so a single landing row is disqualified by the
// wall behind it exactly as the head row was. That took the last 3% of levels from
// unreachable to reachable.
const LANDING = 2;

// How many a floor gets. A few, always — a staircase is part of what a floor of
// this building IS, not an event that sometimes happens on one, so zero is not an
// answer. It is a range rather than a number so that which rooms have one still
// tells one floor from another.
const PER_FLOOR = [2, 4];

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
  const want = rng.int(PER_FLOOR[0], PER_FLOOR[1]);

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
 * The middle of that floor, in world space — where the stairs start.
 *
 * This is where the rest of the building thinks you are while you are up in an attic
 * or down in a basement: the nav grid is one grid for the ground floor and cannot
 * hold a second level, so the honest answer to "how do I get to the player" is "to
 * the foot of their stairs". See `update` in enemies.js.
 */
export function approachSpot(layout, plan) {
  const r = approachRect(plan);
  return {
    x: worldX(layout, (r.x0 + r.x1) / 2),
    z: worldZ(layout, (r.y0 + r.y1) / 2),
  };
}

/** The staircase whose level a point is standing on, or null for the ground floor. */
export function planAt(layout, x, z, feetY) {
  if (Math.abs(feetY) < LEVEL_Y * 0.5) return null;
  const dir = feetY > 0 ? 1 : -1;
  const tx = Math.round((x - layout.ox) / TILE - 0.5);
  const ty = Math.round((z - layout.oz) / TILE - 0.5);
  for (const plan of layout.stairs) {
    if (plan.dir !== dir) continue;
    const r = plan.room;
    if (tx >= r.x0 && tx < r.x1 && ty >= r.y0 && ty < r.y1) return plan;
  }
  return null;
}

/**
 * Which tiles a stairwell leaves nothing overhead or underfoot.
 *
 * A ceiling across the top of an attic flight would be a sheet of tiles through the
 * middle of it and through the head of whoever was climbing — the body is BODY_H
 * tall and clears the 3 m ceiling from about the fifth tread up. A basement flight
 * has the same problem the other way round: the building's floor plate would be a
 * lid over it. Both are the same tiles, and which surface gets the hole is which way
 * the stairs go.
 *
 * Returned as a mask rather than stamped into `tiles`, because these are perfectly
 * ordinary room tiles for every other purpose.
 */
export function stairwellCut(layout, dir) {
  const cut = new Uint8Array(layout.W * layout.H);
  for (const plan of layout.stairs) {
    if (plan.dir !== dir) continue;
    for (const i of stripTiles(plan, layout.W)) cut[i] = 1;
  }
  return cut;
}

/**
 * Every solid the stairs and the level they serve are made of, in world space.
 *
 * One function, so the picture, the player's collision, the solver and the
 * validators cannot come to different conclusions about where a tread is. Each box
 * says what it is (`part`, which picks the material) and how it stands (`base` to
 * `y1`).
 *
 * An attic and a basement are the same construction reflected in the floor plate,
 * and the reflection is honest rather than cosmetic: an attic's walls stand from its
 * own floor up to its own ceiling, a basement's stand from its floor up to the plate
 * it hangs under, and in both cases the flight is a solid wedge of treads with the
 * level's slab as its last step.
 */
export function stairBoxes(layout, plan) {
  const alongX = plan.axis === 'x';
  const sx0 = worldX(layout, plan.x0), sx1 = worldX(layout, plan.x1);
  const sz0 = worldZ(layout, plan.y0), sz1 = worldZ(layout, plan.y1);

  const a0 = alongX ? sx0 : sz0, a1 = alongX ? sx1 : sz1;
  const c0 = alongX ? sz0 : sx0, c1 = alongX ? sz1 : sx1;

  // `plan.up` is the direction the flight RUNS along its wall; `plan.dir` is whether
  // it goes up or down. The first tread is at the running end either way.
  const foot = plan.up > 0 ? a0 : a1;
  const y = levelY(plan);
  const down = plan.dir < 0;

  const box = (part, x0, z0, x1, z1, base, y1) => ({
    part, base: Math.min(base, y1), y1: Math.max(base, y1),
    minX: Math.min(x0, x1), maxX: Math.max(x0, x1),
    minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1),
  });
  const acrossBox = (part, lo, hi, base, y1) => (alongX
    ? box(part, lo, c0, hi, c1, base, y1)
    : box(part, c0, lo, c1, hi, base, y1));

  const out = [];
  // Treads. Going up, each is a solid step from the floor to its own top and the last
  // one lands on the deck. Going down, each hangs from the plate to its own top and
  // the last step of all is the basement's slab — so there is one fewer of them, and
  // the lowest is exactly one riser above the floor.
  const steps = down ? TREADS - 1 : TREADS;
  for (let i = 0; i < steps; i++) {
    const top = down ? -(i + 1) * RISER : (i + 1) * RISER;
    out.push(acrossBox('tread',
      foot + plan.up * i * GOING, foot + plan.up * (i + 1) * GOING, down ? y : 0, top));
  }

  // The level: its floor over the room's whole footprint, a wall ring standing over
  // the walls of the room it belongs to, and a lid over that.
  const f = levelFloor(layout, plan);
  const well = { x0: sx0, z0: sz0, x1: sx1, z1: sz1 };
  const wallTop = down ? 0 : UPPER_CEIL;
  // Which surface the stairwell is a hole in depends entirely on which way the stairs
  // go, and getting it the wrong way round is a hole you fall through. An attic's
  // floor is punched, because the flight comes UP through it. A basement's floor is
  // solid — the flight comes down and LANDS on it; what gets punched down there is
  // the lid. Both were punched to begin with, and the last half metre of every
  // basement flight was a step off the bottom tread into nothing.
  const floorRects = down ? [rectOf(f)] : punchRects([rectOf(f)], well);
  for (const r of floorRects) {
    out.push(box('deck', r.x0, r.z0, r.x1, r.z1, y - PLATE_T, y));
  }
  out.push(box('wall', f.minX - WALL_T, f.minZ - WALL_T, f.minX, f.maxZ + WALL_T, y, wallTop));
  out.push(box('wall', f.maxX, f.minZ - WALL_T, f.maxX + WALL_T, f.maxZ + WALL_T, y, wallTop));
  out.push(box('wall', f.minX, f.minZ - WALL_T, f.maxX, f.minZ, y, wallTop));
  out.push(box('wall', f.minX, f.maxZ, f.maxX, f.maxZ + WALL_T, y, wallTop));

  if (down) {
    // A basement's lid is the underside of the building's own floor plate, which is
    // drawn from above and so is not there at all from below. It gets one of its own,
    // with the stairwell left out so the flight comes through.
    for (const r of punchRects([rectOf(f)], well)) {
      out.push(box('lid', r.x0, r.z0, r.x1, r.z1, -PLATE_T - ROOF_T, -PLATE_T));
    }
  } else {
    out.push(box('roof', f.minX - WALL_T, f.minZ - WALL_T, f.maxX + WALL_T, f.maxZ + WALL_T,
      UPPER_CEIL, UPPER_CEIL + ROOF_T));
  }

  return out;
}

// The flight's slope, and how far it runs. Exported because the nav grid needs both:
// it samples the ramp for a body's height, and it has to know the most a step can
// rise so that walking ACROSS a flight is refused while walking UP one is not.
export const RAMP_SLOPE = RISER / GOING;
export const RAMP_RUN = TREADS * GOING;
// The most the walking surface may rise between two neighbouring tiles. On a flight
// that is the slope over a tile; anywhere else it is a cliff, and the cliff that
// matters is the edge of a landing where somebody could otherwise step sideways off
// it into the middle of the shaft. Derived, so retuning the stairs cannot leave nav
// believing in a staircase the building does not have.
export const MAX_TILE_RISE = TILE * RAMP_SLOPE;

/** What a flight is, for anybody who needs to sample its height themselves. */
export function rampSpec(layout, plan) {
  const alongX = plan.axis === 'x';
  const a0 = alongX ? worldX(layout, plan.x0) : worldZ(layout, plan.y0);
  const a1 = alongX ? worldX(layout, plan.x1) : worldZ(layout, plan.y1);
  return {
    alongX,
    foot: plan.up > 0 ? a0 : a1,
    up: plan.up,
    dir: plan.dir,
  };
}

/** The height of a flight at a point, from its spec. Continuous, not per tile. */
export function rampHeight(spec, x, z) {
  const along = ((spec.alongX ? x : z) - spec.foot) * spec.up;
  return spec.dir * Math.max(0, Math.min(RAMP_RUN, along)) * RAMP_SLOPE;
}

/**
 * How high the flight is at a point inside its stairwell.
 *
 * A flight is one ramp: the height depends on how far along it you are and on
 * nothing else — not on whether you are on your way up or down, and not on which
 * nav layer you happen to be on. That is what makes crossing between levels
 * invisible, and it is why this is the same function for a body and for the tread
 * boxes it walks on.
 */
export function stairHeightAt(layout, plan, x, z) {
  return rampHeight(rampSpec(layout, plan), x, z);
}

/** A level's floor, which is the footprint of the room its stairs are in. */
export function levelFloor(layout, plan) {
  const room = plan.room;
  return {
    minX: worldX(layout, room.x0), maxX: worldX(layout, room.x1),
    minZ: worldZ(layout, room.y0), maxZ: worldZ(layout, room.y1),
  };
}

/**
 * Rectangles with a hole taken out of them, as up to four each.
 *
 * Used for a level's slab, for its lid, and for the building's own floor plate,
 * which is the same problem three times: a rectangle of floor that a stairwell has
 * to pass through. Kept general because the special case — a hole against one wall
 * for its whole width — is no easier to write and would be wrong the first time a
 * stairwell sat somewhere unexpected.
 */
export function punchRects(rects, hole) {
  const out = [];
  const push = (x0, z0, x1, z1) => {
    if (x1 - x0 > 1e-6 && z1 - z0 > 1e-6) out.push({ x0, z0, x1, z1 });
  };

  for (const { x0, z0, x1, z1 } of rects) {
    // No overlap at all: the rectangle survives whole.
    if (hole.x1 <= x0 || hole.x0 >= x1 || hole.z1 <= z0 || hole.z0 >= z1) {
      push(x0, z0, x1, z1);
      continue;
    }
    push(x0, z0, x1, Math.max(z0, hole.z0));                  // before it
    push(x0, Math.min(z1, hole.z1), x1, z1);                  // after it
    const hz0 = Math.max(z0, hole.z0), hz1 = Math.min(z1, hole.z1);
    push(x0, hz0, Math.max(x0, hole.x0), hz1);                // left of it
    push(Math.min(x1, hole.x1), hz0, x1, hz1);                // right of it
  }
  return out;
}

/** A rect in the {x0,z0,x1,z1} shape punchRects speaks, from a world AABB. */
export const rectOf = (b) => ({ x0: b.minX, z0: b.minZ, x1: b.maxX, z1: b.maxZ });

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
    // A flight needs its run, floor at the bottom to walk at it from, and a landing at
    // the top to step off onto.
    if (along < FLIGHT_TILES + APPROACH + LANDING) continue;

    const from = side.axis === 'x' ? side.x0 : side.y0;
    // Which way it climbs is chosen FIRST, because it decides which end of the
    // stairwell owes the room two tiles and which owes it one.
    for (const up of rng.shuffle([1, -1])) {
      const lead = up > 0 ? APPROACH : LANDING;   // clearance before the low index
      const tail = up > 0 ? LANDING : APPROACH;   // ...and after the high one
      const starts = [];
      for (let i = lead; i <= along - FLIGHT_TILES - tail; i++) starts.push(from + i);
      rng.shuffle(starts);

      for (const start of starts) {
        const rect = side.axis === 'x'
          ? { x0: start, x1: start + FLIGHT_TILES, y0: side.y0, y1: side.y1 }
          : { x0: side.x0, x1: side.x1, y0: start, y1: start + FLIGHT_TILES };
        if (hits(zone, W, rect)) continue;

        // `dir` is up to the attic or down to the basement, and it is an even coin:
        // the two are the same construction reflected in the floor plate, and a
        // building where every staircase went the same way would read as a rule.
        const plan = { room, side: s, axis: side.axis, up, dir: rng.chance(0.5) ? 1 : -1, ...rect };
        // Belt and braces: the start range above is derived from the same two
        // constants, so this can only fail if one of them is edited and the other
        // is not.
        if (approachInside(room, plan) && landingInside(room, plan)) return plan;
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

// The same question at the head of the flight, where the level's own floor has to
// carry the landing.
function landingInside(room, plan) {
  const r = landingRect(plan);
  return r.x0 >= room.x0 && r.x1 <= room.x1 && r.y0 >= room.y0 && r.y1 <= room.y1;
}

function landingRect(plan) {
  if (plan.axis === 'x') {
    return plan.up > 0
      ? { x0: plan.x1, x1: plan.x1 + LANDING, y0: plan.y0, y1: plan.y1 }
      : { x0: plan.x0 - LANDING, x1: plan.x0, y0: plan.y0, y1: plan.y1 };
  }
  return plan.up > 0
    ? { x0: plan.x0, x1: plan.x1, y0: plan.y1, y1: plan.y1 + LANDING }
    : { x0: plan.x0, x1: plan.x1, y0: plan.y0 - LANDING, y1: plan.y0 };
}

export function approachRect(plan) {
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
