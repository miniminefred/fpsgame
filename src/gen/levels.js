// The storey at the top of a staircase, and the staircase itself.
//
// gen/stairs.js plans them — which room, which wall, how the flight runs — and
// this builds what it planned: the treads, the storey's own walls and slab and
// roof, its lights, and the crates nobody would carry back down.

import { LAMP_COLD } from '../textures.js';
import { applyWorldUVs, boxBetween, slab } from './geom.js';
import { footprintOf, tryPlace } from './props.js';
import { TILE } from './layout.js';
import {
  approachTiles,
  levelFloor,
  LOWER_Y,
  PLATE_T,
  stairBoxes,
  stripTiles,
  UPPER_CEIL,
  UPPER_Y,
} from './stairs.js';
import { LIGHT_PITCH } from './shell.js';
import { makeSink } from './sink.js';

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

export const FLOOR_SKIN = 0.03;      // flooring laid over the structural deck
// Materials by what the part IS, so the geometry half never names one.

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
export function buildStairs(layout, batcher, materials, masks, rng) {
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
export function furnishLevels(layout, batcher, materials, shared, rng) {
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
