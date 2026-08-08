import * as THREE from 'three';
import { getAssets } from '../textures.js';
import { maskToRects } from './rects.js';
import { Batcher, boxBetween, slab, applyWorldUVs } from './geom.js';
import { furnish, tryPlace } from './props.js';
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

  reserveClearances(layout, reserved);

  buildShell(layout, batcher, materials, colliders);
  buildDoorFrames(layout, batcher, materials);
  buildWindows(layout, batcher, materials, fixtures);
  buildCeilingLights(layout, batcher, materials, fixtures);

  const sink = makeSink(layout, batcher, materials, { blocked, occupied, reserved, colliders });
  furnishRooms(layout, sink, rng);
  furnishCorridors(layout, sink, rng);

  const meshes = batcher.build(scene);
  objects.push(...meshes);

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

// A lintel over every doorway plus a frame down both jambs, so an opening reads
// as a door and not as a hole somebody knocked in the wall.
function buildDoorFrames(layout, batcher, materials) {
  for (const d of layout.doors) {
    const x0 = worldX(layout, d.x0), x1 = worldX(layout, d.x1);
    const z0 = worldZ(layout, d.y0), z1 = worldZ(layout, d.y1);

    batcher.add('wall', materials.wall,
      applyWorldUVs(boxBetween(x0, DOOR_H, z0, x1, WALL_H, z1)));

    const T = 0.06;
    if (d.vertical) {
      batcher.add('doorframe', materials.doorframe, boxBetween(x0 - T, 0, z0 - T, x1 + T, DOOR_H + T, z0));
      batcher.add('doorframe', materials.doorframe, boxBetween(x0 - T, 0, z1, x1 + T, DOOR_H + T, z1 + T));
      batcher.add('doorframe', materials.doorframe, boxBetween(x0 - T, DOOR_H, z0, x1 + T, DOOR_H + T, z1));
    } else {
      batcher.add('doorframe', materials.doorframe, boxBetween(x0 - T, 0, z0 - T, x0, DOOR_H + T, z1 + T));
      batcher.add('doorframe', materials.doorframe, boxBetween(x1, 0, z0 - T, x1 + T, DOOR_H + T, z1 + T));
      batcher.add('doorframe', materials.doorframe, boxBetween(x0, DOOR_H, z0 - T, x1, DOOR_H + T, z1 + T));
    }
  }
}

// --- windows ----------------------------------------------------------------

// Walks in from each facade to find the first open tile in every row/column;
// where a long enough stretch sits at the same depth, that's an outside wall
// worth glazing.
function buildWindows(layout, batcher, materials, fixtures) {
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
      if (run && run.to - run.from >= MIN_WINDOW_RUN) emitWindow(layout, batcher, materials, fixtures, side, run);
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

function emitWindow(layout, batcher, materials, fixtures, side, run) {
  const { W, H } = layout;
  // Depth is measured from the grid edge; convert to the face of the wall that
  // the room actually sees, then pull the glass just clear of it.
  const inner = side.outward < 0 ? run.depth : (side.axis === 'x' ? W : H) - run.depth;
  const at = (side.axis === 'x' ? worldX : worldZ)(layout, inner) - side.outward * 0.02;

  const a0 = (side.axis === 'x' ? worldZ : worldX)(layout, run.from);
  const a1 = (side.axis === 'x' ? worldZ : worldX)(layout, run.to);
  const facingPositive = side.outward < 0;   // glass faces back into the building

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
  const mullions = Math.max(1, Math.round((a1 - a0) / 1.6));
  for (let m = 1; m < mullions; m++) {
    const t = a0 + (a1 - a0) * (m / mullions);
    push(t - 0.03, t + 0.03, WINDOW_Y0, WINDOW_Y1);
  }

  // Daylight spilling in, as a cool counterpoint to the warm ceiling tubes.
  const steps = Math.max(1, Math.round((a1 - a0) / 4));
  for (let s = 0; s < steps; s++) {
    const t = a0 + (a1 - a0) * ((s + 0.5) / steps);
    const inset = side.outward * -1.1;
    fixtures.push({
      x: side.axis === 'x' ? at + inset : t,
      y: 1.9,
      z: side.axis === 'x' ? t : at + inset,
      color: 0xbcd6f0, intensity: 6, distance: 9,
    });
  }
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

function buildCeilingLights(layout, batcher, materials, fixtures) {
  const { W, H, tiles } = layout;
  const step = Math.round(LIGHT_PITCH / TILE);

  for (let ty = step; ty < H - step; ty += step) {
    for (let tx = step; tx < W - step; tx += step) {
      if (!isOpen(tiles[ty * W + tx])) continue;

      const x = worldX(layout, tx + 0.5);
      const z = worldZ(layout, ty + 0.5);
      const along = tiles[ty * W + tx] === CORRIDOR;   // tubes run down corridors
      const hw = along ? 0.16 : 0.6;
      const hd = along ? 0.6 : 0.16;

      batcher.add('panel', materials.panel,
        slab(x - hw, z - hd, x + hw, z + hd, CEIL_H - 0.015, false),
        { castShadow: false, receiveShadow: false });

      fixtures.push({ x, y: CEIL_H - 0.12, z, color: 0xfff2d6, intensity: 9, distance: 8.5 });
    }
  }
}

// --- furnishing -------------------------------------------------------------

function makeSink(layout, batcher, materials, masks) {
  const { W, H, tiles } = layout;
  const { blocked, occupied, reserved, colliders } = masks;

  // Tile range covering a world-space AABB.
  const range = (x0, z0, x1, z1) => ({
    tx0: Math.max(0, Math.floor((x0 - layout.ox) / TILE)),
    tx1: Math.min(W - 1, Math.ceil((x1 - layout.ox) / TILE) - 1),
    ty0: Math.max(0, Math.floor((z0 - layout.oz) / TILE)),
    ty1: Math.min(H - 1, Math.ceil((z1 - layout.oz) / TILE) - 1),
  });

  const stamp = (mask, x0, z0, x1, z1) => {
    const r = range(x0, z0, x1, z1);
    for (let ty = r.ty0; ty <= r.ty1; ty++) {
      for (let tx = r.tx0; tx <= r.tx1; tx++) mask[ty * W + tx] = 1;
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
      batcher.add(key, materials[key], boxBetween(x0, y0, z0, x1, y1, z1));
    },

    obstacle(x0, z0, x1, z1, top) {
      colliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, top });
      // Anything knee-high or taller stops an enemy from walking through it.
      if (top >= 0.5) stamp(blocked, x0, z0, x1, z1);
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

  scene.add(group);
  fixtures.push({ x: layout.exit.x, y: 1.6, z: layout.exit.z, color: 0x64ffa0, intensity: 7, distance: 8 });

  group.userData.ring = ring;
  group.userData.shaft = shaft;
  return group;
}
