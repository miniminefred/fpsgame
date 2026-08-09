import * as THREE from 'three';
import { getAssets } from '../textures.js';
import { maskToRects } from './rects.js';
import { Batcher, boxBetween, slab, applyWorldUVs } from './geom.js';
import { tryPlace } from './props.js';
import { furnish } from './rooms.js';
import { modelInfo, stampModel, paintDebris } from './models.js';
import {
  TILE, WALL_H, CEIL_H, DOOR_H,
  SOLID, ROOM, CORRIDOR, DOOR, isOpen, worldX, worldZ,
} from './layout.js';

// Turns an abstract floorplan into everything the game needs: batched meshes,
// collision AABBs, a nav grid for the enemies, and the list of ceiling lights
// the light pool draws from.

const BASEBOARD_H = 0.11;
const WINDOW_Y0 = 1.0;
const WINDOW_Y1 = 2.35;
const MIN_WINDOW_RUN = 6;      // tiles (3 m) — shorter runs aren't worth glazing
const MAX_WINDOW_DEPTH = 7;    // tiles in from the facade before it's not a facade
const LIGHT_PITCH = 4;         // metres between ceiling fixtures

// Glass and ceiling tubes are one-shot from any weapon on purpose: they are
// scenery you interact with, not cover you have to grind through.
const GLASS_HP = 1;
const PANEL_HP = 1;
const GLASS_OFFSET = 0.03;     // metres the glazing sits in front of the sky

// Not every room got the same refit. The rooms staff and visitors see are lit
// with cool white panels; the rooms nobody was ever meant to stand in still have
// the old warm tubes in them, running a little dimmer and a long way yellower.
//
// It is a small difference on any one fixture and a large one across a room, and
// it does the job three walls of signage would otherwise have to: you can tell
// from the doorway whether you have walked into somewhere that matters.
const FRONT_OF_HOUSE = { key: 'panel', color: 0xfff4de, intensity: 16 };
const BACK_OF_HOUSE = { key: 'panelWarm', color: 0xffd89a, intensity: 12 };
const GRADE = {
  storage: BACK_OF_HOUSE,
  archive: BACK_OF_HOUSE,
  utility: BACK_OF_HOUSE,
  mailroom: BACK_OF_HOUSE,
  copyroom: BACK_OF_HOUSE,
  itbay: BACK_OF_HOUSE,
  server: BACK_OF_HOUSE,
};

export function buildLevel(scene, layout) {
  const { materials } = getAssets();
  const { W, H, tiles, rng } = layout;

  const batcher = new Batcher();
  const colliders = [];
  const objects = [];
  const fixtures = [];

  // Nav/placement bookkeeping, all on the same tile grid as the layout.
  const blocked = new Uint8Array(W * H);   // props too tall for an enemy to pass
  const occupied = new Uint8Array(W * H);  // footprint of anything already placed
  const reserved = new Uint8Array(W * H);  // doorways, spawn, exit — keep clear
  const dynamics = [];                     // loose props handed to the physics world
  const destructibles = [];                // everything static that can be shot apart
  const doors = [];                        // sliding panels, see doors.js

  reserveClearances(layout, reserved);

  buildShell(layout, batcher, materials, colliders);
  buildDoorFrames(layout, batcher, materials);
  buildWindows(layout, batcher, materials, fixtures, destructibles);
  buildCeilingLights(layout, batcher, materials, fixtures, destructibles);
  // Doors are their own meshes rather than batched geometry, for the obvious
  // reason: a batched thing cannot move.
  buildSlidingDoors(layout, scene, materials, doors, colliders, rng);

  const sink = makeSink(layout, batcher, materials,
    { blocked, occupied, reserved, colliders, dynamics, destructibles });
  furnishRooms(layout, sink, rng);
  furnishCorridors(layout, sink, rng);

  const meshes = batcher.build(scene);
  objects.push(...meshes);

  // Loose props go in as their own meshes so physics can shove them around.
  for (const dyn of dynamics) {
    scene.add(dyn.group);
    objects.push(dyn.group);
    meshes.push(...dyn.group.children);
  }

  for (const door of doors) objects.push(door.mesh);

  const exitObject = buildExit(scene, layout, fixtures);
  objects.push(exitObject);

  // Walkable = open floor the enemies can actually stand on.
  const walk = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) walk[i] = isOpen(tiles[i]) && !blocked[i] ? 1 : 0;

  return {
    layout,
    meshes,          // raycast targets for bullets
    objects,         // everything added to the scene, for teardown
    colliders,
    dynamics,
    destructibles,
    doors,
    fixtures,
    exitObject,
    nav: { W, H, TILE, ox: layout.ox, oz: layout.oz, walk, tiles },
  };
}

// --- shell: walls, floors, ceiling ------------------------------------------

function buildShell(layout, batcher, materials, colliders) {
  const { W, H, tiles } = layout;

  // Walls. Merging tile runs into rectangles first keeps this to a couple of
  // hundred boxes instead of tens of thousands.
  for (const r of maskToRects(tiles, W, H, (t) => t === SOLID)) {
    const x0 = worldX(layout, r.x0), x1 = worldX(layout, r.x1);
    const z0 = worldZ(layout, r.y0), z1 = worldZ(layout, r.y1);

    batcher.add('wall', materials.wall, applyWorldUVs(boxBetween(x0, 0, z0, x1, WALL_H, z1)));
    // Skirting board, proud of the wall face so it catches a highlight.
    batcher.add('trim', materials.trim,
      boxBetween(x0 - 0.015, 0, z0 - 0.015, x1 + 0.015, BASEBOARD_H, z1 + 0.015));

    colliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, top: WALL_H });
  }

  // Carpet in the rooms, vinyl in the corridors and doorways — the floor change
  // underfoot is the clearest signal of where you are.
  for (const r of maskToRects(tiles, W, H, (t) => t === ROOM)) {
    batcher.add('carpet', materials.carpet, applyWorldUVs(floorSlab(layout, r, 0)),
      { castShadow: false });
  }
  for (const r of maskToRects(tiles, W, H, (t) => t === CORRIDOR || t === DOOR)) {
    batcher.add('vinyl', materials.vinyl, applyWorldUVs(floorSlab(layout, r, 0)),
      { castShadow: false });
  }

  // Suspended ceiling over everything walkable.
  for (const r of maskToRects(tiles, W, H, isOpen)) {
    batcher.add('ceiling', materials.ceiling, applyWorldUVs(floorSlab(layout, r, CEIL_H, false)),
      { castShadow: false });
  }
}

function floorSlab(layout, r, y, up = true) {
  return slab(worldX(layout, r.x0), worldZ(layout, r.y0),
    worldX(layout, r.x1), worldZ(layout, r.y1), y, up);
}

const FRAME_T = 0.06;

// A doorway is three pieces of geometry meeting in the same few centimetres —
// the wall above it, the header, and the jambs — and every shared plane between
// them is a z-fight waiting to happen. Two rules keep it clean:
//
//  1. The frame LINES the opening rather than sitting flush with its mouth. A
//     jamb spanning the last tile of wall would put its inner face exactly on
//     the wall's reveal face, both pointing the same way; moving it just inside
//     the opening puts the two faces back-to-back instead, where backface
//     culling deals with them.
//  2. Nothing abuts — everything OVERLAPS. The wall above starts half a frame
//     depth *inside* the header, and the jambs run half a frame depth *into* it,
//     so every buried face ends up strictly inside solid geometry instead of
//     level with another face.
const LINTEL_Y = DOOR_H + FRAME_T * 0.5;
const JAMB_TOP = DOOR_H + FRAME_T * 0.5;

function buildDoorFrames(layout, batcher, materials) {
  for (const d of layout.doors) {
    const x0 = worldX(layout, d.x0), x1 = worldX(layout, d.x1);
    const z0 = worldZ(layout, d.y0), z1 = worldZ(layout, d.y1);
    const T = FRAME_T;

    const frame = (a0, b0, c0, a1, b1, c1) =>
      batcher.add('doorframe', materials.doorframe, boxBetween(a0, b0, c0, a1, b1, c1));

    batcher.add('wall', materials.wall,
      applyWorldUVs(boxBetween(x0, LINTEL_Y, z0, x1, WALL_H, z1)));

    if (d.vertical) {
      // Wall runs along Z, one tile thick in X; the opening spans z0..z1.
      frame(x0 - T, 0, z0, x1 + T, JAMB_TOP, z0 + T);
      frame(x0 - T, 0, z1 - T, x1 + T, JAMB_TOP, z1);
      frame(x0 - T, DOOR_H, z0, x1 + T, DOOR_H + T, z1);
    } else {
      // Wall runs along X, one tile thick in Z; the opening spans x0..x1.
      frame(x0, 0, z0 - T, x0 + T, JAMB_TOP, z1 + T);
      frame(x1 - T, 0, z0 - T, x1, JAMB_TOP, z1 + T);
      frame(x0, DOOR_H, z0 - T, x1, DOOR_H + T, z1 + T);
    }
  }
}

// --- windows ----------------------------------------------------------------

// Walks in from each facade to find the first open tile in every row/column;
// where a long enough stretch sits at the same depth, that's an outside wall
// worth glazing.
function buildWindows(layout, batcher, materials, fixtures, destructibles) {
  const { W, H, tiles } = layout;

  const sides = [
    { axis: 'x', outward: -1, scan: H, probe: (i, d) => tiles[i * W + d] },                 // west
    { axis: 'x', outward: 1, scan: H, probe: (i, d) => tiles[i * W + (W - 1 - d)] },        // east
    { axis: 'z', outward: -1, scan: W, probe: (i, d) => tiles[d * W + i] },                 // north
    { axis: 'z', outward: 1, scan: W, probe: (i, d) => tiles[(H - 1 - d) * W + i] },        // south
  ];

  for (const side of sides) {
    let run = null;
    const flush = () => {
      if (run && run.to - run.from >= MIN_WINDOW_RUN) {
        emitWindow(layout, batcher, materials, fixtures, destructibles, side, run);
      }
      run = null;
    };

    for (let i = 1; i < side.scan - 1; i++) {
      let depth = -1;
      for (let d = 1; d <= MAX_WINDOW_DEPTH; d++) {
        if (isOpen(side.probe(i, d))) { depth = d; break; }
      }
      if (depth < 0) { flush(); continue; }
      if (run && run.depth === depth) run.to = i + 1;
      else { flush(); run = { depth, from: i, to: i + 1 }; }
    }
    flush();
  }
}

function emitWindow(layout, batcher, materials, fixtures, destructibles, side, run) {
  const { W, H } = layout;
  // Depth is measured from the grid edge; convert to the face of the wall that
  // the room actually sees, then pull the glass just clear of it.
  const inner = side.outward < 0 ? run.depth : (side.axis === 'x' ? W : H) - run.depth;
  const at = (side.axis === 'x' ? worldX : worldZ)(layout, inner) - side.outward * 0.02;

  const a0 = (side.axis === 'x' ? worldZ : worldX)(layout, run.from);
  const a1 = (side.axis === 'x' ? worldZ : worldX)(layout, run.to);
  const facingPositive = side.outward < 0;   // glass faces back into the building

  // The sky is a permanent backdrop, not the window. Behind it is solid wall —
  // the shell is never cut — so if the sky went away with the glass, shooting a
  // window out would replace the view with grey drywall and read as a bug.
  // Leaving it and taking only the glazing away is what makes it read right.
  batcher.add('window', materials.window,
    paneQuad(side.axis, at, a0, a1, WINDOW_Y0, WINDOW_Y1, facingPositive),
    { castShadow: false, receiveShadow: false });

  // Frame and mullions, in from the glass so they sit proud of it.
  const T = 0.05;
  const push = (b0, b1, y0, y1) => {
    const g = side.axis === 'x'
      ? boxBetween(at - T, y0, b0, at + T, y1, b1)
      : boxBetween(b0, y0, at - T, b1, y1, at + T);
    batcher.add('doorframe', materials.doorframe, g, { castShadow: false });
  };
  push(a0, a0 + 0.06, WINDOW_Y0, WINDOW_Y1);
  push(a1 - 0.06, a1, WINDOW_Y0, WINDOW_Y1);
  push(a0, a1, WINDOW_Y0 - 0.06, WINDOW_Y0);
  push(a0, a1, WINDOW_Y1, WINDOW_Y1 + 0.06);
  const bays = Math.max(1, Math.round((a1 - a0) / 1.6));
  for (let m = 1; m < bays; m++) {
    const t = a0 + (a1 - a0) * (m / bays);
    push(t - 0.03, t + 0.03, WINDOW_Y0, WINDOW_Y1);
  }

  // Daylight spilling in, as a cool counterpoint to the warm ceiling tubes.
  const daylight = [];
  const steps = Math.max(1, Math.round((a1 - a0) / 4));
  for (let s = 0; s < steps; s++) {
    const t = a0 + (a1 - a0) * ((s + 0.5) / steps);
    const inset = side.outward * -1.1;
    const fixture = {
      x: side.axis === 'x' ? at + inset : t,
      y: 1.9,
      z: side.axis === 'x' ? t : at + inset,
      color: 0xbcd6f0, intensity: 6, distance: 9,
      at: t,
    };
    fixtures.push(fixture);
    daylight.push(fixture);
  }

  // The glazing: one destructible pane per bay, a few centimetres inside the
  // sky, so a window comes out a bay at a time rather than a whole facade run.
  const glassAt = at - side.outward * GLASS_OFFSET;
  for (let b = 0; b < bays; b++) {
    const b0 = a0 + (a1 - a0) * (b / bays);
    const b1 = a0 + (a1 - a0) * ((b + 1) / bays);

    const spans = batcher.beginSpans();
    batcher.add('glass', materials.glass,
      paneQuad(side.axis, glassAt, b0 + 0.03, b1 - 0.03, WINDOW_Y0, WINDOW_Y1, facingPositive),
      { castShadow: false, receiveShadow: false });
    batcher.endSpans();

    destructibles.push({
      kind: 'glass',
      hp: GLASS_HP,
      spans,
      colliders: [],
      navTiles: [],
      // Losing the daylight when the pane goes is a gameplay call, not a
      // physical one: shooting the windows out is a way to darken a room.
      fixtures: daylight.filter((f) => f.at >= b0 && f.at < b1),
      parts: glassShards(side.axis, glassAt, b0, b1, materials.glass),
      broken: false,
    });
  }
}

// A pane falls into a 2 x 2 of slabs — deliberately not random, so the pieces
// always add back up to the pane that was there a moment ago.
function glassShards(axis, at, b0, b1, material) {
  const shards = [];
  const T = 0.012;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const c0 = b0 + (b1 - b0) * (i / 2) + 0.02;
      const c1 = b0 + (b1 - b0) * ((i + 1) / 2) - 0.02;
      const y0 = WINDOW_Y0 + (WINDOW_Y1 - WINDOW_Y0) * (j / 2) + 0.02;
      const y1 = WINDOW_Y0 + (WINDOW_Y1 - WINDOW_Y0) * ((j + 1) / 2) - 0.02;
      shards.push(axis === 'x'
        ? { material, x0: at - T, y0, z0: c0, x1: at + T, y1, z1: c1 }
        : { material, x0: c0, y0, z0: at - T, x1: c1, y1, z1: at + T });
    }
  }
  return shards;
}

// A vertical quad, with its UVs scaled so the sky texture keeps a constant
// world size no matter how long the window run is.
function paneQuad(axis, at, a0, a1, y0, y1, facingPositive) {
  const w = a1 - a0;
  const h = y1 - y0;
  const geo = new THREE.PlaneGeometry(w, h);

  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (w / 2.4));
  uv.needsUpdate = true;

  if (axis === 'x') {
    geo.rotateY(facingPositive ? Math.PI / 2 : -Math.PI / 2);
    geo.translate(at, (y0 + y1) / 2, (a0 + a1) / 2);
  } else {
    if (!facingPositive) geo.rotateY(Math.PI);
    geo.translate((a0 + a1) / 2, (y0 + y1) / 2, at);
  }
  return geo;
}

// --- ceiling lights ---------------------------------------------------------

// Fixtures are placed per room and then along the corridors, NOT on one global
// grid. A global grid seems simpler, but rooms are only ~4.5 m across at the
// smallest and the grid pitch is 4 m, so a room could easily fall between
// sample points and come out with no ceiling light at all — a pitch-black
// office in the middle of a lit floor. Walking the rooms guarantees every one
// gets at least a fixture at its centre.
function buildCeilingLights(layout, batcher, materials, fixtures, destructibles) {
  const { W, H, tiles } = layout;

  const addFixture = (x, z, alongX, grade = FRONT_OF_HOUSE) => {
    const hw = alongX ? 0.62 : 0.16;
    const hd = alongX ? 0.16 : 0.62;

    const spans = batcher.beginSpans();
    batcher.add(grade.key, materials[grade.key],
      slab(x - hw, z - hd, x + hw, z + hd, CEIL_H - 0.015, false),
      { castShadow: false, receiveShadow: false });
    batcher.endSpans();

    const fixture = {
      x, y: CEIL_H - 0.12, z,
      color: grade.color, intensity: grade.intensity, distance: 11,
    };
    fixtures.push(fixture);

    // Shooting the tube out kills both halves of a fixture at once: the
    // emissive panel that lights the whole floor for free, and the pool light
    // that lights the room you're standing in.
    destructibles.push({
      kind: 'panel',
      hp: PANEL_HP,
      spans,
      colliders: [],
      navTiles: [],
      fixtures: [fixture],
      parts: [
        { material: materials[grade.key], x0: x - hw, y0: CEIL_H - 0.05, z0: z - hd, x1: x, y1: CEIL_H - 0.02, z1: z + hd },
        { material: materials[grade.key], x0: x, y0: CEIL_H - 0.05, z0: z - hd, x1: x + hw, y1: CEIL_H - 0.02, z1: z + hd },
      ],
      broken: false,
    });
  };

  for (const room of layout.rooms) {
    const x0 = worldX(layout, room.x0), x1 = worldX(layout, room.x1);
    const z0 = worldZ(layout, room.y0), z1 = worldZ(layout, room.y1);
    const nx = Math.max(1, Math.round((x1 - x0) / LIGHT_PITCH));
    const nz = Math.max(1, Math.round((z1 - z0) / LIGHT_PITCH));
    const alongX = (x1 - x0) >= (z1 - z0);

    const grade = GRADE[room.role] ?? FRONT_OF_HOUSE;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        addFixture(x0 + (x1 - x0) * ((i + 0.5) / nx), z0 + (z1 - z0) * ((j + 0.5) / nz), alongX, grade);
      }
    }
  }

  // Corridors are 6 tiles wide, so a 6-tile lattice always lands on them a few
  // times along their length. Tubes run the way the corridor runs.
  const step = 6;
  for (let ty = step; ty < H - step; ty += step) {
    for (let tx = step; tx < W - step; tx += step) {
      if (tiles[ty * W + tx] !== CORRIDOR) continue;
      const runX = tiles[ty * W + tx - 4] === CORRIDOR && tiles[ty * W + tx + 4] === CORRIDOR;
      addFixture(worldX(layout, tx + 0.5), worldZ(layout, ty + 0.5), runX);
    }
  }
}

// --- sliding doors ----------------------------------------------------------

const DOOR_T = 0.09;           // panel thickness
const DOOR_PANEL_H = DOOR_H - 0.04;
// A retracted panel has to go somewhere, and where it goes is inside the wall
// next to the opening. So the wall has to BE there: the full width of the panel,
// on the same line, solid the whole way, and one tile deep on both faces. Near a
// corner it is not, and a door fitted there would slide out into the corridor
// and hang in mid-air at right angles to its own frame. Those doorways simply
// do not get a door — a floor with a few open doorways on it reads as a floor
// with a few open doorways on it, which is what an office looks like anyway.
function slidePocket(layout, door, dir) {
  const { W, H, tiles } = layout;
  const at = (tx, ty) => (tx >= 0 && ty >= 0 && tx < W && ty < H ? tiles[ty * W + tx] : SOLID);

  const span = door.vertical ? door.y1 - door.y0 : door.x1 - door.x0;
  for (let i = 1; i <= span; i++) {
    if (door.vertical) {
      const ty = dir > 0 ? door.y1 - 1 + i : door.y0 - i;
      // The wall line itself must be solid, and so must the tile either side of
      // it — otherwise the "wall" is one tile of jamb with a room behind it.
      if (at(door.x0, ty) !== SOLID) return false;
    } else {
      const tx = dir > 0 ? door.x1 - 1 + i : door.x0 - i;
      if (at(tx, door.y0) !== SOLID) return false;
    }
  }
  return true;
}

function buildSlidingDoors(layout, scene, materials, doors, colliders, rng) {
  const geo = new THREE.BoxGeometry(1, 1, 1);

  for (const d of layout.doors) {
    // Not every doorway has a door in it. Some were taken off their runners
    // years ago and nobody replaced them.
    if (!rng.chance(0.55)) continue;

    const dir = rng.chance(0.5) ? 1 : -1;
    const side = slidePocket(layout, d, dir) ? dir
      : slidePocket(layout, d, -dir) ? -dir
        : 0;
    if (!side) continue;

    const x0 = worldX(layout, d.x0), x1 = worldX(layout, d.x1);
    const z0 = worldZ(layout, d.y0), z1 = worldZ(layout, d.y1);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const width = d.vertical ? z1 - z0 : x1 - x0;

    const mesh = new THREE.Mesh(geo, materials.doorPanel);
    mesh.scale.set(
      d.vertical ? DOOR_T : width,
      DOOR_PANEL_H,
      d.vertical ? width : DOOR_T);
    mesh.position.set(cx, DOOR_PANEL_H / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // The collider is the closed footprint. It is not retired when the door
    // opens — its `top` is dropped below the floor instead, which is how every
    // other collider in this game says "walk through me" (see player.js).
    const collider = {
      minX: d.vertical ? cx - DOOR_T / 2 : x0,
      maxX: d.vertical ? cx + DOOR_T / 2 : x1,
      minZ: d.vertical ? z0 : cz - DOOR_T / 2,
      maxZ: d.vertical ? z1 : cz + DOOR_T / 2,
      top: DOOR_PANEL_H,
      // Not furniture. It stands in a doorway on purpose and it is out of the
      // way whenever anybody is there, so the checks that police what may block
      // a doorway have to be able to tell it apart from a filing cabinet.
      door: true,
    };
    colliders.push(collider);

    doors.push({
      mesh, collider,
      x: cx, z: cz,
      at: new THREE.Vector3(cx, 1.2, cz),
      baseX: cx, baseZ: cz,
      dirX: d.vertical ? 0 : side,
      dirZ: d.vertical ? side : 0,
      // A hair further than its own width, so the leading edge finishes inside
      // the jamb rather than flush with it.
      travel: width * 1.02,
      height: DOOR_PANEL_H,
    });
  }
}

// --- furnishing -------------------------------------------------------------

function makeSink(layout, batcher, materials, masks) {
  const { W, H, tiles } = layout;
  const { blocked, occupied, reserved, colliders, dynamics, destructibles } = masks;

  // While a dynamic prop is being authored, its boxes are collected here
  // instead of going into the static batch — they need to stay a separate
  // mesh so physics can move them.
  let pending = null;
  // A static prop being authored: everything it draws, blocks and collides
  // with, gathered so all of it can be taken away in one go when it's shot.
  let record = null;
  // A dry run of a prop's `build`, collecting the boxes without drawing them.
  let capture = null;

  // Tile range covering a world-space AABB.
  const range = (x0, z0, x1, z1) => ({
    tx0: Math.max(0, Math.floor((x0 - layout.ox) / TILE)),
    tx1: Math.min(W - 1, Math.ceil((x1 - layout.ox) / TILE) - 1),
    ty0: Math.max(0, Math.floor((z0 - layout.oz) / TILE)),
    ty1: Math.min(H - 1, Math.ceil((z1 - layout.oz) / TILE) - 1),
  });

  // Reserving floor rounds OUTWARD — being generous is what stops two props
  // overlapping.
  const stamp = (mask, x0, z0, x1, z1) => {
    const r = range(x0, z0, x1, z1);
    for (let ty = r.ty0; ty <= r.ty1; ty++) {
      for (let tx = r.tx0; tx <= r.tx1; tx++) mask[ty * W + tx] = 1;
    }
  };

  // Blocking navigation rounds to tile CENTRES instead. Rounding outward here
  // inflates every prop to whole half-metre tiles — a 0.66 m cabinet would
  // block a full metre — which walls off gaps a body can plainly walk through
  // and leaves the enemies with a floorplan the player doesn't share.
  const stampCentres = (mask, x0, z0, x1, z1, into) => {
    const tx0 = Math.max(0, Math.ceil((x0 - layout.ox) / TILE - 0.5));
    const tx1 = Math.min(W - 1, Math.floor((x1 - layout.ox) / TILE - 0.5));
    const ty0 = Math.max(0, Math.ceil((z0 - layout.oz) / TILE - 0.5));
    const ty1 = Math.min(H - 1, Math.floor((z1 - layout.oz) / TILE - 0.5));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        mask[ty * W + tx] = 1;
        into?.push(ty * W + tx);
      }
    }
  };

  return {
    canPlace(x0, z0, x1, z1) {
      const r = range(x0, z0, x1, z1);
      if (r.tx1 < r.tx0 || r.ty1 < r.ty0) return false;
      for (let ty = r.ty0; ty <= r.ty1; ty++) {
        for (let tx = r.tx0; tx <= r.tx1; tx++) {
          const i = ty * W + tx;
          if (!isOpen(tiles[i]) || occupied[i] || reserved[i]) return false;
        }
      }
      return true;
    },

    occupy(x0, z0, x1, z1) { stamp(occupied, x0, z0, x1, z1); },

    box(key, x0, y0, z0, x1, y1, z1) {
      const b = { key, x0, y0, z0, x1, y1, z1 };
      if (capture) { capture.push(b); return; }
      if (pending) { pending.boxes.push(b); return; }
      batcher.add(key, materials[key], boxBetween(x0, y0, z0, x1, y1, z1));
      record?.boxes.push(b);
    },

    obstacle(x0, z0, x1, z1, top) {
      // A dynamic prop's footprint moves, so it can't become a static collider
      // or a permanent hole in the nav grid. A dry run isn't there at all.
      if (pending || capture) return;
      const collider = { minX: x0, maxX: x1, minZ: z0, maxZ: z1, top };
      colliders.push(collider);
      record?.colliders.push(collider);
      // Anything the player can't step over blocks the enemies too. The
      // threshold has to match the player's step tolerance (STEP_EPS in
      // player.js): a sofa at 0.44 m and a plant pot at 0.34 m are both solid
      // to walk into, so leaving them out of the nav grid gave the enemies
      // routes straight through the furniture.
      if (top > 0.3) stampCentres(blocked, x0, z0, x1, z1, record?.navTiles);
    },

    // --- downloaded models -------------------------------------------------
    modelInfo,

    // Batched by source material, so a floor of desks is a couple of draw calls.
    model(key, x, y, z, yaw) {
      return stampModel(key, x, y, z, yaw, (geometry, material) => {
        batcher.add(`mdl:${material.name || 'm'}:${material.id}`, material, geometry);
      });
    },

    // Runs `fn` with everything it draws diverted into a list instead of into
    // the world. Model-backed props use this to work out what they should break
    // into without drawing the boxes they'd break into.
    captureBoxes(fn) {
      const previous = capture;
      const boxes = [];
      capture = boxes;
      try { fn(); } finally { capture = previous; }
      return boxes;
    },

    // Gives captured boxes the colours of the models stamped in their place, so
    // the wreckage is recognisably the thing that was standing there.
    paintDebris,

    // --- static props ------------------------------------------------------

    beginStatic(hp, substance, volatile = false) {
      record = hp > 0
        ? {
          hp, substance, volatile,
          boxes: [], colliders: [], navTiles: [], spans: batcher.beginSpans(),
        }
        : null;
    },

    // Files the prop away as one destructible unit: the vertex runs to erase,
    // the colliders to retire, the nav tiles to give back, and the boxes to
    // scatter. `debris` stands in for the geometry a model-backed prop drew as
    // a model and therefore cannot break into — and it ADDS to whatever that
    // prop did draw as boxes, because a rack's stock is real geometry that has
    // to come off the shelf with the shelf.
    endStatic(debris) {
      const r = record;
      record = null;
      if (!r) return;
      batcher.endSpans();
      if (!r.spans.length) return;

      destructibles.push({
        kind: 'prop',
        // What it is made of, so a bullet into a filing cabinet and a bullet
        // into a pot plant do not make the same noise.
        substance: r.substance,
        hp: r.hp,
        // A pressure vessel. Destroying it launches it instead of breaking it.
        volatile: r.volatile,
        spans: r.spans,
        colliders: r.colliders,
        navTiles: r.navTiles,
        fixtures: [],
        // A captured box may already carry the colour of the model that was
        // drawn over it (see `paintDebris`); anything else wears the palette it
        // was authored in.
        parts: (debris ? [...debris, ...r.boxes] : r.boxes)
          .map((b) => ({ ...b, material: b.material ?? materials[b.key] })),
        broken: false,
      });
    },

    beginDynamic(mass, hp, substance) { pending = { mass, hp, substance, boxes: [] }; },

    // Turns the collected boxes into one free-standing group whose origin sits
    // at the centre of their combined bounds — which is exactly where the
    // physics body's origin is, so syncing the two is a straight copy.
    endDynamic() {
      const p = pending;
      pending = null;
      if (!p || !p.boxes.length) return;

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of p.boxes) {
        minX = Math.min(minX, b.x0); maxX = Math.max(maxX, b.x1);
        minY = Math.min(minY, b.y0); maxY = Math.max(maxY, b.y1);
        minZ = Math.min(minZ, b.z0); maxZ = Math.max(maxZ, b.z1);
      }

      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      const group = new THREE.Group();
      group.position.set(cx, cy, cz);

      // The parts list is kept in the group's local space so that breaking the
      // prop apart is just "re-emit each of these as its own body" — the boxes
      // it was authored from are already the pieces it should fall into.
      const parts = [];
      for (const b of p.boxes) {
        const local = {
          key: b.key,
          material: materials[b.key],
          x0: b.x0 - cx, y0: b.y0 - cy, z0: b.z0 - cz,
          x1: b.x1 - cx, y1: b.y1 - cy, z1: b.z1 - cz,
        };
        parts.push(local);

        const mesh = new THREE.Mesh(
          boxBetween(local.x0, local.y0, local.z0, local.x1, local.y1, local.z1),
          materials[b.key]
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }

      dynamics.push({
        group,
        parts,
        mass: p.mass,
        hp: p.hp ?? 0,
        substance: p.substance,
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
        position: { x: cx, y: cy, z: cz },
      });
    },
  };
}

function furnishRooms(layout, sink, rng) {
  for (const room of layout.rooms) {
    // Keep furniture off the walls so nothing clips into the skirting.
    const bounds = {
      x0: worldX(layout, room.x0) + 0.15,
      z0: worldZ(layout, room.y0) + 0.15,
      x1: worldX(layout, room.x1) - 0.15,
      z1: worldZ(layout, room.y1) - 0.15,
    };
    furnish(sink, room, bounds, rng);
  }
}

// Corridors stay walkable, but a few props along the walls stop them reading as
// empty tubes.
function furnishCorridors(layout, sink, rng) {
  const { W, H, tiles } = layout;
  const step = 7;
  const kinds = ['plant', 'waterCooler', 'crateStack', 'printer', 'cabinet'];

  for (let ty = step; ty < H - step; ty += step) {
    for (let tx = step; tx < W - step; tx += step) {
      if (tiles[ty * W + tx] !== CORRIDOR || !rng.chance(0.4)) continue;
      const x = worldX(layout, tx + 0.5);
      const z = worldZ(layout, ty + 0.5);
      tryPlace(sink, rng.pick(kinds), x, z, rng.int(0, 3), rng);
    }
  }
}

// Doorways, the spawn point and the exit must never be furnished shut.
function reserveClearances(layout, reserved) {
  const { W, H } = layout;

  const stampTiles = (tx0, ty0, tx1, ty1) => {
    for (let ty = Math.max(0, ty0); ty <= Math.min(H - 1, ty1); ty++) {
      for (let tx = Math.max(0, tx0); tx <= Math.min(W - 1, tx1); tx++) reserved[ty * W + tx] = 1;
    }
  };

  const SWING = 4; // tiles of clear floor on both sides of a doorway
  for (const d of layout.doors) {
    if (d.vertical) stampTiles(d.x0 - SWING, d.y0 - 1, d.x1 + SWING, d.y1);
    else stampTiles(d.x0 - 1, d.y0 - SWING, d.x1, d.y1 + SWING);
  }

  for (const room of [layout.spawnRoom, layout.exitRoom]) {
    const cx = Math.round(room.cx), cy = Math.round(room.cy);
    stampTiles(cx - 5, cy - 5, cx + 5, cy + 5);
  }
}

// --- the way out ------------------------------------------------------------

// A service hatch: a lit floor pad under a shaft of light. Deliberately not a
// door in a wall — it has to be placeable in any room the generator picks, and
// it has to be visible from across a dark floor.
function buildExit(scene, layout, fixtures) {
  const group = new THREE.Group();
  group.position.set(layout.exit.x, 0, layout.exit.z);

  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 0.06, 32),
    new THREE.MeshBasicMaterial({ color: 0x1c6b45 })
  );
  pad.position.y = 0.03;
  group.add(pad);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.95, 0.06, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0x64ffa0 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  group.add(ring);

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.85, 1.05, CEIL_H, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x64ffa0, transparent: true, opacity: 0.09,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  shaft.position.y = CEIL_H / 2;
  group.add(shaft);

  // These materials are one-offs rather than the shared cache, so the level
  // teardown is allowed to dispose them.
  group.traverse((child) => { child.userData.ownMaterial = true; });

  scene.add(group);
  fixtures.push({ x: layout.exit.x, y: 1.6, z: layout.exit.z, color: 0x64ffa0, intensity: 7, distance: 8 });

  group.userData.ring = ring;
  group.userData.shaft = shaft;
  return group;
}
