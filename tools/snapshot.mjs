// What this game actually produces, hashed and COMMITTED, so a regression is
// something `npm test` tells you about rather than something you go looking for.
//
//   npm test                       # ...runs this among the validators
//   node tools/snapshot.mjs        # compare against tools/baseline/, exit 1 on any change
//   node tools/snapshot.mjs --write   # accept what it produces now as the baseline
//   node tools/snapshot.mjs --plan    # one layer only (also --build, --roster)
//
// WHY THIS EXISTS ALONGSIDE THE THREE VALIDATORS. They prove INVARIANTS — a
// floor is connected, no lock strands the exit, no prop stands in a doorway —
// and a change can hold every one of them while quietly generating a different
// building or a differently-behaved roster. Neither is a bug the validators can
// see, and both are bugs.
//
// AND WHY THE BASELINE IS COMMITTED. The tool began life as a before/after diff
// you drove by hand, which works and asks you to remember to do it. A committed
// baseline inverts that: an ACCIDENTAL change fails the suite on the spot, and
// an INTENTIONAL one is `--write` plus a diff in the commit that a reviewer can
// read. The diff is the point — `tools/baseline/roster.txt` moving by four lines
// is a reviewable claim about what a change did, where a hash that merely
// differs is not.
//
// THREE LAYERS, because they fail differently and no one of them can see the
// others:
//
//  - PLAN — the tile grid, the room and door lists, the locks, the stairs and the
//    two lift cars. What gen/layout.js, gen/carve.js, gen/roles.js, gen/locks.js
//    and gen/lifts.js decide, over 280 floors. Counted and hashed rather than
//    listed, for the reason `describePlan` gives.
//  - BUILD — the colliders, the door records, the workstations and the nav grid
//    gen/build.js turns that plan into, over 24 floors. Slower, and the only
//    layer that catches a builder refactor.
//  - ROSTER — who is on the floor and what they are all doing after forty
//    seconds of the building working, over 18 floors. The layer for enemies.js,
//    rigs.js, chores.js, jobs.js and enemy-anim.js, and the other two cannot see
//    a line of it.

import fs from 'node:fs';
import path from 'node:path';
import './headless.mjs';

const { generateLayout } = await import('../src/gen/layout.js');

const DIR = path.join(import.meta.dirname, 'baseline');
const args = process.argv.slice(2);
const write = args.includes('--write');
const wanted = ['plan', 'build', 'roster'].filter((k) => args.includes(`--${k}`));

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

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

// Everything is rounded before it is written, because a change that reassociates
// one floating-point expression is not a change to the game and must not read as
// one. Four decimals is a tenth of a millimetre.
const num = (v) => (v === undefined || v === null ? '-'
  : (typeof v === 'number' ? (Math.round(v * 1e4) / 1e4) : v));

// A room holds a back-reference to its own leaf and to its doors, so a plain
// stringify would either cycle or dump the floor twice. The scalars are the part
// that means anything.
const flat = (o) => Object.keys(o).sort()
  .filter((k) => o[k] === null || typeof o[k] !== 'object')
  .map((k) => `${k}=${num(o[k])}`).join(' ');

const box = (c) => `${num(c.minX)},${num(c.minZ)},${num(c.maxX)},${num(c.maxZ)}`
  + `,${num(c.top)},${num(c.base)}`;

/**
 * Every layer is this shape: a list of (seed, floor) cases, and a function that
 * turns one case into text.
 *
 * A case that THROWS is recorded as its stack rather than crashing the sweep,
 * because a crash on floor 3 hides whatever floors 4 to 280 would have said —
 * and because a stack in the diff names the change that caused it.
 */
async function sweep(name, seeds, floors, describe) {
  const out = [];
  for (let i = 0; i < seeds; i++) {
    const seed = 1000 + i * 7919;
    for (const floor of floors) {
      let body;
      try {
        body = await describe(seed, floor);
      } catch (e) {
        body = `THREW ${e.stack}`;
      }
      out.push(`${name} s${seed}/f${floor} ${hash(body)}`);
      // The detail goes in too, so a diff says WHAT moved rather than only that
      // something did. It is the whole reason the baseline is a file of lines
      // and not a file of hashes.
      for (const line of body.split('\n')) out.push(`  ${line}`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

function describePlan(L) {
  const out = [];
  out.push(`W=${L.W} H=${L.H} area=${num(L.areaRatio)}`);
  out.push(`tiles=${hash(Array.from(L.tiles).join(''))}`);
  out.push(`spawn=${num(L.spawn.x)},${num(L.spawn.z)} exit=${num(L.exit.x)},${num(L.exit.z)}`);
  out.push(`prologue=${L.prologue ? L.prologue.filter(Boolean).length : '-'}`);
  // COUNTED AND HASHED rather than listed, which the other two layers are not.
  // 280 floors of every room and every door came to 97,000 lines and 5.4 MB —
  // too big to commit and far too big to read, so the per-item diff it was
  // bought for was never going to be looked at. A count beside a hash still
  // gives a reviewable sentence ("42 rooms became 41") and the build and roster
  // layers, which sweep 24 and 18 floors, keep their full detail.
  out.push(`rooms=${L.rooms.length} ${hash(L.rooms.map((r) =>
    `${r.x0},${r.y0},${r.x1},${r.y1},${r.role},${r.open ? 1 : 0},${r.lock ?? '-'}`
    + `,${r.forcedRole ? 1 : 0},${num(r.liftSide)}`).join(';'))}`);
  out.push(`roles=${[...new Set(L.rooms.map((r) => r.role))].sort().join(',')}`);
  out.push(`doors=${L.doors.length} ${hash(L.doors.map((d) =>
    `${d.x0},${d.y0},${d.x1},${d.y1},${d.vertical ? 1 : 0},${d.hall ? 1 : 0}`
    + `,${d.lift ? 1 : 0},${d.double ? 1 : 0},${d.free ? 1 : 0},${num(d.swing)}`
    + `,${d.lock ?? '-'}`).join(';'))}`);
  out.push(`locks=${(L.locks ?? []).map((l) => `${l.tier}${l.staffOnly ? '!' : ''}`)
    .sort().join(',')}`);
  out.push(`stairs=${(L.stairs ?? []).length} ${hash((L.stairs ?? []).map(flat).join(';'))}`);
  for (const [nm, c] of [['arrival', L.lifts?.arrival], ['departure', L.lifts?.departure]]) {
    out.push(c
      ? `lift ${nm} side=${c.side} ${c.tx0},${c.ty0},${c.tx1},${c.ty1}`
        + ` block=${c.bx0},${c.by0},${c.bx1},${c.by1} at=${num(c.x)},${num(c.z)}`
      : `lift ${nm} none`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// the build
// ---------------------------------------------------------------------------

function describeBuild(level) {
  const out = [];
  out.push(`colliders=${level.colliders.length} meshes=${level.meshes.length}`
    + ` objects=${level.objects.length} fixtures=${level.fixtures.length}`);
  out.push(`colliderHash=${hash(level.colliders.map(box).join(';'))}`);
  out.push(`dynamics=${level.dynamics.length} destructibles=${level.destructibles.length}`);

  // Doors are listed rather than hashed: they are the thing the three builders in
  // gen/doorways.js disagree about most easily, and a diff naming the door is
  // worth more than one naming the floor.
  for (const d of level.doors) {
    out.push(`door at=${num(d.x)},${num(d.z)} h=${num(d.height)} lock=${d.lock ?? '-'}`
      + ` reader=${d.reader ? 1 : 0} nav=${d.navTiles.length} col=${box(d.collider)}`
      + ` kind=${d.leaves ? 'hinged' : d.panels ? 'parting' : 'panel'}`
      + ` travel=${(d.panels ?? [d]).map((p) => num(p.travel)).join('/')}`
      + ` swing=${(d.leaves ?? []).map((l) => num(l.angleTo)).join('/')}`);
  }

  out.push(`workstations=${hash(level.workstations
    .map((w) => `${num(w.x)},${num(w.z)},${w.rot},${w.at}`).join(';'))}`);
  out.push(`stationKinds=${[...new Set(level.workstations.map((w) => w.at))].sort().join(',')}`);
  out.push(`exit=${level.exitObject ? 1 : 0} cow=${level.cow ? 1 : 0}`);
  out.push(`walk=${hash(Array.from(level.nav.walk).join(''))}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// the roster
// ---------------------------------------------------------------------------

const DT = 1 / 60;
const ROSTER_SECONDS = 40;

// A target the roster can measure against that is never in the way: at the
// origin, marked dead, so nothing sights it and no errand is interrupted. What
// is being recorded is the building WORKING, not a fight.
const DEAD = [{ x: 0, y: 0, z: 0, layer: 0, dead: true, hurt() {} }];
// ...and a silent audio bank, because `animate` voices a footfall on every
// stride and the game never runs without one.
const AUDIO = new Proxy({}, { get: () => () => {} });

/**
 * A seeded `Math.random`, and without it none of the roster layer is a snapshot
 * at all.
 *
 * Every floor is a pure function of its seed and the roster is dealt off
 * `makeRng` — but chores.js and jobs.js pick which errand and which machine with
 * a bare `Math.random()`, deliberately, because whose turn it is at the copier is
 * a runtime decision and not a fact about the building. So that half is genuinely
 * irreproducible in the game, and a snapshot of it would differ on every run for
 * no reason at all.
 *
 * Seeding it is the harness making the game deterministic in the one place it is
 * deliberately not, which is what a harness is for. It is restored afterwards so
 * nothing else in the process inherits it.
 *
 * WHERE IT IS INSTALLED IS THE WHOLE TRICK, and getting that wrong cost an
 * afternoon. Installed before `generateLayout` and `buildLevel` — the obvious
 * place, wrapping the case — it also covers the ONE-TIME lazy caches those two
 * populate: `textures.js` paints procedural canvas textures with 15 calls to
 * `Math.random` and `tech-textures.js` another 12, and they are memoised, so the
 * FIRST case in a process ate 27 draws out of the seeded stream that no later
 * case did. Everything after it shifted, and the symptom was as confusing as it
 * sounds: a snapshot that was stable across processes, stable case to case, and
 * disagreed with itself depending on whether the build layer had run first —
 * because the build layer had already warmed the textures.
 *
 * So: the caches are warmed ONCE, up front, with the real `Math.random` (see
 * `warmAssets`), and the seed is installed around the part that is supposed to
 * be seeded — the roster and the simulation — and nothing else.
 */
function seedRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paints every lazily-cached texture, material and bit of geometry in the game.
 *
 * One throwaway floor does nearly all of it — `buildLevel` reaches `getAssets`,
 * the tech textures and the whole prop catalogue — and the four things a body
 * can be holding are built by hand, because a rig only makes one the first time
 * somebody is handed a drink.
 *
 * It exists so that no case pays a one-time cost out of its own seed. It is not
 * an optimisation: it is the difference between a snapshot and a coin toss.
 */
function warmAssets(THREE, buildLevel) {
  buildLevel(new THREE.Scene(), generateLayout(1, 1));
}

function describeRoster(enemies) {
  const out = [];
  out.push(`roster=${enemies.items.length} hostile=${enemies.hostileCount}`
    + ` open=${enemies.openHostileCount} keyed=${enemies.keyedAlive}`);
  for (const e of enemies.items) {
    out.push(`${String(e.index).padStart(4)} ${e.type.name}`
      + ` at=${num(e.x)},${num(e.z)},${num(e.y)} yaw=${num(e.yaw)}`
      + ` s=${e.state} alive=${e.alive ? 1 : 0} gone=${e.gone ? 1 : 0}`
      + ` seat=${e.seat ?? '-'} chore=${e.chore?.kind ?? '-'} job=${e.jobRole ?? '-'}`
      + ` held=${[e.carry && 'crate', e.can && 'can', e.papers && 'papers',
        e.tray && 'tray', e.truck && 'truck'].filter(Boolean).join('+') || '-'}`
      + ` card=${e.card ?? '-'} break=${e.break ? 1 : 0} hp=${num(e.health)}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

const LAYERS = {
  plan: () => sweep('plan', 40, [1, 2, 3, 5, 8, 12, 15],
    (seed, floor) => describePlan(generateLayout(seed, floor))),

  build: async () => {
    const THREE = await import('three');
    const { buildLevel } = await import('../src/gen/build.js');
    return sweep('build', 8, [1, 4, 9],
      (seed, floor) => describeBuild(
        buildLevel(new THREE.Scene(), generateLayout(seed, floor))));
  },

  roster: async () => {
    const THREE = await import('three');
    const { buildLevel } = await import('../src/gen/build.js');
    const { NavGrid } = await import('../src/nav.js');
    const { Enemies } = await import('../src/enemies.js');
    const { Chores } = await import('../src/chores.js');
    const { Jobs } = await import('../src/jobs.js');
    const { makeRng } = await import('../src/gen/rng.js');
    const { tuningFor } = await import('../src/game.js');

    // Every lazily-cached texture and material in the game, painted now with the
    // REAL `Math.random`, so no case pays for them out of its seed. See
    // `seedRandom` for what this is protecting against and how it presented.
    warmAssets(THREE, buildLevel);

    return sweep('roster', 6, [1, 5, 9], (seed, floor) => {
      const layout = generateLayout(seed, floor);
      const scene = new THREE.Scene();
      const level = buildLevel(scene, layout);
      const nav = new NavGrid(level.nav);
      // The building OPEN, which is the only interesting case: almost every
      // machine is behind a badged door and a badged door is off the nav grid,
      // so a shut floor is one where nobody can reach anything.
      for (const door of level.doors) if (door.lock) nav.openTiles(door.navTiles);

      // ...and from here on it is seeded, because from here on the game is
      // making decisions rather than building geometry.
      const real = Math.random;
      Math.random = seedRandom(seed ^ floor);
      try {
        const enemies = new Enemies(scene);
        enemies.spawn(layout, nav, makeRng(seed ^ 0x51ed270b),
          tuningFor(floor, layout.areaRatio ?? 1), level.workstations);

        const chores = new Chores({ enemies, effects: null, audio: AUDIO });
        chores.spawn(nav, enemies, null);
        const jobs = new Jobs({ enemies, effects: null, audio: AUDIO });
        jobs.spawn(nav, enemies, null);

        const ctx = { targets: DEAD, effects: null, audio: AUDIO };
        for (let f = 0; f < ROSTER_SECONDS * 60; f++) {
          chores.update(DT);
          jobs.update(DT);
          enemies.update(DT, ctx);
        }
        return describeRoster(enemies);
      } finally {
        Math.random = real;
      }
    });
  },
};

// ---------------------------------------------------------------------------
// compare, or accept
// ---------------------------------------------------------------------------

const SHOW = 24;   // lines of diff to print before saying how many are left

function firstDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const out = [];
  let n = 0;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] === B[i]) continue;
    n++;
    if (out.length < SHOW) {
      out.push(`  - ${A[i] ?? '(end)'}`);
      out.push(`  + ${B[i] ?? '(end)'}`);
    }
  }
  return { text: out.join('\n'), n };
}

fs.mkdirSync(DIR, { recursive: true });
let failed = 0;

for (const [name, build] of Object.entries(LAYERS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const t0 = Date.now();
  const now = await build();
  const file = path.join(DIR, `${name}.txt`);
  const took = `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  if (write) {
    fs.writeFileSync(file, `${now}\n`);
    console.log(`WROTE  ${name.padEnd(7)} ${now.split('\n').length} lines  ${took}`);
    continue;
  }

  if (!fs.existsSync(file)) {
    console.log(`NEW    ${name.padEnd(7)} no baseline yet — run with --write  ${took}`);
    failed++;
    continue;
  }

  const was = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
  if (was === now) {
    console.log(`SAME   ${name.padEnd(7)} ${now.split('\n').length} lines  ${took}`);
    continue;
  }

  const { text, n } = firstDiff(was, now);
  console.log(`CHANGED ${name.padEnd(6)} ${n} line${n === 1 ? '' : 's'} differ  ${took}`);
  console.log(text);
  if (n > SHOW) console.log(`  ...and ${n - SHOW} more`);
  failed++;
}

if (failed && !write) {
  console.log('\nThe game does not produce what the baseline says it does.');
  console.log('If that is the point of the change: node tools/snapshot.mjs --write');
  console.log('and let the diff in tools/baseline/ be part of the commit.');
  process.exit(1);
}
