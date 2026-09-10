// Does everything DIE correctly — every enemy type, and every prop on a floor?
//
//   node tools/probe-kill.mjs            # both sweeps
//   node tools/probe-kill.mjs types      # ...or one of them
//   node tools/probe-kill.mjs props
//
// The damage layer of tools/snapshot.mjs already records what came off 30 fitted
// and 12 loose props on 8 floors, and that is a REGRESSION test: it says today's
// wreckage matches yesterday's. It cannot say whether the prop it never sampled
// works at all, and it says nothing whatever about a BODY dying. So this is the
// other half:
//
//   types  one of every entry in TYPES, shot through `enemies.hit` until it
//          stops. A death has to leave: alive=0, the hostile count down by one
//          if it was hostile, `onDeath` fired exactly once, and every hitbox's
//          back-reference to the body cleared while its `isEnemyPart` flag
//          stays — which is what makes the next round pass THROUGH the corpse
//          instead of being spent on it.
//   props  EVERY destructible and EVERY loose prop on a handful of floors,
//          rather than the 30-and-12 sample the baseline takes: thousands of
//          props instead of hundreds, which makes it a hunt for the one that
//          throws rather than a record of what the usual ones do. A break has
//          to leave: broken=1, no throw, the collider retired, and the prop's
//          nav tiles handed back.
//
// It cannot report per CATALOGUE KIND, and that is a fact about the game rather
// than a shortcut here: a static destructible records `kind: 'prop'` and what it
// is made of, never which entry of PROPS built it (see gen/sink.js). So what it
// can name is the substance, and `validate-props.mjs --catalogue` is what audits
// the catalogue itself.

import { AUDIO, stubWorld } from './headless.mjs';

const { generateLayout } = await import('../src/gen/layout.js');
const { buildLevel } = await import('../src/gen/build.js');
const { NavGrid } = await import('../src/nav.js');
const { Enemies } = await import('../src/enemies.js');
const { Destruction } = await import('../src/destruction.js');
const { TYPES } = await import('../src/enemy-types.js');
const { PROPS } = await import('../src/gen/props.js');
const { makeRng } = await import('../src/gen/rng.js');
const { tuningFor } = await import('../src/game.js');
const THREE = await import('three');

const WHICH = process.argv[2] ?? 'both';
const DEAD = [{ x: 0, y: 0, z: 0, layer: 0, dead: true, hurt() {} }];

let fails = 0;
const fail = (what, why) => { fails++; console.log(`  FAIL ${what}: ${why}`); };

function walkCount(nav) {
  let n = 0;
  for (let i = 0; i < nav.walk.length; i++) if (nav.walk[i]) n++;
  return n;
}

// --------------------------------------------------------------- every type
if (WHICH === 'both' || WHICH === 'types') {
  const seed = 4242;
  const floor = 6;
  const layout = generateLayout(seed, floor);
  const level = buildLevel(new THREE.Scene(), layout);
  const nav = new NavGrid(level.nav);
  const tuning = tuningFor(floor, layout.areaRatio ?? 1);

  console.log(`\nevery type dies (${Object.keys(TYPES).length} in TYPES)`);
  const rows = [];
  for (const [name, type] of Object.entries(TYPES)) {
    const enemies = new Enemies(new THREE.Scene());
    enemies.spawn(layout, nav, makeRng(seed), tuning, level.workstations);
    let died = 0;
    enemies.onDeath = () => { died++; };
    const before = enemies.hostileCount;

    const e = enemies._add(layout.spawn.x + 6, layout.spawn.z + 6,
      makeRng(seed ^ 7), tuning, type);
    if (!e) { fail(name, 'could not be added to the roster'); continue; }
    const hp0 = e.health;
    const boxes = e.hitboxes ?? [];
    if (!boxes.length) { fail(name, 'has no hitboxes, so nothing can shoot it'); continue; }

    let shots = 0;
    let err = null;
    try {
      // Through the real path: a mesh, a direction, a contact point and a punch.
      while (e.alive && shots < 400) {
        enemies.hit(boxes[shots % boxes.length], 25, { x: 0, y: 0, z: 1 },
          { x: e.x, y: 1, z: e.z }, 1);
        shots++;
      }
      enemies.update(1 / 60, { targets: DEAD, effects: null, audio: AUDIO });
    } catch (ex) { err = ex; }

    if (err) { fail(name, `threw while dying: ${err.message}`); continue; }
    if (e.alive) { fail(name, `still alive after ${shots} rounds (hp ${e.health})`); continue; }
    if (died !== 1) fail(name, `onDeath fired ${died} times, not once`);
    const held = boxes.filter((b) => b.userData?.enemy);
    if (held.length) fail(name, `${held.length} hitboxes still point at the corpse`);
    const flagged = boxes.filter((b) => b.userData?.isEnemyPart);
    if (flagged.length !== boxes.length) {
      fail(name, `${boxes.length - flagged.length} hitboxes lost isEnemyPart`);
    }
    const after = enemies.hostileCount;
    if (!type.neutral && after !== before) {
      fail(name, `hostile count ${before} -> ${after} on killing a hostile`);
    }
    rows.push(`  ok ${name.padEnd(18)} hp=${String(hp0).padStart(4)}`
      + ` rounds=${String(shots).padStart(3)} boxes=${boxes.length}`
      + ` ${type.neutral ? 'neutral' : 'hostile'}${type.chassis ? ' chassis' : ''}`);
  }
  console.log(rows.join('\n'));
}

// -------------------------------------------------------------- every prop
if (WHICH === 'both' || WHICH === 'props') {
  const scene = new THREE.Scene();
  let statics = 0;
  let loose = 0;
  let navBack = 0;
  let retired = 0;
  const met = new Map();

  console.log(`\nevery prop on a floor breaks (${Object.keys(PROPS).length} kinds in PROPS)`);
  for (let i = 0; i < 6; i++) {
    const seed = 9000 + i * 7919;
    const floor = 1 + (i % 12);
    const layout = generateLayout(seed, floor);
    const level = buildLevel(scene, layout);
    const nav = new NavGrid(level.nav);
    level.nav = nav;
    const world = stubWorld();
    const d = new Destruction({ ...world, scene });
    d.setLevel(level);

    let broke = 0;
    for (const [what, list] of [['s', level.destructibles], ['l', level.dynamics]]) {
      for (let n = 0; n < list.length; n++) {
        const item = list[n];
        if (item.broken || !item.parts?.length) continue;
        const p = item.parts[0];
        const at = {
          x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2, z: (p.z0 + p.z1) / 2,
        };
        if (what === 'l') {
          at.x += item.group.position.x;
          at.y += item.group.position.y;
          at.z += item.group.position.z;
        }
        const label = `${what}:${item.substance ?? item.kind ?? '-'}`;
        const where = `${label} s${seed}/f${floor}#${n}`;
        const wantNav = item.navTiles?.length ?? 0;
        const walk0 = walkCount(nav);
        // The generator is the one prop that is destroyed and still there, so it
        // keeps its collider and its nav tiles on purpose. See wreck.js.
        const isHulk = item.parts.some((q) => q.hulk);
        let err = null;
        try {
          if (what === 's') d.netShatter(n, { x: 0, y: 0, z: 1 }, at);
          else d.netBreakProp(n, { x: 0, y: 0, z: 1 }, at);
        } catch (ex) { err = ex; }

        met.set(label, (met.get(label) ?? 0) + 1);
        if (err) { fail(where, `threw: ${err.message}`); continue; }
        if (!item.broken) { fail(where, 'did not break'); continue; }
        broke++;
        if (what === 'l') { loose++; continue; }
        statics++;
        // A fitted prop holds a LIST (`colliders`), not one box: a reception
        // counter is an L of two. A loose one has the single `collider` its
        // physics body is synced from.
        const live = (item.colliders ?? []).filter((c) => c.top > 0);
        if (live.length && !isHulk) {
          fail(where, `${live.length} of ${item.colliders.length} colliders not retired`);
        } else if (item.colliders?.length) retired++;
        if (wantNav && !isHulk) {
          if (walkCount(nav) <= walk0) fail(where, `held ${wantNav} nav tiles and gave none back`);
          else navBack++;
        }
        d.debris.clear();
        d.stock?.clear?.();
      }
    }
    console.log(`  s${seed}/f${floor} broke ${broke} of`
      + ` ${level.destructibles.length} fitted + ${level.dynamics.length} loose`);
  }
  console.log(`  ${statics} fitted props broken (${retired} colliders retired,`
    + ` ${navBack} handed nav tiles back) and ${loose} loose ones`);
  console.log(`  substances met: ${[...met.keys()].sort().join(' ')}`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nno failures');
process.exit(fails ? 1 : 0);
