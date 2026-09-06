// Everything hung in a doorway: the three kinds of door and the badge reader
// beside them.
//
// The three kinds are one panel on a runner, two hinged leaves and two leaves
// that part in the middle, and they differ ONLY in the meshes and in how those
// meshes move — `doorway` and `addDoor` are the half of each that is the same.

import * as THREE from 'three';
import { DOOR_H, slidePocketRun, slidePocketSide, TILE, worldX, worldZ } from './layout.js';
import { CARDS, READER_LIT, READER_OPEN } from '../keycards.js';
import { UP } from './shell.js';

const DOOR_T = 0.09;           // panel thickness
// How far short of the end of its pocket a fully-retracted panel stops.
//
// Not slack: it is what keeps the panel's far face from landing exactly on the far
// face of the wall it is inside. Those two faces coplanar is a shimmering rectangle
// of door on the end of a wall, which is a worse artefact than the 3 cm of panel
// edge standing in the next room that this replaces.

// How far short of the end of its pocket a fully-retracted panel stops.
//
// Not slack: it is what keeps the panel's far face from landing exactly on the far
// face of the wall it is inside. Those two faces coplanar is a shimmering rectangle
// of door on the end of a wall, which is a worse artefact than the 3 cm of panel
// edge standing in the next room that this replaces.
const POCKET_CLEAR = 0.02;

export const DOOR_PANEL_H = DOOR_H - 0.04;

// One unit cube behind every door in the building. Each door scales it, so there
// is nothing per-door about the geometry, and the three builders below were each
// allocating one of these per floor for themselves.

// One unit cube behind every door in the building. Each door scales it, so there
// is nothing per-door about the geometry, and the three builders below were each
// allocating one of these per floor for themselves.
const DOOR_GEO = new THREE.BoxGeometry(1, 1, 1);

/**
 * Everything about a doorway that does not depend on what is hung in it.
 *
 * There are three door builders in this file — one panel on a runner, two hinged
 * leaves, two parting leaves — and they differ ONLY in the meshes and in how
 * those meshes move. Where the opening is in world metres, how wide it is, the
 * collider that fills it when shut and the tiles it occupies are the same three
 * questions for all three, and each builder used to answer them for itself.
 *
 * The collider is the one worth pulling out on its own account: it is load
 * bearing in two directions at once, being what the player walks into and — by
 * having its `top` dropped below the floor rather than being removed — how every
 * door in this game says "walk through me" (see player.js).
 */

/**
 * Everything about a doorway that does not depend on what is hung in it.
 *
 * There are three door builders in this file — one panel on a runner, two hinged
 * leaves, two parting leaves — and they differ ONLY in the meshes and in how
 * those meshes move. Where the opening is in world metres, how wide it is, the
 * collider that fills it when shut and the tiles it occupies are the same three
 * questions for all three, and each builder used to answer them for itself.
 *
 * The collider is the one worth pulling out on its own account: it is load
 * bearing in two directions at once, being what the player walks into and — by
 * having its `top` dropped below the floor rather than being removed — how every
 * door in this game says "walk through me" (see player.js).
 */
function doorway(layout, d) {
  const x0 = worldX(layout, d.x0), x1 = worldX(layout, d.x1);
  const z0 = worldZ(layout, d.y0), z1 = worldZ(layout, d.y1);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const width = d.vertical ? z1 - z0 : x1 - x0;

  // Shut, whatever is in the opening fills it exactly, so one box serves a
  // panel, a parting pair and a hinged pair alike.
  const collider = {
    minX: d.vertical ? cx - DOOR_T / 2 : x0,
    maxX: d.vertical ? cx + DOOR_T / 2 : x1,
    minZ: d.vertical ? z0 : cz - DOOR_T / 2,
    maxZ: d.vertical ? z1 : cz + DOOR_T / 2,
    top: DOOR_PANEL_H,
    // Not furniture. It stands in a doorway on purpose and it is out of the way
    // whenever anybody is there, so the checks that police what may block a
    // doorway have to be able to tell it apart from a filing cabinet.
    door: true,
  };

  // The tiles this opening occupies. A locked door is closed to the nav grid as
  // well as to the player (see buildLevel), and unlocking it has to hand them
  // back — which is the same job destruction.js does when a prop that was
  // standing in the way stops existing.
  const navTiles = [];
  for (let ty = d.y0; ty < d.y1; ty++) {
    for (let tx = d.x0; tx < d.x1; tx++) navTiles.push(ty * layout.W + tx);
  }

  return { x0, x1, z0, z1, cx, cz, width, half: width / 2, collider, navTiles };
}

/**
 * ...and registering one, which is the other end of the same sentence.
 *
 * `moving` is whatever doors.js needs to animate this kind — a `mesh` for a
 * panel, `panels` for a parting pair, `leaves` for a hinged pair. Everything
 * else on a door record is the same for all three, the badge reader included:
 * a doorway asked for a lock and not given a reader is a lock that seals
 * nothing and says nothing, which is the shape of the bug `5.lock-sealed`
 * caught in the pass that assigns them.
 */

/**
 * ...and registering one, which is the other end of the same sentence.
 *
 * `moving` is whatever doors.js needs to animate this kind — a `mesh` for a
 * panel, `panels` for a parting pair, `leaves` for a hinged pair. Everything
 * else on a door record is the same for all three, the badge reader included:
 * a doorway asked for a lock and not given a reader is a lock that seals
 * nothing and says nothing, which is the shape of the bug `5.lock-sealed`
 * caught in the pass that assigns them.
 */
function addDoor(doors, colliders, readers, d, geom, moving) {
  colliders.push(geom.collider);
  doors.push({
    ...moving,
    collider: geom.collider,
    x: geom.cx, z: geom.cz,
    at: new THREE.Vector3(geom.cx, 1.2, geom.cz),
    height: DOOR_PANEL_H,
    // null on an ordinary door; a card tier on a badged one. See doors.js.
    lock: d.lock ?? null,
    navTiles: geom.navTiles,
    reader: d.lock && readers ? readers.add(d, geom.cx, geom.cz, geom.x1, geom.z1) : null,
  });
}

// A leaf or a panel, sized and turned for the wall its doorway is cut in.

// A leaf or a panel, sized and turned for the wall its doorway is cut in.
function doorPanel(materials, d, width, x, z) {
  const mesh = new THREE.Mesh(DOOR_GEO, materials.doorPanel);
  mesh.scale.set(d.vertical ? DOOR_T : width, DOOR_PANEL_H, d.vertical ? width : DOOR_T);
  mesh.position.set(x, DOOR_PANEL_H / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
// Which doorways get a panel. Where a retracted one goes — and why some
// openings cannot take one at all — is slidePocketSide's business, in layout.js,
// because assignLocks has to ask the same question before it badges a room. A
// floor with a few open doorways on it reads as a floor with a few open doorways
// on it, which is what an office looks like anyway.

// Which doorways get a panel. Where a retracted one goes — and why some
// openings cannot take one at all — is slidePocketSide's business, in layout.js,
// because assignLocks has to ask the same question before it badges a room. A
// floor with a few open doorways on it reads as a floor with a few open doorways
// on it, which is what an office looks like anyway.
export function buildSlidingDoors(layout, scene, materials, doors, colliders, readers, rng) {
  for (const d of layout.doors) {
    // The ones across the corridors are hinged, not hung on a runner, and they
    // are fitted below. So are the lift cars', which are a pair of leaves that
    // part in the middle — and which must never be one of the doorways that
    // simply has no door in it, whatever the die says: a lift standing open to
    // its shaft is not a lift.
    if (d.hall || d.lift || d.double) continue;
    // Not every doorway has a door in it. Some were taken off their runners
    // years ago and nobody replaced them — but never the badged ones, and the
    // generator has already checked that every one of those can hold a panel.
    if (!d.lock && !rng.chance(0.55)) continue;

    const side = slidePocketSide(layout.tiles, layout.W, layout.H, d, rng.chance(0.5) ? 1 : -1);
    if (!side) continue;

    const g = doorway(layout, d);
    const mesh = doorPanel(materials, d, g.width, g.cx, g.cz);
    scene.add(mesh);

    addDoor(doors, colliders, readers, d, g, {
      mesh, root: mesh,
      baseX: g.cx, baseZ: g.cz,
      dirX: d.vertical ? 0 : side,
      dirZ: d.vertical ? side : 0,
      // A hair further than its own width, so the trailing edge finishes inside
      // the jamb rather than flush with it — but never further than the wall
      // actually goes. `slidePocketSide` proves a pocket exactly as long as the
      // opening, and on the doorways where that is all the wall there is, the hair
      // put 3 to 4 cm of the panel's far end out in the open on the other side. It
      // is the same panel either way; what changed is that the number now comes
      // from the wall rather than from a multiplier.
      travel: Math.min(g.width * 1.02,
        Math.max(0, slidePocketRun(layout.tiles, layout.W, layout.H, d, side) * TILE - POCKET_CLEAR)),
    });
  }
}

/**
 * The doors across the corridors: two leaves on hinges, no runner.
 *
 * Why they swing at all is layout.js's story (see cutHallDoors) — there is no
 * wall beside a corridor to pocket a panel into. What that buys here is that a
 * leaf needs nothing built for it: it turns about its own hinge into corridor
 * air the generator has already proved is clear.
 *
 * Both leaves are ONE door as far as doors.js is concerned. They share a sensor
 * because they are one doorway, they share a sound because two identical door
 * noises a millisecond apart is a flam rather than a pair of doors, and they
 * share a collider because two leaves shut is exactly the opening. They share
 * one badge reader too, for the same reason: it is one doorway.
 */

/**
 * The doors across the corridors: two leaves on hinges, no runner.
 *
 * Why they swing at all is layout.js's story (see cutHallDoors) — there is no
 * wall beside a corridor to pocket a panel into. What that buys here is that a
 * leaf needs nothing built for it: it turns about its own hinge into corridor
 * air the generator has already proved is clear.
 *
 * Both leaves are ONE door as far as doors.js is concerned. They share a sensor
 * because they are one doorway, they share a sound because two identical door
 * noises a millisecond apart is a flam rather than a pair of doors, and they
 * share a collider because two leaves shut is exactly the opening. They share
 * one badge reader too, for the same reason: it is one doorway.
 */
export function buildHallDoors(layout, scene, materials, doors, colliders, readers) {
  for (const d of layout.doors) {
    if (!d.hall) continue;

    const g = doorway(layout, d);
    const root = new THREE.Group();
    const leaves = [];

    // One leaf hinged at each end of the opening, each an arm reaching back to
    // the middle. `end` is which end it hangs from, and it is also the sign of
    // the arm — so it is the whole of the difference between the two.
    for (const end of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(
        d.vertical ? g.cx : (end < 0 ? g.x0 : g.x1),
        0,
        d.vertical ? (end < 0 ? g.z0 : g.z1) : g.cz);
      pivot.add(doorPanel(materials, d, g.half,
        d.vertical ? 0 : -end * g.half / 2,
        d.vertical ? -end * g.half / 2 : 0));
      root.add(pivot);

      // A quarter turn, and which quarter is the one that lays the arm down the
      // way the generator said the wall is. The two leaves turn opposite ways
      // for the same reason two doors on one frame do: their arms point at each
      // other to start with.
      leaves.push({ pivot, angleTo: (d.vertical ? -1 : 1) * end * d.swing * Math.PI / 2 });
    }
    scene.add(root);

    addDoor(doors, colliders, readers, d, g, { root, leaves });
  }
}

// --- the lift cars ----------------------------------------------------------

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
function fitPartingDoors(layout, d, scene, materials, doors, colliders, travelFor, readers) {
  const g = doorway(layout, d);
  const root = new THREE.Group();
  const panels = [];

  for (const end of [-1, 1]) {
    const px = d.vertical ? g.cx : g.cx + end * g.half / 2;
    const pz = d.vertical ? g.cz + end * g.half / 2 : g.cz;
    const mesh = doorPanel(materials, d, g.half, px, pz);
    root.add(mesh);
    panels.push({
      mesh, baseX: px, baseZ: pz,
      dirX: d.vertical ? 0 : end,
      dirZ: d.vertical ? end : 0,
      travel: travelFor(end, g.half),
    });
  }
  scene.add(root);

  // Neither of these doorways is ever badged — a car has no reader and the
  // lobby's way out is marked `free` before a single lock is assigned. It still
  // goes through `addDoor` like the other two rather than hardcoding `null`,
  // because a reader the generator asked for and the builder did not fit is a
  // lock that seals nothing and says nothing.
  addDoor(doors, colliders, readers, d, g, { root, panels });
}

export function fitLiftDoors(layout, lift, scene, materials, doors, colliders) {
  // Its own width, less the same hair `slidePocketRun` keeps: a car's pocket is
  // exactly one leaf long, so travelling the full width would put the far face
  // of the leaf flush with the far face of the jamb — which is a shimmering
  // rectangle of door on the end of a wall.
  fitPartingDoors(layout, lift.door, scene, materials, doors, colliders,
    (end, half) => Math.max(0, half - POCKET_CLEAR));
}

/**
 * The lobby's own doors: a pair, and never locked.
 *
 * The one doorway in the building the player meets before they have moved, and
 * the one they walk back to. A single panel sliding sideways out of a lift lobby
 * reads as a cupboard being opened; two leaves parting in the middle is a way
 * out of a lobby, and it is the same statement the two cars behind them are
 * making one wall back.
 *
 * The leaves are the cars', with one difference that is the whole of this
 * function: a car's front was BUILT round its pocket and a room's wall was not,
 * so how far each leaf may run is measured (`slidePocketRun`) rather than
 * assumed. A short pocket leaves a hand's width of leaf standing in the opening
 * rather than putting the far end of it out in the next room, which is the trade
 * every sliding panel in this building already makes and for the same reason.
 *
 * Never badged, and that is settled in gen/layout.js rather than here — the
 * lobby's doorways are marked `free` before a single lock is assigned, because a
 * reader on the way out of the lobby is the one lock in the game that can shut
 * the player in holding nothing.
 */

/**
 * The lobby's own doors: a pair, and never locked.
 *
 * The one doorway in the building the player meets before they have moved, and
 * the one they walk back to. A single panel sliding sideways out of a lift lobby
 * reads as a cupboard being opened; two leaves parting in the middle is a way
 * out of a lobby, and it is the same statement the two cars behind them are
 * making one wall back.
 *
 * The leaves are the cars', with one difference that is the whole of this
 * function: a car's front was BUILT round its pocket and a room's wall was not,
 * so how far each leaf may run is measured (`slidePocketRun`) rather than
 * assumed. A short pocket leaves a hand's width of leaf standing in the opening
 * rather than putting the far end of it out in the next room, which is the trade
 * every sliding panel in this building already makes and for the same reason.
 *
 * Never badged, and that is settled in gen/layout.js rather than here — the
 * lobby's doorways are marked `free` before a single lock is assigned, because a
 * reader on the way out of the lobby is the one lock in the game that can shut
 * the player in holding nothing.
 */
export function buildDoubleDoors(layout, scene, materials, doors, colliders, readers) {
  for (const d of layout.doors) {
    if (!d.double || d.hall || d.lift) continue;
    fitPartingDoors(layout, d, scene, materials, doors, colliders, (end, half) => {
      const run = slidePocketRun(layout.tiles, layout.W, layout.H, d, end) * TILE;
      return Math.max(0, Math.min(half, run) - POCKET_CLEAR);
    }, readers);
  }
}

// --- badge readers ----------------------------------------------------------

const READER_H = 1.15;         // metres up the jamb — where your hand goes
// Hall doors only: how far back along the corridor the reader sits from the door
// line, and how deep into the side wall — the rest of the plate stands proud of
// it. See add().

// Hall doors only: how far back along the corridor the reader sits from the door
// line, and how deep into the side wall — the rest of the plate stands proud of
// it. See add().
const READER_STEP = 0.45;

const READER_PROUD = 0.06;

/**
 * A badge reader beside every badged doorway.
 *
 * The panel on a locked door looks exactly like the panel on an unlocked one,
 * and a door that silently refuses to open reads as a bug rather than as a lock.
 * So the lock is stated on the wall before you are close enough for the sensor
 * to have decided anything, and it states two separate things: the lamp says
 * locked or open, in red and green, and the plate around it is the colour of the
 * card that opens it. Which card you need is a question you want answered from
 * the far end of a corridor; whether you have already been through is one you
 * only ask standing in front of it.
 *
 * Each is sunk into the jamb at the end of the opening and pokes a couple of
 * centimetres out of BOTH faces of the wall, because a doorway has two sides and
 * you may well arrive at either.
 *
 * Two InstancedMeshes for the whole floor, plate and lamp, rather than a mesh
 * each. White is on every door in the building, so this went from a handful of
 * readers to two hundred of them, and two hundred little boxes is two hundred
 * more draw calls than a floor should spend on door furniture. Instancing also
 * makes turning one green a colour write rather than a material, which is what
 * lets a single card pickup relight the entire floor in one frame.
 */

/**
 * A badge reader beside every badged doorway.
 *
 * The panel on a locked door looks exactly like the panel on an unlocked one,
 * and a door that silently refuses to open reads as a bug rather than as a lock.
 * So the lock is stated on the wall before you are close enough for the sensor
 * to have decided anything, and it states two separate things: the lamp says
 * locked or open, in red and green, and the plate around it is the colour of the
 * card that opens it. Which card you need is a question you want answered from
 * the far end of a corridor; whether you have already been through is one you
 * only ask standing in front of it.
 *
 * Each is sunk into the jamb at the end of the opening and pokes a couple of
 * centimetres out of BOTH faces of the wall, because a doorway has two sides and
 * you may well arrive at either.
 *
 * Two InstancedMeshes for the whole floor, plate and lamp, rather than a mesh
 * each. White is on every door in the building, so this went from a handful of
 * readers to two hundred of them, and two hundred little boxes is two hundred
 * more draw calls than a floor should spend on door furniture. Instancing also
 * makes turning one green a colour write rather than a material, which is what
 * lets a single card pickup relight the entire floor in one frame.
 */
export class BadgeReaders {
  constructor(scene, objects, count) {
    // Sized for a vertical door and re-oriented per instance; the lamp is a
    // shade proud of the plate on each face so it is never edge-on.
    this.plates = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.56, 0.2, 0.15),
      new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.25 }),
      count);
    this.lamps = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.6, 0.075, 0.07),
      new THREE.MeshBasicMaterial(),
      count);

    for (const m of [this.plates, this.lamps]) {
      m.count = 0;                                  // grown as readers are added
      m.frustumCulled = false;                      // one object spanning a floor
      m.userData.ownMaterial = true;
      scene.add(m);
      objects.push(m);
    }

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
  }

  add(d, cx, cz, x1, z1) {
    const i = this.plates.count++;
    this.lamps.count++;

    if (d.hall) {
      // A doorway in a wall mounts its reader in that wall, just past the
      // opening, where you walk straight at it. A doorway ACROSS a corridor has
      // no such wall — the only one it touches is the corridor's own side,
      // running the other way — so this one turns ninety degrees, beds into that
      // side wall and stands most of its depth PROUD of it, which is how a
      // reader in a hallway is actually mounted and the only way it is visible
      // at all edge-on.
      //
      // And it steps back off the door line, against the swing: both leaves fold
      // flat onto these same walls, and a reader on that side would be a box
      // sticking through an open door.
      const back = READER_STEP * -(d.swing ?? 1);
      this._p.set(
        d.vertical ? cx + back : x1 + READER_PROUD,
        READER_H,
        d.vertical ? z1 + READER_PROUD : cz + back);
      this._q.setFromAxisAngle(UP, d.vertical ? Math.PI / 2 : 0);
    } else {
      this._p.set(d.vertical ? cx : x1 + 0.16, READER_H, d.vertical ? z1 + 0.16 : cz);
      this._q.setFromAxisAngle(UP, d.vertical ? 0 : Math.PI / 2);
    }
    this._m.compose(this._p, this._q, this._s);
    this.plates.setMatrixAt(i, this._m);
    this.lamps.setMatrixAt(i, this._m);

    this.plates.setColorAt(i, this._c.setHex((CARDS[d.lock] ?? CARDS.white).color));
    this.lamps.setColorAt(i, this._c.setHex(READER_LIT));

    // The handle a door keeps: it knows its own index and nothing else.
    return {
      setOpen: () => {
        this.lamps.setColorAt(i, this._c.setHex(READER_OPEN));
        this.lamps.instanceColor.needsUpdate = true;
      },
    };
  }

  finish() {
    for (const m of [this.plates, this.lamps]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}
