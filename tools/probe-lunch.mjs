// Does everybody who goes for a break get back OUT again?
//
//   node tools/probe-lunch.mjs [floors] [seconds]
//
// A player reported people stuck in the cafeteria. The failure this looks for is
// the one `liftSpots` in roster.js already documents for a different pool:
// FITTING IS NOT THE SAME AS BEING CONNECTED. `deskPool` drops a seat a body
// does not fit at (`standable` -> `nav.fitsAt`), which is a LOCAL test — so a
// chair on an island of walkable tiles, ringed by the room's own static tables,
// survives the pool. A body sits down there and then has no route anywhere for
// the rest of the floor.
//
// Two questions, because a seat can be islanded without anybody being dealt it:
//   islanded  seats in the pool whose tile is off a field flooded from the
//             corridor network, which is connected by construction
//   stuck     bodies that finished a break and are still not moving a minute on
//
// Driven at a fixed 1/60, for the reason CLAUDE.md gives about
// `requestAnimationFrame`: in a tab nobody is looking at, a body freezes.

import './headless.mjs';

const { generateLayout } = await import('../src/gen/layout.js');
const { buildLevel } = await import('../src/gen/build.js');
const { NavGrid } = await import('../src/nav.js');
const { Enemies } = await import('../src/enemies.js');
const { makeRng } = await import('../src/gen/rng.js');
const { tuningFor } = await import('../src/game.js');
const THREE = await import('three');

const FLOORS = Number(process.argv[2] ?? 8);
const SECONDS = Number(process.argv[3] ?? 240);
const DT = 1 / 60;
const STILL = 0.35;      // m — under this over a whole minute is not walking
const STILL_FOR = 60;    // s

const DEAD = [{ x: 0, y: 0, z: 0, layer: 0, dead: true, hurt() {} }];
const AUDIO = new Proxy({}, { get: () => () => {} });
const CTX = { targets: DEAD, effects: null, audio: AUDIO };

let tot = { seats: 0, islanded: 0, breaks: 0, stuck: 0, cafeStuck: 0, floors: 0, cafes: 0 };

for (let i = 0; i < FLOORS; i++) {
  const seed = 5000 + i * 7919;
  const floor = 1 + (i % 8);
  const layout = generateLayout(seed, floor);
  const level = buildLevel(new THREE.Scene(), layout);
  const nav = new NavGrid(level.nav);

  const enemies = new Enemies(new THREE.Scene());
  enemies.spawn(layout, nav, makeRng(seed ^ 0x1234),
    tuningFor(floor, layout.areaRatio ?? 1), level.workstations);
  // The building open, as it is once a white card is in the player's pocket —
  // otherwise almost nobody can reach the canteen at all and this measures the
  // locks instead of the seats.
  for (const door of level.doors) if (door.lock) nav.openTiles(door.navTiles);

  // One flood from the corridor network, exactly as `liftSpots` does it.
  const corr = enemies.corridors ?? [];
  const field = corr.length ? nav.makeField() : null;
  const joined = field && nav.floodTo(field, corr[0].x, corr[0].z);

  const cafeRoom = layout.cafeteriaRoom;
  const seatKinds = ['tables', 'lounges', 'desks', 'meetingSeats'];
  const islandedBy = {};
  let seats = 0, islanded = 0;
  for (const kind of seatKinds) {
    const pool = enemies[kind];
    if (!pool) continue;
    for (const list of pool.values()) {
      for (const w of list) {
        seats++;
        // A LOUNGE seat's own point is inside the sofa, so the tile that matters
        // is the one `sittable` proved you can step off onto. Asking about the
        // station itself would report every sofa in the building as islanded.
        const at = w.step ?? w;
        const tx = nav.tx(at.x), ty = nav.ty(at.z);
        if (joined && field[ty * nav.W + tx] < 0) {
          islanded++;
          islandedBy[kind] = (islandedBy[kind] ?? 0) + 1;
        }
      }
    }
  }

  // Run the floor, then ask the only question the player can see: is this body
  // standing on floor it cannot leave? A body off a field flooded from the
  // corridor network has no route anywhere for the rest of the floor, whatever
  // put it there — placed by the shift, seated as one of the opening diners, or
  // walked in and left behind by a break.
  const onBreak = new Set();
  for (let f = 0; f < SECONDS * 60; f++) {
    enemies.update(DT, CTX);
    if (f % 30) continue;
    for (const e of enemies.items) if (e.break) onBreak.add(e);
  }
  let stuck = 0, stuckCafe = 0;
  for (const e of enemies.items) {
    if (e.dead || e.gone || (e.layer ?? 0) !== 0) continue;
    const tx = nav.tx(e.x), ty = nav.ty(e.z);
    if (!joined || field[ty * nav.W + tx] >= 0) continue;
    stuck++;
    if (cafeRoom && tx >= cafeRoom.x0 && tx < cafeRoom.x1
      && ty >= cafeRoom.y0 && ty < cafeRoom.y1) stuckCafe++;
  }

  const cafe = !!cafeRoom;
  tot.floors++; tot.cafes += cafe ? 1 : 0;
  tot.seats += seats; tot.islanded += islanded;
  tot.breaks += onBreak.size; tot.stuck += stuck; tot.cafeStuck += stuckCafe;
  console.log(`s${seed}/f${floor} cafeteria=${cafe ? 'yes' : 'no '} `
    + `seats=${String(seats).padStart(3)} islanded=${String(islanded).padStart(3)}`
    + ` ${JSON.stringify(islandedBy)} breaks=${String(onBreak.size).padStart(3)}`
    + ` STRANDED=${String(stuck).padStart(3)} (${stuckCafe} in the cafeteria)`);
}

console.log(`\n${tot.floors} floors (${tot.cafes} with a cafeteria): `
  + `${tot.islanded}/${tot.seats} seats islanded `
  + `(${(100 * tot.islanded / Math.max(1, tot.seats)).toFixed(1)}%), `
  + `${tot.stuck} bodies stranded on floor they cannot leave `
  + `(${tot.cafeStuck} of them in a cafeteria)`);
process.exit(tot.islanded || tot.stuck ? 1 : 0);
