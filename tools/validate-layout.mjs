// Headless QA harness for the procedural floorplan generator.
//
//   node tools/validate-layout.mjs                 # full sweep + summary
//   node tools/validate-layout.mjs --seeds 60      # seeds per floor (default 30)
//   node tools/validate-layout.mjs --dump 7 3      # ASCII map for seed 7, floor 3
//
// generateLayout is pure — no DOM, no Three.js — so the whole sweep runs in
// plain Node with no bundler in the loop.
//
// Two severities:
//   FAIL — a hard invariant the game depends on (unwinnable floor, broken mesh).
//   WARN — the floor still works but the generation quality is off.

import { generateLayout, TILE, SOLID, ROOM, CORRIDOR, DOOR, isOpen } from '../src/gen/layout.js';

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};

const SEEDS_PER_FLOOR = Number(argVal('--seeds', 30));
const FLOORS = 15;
const MAX_EXAMPLES = 6;
const PAD = 2;            // must match layout.js
const MAX_ROOM_DEPTH = 2; // rooms deeper than this from a corridor are a WARN

// ---------------------------------------------------------------------------
// check bookkeeping
// ---------------------------------------------------------------------------

class Check {
  constructor(id, sev, title) {
    this.id = id; this.sev = sev; this.title = title;
    this.runs = 0; this.fails = 0; this.examples = []; this.notes = new Map();
  }
  run() { this.runs++; }
  fail(caseId, note) {
    this.fails++;
    if (this.examples.length < MAX_EXAMPLES) this.examples.push(caseId);
    if (note) this.notes.set(note, (this.notes.get(note) || 0) + 1);
  }
}

const checks = new Map();
const check = (id) => checks.get(id);

// Declared up front so a check that never fires still prints a PASS line.
const IDS = [
  ['0.crash', 'FAIL', 'CRASH         generateLayout threw'],
  ['1.connectivity', 'FAIL', 'CONNECTIVITY  all open tiles reachable from spawn'],
  ['1.room-reach', 'FAIL', 'CONNECTIVITY  every room interior tile reachable'],
  ['1.corridor-reach', 'FAIL', 'CONNECTIVITY  every corridor tile reachable'],
  ['2.exit-open', 'FAIL', 'EXIT          exit tile is open floor'],
  ['2.exit-reach', 'FAIL', 'EXIT          exit reachable from spawn'],
  ['2.exit-distinct', 'FAIL', 'EXIT          exit room is not the spawn room'],
  ['2.exit-near', 'WARN', 'EXIT          exit at least 15 m walk from spawn'],
  ['2.exit-far', 'WARN', 'EXIT          exit at most 150 m walk from spawn'],
  ['3.spawn-open', 'FAIL', 'SPAWN         spawn tile is open floor'],
  ['3.spawn-inroom', 'FAIL', 'SPAWN         spawn point lies inside its spawnRoom'],
  ['4.border', 'FAIL', 'NO LEAKS      no open tile on the grid border'],
  ['4.shell', 'FAIL', 'NO LEAKS      exterior shell at least PAD tiles thick'],
  ['5.room-door', 'FAIL', 'ROOM          every room has >= 1 door'],
  ['5.room-overlap', 'FAIL', 'ROOM          room interiors do not overlap each other'],
  ['5.room-tiles', 'FAIL', 'ROOM          every room interior tile has value ROOM(1)'],
  ['5.room-corridor', 'WARN', 'ROOM          every room has a door onto a corridor'],
  ['5.room-depth', 'WARN', `ROOM          no room more than ${MAX_ROOM_DEPTH} rooms deep from a corridor`],
  ['6.door-thickness', 'FAIL', 'DOOR          opening is exactly 1 tile thick'],
  ['6.door-width', 'FAIL', 'DOOR          opening is exactly 3 tiles wide'],
  ['6.door-tiles', 'FAIL', 'DOOR          all door tiles have value DOOR(3)'],
  ['6.door-bothsides', 'FAIL', 'DOOR          open floor on BOTH sides of the opening'],
  ['6.door-dead', 'FAIL', 'DOOR          doors[] holds no doors sealed on both sides'],
  ['6.door-reachable', 'FAIL', 'DOOR          door tiles reachable from spawn'],
  ['6.door-corner', 'FAIL', 'DOOR          opening is not in a corner (wall at both ends)'],
  ['6.door-abut', 'FAIL', 'DOOR          no two doors merge into one wider opening'],
  ['7.zero-rooms', 'FAIL', 'DEGENERATE    floor has 0 rooms'],
  ['7.one-room', 'FAIL', 'DEGENERATE    floor has 1 room'],
  ['7.walkable', 'FAIL', 'DEGENERATE    walkable area >= 15% of footprint'],
  ['7.roles', 'WARN', 'DEGENERATE    all four flavour roles present'],
];
for (const [id, sev, title] of IDS) checks.set(id, new Check(id, sev, title));

// ---------------------------------------------------------------------------
// tile helpers — deliberately NOT reusing layout.js's own bfs, so a bug in the
// generator's flood fill cannot hide itself from the validator.
// ---------------------------------------------------------------------------

function flood(tiles, W, H, sx, sy, accept) {
  const dist = new Int32Array(W * H).fill(-1);
  const start = sy * W + sx;
  if (!accept(tiles[start])) return dist;
  const q = new Int32Array(W * H);
  let head = 0, tail = 0;
  dist[start] = 0; q[tail++] = start;
  while (head < tail) {
    const i = q[head++], x = i % W, y = (i / W) | 0, d = dist[i] + 1;
    if (x > 0 && dist[i - 1] < 0 && accept(tiles[i - 1])) { dist[i - 1] = d; q[tail++] = i - 1; }
    if (x < W - 1 && dist[i + 1] < 0 && accept(tiles[i + 1])) { dist[i + 1] = d; q[tail++] = i + 1; }
    if (y > 0 && dist[i - W] < 0 && accept(tiles[i - W])) { dist[i - W] = d; q[tail++] = i - W; }
    if (y < H - 1 && dist[i + W] < 0 && accept(tiles[i + W])) { dist[i + W] = d; q[tail++] = i + W; }
  }
  return dist;
}

// Connected components of open tiles, with a per-kind census so an orphan can
// be described ("12 tiles, all DOOR" reads very differently from "a lost room").
function openComponents(tiles, W, H) {
  const comp = new Int32Array(W * H).fill(-1);
  const comps = [];
  const q = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (comp[s] >= 0 || !isOpen(tiles[s])) continue;
    const c = { id: comps.length, size: 0, kinds: { 1: 0, 2: 0, 3: 0 }, sample: [s % W, (s / W) | 0] };
    let head = 0, tail = 0;
    comp[s] = c.id; q[tail++] = s;
    while (head < tail) {
      const i = q[head++], x = i % W, y = (i / W) | 0;
      c.size++; c.kinds[tiles[i]]++;
      const push = (j) => { if (comp[j] < 0 && isOpen(tiles[j])) { comp[j] = c.id; q[tail++] = j; } };
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
    }
    comps.push(c);
  }
  return { comp, comps };
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const fmt = (n, d = 1) => Number(n).toFixed(d);
// Spreading a 100k-element array into Math.min blows the stack — fold instead.
const lo = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
const hi = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const hist = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' ');

// ---------------------------------------------------------------------------
// aggregate stats
// ---------------------------------------------------------------------------

const stats = {
  roomCounts: [], roomAreas: [], roomMinDim: [], roomAspect: [],
  corridorShare: [], walkableShare: [], doorCounts: [], doorsPerRoom: [],
  exitDist: [], roles: new Map(), roleBranch: { openplan85: 0, mid40: 0, longThin: 0, small: 0 },
  depth: new Map(), vCorr: new Map(), hCorr: new Map(),
  abutPairs: 0, deadDoors: 0, alcoveDoors: 0, totalDoors: 0,
  orphanTiles: [], noCorridorRooms: 0, totalRooms: 0,
};

// ---------------------------------------------------------------------------
// per-layout validation
// ---------------------------------------------------------------------------

function validate(seed, floorNumber) {
  const id = `s${seed}/f${floorNumber}`;
  const L = generateLayout(seed, floorNumber);
  const { W, H, tiles, rooms, doors, ox, oz } = L;
  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const T = (x, y) => (inb(x, y) ? tiles[idx(x, y)] : SOLID);
  const tx = (wx) => Math.floor((wx - ox) / TILE);
  const ty = (wz) => Math.floor((wz - oz) / TILE);

  for (const [cid] of IDS) if (cid !== '0.crash') check(cid).run();

  // ---- 3. spawn sanity ----------------------------------------------------
  const sx = tx(L.spawn.x), sy = ty(L.spawn.z);
  const spawnOpen = inb(sx, sy) && isOpen(T(sx, sy));
  if (!spawnOpen) check('3.spawn-open').fail(id, `spawn tile (${sx},${sy}) = ${inb(sx, sy) ? T(sx, sy) : 'oob'}`);
  const sr = L.spawnRoom;
  if (!(sx >= sr.x0 && sx < sr.x1 && sy >= sr.y0 && sy < sr.y1)) {
    check('3.spawn-inroom').fail(id, 'spawn point outside its own spawnRoom bounds');
  }

  // ---- 1. connectivity ----------------------------------------------------
  const dist = spawnOpen ? flood(tiles, W, H, sx, sy, isOpen) : new Int32Array(W * H).fill(-1);
  const { comps } = openComponents(tiles, W, H);
  const openTotal = comps.reduce((s, c) => s + c.size, 0);
  let reached = 0;
  for (let i = 0; i < W * H; i++) if (dist[i] >= 0) reached++;
  const orphan = openTotal - reached;
  if (orphan > 0) {
    const stray = comps.filter((c) => dist[idx(c.sample[0], c.sample[1])] < 0);
    const shapes = [...new Set(stray.map((c) => `${c.size}t[R${c.kinds[1]}/C${c.kinds[2]}/D${c.kinds[3]}]`))];
    check('1.connectivity').fail(id, `${stray.length} orphan region(s), ${orphan} tiles; ${shapes.slice(0, 3).join(' ')}`);
    stats.orphanTiles.push(orphan);
  }

  let unreachableRoomTiles = 0;
  for (const r of rooms) {
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (dist[idx(x, y)] < 0) unreachableRoomTiles++;
  }
  if (unreachableRoomTiles) check('1.room-reach').fail(id, `${unreachableRoomTiles} room interior tiles unreachable`);

  let unreachableCorridor = 0;
  for (let i = 0; i < W * H; i++) if (tiles[i] === CORRIDOR && dist[i] < 0) unreachableCorridor++;
  if (unreachableCorridor) check('1.corridor-reach').fail(id, `${unreachableCorridor} corridor tiles unreachable`);

  // ---- 2. exit ------------------------------------------------------------
  const ex = tx(L.exit.x), ey = ty(L.exit.z);
  if (!(inb(ex, ey) && isOpen(T(ex, ey)))) check('2.exit-open').fail(id, `exit tile (${ex},${ey}) not open`);
  const dExit = inb(ex, ey) ? dist[idx(ex, ey)] : -1;
  if (dExit < 0) check('2.exit-reach').fail(id, 'exit not reachable from spawn');
  else stats.exitDist.push(dExit * TILE);
  if (L.exitRoom === L.spawnRoom) check('2.exit-distinct').fail(id, 'exitRoom === spawnRoom');
  if (dExit >= 0 && dExit * TILE < 15) check('2.exit-near').fail(id, `exit only ${fmt(dExit * TILE)} m from spawn`);
  if (dExit * TILE > 150) check('2.exit-far').fail(id, `exit ${fmt(dExit * TILE)} m from spawn`);

  // ---- 4. leaks -----------------------------------------------------------
  // NOTE: the "flood SOLID from (0,0)" formulation is vacuous for this
  // generator — interior walls are one tile thick and structurally contiguous
  // with the exterior shell, so the solid flood covers every wall in the
  // building. The meaningful invariants are (a) no open tile on the border and
  // (b) the shell is at least PAD tiles thick everywhere, which together mean
  // the outside can never see in.
  let borderOpen = 0;
  for (let x = 0; x < W; x++) { if (isOpen(T(x, 0))) borderOpen++; if (isOpen(T(x, H - 1))) borderOpen++; }
  for (let y = 0; y < H; y++) { if (isOpen(T(0, y))) borderOpen++; if (isOpen(T(W - 1, y))) borderOpen++; }
  if (borderOpen) check('4.border').fail(id, `${borderOpen} open tiles on the grid border`);

  let thinShell = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isOpen(T(x, y))) continue;
      if (x < PAD || y < PAD || x >= W - PAD || y >= H - PAD) thinShell++;
    }
  }
  if (thinShell) check('4.shell').fail(id, `${thinShell} open tiles inside the ${PAD}-tile exterior shell`);

  // ---- 5. rooms -----------------------------------------------------------
  const doorless = rooms.filter((r) => !r.doors || r.doors.length === 0).length;
  if (doorless) check('5.room-door').fail(id, `${doorless} rooms with no door`);

  const owner = new Int32Array(W * H).fill(-1);
  let overlap = 0, badTiles = 0, corridorOverlap = 0;
  rooms.forEach((r, ri) => {
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = idx(x, y);
        if (owner[i] >= 0) overlap++; else owner[i] = ri;
        if (tiles[i] !== ROOM) { badTiles++; if (tiles[i] === CORRIDOR) corridorOverlap++; }
      }
    }
  });
  if (overlap) check('5.room-overlap').fail(id, `${overlap} tiles claimed by 2+ rooms`);
  if (badTiles) check('5.room-tiles').fail(id, `${badTiles} interior tiles not ROOM (${corridorOverlap} CORRIDOR)`);

  // Room adjacency graph via doors: which rooms front a corridor, and how deep
  // the rest sit behind them.
  const adj = rooms.map(() => new Set());
  const onCorridor = new Array(rooms.length).fill(false);
  rooms.forEach((r, ri) => {
    for (const d of r.doors) {
      for (let y = d.y0; y < d.y1; y++) {
        for (let x = d.x0; x < d.x1; x++) {
          const ns = d.vertical ? [[x - 1, y], [x + 1, y]] : [[x, y - 1], [x, y + 1]];
          for (const [nx, ny] of ns) {
            if (T(nx, ny) === CORRIDOR) onCorridor[ri] = true;
            const o = inb(nx, ny) ? owner[idx(nx, ny)] : -1;
            if (o >= 0 && o !== ri) { adj[ri].add(o); adj[o].add(ri); }
          }
        }
      }
    }
  });
  const depth = new Array(rooms.length).fill(-1);
  const q = [];
  rooms.forEach((_, ri) => { if (onCorridor[ri]) { depth[ri] = 0; q.push(ri); } });
  for (let h = 0; h < q.length; h++) for (const o of adj[q[h]]) if (depth[o] < 0) { depth[o] = depth[q[h]] + 1; q.push(o); }

  const noCorr = onCorridor.filter((v) => !v).length;
  stats.noCorridorRooms += noCorr;
  stats.totalRooms += rooms.length;
  if (noCorr) check('5.room-corridor').fail(id, `${noCorr}/${rooms.length} rooms only reachable through another room`);
  const deep = depth.filter((d) => d > MAX_ROOM_DEPTH || d < 0).length;
  const maxDepth = Math.max(0, hi(depth));
  if (deep) check('5.room-depth').fail(id, `${deep} rooms deeper than ${MAX_ROOM_DEPTH} (max depth ${maxDepth})`);
  for (const d of depth) stats.depth.set(d, (stats.depth.get(d) || 0) + 1);

  // ---- 6. doors -----------------------------------------------------------
  let thick = 0, wrongW = 0, notDoor = 0, oneSided = 0, cornered = 0, unreach = 0, dead = 0;
  for (const d of doors) {
    const w = d.x1 - d.x0, h = d.y1 - d.y0;
    stats.totalDoors++;
    if (d.vertical ? w !== 1 : h !== 1) thick++;
    if ((d.vertical ? h : w) !== 3) wrongW++;

    let sideA = 0, sideB = 0, tilesOk = true, anyReach = false;
    for (let y = d.y0; y < d.y1; y++) {
      for (let x = d.x0; x < d.x1; x++) {
        if (T(x, y) !== DOOR) tilesOk = false;
        if (dist[idx(x, y)] >= 0) anyReach = true;
        if (isOpen(d.vertical ? T(x - 1, y) : T(x, y - 1))) sideA++;
        if (isOpen(d.vertical ? T(x + 1, y) : T(x, y + 1))) sideB++;
      }
    }
    if (!tilesOk) notDoor++;
    if (sideA === 0 && sideB === 0) { dead++; }
    else if (sideA === 0 || sideB === 0) { oneSided++; stats.alcoveDoors++; }
    if (!anyReach) unreach++;

    // A real opening has wall at both ends of its span; if both ends are open
    // the "wall" between two rooms has effectively vanished.
    const capA = d.vertical ? T(d.x0, d.y0 - 1) : T(d.x0 - 1, d.y0);
    const capB = d.vertical ? T(d.x0, d.y1) : T(d.x1, d.y0);
    if (isOpen(capA) && isOpen(capB)) cornered++;
  }
  stats.deadDoors += dead;

  // Two doors on the same wall line whose spans touch => one merged opening
  // with a stray door frame rendered inside it.
  const byWall = new Map();
  for (const d of doors) {
    const k = d.vertical ? `v${d.x0}` : `h${d.y0}`;
    if (!byWall.has(k)) byWall.set(k, []);
    byWall.get(k).push(d);
  }
  let abut = 0;
  for (const [, list] of byWall) {
    list.sort((p, r) => (p.vertical ? p.y0 - r.y0 : p.x0 - r.x0));
    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1], r = list[i];
      if ((r.vertical ? r.y0 : r.x0) <= (p.vertical ? p.y1 : p.x1)) abut++;
    }
  }
  stats.abutPairs += abut;

  if (thick) check('6.door-thickness').fail(id, `${thick} doors not 1 tile thick`);
  if (wrongW) check('6.door-width').fail(id, `${wrongW} doors not 3 tiles wide`);
  if (notDoor) check('6.door-tiles').fail(id, `${notDoor} doors whose tiles are not DOOR`);
  if (oneSided) check('6.door-bothsides').fail(id, `${oneSided} doors with solid on one side`);
  if (dead) check('6.door-dead').fail(id, `${dead} doors walled in on both sides`);
  if (unreach) check('6.door-reachable').fail(id, `${unreach} doors entirely unreachable from spawn`);
  if (cornered) check('6.door-corner').fail(id, `${cornered} doors with open floor at both ends (no frame)`);
  if (abut) check('6.door-abut').fail(id, `${abut} pairs of doors merged into one opening`);

  // ---- 7. degenerate ------------------------------------------------------
  if (rooms.length === 0) check('7.zero-rooms').fail(id, 'no rooms at all');
  if (rooms.length === 1) check('7.one-room').fail(id, 'single room floor');

  let openCount = 0, corridorCount = 0;
  for (let i = 0; i < W * H; i++) { if (isOpen(tiles[i])) openCount++; if (tiles[i] === CORRIDOR) corridorCount++; }
  const walkShare = openCount / (W * H);
  if (walkShare < 0.15) check('7.walkable').fail(id, `walkable ${fmt(walkShare * 100)}% of footprint`);

  const roleSet = new Set(rooms.map((r) => r.role));
  const missing = ['storage', 'copyroom', 'server', 'breakroom'].filter((r) => !roleSet.has(r));
  if (missing.length) check('7.roles').fail(id, `missing roles: ${missing.join(',')}`);

  // ---- 8. stats -----------------------------------------------------------
  stats.roomCounts.push(rooms.length);
  stats.corridorShare.push(corridorCount / (W * H));
  stats.walkableShare.push(walkShare);
  stats.doorCounts.push(doors.length);
  for (const r of rooms) {
    stats.roomAreas.push(r.areaM2);
    stats.roomMinDim.push(Math.min(r.wTiles, r.hTiles) * TILE);
    stats.roomAspect.push(Math.max(r.wTiles, r.hTiles) / Math.min(r.wTiles, r.hTiles));
    stats.doorsPerRoom.push(r.doors.length);
    stats.roles.set(r.role, (stats.roles.get(r.role) || 0) + 1);
    // Which branch of assignRoles() this room's shape lands in.
    const long = Math.max(r.wTiles, r.hTiles) / Math.min(r.wTiles, r.hTiles);
    if (r.areaM2 > 85) stats.roleBranch.openplan85++;
    else if (r.areaM2 > 40) stats.roleBranch.mid40++;
    else if (long > 2.1) stats.roleBranch.longThin++;
    else stats.roleBranch.small++;
  }

  // Corridor spine width: how many full-height / full-width corridor lines.
  let vTiles = 0, hTiles = 0;
  for (let x = 0; x < W; x++) {
    let full = true;
    for (let y = PAD; y < H - PAD; y++) if (tiles[y * W + x] !== CORRIDOR && tiles[y * W + x] !== DOOR) { full = false; break; }
    if (full) vTiles++;
  }
  for (let y = 0; y < H; y++) {
    let full = true;
    for (let x = PAD; x < W - PAD; x++) if (tiles[y * W + x] !== CORRIDOR && tiles[y * W + x] !== DOOR) { full = false; break; }
    if (full) hTiles++;
  }
  const nv = Math.round(vTiles / 6), nh = Math.round(hTiles / 6);
  stats.vCorr.set(nv, (stats.vCorr.get(nv) || 0) + 1);
  stats.hCorr.set(nh, (stats.hCorr.get(nh) || 0) + 1);
}

// ---------------------------------------------------------------------------
// ASCII dump for eyeballing a specific seed
// ---------------------------------------------------------------------------

function dump(seed, floorNumber) {
  const L = generateLayout(seed, floorNumber);
  const { W, H, tiles, ox, oz } = L;
  const sx = Math.floor((L.spawn.x - ox) / TILE), sy = Math.floor((L.spawn.z - oz) / TILE);
  const ex = Math.floor((L.exit.x - ox) / TILE), ey = Math.floor((L.exit.z - oz) / TILE);
  const dist = flood(tiles, W, H, sx, sy, isOpen);
  const glyph = { [SOLID]: '#', [ROOM]: '.', [CORRIDOR]: ':', [DOOR]: '+' };
  console.log(`\n--- seed ${seed} floor ${floorNumber}  ${W}x${H}  rooms=${L.rooms.length} doors=${L.doors.length}`);
  console.log('    # solid  . room  : corridor  + door  ? OPEN BUT UNREACHABLE  S spawn  X exit');
  for (let y = 0; y < H; y++) {
    let line = '';
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x === sx && y === sy) { line += 'S'; continue; }
      if (x === ex && y === ey) { line += 'X'; continue; }
      line += isOpen(tiles[i]) && dist[i] < 0 ? '?' : glyph[tiles[i]];
    }
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

if (args.includes('--dump')) {
  const i = args.indexOf('--dump');
  dump(Number(args[i + 1] ?? 1), Number(args[i + 2] ?? 1));
  process.exit(0);
}

const t0 = Date.now();
let cases = 0;
const runOne = (seed, floor) => {
  try { validate(seed >>> 0, floor); } catch (e) {
    check('0.crash').run();
    check('0.crash').fail(`s${seed >>> 0}/f${floor}`, `${e.name}: ${e.message}`);
  }
  cases++;
};

for (let floor = 1; floor <= FLOORS; floor++) {
  // Seeds spread over the 32-bit space — the game seeds from Math.random().
  for (let s = 1; s <= SEEDS_PER_FLOOR; s++) runOne(((s * 2654435761) >>> 0) ^ (floor * 40503), floor);
  // Plus a block of small human-typeable seeds, easier to repro by hand.
  for (let s = 1; s <= 10; s++) runOne(s + floor * 1000, floor);
}

const line = '='.repeat(80);
console.log(line);
console.log(`FLOORPLAN VALIDATOR — ${cases} layouts, floors 1..${FLOORS}, ${Date.now() - t0} ms`);
console.log(line);

let hardFails = 0, warns = 0;
for (const [, c] of checks) {
  if (c.runs === 0 && c.fails === 0) continue;
  const ok = c.fails === 0;
  if (!ok) { if (c.sev === 'FAIL') hardFails++; else warns++; }
  const pct = c.runs ? fmt((c.fails / c.runs) * 100) : '0.0';
  const tag = ok ? 'PASS' : c.sev;
  console.log(`${tag}  ${c.title.padEnd(60)} ${String(c.fails).padStart(4)}/${String(c.runs).padEnd(4)} (${pct}%)`);
  if (!ok) {
    console.log(`      repro: ${c.examples.join('  ')}`);
    for (const [note, n] of [...c.notes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      console.log(`      x${String(n).padStart(4)}  ${note}`);
    }
  }
}

console.log(line);
console.log('STATS');
console.log(line);
const rc = stats.roomCounts, ra = stats.roomAreas;
console.log(`rooms / floor       min ${lo(rc)}  median ${median(rc)}  mean ${fmt(mean(rc))}  max ${hi(rc)}`);
console.log(`room area m2        min ${fmt(lo(ra))}  median ${fmt(median(ra))}  mean ${fmt(mean(ra))}  max ${fmt(hi(ra))}`);
console.log(`room short side m   min ${fmt(lo(stats.roomMinDim))}  median ${fmt(median(stats.roomMinDim))}  max ${fmt(hi(stats.roomMinDim))}`);
console.log(`room aspect ratio   median ${fmt(median(stats.roomAspect), 2)}  max ${fmt(hi(stats.roomAspect), 2)}`);
console.log(`corridor share      min ${fmt(lo(stats.corridorShare) * 100)}%  mean ${fmt(mean(stats.corridorShare) * 100)}%  max ${fmt(hi(stats.corridorShare) * 100)}%`);
console.log(`walkable share      min ${fmt(lo(stats.walkableShare) * 100)}%  mean ${fmt(mean(stats.walkableShare) * 100)}%  max ${fmt(hi(stats.walkableShare) * 100)}%`);
console.log(`doors / floor       min ${lo(stats.doorCounts)}  median ${median(stats.doorCounts)}  mean ${fmt(mean(stats.doorCounts))}  max ${hi(stats.doorCounts)}`);
console.log(`doors / room        min ${lo(stats.doorsPerRoom)}  median ${median(stats.doorsPerRoom)}  mean ${fmt(mean(stats.doorsPerRoom), 2)}  max ${hi(stats.doorsPerRoom)}`);
if (stats.exitDist.length) {
  console.log(`exit walk distance  min ${fmt(lo(stats.exitDist))} m  median ${fmt(median(stats.exitDist))} m  max ${fmt(hi(stats.exitDist))} m`);
}
console.log(`corridor spine      vertical count ${hist(stats.vCorr)}   horizontal count ${hist(stats.hCorr)}`);
console.log(`room depth from corridor  ${hist(stats.depth)}   (${stats.noCorridorRooms}/${stats.totalRooms} = ${fmt(100 * stats.noCorridorRooms / stats.totalRooms)}% have no corridor door)`);
console.log(`door pathologies    ${stats.abutPairs} merged/abutting pairs, ${stats.deadDoors} sealed both sides, ${stats.alcoveDoors} open on one side only (of ${stats.totalDoors})`);
if (stats.orphanTiles.length) {
  console.log(`orphan open tiles   ${stats.orphanTiles.length} floors, ${stats.orphanTiles.reduce((a, b) => a + b, 0)} tiles, worst floor ${hi(stats.orphanTiles)}`);
}
const rb = stats.roleBranch;
console.log(`assignRoles branches  areaM2>85 ${rb.openplan85}   >40 ${rb.mid40}   aspect>2.1 ${rb.longThin}   small ${rb.small}`);
const roleTotal = [...stats.roles.values()].reduce((a, b) => a + b, 0);
console.log('role distribution   ' + [...stats.roles.entries()].sort((a, b) => b[1] - a[1])
  .map(([r, n]) => `${r} ${n} (${fmt((n / roleTotal) * 100)}%)`).join('  '));

console.log(line);
console.log(hardFails === 0
  ? `RESULT: all hard invariants PASS — ${warns} quality warning(s)`
  : `RESULT: ${hardFails} HARD FAILURE(S), ${warns} warning(s)`);
process.exit(hardFails === 0 ? 0 : 1);
