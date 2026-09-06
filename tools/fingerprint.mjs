// A fingerprint of what the generator actually produces, for proving that a
// refactor changed nothing.
//
//   node tools/fingerprint.mjs > before.txt
//   ...refactor...
//   node tools/fingerprint.mjs > after.txt
//   diff before.txt after.txt
//
//   node tools/fingerprint.mjs --plan     # the floorplan only, and much quicker
//
// The validators prove INVARIANTS — that a floor is connected, that no lock
// strands the exit, that no prop stands in a doorway — and a refactor can hold
// every one of them while quietly generating a different building. This hashes
// the OUTPUT instead, which is the only evidence that a change advertised as a
// pure cleanup was one.
//
// Two layers, because they fail differently:
//
//  - The PLAN: the tile grid, every door, every room's rect and role, the locks,
//    the stairs and the two lift cars. This is what gen/layout.js, gen/locks.js
//    and gen/lifts.js decide, and it is cheap enough to sweep 280 floors of.
//  - The BUILD: the colliders, the door records, the workstations and the
//    destructibles that gen/build.js turns that plan into. Slower, so it sweeps
//    fewer floors — but it is the layer that catches a builder refactor, and the
//    plan cannot see it at all.

import './headless.mjs';

const { generateLayout } = await import('../src/gen/layout.js');

const planOnly = process.argv.includes('--plan');
const PLAN_SEEDS = 40;
const PLAN_FLOORS = [1, 2, 3, 5, 8, 12, 15];
const BUILD_SEEDS = 8;
const BUILD_FLOORS = [1, 4, 9];

// FNV-1a over a string, which is plenty for telling two buildings apart and is
// four lines instead of a dependency.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Everything is rounded before it is hashed, because a refactor that reassociates
// one floating-point expression is not a change to the building and should not
// read as one.
const num = (v) => (v === undefined || v === null ? '-'
  : (typeof v === 'number' ? (Math.round(v * 1e4) / 1e4) : v));

function describePlan(L) {
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
  for (const s of L.stairs ?? []) out.push(`stair ${flat(s)}`);
  for (const [name, c] of [['arrival', L.lifts?.arrival], ['departure', L.lifts?.departure]]) {
    out.push(c
      ? `lift ${name} side=${c.side} ${c.tx0},${c.ty0},${c.tx1},${c.ty1}`
        + ` block=${c.bx0},${c.by0},${c.bx1},${c.by1} at=${num(c.x)},${num(c.z)}`
      : `lift ${name} none`);
  }
  return out.join('\n');
}

// A room holds a back-reference to its own leaf and to its doors, so a plain
// stringify would either cycle or dump the floor twice. The scalars are the part
// that means anything here.
function flat(o) {
  return Object.keys(o).sort()
    .filter((k) => o[k] === null || typeof o[k] !== 'object')
    .map((k) => `${k}=${num(o[k])}`).join(' ');
}

function describeBuild(level) {
  const out = [];
  const box = (c) => `${num(c.minX)},${num(c.minZ)},${num(c.maxX)},${num(c.maxZ)}`
    + `,${num(c.top)},${num(c.base)}`;

  out.push(`colliders=${level.colliders.length} meshes=${level.meshes.length}`
    + ` objects=${level.objects.length} fixtures=${level.fixtures.length}`);
  out.push(`colliderHash=${hash(level.colliders.map(box).join(';'))}`);
  out.push(`dynamics=${level.dynamics.length} destructibles=${level.destructibles.length}`);

  // Doors are listed rather than hashed: they are the thing three builders in
  // gen/build.js disagree about most easily, and a diff naming the door is worth
  // more than a diff naming the floor.
  for (const d of level.doors) {
    out.push(`door at=${num(d.x)},${num(d.z)} h=${num(d.height)} lock=${d.lock ?? '-'}`
      + ` reader=${d.reader ? 1 : 0} nav=${d.navTiles.length} col=${box(d.collider)}`
      + ` kind=${d.leaves ? 'hinged' : d.panels ? 'parting' : 'panel'}`
      + ` travel=${(d.panels ?? [d]).map((p) => num(p.travel)).join('/')}`
      + ` swing=${(d.leaves ?? []).map((l) => num(l.angleTo)).join('/')}`);
  }

  out.push(`workstations=${hash(level.workstations
    .map((w) => `${num(w.x)},${num(w.z)},${w.rot},${w.at}`).join(';'))}`);
  out.push(`exit=${level.exitObject ? 1 : 0} cow=${level.cow ? 1 : 0}`);
  out.push(`walk=${hash(Array.from(level.nav.walk).join(''))}`);
  return out.join('\n');
}

for (let i = 0; i < PLAN_SEEDS; i++) {
  const seed = 1000 + i * 7919;
  for (const floor of PLAN_FLOORS) {
    let body;
    try {
      body = describePlan(generateLayout(seed, floor));
    } catch (e) {
      body = `THREW ${e.message}`;
    }
    console.log(`plan s${seed}/f${floor} ${hash(body)}`);
  }
}

if (!planOnly) {
  const THREE = await import('three');
  const { buildLevel } = await import('../src/gen/build.js');

  for (let i = 0; i < BUILD_SEEDS; i++) {
    const seed = 1000 + i * 7919;
    for (const floor of BUILD_FLOORS) {
      let body;
      try {
        body = describeBuild(buildLevel(new THREE.Scene(), generateLayout(seed, floor)));
      } catch (e) {
        body = `THREW ${e.stack}`;
      }
      console.log(`build s${seed}/f${floor} ${hash(body)}`);
      // The per-door lines go out too, so a diff says which door moved rather
      // than only that the floor did.
      for (const line of body.split('\n')) console.log(`  ${line}`);
    }
  }
}
