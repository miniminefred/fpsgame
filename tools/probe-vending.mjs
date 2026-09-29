// Do the drinks machines empty, and does anybody fill them back up?
//
//   node tools/probe-vending.mjs [floors] [seconds]
//
// Drives the roster at a fixed 1/60 with the building open (the chore table only
// really runs once a white card has opened the floor) and reports, per floor:
// how many cans the staff bought, how many restock errands were cast and how many
// finished, and how full the machines were at the start and the end.

import './headless.mjs';

const { generateLayout } = await import('../src/gen/layout.js');
const { buildLevel } = await import('../src/gen/build.js');
const { NavGrid } = await import('../src/nav.js');
const { Enemies } = await import('../src/enemies.js');
const { Chores } = await import('../src/chores.js');
const { Vending } = await import('../src/vending.js');
const { makeRng } = await import('../src/gen/rng.js');
const { tuningFor } = await import('../src/game.js');
const THREE = await import('three');

const FLOORS = Number(process.argv[2] ?? 6);
const SECONDS = Number(process.argv[3] ?? 600);
const DT = 1 / 60;
const DEAD = [{ x: 0, y: 0, z: 0, layer: 0, dead: true, hurt() {} }];
const AUDIO = new Proxy({}, { get: () => () => {} });
const CTX = { targets: DEAD, effects: null, audio: AUDIO };

const tot = { bought: 0, cast: 0, done: 0, refilled: 0, machines: 0 };
for (let i = 0; i < FLOORS; i++) {
  const seed = 7000 + i * 7919;
  const floor = 1 + (i % 9);
  const layout = generateLayout(seed, floor);
  const level = buildLevel(new THREE.Scene(), layout);
  const nav = new NavGrid(level.nav);
  const enemies = new Enemies(new THREE.Scene());
  enemies.spawn(layout, nav, makeRng(seed ^ 0x1234),
    tuningFor(floor, layout.areaRatio ?? 1), level.workstations);
  for (const door of level.doors) if (door.lock) nav.openTiles(door.navTiles);

  const vending = new Vending();
  vending.setLevel(level);
  const chores = new Chores({ enemies, effects: null, audio: AUDIO });
  chores.spawn(nav, enemies, null);
  chores.vending = vending;

  const fill = () => vending.machines.reduce((t, m) => t + vending.left(m), 0);
  const cap = vending.machines.reduce((t, m) => t + m.slots.length, 0);
  const start = fill();
  let bought = 0, refilled = 0;
  const take = vending.take.bind(vending), restock = vending.restock.bind(vending);
  vending.take = (m) => { const s = take(m); if (s != null) bought++; return s; };
  vending.restock = (m) => { const n = restock(m); refilled += n; return n; };

  const seen = new Set();
  let done = 0, minFill = start;
  const onRestock = new Map();
  for (let f = 0; f < SECONDS * 60; f++) {
    chores.update(DT);
    enemies.update(DT, CTX);
    for (const e of enemies.items) {
      const on = e.chore?.routine === 'restock';
      if (on && !seen.has(e.chore)) seen.add(e.chore);
      if (onRestock.get(e) && !on && e.chore == null) { /* ended */ }
      onRestock.set(e, on);
    }
    if (f % 60 === 0) minFill = Math.min(minFill, fill());
  }
  done = refilled > 0 ? [...seen].length : 0;
  tot.bought += bought; tot.cast += seen.size; tot.refilled += refilled; tot.machines += vending.machines.length;
  console.log(`s${seed}/f${floor}`.padEnd(14)
    + ` machines=${vending.machines.length}  stock ${start}/${cap} -> min ${minFill} -> end ${fill()}`
    + `  bought=${bought}  restocks cast=${seen.size}  cans put back=${refilled}`);
}
console.log(`\n${tot.machines} machines, ${tot.bought} cans bought, ${tot.cast} restocks cast, ${tot.refilled} cans put back`);
