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

  const layout = {
    seed, floorNumber, W, H, TILE,
    ox: -W * TILE / 2, oz: -H * TILE / 2,
    tiles, rooms: live, doors,
    spawnRoom, exitRoom,
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
