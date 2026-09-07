// Does a job on the chore table actually get done?
//
//   node tools/probe-chore.mjs packing [floors] [seconds]
//
// Three questions, and a new job can fail any of them silently — which is the
// whole reason this exists. The furnisher can publish a station nobody fits at
// (`standable` drops it from the pool with nothing to say it was ever there);
// the pool can be there and the cast never reach it, because almost every
// machine is behind a badged door and a badged door is off the nav grid; and the
// job can be cast and then never finish, which looks exactly like a job that was
// never cast.
//
// Driven at a fixed 1/60 for the reason CLAUDE.md gives about
// `requestAnimationFrame`: in a tab nobody is looking at, a body freezes.

import './headless.mjs';

const { generateLayout } = await import('../src/gen/layout.js');
const { buildLevel } = await import('../src/gen/build.js');
const { NavGrid } = await import('../src/nav.js');
const { Enemies } = await import('../src/enemies.js');
const { Chores } = await import('../src/chores.js');
const { makeRng } = await import('../src/gen/rng.js');
const { tuningFor } = await import('../src/game.js');
const THREE = await import('three');

const KIND = process.argv[2] ?? 'packing';
const FLOORS = Number(process.argv[3] ?? 10);
const SECONDS = Number(process.argv[4] ?? 120);
const DT = 1 / 60;

const DEAD = [{ x: 0, y: 0, z: 0, layer: 0, dead: true, hurt() {} }];
const AUDIO = new Proxy({}, { get: () => () => {} });
const CTX = { targets: DEAD, effects: null, audio: AUDIO };

let anyPool = 0, anyRun = 0, totalDone = 0, totalBoxes = 0;

for (let i = 0; i < FLOORS; i++) {
  const seed = 3000 + i * 7919;
  const floor = 1 + (i % 8);
  const layout = generateLayout(seed, floor);
  const level = buildLevel(new THREE.Scene(), layout);
  const nav = new NavGrid(level.nav);

  const enemies = new Enemies(new THREE.Scene());
  enemies.spawn(layout, nav, makeRng(seed ^ 0x1234),
    tuningFor(floor, layout.areaRatio ?? 1), level.workstations);
  for (const door of level.doors) if (door.lock) nav.openTiles(door.navTiles);

  const chores = new Chores({ enemies, effects: null, audio: AUDIO });
  chores.spawn(nav, enemies, null);

  // `pools` is keyed by KIND and holds the stations themselves, not the spec —
  // so what this can honestly report is how many survived `standable`, and not
  // how many the furnisher published. A column that would have to guess at the
  // `at` name prints a wrong number, which is the one thing a tool must not do.
  const pool = chores.pools.get(KIND)?.length ?? 0;

  // How many bodies get this job, and how many boxes they actually shift — a
  // `stay` that never repeats is a job that reads as one go rather than as work.
  let peak = 0, done = 0, boxes = 0;
  const seen = new Set();
  const held = new Map();
  for (let f = 0; f < SECONDS * 60; f++) {
    chores.update(DT);
    enemies.update(DT, CTX);
    let live = 0;
    for (const e of enemies.items) {
      const c = e.chore;
      if (c?.legs?.[c.leg]?.kind !== KIND && c?.kind !== KIND) continue;
      live++;
      if (!seen.has(e)) { seen.add(e); done++; }
      // A box appearing and going again is one parcel packed.
      const had = held.get(e) ?? false;
      if (had && !e.carry) boxes++;
      held.set(e, !!e.carry);
    }
    peak = Math.max(peak, live);
  }

  if (pool) anyPool++;
  if (done) anyRun++;
  totalDone += done;
  totalBoxes += boxes;
  console.log(`s${seed}/f${floor}`.padEnd(16)
    + ` usable=${String(pool).padStart(3)}`
    + `  bodies=${String(done).padStart(3)}  peak=${String(peak).padStart(2)}`
    + `  boxes=${String(boxes).padStart(3)}`);
}

console.log(`\n${anyPool}/${FLOORS} floors have a usable '${KIND}' station`);
console.log(`${anyRun}/${FLOORS} floors had somebody doing it`);
console.log(`${totalDone} bodies did it, shifting ${totalBoxes} boxes in ${SECONDS}s each`);
