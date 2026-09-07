// Does the man in the coloured suit actually come in, take a crate and leave?
//
// Driven headlessly at a fixed 1/60 rather than watched in a browser, for the
// reason CLAUDE.md gives about the render loop: `requestAnimationFrame` does not
// tick in a tab nobody is looking at, so a body simply freezes and the errand
// reads as broken when nothing is. It is also the only way to watch three
// minutes of one floor without sitting through three minutes.
//
//   node tools/probe-visitor.mjs [floors] [seconds]

import './headless.mjs';

const { generateLayout } = await import('../src/gen/layout.js');
const { buildLevel } = await import('../src/gen/build.js');
const { NavGrid } = await import('../src/nav.js');
const { Enemies } = await import('../src/enemies.js');
const { Chores } = await import('../src/chores.js');
const { makeRng } = await import('../src/gen/rng.js');
const { tuningFor } = await import('../src/game.js');
const THREE = await import('three');

const FLOORS = Number(process.argv[2] ?? 10);
const SECONDS = Number(process.argv[3] ?? 200);
const DT = 1 / 60;

// A target the roster can measure against that is never in the way: at the
// spawn, marked dead, so nothing sights it and no errand is interrupted. What is
// being measured is the building working, not a fight.
const DEAD = [{ x: 0, y: 0, z: 0, layer: 0, dead: true, hurt() {} }];
// A silent audio bank rather than null: `animate` voices a footfall on every
// stride and the game never runs without one, so a stub is the honest shape.
const AUDIO = new Proxy({}, { get: () => () => {} });
const CTX = { targets: DEAD, effects: null, audio: AUDIO };

const rows = [];

for (let i = 0; i < FLOORS; i++) {
  const seed = 2000 + i * 7919;
  const floor = 1 + (i % 8);
  const layout = generateLayout(seed, floor);
  const scene = new THREE.Scene();
  const level = buildLevel(scene, layout);
  const nav = new NavGrid(level.nav);

  const enemies = new Enemies(scene);
  enemies.spawn(layout, nav, makeRng(seed ^ 0x1234),
    tuningFor(floor, layout.areaRatio ?? 1), level.workstations);

  // The building open, the way a white card opens it — every errand in the game
  // only really starts once it is (see the note in chores.js).
  for (const door of level.doors) if (door.lock) nav.openTiles(door.navTiles);

  const chores = new Chores({ enemies, effects: null, audio: AUDIO });
  chores.spawn(nav, enemies, null);

  const v = enemies.visitor;
  const row = { id: `s${seed}/f${floor}`, visitor: !!v, legs: [], gone: false, away: 0 };
  if (v) {
    const home = { x: v.x, z: v.z };
    let prev = null;
    for (let f = 0; f < SECONDS * 60; f++) {
      chores.update(DT);
      enemies.update(DT, CTX);
      const c = v.chore;
      const state = v.gone ? 'gone' : c ? `${c.legs[c.leg].kind}/${c.stage}` : 'idle';
      row.away = Math.max(row.away, Math.hypot(v.x - home.x, v.z - home.z));
      if (state !== prev) {
        row.legs.push(`${(f * DT).toFixed(0)}s ${state}${v.carry ? '+crate' : ''}`);
        prev = state;
      }
      if (v.gone) { row.gone = true; break; }
    }
    // To the NEAREST lift, not to the one he arrived at: a floor has two cars and
    // the errand takes whichever it can reach, exactly as a post run does.
    row.back = Math.min(...enemies.lifts.map((l) => Math.hypot(v.x - l.x, v.z - l.z)));
    row.hidden = !v.group.visible;
    row.offMap = !!v.offMap;
    row.carry = !!v.carry;
    row.suit = '#' + v.type.suit.toString(16);
  }
  rows.push(row);
  console.log(`${row.id.padEnd(16)} ${row.visitor ? (row.suit ?? 'visitor') : 'none   '}`
    + ` ${row.gone ? 'LEFT' : row.visitor ? '....' : '    '}`
    + ` away=${row.away.toFixed(1).padStart(5)}m`
    + ` back=${row.back !== undefined ? row.back.toFixed(1).padStart(4) : '   -'}m`
    + `  ${row.legs.join(' -> ')}`);
}

const had = rows.filter((r) => r.visitor);
const left = had.filter((r) => r.gone);
const carried = had.filter((r) => r.legs.some((l) => l.includes('+crate')));
console.log(`\n${had.length}/${rows.length} floors had a visitor`);
console.log(`${carried.length}/${had.length} of them picked up a crate`);
console.log(`${left.length}/${had.length} of them left the building`);
const bad = left.filter((r) => !r.hidden || !r.offMap || r.carry || r.back > 1.0);
console.log(`${bad.length} left in a bad state`
  + ' (still drawn, on the map, holding a crate, or nowhere near a lift)');
