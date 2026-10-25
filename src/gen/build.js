// Turns an abstract floorplan into everything the game needs: batched meshes,
// collision AABBs, a nav grid for the enemies, and the list of ceiling lights
// the light pool draws from.
//
// This file is the ORDER the passes run in and nothing else. Each pass lives in
// a module of its own — the shell, the doorways, the fit-out, the furnishing,
// the storeys off the ground floor — and several of them only work because of
// where they sit in this list, which is why the list is worth being able to read
// on one screen.

import { getAssets } from '../textures.js';
import { Batcher } from './geom.js';
import { isOpen, TILE } from './layout.js';
import { PLAYER_RADIUS } from '../metrics.js';
import {
  footLayer, levelLayer, levelY, rampSpec, roofCollisionCut, stairwellCut, stripTiles,
} from './stairs.js';
import {
  BadgeReaders,
  buildDoubleDoors,
  buildHallDoors,
  buildSlidingDoors,
} from './doorways.js';
import { buildExit, buildLifts } from './fitout.js';
import {
  furnishCorridors,
  furnishRooms,
  placeCow,
  placeWashers,
  reserveClearances,
} from './furnish.js';
import { buildStairs, furnishLevels } from './levels.js';
import { buildGeneratorMezzanine } from './mezzanine.js';
import {
  buildCeilingLights,
  buildDoorFrames,
  buildGeneratorLights,
  buildShell,
  buildWindows,
  floorPlate,
  generatorRoomCut,
  orMask,
} from './shell.js';
import { makeSink } from './sink.js';

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
  buildDoubleDoors(layout, scene, materials, doors, colliders, readers);
  readers.finish();
  // The two cars, after the doors because they fit doors of their own, and
  // before the furnishing for no reason at all — nothing they draw is on the
  // tile grid the furnisher works against. See gen/lifts.js.
  buildLifts(layout, batcher, materials, scene, doors, colliders, fixtures, destructibles);

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
  // A car park's corridors are its lanes, and a lane is kept clear for driving.
  if (!layout.garage) furnishCorridors(layout, sink, rng);
  // After the ordinary corridor clutter, so a machine takes a tile the clutter
  // did not want rather than the other way round: there are at most three of
  // these and a hundred of that, and the one that should lose a contested tile
  // is the one with plenty of other tiles to go to.
  placeWashers(layout, sink, rng);
  const cow = placeCow(layout, sink, rng);
  // Last, and through sinks of their own: a level off the ground floor has its own
  // occupancy and its own nav layer. See furnishLevels.
  // One occupancy mask per nav LAYER rather than one for every level, because a
  // car park stacks whole decks on the same tiles (gen/garage.js): a car parked on
  // the top deck must not block the deck under it. An ordinary floor only ever
  // uses layer 1.
  const levelBlocked = new Map();
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

  // ...and the panels themselves, kept apart from `meshes` on purpose — see
  // `doorMeshes` in the returned level.
  const doorMeshes = [];
  for (const door of doors) {
    objects.push(door.root);
    door.root.traverse((o) => { if (o.isMesh) doorMeshes.push(o); });
  }

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
    meshes,          // raycast targets for bullets, AND the decal surfaces
    // The door panels, and they are a SECOND list rather than part of `meshes`
    // because those two jobs come apart here. A bullet has to stop on a shut
    // door — it did not, and you could shoot somebody standing behind one from
    // either side, on all 332 doors of the four floors that were measured. A
    // DECAL must not be left on one: `meshes` is what `effects.setSurfaces`
    // clips a mark against, and a bullet hole on a panel that then slides into
    // its pocket is a hole hanging in the middle of the doorway. Being out of
    // `surfaces` is what already declines it — `_reach` finds no surface under
    // its probe, returns 0, and `decal` drops the mark for want of a span.
    //
    // Collected by TRAVERSING each door's root rather than by naming fields, so
    // it does not have to know that a sliding door's root is its panel, a hall
    // door's is a group of two hinged leaves and the lobby's is two parting
    // ones — and so a fourth kind is covered the day it is written. The readers
    // are not in here: they are two InstancedMeshes of their own (see
    // BadgeReaders), beside the door rather than under it.
    //
    // An OPEN door needs no special case. The panel is not moved out of the
    // way, it is moved INTO the wall beside the opening, so a shot through the
    // doorway misses it by construction.
    doorMeshes,
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
  // One layer for every attic and basement at once, as it always was — plus one per
  // stacked deck on a car park. `levelLayer` says which a plan's level is on.
  const count = Math.max(1, ...layout.stairs.map(levelLayer));
  const layers = Array.from({ length: count }, () => ({
    walk: new Uint8Array(W * H),
    sight: new Uint8Array(W * H),
    levelY: new Float32Array(W * H),
  }));
  const cross = new Int8Array(W * H).fill(-1);
  // Which flight a stairwell tile belongs to, so nav can sample that flight's height
  // continuously rather than storing one number per tile and making a body climb in
  // 33 cm jerks.
  const rampAt = new Int8Array(W * H).fill(-1);
  const ramps = [];

  // Every level's floor first, so a ramp that STANDS on a deck (a car park's upper
  // one) is laid over a floor that is already there.
  for (const plan of layout.stairs) {
    const k = levelLayer(plan);
    const layer = layers[k - 1];
    const blocked = levelBlocked.get(k);
    const room = plan.room;
    for (let ty = room.y0; ty < room.y1; ty++) {
      for (let tx = room.x0; tx < room.x1; tx++) {
        const i = ty * W + tx;
        layer.levelY[i] = levelY(plan);
        layer.sight[i] = 1;
        // The level's floor, minus whatever is standing on it.
        if (!blocked?.[i]) layer.walk[i] = 1;
      }
    }
  }

  // ...and the stairwells, which belong to both layers they join and are where they
  // join. All of it: a body has to be able to stand anywhere on a flight and walk the
  // length of it. What stops anybody stepping onto the MIDDLE of one — off the edge
  // of the landing above, or up off the floor below — is the no-cliff rule in nav.js,
  // which is also what caught the three-metre teleport that used to happen here.
  for (const plan of layout.stairs) {
    const lo = footLayer(plan);
    const ramp = ramps.push(rampSpec(layout, plan)) - 1;
    for (const i of stripTiles(plan, W)) {
      rampAt[i] = ramp;
      cross[i] = lo;
      for (const k of [lo, lo + 1]) {
        if (k === 0) continue;   // the ground's own grid comes from the floorplan
        layers[k - 1].walk[i] = 1;
        layers[k - 1].sight[i] = 1;
      }
    }
  }

  return { layers, cross, rampAt, ramps };
}

// --- shell: walls, floors, ceiling ------------------------------------------
