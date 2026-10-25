// Can the PLAYER walk down into every basement, and up into every attic?
//
//   node tools/probe-stairs.mjs [floors]
//
// The real Player, on the real colliders, started at the approach spot the
// generator reserves at the foot of each flight and steered along it at a fixed
// 1/60. Reports every flight whose far end the body never reached.

import './headless.mjs';

const { generateLayout } = await import('../src/gen/layout.js');
const { buildLevel } = await import('../src/gen/build.js');
const { approachSpot, levelY, rampSpec, FLIGHT_TILES, footY } = await import('../src/gen/stairs.js');
const { Player } = await import('../src/player.js');
const { NavGrid } = await import('../src/nav.js');
const { doorsOnRoom } = await import('../src/gen/locks.js');
const THREE = await import('three');

const FLOORS = Number(process.argv[2] ?? 40);
const DT = 1 / 60;
const EYE = 1.7;

const camera = new THREE.PerspectiveCamera();
const dom = { addEventListener() {}, removeEventListener() {}, ownerDocument: globalThis.document,
  requestPointerLock() {} };
globalThis.document.addEventListener ??= () => {};
globalThis.document.getElementById ??= () => null;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.document.removeEventListener ??= () => {};

let tried = 0, failed = 0;
const byDir = { up: [0, 0], down: [0, 0] };
for (let i = 0; i < FLOORS; i++) {
  const seed = 9000 + i * 7919;
  const floor = 1 + (i % 10);
  const layout = generateLayout(seed, floor);
  if (!layout.stairs?.length) continue;
  const level = buildLevel(new THREE.Scene(), layout);
  const nav = new NavGrid(level.nav);
  // The building open: every door drawn back, every reader cleared.
  for (const door of level.doors ?? []) if (door.lock) nav.openTiles(door.navTiles);
  for (const c of level.colliders) if (c.door) c.top = -1;

  for (const plan of layout.stairs) {
    const keys = { forward: true };
    const p = new Player(camera, dom, keys);
    p.controls.engaged = true;
    p.setColliders(level.colliders, []);
    p.setBounds(level.bounds);
    const start = approachSpot(layout, plan);
    // Walk in from the room's own doorway, down the nav field, to the foot.
    const door = doorsOnRoom(layout.doors, plan.room)[0];
    const TL = 0.5;
    // A car park's rooms have no doors (gen/garage.js): start at the foot.
    if (!door || footY(plan) !== 0) { p.object.position.set(start.x, footY(plan) + EYE, start.z); }
    else {
    const dx0 = layout.ox + ((door.x0 + door.x1) / 2) * TL, dz0 = layout.oz + ((door.y0 + door.y1) / 2) * TL;
    p.object.position.set(dx0, EYE, dz0);
    const field = nav.makeField();
    const routed = nav.floodTo(field, start.x, start.z);
    const out = new THREE.Vector3();
    let tw = 0, lastMove = 0, prevX = dx0, prevZ = dz0, stuckApproach = false;
    while (Math.hypot(p.object.position.x - start.x, p.object.position.z - start.z) > 0.4) {
      const P = p.object.position;
      const d = nav.descendOn(field, P.x, P.z, out);
      if (!d) { stuckApproach = 'off-field'; break; }
      camera.position.copy(P);
      camera.lookAt(P.x + out.x, P.y, P.z + out.z);
      p.update(DT, camera);
      tw += DT;
      if (Math.hypot(P.x - prevX, P.z - prevZ) > 0.5) { prevX = P.x; prevZ = P.z; lastMove = tw; }
      if (tw - lastMove > 3) { stuckApproach = 'wedged'; break; }
      if (tw > 60) { stuckApproach = 'timeout'; break; }
    }
    if (!routed || stuckApproach) {
      const P = p.object.position;
      console.log(`APPROACH s${seed}/f${floor} ${plan.dir < 0 ? 'down' : 'up'} ${plan.room.role} ` +
        `${routed ? stuckApproach : 'no nav route'} at (${P.x.toFixed(2)},${P.z.toFixed(2)}) foot (${start.x.toFixed(2)},${start.z.toFixed(2)})`);
      p.object.position.set(start.x, footY(plan) + EYE, start.z);
    }
    }

    const spec = rampSpec(layout, plan);
    const TILE = 0.5;
    const cMid = spec.alongX ? layout.oz + ((plan.y0 + plan.y1) / 2) * TILE : layout.ox + ((plan.x0 + plan.x1) / 2) * TILE;
    // Off the top tread and onto the level: 0.7 m past the end of the flight.
    const far = spec.foot + spec.up * (FLIGHT_TILES * TILE + 0.7);
    const pts = [
      spec.alongX ? { x: spec.foot - spec.up * 0.3, z: cMid } : { x: cMid, z: spec.foot - spec.up * 0.3 },
      spec.alongX ? { x: far, z: cMid } : { x: cMid, z: far },
    ];
    const goalY = levelY(plan);
    let wp = 0, t = 0, reached = false, minFeet = 0, maxFeet = 0;
    const pos = p.object.position;
    while (t < 20) {
      const g = pts[wp];
      const dx = g.x - pos.x, dz = g.z - pos.z;
      if (Math.hypot(dx, dz) < 0.25) { if (++wp >= pts.length) break; continue; }
      camera.position.copy(pos);
      camera.lookAt(g.x, pos.y, g.z);
      p.update(DT, camera);
      t += DT;
      const feet = pos.y - EYE;
      minFeet = Math.min(minFeet, feet); maxFeet = Math.max(maxFeet, feet);
    }
    keys.forward = false;
    for (let s = 0; s < 120; s++) p.update(DT, camera);
    const feet = pos.y - EYE;
    reached = wp >= pts.length && Math.abs(feet - goalY) < 0.05;
    tried++;
    const k = plan.dir < 0 ? 'down' : 'up';
    byDir[k][0]++;
    if (!reached) {
      failed++; byDir[k][1]++;
      console.log(`FAIL s${seed}/f${floor} ${k} ${plan.room.role} axis=${plan.axis} up=${plan.up} ` +
        `start=(${start.x.toFixed(2)},${start.z.toFixed(2)}) end=(${pos.x.toFixed(2)},${pos.z.toFixed(2)}) ` +
        `feet=${feet.toFixed(2)} goal=${goalY} wp=${wp} range=[${minFeet.toFixed(2)},${maxFeet.toFixed(2)}]`);
    }
  }
}
console.log(`\n${tried} flights, ${failed} unreachable — up ${byDir.up[1]}/${byDir.up[0]}, down ${byDir.down[1]}/${byDir.down[0]}`);
