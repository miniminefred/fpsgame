// The building itself: walls, floors, ceilings, roofs, window glazing and the
// frame over every doorway, plus the ceiling lights that hang off all of it.
//
// This is the part of a floor that is STRUCTURE rather than contents. It is all
// batched (see gen/geom.js) because none of it ever moves, and it is the only
// pass that reads the tile grid as geometry rather than as a place to put
// something.

import * as THREE from 'three';
import { LAMP_COLD, LAMP_WARM } from '../textures.js';
import { maskToRects } from './rects.js';
import { applyWorldUVs, boxBetween, slab } from './geom.js';
import {
  CEIL_H,
  centreX,
  centreZ,
  CORRIDOR,
  DOOR,
  DOOR_H,
  doorsOnRoom,
  isOpen,
  ROOM,
  SOLID,
  TILE,
  WALL_H,
  worldX,
  worldZ,
} from './layout.js';
import { PLATE_T, punchRects, ROOF_T } from './stairs.js';
import { FLOOR_SKIN } from './levels.js';
import { garageKey } from './garage.js';

const BASEBOARD_H = 0.11;

const WINDOW_Y0 = 1.0;

const WINDOW_Y1 = 2.35;

const MIN_WINDOW_RUN = 6;      // tiles (3 m) — shorter runs aren't worth glazing

const MAX_WINDOW_DEPTH = 7;    // tiles in from the facade before it's not a facade

export const LIGHT_PITCH = 4;         // metres between ceiling fixtures

// Glass and ceiling tubes are one-shot from any weapon on purpose: they are
// scenery you interact with, not cover you have to grind through.

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
// A grade is one lamp: the material its panel is drawn with, the colour of the
// light that panel casts, and how hard it casts it. `key` and `color` are two
// halves of the same tube and must name the same colour — see LAMP_COLD /
// LAMP_WARM in textures.js, which is where both are defined so they cannot
// drift apart again.
const FRONT_OF_HOUSE = { key: 'panel', color: LAMP_COLD, intensity: 16 };

const BACK_OF_HOUSE = { key: 'panelWarm', color: LAMP_WARM, intensity: 12 };

const GRADE = {
  storage: BACK_OF_HOUSE,
  archive: BACK_OF_HOUSE,
  utility: BACK_OF_HOUSE,
  mailroom: BACK_OF_HOUSE,
  copyroom: BACK_OF_HOUSE,
  itbay: BACK_OF_HOUSE,
  server: BACK_OF_HOUSE,
  closet: BACK_OF_HOUSE,
  security: BACK_OF_HOUSE,
  generator: BACK_OF_HOUSE,
};

export function buildShell(layout, batcher, materials, colliders, cuts) {
  const { W, H, tiles } = layout;

  // Walls. Merging tile runs into rectangles first keeps this to a couple of
  // hundred boxes instead of tens of thousands.
  //
  // Two passes rather than one: the generator room's own walls stand a full
  // storey taller (see generatorWallMask) — genuinely, not just an open shaft
  // above the ordinary height, so the room reads as walled up two storeys
  // rather than roofless. Splitting the SOLID mask in two and running the same
  // rect-merge twice is cheaper than teaching maskToRects about height.
  // SOLID is 0, so the placeholder for "not part of this pass" has to be
  // anything else — ROOM works fine, maskToRects only ever tests `=== SOLID`.
  const tallMask = generatorWallMask(layout);
  const normalWalls = tiles.map((t, i) => (t === SOLID && !tallMask[i] ? SOLID : ROOM));
  const tallWalls = tiles.map((t, i) => (t === SOLID && tallMask[i] ? SOLID : ROOM));
  drawWalls(layout, normalWalls, batcher, materials, colliders, WALL_H, false);
  drawWalls(layout, tallWalls, batcher, materials, colliders, WALL_H * 2, true);

  // The floor, which is a SLAB and not a sheet. It used to be one plane at y = 0,
  // which is invisible right up until you can see its edge — and a staircase down to
  // a basement cuts a hole straight through it, so its edge is the first thing you
  // look at on the way down. PLATE_T of structural deck with the flooring laid over
  // the top of it is what an office floor actually is, and the cut edge reads as
  // exactly that. Carpet in the rooms, vinyl in the corridors and doorways: the
  // change underfoot is the clearest signal of where you are.
  const floorTiles = masked(tiles, cuts.floor);
  for (const [key, pick] of [['carpet', (t) => t === ROOM], ['vinyl', (t) => t === CORRIDOR || t === DOOR]]) {
    for (const r of maskToRects(floorTiles, W, H, pick)) {
      const x0 = worldX(layout, r.x0), x1 = worldX(layout, r.x1);
      const z0 = worldZ(layout, r.y0), z1 = worldZ(layout, r.y1);
      batcher.add('trim', materials.trim,
        boxBetween(x0, -PLATE_T, z0, x1, -FLOOR_SKIN, z1), { castShadow: false });
      const floorKey = garageKey(layout, key);
      batcher.add(floorKey, materials[floorKey], applyWorldUVs(
        boxBetween(x0, -FLOOR_SKIN, z0, x1, 0, z1)), { castShadow: false });
    }
  }

  // Suspended ceiling over everything walkable — except where an attic's stairs come
  // up through it (see stairwellCut in gen/stairs.js).
  for (const r of maskToRects(masked(tiles, cuts.ceiling), W, H, isOpen)) {
    const ceilKey = garageKey(layout, 'ceiling');
    batcher.add(ceilKey, materials[ceilKey], applyWorldUVs(floorSlab(layout, r, CEIL_H, false)),
      { castShadow: false });
  }

  // The roof, structural rather than the suspended panel below it — a real box,
  // not a one-sided plane, because the suspended ceiling is drawn facing DOWN
  // only (`floorSlab(..., false)`) on the assumption there is always a real
  // structural deck above it hiding its top and edges from ever being seen. That
  // was true by construction until a body could get above `WALL_H` at all: once
  // it could, the gap between the suspended tile and here was daylight straight
  // through into whatever the fog clears to, from a viewpoint the panel was never
  // built to be looked at from below or the side.
  //
  // Collision is chunked the same way the walls are rather than as one
  // floor-spanning slab: `_moveHorizontal` resolves a collision by pushing to the
  // box's OWN far face, which is the right move for something the size of a room
  // and a same-frame teleport to the edge of the building for something the size
  // of the floor. A giant unchunked roof did exactly that the moment a player's
  // feet — from a jump, or just standing on tall furniture — landed in the band
  // this collider blocks but nothing else does.
  //
  // An attic's own ROOM, not just its stairwell, stays out of this pass entirely:
  // its deck (`stairBoxes`) already covers that footprint one storey up, and a
  // room's worth of roof sitting at floor height inside the attic would be the
  // same bug this whole pass exists to fix, just scoped to one room.
  // Two passes, for the same reason the walls take two: the generator room's
  // roof sits a whole storey higher than everybody else's, on top of the taller
  // walls that are already standing there. `masked` takes the generator's tiles
  // OUT of the ordinary pass and `only` is what hands them to the tall one, and
  // on a floor with no generator room that second mask is empty and the pass
  // costs a rect-merge over nothing.
  const drawRoof = (mask, y) => {
    for (const r of maskToRects(mask, W, H, isOpen)) {
      const x0 = worldX(layout, r.x0), x1 = worldX(layout, r.x1);
      const z0 = worldZ(layout, r.y0), z1 = worldZ(layout, r.y1);
      batcher.add('ceiling', materials.ceiling,
        applyWorldUVs(boxBetween(x0, y, z0, x1, y + ROOF_T, z1)), { castShadow: false });
      colliders.push({
        // `barrier` for the same reason a wall has one, and it is the other half
        // of that fix: ROOF_T is kept clear of STEP_EPS so a roof cannot be
        // stepped onto FROM BELOW, but nothing said it could not be stood on by
        // a body that had got above it some other way — and the top of the
        // building is the one surface with nothing above it and no walls on it.
        minX: x0, maxX: x1, minZ: z0, maxZ: z1,
        base: y, top: y + ROOF_T, building: true, ceiling: true, barrier: true,
      });
    }
  };
  drawRoof(masked(tiles, cuts.roof), WALL_H);
  drawRoof(only(tiles, cuts.tallRoof), WALL_H * 2);
}

// The complement of `masked`: everything OUTSIDE the cut turned SOLID, so a pass
// runs over the cut alone. Absent cut means nothing to draw, not everything.

// The complement of `masked`: everything OUTSIDE the cut turned SOLID, so a pass
// runs over the cut alone. Absent cut means nothing to draw, not everything.
function only(tiles, cut) {
  return cut ? tiles.map((t, i) => (cut[i] ? t : SOLID)) : tiles.map(() => SOLID);
}

// Tiles with a stairwell's hole taken out of them, for the surface it passes
// through. Masking the tile VALUES rather than adding a predicate, because
// maskToRects tests what it is handed and knows nothing about where it came from.
function masked(tiles, cut) {
  return cut ? tiles.map((t, i) => (cut[i] ? SOLID : t)) : tiles;
}

// The generator room's own tile footprint — see buildLevel's cuts.ceiling/roof.
// At most one room on the floor has this role, but the loop costs nothing to
// leave general.
export function generatorRoomCut(layout) {
  const cut = new Uint8Array(layout.W * layout.H);
  for (const r of layout.rooms) {
    if (r.role !== 'generator') continue;
    for (let ty = r.y0; ty < r.y1; ty++) {
      for (let tx = r.x0; tx < r.x1; tx++) cut[ty * layout.W + tx] = 1;
    }
  }
  return cut;
}

export function orMask(a, b) {
  for (let i = 0; i < a.length; i++) if (b[i]) a[i] = 1;
  return a;
}

// SOLID tiles immediately next to the generator room's own footprint — its
// four walls, basically, including the stub either side of its one doorway.
// Empty (no tiles set) on every floor without one, same as generatorRoomCut.
function generatorWallMask(layout) {
  const { W, H, tiles } = layout;
  const footprint = generatorRoomCut(layout);
  const mask = new Uint8Array(W * H);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (tiles[i] !== SOLID) continue;
      if ((tx > 0 && footprint[i - 1]) || (tx < W - 1 && footprint[i + 1]) ||
          (ty > 0 && footprint[i - W]) || (ty < H - 1 && footprint[i + W])) {
        mask[i] = 1;
      }
    }
  }
  return mask;
}

// One wall pass at a given height, over a tile array that is SOLID only where
// this pass should draw (see the two calls in buildShell). `building: true`
// on the taller pass exempts it from validate-props.mjs's furniture height
// cap the same way an ordinary WALL_H wall already is — see MAX_PROP_TOP.
function drawWalls(layout, tiles, batcher, materials, colliders, wallH, building) {
  const { W, H } = layout;
  for (const r of maskToRects(tiles, W, H, (t) => t === SOLID)) {
    const x0 = worldX(layout, r.x0), x1 = worldX(layout, r.x1);
    const z0 = worldZ(layout, r.y0), z1 = worldZ(layout, r.y1);

    const wallKey = garageKey(layout, 'wall');
    batcher.add(wallKey, materials[wallKey], applyWorldUVs(boxBetween(x0, 0, z0, x1, wallH, z1)));
    batcher.add('trim', materials.trim,
      boxBetween(x0 - 0.015, 0, z0 - 0.015, x1 + 0.015, BASEBOARD_H, z1 + 0.015));

    // `barrier`: a wall is a wall at every height a body can reach, never a kerb
    // to step onto and never a floor to stand on. Without it the step tolerance
    // turns every 3.2 m wall in the building into a knee-high ledge the moment a
    // body's feet are within STEP_EPS of its top — which a staircase, an attic
    // deck and the mezzanine all put them, legitimately. See _moveHorizontal.
    const collider = { minX: x0, maxX: x1, minZ: z0, maxZ: z1, top: wallH, barrier: true };
    if (building) collider.building = true;
    colliders.push(collider);
  }
}

// A mezzanine over the generator room: a deck reaching three of its four walls,
// with the fourth side open over the machine, and a flight up beside the door.
//
// The deck is colliders-only — pushed straight into `masks.colliders` rather
// than through `sink.obstacle()`, so none of it touches the nav grid: an enemy
// on the ground floor is blind to the height difference, same as the ground is
// blind to a storey's own furniture. That's a real gameplay compromise (nobody
// up here gets shot at, or shoots down), accepted for what's a one-room
// flourish rather than a second attic-and-basement system. Its FURNITURE is not
// colliders-only: the desks go in through a level sink of their own, the same
// machinery furnishLevels uses for an attic, so they are ordinary destructible
// props that come apart when shot.
//
// Everything below is worked in the room's own two axes rather than in x/z, and
// they are worth naming because every number is in them:
//
//   u   from the door wall into the room, 0 at the door wall. The generator is
//       at the far end of u, spanning that entire wall.
//   v   along the door wall, 0 at one side wall and vLen at the other.
//
// So the deck is u in [0, depth] by the full width of v, and the flight runs
// inside a notch cut out of it, flush against a wall — the door wall where the
// run fits beside the opening, a side wall where it does not. That is the whole
// shape of the thing: walk in, turn left or right, and walk straight up.

// Marks every tile a world-space rectangle touches, rounding outward — the
// same generous rounding `makeSink`'s own `stamp` uses, for the same reason:
// under-reserving is what lets the next thing placed overlap it.
export function stampOccupied(mask, layout, x0, z0, x1, z1) {
  const { W, H, TILE, ox, oz } = layout;
  const tx0 = Math.max(0, Math.floor((x0 - ox) / TILE));
  const tx1 = Math.min(W - 1, Math.ceil((x1 - ox) / TILE) - 1);
  const ty0 = Math.max(0, Math.floor((z0 - oz) / TILE));
  const ty1 = Math.min(H - 1, Math.ceil((z1 - oz) / TILE) - 1);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) mask[ty * W + tx] = 1;
  }
}

/**
 * The floor plate as collision, coarsely: the whole slab with the basement
 * stairwells punched out of it.
 *
 * The floor used to need no collider at all — `_supportHeight` assumed y = 0. Now
 * that a room can exist underneath, the plate has to be a real surface, or a player
 * walking over a basement falls into it through an intact floor.
 *
 * Coarse on purpose. The DRAWN floor is a couple of thousand rectangles, one per run
 * of matching tiles, and handing all of them to the solver as static bodies would be
 * a real cost for no gain: collision only needs to know the plate is at 0 everywhere
 * except the holes, and it does not care that the plate extends under the walls.
 * A handful of boxes says exactly that.
 */
export function floorPlate(layout) {
  let rects = [{
    x0: worldX(layout, 0), z0: worldZ(layout, 0),
    x1: worldX(layout, layout.W), z1: worldZ(layout, layout.H),
  }];
  for (const plan of layout.stairs) {
    if (plan.dir > 0) continue;
    rects = punchRects(rects, {
      x0: worldX(layout, plan.x0), z0: worldZ(layout, plan.y0),
      x1: worldX(layout, plan.x1), z1: worldZ(layout, plan.y1),
    });
  }
  return rects.map((r) => ({
    minX: r.x0, maxX: r.x1, minZ: r.z0, maxZ: r.z1,
    base: -PLATE_T, top: 0, building: true,
  }));
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

export function buildDoorFrames(layout, batcher, materials, colliders) {
  // The wall over an opening has to reach the top of the wall it is IN, and one
  // wall in the building is not WALL_H: the generator room's four are a full
  // storey taller (see generatorWallMask, and the tall roof pass in
  // buildShell). Hard-coded to WALL_H this left a 3.2 m hole over the one
  // doorway whose wall goes to 6.4 — a space above the door, looking straight
  // out of the room over the corridor's roof. The wall TILE is shared and tall
  // on both faces, so the header over it is tall too; it is the opening that
  // decides, not which side you are standing on.
  const gen = layout.rooms.find((r) => r.role === 'generator');
  const tallHeader = new Set(gen ? doorsOnRoom(layout.doors, gen) : []);

  for (const d of layout.doors) {
    const x0 = worldX(layout, d.x0), x1 = worldX(layout, d.x1);
    const z0 = worldZ(layout, d.y0), z1 = worldZ(layout, d.y1);
    const T = FRAME_T;

    const frame = (a0, b0, c0, a1, b1, c1) =>
      batcher.add('doorframe', materials.doorframe, boxBetween(a0, b0, c0, a1, b1, c1));

    const headTop = tallHeader.has(d) ? WALL_H * 2 : WALL_H;
    batcher.add('wall', materials.wall,
      applyWorldUVs(boxBetween(x0, LINTEL_Y, z0, x1, headTop, z1)));

    // An ordinary header needs no collider: it starts at 2.13 m and nothing in
    // the building can get its feet up there. A TALL one can be reached, because
    // the generator room's mezzanine deck is at WALL_H and a prop on the deck
    // stands higher still — so the part of it above the ordinary wall line is
    // given one, or the header is opaque and walk-through, which is worse than
    // the hole it replaced. `base` rather than a plain pillar, so the doorway
    // itself stays open at floor level: a body only meets this if its feet are
    // within BODY_H of it.
    if (headTop > WALL_H) {
      colliders.push({
        minX: Math.min(x0, x1), maxX: Math.max(x0, x1),
        minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1),
        base: WALL_H, top: headTop, building: true,
      });
    }

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
export function buildWindows(layout, batcher, materials, fixtures, destructibles) {
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
export function buildCeilingLights(layout, batcher, materials, fixtures, destructibles) {
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
    // No suspended ceiling to hang a panel from — see buildGeneratorLights,
    // which mounts this room's fixtures on the walls instead.
    if (room.role === 'generator') continue;

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
      addFixture(centreX(layout, tx), centreZ(layout, ty), runX);
    }
  }
}

// The generator room's lights, and it is the one room in the building lit from
// more than one height. Both mounts are the same fixture/destructible shape as
// an ordinary ceiling panel — kind: 'panel', one light each, shot out or blacked
// out the same way — they just hang off different surfaces.
//
//   The roof, at WALL_H * 2: high bays under the double-height deck (see the
//   tall roof pass in buildShell). Without them the room is sealed but its
//   ceiling is 3.8 m above the nearest thing lighting it and comes out nearly
//   black — which looks exactly like the roofless hole it replaced, so capping
//   the room and lighting the cap are one change, not two. They carry a longer
//   `distance` than a suspended panel for the obvious reason: they are twice as
//   far from the floor they have to reach.
//
//   And the underside of the mezzanine, which is built later and lights itself —
//   see the soffit pass in buildGeneratorMezzanine. It is what lights the half of
//   the room the deck shades, which the high bays above it cannot reach.
//
// There used to be a third: four panels bracketed off the walls at 2.6 m, from
// when this room had no ceiling at all to hang anything from. Once it had a roof
// AND a lit soffit they were lighting rooms that were already lit, from a mount
// nothing else in the building uses — a plant room reads as a plant room because
// its lights are overhead industrial fittings, not because it has picture lights
// round the walls.
/**
 * One downward-facing panel in the generator room, wherever it is mounted: the
 * emissive slab, the fixture the light pool homes onto, and the destructible
 * record that ties the two together so shooting it kills both halves.
 *
 * Shared rather than local to buildGeneratorLights because the mezzanine lights
 * its own underside (see the soffit pass in buildGeneratorMezzanine) and a
 * second copy of this is a second place for a panel to stop being destructible.
 */
export function generatorPanel(batcher, materials, fixtures, destructibles, x, y, z, hw, hd, distance) {
  const grade = GRADE.generator;
  const spans = batcher.beginSpans();
  batcher.add(grade.key, materials[grade.key],
    slab(x - hw, z - hd, x + hw, z + hd, y, false), { castShadow: false, receiveShadow: false });
  batcher.endSpans();

  const fixture = { x, y: y - 0.05, z, color: grade.color, intensity: grade.intensity, distance };
  fixtures.push(fixture);

  destructibles.push({
    kind: 'panel',
    hp: PANEL_HP,
    spans,
    colliders: [],
    navTiles: [],
    fixtures: [fixture],
    parts: [{
      material: materials[grade.key],
      x0: x - hw, y0: y - 0.03, z0: z - hd, x1: x + hw, y1: y, z1: z + hd,
    }],
    broken: false,
  });
}

export function buildGeneratorLights(layout, batcher, materials, fixtures, destructibles) {
  const room = layout.rooms.find((r) => r.role === 'generator');
  if (!room) return;

  const x0 = worldX(layout, room.x0), x1 = worldX(layout, room.x1);
  const z0 = worldZ(layout, room.y0), z1 = worldZ(layout, room.y1);
  const ROOF_Y = WALL_H * 2;  // the underside of this room's own roof

  // High bays on the same pitch an ordinary room's panels use, so a big plant
  // room gets several and a small one still gets the fixture at its centre.
  const nx = Math.max(1, Math.round((x1 - x0) / LIGHT_PITCH));
  const nz = Math.max(1, Math.round((z1 - z0) / LIGHT_PITCH));
  const alongX = (x1 - x0) >= (z1 - z0);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      generatorPanel(batcher, materials, fixtures, destructibles,
        x0 + (x1 - x0) * ((i + 0.5) / nx), ROOF_Y - 0.015,
        z0 + (z1 - z0) * ((j + 0.5) / nz),
        alongX ? 0.62 : 0.16, alongX ? 0.16 : 0.62, 22);
    }
  }
}

// --- sliding doors ----------------------------------------------------------

export const UP = new THREE.Vector3(0, 1, 0);

// --- furnishing -------------------------------------------------------------

/**
 * Everything a prop needs to put itself into the world.
 *
 * `masks.level` is the floor this sink furnishes, and it is 0 for the building. A
 * sink at a level draws every box, model and collider that much higher, gives its
 * colliders an underside, and stays out of the nav grid — which is the whole of
 * what "furnish the storey upstairs" means. Doing it here rather than in a wrapper
 * is deliberate: `tryPlace` and all 30 props in the catalogue then furnish a second
 * storey without one line of them knowing there is one.
 */
