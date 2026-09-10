// Cutting a slab into corridors, rooms and doorways.
//
// Real office floors are not mazes — they are a corridor spine with rooms packed
// against it — so this generates in that order: carve the spine (guaranteed to
// intersect, so the network is connected by construction), BSP-subdivide each
// leftover block into rooms, and cut a doorway from each room onto whatever it
// touches. Then the doors ACROSS the corridors, which are the exception to
// almost everything the room doorways do.
//
// Everything here is tile arithmetic on the vocabulary in gen/tiles.js. Nothing
// in it knows what a room is FOR — that is gen/roles.js — and nothing in it
// knows about locks, stairs or lifts, all of which run against the finished
// carve. gen/layout.js is the order the three of them run in.

import { bfs, CORRIDOR, DOOR, ROOM, SOLID } from './tiles.js';

// PAD, CORRIDOR_W and DOOR_W are exported because tools/validate-layout.mjs
// checks against them, and a validator holding its own copy of the number it is
// checking is the FIRST_CONTACT_GAP failure exactly: the sweep stops testing the
// generator and starts asserting its own arithmetic back at it.
export const PAD = 2;              // solid tiles of exterior wall on each side

export const CORRIDOR_W = 6;       // 3 m corridors

export const MIN_LEAF = 10;               // smallest room block (=> 4.5 m interior)

const MAX_LEAF = 26;               // above this a block always splits again

/**
 * How much of a floor's room area is OPEN FLOOR, and how big one of them gets.
 *
 * An office building is mostly open plan with the cellular offices round the
 * edge of it, and this generator was the other way round: `MAX_LEAF` caps a BSP
 * leaf at 26 tiles a side, so the biggest room a floor could ever have was
 * 13 x 13 m, the median room was 37 m², and 2.5% of rooms came out on the `big`
 * branch at all. Every floor was a warren of small rooms with the occasional
 * slightly larger small room, and "open plan" was a label on a 9 x 8 m office.
 *
 * So a share of each floor's room area is claimed for open floor BEFORE the
 * subdivision reaches it, and a block that qualifies stops splitting whole.
 * Measured against the area the BSP has to hand out rather than against the
 * slab, because corridors and structural core are not somebody's office.
 *
 * The cap is what keeps it an office rather than a warehouse: a block between
 * two corridors can be sixty tiles across on a deep floor, and a 30 x 30 m room
 * with no interior wall in it is a distribution centre. It is a good deal wider
 * than MAX_LEAF even so — the whole point is that the biggest thing on the floor
 * is somewhere people work rather than somewhere they store things.
 */
export const OPEN_SHARE = 0.4;

const OPEN_LEAF = 44;              // tiles a side — 22 m

const OPEN_MIN = 20;               // ...and 10 m, under which it is just a room
// How often a qualifying block is taken rather than split again. It is what
// SPREADS the open floors: the budget alone would hand the first blocks the BSP
// walks the whole share, and the blocks are walked in a fixed order across the
// slab, so every open floor on the floor would be in one corner of it.
const OPEN_TAKE = 0.8;

export const DOOR_W = 3;           // 1.5 m doorways
// Minimum solid wall left between two openings. Without this, two rooms either
// side of a shared wall each cut their own doorway and the second lands flush
// against the first, merging them into one 3 m hole with a loose doorpost
// floating in the middle of it.
const DOOR_GAP = 2;

// Doors across the corridors themselves — see cutHallDoors. A range per corridor
// rather than a count per floor, because what they are for is breaking up the
// long ones; the short spurs can go without.
const HALL_DOORS = [0, 2];

const HALL_END = 10;               // tiles clear of where a corridor stops

const HALL_APART = 26;             // tiles between two doors on the same corridor

// --- how big this one is ----------------------------------------------------
// The curve in floorSpans is the TYPICAL floor for a depth; every floor then
// rolls its own size around it, so eight is not simply seven with more walking.
// Two dice, because they answer different questions: `scale` is how much
// building there is, `skew` is what shape it is — above 1 wide and shallow,
// below 1 deep and narrow. Skew multiplies one axis and divides the other, so
// changing a floor's shape does not also change how much of it there is.
//
// The point is pacing. A small floor is a tight, quick clear and a big one is a
// hike, and not knowing which you are stepping out of the lift into is worth
// more than either. The range is wide on purpose: within a few percent of the
// depth's size every floor reads as the same floor.

// `count` positions inside [min,max] that are at least `sep` apart.
export function pickLines(rng, min, max, count, sep) {
  const lines = [];
  if (max <= min) return lines;
  for (let tries = 0; tries < 60 && lines.length < count; tries++) {
    const v = rng.int(min, max);
    if (lines.every((l) => Math.abs(l - v) >= sep)) lines.push(v);
  }
  return lines.sort((a, b) => a - b);
}

/**
 * Pulls corridors back over any room block that shortening left stranded.
 *
 * Rooms are carved into the blocks between corridors, and every room needs a way
 * out. That works because a block always fronts onto a corridor — until a
 * shortened corridor stops before reaching it, and a block can end up ringed by
 * four solid stretches. BSP then buries its rooms behind each other with no exit
 * at all, and the connectivity repair downstream can only respond by walling the
 * whole block off, which quietly deletes a quarter of the floor.
 *
 * So the frontage is restored here, while corridors are still just numbers and
 * before anything is carved: any unserved block extends one of its neighbours
 * back over itself. Cheaper and far more predictable than discovering the
 * problem later as a hole in the map.
 */
export function ensureFrontage(vBands, hBands, inner) {
  const xSpans = complement(inner.x0, inner.x1, vBands);
  const ySpans = complement(inner.y0, inner.y1, hBands);
  const enough = DOOR_W + 2;   // a frontage too short to hold a doorway is none

  for (const xs of xSpans) {
    if (xs.hi - xs.lo < MIN_LEAF + 1) continue;   // too thin to become rooms
    for (const ys of ySpans) {
      if (ys.hi - ys.lo < MIN_LEAF + 1) continue;

      const vAdj = vBands.filter((b) => b.hi === xs.lo || b.lo === xs.hi);
      const hAdj = hBands.filter((b) => b.hi === ys.lo || b.lo === ys.hi);
      const served =
        vAdj.some((b) => overlap(b.from, b.to, ys.lo, ys.hi) >= enough) ||
        hAdj.some((b) => overlap(b.from, b.to, xs.lo, xs.hi) >= enough);
      if (served) continue;

      // Prefer extending a vertical neighbour; either restores frontage.
      const band = vAdj[0] ?? hAdj[0];
      if (!band) continue;
      const span = vAdj.length ? ys : xs;
      band.from = Math.min(band.from, span.lo);
      band.to = Math.max(band.to, span.hi);
    }
  }
}

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

// Stops a corridor short of one or both exterior walls. `must` is the primary
// corridor on the other axis, and the run has to keep covering it with a decent
// stub either side — a corridor that ended exactly at the junction would read as
// a T rather than as a corridor that carries on a bit and then stops.
export function shorten(rng, b, lo, hi, must) {
  const stub = CORRIDOR_W * 2;
  const latestStart = Math.max(lo, must.lo - stub);
  const earliestEnd = Math.min(hi, must.hi + stub);
  if (rng.chance(0.6)) b.from = rng.int(lo, latestStart);
  if (rng.chance(0.6)) b.to = rng.int(earliestEnd, hi);
}

// A corridor: `lo..hi` is its width across the slab, `from..to` how far it runs
// along it. Only `from..to` is ever shortened — the width and therefore the room
// blocks either side of it stay exactly as they were, so a stopped corridor
// leaves solid structural core behind it rather than a hole in the blocking.
export function band(center, lo, hi, from, to) {
  return {
    from, to,
    lo: Math.max(lo, center - Math.floor(CORRIDOR_W / 2)),
    hi: Math.min(hi, center + Math.ceil(CORRIDOR_W / 2)),
  };
}

// The gaps left between a set of bands inside [lo,hi).

// The gaps left between a set of bands inside [lo,hi).
export function complement(lo, hi, bands) {
  const spans = [];
  let cursor = lo;
  for (const b of [...bands].sort((a, c) => a.lo - c.lo)) {
    if (b.lo > cursor) spans.push({ lo: cursor, hi: b.lo });
    cursor = Math.max(cursor, b.hi);
  }
  if (cursor < hi) spans.push({ lo: cursor, hi });
  return spans;
}

/**
 * Subdivides one block into rooms.
 *
 * `open` is the floor's open-plan budget — `{ left }` in tiles, shared by every
 * block on the floor and spent as blocks are claimed. See OPEN_SHARE.
 */
export function bsp(rect, rng, out, open) {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const canX = w >= MIN_LEAF * 2;
  const canY = h >= MIN_LEAF * 2;

  if (!canX && !canY) { out.push(rect); return; }

  // An OPEN FLOOR: taken whole, and taken here rather than further down.
  //
  // The order is the whole of it. Offered a rect that has already been halved
  // twice, the budget spends itself on rooms that are merely large — and what
  // makes an open plan office read as one is that it is the biggest thing on the
  // floor, with the cellular offices around it rather than beside it. So the
  // first rect on each path that is inside the cap is the one that gets asked,
  // and anything wider than the cap goes on splitting until it fits.
  if (open.left > 0
    && w <= OPEN_LEAF && h <= OPEN_LEAF
    && w >= OPEN_MIN && h >= OPEN_MIN
    && rng.chance(OPEN_TAKE)) {
    open.left -= w * h;
    rect.open = true;
    out.push(rect);
    return;
  }

  // Stop early now and then, which is what a floor's merely-large rooms are.
  if (w <= MAX_LEAF && h <= MAX_LEAF && rng.chance(0.22)) { out.push(rect); return; }

  let splitX;
  if (canX && canY) splitX = w > h ? rng.chance(0.82) : rng.chance(0.18);
  else splitX = canX;

  if (splitX) {
    const cut = rng.int(rect.x0 + MIN_LEAF, rect.x1 - MIN_LEAF);
    bsp({ x0: rect.x0, y0: rect.y0, x1: cut, y1: rect.y1 }, rng, out, open);
    bsp({ x0: cut, y0: rect.y0, x1: rect.x1, y1: rect.y1 }, rng, out, open);
  } else {
    const cut = rng.int(rect.y0 + MIN_LEAF, rect.y1 - MIN_LEAF);
    bsp({ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: cut }, rng, out, open);
    bsp({ x0: rect.x0, y0: cut, x1: rect.x1, y1: rect.y1 }, rng, out, open);
  }
}

// Runs of wall along each side of a room that have open floor on the far side.

// Runs of wall along each side of a room that have open floor on the far side.
export function doorCandidates(room, tiles, W, H) {
  const { leaf } = room;
  const out = [];

  const tileAt = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : SOLID);

  // Is there already an opening within DOOR_GAP tiles along this wall line?
  // Rooms are doored one at a time, so this is what stops the next room's
  // doorway from landing flush against one already cut from the other side.
  const doorNear = (axis, line, i) => {
    for (let k = -DOOR_GAP; k <= DOOR_GAP; k++) {
      if ((axis === 'v' ? tileAt(line, i + k) : tileAt(i + k, line)) === DOOR) return true;
    }
    return false;
  };

  // Walks one side of the room collecting maximal runs of wall that have the
  // same kind of open floor on the far side; runs at least a doorway wide are
  // door candidates.
  const scan = (axis, wallLine, outsideLine, from, to) => {
    let run = null;
    const flush = () => {
      if (run && run.to - run.from >= DOOR_W) out.push(run);
      run = null;
    };

    for (let i = from; i < to; i++) {
      const ox = axis === 'v' ? outsideLine : i;
      const oy = axis === 'v' ? i : outsideLine;
      const wx = axis === 'v' ? wallLine : i;
      const wy = axis === 'v' ? i : wallLine;

      const kind = tileAt(ox, oy);
      // The wall tile itself must still be wall — a corridor may have eaten it.
      const usable = (kind === CORRIDOR || kind === ROOM)
        && tiles[wy * W + wx] === SOLID
        && !doorNear(axis, wallLine, i);

      if (usable && run && run.kind === kind) {
        run.to = i + 1;
      } else {
        flush();
        if (usable) run = { axis, wallLine, outsideLine, kind, from: i, to: i + 1 };
      }
    }
    flush();
  };

  // Skip the first and last tile of each side so doors never land in a corner.
  scan('v', leaf.x0, leaf.x0 - 1, room.y0 + 1, room.y1 - 1);
  scan('v', leaf.x1, leaf.x1 + 1, room.y0 + 1, room.y1 - 1);
  scan('h', leaf.y0, leaf.y0 - 1, room.x0 + 1, room.x1 - 1);
  scan('h', leaf.y1, leaf.y1 + 1, room.x0 + 1, room.x1 - 1);

  return out;
}

export function cutDoor(run, rng, tiles, W, doors, room) {
  const span = run.to - run.from;
  const start = run.from + (span > DOOR_W ? rng.int(0, span - DOOR_W) : 0);
  const end = Math.min(run.to, start + DOOR_W);

  for (let i = start; i < end; i++) {
    if (run.axis === 'v') tiles[i * W + run.wallLine] = DOOR;
    else tiles[run.wallLine * W + i] = DOOR;
  }

  const door = run.axis === 'v'
    ? { x0: run.wallLine, x1: run.wallLine + 1, y0: start, y1: end, vertical: true }
    : { x0: start, x1: end, y0: run.wallLine, y1: run.wallLine + 1, vertical: false };

  doors.push(door);
  room.doors.push(door);
}

/**
 * The doors across the corridors — the ones you walk through rather than into.
 *
 * A floor without them is one continuous open hallway network, which is the one
 * place in the building that reads as a level rather than as an office: real
 * corridors are broken up by fire doors every so often, and having to push
 * through one is what makes a corridor feel like it has a far end.
 *
 * They are the odd ones out in two ways, and both fall out of there being no
 * wall across a corridor to cut a hole in:
 *
 *  - They span the corridor's ENTIRE width, so the opening is a 3 m one rather
 *    than the 1.5 m every room doorway gets. `hall` says so, since the width
 *    invariant is different for them.
 *  - They cannot slide. A retracted panel goes inside the wall beside its
 *    opening (see slidePocketSide) and beside a corridor there is one tile of
 *    wall with somebody's office behind it. So these are two hinged leaves that
 *    swing back flat against the corridor walls, which is what the doors they
 *    are modelled on do anyway.
 *
 * That second point is the whole of the placement rule. A leaf needs the wall it
 * swings back against to actually be there for its own length, which is what
 * `swing` picks a direction for and what the flank sweep below proves. It also
 * does three other jobs for free: it puts the door somewhere the frame has a
 * jamb at both ends, it keeps a leaf from swinging across a room's doorway and
 * sealing it, and it refuses junctions outright, because at a crossing the
 * flanking wall is the other corridor.
 *
 * None of them is ever locked by the room passes. They are not on any room, so
 * the LOCK_PLAN loop in gen/locks.js never sees them; what badges them is
 * hallLocks, which proves a way round before it dares, because a badged door
 * across the one route everybody takes would be a floor locked in half.
 */
export function cutHallDoors(tiles, W, H, doors, bands, alongY, rng) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : SOLID);
  // `p` walks along the corridor; `k` walks across it. A vertical corridor runs
  // along y, so its cross-section is a row and its flanks are columns — and the
  // other way round for a horizontal one. That is the only difference between
  // the two axes, so it is the only thing this pair of helpers hides.
  const cross = (b, p, k) => (alongY ? at(b.lo + k, p) : at(p, b.lo + k));
  const flank = (b, p, side) =>
    (alongY ? at(side < 0 ? b.lo - 1 : b.hi, p) : at(p, side < 0 ? b.lo - 1 : b.hi));

  for (const b of bands) {
    const width = b.hi - b.lo;
    const leaf = Math.ceil(width / 2);
    // Too short to hold one anywhere that is not its own mouth.
    if (b.to - b.from < HALL_END * 2 + 2) continue;

    const placed = [];
    for (let n = rng.int(HALL_DOORS[0], HALL_DOORS[1]); n > 0; n--) {
      for (let tries = 0; tries < 40; tries++) {
        const p = rng.int(b.from + HALL_END, b.to - HALL_END - 1);
        if (placed.some((q) => Math.abs(q - p) < HALL_APART)) continue;

        // Clear across, and clear on both flanks for a leaf's length the way the
        // leaves fold. One tile the other way as well, so the frame never lands
        // flush against a doorway cut in the corridor wall opposite.
        const swing = rng.chance(0.5) ? 1 : -1;
        let ok = true;
        for (let k = 0; k < width && ok; k++) if (cross(b, p, k) !== CORRIDOR) ok = false;
        const lo = swing > 0 ? p - 1 : p - leaf;
        const hi = swing > 0 ? p + leaf : p + 1;
        for (let q = lo; q <= hi && ok; q++) {
          if (flank(b, q, -1) !== SOLID || flank(b, q, 1) !== SOLID) ok = false;
        }
        if (!ok) continue;

        for (let k = 0; k < width; k++) {
          if (alongY) tiles[p * W + (b.lo + k)] = DOOR;
          else tiles[(b.lo + k) * W + p] = DOOR;
        }
        doors.push(alongY
          ? { x0: b.lo, x1: b.hi, y0: p, y1: p + 1, vertical: false, hall: true, swing }
          : { x0: p, x1: p + 1, y0: b.lo, y1: b.hi, vertical: true, hall: true, swing });
        placed.push(p);
        break;
      }
    }
  }
}

// Flood the floor from the corridor network; any room left stranded gets an
// extra door punched toward reachable floor, and anything still stranded after
// a few passes is filled back in so the player can never see an orphan room.
export function connectAll(tiles, W, H, rooms, doors, vBand, hBand, rng) {
  const seedX = vBand ? vBand.lo : PAD + 1;
  const seedY = hBand ? hBand.lo : PAD + 1;

  for (let pass = 0; pass < 5; pass++) {
    const dist = bfs(tiles, W, H, seedX, seedY);
    const stranded = rooms.filter((r) => dist[Math.round((r.y0 + r.y1) / 2) * W + Math.round((r.x0 + r.x1) / 2)] < 0);
    if (!stranded.length) return;

    let cut = false;
    for (const room of stranded) {
      const options = doorCandidates(room, tiles, W, H).filter((run) => {
        const ox = run.axis === 'v' ? run.outsideLine : run.from;
        const oy = run.axis === 'v' ? run.from : run.outsideLine;
        if (ox < 0 || oy < 0 || ox >= W || oy >= H) return false;
        return dist[oy * W + ox] >= 0;
      });
      if (options.length) {
        cutDoor(rng.pick(options), rng, tiles, W, doors, room);
        cut = true;
      }
    }
    if (!cut) break;
  }

  // Give up on the rest: wall them off entirely.
  const dist = bfs(tiles, W, H, seedX, seedY);
  for (const room of rooms) {
    if (dist[Math.round((room.y0 + room.y1) / 2) * W + Math.round((room.x0 + room.x1) / 2)] >= 0) continue;
    for (let y = room.y0; y < room.y1; y++) {
      for (let x = room.x0; x < room.x1; x++) tiles[y * W + x] = SOLID;
    }
    room.doors.length = 0;
  }
}

// The biggest a lift lobby is allowed to be. There is no floor to go with it:
// what the room has to be able to hold is stated once, in `fitsLifts`, and
// restating it here in square metres is the FIRST_CONTACT_GAP failure in
// miniature — a room that passes an area test and cannot hold a car is a floor
// that arrives by standing in the middle of the carpet.
