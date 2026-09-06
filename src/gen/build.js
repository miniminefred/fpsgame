import * as THREE from 'three';
import { getAssets, LAMP_COLD, LAMP_WARM } from '../textures.js';
import { maskToRects } from './rects.js';
import { Batcher, boxBetween, slab, applyWorldUVs } from './geom.js';
import { footprintOf, tryPlace } from './props.js';
import { furnish } from './rooms.js';
import { modelInfo, stampModel, paintDebris } from './models.js';
import {
  TILE, WALL_H, CEIL_H, DOOR_H, DOOR_CLEAR,
  SOLID, ROOM, CORRIDOR, DOOR, isOpen, FACING, worldX, worldZ, tileX, tileY,
  slidePocketSide, slidePocketRun, doorSide, doorsOnRoom,
} from './layout.js';
import { CARDS, READER_LIT, READER_OPEN } from '../keycards.js';
import { PLAYER_RADIUS } from '../metrics.js';
import {
  UPPER_Y, UPPER_CEIL, LOWER_Y, PLATE_T, ROOF_T, RISER, approachTiles, levelFloor, levelY, punchRects,
  stairBoxes, stairwellCut, roofCollisionCut, stripTiles, rampSpec, approachRect,
} from './stairs.js';

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

export function buildLevel(scene, layout, theme = null) {
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
  const doors = [];                        // panels and leaves, see doors.js
  const workstations = [];                 // desks with a chair at them, see furnishRooms

  reserveClearances(layout, reserved);

  // The floor is a slab with a thickness now, and a basement's stairs cut a hole
  // through it. Both cuts are the same tiles; which surface loses them is which way
  // the stairs go.
  //
  // The generator room loses its suspended ceiling and its ordinary roof, and
  // gets a roof of its own one storey higher instead. That is what makes it
  // double-height rather than roofless: its walls already stand at WALL_H * 2
  // (see generatorWallMask), and for a long time nothing capped them — so
  // looking up in the one room built to be looked up in showed the fog clear
  // colour going on for ever, which reads as a hole in the building rather than
  // as a tall room. The floor plate is untouched; only the two upper surfaces
  // move.
  const genCut = generatorRoomCut(layout);
  buildShell(layout, batcher, materials, colliders, {
    ceiling: orMask(stairwellCut(layout, 1), genCut),
    floor: stairwellCut(layout, -1),
    roof: orMask(roofCollisionCut(layout), genCut),
    tallRoof: genCut,
  });
  colliders.push(...floorPlate(layout));
  buildDoorFrames(layout, batcher, materials, colliders);
  buildWindows(layout, batcher, materials, fixtures, destructibles);
  buildCeilingLights(layout, batcher, materials, fixtures, destructibles);
  buildGeneratorLights(layout, batcher, materials, fixtures, destructibles);
  // Doors are their own meshes rather than batched geometry, for the obvious
  // reason: a batched thing cannot move.
  // One instanced set of badge readers for every door on the floor, whichever
  // kind it is — a reader on a hall door has to look like a reader on an office.
  const readers = new BadgeReaders(scene, objects, layout.doors.length);
  buildSlidingDoors(layout, scene, materials, doors, colliders, readers, rng);
  buildHallDoors(layout, scene, materials, doors, colliders, readers);
  // The lobby's way out into the office: a pair of leaves rather than a panel,
  // and never locked. See buildDoubleDoors.
  buildDoubleDoors(layout, scene, materials, doors, colliders);
  readers.finish();
  // The two cars, after the doors because they fit doors of their own, and
  // before the furnishing for no reason at all — nothing they draw is on the
  // tile grid the furnisher works against. See gen/lifts.js.
  buildLifts(layout, batcher, materials, scene, doors, colliders, fixtures);

  const sink = makeSink(layout, batcher, materials,
    { blocked, occupied, reserved, colliders, dynamics, destructibles, workstations });
  // Before the rooms are furnished, because the strip takes its tiles out of the
  // nav grid and out of the furnisher's reach in the same pass — and because the
  // deck's own junk is placed through the same sink and must be down before
  // anything on the room floor can be shoved against it.
  buildStairs(layout, batcher, materials, { colliders, blocked, occupied, fixtures }, rng);
  buildGeneratorMezzanine(layout, batcher, materials,
    { colliders, occupied, dynamics, destructibles, fixtures }, rng);
  furnishRooms(layout, sink, rng, workstations, theme);
  furnishCorridors(layout, sink, rng);
  // After the ordinary corridor clutter, so a machine takes a tile the clutter
  // did not want rather than the other way round: there are at most three of
  // these and a hundred of that, and the one that should lose a contested tile
  // is the one with plenty of other tiles to go to.
  placeWashers(layout, sink, rng);
  const cow = placeCow(layout, sink, rng);
  // Last, and through sinks of their own: a level off the ground floor has its own
  // occupancy and its own nav layer. See furnishLevels.
  const levelBlocked = new Uint8Array(W * H);
  furnishLevels(layout, batcher, materials,
    { colliders, dynamics, destructibles, levelBlocked }, rng);

  const meshes = batcher.build(scene);
  objects.push(...meshes);

  // Loose props go in as their own meshes so physics can shove them around.
  for (const dyn of dynamics) {
    scene.add(dyn.group);
    objects.push(dyn.group);
    meshes.push(...dyn.group.children);
  }

  for (const door of doors) objects.push(door.root);

  const exitObject = buildExit(scene, layout, fixtures);
  objects.push(exitObject);

  // Walkable = open floor the enemies can actually stand on.
  const walk = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) walk[i] = isOpen(tiles[i]) && !blocked[i] ? 1 : 0;

  // A badged door is shut to the enemies too, so it is shut to the nav grid: the
  // flow field must not route a chase through a door the chaser cannot open, or
  // the whole pursuit piles up against it. Only the OPENING is closed, not the
  // room behind it — the moment the player badges in, doors.js hands these exact
  // tiles back with nav.openTiles and the floor follows them through.
  //
  // This is safe for the same reason the locks are: assignLocks proved that
  // sealing every locked room leaves the rest of the floor connected, so closing
  // their doorways cannot strand anybody.
  for (const door of doors) {
    if (!door.lock) continue;
    for (const i of door.navTiles) walk[i] = 0;
  }

  return {
    layout,
    // The rectangle a body may never leave, and the last line of defence against
    // ending up outside the building — see `setBounds` in player.js. It is the
    // slab inset by the one tile of perimeter wall that rings every floor, plus
    // the body's own radius, which is exactly where a body standing against the
    // inside of that wall has its centre: the tightest bound that can never move
    // a legal position.
    bounds: {
      minX: layout.ox + TILE + PLAYER_RADIUS,
      maxX: layout.ox + (layout.W - 1) * TILE - PLAYER_RADIUS,
      minZ: layout.oz + TILE + PLAYER_RADIUS,
      maxZ: layout.oz + (layout.H - 1) * TILE - PLAYER_RADIUS,
    },
    meshes,          // raycast targets for bullets
    objects,         // everything added to the scene, for teardown
    colliders,
    dynamics,
    destructibles,
    doors,
    fixtures,
    exitObject,
    // Where the staff work, for whoever is going to be found working there.
    workstations,
    cow,             // {x, z} if this floor rolled one, else null — see placeCow
    nav: {
      W, H, TILE, ox: layout.ox, oz: layout.oz, walk, tiles,
      levels: levelNav(layout, levelBlocked),
    },
  };
}

/**
 * The second nav layer: every attic and basement at once, plus the stairwells that
 * join them to the ground floor.
 *
 * One layer holds all of them because no two ever overlap — a room gets at most one
 * staircase, so at most one level above or below it. See the note at the top of
 * nav.js for what the layers mean and where they are joined.
 *
 * `cross` is the joint and it is the stairwell and nothing else. `rampY` is how high
 * the flight is at each of those tiles, so a body on the stairs is at the height of
 * the stairs whichever layer it is currently on — which is what makes the crossing
 * invisible. `sight` is the level's own floor, because a level is one open room with
 * a lid and there is nothing inside it to see through.
 */
function levelNav(layout, levelBlocked) {
  const { W, H } = layout;
  const walk = new Uint8Array(W * H);
  const sight = new Uint8Array(W * H);
  const cross = new Uint8Array(W * H);
  const levelYs = new Float32Array(W * H);
  // Which flight a stairwell tile belongs to, so nav can sample that flight's height
  // continuously rather than storing one number per tile and making a body climb in
  // 33 cm jerks.
  const rampAt = new Int8Array(W * H).fill(-1);
  const ramps = [];

  for (const plan of layout.stairs) {
    const room = plan.room;
    for (let ty = room.y0; ty < room.y1; ty++) {
      for (let tx = room.x0; tx < room.x1; tx++) {
        const i = ty * W + tx;
        levelYs[i] = levelY(plan);
        sight[i] = 1;
        // The level's floor, minus whatever is standing on it.
        if (!levelBlocked[i]) walk[i] = 1;
      }
    }
    // ...and the stairwell, which belongs to both layers and is where they join. All
    // of it: a body has to be able to stand anywhere on a flight and walk the length
    // of it. What stops anybody stepping onto the MIDDLE of one — off the edge of the
    // landing above, or up off the room floor below — is the no-cliff rule in nav.js,
    // which is also what caught the three-metre teleport that used to happen here.
    const ramp = ramps.push(rampSpec(layout, plan)) - 1;
    for (const i of stripTiles(plan, W)) {
      rampAt[i] = ramp;
      cross[i] = 1;
      walk[i] = 1;
      sight[i] = 1;
    }
  }

  return { walk, sight, cross, rampAt, ramps, levelY: levelYs };
}

// --- shell: walls, floors, ceiling ------------------------------------------

function buildShell(layout, batcher, materials, colliders, cuts) {
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
      batcher.add(key, materials[key], applyWorldUVs(
        boxBetween(x0, -FLOOR_SKIN, z0, x1, 0, z1)), { castShadow: false });
    }
  }

  // Suspended ceiling over everything walkable — except where an attic's stairs come
  // up through it (see stairwellCut in gen/stairs.js).
  for (const r of maskToRects(masked(tiles, cuts.ceiling), W, H, isOpen)) {
    batcher.add('ceiling', materials.ceiling, applyWorldUVs(floorSlab(layout, r, CEIL_H, false)),
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
function generatorRoomCut(layout) {
  const cut = new Uint8Array(layout.W * layout.H);
  for (const r of layout.rooms) {
    if (r.role !== 'generator') continue;
    for (let ty = r.y0; ty < r.y1; ty++) {
      for (let tx = r.x0; tx < r.x1; tx++) cut[ty * layout.W + tx] = 1;
    }
  }
  return cut;
}

function orMask(a, b) {
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

    batcher.add('wall', materials.wall, applyWorldUVs(boxBetween(x0, 0, z0, x1, wallH, z1)));
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
function buildGeneratorMezzanine(layout, batcher, materials, masks, rng) {
  const room = layout.rooms.find((r) => r.role === 'generator');
  if (!room) return;
  // `doorsOnRoom`, not `room.doors[0]`: the room's own list only holds doors
  // IT cut, and its one real doorway may belong to the room next door — see
  // the same note in generatorRoom (gen/rooms.js).
  const door = doorsOnRoom(layout.doors, room)[0];
  if (!door) return;

  const DECK_Y = WALL_H;        // one ordinary storey up — the same datum the
                                // attic/basement system uses, just not wired
                                // into it (see the note above).
  const DECK_T = 0.2;
  const RAIL_H = 1.0;
  const RAIL_T = 0.06;
  const GOING = 0.26;           // an industrial access stair is steep
  const STAIR_W = 1.3;
  // How far past the doorway's edge the bottom tread starts. The flight goes
  // flush against the door wall and BESIDE the opening, which is what makes the
  // walk one turn: in, turn left (or right), straight up, with the first tread
  // where the turn puts you. Half a metre is what clears the door furniture —
  // a room's badge reader beds into the jamb 0.16 m past the opening and is
  // 0.15 m wide along the wall, so it ends at 0.235 — with enough left over to
  // stand on to make the step up.
  const DOOR_GAP = 0.5;
  // A body's length of floor. Used twice for the same reason both times: it is
  // how much room the foot of a flight needs in front of it to be climbable at
  // all — once when a side-wall flight decides where to start, and again when
  // the furnisher is told to keep off that floor.
  const FOOT_ROOM = 1.3;
  // The hole in the deck is wider than the flight in it. A notch cut to exactly
  // the stair's width leaves a body climbing it no room to be off-centre: the
  // player is 0.8 m across on a 1.3 m tread, and the moment their shoulder
  // crosses the deck's edge their head meets its underside — which happens
  // around the sixth step, where standing height first reaches the 3.0 m soffit.
  // It reads as the stairs simply stopping half way up. Found by walking, not
  // by looking: a body that climbed to 2.8 m and then would not go on.
  //
  // Only the side away from the wall needs it once the flight is flush: on the
  // near side there is no deck edge to meet, because the wall itself is what
  // the notch stops against, and the wall stops the body a whole step earlier
  // than its head would ever reach the soffit.
  const NOTCH_PAD = 0.5;
  // The deck stops this far off the generator's wall: the machine's own 3.0 m
  // depth (its pipework is inside its footprint — see `generator` in
  // gen/props.js) plus the 0.15 m wall inset, plus a slot to see it down. The
  // machine stands 5.9 m tall against a 6.4 m wall, so what this buys is the
  // whole of it visible from the deck rather than its top half met at waist
  // height.
  const GEN_CLEAR = 0.15 + 3.0 + 0.5;

  // The flight's rise-per-step matches every other staircase in the building
  // (RISER, from gen/stairs.js — small enough to walk up without jumping), so
  // its run is fixed by that and by DECK_Y rather than chosen independently.
  const steps = Math.ceil(DECK_Y / RISER);
  const riser = DECK_Y / steps;
  const RUN = steps * GOING;

  const doorWallSide = doorSide(door, room);
  const x0 = worldX(layout, room.x0), x1 = worldX(layout, room.x1);
  const z0 = worldZ(layout, room.y0), z1 = worldZ(layout, room.y1);

  // v runs along the door wall; u runs away from it into the room.
  const alongX = doorWallSide === 0 || doorWallSide === 2;
  const uWall = doorWallSide === 0 ? z1 : doorWallSide === 2 ? z0
    : doorWallSide === 1 ? x0 : x1;
  const uSign = (doorWallSide === 0 || doorWallSide === 3) ? -1 : 1;
  const vLo = alongX ? x0 : z0;
  const vLen = alongX ? x1 - x0 : z1 - z0;
  const uLen = alongX ? z1 - z0 : x1 - x0;

  const depth = uLen - GEN_CLEAR;
  // Enough deck left over beside a stairwell to be worth climbing to. This is
  // the bar for the door-wall arrangement, which is the shallower of the two;
  // the side-wall one needs a whole RUN of depth and asks for it itself.
  if (depth < STAIR_W + NOTCH_PAD + 1.4) return;   // no deck worth standing on

  // The doorway's extent along that wall. The flight starts just past one edge
  // of it, so what has to fit is the whole run between that edge and the far
  // corner — the opening itself is dead length either way.
  const dA = (alongX ? worldX(layout, door.x0) : worldZ(layout, door.y0)) - vLo;
  const dB = (alongX ? worldX(layout, door.x1) : worldZ(layout, door.y1)) - vLo;
  const dLo = Math.min(dA, dB), dHi = Math.max(dA, dB);

  // Where the flight goes, as the rectangle it occupies plus which way it
  // climbs. There are two arrangements and BOTH are flush against a wall, which
  // is the whole point of them: a flight standing off in the middle of the room
  // reads as a piece of furniture somebody left there rather than as part of
  // the building.
  //
  //   'v'  along the door wall, flush at u = 0, its bottom step DOOR_GAP past
  //        the edge of the opening. First choice, because the walk is one turn:
  //        in, turn left (or right), straight up, with the first tread exactly
  //        where the turn leaves you.
  //   'u'  along a side wall, flush at v = 0 or vLen, climbing away from the
  //        door wall. Second choice, and what it costs is the walk along the
  //        door wall to reach the foot. It is needed because being flush makes
  //        the RUN the constraint: the opening plus a whole run has to fit on
  //        one wall, so a nine-metre door wall with the door in the middle has
  //        not four metres either way. Measured over 198 generator rooms, the
  //        door wall takes it 86% of the time and this takes the other 14%.
  //
  // Either way the flight climbs AWAY from where you come in. One that climbed
  // back toward the door would be one you walk past and turn round in.
  const options = rng.chance(0.5) ? [-1, 1] : [1, -1];
  let plan = null;
  for (const d of options) {
    const f = d < 0 ? dLo - DOOR_GAP : dHi + DOOR_GAP;
    const t = f + d * RUN;
    if (Math.min(f, t) >= 0.25 && Math.max(f, t) <= vLen - 0.25) {
      plan = { axis: 'v', c0: 0, c1: STAIR_W, foot: f, dir: d };
      break;
    }
  }
  if (!plan && depth >= FOOT_ROOM + RUN + 0.25 && vLen >= STAIR_W + NOTCH_PAD + 1.4) {
    // The side wall nearer the door, so the walk to the foot is the shorter of
    // the two. The flight starts FOOT_ROOM off the door wall rather than in the
    // corner: it climbs into the room, so the floor you step onto the bottom
    // tread from is the floor between it and the door wall, and jammed into the
    // corner there is none — you would be stepping onto the flight sideways.
    const near = (dLo + dHi) / 2 < vLen / 2;
    const c0 = near ? 0 : vLen - STAIR_W;
    plan = { axis: 'u', c0, c1: c0 + STAIR_W, foot: FOOT_ROOM, dir: 1 };
  }
  if (!plan) return;   // no wall in this room can take the run

  // The hole in the deck: the flight's own rectangle, padded across its width
  // on any side that is not a wall. Along the run it is not padded at all —
  // the foot end is at floor level so there is nothing to duck, and the head
  // end has to meet the deck exactly or there is a gap to step over.
  const top = plan.foot + plan.dir * RUN;
  const pad = (lo, hi, limit) => [Math.max(0, lo - NOTCH_PAD), Math.min(limit, hi + NOTCH_PAD)];
  const [nu0, nu1] = plan.axis === 'v'
    ? pad(plan.c0, plan.c1, depth)
    : [Math.min(plan.foot, top), Math.max(plan.foot, top)];
  const [nv0, nv1] = plan.axis === 'v'
    ? [Math.min(plan.foot, top), Math.max(plan.foot, top)]
    : pad(plan.c0, plan.c1, vLen);
  // Which edge of that hole is the head of the flight, and so has to stay open:
  // it is the way onto the deck.
  const head = plan.axis === 'v' ? (plan.dir > 0 ? 'v1' : 'v0') : 'u1';

  // One drawing primitive for the whole mezzanine: a u/v rectangle between two
  // heights. u runs either way in world space, so the min/max is taken rather
  // than assumed, and a run that is a line in plan (a railing) is given the
  // thickness it is asked for about that line — a zero-width box draws as
  // nothing and collides with nothing, which is a railing you fall through.
  // u/v rectangle to world box. Separate from `piece` because the furnisher
  // reservation below wants the box without anything being drawn into it.
  const rect = (u0, u1, v0, v1) => {
    const ua = uWall + uSign * u0, ub = uWall + uSign * u1;
    const va = vLo + v0, vb = vLo + v1;
    return {
      bx0: alongX ? Math.min(va, vb) : Math.min(ua, ub),
      bx1: alongX ? Math.max(va, vb) : Math.max(ua, ub),
      bz0: alongX ? Math.min(ua, ub) : Math.min(va, vb),
      bz1: alongX ? Math.max(ua, ub) : Math.max(va, vb),
    };
  };
  const piece = (key, u0, u1, v0, v1, yLo, yHi, opts = {}) => {
    const { uv = false, solid = true, thin = 0 } = opts;
    let { bx0, bx1, bz0, bz1 } = rect(u0, u1, v0, v1);
    if (thin) {
      if (bx1 - bx0 < thin * 2) { const m = (bx0 + bx1) / 2; bx0 = m - thin; bx1 = m + thin; }
      if (bz1 - bz0 < thin * 2) { const m = (bz0 + bz1) / 2; bz0 = m - thin; bz1 = m + thin; }
    }
    const geom = boxBetween(bx0, yLo, bz0, bx1, yHi, bz1);
    batcher.add(key, materials[key], uv ? applyWorldUVs(geom) : geom);
    if (solid) {
      masks.colliders.push({
        minX: bx0, maxX: bx1, minZ: bz0, maxZ: bz1,
        base: yLo, top: yHi, building: true,
      });
    }
    return { bx0, bx1, bz0, bz1 };
  };

  // --- the deck, in four pieces around the stairwell notch ------------------
  // Whatever of [0, depth] x [0, vLen] the notch is not: two strips either side
  // of it on u, then the two ends of its own u band. Written as the complement
  // rather than as named pieces because the notch sits in a different place in
  // each arrangement, and a piece with no width has to drop out rather than be
  // drawn as a sliver. Flush against a wall, the strip on that side is exactly
  // the piece that has no width — the deck still reaches the wall, along its
  // length either side of the run, and the doorway is under one of those ends
  // because the flight starts beside the opening rather than in front of it.
  if (nu0 > 0.05) piece('trim', 0, nu0, 0, vLen, DECK_Y - DECK_T, DECK_Y, { uv: true });
  if (depth - nu1 > 0.05) piece('trim', nu1, depth, 0, vLen, DECK_Y - DECK_T, DECK_Y, { uv: true });
  if (nv0 > 0.05) piece('trim', nu0, nu1, 0, nv0, DECK_Y - DECK_T, DECK_Y, { uv: true });
  if (vLen - nv1 > 0.05) piece('trim', nu0, nu1, nv1, vLen, DECK_Y - DECK_T, DECK_Y, { uv: true });

  // --- lights under the deck --------------------------------------------------
  // Most of the room's floor is UNDER this thing, and both of the room's other
  // mounts are above it: the wall panels at 2.6 m are below the deck but only
  // four of them round the edge of a room up to fifteen metres across, and the
  // high bays are lighting the top of the deck rather than the three metres of
  // headroom beneath it. So the overhang lights what it shades, on the same
  // LIGHT_PITCH grid any other ceiling uses and at an ordinary ceiling's
  // `distance` — it is at an ordinary ceiling's height above the floor, which is
  // the whole difference between these and the high bays.
  //
  // Built here rather than in buildGeneratorLights because that pass runs long
  // before this one and cannot know where the deck ended up, or whether the room
  // got one at all — every early return above is a room with no overhang to
  // light.
  const SOFFIT_DROP = 0.015;
  const nuLights = Math.max(1, Math.round(depth / LIGHT_PITCH));
  const nvLights = Math.max(1, Math.round(vLen / LIGHT_PITCH));
  for (let i = 0; i < nuLights; i++) {
    for (let j = 0; j < nvLights; j++) {
      const u = depth * ((i + 0.5) / nuLights);
      const v = vLen * ((j + 0.5) / nvLights);
      // Nothing overhead to hang it from: that is the stairwell, not deck.
      if (u > nu0 && u < nu1 && v > nv0 && v < nv1) continue;
      const { bx0, bz0 } = rect(u, u, v, v);
      generatorPanel(batcher, materials, masks.fixtures, masks.destructibles,
        bx0, DECK_Y - DECK_T - SOFFIT_DROP, bz0,
        alongX ? 0.62 : 0.16, alongX ? 0.16 : 0.62, 11);
    }
  }

  // --- railings -------------------------------------------------------------
  // Glass with a dark capping rail, so the drop reads as a drop rather than as
  // an edge found with a foot. The long overlook faces the machine; the rest
  // fence the stairwell.
  const railing = (u0, u1, v0, v1) => {
    piece('glass', u0, u1, v0, v1, DECK_Y, DECK_Y + RAIL_H, { thin: RAIL_T });
    piece('metalDark', u0, u1, v0, v1,
      DECK_Y + RAIL_H - 0.03, DECK_Y + RAIL_H + 0.03, { solid: false, thin: RAIL_T + 0.02 });
  };
  railing(depth, depth, 0, vLen);              // the overlook, at the generator
  // Every edge of the stairwell except two kinds. The head of the flight stays
  // open because it is the way onto the deck; an edge with no deck beyond it is
  // a room wall rather than a drop, and a pane of glass standing in the plaster
  // is not a railing. Which edges those are is what differs between the two
  // arrangements, so it is asked of each edge rather than written out per case.
  if (nu0 > 0.05 && head !== 'u0') railing(nu0, nu0, nv0, nv1);
  if (depth - nu1 > 0.05 && head !== 'u1') railing(nu1, nu1, nv0, nv1);
  if (nv0 > 0.05 && head !== 'v0') railing(nu0, nu1, nv0, nv0);
  if (vLen - nv1 > 0.05 && head !== 'v1') railing(nu0, nu1, nv1, nv1);

  // --- the flight -----------------------------------------------------------
  // A straight run of solid pillars climbing flush along a wall, RISER by
  // RISER — the same climbable rise as every other staircase in the building
  // (see gen/stairs.js), just authored directly rather than through the
  // layout-level stairwell system. It needs no landing tread because the floor
  // it starts off is the floor you arrive on: on the door wall the bottom step
  // is DOOR_GAP along from the opening, so the turn out of the doorway puts you
  // square on it, and on a side wall it stands FOOT_ROOM off the door wall for
  // the same reason. The awkward case this replaced was a flight whose bottom
  // step was jammed against a wall with nothing in front of it to stand on.
  //
  // `along` is the run and `across` is the width, whichever way round u and v
  // are for this arrangement — a step is the same box either way.
  const along = (lo, hi) => (plan.axis === 'v' ? [plan.c0, plan.c1, lo, hi] : [lo, hi, plan.c0, plan.c1]);
  for (let i = 0; i < steps; i++) {
    const stepTop = (i + 1) * riser;
    const a = plan.foot + plan.dir * i * GOING, b = plan.foot + plan.dir * (i + 1) * GOING;
    const p = piece('trim', ...along(Math.min(a, b), Math.max(a, b)), 0, stepTop,
      { solid: false });
    // Shell, not furniture, unconditionally — the same call gen/stairs.js makes
    // for every one of its own treads: a step is structure, and `building:
    // true` is what keeps it out of the furniture dimension and doorway-swing
    // checks. `climb: true` is this flight's own problem to solve, not
    // validate-props.mjs's: nothing here is registered in `layout.stairs`, so
    // the generic geometric-reachability flood (which has no notion of
    // climbing, only of "clear at head height") would otherwise see sixteen
    // solid risers and call the room sealed. Pushed by hand rather than through
    // `piece` because a step is stood ON rather than walked under, so it has a
    // `top` and no `base`.
    masks.colliders.push({
      minX: p.bx0, maxX: p.bx1, minZ: p.bz0, maxZ: p.bz1, top: stepTop,
      building: true, climb: true,
    });
  }

  // Only the flight's own footprint is kept off the ground-floor furnisher, and
  // that is the whole of it. The deck now covers most of the room, and
  // reserving the ground under it would leave a plant room with nothing in it —
  // including, since furnishRooms runs after this, the generator. There is 3 m
  // of headroom under the deck; crates and workbenches belong there.
  // Including a body's length of floor beyond the bottom step. That is where you
  // stand to start climbing, and it is not covered by the flight's own
  // footprint — the same thing `approachTiles` does for the layout-level
  // stairwells, and for the same reason: a crate on the tile in front of the
  // first tread is a staircase you cannot get onto, and nothing else would
  // notice, because the deck is off the nav grid.
  const back = plan.foot - plan.dir * FOOT_ROOM;
  const r = rect(...along(Math.min(plan.foot, top, back), Math.max(plan.foot, top, back)));
  stampOccupied(masks.occupied, layout, r.bx0, r.bz0, r.bx1, r.bz1);

  dressMezzanine(layout, batcher, materials, masks, rng, {
    DECK_Y, depth, vLen, vLo, uWall, uSign, alongX, nu0, nu1, nv0, nv1,
  });
}

/**
 * The row of workstations along the mezzanine's railing, facing out over the
 * machine.
 *
 * Placed through a sink of its own at deck height rather than drawn into the
 * batch, which is what makes them real: ordinary destructible props with a
 * model, a monitor and a keyboard on them, that come apart when shot like every
 * other desk in the building. Same machinery as furnishLevels uses for an attic
 * — see the note there on why a level needs its own occupancy — with two
 * differences. `reserved` is inverted, so the only tiles the sink will place
 * into are the deck's; and `blocked` is a throwaway, because the mezzanine is
 * deliberately off the nav grid and a desk up here must not make the floor
 * underneath it impassable.
 */
function dressMezzanine(layout, batcher, materials, masks, rng, m) {
  const { W, H } = layout;
  const { DECK_Y, depth, vLen, vLo, uWall, uSign, alongX, nu0, nu1, nv0, nv1 } = m;

  const reserved = new Uint8Array(W * H).fill(1);
  const open = (u0, u1, v0, v1, val) => {
    const ua = uWall + uSign * u0, ub = uWall + uSign * u1;
    const ax = alongX ? vLo + v0 : Math.min(ua, ub);
    const bx = alongX ? vLo + v1 : Math.max(ua, ub);
    const az = alongX ? Math.min(ua, ub) : vLo + v0;
    const bz = alongX ? Math.max(ua, ub) : vLo + v1;
    const tx0 = Math.max(0, Math.floor((ax - layout.ox) / TILE));
    const tx1 = Math.min(W - 1, Math.ceil((bx - layout.ox) / TILE) - 1);
    const ty0 = Math.max(0, Math.floor((az - layout.oz) / TILE));
    const ty1 = Math.min(H - 1, Math.ceil((bz - layout.oz) / TILE) - 1);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) reserved[ty * W + tx] = val;
    }
  };
  // The deck, then the stairwell taken back out of it. Rounded inward for the
  // deck and outward for the hole, so a prop can never be fitted to a tile that
  // is only half floor.
  open(0.2, depth - 0.2, 0.2, vLen - 0.2, 0);
  open(nu0 - 0.2, nu1 + 0.2, nv0 - 0.2, nv1 + 0.2, 1);

  const sink = makeSink(layout, batcher, materials, {
    level: DECK_Y,
    blocked: new Uint8Array(W * H),
    occupied: new Uint8Array(W * H),
    reserved,
    colliders: masks.colliders,
    dynamics: masks.dynamics,
    destructibles: masks.destructibles,
  });

  // Facing +u, which is out over the railing at the machine. A prop is authored
  // facing -z and the quarter turn puts that face into the room, so the turn
  // that faces +u falls out of which world axis +u is and which way it runs —
  // the same table edgeProp works from (0 = the +z wall, 1 = -x, 2 = -z, 3 = +x).
  const rot = alongX ? (uSign > 0 ? 2 : 0) : (uSign > 0 ? 1 : 3);

  const { w: deskW, d: deskD } = footprintOf(sink, 'desk');
  const uDesk = depth - 0.35 - deskD / 2;   // backed up to the railing
  if (uDesk < nu1 + deskD) return;

  const PITCH = deskW + 0.55;
  const first = 0.5 + deskW / 2;
  const n = Math.floor((vLen - 2 * first + PITCH) / PITCH);
  for (let i = 0; i < n; i++) {
    const v = first + i * PITCH;
    const uw = uWall + uSign * uDesk;
    const cx = alongX ? vLo + v : uw;
    const cz = alongX ? uw : vLo + v;
    if (!tryPlace(sink, 'desk', cx, cz, rot, rng)) continue;
    // A short wall between this station and the last, which is what makes a row
    // of desks read as a bank of workstations rather than as furniture in a
    // line. Failing is fine — it is the desks that matter.
    if (i > 0) {
      const vp = v - PITCH / 2;
      const px = alongX ? vLo + vp : uWall + uSign * (uDesk - 0.1);
      const pz = alongX ? uWall + uSign * (uDesk - 0.1) : vLo + vp;
      tryPlace(sink, 'partition', px, pz, (rot + 1) & 3, rng);
    }
  }
}

// Marks every tile a world-space rectangle touches, rounding outward — the
// same generous rounding `makeSink`'s own `stamp` uses, for the same reason:
// under-reserving is what lets the next thing placed overlap it.
function stampOccupied(mask, layout, x0, z0, x1, z1) {
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
function floorPlate(layout) {
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

function buildDoorFrames(layout, batcher, materials, colliders) {
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
      addFixture(worldX(layout, tx + 0.5), worldZ(layout, ty + 0.5), runX);
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
function generatorPanel(batcher, materials, fixtures, destructibles, x, y, z, hw, hd, distance) {
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

function buildGeneratorLights(layout, batcher, materials, fixtures, destructibles) {
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

const DOOR_T = 0.09;           // panel thickness
// How far short of the end of its pocket a fully-retracted panel stops.
//
// Not slack: it is what keeps the panel's far face from landing exactly on the far
// face of the wall it is inside. Those two faces coplanar is a shimmering rectangle
// of door on the end of a wall, which is a worse artefact than the 3 cm of panel
// edge standing in the next room that this replaces.
const POCKET_CLEAR = 0.02;
const DOOR_PANEL_H = DOOR_H - 0.04;
// Which doorways get a panel. Where a retracted one goes — and why some
// openings cannot take one at all — is slidePocketSide's business, in layout.js,
// because assignLocks has to ask the same question before it badges a room. A
// floor with a few open doorways on it reads as a floor with a few open doorways
// on it, which is what an office looks like anyway.
function buildSlidingDoors(layout, scene, materials, doors, colliders, readers, rng) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const { W } = layout;

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

    // The tiles this opening occupies. A locked door is closed to the nav grid
    // as well as to the player (see buildLevel), and unlocking it has to hand
    // them back — which is the same job destruction.js does when a prop that
    // was standing in the way stops existing.
    const navTiles = [];
    for (let ty = d.y0; ty < d.y1; ty++) {
      for (let tx = d.x0; tx < d.x1; tx++) navTiles.push(ty * W + tx);
    }

    doors.push({
      mesh, root: mesh, collider,
      x: cx, z: cz,
      at: new THREE.Vector3(cx, 1.2, cz),
      baseX: cx, baseZ: cz,
      dirX: d.vertical ? 0 : side,
      dirZ: d.vertical ? side : 0,
      // A hair further than its own width, so the trailing edge finishes inside
      // the jamb rather than flush with it — but never further than the wall
      // actually goes. `slidePocketSide` proves a pocket exactly as long as the
      // opening, and on the doorways where that is all the wall there is, the hair
      // put 3 to 4 cm of the panel's far end out in the open on the other side. It
      // is the same panel either way; what changed is that the number now comes
      // from the wall rather than from a multiplier.
      travel: Math.min(width * 1.02,
        Math.max(0, slidePocketRun(layout.tiles, layout.W, layout.H, d, side) * TILE - POCKET_CLEAR)),
      height: DOOR_PANEL_H,
      // null on an ordinary door; a card tier on a badged one. See doors.js.
      lock: d.lock ?? null,
      navTiles,
      reader: d.lock ? readers.add(d, cx, cz, x1, z1) : null,
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
function buildHallDoors(layout, scene, materials, doors, colliders, readers) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const { W } = layout;

  for (const d of layout.doors) {
    if (!d.hall) continue;

    const x0 = worldX(layout, d.x0), x1 = worldX(layout, d.x1);
    const z0 = worldZ(layout, d.y0), z1 = worldZ(layout, d.y1);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const half = (d.vertical ? z1 - z0 : x1 - x0) / 2;

    const root = new THREE.Group();
    const leaves = [];

    // One leaf hinged at each end of the opening, each an arm reaching back to
    // the middle. `end` is which end it hangs from, and it is also the sign of
    // the arm — so it is the whole of the difference between the two.
    for (const end of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(
        d.vertical ? cx : (end < 0 ? x0 : x1),
        0,
        d.vertical ? (end < 0 ? z0 : z1) : cz);

      const mesh = new THREE.Mesh(geo, materials.doorPanel);
      mesh.scale.set(d.vertical ? DOOR_T : half, DOOR_PANEL_H, d.vertical ? half : DOOR_T);
      mesh.position.set(
        d.vertical ? 0 : -end * half / 2,
        DOOR_PANEL_H / 2,
        d.vertical ? -end * half / 2 : 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pivot.add(mesh);
      root.add(pivot);

      // A quarter turn, and which quarter is the one that lays the arm down the
      // way the generator said the wall is. The two leaves turn opposite ways
      // for the same reason two doors on one frame do: their arms point at each
      // other to start with.
      leaves.push({ pivot, angleTo: (d.vertical ? -1 : 1) * end * d.swing * Math.PI / 2 });
    }
    scene.add(root);

    // Shut, the pair fills the opening exactly, so the two of them need one box
    // between them.
    const collider = {
      minX: d.vertical ? cx - DOOR_T / 2 : x0,
      maxX: d.vertical ? cx + DOOR_T / 2 : x1,
      minZ: d.vertical ? z0 : cz - DOOR_T / 2,
      maxZ: d.vertical ? z1 : cz + DOOR_T / 2,
      top: DOOR_PANEL_H,
      door: true,
    };
    colliders.push(collider);

    // The corridor tiles this doorway occupies. A locked one is shut to the nav
    // grid as well as to the player, and unlocking it has to hand them back —
    // which for a hall door is a whole wing of the floor rejoining the chase.
    const navTiles = [];
    for (let ty = d.y0; ty < d.y1; ty++) {
      for (let tx = d.x0; tx < d.x1; tx++) navTiles.push(ty * W + tx);
    }

    doors.push({
      root, leaves, collider,
      x: cx, z: cz,
      at: new THREE.Vector3(cx, 1.2, cz),
      height: DOOR_PANEL_H,
      lock: d.lock ?? null,
      navTiles,
      reader: d.lock ? readers.add(d, cx, cz, x1, z1) : null,
    });
  }
}

// --- the lift cars ----------------------------------------------------------

const LINE_T = 0.04;           // how far the car's lining stands off its plaster
const LINE_H = 2.45;           // and how far up it goes, leaving a band of wall
const RAIL_Y = 0.92;           // the handrail, at the height a hand falls
const RAIL_R = 0.035;
const CAR_LAMP_INSET = 0.35;   // the lit ceiling panel, in from the car's walls
const CAR_LAMP_Y = CEIL_H - 0.02;
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
function buildLifts(layout, batcher, materials, scene, doors, colliders, fixtures) {
  for (const lift of [layout.lifts?.arrival, layout.lifts?.departure]) {
    if (!lift) continue;
    // The departure car's indicator is green and belongs to buildExit, which
    // owns everything on this floor that says "down" and owns the one-off
    // materials it is painted in. Drawing a white one here as well would be two
    // signs over one doorway, and the wrong one is the one you would read.
    dressCar(layout, lift, batcher, materials, fixtures,
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
function dressCar(layout, lift, batcher, materials, fixtures, sign) {
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

  batcher.add('panel', materials.panel, slab(
    x0 + CAR_LAMP_INSET, z0 + CAR_LAMP_INSET,
    x1 - CAR_LAMP_INSET, z1 - CAR_LAMP_INSET, CAR_LAMP_Y, false), { castShadow: false });
  fixtures.push({
    x: (x0 + x1) / 2, y: CAR_LAMP_Y - 0.1, z: (z0 + z1) / 2,
    color: LAMP_COLD, intensity: 2.2, distance: 5,
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
function fitPartingDoors(layout, d, scene, materials, doors, colliders, travelFor) {
  const { W } = layout;
  const geo = new THREE.BoxGeometry(1, 1, 1);

  const x0 = worldX(layout, d.x0), x1 = worldX(layout, d.x1);
  const z0 = worldZ(layout, d.y0), z1 = worldZ(layout, d.y1);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const width = d.vertical ? z1 - z0 : x1 - x0;
  const half = width / 2;

  const root = new THREE.Group();
  const panels = [];
  for (const end of [-1, 1]) {
    const mesh = new THREE.Mesh(geo, materials.doorPanel);
    mesh.scale.set(d.vertical ? DOOR_T : half, DOOR_PANEL_H, d.vertical ? half : DOOR_T);
    const px = d.vertical ? cx : cx + end * half / 2;
    const pz = d.vertical ? cz + end * half / 2 : cz;
    mesh.position.set(px, DOOR_PANEL_H / 2, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    panels.push({
      mesh, baseX: px, baseZ: pz,
      dirX: d.vertical ? 0 : end,
      dirZ: d.vertical ? end : 0,
      travel: travelFor(end, half),
    });
  }
  scene.add(root);

  const collider = {
    minX: d.vertical ? cx - DOOR_T / 2 : x0,
    maxX: d.vertical ? cx + DOOR_T / 2 : x1,
    minZ: d.vertical ? z0 : cz - DOOR_T / 2,
    maxZ: d.vertical ? z1 : cz + DOOR_T / 2,
    top: DOOR_PANEL_H,
    door: true,
  };
  colliders.push(collider);

  const navTiles = [];
  for (let ty = d.y0; ty < d.y1; ty++) {
    for (let tx = d.x0; tx < d.x1; tx++) navTiles.push(ty * W + tx);
  }

  doors.push({
    root, panels, collider,
    x: cx, z: cz,
    at: new THREE.Vector3(cx, 1.2, cz),
    height: DOOR_PANEL_H,
    lock: null,
    navTiles,
    reader: null,
  });
}

function fitLiftDoors(layout, lift, scene, materials, doors, colliders) {
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
function buildDoubleDoors(layout, scene, materials, doors, colliders) {
  for (const d of layout.doors) {
    if (!d.double || d.hall || d.lift) continue;
    fitPartingDoors(layout, d, scene, materials, doors, colliders, (end, half) => {
      const run = slidePocketRun(layout.tiles, layout.W, layout.H, d, end) * TILE;
      return Math.max(0, Math.min(half, run) - POCKET_CLEAR);
    });
  }
}

// --- badge readers ----------------------------------------------------------

const READER_H = 1.15;         // metres up the jamb — where your hand goes
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
class BadgeReaders {
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

const UP = new THREE.Vector3(0, 1, 0);

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
function makeSink(layout, batcher, materials, masks) {
  const { W, H, tiles } = layout;
  const { blocked, occupied, reserved, colliders, dynamics, destructibles } = masks;
  const level = masks.level ?? 0;

  // While a dynamic prop is being authored, its boxes are collected here
  // instead of going into the static batch — they need to stay a separate
  // mesh so physics can move them.
  let pending = null;
  // A static prop being authored: everything it draws, blocks and collides
  // with, gathered so all of it can be taken away in one go when it's shot.
  let record = null;
  // A dry run of a prop's `build`, collecting the boxes without drawing them.
  let capture = null;
  // What grade of hulk the boxes being drawn right now are, if any: `true` for
  // welded structure, `'trim'` for a fitting bolted to it. Both stay standing
  // when the prop is destroyed; only the first says how big the machine is.
  // See `hulk` below.
  let hulkOn = false;
  // What the boxes being drawn right now are STOCK for, or null: the drink seed
  // for the can itself, or 'trim' for something drawn ON that can. A stock box is
  // not one of the prop's fragments — it is a thing the prop is holding, and it
  // leaves as itself rather than as a piece of the cabinet it was standing in.
  // See `stock` below and `_spillStock` in destruction.js.
  let stockOn = null;

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

    /**
     * Runs `fn` with one prop's reserved floor lent back to it, and takes it
     * again afterwards. For a chair pulled up to a desk, which is the only kind
     * of prop that is SUPPOSED to stand inside another one's reservation.
     *
     * Reserving floor rounds outward to whole tiles (see `stamp`), which is what
     * stops two props overlapping and is not worth loosening. But a desk is
     * 0.97 m deep, so its reservation reaches up to half a metre past its own
     * front face — and a chair pulled up to that face therefore lands inside it
     * however carefully it is placed in metres. Measured on one floor: 16 desks
     * backed against walls, 16 chairs refused, every private office on the floor
     * furnished with a desk nobody could be sitting at.
     *
     * Everything else still applies while the tiles are lent: a wall is still a
     * wall, a doorway apron is still reserved, and the cabinet beside the desk
     * still has its own floor. It is one prop's claim that is waived, for the one
     * prop that belongs to it.
     */
    lend(x0, z0, x1, z1, fn) {
      const r = range(x0, z0, x1, z1);
      const held = [];
      for (let ty = r.ty0; ty <= r.ty1; ty++) {
        for (let tx = r.tx0; tx <= r.tx1; tx++) {
          const i = ty * W + tx;
          if (occupied[i]) { held.push(i); occupied[i] = 0; }
        }
      }
      try { return fn(); } finally { for (const i of held) occupied[i] = 1; }
    },

    /**
     * A place somebody works: where the chair is, and which way round they are
     * sitting in it. `rot` is the chair's own quarter turn, so the body faces
     * the desk for exactly the reason the chair does.
     *
     * The furnisher is the only thing on the floor that knows a desk has a
     * monitor on it and a chair pulled up to it, so it is the only thing that
     * can say where a working body goes — enemies.js would otherwise be
     * guessing at furniture from the nav grid. Nothing here reserves anything:
     * a workstation is an offer, taken up by whoever is staffing the room (see
     * `_takeDesk` in enemies.js) and ignored if nobody is.
     *
     * A sink furnishing a storey does not collect them. The nav grid on a level
     * is not the ground floor's, the desks on the generator's mezzanine are off
     * it entirely, and a body seated somewhere nothing can walk to is a body
     * that stands up into a wall.
     */
    workstation(x, z, rot, at = 'desk') {
      if (level) return;
      // `at` is what the chair is pulled up to, and the two are not
      // interchangeable: a desk is a JOB — it decides how big a shift a room is
      // dealt and it seats a body typing (see _spawnPoints and deskPool in
      // enemies.js) — while a canteen table is somewhere to eat lunch. Pooled
      // apart at the other end, so a cafeteria full of seats can never be read
      // as a room with twenty jobs going in it.
      masks.workstations.push({ x, z, rot, at, room: null });
    },

    box(key, x0, y0, z0, x1, y1, z1) {
      const b = { key, x0, y0: y0 + level, z0, x1, y1: y1 + level, z1 };
      if (hulkOn) b.hulk = hulkOn;
      // Tested against null rather than for truth, because seed 0 is a drink
      // like any other and `if (stockOn)` would quietly hand every twenty-
      // thousandth can back to the fragment pile.
      if (stockOn != null) b.stock = stockOn;
      if (capture) { capture.push(b); return; }
      if (pending) { pending.boxes.push(b); return; }
      batcher.add(key, materials[key], boxBetween(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1));
      // One add() and one box, on the same call and in the same order — which
      // is what lets endStatic hand destruction.js a mask over `spans`.
      record?.boxes.push(b);
    },

    /**
     * Marks what follows as part of the HULK: the geometry that is still
     * standing, burnt, after the prop is destroyed. Only the generator uses it
     * (see `weld` in gen/props.js); leave it off and a prop is destroyed
     * exactly as it always was, geometry and all.
     *
     * `true` is welded structure — the machine's own mass, whose extent is what
     * `_wreck` sites its blasts against. `'trim'` is a fitting bolted to that:
     * it survives and is carved identically, but it must not be allowed to
     * stretch the machine's measured corners out to the tip of an exhaust
     * stack. Anything falsy ends the run.
     */
    hulk(grade) { hulkOn = grade || false; },

    /**
     * Marks what follows as STOCK: something the prop is holding rather than
     * something it is made of. Pass null to end the run.
     *
     * The prop still draws it, and it is still erased with the rest of the
     * prop's spans when the prop goes — what changes is what happens next.
     * `_shatter` takes stock off the fragment list and throws the real thing
     * from where the facing was standing, so the drink that was in the window
     * is the drink now rolling across the carpet. Left unmarked, a machine's
     * stock would be thrown twice: once as a coloured box out of the debris
     * budget, and once as the can it actually is.
     *
     * A NUMBER is the drink itself, and it is the seed that says which drink
     * (see drinks.js). 'trim' is something drawn on that can — its label
     * band — which is neither a drink of its own nor a fragment of the machine,
     * so it is thrown by neither pass and goes with the prop. Exactly the
     * distinction `hulk` draws one method up between a machine's own mass and a
     * fitting bolted to it.
     *
     * Same trap as `hulk` too: the placer in gen/props.js has to forward this or
     * a prop marking its stock reaches nothing at all, silently.
     */
    stock(grade) { stockOn = grade == null ? null : grade; },

    obstacle(x0, z0, x1, z1, top, building) {
      // A dynamic prop's footprint moves, so it can't become a static collider
      // or a permanent hole in the nav grid. A dry run isn't there at all.
      if (pending || capture) return;
      const collider = { minX: x0, maxX: x1, minZ: z0, maxZ: z1, top: top + level };
      // Its underside, on a sink that is furnishing a storey rather than the
      // ground. Without it the collider is a pillar from the floor and a crate
      // upstairs is a pillar through the room below — see gen/stairs.js.
      if (level) collider.base = level;
      // Shell, not furniture — exempts a genuinely oversized prop (the
      // generator) from validate-props.mjs's MAX_PROP_SIDE/MAX_PROP_TOP
      // furniture caps, the same way a wall or a staircase already is.
      if (building) collider.building = true;
      colliders.push(collider);
      record?.colliders.push(collider);
      // Anything the player can't step over blocks the enemies too. The
      // threshold has to match the player's step tolerance (STEP_EPS in
      // player.js): a sofa at 0.44 m and a plant pot at 0.34 m are both solid
      // to walk into, so leaving them out of the nav grid gave the enemies
      // routes straight through the furniture.
      //
      // None of which applies to a prop that is not on the floor. The nav grid is
      // one grid per floor and it describes the ground: stamping this one would
      // have a crate upstairs make the office below impassable, and handing its
      // tiles back when it is shot would open a tile a desk down there is
      // standing on. So a storey's props are simply not in it — which is the same
      // decision as the stairwell's, for the same reason.
      if (!level && top > 0.3) stampCentres(blocked, x0, z0, x1, z1, record?.navTiles);
    },

    // --- downloaded models -------------------------------------------------
    modelInfo,

    // Batched by source material, so a floor of desks is a couple of draw calls.
    model(key, x, y, z, yaw) {
      return stampModel(key, x, y + level, z, yaw, (geometry, material) => {
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

    beginStatic(hp, substance, volatile = false, powerCore = false, spills = null) {
      hulkOn = false;
      stockOn = null;
      record = hp > 0
        ? {
          hp, substance, volatile, powerCore, spills,
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
      hulkOn = false;
      stockOn = null;
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
        // The one destructible that fans its own kill out floor-wide — see
        // destruction.js's _shatter and game.js's _onPowerCut.
        powerCore: r.powerCore,
        // What is inside it, if anything pours out when it goes. The same trait
        // a loose prop carries on `traits.spills` — a cooler is loose and a
        // vending machine is not, and both have to answer the same question.
        spills: r.spills,
        spans: r.spans,
        // Which of those spans belong to the hulk, aligned one-for-one because
        // box() records a span and a box on the same call. Only its PRESENCE is
        // read, and that is the point of it: it is how `_shatter` tells "leaves
        // a wreck" from "goes, like everything else on the floor". The grades
        // themselves travel on `parts`, which is what `_wreck` reads.
        hulkSpans: r.boxes.some((b) => b.hulk) ? r.boxes.map((b) => !!b.hulk) : null,
        // Whether this prop is holding anything, asked once here rather than
        // per destruction: `_shatter` runs for every desk and pane of glass on
        // the floor, and it must not sift a parts list looking for stock that
        // thirty of the thirty-one props in the catalogue never have. The stock
        // itself travels on `parts`, one seed per facing.
        stock: r.boxes.some((b) => typeof b.stock === 'number'),
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

    // `traits` is whatever about a loose prop the runtime has to know that is not
    // its shape: whether a body walking over it flattens it, and whether shooting
    // it puts water on the floor. Both are read in game.js and destruction.js,
    // which never see the catalogue.
    beginDynamic(mass, hp, substance, traits) {
      pending = { mass, hp, substance, traits, boxes: [] };
    },

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
      const boxMeshes = [];

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
        boxMeshes.push(mesh);
      }

      // A loose prop drawn with its MODEL instead of its boxes, which is the one
      // combination gen/models.js says does not happen — see `washingMachine` in
      // gen/props.js for why this one has to have both. The boxes stay exactly
      // as they are, in `parts`, because they are what the prop breaks into and
      // what the collider is measured from; they are only taken out of the
      // picture.
      //
      // Two transforms, and both are the documented model contract read
      // backwards. A baked model sits centred in X/Z with its min Y at zero,
      // while the group's origin is the CENTRE of the box bounds — so the model
      // drops by exactly the distance from that centre down to the floor. And
      // the prop's quarter turn is baked into the box coordinates by `placer`,
      // so the model has to be turned by hand to match; it goes on a child group
      // rather than on the group itself, because the group's rotation belongs to
      // the physics body.
      const template = p.traits?.model ? modelInfo(p.traits.model) : null;
      if (template?.parts?.length) {
        const skin = new THREE.Group();
        skin.position.y = minY - cy;
        skin.rotation.y = -(p.traits.rot ?? 0) * Math.PI / 2;
        for (const part of template.parts) {
          const mesh = new THREE.Mesh(part.geometry, part.material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          skin.add(mesh);
        }
        group.add(skin);
        // Hidden rather than removed, so the fallback is one flag away if a GLB
        // ever fails to load mid-session. `visible` is enough: these meshes are
        // not in the raycast list (bullets test the group's children via
        // `userData.dynamic`, which is set on all of them in game.js) — and a
        // hidden mesh with a live collider is exactly what the parcels
        // documented as worse than nothing, which is why the collider is
        // measured from the BOXES either way and does not care.
        for (const mesh of boxMeshes) mesh.visible = false;
      }

      dynamics.push({
        group,
        parts,
        mass: p.mass,
        hp: p.hp ?? 0,
        substance: p.substance,
        crushable: !!p.traits?.crushable,
        spills: p.traits?.spills ?? null,
        // Whose runtime this prop belongs to, if anybody's. See washers.js.
        washer: !!p.traits?.washer,
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
        position: { x: cx, y: cy, z: cz },
      });
    },
  };
}

function furnishRooms(layout, sink, rng, workstations, theme) {
  for (const room of layout.rooms) {
    // Keep furniture off the walls so nothing clips into the skirting.
    const bounds = {
      x0: worldX(layout, room.x0) + 0.15,
      z0: worldZ(layout, room.y0) + 0.15,
      x1: worldX(layout, room.x1) - 0.15,
      z1: worldZ(layout, room.y1) - 0.15,
    };
    const before = workstations.length;
    furnish(sink, room, bounds, rng, layout.doors, theme);
    // Whose room each desk is in, stamped here rather than threaded through the
    // furnisher: `seatFacing` is called from six roles and none of them has any
    // other reason to know which room it is filling, and a workstation lands
    // between these two lines or it does not exist. Who works in a room is
    // decided per room (see `_spawnPoints` in enemies.js), so this is the one
    // fact about a desk that the placement needs and the placer cannot give.
    for (let i = before; i < workstations.length; i++) workstations[i].room = room;
  }
}

// How a cow got into an office block is not this file's problem either — see
// the `cow` entry in gen/props.js. One floor in COW_CHANCE gets one, in one
// random room, tried after every room is furnished so it only ever claims
// floor space nothing else wanted. Not the spawn room (nowhere to hide a punch
// line before the player has even moved) or the exit (the last thing seen on
// the way out is the objective, not the joke).
const COW_CHANCE = 0.15;

function placeCow(layout, sink, rng) {
  if (!rng.chance(COW_CHANCE)) return null;

  const candidates = rng.shuffle(
    layout.rooms.filter((r) => r !== layout.spawnRoom && r !== layout.exitRoom));
  for (const room of candidates) {
    const x0 = worldX(layout, room.x0) + 0.2, x1 = worldX(layout, room.x1) - 0.2;
    const z0 = worldZ(layout, room.y0) + 0.2, z1 = worldZ(layout, room.y1) - 0.2;
    if (x1 - x0 < 1 || z1 - z0 < 1) continue;

    for (let tries = 0; tries < 12; tries++) {
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      if (tryPlace(sink, 'cow', x, z, rng.int(0, 3), rng)) return { x, z };
    }
  }
  return null;
}

// --- stairs -----------------------------------------------------------------

// What ends up on a deck. Storage, because that is what a raised platform in an
// office is for, and because a deck is the one place worth walking to for what is
// on it rather than for where it goes.
//
// Nothing over 1.4 m tall is in the list, and that is a real constraint rather
// than taste: a prop's collider is a pillar from the floor, so on a deck its
// `top` comes out at DECK_Y plus its own height, and the props validator holds
// every prop to 2.4 m. A 1.85 m locker on a metre-high deck is a 2.85 m prop.
// Repeats are the weighting: a deck should read as stock that got put up out of
// the way, so it is mostly crates and pallets with the odd bit of office in among
// them.
const UPPER_KINDS = [
  'crate', 'crate', 'crate', 'crateStack', 'crateStack', 'crateStack',
  'pallet', 'pallet', 'cabinet', 'cabinet', 'workbench', 'shelving',
  'recyclingBin', 'trashCan', 'extinguisher', 'printer', 'stool', 'lockers',
];
// The same 0.15 m a room keeps off its plaster, for the same reason: the storey's
// wall ring stands over the wall downstairs, so its inside face is exactly where
// the room's is.
const UPPER_INSET = 0.15;
const TREAD_SKIN = 0.03;      // the walking surface laid over the step's body
const NOSING = 0.07;          // yellow strip along the front edge of every tread
const FLOOR_SKIN = 0.03;      // flooring laid over the structural deck
// Materials by what the part IS, so the geometry half never names one.
const PART_MATERIAL = { tread: 'trim', deck: 'trim', wall: 'wall', roof: 'ceiling', lid: 'ceiling' };

/**
 * The staircases, the storeys they climb to, and what is up there.
 *
 * Every box comes from `stairBoxes` in gen/stairs.js rather than being worked out
 * again here, so the picture, the player's collision, the solver and the validators
 * cannot come to different conclusions about where a tread is.
 *
 * Colliders are marked `building`: they are shell, not furniture. Permanent, not
 * destructible, and the props validator audits them as such — a whole storey's
 * floor slab read as a prop fails every dimension a prop has. They also carry
 * `base`, which is what makes the storey possible at all: see gen/stairs.js.
 */
function buildStairs(layout, batcher, materials, masks, rng) {
  const { W } = layout;

  for (const plan of layout.stairs) {
    for (const b of stairBoxes(layout, plan)) {
      if (b.part === 'tread') drawStep(batcher, materials, b, plan);
      else drawPart(batcher, materials, b);

      // `roof`, `lid` and `deck` are the slabs a body can be standing anywhere
      // underneath — furniture inside a storey, or inside the room below an
      // attic's own floor. `wall` and `tread` are meant to push back side-on,
      // which is what makes one a wall and the other a step.
      masks.colliders.push({
        minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ,
        base: b.base, top: b.y1, building: true,
        ceiling: b.part === 'roof' || b.part === 'lid' || b.part === 'deck',
        // A storey's walls and its roof are the shell one floor up, and take the
        // shell's rule (see `barrier` in drawWalls). The other three cannot have
        // it: a `tread` is the one thing here that MUST be a step, a `deck` is a
        // storey's own floor and is stood on top of, and a `lid` is the underside
        // of the plate a basement is roofed with.
        //
        // ...and neither can a BASEMENT's wall ring, which is why the test is not
        // simply `part === 'wall'`. What `barrier` says is "never a kerb and never
        // a floor", and the reason a wall wants it is that a body standing on a
        // deck or a flight beside one must not step up onto its top. A basement's
        // walls stand from its slab to y = 0 (`wallTop` in gen/stairs.js), so their
        // top is not somewhere you might step onto — it IS the ground floor, the
        // surface the whole building walks on. Barrier there does not fence off a
        // wall top, it fences off the ROOM UPSTAIRS: `barrier` defeats the kerb
        // test at every height, so a box lying entirely under the floor was a
        // full-height obstruction to anyone above it, and every room standing over
        // a basement was ringed by an invisible wall one tile inside its own. Its
        // doorway could not be walked through, which is the whole of what that
        // looks like from the corridor — measured at 23 impassable doorways over 12
        // floors, on 11 of them. Nothing hands these boxes to the nav grid, so the
        // staff walked in and out of the room the whole time, and `buildGeomGrid`
        // in tools/validate-props.mjs has always discarded a collider whose top is
        // at or below the floor ("a body walks under an attic and over a
        // basement"), which is why npm test stayed green over a sealed room.
        //
        // It is still a wall to anyone DOWNSTAIRS without it: from the basement's
        // own slab its top is a full storey up, decades past STEP_EPS, and the only
        // way to feet within a step of y = 0 down there is the flight itself, whose
        // treads land you on the ground floor because that is what they are for.
        barrier: (b.part === 'wall' && b.y1 > 0) || b.part === 'roof',
      });
    }

    // The stairwell is out of the FURNISHER's reach, so no desk ends up buried in
    // the flight — but it stays in the nav grid, which is what lets somebody follow
    // you up it. The grid has a layer for the levels and joins the two at exactly
    // these tiles; see the note at the top of nav.js.
    for (const i of stripTiles(plan, W)) masks.occupied[i] = 1;
    // The floor at the bottom of the flight is reserved from the furnisher but
    // stays in the nav grid — you have to be able to stand there to start
    // climbing, and so does anybody following you. Without it, better than one
    // flight in three came out behind a filing cabinet.
    for (const i of approachTiles(plan, W)) masks.occupied[i] = 1;

    lightLevel(layout, plan, batcher, materials, masks.fixtures);
  }
}

// A step is a grey body with the building's own floor laid over the top of it, and
// a hazard strip along the edge you meet coming down. The strip OVERLAPS the tread
// rather than resting flush on it, for the reason the door frames do: two faces in
// one plane is a z-fight, two solids that interpenetrate is not.
function drawStep(batcher, materials, b, plan) {
  batcher.add('trim', materials.trim,
    boxBetween(b.minX, b.base, b.minZ, b.maxX, b.y1 - TREAD_SKIN, b.maxZ));
  batcher.add('vinyl', materials.vinyl, applyWorldUVs(
    boxBetween(b.minX, b.y1 - TREAD_SKIN, b.minZ, b.maxX, b.y1, b.maxZ)));

  // The exposed edge is the one facing the bottom of the flight, which is the
  // opposite way to the climb.
  const alongX = plan.axis === 'x';
  const front = plan.up > 0 ? (alongX ? b.minX : b.minZ) : (alongX ? b.maxX : b.maxZ) - NOSING;
  batcher.add('hazard', materials.hazard, boxBetween(
    alongX ? front : b.minX, b.y1 - NOSING, alongX ? b.minZ : front,
    alongX ? front + NOSING : b.maxX, b.y1 + 0.004, alongX ? b.maxZ : front + NOSING));
}

function drawPart(batcher, materials, b) {
  const key = PART_MATERIAL[b.part];
  batcher.add(key, materials[key], applyWorldUVs(
    boxBetween(b.minX, b.base, b.minZ, b.maxX, b.y1, b.maxZ)));
  // A level's deck gets flooring laid on it, like a tread does — you walk on it.
  if (b.part !== 'deck') return;
  batcher.add('vinyl', materials.vinyl, applyWorldUVs(
    boxBetween(b.minX, b.y1 - TREAD_SKIN, b.minZ, b.maxX, b.y1, b.maxZ)));
}

// A sealed level has no window and a lid of its own, so without this it is a black
// room with something in it. Panels on the same pitch as any other room's, registered
// as fixtures, so the light pool treats them as the ceiling lights they are. An attic
// has them under its roof; a basement has them under the floor plate.
function lightLevel(layout, plan, batcher, materials, fixtures) {
  const f = levelFloor(layout, plan);
  const y = plan.dir > 0 ? UPPER_CEIL : -PLATE_T;
  const nx = Math.max(1, Math.round((f.maxX - f.minX) / LIGHT_PITCH));
  const nz = Math.max(1, Math.round((f.maxZ - f.minZ) / LIGHT_PITCH));

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = f.minX + ((ix + 0.5) / nx) * (f.maxX - f.minX);
      const z = f.minZ + ((iz + 0.5) / nz) * (f.maxZ - f.minZ);
      batcher.add('panel', materials.panel,
        slab(x - 0.62, z - 0.16, x + 0.62, z + 0.16, y - 0.02, false),
        { castShadow: false, receiveShadow: false });
      // Drawn with materials.panel above, so it throws that panel's own colour.
      fixtures.push({ x, y: y - 0.12, z, color: LAMP_COLD, intensity: 0.85, distance: 10 });
    }
  }
}

/**
 * Furnishes the attics and the basements, through sinks of their own.
 *
 * A level gets masks of its own and that is the whole trick. The collider list, the
 * loose props and the destruction records are the floor's — a crate in an attic is
 * shot apart exactly like one in the corridor. But "is this tile taken" and "can a
 * body walk here" are questions about a LEVEL, and the answers up there have nothing
 * to do with the answers on the ground: sharing the real masks would have a filing
 * cabinet in an attic make the office beneath it impassable.
 *
 * One sink per direction, because a sink belongs to one level (`masks.level`) — which
 * is also what gives its colliders an underside and keeps them off the nav grid.
 *
 * Nothing is height-limited, unlike a low platform would be: a level has a full
 * room's headroom, so the tall things go up and down there too.
 */
function furnishLevels(layout, batcher, materials, shared, rng) {
  if (!layout.stairs.length) return;
  const { W, H } = layout;

  for (const dir of [1, -1]) {
    const plans = layout.stairs.filter((p) => p.dir === dir);
    if (!plans.length) continue;

    // Reserved is everything EXCEPT this level's own floor, which is the room it
    // belongs to minus the stairwell. Inverted rather than listed because the tile
    // grid a prop is fitted against is the floorplan's, and the floorplan has no idea
    // a second level exists: without this a two-metre workbench could reach past the
    // deck and out over the corridor, held up by nothing at all.
    const reserved = new Uint8Array(W * H).fill(1);
    for (const plan of plans) {
      const r = plan.room;
      for (let ty = r.y0; ty < r.y1; ty++) {
        for (let tx = r.x0; tx < r.x1; tx++) reserved[ty * W + tx] = 0;
      }
    }
    for (const plan of plans) {
      for (const i of stripTiles(plan, W)) reserved[i] = 1;
    }

    const sink = makeSink(layout, batcher, materials, {
      level: dir > 0 ? UPPER_Y : LOWER_Y,
      // A level's own furniture DOES block its own nav layer — it is the floor those
      // props are standing on. `shared.levelBlocked` is one mask for every level on
      // the floor, which works because no two of them share a tile.
      blocked: shared.levelBlocked,
      occupied: new Uint8Array(W * H),
      reserved,
      colliders: shared.colliders,
      dynamics: shared.dynamics,
      destructibles: shared.destructibles,
    });

    for (const plan of plans) dressLevel(layout, plan, sink, rng);
  }
}

function dressLevel(layout, plan, sink, rng) {
  const f = levelFloor(layout, plan);
  const x0 = f.minX + UPPER_INSET, x1 = f.maxX - UPPER_INSET;
  const z0 = f.minZ + UPPER_INSET, z1 = f.maxZ - UPPER_INSET;
  if (x1 - x0 < 0.5 || z1 - z0 < 0.5) return;

  // Every half-metre cell gets a try, in a shuffled order. Darts were the first
  // version and gave a room of two things or of nine: a spot that survives the fit
  // test is a small fraction of a room, so a fixed number of random throws is a
  // lottery rather than a density. Same lesson as camera placement in cameras.js.
  const spots = [];
  for (let z = z0 + TILE / 2; z <= z1 - TILE / 2 + 1e-9; z += TILE) {
    for (let x = x0 + TILE / 2; x <= x1 - TILE / 2 + 1e-9; x += TILE) spots.push({ x, z });
  }
  // ...and a ceiling on how many land. Without it the big things take the first few
  // spots and then every leftover gap takes the one prop still small enough to fit it,
  // which came out as two pallets and eight fire extinguishers. A store room is
  // stacked, not tiled.
  let left = Math.max(4, Math.round((x1 - x0) * (z1 - z0) / 1.6));

  rng.shuffle(spots);
  for (const s of spots) {
    if (left <= 0) break;
    // Several kinds per spot rather than one. With a single random pick, a spot that
    // came up `workbench` against a wall is simply lost, and what is up there is the
    // entire point of climbing.
    const rot = rng.int(0, 3);
    for (const kind of rng.shuffle(UPPER_KINDS.slice())) {
      // The tile grid a prop is fitted against is the floorplan's, which stops at the
      // wall and knows nothing about the 0.15 m a room keeps off its plaster. So the
      // inset is tested here, through the same `footprintOf` every other placement
      // uses — never PROPS[kind].w/.d, which is a quarter of a metre out on half the
      // model-backed props.
      const foot = footprintOf(sink, kind, rot);
      if (s.x - foot.w / 2 < x0 || s.x + foot.w / 2 > x1) continue;
      if (s.z - foot.d / 2 < z0 || s.z + foot.d / 2 > z1) continue;
      if (tryPlace(sink, kind, s.x, s.z, rot, rng)) { left--; break; }
    }
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

/**
 * One to three washing machines, in the corridors.
 *
 * A pass of its own rather than another entry in `furnishCorridors`'s `kinds`
 * list, because that pass walks a 7-tile grid at 40% and would deal a dozen of
 * them to a big floor. This is a joke and the codebase already knows the rule
 * for those — one per floor is a joke, two is a running joke, three is a fleet
 * (see `roomba` in enemy-types.js) — so it is capped at three and scaled by how
 * much building there is.
 *
 * A SHUFFLED LIST rather than darts, which is the lesson cameras.js and
 * conveyors.js both paid for: a corridor tile that survives every test is a few
 * percent of a floor, so throwing darts delivers one machine on this floor and
 * five on the next. Spaced out too, because two of these in earshot of each
 * other is one racket rather than two.
 */
function placeWashers(layout, sink, rng) {
  const { W, H, tiles } = layout;
  const want = Math.min(WASHER_MAX,
    Math.max(1, Math.round(rng.int(1, WASHER_MAX) * (layout.areaRatio ?? 1))));

  const spots = [];
  for (let ty = 2; ty < H - 2; ty++) {
    for (let tx = 2; tx < W - 2; tx++) {
      if (tiles[ty * W + tx] !== CORRIDOR) continue;
      spots.push([tx, ty]);
    }
  }
  rng.shuffle(spots);

  const placed = [];
  for (const [tx, ty] of spots) {
    if (placed.length >= want) break;
    const x = worldX(layout, tx + 0.5);
    const z = worldZ(layout, ty + 0.5);
    if (placed.some((q) => Math.hypot(q.x - x, q.z - z) < WASHER_GAP)) continue;
    if (tryPlace(sink, 'washingMachine', x, z, rng.int(0, 3), rng)) placed.push({ x, z });
  }
}

// Three at the very most, and never nearer than this to each other — see the
// note above. The gap is well past the clip's own audible range (WASHER_AUDIBLE
// in audio.js), so two are never heard as one.
const WASHER_MAX = 3;
const WASHER_GAP = 26;

// Doorways, the spawn point and the exit must never be furnished shut.
function reserveClearances(layout, reserved) {
  const { W, H } = layout;

  const stampTiles = (tx0, ty0, tx1, ty1) => {
    for (let ty = Math.max(0, ty0); ty <= Math.min(H - 1, ty1); ty++) {
      for (let tx = Math.max(0, tx0); tx <= Math.min(W - 1, tx1); tx++) reserved[ty * W + tx] = 1;
    }
  };

  // DOOR_CLEAR tiles of clear floor on both sides of a doorway, shared with
  // gen/stairs.js — see its declaration in gen/tiles.js.
  const SWING = DOOR_CLEAR;
  for (const d of layout.doors) {
    if (d.vertical) stampTiles(d.x0 - SWING, d.y0 - 1, d.x1 + SWING, d.y1);
    else stampTiles(d.x0 - 1, d.y0 - SWING, d.x1, d.y1 + SWING);
  }

  // A clear square where the player materialises, and another at the hatch they
  // leave by.
  //
  // Four metres across rather than the five and a half it used to be, and what
  // changed is the spawn. This was sized when arriving always meant a lift lobby
  // — a small room furnished against its walls anyway, where the difference is
  // invisible — and a floor now arrives in its canteen when it has one (see
  // pickCafeteria in gen/layout.js), which is the first room this has ever been
  // stamped into that is furnished AROUND the player. Measured: a cafeteria is
  // typically 8 to 12 m across, and 5.5 m of clear square through the middle of
  // it plus the lane kept in front of the servery is the room's whole depth. 11
  // of 37 came out with a counter, a vending machine and nothing whatever to sit
  // at, which is exactly how they looked.
  //
  // It stays well clear of what it is for either way: the props sweep holds both
  // points to 1.5 m of clear floor (SPAWN/EXIT in tools/validate-props.mjs), and
  // this is 2 m to the nearest edge of the square.
  //
  // Measured from where the player ACTUALLY arrives rather than from the middle
  // of the room, which is the same point on a floor with no lifts and is a car
  // hard against one wall on a floor with them. Off the room centre it left the
  // reception's own desk free to be placed across the lift doors.
  const ARRIVAL_CLEAR = 4;   // tiles from the centre tile, so a 9 x 9 square
  for (const at of [layout.spawn, layout.exit]) {
    const cx = tileX(layout, at.x), cy = tileY(layout, at.z);
    stampTiles(cx - ARRIVAL_CLEAR, cy - ARRIVAL_CLEAR,
      cx + ARRIVAL_CLEAR, cy + ARRIVAL_CLEAR);
  }

  // And the cars themselves, whole. The square above covers a car standing
  // square to the axes it is measured on, but it is a square and a car is not:
  // a corner of a 4 x 3 tile interior can fall outside it once the doorway apron
  // has been stamped in a different direction, and a fire extinguisher in the
  // corner of the lift you arrive in is the first thing on the floor.
  for (const lift of [layout.lifts?.arrival, layout.lifts?.departure]) {
    if (lift) stampTiles(lift.tx0, lift.ty0, lift.tx1 - 1, lift.ty1 - 1);
  }

  // Both of these are about a route rather than a spot, and both hang off the same
  // list of doorways.
  const mouths = doorMouths(layout);
  reserveThroughRoutes(layout, mouths, stampTiles);
  reserveStairRoutes(layout, mouths, stampTiles);
}

/**
 * How wide a reserved lane is, in tiles.
 *
 * Three, and the third one is not slack. Two tiles is a metre of floor no prop can
 * reach into, which is plenty for the PLAYER — their collision is continuous and a
 * 0.8 m body walks a 1 m gap. It is not enough for anybody else: the nav grid is
 * eroded by the body radius per tile (`fits` in nav.js), and that test reaches 0.11 m
 * past the tile it is centred on, so both columns of a two-wide lane are disqualified
 * by whatever is standing beside the lane. The result was a lane the player could walk
 * and the enemies could not — which the nav sweep found as a quarter of all levels
 * being unreachable from their own doorway.
 */
const LANE = 3;

/**
 * A room you have to walk THROUGH keeps a lane between its doorways.
 *
 * Almost every room opens onto a corridor, and a corridor cannot be furnished
 * shut — the props along one are 7 tiles apart in a 6-tile-wide hallway. So for
 * almost every room, furniture blocking the way from one of its doors to another
 * costs the player nothing: both halves are still reachable from the hall.
 *
 * The exception is a room whose doorway leads into another ROOM rather than a
 * corridor, and it is the whole reason this exists. Then the far room's only
 * route in is across this one, and two props standing corner to corner across
 * the middle do not merely make the room awkward — they end the floor. A hostile
 * still spawns in the sealed room, because the nav grid is coarser than a body
 * and thinks the gap is walkable, so the objective can never reach zero and the
 * run is over. That is `5.geom-connected` in tools/validate-props.mjs, and it is
 * what caught this: a copyroom behind a crate and a shelving unit 0.85 m apart
 * on the diagonal, which is under the 0.8 m of square body needed to pass.
 *
 * Reserving the lane rather than repairing it afterwards is deliberate, and it
 * is what the rest of this function already does for the doorways themselves: a
 * floor cannot be furnished into a state it then has to be rescued from.
 */
/**
 * Every doorway of every room, from the inside.
 *
 * `room.doors` holds only the doors that room CUT (see cutDoor in gen/layout.js), and
 * the one its neighbour cut into it is in the wall all the same — so the sides are
 * recovered from the tiles either side of each opening. A hall door probes two
 * corridor tiles and drops out, which is right: it is not in anybody's room.
 */
function doorMouths(layout) {
  const { rooms, doors } = layout;
  const inside = (r, tx, ty) => tx >= r.x0 && tx < r.x1 && ty >= r.y0 && ty < r.y1;
  const mouths = new Map();
  for (const d of doors) {
    const cx = Math.floor((d.x0 + d.x1) / 2), cy = Math.floor((d.y0 + d.y1) / 2);
    const probes = d.vertical
      ? [[d.x0 - 1, cy], [d.x1, cy]]
      : [[cx, d.y0 - 1], [cx, d.y1]];
    const sides = probes
      .map(([px, py]) => ({ room: rooms.find((r) => inside(r, px, py)), at: [px, py] }))
      .filter((s) => s.room);
    // Two rooms either side means neither of them is a way out on its own.
    const through = sides.length === 2;
    for (const s of sides) {
      if (!mouths.has(s.room)) mouths.set(s.room, []);
      mouths.get(s.room).push({ at: s.at, through });
    }
  }
  return mouths;
}

/**
 * A clear walk from a room's doorway to the foot of its stairs.
 *
 * The floor at the bottom of a flight is already reserved, but being clear is not the
 * same as being CONNECTED: the furnisher is free to line the flight's open side with
 * desks, and then the approach is a 3x2 pocket with a staircase in it. The nav sweep
 * found exactly that — a flood coming down from an attic reached 23 tiles of the
 * ground floor and stopped, because a body cannot get out of the stairwell.
 *
 * So the route itself is reserved, from the approach to a doorway, which is the same
 * thing `reserveThroughRoutes` does for a room you have to walk through and for the
 * same reason. It is also better level design than the alternative: the way to the
 * stairs is a route rather than a gap between two filing cabinets.
 */
function reserveStairRoutes(layout, mouths, stampTiles) {
  for (const plan of layout.stairs) {
    const list = mouths.get(plan.room);
    if (!list?.length) continue;
    const r = approachRect(plan);
    const alongX = plan.axis === 'x';
    // The lane starts on the ROOM side of the approach, not in the middle of it.
    // `reserveLane` widens from the point it is given in the + direction, so a point
    // inside a two-tile approach puts a third of the lane inside the stairwell — where
    // the floor is a flight of stairs, not floor. The lane then had one tile of flat
    // ground in it, which is a lane the player can walk and a body cannot.
    const band = (lo, hi) => (plan.up > 0 ? hi - LANE : lo);
    const foot = alongX
      ? [band(r.x0, r.x1), Math.floor((r.y0 + r.y1) / 2)]
      : [Math.floor((r.x0 + r.x1) / 2), band(r.y0, r.y1)];
    // Every doorway, not just the nearest: a room with two ways in should not have
    // one of them lead to a staircase you cannot reach.
    for (const m of list) reserveLane(plan.room, foot, m.at, stampTiles);
  }
}

function reserveThroughRoutes(layout, mouths, stampTiles) {
  for (const [room, list] of mouths) {
    if (list.length < 2 || !list.some((m) => m.through)) continue;
    // Every other doorway back to the first one, so the lanes of a room with
    // three doors still meet rather than forming two separate legs.
    for (let i = 1; i < list.length; i++) reserveLane(room, list[0].at, list[i].at, stampTiles);
  }
}

// An L of reserved floor between two tiles of one room: along z at `a`, then
// along x at `b`. Both legs are widened toward the room's inside, because a
// doorway sits against a wall and a lane hanging half in the plaster is 0.5 m.
function reserveLane(room, [ax, ay], [bx, by], stampTiles) {
  const wide = (v, lo, hi) => Math.max(lo, Math.min(v, hi - LANE + 1));
  const laneY = wide(ay, room.y0, room.y1 - 1);
  const laneX = wide(bx, room.x0, room.x1 - 1);

  stampTiles(Math.min(ax, bx), laneY, Math.max(ax, bx), laneY + LANE - 1);
  stampTiles(laneX, Math.min(ay, by), laneX + LANE - 1, Math.max(ay, by));
}

// --- the way out ------------------------------------------------------------

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

function buildExit(scene, layout, fixtures) {
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
