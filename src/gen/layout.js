import { makeRng } from './rng.js';
import { clamp } from '../util.js';
import {
  TILE, SOLID, ROOM, CORRIDOR, DOOR, isOpen, bfs, worldX, worldZ,
} from './tiles.js';
import { assignLocks, lockedMask, prologueRegion } from './locks.js';
import { planStairs } from './stairs.js';

// Procedural office floorplan.
//
// Real office floors aren't mazes — they're a corridor spine with rooms packed
// against it. So we generate in that order: carve 1-2 horizontal and 1-3
// vertical corridors across the slab (guaranteed to intersect, so the corridor
// network is connected by construction), then subdivide each leftover block
// into rooms with BSP and cut a door from each room onto whatever it touches.
//
// Everything is done on a tile grid of TILE-metre cells. Walls are exactly one
// tile thick, which is why rooms are carved inset by one tile on their min
// sides only — two neighbouring rooms then share a single wall tile instead of
// stacking two.
//
// This file is the CARVING half of generation, and it is deliberately only that.
// The vocabulary the floorplan is written in lives in gen/tiles.js, and the badge
// readers — which are proofs about a finished floor rather than dice rolled over
// it — live in gen/locks.js. Both are re-exported below, because everything
// downstream asks gen/layout.js for a floor and should not have to know which of
// three files a constant ended up in.

// Re-exported so the rest of the tree keeps one address for the floorplan. The
// tile vocabulary in particular is imported by gen/build.js, nav.js, enemies.js,
// cameras.js, minimap.js and both validators, and none of them cares that it now
// has a file of its own.
export {
  TILE, WALL_H, CEIL_H, DOOR_H, DOOR_CLEAR,
  SOLID, ROOM, CORRIDOR, DOOR, isOpen,
  worldX, worldZ, centreX, centreZ, tileX, tileY,
  bfs, slidePocketSide,
} from './tiles.js';
// FIRST_CONTACT_GAP is re-exported rather than re-declared, and that is not
// tidiness — enemies.js imports it from here and measures the prologue guarantee
// against the same number the generator proved. See its comment in gen/locks.js
// for what happened the one time there were two of them.
export { FIRST_CONTACT_GAP, PROLOGUE_MIN, STAFF_ONLY } from './locks.js';

// PAD, CORRIDOR_W and DOOR_W are exported because tools/validate-layout.mjs
// checks against them, and a validator holding its own copy of the number it is
// checking is the FIRST_CONTACT_GAP failure exactly: the sweep stops testing the
// generator and starts asserting its own arithmetic back at it.
export const PAD = 2;              // solid tiles of exterior wall on each side
export const CORRIDOR_W = 6;       // 3 m corridors
const MIN_LEAF = 10;               // smallest room block (=> 4.5 m interior)
const MAX_LEAF = 26;               // above this a block always splits again
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
const SIZE_SCALE = [0.78, 1.18];
const SIZE_SKEW = [0.82, 1.2];
// Where the growth curve stops, and with it the biggest floor in the game.
const BASE_W_MAX = 300;
const BASE_H_MAX = 252;
// Absolute bounds in tiles, on either axis — 300 on both, so the shape die is
// free to stand a floor on end. The lower one is not taste: a slab much under
// 60 m has room for the corridor spine and little else, and the prologue pass
// then starts stripping readers off doorways to find somewhere to stand the
// first body (see freeThePrologue in gen/locks.js).
const SPAN_MIN = 120;
const SPAN_MAX = 300;
// And the area of the largest floor the curve ever asks for. The roll varies a
// floor UNDER that ceiling rather than through it: past floor ~12 the difficulty
// is meant to come from the enemies rather than from more walking, so a big roll
// on floor 15 must not quietly hand out a fifth more building than the game has
// ever had to draw, light and populate.
const AREA_MAX = BASE_W_MAX * BASE_H_MAX;

/**
 * The slab, in tiles, plus how that came out relative to this depth's usual.
 *
 * `areaRatio` is the part callers want and the reason it is returned rather than
 * recomputed: how many people and how many cameras a floor gets is a question
 * about DENSITY, and both are authored against the typical floor for a depth.
 * 200 staff is a crowd on that floor and a crush on one two-thirds the size.
 * It is measured from the spans that survived the clamps rather than from
 * `scale`, so a floor that hit a bound still reports the area it actually has.
 *
 * On its own stream, and mixed with the floor number, for the same two reasons
 * the locks are (see assignLocks below). Drawing from the floor's own `rng` would
 * shift every later number and re-roll the whole building off a die that has
 * nothing to do with its contents; and a stream of the seed alone would hand
 * every floor of one seed the same shape, which is exactly the variety the
 * validators sweep for.
 */
function floorSpans(seed, floorNumber) {
  const rng = makeRng((seed ^ 0x1b56c4e9) + Math.imul(floorNumber, 0x9e3779b1));

  // Floors grow as you descend, but not without bound — past floor ~12 the
  // difficulty comes from the enemies, not from more walking.
  const baseW = Math.min(BASE_W_MAX, 176 + floorNumber * 10);
  const baseH = Math.min(BASE_H_MAX, 144 + floorNumber * 10);

  const scale = rng.range(SIZE_SCALE[0], SIZE_SCALE[1]);
  const skew = rng.range(SIZE_SKEW[0], SIZE_SKEW[1]);
  let W = clamp(Math.round(baseW * scale * skew), SPAN_MIN, SPAN_MAX);
  let H = clamp(Math.round(baseH * scale / skew), SPAN_MIN, SPAN_MAX);

  // Back under the ceiling on both axes at once, so a floor that overshot comes
  // back the shape it rolled rather than squared off against whichever bound it
  // happened to hit first.
  if (W * H > AREA_MAX) {
    const back = Math.sqrt(AREA_MAX / (W * H));
    W = clamp(Math.floor(W * back), SPAN_MIN, SPAN_MAX);
    H = clamp(Math.floor(H * back), SPAN_MIN, SPAN_MAX);
  }

  return { W, H, areaRatio: (W * H) / (baseW * baseH) };
}

export function generateLayout(seed, floorNumber) {
  const rng = makeRng(seed);

  const { W, H, areaRatio } = floorSpans(seed, floorNumber);

  const tiles = new Uint8Array(W * H); // SOLID everywhere to start
  const at = (x, y) => tiles[y * W + x];
  const set = (x, y, v) => { tiles[y * W + x] = v; };

  const inner = { x0: PAD, y0: PAD, x1: W - PAD, y1: H - PAD };

  // --- 1. corridor spine ----------------------------------------------------
  // Corridor count scales with the slab. A single cross on a big floor leaves
  // four huge blocks, and BSP then buries the middle of each block behind
  // three or four other rooms — you end up walking through somebody's office
  // to reach somebody else's office. More spine keeps every room within a
  // room or two of a corridor.
  const vWanted = clamp(Math.round(W / 32), 3, 7);
  const hWanted = clamp(Math.round(H / 32), 2, 5);
  const vLines = pickLines(rng, inner.x0 + MIN_LEAF + 2, inner.x1 - MIN_LEAF - 2, vWanted, CORRIDOR_W + 15);
  const hLines = pickLines(rng, inner.y0 + MIN_LEAF + 2, inner.y1 - MIN_LEAF - 2, hWanted, CORRIDOR_W + 15);
  // Both axes must exist or the corridors never cross and the floor splits.
  if (!vLines.length) vLines.push(Math.floor((inner.x0 + inner.x1) / 2));
  if (!hLines.length) hLines.push(Math.floor((inner.y0 + inner.y1) / 2));

  const vBands = vLines.map((cx) => band(cx, inner.x0, inner.x1, inner.y0, inner.y1));
  const hBands = hLines.map((cy) => band(cy, inner.y0, inner.y1, inner.x0, inner.x1));

  // The first corridor on each axis runs the full slab, and those two crossing
  // is what makes the network connected by construction. Every other corridor is
  // cut short at one or both ends, so a floor reads as a building with a core
  // and some wings rather than a grid stamped edge to edge. Shortening is only
  // ever allowed to stop a corridor *outside* the primary cross, so the spine
  // stays intact no matter how the dice fall — and connectAll still proves it.
  for (let i = 1; i < vBands.length; i++) shorten(rng, vBands[i], inner.y0, inner.y1, hBands[0]);
  for (let i = 1; i < hBands.length; i++) shorten(rng, hBands[i], inner.x0, inner.x1, vBands[0]);
  ensureFrontage(vBands, hBands, inner);

  for (const b of vBands) {
    for (let x = b.lo; x < b.hi; x++) for (let y = b.from; y < b.to; y++) set(x, y, CORRIDOR);
  }
  for (const b of hBands) {
    for (let y = b.lo; y < b.hi; y++) for (let x = b.from; x < b.to; x++) set(x, y, CORRIDOR);
  }

  // --- 2. rooms in the leftover blocks --------------------------------------
  const xSpans = complement(inner.x0, inner.x1, vBands);
  const ySpans = complement(inner.y0, inner.y1, hBands);

  const rooms = [];
  for (const xs of xSpans) {
    for (const ys of ySpans) {
      // Too thin to hold a room — leave it solid as a structural core.
      if (xs.hi - xs.lo < MIN_LEAF + 1 || ys.hi - ys.lo < MIN_LEAF + 1) continue;

      // Reserve the block's max edges as wall so rooms carved inset-on-min
      // still end up separated from the corridor beyond.
      const block = { x0: xs.lo, y0: ys.lo, x1: xs.hi - 1, y1: ys.hi - 1 };
      const leaves = [];
      bsp(block, rng, leaves);

      for (const leaf of leaves) {
        const room = {
          id: rooms.length,
          leaf,
          x0: leaf.x0 + 1, y0: leaf.y0 + 1, x1: leaf.x1, y1: leaf.y1, // interior, max exclusive
          doors: [],
        };
        if (room.x1 - room.x0 < 4 || room.y1 - room.y0 < 4) continue;
        for (let y = room.y0; y < room.y1; y++) {
          for (let x = room.x0; x < room.x1; x++) set(x, y, ROOM);
        }
        rooms.push(room);
      }
    }
  }

  // --- 3. doors -------------------------------------------------------------
  const doors = [];
  for (const room of rooms) {
    const sides = doorCandidates(room, tiles, W, H);
    // A door onto a corridor is always preferred; rooms that only touch other
    // rooms get an interconnecting door instead.
    const corridorSides = sides.filter((s) => s.kind === CORRIDOR);
    const chosen = corridorSides.length ? corridorSides : sides;
    if (!chosen.length) continue;

    rng.shuffle(chosen);
    const wanted = 1 + (rng.chance(0.35) && chosen.length > 1 ? 1 : 0);
    for (let i = 0; i < Math.min(wanted, chosen.length); i++) {
      cutDoor(chosen[i], rng, tiles, W, doors, room);
    }
  }

  // --- 4. connectivity ------------------------------------------------------
  connectAll(tiles, W, H, rooms, doors, vBands[0], hBands[0], rng);

  // --- 4b. doors across the corridors ---------------------------------------
  // After connectivity, not before: these are cut against the finished floor, so
  // they can see every room doorway that was going to be cut and keep clear of
  // it. They can never affect connectivity themselves — a doorway is open floor
  // and none of them is ever locked.
  cutHallDoors(tiles, W, H, doors, vBands, true, rng);
  cutHallDoors(tiles, W, H, doors, hBands, false, rng);

  // --- 5. roles, spawn and exit --------------------------------------------
  const live = rooms.filter((r) => r.doors.length > 0);
  for (const r of live) {
    r.wTiles = r.x1 - r.x0;
    r.hTiles = r.y1 - r.y0;
    r.areaM2 = r.wTiles * r.hTiles * TILE * TILE;
    r.cx = (r.x0 + r.x1) / 2;
    r.cy = (r.y0 + r.y1) / 2;
  }

  const spawnRoom = pickSpawnRoom(live, rng);
  const dist = bfs(tiles, W, H, Math.round(spawnRoom.cx), Math.round(spawnRoom.cy));

  // The exit goes somewhere far, but not reliably in the opposite corner — the
  // strict furthest room makes every floor a diagonal march across the whole
  // slab. Picking from the furthest quarter keeps it a hike without making it
  // a chore.
  const ranked = live
    .map((r) => ({ r, d: dist[Math.round(r.cy) * W + Math.round(r.cx)] }))
    .filter((e) => e.d >= 0)
    .sort((a, b) => b.d - a.d);
  const exitRoom = ranked.length
    ? rng.pick(ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.25)))).r
    : spawnRoom;

  assignRoles(live, spawnRoom, exitRoom, rng);
  // On its own stream, not the floor's. Everything downstream of here — the
  // furniture in every room on the floor — draws from `rng`, so spending a
  // variable number of numbers on picking locks would re-roll the contents of a
  // building that has nothing to do with them. It showed up immediately as a
  // mailroom, three hundred metres from the nearest badge reader, furnishing
  // itself shut.
  const locks = assignLocks(tiles, W, H, live, doors, spawnRoom, exitRoom, dist,
    makeRng(seed ^ 0x5bf03635));
  // Its own stream for the same reason, and the reason bites harder here: how
  // many stairs a floor gets is itself a die, and how many candidate rooms and
  // walls were tried before one fitted is several more. Left on the floor's
  // stream, a floor with a staircase would furnish every OTHER room differently
  // from the same floor without one.
  const stairs = planStairs(tiles, W, H, live, spawnRoom, exitRoom,
    makeRng(seed ^ 0x7f4a7c15));

  const layout = {
    seed, floorNumber, W, H, TILE,
    // How much floor this is compared with the usual one at this depth. Read by
    // whoever has to spread a fixed number of things over it — see floorSpans.
    areaRatio,
    ox: -W * TILE / 2, oz: -H * TILE / 2,
    tiles, rooms: live, doors,
    spawnRoom, exitRoom,
    locks,
    // The 0-2 rooms with a flight of stairs in them, and where in the room it
    // runs. Authored here rather than in the builder so the layout sweep sees it.
    stairs,
    // Every tile behind a badge reader, so the things that scatter themselves
    // over a floor — enemies, vermin — can keep out of rooms they would be
    // locked into. See enemies.js.
    locked: lockedMask(W, H, locks),
    // And every tile they can reach on arrival with nothing in their pocket,
    // which is a different question now that the corridors have readers on them
    // too: it is where the FIRST white card has to be standing. See
    // _cardOutside in enemies.js and hallLocks in gen/locks.js.
    prologue: prologueRegion(tiles, W, H,
      Math.round(spawnRoom.cx), Math.round(spawnRoom.cy), doors),
    rng,
  };

  layout.spawn = { x: worldX(layout, spawnRoom.cx), z: worldZ(layout, spawnRoom.cy) };
  layout.exit = { x: worldX(layout, exitRoom.cx), z: worldZ(layout, exitRoom.cy) };

  return layout;
}

// --- generation internals ---------------------------------------------------

// `count` positions inside [min,max] that are at least `sep` apart.
function pickLines(rng, min, max, count, sep) {
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
function ensureFrontage(vBands, hBands, inner) {
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
function shorten(rng, b, lo, hi, must) {
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
function band(center, lo, hi, from, to) {
  return {
    from, to,
    lo: Math.max(lo, center - Math.floor(CORRIDOR_W / 2)),
    hi: Math.min(hi, center + Math.ceil(CORRIDOR_W / 2)),
  };
}

// The gaps left between a set of bands inside [lo,hi).
function complement(lo, hi, bands) {
  const spans = [];
  let cursor = lo;
  for (const b of [...bands].sort((a, c) => a.lo - c.lo)) {
    if (b.lo > cursor) spans.push({ lo: cursor, hi: b.lo });
    cursor = Math.max(cursor, b.hi);
  }
  if (cursor < hi) spans.push({ lo: cursor, hi });
  return spans;
}

function bsp(rect, rng, out) {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const canX = w >= MIN_LEAF * 2;
  const canY = h >= MIN_LEAF * 2;

  if (!canX && !canY) { out.push(rect); return; }
  // Stop early now and then so some rooms come out as big open-plan floors.
  if (w <= MAX_LEAF && h <= MAX_LEAF && rng.chance(0.22)) { out.push(rect); return; }

  let splitX;
  if (canX && canY) splitX = w > h ? rng.chance(0.82) : rng.chance(0.18);
  else splitX = canX;

  if (splitX) {
    const cut = rng.int(rect.x0 + MIN_LEAF, rect.x1 - MIN_LEAF);
    bsp({ x0: rect.x0, y0: rect.y0, x1: cut, y1: rect.y1 }, rng, out);
    bsp({ x0: cut, y0: rect.y0, x1: rect.x1, y1: rect.y1 }, rng, out);
  } else {
    const cut = rng.int(rect.y0 + MIN_LEAF, rect.y1 - MIN_LEAF);
    bsp({ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: cut }, rng, out);
    bsp({ x0: rect.x0, y0: cut, x1: rect.x1, y1: rect.y1 }, rng, out);
  }
}

// Runs of wall along each side of a room that have open floor on the far side.
function doorCandidates(room, tiles, W, H) {
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

function cutDoor(run, rng, tiles, W, doors, room) {
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
function cutHallDoors(tiles, W, H, doors, bands, alongY, rng) {
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
function connectAll(tiles, W, H, rooms, doors, vBand, hBand, rng) {
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

function pickSpawnRoom(rooms, rng) {
  // A mid-sized room with a corridor door: reads as stepping out of a lift.
  const good = rooms.filter((r) => r.areaM2 > 18 && r.areaM2 < 70);
  return rng.pick(good.length ? good : rooms);
}

// Where the role ladder splits. Aspect is tested before area on purpose: a long
// thin room is a service room whatever its floor area, and testing area first
// made that branch unreachable.
const LONG_THIN = 1.9;   // longest side / shortest side
const BIG_ROOM = 85;     // m², open plan and canteens
const MID_ROOM = 40;     // m², the meeting-room band

/**
 * Which branch of the role table a room's shape lands in.
 *
 * Exported because `validate-layout.mjs` reports this distribution, and its own
 * copy of the ladder had drifted: it tested area before aspect and used 2.1 for
 * the aspect cut, so it reported zero long-thin rooms on every sweep while the
 * generator was in fact producing thousands of them — which is the whole
 * storage/archive/utility supply. A tool asserting its own wrong number back at
 * the generator is exactly the failure FIRST_CONTACT_GAP is a monument to, so
 * there is one ladder now and both ends call it.
 */
export function roleBranch(r) {
  const long = Math.max(r.wTiles, r.hTiles) / Math.min(r.wTiles, r.hTiles);
  if (long > LONG_THIN) return 'longThin';
  if (r.areaM2 > BIG_ROOM) return 'big';
  if (r.areaM2 > MID_ROOM) return 'mid';
  return 'small';
}

// What each branch may be. Long-thin rooms furnish as ranks with an aisle
// between them, which is why they are back-of-house whatever their area.
const ROLE_PICKS = {
  longThin: ['storage', 'copyroom', 'server', 'storage', 'archive', 'utility', 'mailroom'],
  big: ['openplan', 'openplan', 'openplan', 'canteen'],
  mid: ['openplan', 'meeting', 'breakroom', 'storage', 'training', 'itbay', 'canteen', 'reception'],
  small: ['office', 'office', 'copyroom', 'storage', 'breakroom', 'utility', 'archive', 'server'],
};

function assignRoles(rooms, spawnRoom, exitRoom, rng) {
  for (const r of rooms) r.role = rng.pick(ROLE_PICKS[roleBranch(r)]);

  // Guarantee the flavour rooms the floor is meant to have — but only in rooms
  // the right size for them, so no floor gets a 150 m² "storage cupboard". The
  // first four are on every floor because the building needs them; the rest is
  // a shuffled draw, so which back-of-house rooms a floor has is part of what
  // tells one floor from another.
  const wants = [
    // The generator room goes first: it wants the biggest, squarest room on
    // the floor, and every other entry below it is happy with something
    // smaller — so it gets first pick before a less demanding role claims the
    // one room that could have held it. Not every floor rolls a room this
    // size, and that's fine: see buildLevel's generator handling, which is
    // opportunistic the same way the security office and broom closet are.
    ['generator', (r) => r.areaM2 > 100 && Math.min(r.wTiles, r.hTiles) >= 14],
    ['storage', (r) => r.areaM2 < 90],
    ['copyroom', (r) => r.areaM2 < 55],
    ['server', (r) => r.areaM2 < 70],
    ['breakroom', (r) => r.areaM2 > 30],
    ...rng.shuffle([
      ['archive', (r) => r.areaM2 < 90],
      ['utility', (r) => r.areaM2 < 60],
      ['mailroom', (r) => r.areaM2 > 25 && r.areaM2 < 90],
      ['itbay', (r) => r.areaM2 > 25 && r.areaM2 < 90],
      ['training', (r) => r.areaM2 > 35],
      ['canteen', (r) => r.areaM2 > 45],
      ['reception', (r) => r.areaM2 > 25],
    ]).slice(0, 4),
  ];
  const pool = rng.shuffle(rooms.filter((r) => r !== spawnRoom && r !== exitRoom));
  for (const [role, fits] of wants) {
    const room = pool.find((r) => fits(r) && !r.forcedRole);
    if (room) { room.role = role; room.forcedRole = true; }
  }

  spawnRoom.role = 'lobby';
  exitRoom.role = 'exit';
}
