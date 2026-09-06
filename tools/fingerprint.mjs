// A fingerprint of what the generator actually produces, for proving a refactor
// changed nothing.
//
// The validators prove INVARIANTS — that a floor is connected, that no lock
// strands the exit — and a refactor can hold every one of them while quietly
// generating a different building. This hashes the output instead: the tile
// grid, every door, every room's rect and role, the locks, the stairs and the
// two lift cars, over a sweep of seeds and depths.
//
// Run it before a change and after, and diff the two files. Identical output is
// the only evidence that a "pure cleanup" was one.
//
//   node tools/fingerprint.mjs > before.txt
//   ...refactor...
//   node tools/fingerprint.mjs > after.txt
//   diff before.txt after.txt

import { generateLayout } from '../src/gen/layout.js';

const SEEDS = 40;
const FLOORS = [1, 2, 3, 5, 8, 12, 15];

// FNV-1a over a string, which is plenty for telling two floorplans apart and is
// four lines instead of a dependency.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const num = (v) => (v === undefined || v === null ? '-' : (typeof v === 'number' ? +v.toFixed(4) : v));

function describe(L) {
  const out = [];
  out.push(`W=${L.W} H=${L.H} area=${num(L.areaRatio)}`);
  out.push(`tiles=${hash(Array.from(L.tiles).join(''))}`);
  out.push(`spawn=${num(L.spawn.x)},${num(L.spawn.z)} exit=${num(L.exit.x)},${num(L.exit.z)}`);
  out.push(`prologue=${L.prologue ? L.prologue.filter(Boolean).length : '-'}`);
  for (const r of L.rooms) {
    out.push(`room ${r.x0},${r.y0},${r.x1},${r.y1} ${r.role} open=${r.open ? 1 : 0}`
      + ` lock=${r.lock ?? '-'} forced=${r.forcedRole ? 1 : 0} lift=${num(r.liftSide)}`);
  }
  for (const d of L.doors) {
    out.push(`door ${d.x0},${d.y0},${d.x1},${d.y1} v=${d.vertical ? 1 : 0}`
      + ` hall=${d.hall ? 1 : 0} lift=${d.lift ? 1 : 0} dbl=${d.double ? 1 : 0}`
      + ` free=${d.free ? 1 : 0} swing=${num(d.swing)} lock=${d.lock ?? '-'}`);
  }
  for (const l of L.locks ?? []) out.push(`lock ${l.tier} staff=${l.staffOnly ? 1 : 0} doors=${l.doors.length}`);
  for (const s of L.stairs ?? []) out.push(`stair ${JSON.stringify(s, sortKeys)}`);
  for (const [name, c] of [['arrival', L.lifts?.arrival], ['departure', L.lifts?.departure]]) {
    out.push(c
      ? `lift ${name} side=${c.side} ${c.tx0},${c.ty0},${c.tx1},${c.ty1}`
        + ` block=${c.bx0},${c.by0},${c.bx1},${c.by1} at=${num(c.x)},${num(c.z)}`
      : `lift ${name} none`);
  }
  return out.join('\n');
}

// A room object holds a back-reference to its own leaf and its doors, so a plain
// stringify would either cycle or dump the floor twice. Stairs are flat data.
function sortKeys(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((k) => typeof value[k] !== 'object' || value[k] === null)
      .map((k) => [k, num(value[k])]));
  }
  return typeof value === 'number' ? num(value) : value;
}

for (let i = 0; i < SEEDS; i++) {
  const seed = 1000 + i * 7919;
  for (const floor of FLOORS) {
    let body;
    try {
      body = describe(generateLayout(seed, floor));
    } catch (e) {
      body = `THREW ${e.message}`;
    }
    console.log(`s${seed}/f${floor} ${hash(body)}`);
  }
}
