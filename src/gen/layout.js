import { makeRng } from './rng.js';

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

export const TILE = 0.5;           // metres per tile
export const WALL_H = 3.2;         // structural wall height
export const CEIL_H = 3.0;         // suspended ceiling height
export const DOOR_H = 2.1;

const PAD = 2;                     // solid tiles of exterior wall on each side
const CORRIDOR_W = 6;              // 3 m corridors
const MIN_LEAF = 10;               // smallest room block (=> 4.5 m interior)
const MAX_LEAF = 26;               // above this a block always splits again
const DOOR_W = 3;                  // 1.5 m doorways
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

export const SOLID = 0;
export const ROOM = 1;
export const CORRIDOR = 2;
export const DOOR = 3;

export const isOpen = (t) => t !== SOLID;

export function generateLayout(seed, floorNumber) {
  const rng = makeRng(seed);

  // Floors grow as you descend, but not without bound — past floor ~12 the
  // difficulty comes from the enemies, not from more walking.
  const W = Math.min(300, 176 + floorNumber * 10);
  const H = Math.min(252, 144 + floorNumber * 10);

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

  const layout = {
    seed, floorNumber, W, H, TILE,
    ox: -W * TILE / 2, oz: -H * TILE / 2,
    tiles, rooms: live, doors,
    spawnRoom, exitRoom,
    locks,
    // Every tile behind a badge reader, so the things that scatter themselves
    // over a floor — enemies, vermin — can keep out of rooms they would be
    // locked into. See enemies.js.
    locked: lockedMask(W, H, locks),
    // And every tile they can reach on arrival with nothing in their pocket,
    // which is a different question now that the corridors have readers on them
    // too: it is where the FIRST white card has to be standing. See
    // _cardOutside in enemies.js and hallLocks below.
    prologue: prologueRegion(tiles, W, H,
      Math.round(spawnRoom.cx), Math.round(spawnRoom.cy), doors),
    rng,
  };

  layout.spawn = { x: worldX(layout, spawnRoom.cx), z: worldZ(layout, spawnRoom.cy) };
  layout.exit = { x: worldX(layout, exitRoom.cx), z: worldZ(layout, exitRoom.cy) };

  return layout;
}

// Tile <-> world helpers. The building is centred on the origin.
export const worldX = (l, tx) => tx * l.TILE + l.ox;
export const worldZ = (l, ty) => ty * l.TILE + l.oz;
export const tileX = (l, x) => Math.floor((x - l.ox) / l.TILE);
export const tileY = (l, z) => Math.floor((z - l.oz) / l.TILE);

// --- generation internals ---------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
 * None of them is ever locked. They are not on any room, so assignLocks never
 * sees them; a badged door across the one route everybody takes would be a floor
 * locked in half.
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

/**
 * Which way a sliding panel in this doorway could retract, or 0 for neither.
 *
 * A retracted panel has to go somewhere, and where it goes is inside the wall
 * beside the opening — so the wall has to BE there: the full width of the panel,
 * on the same line, solid the whole way. Near a corner it is not, and a door
 * fitted there would slide out into the corridor and hang in mid-air at right
 * angles to its own frame.
 *
 * It lives here rather than in gen/build.js, which is what actually fits the
 * doors, because assignLocks has to ask the same question: a doorway that cannot
 * hold a panel cannot hold a locked one either, and a lock with no door in it is
 * a hole with a badge reader next to it.
 */
export function slidePocketSide(tiles, W, H, door, prefer = 1) {
  const at = (tx, ty) => (tx >= 0 && ty >= 0 && tx < W && ty < H ? tiles[ty * W + tx] : SOLID);
  const span = door.vertical ? door.y1 - door.y0 : door.x1 - door.x0;

  const fits = (dir) => {
    for (let i = 1; i <= span; i++) {
      if (door.vertical) {
        const ty = dir > 0 ? door.y1 - 1 + i : door.y0 - i;
        if (at(door.x0, ty) !== SOLID) return false;
      } else {
        const tx = dir > 0 ? door.x1 - 1 + i : door.x0 - i;
        if (at(tx, door.y0) !== SOLID) return false;
      }
    }
    return true;
  };

  return fits(prefer) ? prefer : fits(-prefer) ? -prefer : 0;
}

// Breadth-first tile distances over open floor. -1 means unreachable.
export function bfs(tiles, W, H, sx, sy) {
  const dist = new Int32Array(W * H).fill(-1);
  if (!isOpen(tiles[sy * W + sx])) {
    // Nudge to the nearest open tile so a bad seed point can't kill the flood.
    let found = false;
    for (let r = 1; r < 12 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          const x = sx + dx, y = sy + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          if (isOpen(tiles[y * W + x])) { sx = x; sy = y; found = true; }
        }
      }
    }
    if (!found) return dist;
  }

  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  dist[sy * W + sx] = 0;
  queue[tail++] = sy * W + sx;

  while (head < tail) {
    const i = queue[head++];
    const x = i % W, y = (i / W) | 0;
    const d = dist[i] + 1;

    if (x > 0 && dist[i - 1] === -1 && isOpen(tiles[i - 1])) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < W - 1 && dist[i + 1] === -1 && isOpen(tiles[i + 1])) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (y > 0 && dist[i - W] === -1 && isOpen(tiles[i - W])) { dist[i - W] = d; queue[tail++] = i - W; }
    if (y < H - 1 && dist[i + W] === -1 && isOpen(tiles[i + W])) { dist[i + W] = d; queue[tail++] = i + W; }
  }

  return dist;
}

function pickSpawnRoom(rooms, rng) {
  // A mid-sized room with a corridor door: reads as stepping out of a lift.
  const good = rooms.filter((r) => r.areaM2 > 18 && r.areaM2 < 70);
  return rng.pick(good.length ? good : rooms);
}

function assignRoles(rooms, spawnRoom, exitRoom, rng) {
  for (const r of rooms) {
    // Aspect is tested before area on purpose: a long thin room is a service
    // room whatever its floor area, and testing area first made this branch
    // unreachable.
    const long = Math.max(r.wTiles, r.hTiles) / Math.min(r.wTiles, r.hTiles);
    if (long > 1.9) {
      // A long thin room is back-of-house whatever its floor area — the ones
      // that furnish as ranks with an aisle between them.
      r.role = rng.pick(['storage', 'copyroom', 'server', 'storage', 'archive', 'utility', 'mailroom']);
    } else if (r.areaM2 > 85) {
      r.role = rng.pick(['openplan', 'openplan', 'openplan', 'canteen']);
    } else if (r.areaM2 > 40) {
      r.role = rng.pick(['openplan', 'meeting', 'breakroom', 'storage', 'training', 'itbay', 'canteen', 'reception']);
    } else {
      r.role = rng.pick(['office', 'office', 'copyroom', 'storage', 'breakroom', 'utility', 'archive', 'server']);
    }
  }

  // Guarantee the flavour rooms the floor is meant to have — but only in rooms
  // the right size for them, so no floor gets a 150 m² "storage cupboard". The
  // first four are on every floor because the building needs them; the rest is
  // a shuffled draw, so which back-of-house rooms a floor has is part of what
  // tells one floor from another.
  const wants = [
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

// --- keycard locks ----------------------------------------------------------
//
// Every door in the building has a reader beside it, because every door in an
// office building does. Which card opens which lock is keycards.js's business;
// this decides which rooms get which lock, and the entire job here is making
// sure a lock can never cost you the floor.
//
// The five cards fall into two groups, and they are governed by two completely
// different rules:
//
//   WHITE is the staff badge, and it goes on EVERYTHING with a door. Every
//   employee in the building is carrying one, so it is not really a lock at all
//   — it is the thirty seconds at the start of a floor before you have taken one
//   off somebody. That is the only reason it can be this indiscriminate. What
//   makes it safe is `staffOnly` below: white rooms are the rooms people work
//   in, so the card is behind the door AND in front of it, several hundred
//   times over, and enemies.js guarantees at least one hostile stands outside
//   every locked room on the floor. The spawn room is the one exception — a
//   badge reader on the lobby you start inside is a floor you cannot leave.
//
//   GREY, BLUE, YELLOW and BLACK are real locks, and they are the ones the
//   proofs below are about. They empty their room of staff, and a room only
//   takes one if FILLING IT IN SOLID still leaves every other room and the exit
//   reachable — so all four are loot, never the route. A candidate must also be
//   reachable with the other three already shut, so no card is ever behind
//   another card's door, and none is behind its own.
//
// The cost is a flood fill per candidate, on a grid the generator has already
// flooded several times. It is worth it: this is the one part of the floor that,
// when it goes wrong, cannot be walked around.

// The back-of-house roles that read as "staff only" from the doorway — they are
// what the grey card is for.
const GREY_ROLES = new Set(['server', 'archive', 'itbay', 'mailroom', 'utility', 'storage']);

// In order, because the ones with a room role of their own have to get first
// pick. White is not in here: it is not chosen, it is what is left.
//
// `staffOnly` is the flag that does the real work — it says this room is emptied
// of staff, which is what keeps its card from being locked inside it. Every
// entry here sets it, and white does not, and that difference IS the difference
// between the two groups.
const LOCK_PLAN = [
  // The manager sits as far from the lifts as the floor allows, which is both
  // how offices work and where you want the last room on the floor to be.
  { tier: 'black', role: 'manager', count: [1, 1], far: true,
    fits: (r) => r.areaM2 >= 14 && r.areaM2 <= 70 },
  { tier: 'blue', role: 'security', count: [1, 1],
    fits: (r) => r.areaM2 >= 14 && r.areaM2 <= 70 },
  { tier: 'yellow', role: 'closet', count: [1, 1],
    fits: (r) => r.areaM2 <= 34 },
  { tier: 'grey', count: [2, 4], fits: (r) => GREY_ROLES.has(r.role) },
];

// How many candidates a tier will flood-fill before giving up on itself. A floor
// that cannot place a lock simply does not have that lock — there is no card for
// it either, so nothing dangles.
const LOCK_TRIES = 10;

// How many hall doors want a real lock rather than the staff badge. They only
// get one where the corridor network offers a way round — see hallLocks — so
// this is a wish rather than a count.
const HALL_GREY = 0.3;

/**
 * How far from the lifts the first person the player can reach has to be, in
 * METRES: far enough not to be standing on the doormat, near enough that finding
 * them is not the floor.
 *
 * Exported because enemies.js measures the same thing against the same number
 * (see _cardOutside), and the two drifting apart is not a hypothetical — it
 * already shipped once. This file guaranteed corridor at 14 *tiles walked* and
 * enemies.js wanted corridor at 11 *metres straight-line*, which is 22 tiles, so
 * the guarantee was both in the wrong unit and weaker than the thing it was
 * protecting. Result: about one floor in forty had nobody the player could reach
 * and could not be started at all. One constant, one unit, one place.
 */
export const FIRST_CONTACT_GAP = 11;

// How many corridor tiles past that gap have to be reachable with every door
// shut. Counted in tiles rather than in standable spots because the generator
// runs before a stick of furniture is placed and cannot know which of them a
// filing cabinet will end up in — so it is deliberately generous, and
// _cardOutside has a fallback for the rest.
const PROLOGUE_MIN = 40;

function assignLocks(tiles, W, H, rooms, doors, spawnRoom, exitRoom, dist, rng) {
  const sx = Math.round(spawnRoom.cx), sy = Math.round(spawnRoom.cy);
  const centre = (r) => Math.round(r.cy) * W + Math.round(r.cx);

  // The floor as it will look with every lock shut. Locks are cumulative, so a
  // candidate is judged against the floor the previous locks left behind.
  const sealed = Uint8Array.from(tiles);
  let reach = bfs(sealed, W, H, sx, sy);

  const locks = [];
  for (const step of LOCK_PLAN) {
    const wanted = rng.int(step.count[0], step.count[1]);

    let pool = rooms.filter((r) =>
      !r.lock && r !== spawnRoom && r !== exitRoom && step.fits(r));
    // A role-bearing lock would rather not eat one of the flavour rooms the
    // floor was promised, so unforced rooms go first.
    pool = rng.shuffle(pool).sort((a, b) => (a.forcedRole ? 1 : 0) - (b.forcedRole ? 1 : 0));
    if (step.far) pool.sort((a, b) => (dist[centre(b)] ?? 0) - (dist[centre(a)] ?? 0));

    let placed = 0;
    for (const room of pool.slice(0, LOCK_TRIES)) {
      if (placed >= wanted) break;

      // Behind a lock already placed: locking it would put its key behind two
      // doors, and the second one may be the one this key opens.
      if (reach[centre(room)] < 0) continue;

      const onRoom = doorsOnRoom(doors, room);
      if (!onRoom.length) continue;
      // Every way in has to be shuttable. One opening on the room with no wall
      // to retract a panel into is a lock you walk straight around.
      if (onRoom.some((d) => slidePocketSide(tiles, W, H, d) === 0)) continue;
      // And no way in may be shared with a room that is already locked to a
      // DIFFERENT tier. A doorway between the security office and the archive
      // has to demand one card or the other, and whichever it demands, the other
      // room is now openable with a card that was never meant to open it. There
      // are four of these locks on a floor of two hundred rooms, so refusing the
      // candidate outright costs nothing and settles the question permanently.
      if (onRoom.some((d) => d.lock)) continue;
      if (!survivesWithout(sealed, W, H, sx, sy, rooms, room, locks, exitRoom, onRoom)) continue;

      room.lock = step.tier;
      room.staffOnly = true;
      if (step.role) { room.role = step.role; room.forcedRole = true; }
      for (const d of onRoom) d.lock = step.tier;
      locks.push({ room, tier: step.tier, doors: onRoom, staffOnly: true });

      fillRoom(sealed, W, room, SOLID);
      reach = bfs(sealed, W, H, sx, sy);
      placed++;
    }
  }

  // The doors across the corridors, which is the last tier decided before white
  // goes on everything left.
  hallLocks(sealed, W, H, sx, sy, doors, reach, rng);

  // And now the one thing white cannot check for itself. Everything above is a
  // lock you meet with an empty pocket, walk away from, and come back to; white
  // is the one you meet before you have anything at all, so the floor has to
  // guarantee a way out of the lobby to somebody worth shooting.
  freeThePrologue(tiles, W, H, sx, sy, spawnRoom.cx, spawnRoom.cy, doors);

  // And white on everything else, with no proof and no flood fill, because
  // there is nothing to prove: white is not a card you go and find, it is a card
  // the next person you shoot is already carrying. The only rooms it skips are
  // the lobby you spawn in — locking that is locking yourself in — and doorways
  // with no wall to retract a panel into, which cannot hold a door at all.
  //
  // The exit room is NOT skipped. Reaching the exit means clearing the floor,
  // clearing the floor means killing somebody, and killing somebody means having
  // a white card, so a badge reader on the exit is a reader you have already
  // walked through forty of.
  for (const room of rooms) {
    if (room.lock || room === spawnRoom) continue;
    const onRoom = doorsOnRoom(doors, room);
    if (!onRoom.length) continue;
    if (onRoom.some((d) => slidePocketSide(tiles, W, H, d) === 0)) continue;
    // A doorway the prologue needs standing open cannot be badged, and a room
    // with one does not get a lock at all — the same deal as the line above, and
    // for the same reason: half a lock is worse than none, because the reader
    // beside it would be lying.
    if (onRoom.some((d) => d.free)) continue;

    room.lock = 'white';
    // Never DOWNGRADE a door. A white room next to the archive shares that
    // doorway, and stamping white over the grey lock on it would open the
    // archive to a staff badge from the room next door.
    for (const d of onRoom) d.lock ??= 'white';
    locks.push({ room, tier: 'white', doors: onRoom, staffOnly: false });
  }

  return locks;
}

/**
 * Badging the doors across the corridors.
 *
 * Every other lock in the building is on a room, and a room is a dead end you
 * choose to open. A corridor is the route, so a reader on one is the only lock
 * in this game that can stand between the player and the rest of the floor —
 * which is why nothing here is left to chance. Two rules, and the floor is safe
 * whichever way the dice fall:
 *
 *  - **A real lock only where the network goes round.** A hall door may take
 *    grey, but only if sealing it strands nothing that was reachable before.
 *    Corridors are a network with more than one way through most of it, so this
 *    is often true — and where it is, the door costs you a detour rather than
 *    the run. The test is cumulative: each door is judged against the floor the
 *    already-badged ones left behind, so two doors that each have a way round
 *    can never be allowed to shut the last one between them.
 *
 *  - **Everything else takes white**, which is the same badge that is already on
 *    every room door on the floor and in every employee's pocket. It costs the
 *    first thirty seconds of a floor and nothing after that.
 *
 * White is what makes the second rule need a guarantee of its own, and that is
 * freeThePrologue below rather than anything here — it is not really a question
 * about hall doors, as it turns out. It is a question about the first thirty
 * seconds of a floor, which hall doors made sharper and did not invent.
 */
function hallLocks(sealed, W, H, sx, sy, doors, reach, rng) {
  for (const d of rng.shuffle(doors.filter((x) => x.hall))) {
    if (rng.chance(HALL_GREY) && goesRound(sealed, W, H, sx, sy, d, reach)) {
      d.lock = 'grey';
      sealDoor(sealed, W, d);
      reach = bfs(sealed, W, H, sx, sy);
    } else {
      d.lock = 'white';
    }
  }
}

/**
 * Leave the player a way out of the lobby, and somebody to meet.
 *
 * Every other lock on this floor is fine to walk up to with nothing in your
 * pocket: you look at the reader, you go and shoot somebody, you come back.
 * White is not, because white is on EVERYTHING — so on arrival the building is
 * shut, and the only cards on the floor are in the pockets of people on the far
 * side of it. The floor has to hand you the first one.
 *
 * Nothing above proves that. The room passes prove things about the floor once
 * you hold a white card; this is the one question asked of the floor before you
 * hold anything, and the answer has to be yes on every seed. So: shut every door
 * on the floor, flood from the lifts, and if what is left is too small to stand
 * the first body in, take the reader off the doorway on the edge of it and ask
 * again. Corridor-fronting doorways go first because corridor is what
 * _cardOutside stands people in, and the nearest one goes first because the
 * point is a short prologue rather than a large one.
 *
 * It terminates in something playable by construction: freeing doorways only
 * ever grows the region, and freeing all of them is a floor with no readers on
 * it at all.
 *
 * This found a real bug the day it was written, and an old one — on about one
 * floor in seven the lobby's only doorway was shared with a neighbouring room,
 * that room's white pass badged it, and the floor began with the player sealed
 * in the lift lobby holding nothing. It had nothing to do with hall doors; it
 * needed a check that asked the question, and hall doors are what made anybody
 * ask it.
 */
// `sx`/`sy` are the tile the flood starts from; `cx`/`cy` are the spawn POINT in
// fractional tiles, which is what layout.spawn denotes and what distances are
// measured from. They are not the same number and must not be conflated.
function freeThePrologue(tiles, W, H, sx, sy, cx, cy, doors) {
  for (let guard = 0; guard <= doors.length; guard++) {
    // Every door shut except the ones already freed — an accurate model, since
    // white is about to go on everything that is still undecided.
    const shut = Uint8Array.from(tiles);
    for (const d of doors) if (!d.free) sealDoor(shut, W, d);

    const dist = bfs(shut, W, H, sx, sy);
    if (prologueRoom(tiles, W, dist, cx, cy) >= PROLOGUE_MIN) return;

    let best = null;
    let bestKey = Infinity;
    for (const d of doors) {
      if (d.free) continue;
      // A doorway already carrying a real tier is the one thing that may not be
      // freed: its room has been marked staff-only and emptied of everybody who
      // works there, and a reader on the room with none on this doorway is the
      // lock undone. Hall doors are exempt — there is no room behind them to
      // contradict.
      if (d.lock && !d.hall) continue;
      const at = doorTouching(d, W, dist);
      if (at < 0) continue;
      // Hall doors go first because freeing one costs nothing but the reader:
      // freeing a ROOM's doorway costs that room its lock entirely (see the
      // white pass), so it is the second choice, and then only where it fronts a
      // corridor. Nearest to the lifts within each group, because the point is a
      // short prologue rather than a large one.
      const rank = d.hall ? 0 : (opensOntoCorridor(d, W, tiles) ? 1e6 : 2e6);
      const key = rank + at;
      if (key >= bestKey) continue;
      best = d; bestKey = key;
    }
    if (!best) return;

    best.free = true;
    best.lock = null;
  }
}

/**
 * Corridor the player can reach on arrival and that is far enough out to stand
 * somebody in — the exact set _cardOutside will be drawing from.
 *
 * Straight-line from the lifts, not walked, because straight-line is what
 * enemies.js measures and this only means anything if the two agree. Walked
 * distance is always the larger of the two, so a guarantee written in it looks
 * satisfied while leaving nowhere legal to stand.
 */
function prologueRoom(tiles, W, dist, cx, cy) {
  const gap = FIRST_CONTACT_GAP / TILE;
  let n = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] < 0 || tiles[i] !== CORRIDOR) continue;
    // Tile CENTRE against the spawn point, in fractional tiles — the same two
    // points enemies.js puts into the same subtraction. Measuring from the
    // rounded spawn tile instead is half a tile out, which sounds like nothing
    // and moved this count by nine tiles at an eleven metre radius.
    const dx = (i % W) + 0.5 - cx;
    const dy = ((i / W) | 0) + 0.5 - cy;
    if (dx * dx + dy * dy > gap * gap) n++;
  }
  return n;
}

// Is either side of this doorway a corridor? Corridor is where the first
// card-holder stands, so it is what the prologue is counting.
function opensOntoCorridor(d, W, tiles) {
  for (let y = d.y0; y < d.y1; y++) {
    for (let x = d.x0; x < d.x1; x++) {
      const sides = d.vertical
        ? [(y * W) + x - 1, (y * W) + x + 1]
        : [((y - 1) * W) + x, ((y + 1) * W) + x];
      for (const i of sides) if (tiles[i] === CORRIDOR) return true;
    }
  }
  return false;
}

// Could you still get everywhere with this door shut? The door's own tiles are
// exempt — they are solid in the trial and are the one thing that is allowed to
// stop being reachable.
function goesRound(sealed, W, H, sx, sy, door, reach) {
  const trial = Uint8Array.from(sealed);
  sealDoor(trial, W, door);
  const after = bfs(trial, W, H, sx, sy);

  for (let i = 0; i < after.length; i++) {
    if (reach[i] >= 0 && after[i] < 0 && !doorHasTile(door, W, i)) return false;
  }
  return true;
}

/**
 * What the player can reach on arrival, holding nothing: a flood from the lifts
 * that refuses to cross any doorway with a reader on it. freeThePrologue above
 * has already guaranteed there is something out there; this is what hands the
 * region to enemies.js so it can put somebody in it.
 */
function prologueRegion(tiles, W, H, sx, sy, doors) {
  const open = Uint8Array.from(tiles);
  for (const d of doors) if (d.lock) sealDoor(open, W, d);
  return bfs(open, W, H, sx, sy);
}

// How far into the region a door's nearest tile is, or -1 if it is not on its
// edge at all. Doors are sealed in that flood, so a locked door bordering the
// region is found by its NEIGHBOURS being reachable, not its own tiles.
function doorTouching(d, W, dist) {
  let best = -1;
  for (let y = d.y0; y < d.y1; y++) {
    for (let x = d.x0; x < d.x1; x++) {
      const sides = d.vertical
        ? [(y * W) + x - 1, (y * W) + x + 1]
        : [((y - 1) * W) + x, ((y + 1) * W) + x];
      for (const i of sides) {
        if (i < 0 || i >= dist.length || dist[i] < 0) continue;
        if (best < 0 || dist[i] < best) best = dist[i];
      }
    }
  }
  return best;
}

function sealDoor(tiles, W, d) {
  for (let y = d.y0; y < d.y1; y++) {
    for (let x = d.x0; x < d.x1; x++) tiles[y * W + x] = SOLID;
  }
}

const doorHasTile = (d, W, i) => {
  const x = i % W, y = (i / W) | 0;
  return x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1;
};

// Would sealing `candidate` strand anything? Every other room has to keep a way
// in from the spawn, and so does the exit. A room already locked counts as
// reachable if any of ITS doorway tiles still is — its interior is solid in this
// model, but you will be opening that door with a card, and the door is the part
// that has to stay in front of you.
function survivesWithout(sealed, W, H, sx, sy, rooms, candidate, locks, exitRoom, ownDoors) {
  const trial = Uint8Array.from(sealed);
  fillRoom(trial, W, candidate, SOLID);

  const after = bfs(trial, W, H, sx, sy);
  const reached = (i) => after[i] >= 0;

  for (const r of rooms) {
    if (r === candidate || r.lock) continue;
    if (!reached(Math.round(r.cy) * W + Math.round(r.cx))) return false;
  }
  // The doors of everything locked, the candidate's own included — a room you
  // can never walk up to is a room whose card does nothing.
  if (!ownDoors.some((d) => anyDoorTile(d, W, reached))) return false;
  for (const lock of locks) {
    if (!lock.doors.some((d) => anyDoorTile(d, W, reached))) return false;
  }
  return reached(Math.round(exitRoom.cy) * W + Math.round(exitRoom.cx));
}

const anyDoorTile = (d, W, reached) => {
  for (let y = d.y0; y < d.y1; y++) {
    for (let x = d.x0; x < d.x1; x++) if (reached(y * W + x)) return true;
  }
  return false;
};

function fillRoom(tiles, W, room, value) {
  for (let y = room.y0; y < room.y1; y++) {
    for (let x = room.x0; x < room.x1; x++) tiles[y * W + x] = value;
  }
}

/**
 * Every doorway on a room's boundary, whoever cut it.
 *
 * A room's own `doors` list holds only the openings IT cut. The room next door
 * may well have cut its own into the same shared wall, and half a lock is no
 * lock at all — so locking a room means locking every opening that leads into
 * it, which is what this finds.
 */
function doorsOnRoom(doors, room) {
  const inside = (x, y) => x >= room.x0 && x < room.x1 && y >= room.y0 && y < room.y1;
  return doors.filter((d) => {
    for (let y = d.y0; y < d.y1; y++) {
      for (let x = d.x0; x < d.x1; x++) {
        if (d.vertical ? (inside(x - 1, y) || inside(x + 1, y))
          : (inside(x, y - 1) || inside(x, y + 1))) return true;
      }
    }
    return false;
  });
}

/**
 * One byte per tile, for anything inside a locked room or in one of its
 * doorways:
 *
 *   0  not behind a card
 *   1  behind a white door — a room people work in, so things may stand here
 *   2  behind a real lock — nobody works here, so nothing may be placed here
 *
 * The distinction is the whole safety argument for white being everywhere: a
 * white room full of staff is a white room full of white cards, whereas anything
 * dropped inside a 2 would be a key locked in with its own lock.
 */
export const STAFF_ONLY = 2;

function lockedMask(W, H, locks) {
  const mask = new Uint8Array(W * H);
  for (const { room, doors, staffOnly } of locks) {
    const v = staffOnly ? STAFF_ONLY : 1;
    for (let y = room.y0; y < room.y1; y++) {
      for (let x = room.x0; x < room.x1; x++) mask[y * W + x] = v;
    }
    for (const d of doors) {
      for (let y = d.y0; y < d.y1; y++) {
        for (let x = d.x0; x < d.x1; x++) mask[y * W + x] = v;
      }
    }
  }
  return mask;
}
