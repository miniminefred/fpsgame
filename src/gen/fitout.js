// The fit-out: what is built INTO a finished shell that is not furniture.
//
// The two lift cars gen/lifts.js cut into the floorplan, and the way down. Both
// are one-off objects rather than systems, and both are about saying where you
// came in and where you leave — which is why the exit's materials are one-offs
// this file owns rather than the shared cache.

import * as THREE from 'three';
import { LAMP_COLD } from '../textures.js';
import { boxBetween, slab } from './geom.js';
import { CEIL_H, FACING, worldX, worldZ } from './layout.js';
import { DOOR_PANEL_H, fitLiftDoors } from './doorways.js';

const LINE_T = 0.04;           // how far the car's lining stands off its plaster

const LINE_H = 2.45;           // and how far up it goes, leaving a band of wall

const RAIL_Y = 0.92;           // the handrail, at the height a hand falls

const RAIL_R = 0.035;

const CAR_LAMP_INSET = 0.35;   // the lit ceiling panel, in from the car's walls

const CAR_LAMP_Y = CEIL_H - 0.02;
// One round, like every tube in the building and like the glazing: the reward
// for shooting a light out is that it goes out. Written here rather than
// imported because shell.js keeps its own PANEL_HP private, and 1 is not a
// number two files can disagree about interestingly.
const CAR_LAMP_HP = 1;

const SIGN_Y0 = DOOR_PANEL_H + 0.12;   // the floor indicator over the doors

const SIGN_H = 0.16;

const SIGN_W = 0.62;

const SIGN_PROUD = 0.015;

/**
 * The fit-out of the two cars gen/lifts.js cut into the floorplan.
 *
 * Everything STRUCTURAL about a car is already standing before this runs — the
 * shell built its walls out of SOLID tiles, the floor pass laid its floor, the
 * ceiling pass covered it and buildDoorFrames put a frame and a header round its
 * opening — so what is left is the four things that make a box with a hole in it
 * read as a lift: a lining, a rail, a light of its own, and doors that part.
 *
 * Three of the four are batched, because they never move. The doors are meshes,
 * for the reason every other door in the building is.
 */
export function buildLifts(layout, batcher, materials, scene, doors, colliders, fixtures,
  destructibles) {
  for (const lift of [layout.lifts?.arrival, layout.lifts?.departure]) {
    if (!lift) continue;
    // The departure car's indicator is green and belongs to buildExit, which
    // owns everything on this floor that says "down" and owns the one-off
    // materials it is painted in. Drawing a white one here as well would be two
    // signs over one doorway, and the wrong one is the one you would read.
    dressCar(layout, lift, batcher, materials, fixtures, destructibles,
      lift !== layout.lifts.departure);
    fitLiftDoors(layout, lift, scene, materials, doors, colliders);
  }
}

// The inside of the car: brushed panel on the three walls you can see, a rail
// across the back of it, and a lit ceiling.
//
// The light is the part that earns its place. A car is a sealed box in the
// middle of a room, so the room's own ceiling fixtures are on the wrong side of
// its walls and the pool that follows the player (see lighting.js) has nothing
// in there to home onto — the floor opened on a black cupboard with a doorway in
// it. One fixture inside, and it is also the only light in the building that is
// GUARANTEED to be the first thing switched on, because the player is standing
// under it before they have moved.
function dressCar(layout, lift, batcher, materials, fixtures, destructibles, sign) {
  const x0 = worldX(layout, lift.tx0), x1 = worldX(layout, lift.tx1);
  const z0 = worldZ(layout, lift.ty0), z1 = worldZ(layout, lift.ty1);
  const [ox, oz] = FACING[lift.facing];

  // The three walls that are not the doors. Written as a direction rather than
  // as named walls, because which of the four the doors are in is the whole of
  // what varies between one car and the next.
  for (const [dx, dz] of FACING) {
    if (dx === ox && dz === oz) continue;
    // No world UVs: `metal` is a flat colour with no map, so there is nothing
    // for them to line up.
    batcher.add('metal', materials.metal, dx
      ? boxBetween(dx > 0 ? x1 - LINE_T : x0, 0, z0, dx > 0 ? x1 : x0 + LINE_T, LINE_H, z1)
      : boxBetween(x0, 0, dz > 0 ? z1 - LINE_T : z0, x1, LINE_H, dz > 0 ? z1 : z0 + LINE_T),
      { castShadow: false });
  }

  // The rail, across the wall the car backs onto — which is the one opposite the
  // doors, so it is the wall you are facing when you turn round inside.
  const back = ox
    ? { a: ox > 0 ? x0 : x1 - LINE_T - RAIL_R * 2, b: 0 }
    : { a: 0, b: oz > 0 ? z0 : z1 - LINE_T - RAIL_R * 2 };
  batcher.add('metalDark', materials.metalDark, ox
    ? boxBetween(back.a + LINE_T, RAIL_Y - RAIL_R, z0 + 0.2,
      back.a + LINE_T + RAIL_R * 2, RAIL_Y + RAIL_R, z1 - 0.2)
    : boxBetween(x0 + 0.2, RAIL_Y - RAIL_R, back.b + LINE_T,
      x1 - 0.2, RAIL_Y + RAIL_R, back.b + LINE_T + RAIL_R * 2),
    { castShadow: false });

  // ...and it is a tube like any other, so it is shot out like any other. It was
  // raw batched geometry with a fixture beside it and no record between them,
  // which made the one light in the building you are standing directly under the
  // one light in the building you could not break. Registered exactly the way
  // `buildCeilingLights` registers a ceiling panel — same `kind`, so it takes
  // the same round, makes the same noise and throws the same glass — and with
  // its fixture on the record, which is what puts the car dark rather than
  // leaving a lit panel over a dead lamp.
  const lampSpans = batcher.beginSpans();
  batcher.add('panel', materials.panel, slab(
    x0 + CAR_LAMP_INSET, z0 + CAR_LAMP_INSET,
    x1 - CAR_LAMP_INSET, z1 - CAR_LAMP_INSET, CAR_LAMP_Y, false), { castShadow: false });
  batcher.endSpans();
  const lamp = {
    x: (x0 + x1) / 2, y: CAR_LAMP_Y - 0.1, z: (z0 + z1) / 2,
    color: LAMP_COLD, intensity: 2.2, distance: 5,
  };
  fixtures.push(lamp);
  destructibles?.push({
    kind: 'panel',
    hp: CAR_LAMP_HP,
    spans: lampSpans,
    colliders: [],
    // No nav tiles and no collider: it is a panel in a ceiling, and the car's
    // walls are the shell's. Giving anything back is `_shatter`'s business and
    // there is nothing here to give.
    navTiles: [],
    fixtures: [lamp],
    parts: [
      { material: materials.panel,
        x0: x0 + CAR_LAMP_INSET, y0: CAR_LAMP_Y - 0.05, z0: z0 + CAR_LAMP_INSET,
        x1: (x0 + x1) / 2, y1: CAR_LAMP_Y - 0.02, z1: z1 - CAR_LAMP_INSET },
      { material: materials.panel,
        x0: (x0 + x1) / 2, y0: CAR_LAMP_Y - 0.05, z0: z0 + CAR_LAMP_INSET,
        x1: x1 - CAR_LAMP_INSET, y1: CAR_LAMP_Y - 0.02, z1: z1 - CAR_LAMP_INSET },
    ],
    broken: false,
  });

  // And the floor indicator over the doors, on the OUTSIDE. It is the one thing
  // here that is for the player standing in the room rather than in the car, and
  // it is what says "lift" from across a reception: a blank wall with a doorway
  // in it is a cupboard, and a lit strip over that doorway is not. The
  // departure car gets a second, louder tell of its own — see buildExit.
  if (!sign) return;
  const d = lift.door;
  const sx = ox ? worldX(layout, ox > 0 ? d.x1 : d.x0) : (worldX(layout, d.x0) + worldX(layout, d.x1)) / 2;
  const sz = oz ? worldZ(layout, oz > 0 ? d.y1 : d.y0) : (worldZ(layout, d.y0) + worldZ(layout, d.y1)) / 2;
  batcher.add('panel', materials.panel, ox
    ? boxBetween(sx + ox * SIGN_PROUD - SIGN_PROUD, SIGN_Y0, sz - SIGN_W / 2,
      sx + ox * SIGN_PROUD + SIGN_PROUD, SIGN_Y0 + SIGN_H, sz + SIGN_W / 2)
    : boxBetween(sx - SIGN_W / 2, SIGN_Y0, sz + oz * SIGN_PROUD - SIGN_PROUD,
      sx + SIGN_W / 2, SIGN_Y0 + SIGN_H, sz + oz * SIGN_PROUD + SIGN_PROUD),
    { castShadow: false });
}

/**
 * Two leaves that part in the middle, one runner each.
 *
 * A third kind of door, and there are two of them in the building. A lift car's
 * is the one the arithmetic was written for: LIFT_DOOR_W in gen/lifts.js sizes
 * the opening so each leaf is half of it and retracts into exactly the tile of
 * the car's own front beside it, which is why a car's opening is 1.0 m rather
 * than the building's 1.5 m. The lobby's own way out is the other — see
 * buildDoubleDoors, which is the same pair of leaves in a wall that was not
 * built around them.
 *
 * Everything else is buildSlidingDoors': one collider for the closed opening,
 * retired by dropping its `top` when the pair is more than half open, and the
 * door tiles handed over so a shut doorway is opaque to sight as well as to
 * walking.
 *
 * They share one entry in `doors` because they are one doorway — the same
 * argument buildHallDoors makes about its two leaves, and for the same three
 * reasons: one sensor, one sound, one collider.
 *
 * `travelFor(end, half)` is how far the leaf hanging off that end may run. A
 * callback rather than a number because the two callers know different things: a
 * car's pocket is guaranteed by the way the car was carved, and a room's has to
 * be measured off the wall it was cut into.
 */

// The way down, which is the second lift car.
//
// It used to be a service hatch — a lit pad on the carpet under a shaft of light
// — and that was a floor with no way in and no way out, only a place you were
// put down and a place you stood on to leave. The floor arrives out of a car
// now, so it leaves by one too, and the marker's job changes with it: the pad no
// longer has to be legible from the far side of a dark floorplate, because the
// thing it is marking is a lit room-sized object with doors on it.
//
// What it still has to do is say WHICH lift, and on a floor with two of them
// that is the whole message. Everything here is the exit green: a pad in the car
// where the hatch used to be, the column of light over it, and — the one piece
// aimed at somebody standing out in the room — the indicator over the doors,
// which every other car in the game wears in cold white.
//
// The pad is sized to the car rather than to the room. At the hatch's 1.1 m it
// was wider than the 1.5 m the car is deep and stood through both its walls.
const EXIT_LIFT_R = 0.42;

const EXIT_PAD_R = 1.1;      // the hatch, on a floor whose exit room took no car

export function buildExit(scene, layout, fixtures) {
  const lift = layout.lifts?.departure;
  const group = new THREE.Group();
  group.position.set(layout.exit.x, 0, layout.exit.z);

  const r = lift ? EXIT_LIFT_R : EXIT_PAD_R;

  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, 0.06, 32),
    new THREE.MeshBasicMaterial({ color: 0x1c6b45 })
  );
  pad.position.y = 0.03;
  group.add(pad);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(r * 0.86, r * 0.055 + 0.02, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0x64ffa0 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  group.add(ring);

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 0.77, r * 0.95, CEIL_H, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x64ffa0, transparent: true, opacity: 0.09,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  shaft.position.y = CEIL_H / 2;
  group.add(shaft);

  // The indicator over the doors, in place of the white one every other car
  // wears (see dressCar, which skips it for this one). It is the only part of
  // the exit anybody sees before they are in the doorway, and it is why the
  // marker no longer needs to shine across the whole floor: a green strip over a
  // lift is a sentence, where a green glow on the far wall is a rumour.
  if (lift) {
    const d = lift.door;
    const [ox, oz] = FACING[lift.facing];
    const sx = ox ? worldX(layout, ox > 0 ? d.x1 : d.x0)
      : (worldX(layout, d.x0) + worldX(layout, d.x1)) / 2;
    const sz = oz ? worldZ(layout, oz > 0 ? d.y1 : d.y0)
      : (worldZ(layout, d.y0) + worldZ(layout, d.y1)) / 2;
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(ox ? SIGN_PROUD * 2 : SIGN_W, SIGN_H, ox ? SIGN_W : SIGN_PROUD * 2),
      new THREE.MeshBasicMaterial({ color: 0x64ffa0 })
    );
    // The group stands at the middle of the CAR, so the sign — which is out on
    // the front wall — is placed relative to that rather than in world metres.
    sign.position.set(
      sx + ox * SIGN_PROUD - layout.exit.x,
      SIGN_Y0 + SIGN_H / 2,
      sz + oz * SIGN_PROUD - layout.exit.z);
    group.add(sign);
  }

  // These materials are one-offs rather than the shared cache, so the level
  // teardown is allowed to dispose them.
  group.traverse((child) => { child.userData.ownMaterial = true; });

  scene.add(group);
  // Lower and dimmer inside a car than it was in the open: the light has 2.0 x
  // 1.5 m of metal to bounce off rather than a room, and at the hatch's strength
  // the whole interior blew out to flat green.
  fixtures.push({
    x: layout.exit.x, y: lift ? 1.1 : 1.6, z: layout.exit.z,
    color: 0x64ffa0, intensity: lift ? 3.5 : 7, distance: lift ? 5 : 8,
  });

  group.userData.ring = ring;
  group.userData.shaft = shaft;
  return group;
}
