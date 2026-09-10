// A floor, start to finish.
//
// This file is the ORDER the passes run in, plus the two dice that decide how
// big a floor is — the carve (gen/carve.js), what each room is for
// (gen/roles.js), the badge readers (gen/locks.js), the staircases
// (gen/stairs.js) and the lift bank (gen/lifts.js). Several of those only work
// because of where they sit in this list, which is why the list is worth being
// able to read on one screen.
//
// It is also the one ADDRESS the rest of the tree has for a floorplan. The tile
// vocabulary, the lock predicates and the role branch are all re-exported below,
// because everything downstream asks gen/layout.js for a floor and should not
// have to know which of five files a constant ended up in.

import { makeRng } from './rng.js';
import { clamp } from '../util.js';
import { bfs, CORRIDOR, doorSide, ROOM, TILE, worldX, worldZ } from './tiles.js';
import {
  assignLocks,
  doorsOnRoom,
  lockedMask,
  opensOntoCorridor,
  prologueRegion,
} from './locks.js';
import { planStairs } from './stairs.js';
import { carveBank, oneWayIn } from './lifts.js';
import {
  band,
  bsp,
  complement,
  connectAll,
  CORRIDOR_W,
  cutDoor,
  cutHallDoors,
  doorCandidates,
  ensureFrontage,
  MIN_LEAF,
  OPEN_SHARE,
  PAD,
  pickLines,
  shorten,
} from './carve.js';
import { assignRoles, pickCafeteria, pickLobbyRoom } from './roles.js';

// Re-exported so the rest of the tree keeps one address for the floorplan. The
// tile vocabulary in particular is imported by gen/build.js, nav.js, enemies.js,
// cameras.js, minimap.js and both validators, and none of them cares that it now
// has a file of its own.
export {
  TILE, WALL_H, CEIL_H, DOOR_H, DOOR_CLEAR,
  SOLID, ROOM, CORRIDOR, DOOR, isOpen, FACING, NEIGHBOURS, NAV_LANE,
  worldX, worldZ, centreX, centreZ, tileX, tileY,
  bfs, slidePocketSide, slidePocketRun, doorSide, doorSpan,
  tileAt, siteWalk, wallBeside, fillRect, sealDoor,
} from './tiles.js';
// FIRST_CONTACT_GAP is re-exported rather than re-declared, and that is not
// tidiness — enemies.js imports it from here and measures the prologue guarantee
// against the same number the generator proved. See its comment in gen/locks.js
// for what happened the one time there were two of them.
export { FIRST_CONTACT_GAP, PROLOGUE_MIN, STAFF_ONLY, doorsOnRoom } from './locks.js';

// PAD, CORRIDOR_W and DOOR_W are re-exported because tools/validate-layout.mjs
// checks against them, and a validator holding its own copy of the number it is
// checking is the FIRST_CONTACT_GAP failure exactly. `roleBranch` is there for
// the same reason: the sweep reports that distribution, and its own copy of the
// ladder had already drifted.
export { PAD, CORRIDOR_W, DOOR_W } from './carve.js';
export { roleBranch } from './roles.js';

// --- how big this one is ----------------------------------------------------
// The curve in floorSpans is the TYPICAL floor for a depth; every floor then
// rolls its own size around it, so eight is not simply seven with more walking.
// Two dice, because they answer different questions: `scale` is how much
// building there is, `skew` is what shape it is — above 1 wide and shallow,
// below 1 deep and narrow. Skew multiplies one axis and divides the other, so
// changing a floor's shape does not also change how much of it there is.
//
// The point is pacing. A small floor is a tight, quick clear and a big one is a
// hike, and not knowing which you are stepping out of the lift into is worth
// more than either. The range is wide on purpose: within a few percent of the
// depth's size every floor reads as the same floor.
const SIZE_SCALE = [0.78, 1.18];

const SIZE_SKEW = [0.82, 1.2];
// Where the growth curve stops, and with it the biggest floor in the game.

// Where the growth curve stops, and with it the biggest floor in the game.
const BASE_W_MAX = 300;

const BASE_H_MAX = 252;
// Absolute bounds in tiles, on either axis — 300 on both, so the shape die is
// free to stand a floor on end. The lower one is not taste: a slab much under
// 60 m has room for the corridor spine and little else, and the prologue pass
// then starts stripping readers off doorways to find somewhere to stand the
// first body (see freeThePrologue in gen/locks.js).

// Absolute bounds in tiles, on either axis — 300 on both, so the shape die is
// free to stand a floor on end. The lower one is not taste: a slab much under
// 60 m has room for the corridor spine and little else, and the prologue pass
// then starts stripping readers off doorways to find somewhere to stand the
// first body (see freeThePrologue in gen/locks.js).
const SPAN_MIN = 120;

const SPAN_MAX = 300;
// And the area of the largest floor the curve ever asks for. The roll varies a
// floor UNDER that ceiling rather than through it: past floor ~12 the difficulty
// is meant to come from the enemies rather than from more walking, so a big roll
// on floor 15 must not quietly hand out a fifth more building than the game has
// ever had to draw, light and populate.

// And the area of the largest floor the curve ever asks for. The roll varies a
// floor UNDER that ceiling rather than through it: past floor ~12 the difficulty
// is meant to come from the enemies rather than from more walking, so a big roll
// on floor 15 must not quietly hand out a fifth more building than the game has
// ever had to draw, light and populate.
const AREA_MAX = BASE_W_MAX * BASE_H_MAX;

/**
 * The slab, in tiles, plus how that came out relative to this depth's usual.
 *
 * `areaRatio` is the part callers want and the reason it is returned rather than
 * recomputed: how many people and how many cameras a floor gets is a question
 * about DENSITY, and both are authored against the typical floor for a depth.
 * 200 staff is a crowd on that floor and a crush on one two-thirds the size.
 * It is measured from the spans that survived the clamps rather than from
 * `scale`, so a floor that hit a bound still reports the area it actually has.
 *
 * On its own stream, and mixed with the floor number, for the same two reasons
 * the locks are (see assignLocks below). Drawing from the floor's own `rng` would
 * shift every later number and re-roll the whole building off a die that has
 * nothing to do with its contents; and a stream of the seed alone would hand
 * every floor of one seed the same shape, which is exactly the variety the
 * validators sweep for.
 */

/**
 * The slab, in tiles, plus how that came out relative to this depth's usual.
 *
 * `areaRatio` is the part callers want and the reason it is returned rather than
 * recomputed: how many people and how many cameras a floor gets is a question
 * about DENSITY, and both are authored against the typical floor for a depth.
 * 200 staff is a crowd on that floor and a crush on one two-thirds the size.
 * It is measured from the spans that survived the clamps rather than from
 * `scale`, so a floor that hit a bound still reports the area it actually has.
 *
 * On its own stream, and mixed with the floor number, for the same two reasons
 * the locks are (see assignLocks below). Drawing from the floor's own `rng` would
 * shift every later number and re-roll the whole building off a die that has
 * nothing to do with its contents; and a stream of the seed alone would hand
 * every floor of one seed the same shape, which is exactly the variety the
 * validators sweep for.
 */
function floorSpans(seed, floorNumber) {
  const rng = makeRng((seed ^ 0x1b56c4e9) + Math.imul(floorNumber, 0x9e3779b1));

  // Floors grow as you descend, but not without bound — past floor ~12 the
  // difficulty comes from the enemies, not from more walking.
  const baseW = Math.min(BASE_W_MAX, 176 + floorNumber * 10);
  const baseH = Math.min(BASE_H_MAX, 144 + floorNumber * 10);

  const scale = rng.range(SIZE_SCALE[0], SIZE_SCALE[1]);
  const skew = rng.range(SIZE_SKEW[0], SIZE_SKEW[1]);
  let W = clamp(Math.round(baseW * scale * skew), SPAN_MIN, SPAN_MAX);
  let H = clamp(Math.round(baseH * scale / skew), SPAN_MIN, SPAN_MAX);

  // Back under the ceiling on both axes at once, so a floor that overshot comes
  // back the shape it rolled rather than squared off against whichever bound it
  // happened to hit first.
  if (W * H > AREA_MAX) {
    const back = Math.sqrt(AREA_MAX / (W * H));
    W = clamp(Math.floor(W * back), SPAN_MIN, SPAN_MAX);
    H = clamp(Math.floor(H * back), SPAN_MIN, SPAN_MAX);
  }

  return { W, H, areaRatio: (W * H) / (baseW * baseH) };
}

export function generateLayout(seed, floorNumber) {
  const rng = makeRng(seed);

  const { W, H, areaRatio } = floorSpans(seed, floorNumber);

  const tiles = new Uint8Array(W * H); // SOLID everywhere to start
  const at = (x, y) => tiles[y * W + x];
  const set = (x, y, v) => { tiles[y * W + x] = v; };

  const inner = { x0: PAD, y0: PAD, x1: W - PAD, y1: H - PAD };

  // --- 1. corridor spine ----------------------------------------------------
  // Corridor count scales with the slab. A single cross on a big floor leaves
  // four huge blocks, and BSP then buries the middle of each block behind
  // three or four other rooms — you end up walking through somebody's office
  // to reach somebody else's office. More spine keeps every room within a
  // room or two of a corridor.
  const vWanted = clamp(Math.round(W / 32), 3, 7);
  const hWanted = clamp(Math.round(H / 32), 2, 5);
  const vLines = pickLines(rng, inner.x0 + MIN_LEAF + 2, inner.x1 - MIN_LEAF - 2, vWanted, CORRIDOR_W + 15);
  const hLines = pickLines(rng, inner.y0 + MIN_LEAF + 2, inner.y1 - MIN_LEAF - 2, hWanted, CORRIDOR_W + 15);
  // Both axes must exist or the corridors never cross and the floor splits.
  if (!vLines.length) vLines.push(Math.floor((inner.x0 + inner.x1) / 2));
  if (!hLines.length) hLines.push(Math.floor((inner.y0 + inner.y1) / 2));

  const vBands = vLines.map((cx) => band(cx, inner.x0, inner.x1, inner.y0, inner.y1));
  const hBands = hLines.map((cy) => band(cy, inner.y0, inner.y1, inner.x0, inner.x1));

  // The first corridor on each axis runs the full slab, and those two crossing
  // is what makes the network connected by construction. Every other corridor is
  // cut short at one or both ends, so a floor reads as a building with a core
  // and some wings rather than a grid stamped edge to edge. Shortening is only
  // ever allowed to stop a corridor *outside* the primary cross, so the spine
  // stays intact no matter how the dice fall — and connectAll still proves it.
  for (let i = 1; i < vBands.length; i++) shorten(rng, vBands[i], inner.y0, inner.y1, hBands[0]);
  for (let i = 1; i < hBands.length; i++) shorten(rng, hBands[i], inner.x0, inner.x1, vBands[0]);
  ensureFrontage(vBands, hBands, inner);

  for (const b of vBands) {
    for (let x = b.lo; x < b.hi; x++) for (let y = b.from; y < b.to; y++) set(x, y, CORRIDOR);
  }
  for (const b of hBands) {
    for (let y = b.lo; y < b.hi; y++) for (let x = b.from; x < b.to; x++) set(x, y, CORRIDOR);
  }

  // --- 2. rooms in the leftover blocks --------------------------------------
  const xSpans = complement(inner.x0, inner.x1, vBands);
  const ySpans = complement(inner.y0, inner.y1, hBands);

  const rooms = [];
  // Every block the BSP is about to be handed, so the open-plan share can be
  // measured against the area there actually is to give away. Collected first
  // rather than accumulated as we go, because a budget spent against a running
  // total is a budget the first block gets all of.
  const blocks = [];
  for (const xs of xSpans) {
    for (const ys of ySpans) {
      // Too thin to hold a room — leave it solid as a structural core.
      if (xs.hi - xs.lo < MIN_LEAF + 1 || ys.hi - ys.lo < MIN_LEAF + 1) continue;
      // Reserve the block's max edges as wall so rooms carved inset-on-min
      // still end up separated from the corridor beyond.
      blocks.push({ x0: xs.lo, y0: ys.lo, x1: xs.hi - 1, y1: ys.hi - 1 });
    }
  }
  const open = {
    left: OPEN_SHARE * blocks.reduce(
      (a, b) => a + (b.x1 - b.x0) * (b.y1 - b.y0), 0),
  };

  for (const block of blocks) {
    const leaves = [];
    bsp(block, rng, leaves, open);

    for (const leaf of leaves) {
      const room = {
        id: rooms.length,
        leaf,
        // Whether the BSP handed this one over whole as an open floor, which is
        // what makes it an open plan office rather than a room that merely came
        // out large. See OPEN_SHARE and assignRoles.
        open: !!leaf.open,
        x0: leaf.x0 + 1, y0: leaf.y0 + 1, x1: leaf.x1, y1: leaf.y1, // interior, max exclusive
        doors: [],
      };
      if (room.x1 - room.x0 < 4 || room.y1 - room.y0 < 4) continue;
      for (let y = room.y0; y < room.y1; y++) {
        for (let x = room.x0; x < room.x1; x++) set(x, y, ROOM);
      }
      rooms.push(room);
    }
  }

  // --- 3. doors -------------------------------------------------------------
  const doors = [];
  for (const room of rooms) {
    const sides = doorCandidates(room, tiles, W, H);
    // A door onto a corridor is always preferred; rooms that only touch other
    // rooms get an interconnecting door instead.
    const corridorSides = sides.filter((s) => s.kind === CORRIDOR);
    const chosen = corridorSides.length ? corridorSides : sides;
    if (!chosen.length) continue;

    rng.shuffle(chosen);
    const wanted = 1 + (rng.chance(0.35) && chosen.length > 1 ? 1 : 0);
    for (let i = 0; i < Math.min(wanted, chosen.length); i++) {
      cutDoor(chosen[i], rng, tiles, W, doors, room);
    }
  }

  // --- 4. connectivity ------------------------------------------------------
  connectAll(tiles, W, H, rooms, doors, vBands[0], hBands[0], rng);

  // --- 4b. doors across the corridors ---------------------------------------
  // After connectivity, not before: these are cut against the finished floor, so
  // they can see every room doorway that was going to be cut and keep clear of
  // it. They can never affect connectivity themselves — a doorway is open floor
  // and none of them is ever locked.
  cutHallDoors(tiles, W, H, doors, vBands, true, rng);
  cutHallDoors(tiles, W, H, doors, hBands, false, rng);

  // --- 5. roles, spawn and exit --------------------------------------------
  const live = rooms.filter((r) => r.doors.length > 0);
  for (const r of live) {
    r.wTiles = r.x1 - r.x0;
    r.hTiles = r.y1 - r.y0;
    r.areaM2 = r.wTiles * r.hTiles * TILE * TILE;
    r.cx = (r.x0 + r.x1) / 2;
    r.cy = (r.y0 + r.y1) / 2;
  }

  // Where the floor puts you down, and where it lets you off: the lift lobby,
  // and it is ONE room. The floor arrives the way a person arrives at an office
  // — out of a car, into the lobby in front of it, and through the doors into
  // the building — and it leaves by the car standing next to the one that
  // brought you. See pickLobbyRoom.
  //
  // `spawnRoom` and `exitRoom` are therefore the same object, and they are kept
  // as two names on purpose rather than collapsed into one: half a dozen callers
  // ask one of those two questions (assignLocks, planStairs, placeCow, the props
  // sweep) and each of them means the one it says. A floor that ever wanted them
  // apart again would change this line and nothing else.
  //
  // The canteen is picked in the same breath and is a different room. It used to
  // BE the spawn, which is where the lunch cycle's counter, tables and diners
  // all live, so the two are separated by name rather than by accident:
  // `cafeteriaRoom` is where lunch happens and `spawnRoom` is where you come in,
  // and enemies.js reads whichever of the two it actually means.
  const cafeteria = pickCafeteria(live, tiles, W, doors);
  const spawnRoom = pickLobbyRoom(live, tiles, W, H, doors, cafeteria);
  const exitRoom = spawnRoom;
  const dist = bfs(tiles, W, H, Math.round(spawnRoom.cx), Math.round(spawnRoom.cy));

  // The lobby's own doorways are never badged and are fitted as a pair of doors
  // rather than a single sliding panel. Both are facts about the lobby rather
  // than about a lock or a builder, so both are stated here, once, before
  // anything reads `doors` again.
  //
  // `free` is the flag freeThePrologue uses for the same purpose one pass later,
  // and marking these up front is cheaper and far more certain than letting that
  // pass discover it: a reader on the way out of the lobby is the one lock in
  // the building that can shut the player in with nothing in their pocket, and
  // it is not a hypothetical — on about one floor in seven the lobby's only
  // doorway was shared with a neighbouring room and that room's white pass
  // badged it. Every consumer already honours the flag: `assignLocks` will not
  // give a lock to any room sharing one, and the prologue flood walks through it.
  //
  // `doorsOnRoom` rather than `spawnRoom.doors`, and for that same reason — a
  // room's own list holds only the doors IT cut, and the one that matters may
  // have been cut by the room next door into a wall they share.
  //
  // ...and there is only ONE of them, as wide as a corridor. `oneWayIn` seals
  // the rest and opens the survivor out: a lobby is the core of the floor and
  // everything comes through it, so what it wants is a front door rather than
  // the three or four ordinary 1.5 m holes the carve gives every room. Both
  // halves of that are allowed to fail — see the note on it in gen/lifts.js.
  const way = oneWayIn({ tiles, W, H, rooms: live }, doors, spawnRoom);
  for (const d of doorsOnRoom(doors, spawnRoom)) {
    d.free = true;
    d.double = true;
  }
  void way;

  // The canteen only survives as one if the lobby did not take it. `pickLobbyRoom`
  // prefers to leave it alone but falls back rather than fail, and a canteen that
  // is also the lobby is a canteen the lunch cycle would walk the whole floor to
  // eat in with the player standing in it.
  const cafeteriaRoom = (cafeteria && cafeteria !== spawnRoom) ? cafeteria : null;

  assignRoles(live, spawnRoom, exitRoom, cafeteriaRoom, doors, rng);
  // On its own stream, not the floor's. Everything downstream of here — the
  // furniture in every room on the floor — draws from `rng`, so spending a
  // variable number of numbers on picking locks would re-roll the contents of a
  // building that has nothing to do with them. It showed up immediately as a
  // mailroom, three hundred metres from the nearest badge reader, furnishing
  // itself shut.
  const locks = assignLocks(tiles, W, H, live, doors, spawnRoom, exitRoom, dist,
    makeRng(seed ^ 0x5bf03635));
  // Its own stream for the same reason, and the reason bites harder here: how
  // many stairs a floor gets is itself a die, and how many candidate rooms and
  // walls were tried before one fitted is several more. Left on the floor's
  // stream, a floor with a staircase would furnish every OTHER room differently
  // from the same floor without one.
  const stairs = planStairs(tiles, W, H, live, spawnRoom, exitRoom,
    makeRng(seed ^ 0x7f4a7c15));

  const layout = {
    seed, floorNumber, W, H, TILE,
    // How much floor this is compared with the usual one at this depth. Read by
    // whoever has to spread a fixed number of things over it — see floorSpans.
    areaRatio,
    ox: -W * TILE / 2, oz: -H * TILE / 2,
    tiles, rooms: live, doors,
    spawnRoom, exitRoom,
    // The room the lunch cycle is about, or null on the ~4% of floors with no
    // room big enough to hold a canteen. NOT the spawn room, which it used to
    // be — see the pick above.
    cafeteriaRoom,
    locks,
    // The 0-2 rooms with a flight of stairs in them, and where in the room it
    // runs. Authored here rather than in the builder so the layout sweep sees it.
    stairs,
    // Every tile behind a badge reader, so the things that scatter themselves
    // over a floor — enemies, vermin — can keep out of rooms they would be
    // locked into. See enemies.js.
    locked: lockedMask(W, H, locks),
    rng,
  };

  // The two lift cars, cut in last — see the header of gen/lifts.js for why the
  // ordering is the whole of their safety. Either may come back null, and a null
  // one is an ordinary answer: the arrival falls back to standing in the middle
  // of the room and the way down to the lit pad it has always been.
  layout.lifts = carveLifts(layout, doors);

  // Which wall the bank took, recorded on the room because the FURNISHER needs
  // it and gets nothing else about the lifts: `liftLobby` in gen/rooms.js keeps
  // the reception counter off that wall, and a desk with its back to the only
  // thing in the room is exactly what it is avoiding. A side number rather than
  // the car itself, so nothing downstream can start reasoning about tiles it has
  // not been handed.
  spawnRoom.liftSide = layout.lifts.arrival?.side ?? null;

  // Every tile they can reach on arrival with nothing in their pocket, which is
  // a different question now that the corridors have readers on them too: it is
  // where the FIRST white card has to be standing. See _cardOutside in
  // enemies.js and hallLocks in gen/locks.js.
  //
  // After the carve rather than before it, and flooded from the CAR when there
  // is one. A region listing tiles that have since become the wall of a lift
  // shaft is a region with somewhere to stand that nobody can stand in.
  const from = tileOf(layout, layout.lifts.arrival, spawnRoom);
  layout.prologue = prologueRegion(tiles, W, H, from.x, from.y, doors);

  layout.spawn = layout.lifts.arrival
    ? { x: layout.lifts.arrival.x, z: layout.lifts.arrival.z }
    : { x: worldX(layout, spawnRoom.cx), z: worldZ(layout, spawnRoom.cy) };
  layout.exit = layout.lifts.departure
    ? { x: layout.lifts.departure.x, z: layout.lifts.departure.z }
    : { x: worldX(layout, exitRoom.cx), z: worldZ(layout, exitRoom.cy) };

  return layout;
}

// The tile a lift puts you down on, or the middle of the room when it has none.

// The tile a lift puts you down on, or the middle of the room when it has none.
const tileOf = (layout, lift, room) => (lift
  ? { x: (lift.tx0 + lift.tx1 - 1) >> 1, y: (lift.ty0 + lift.ty1 - 1) >> 1 }
  : { x: Math.round(room.cx), y: Math.round(room.cy) });

/**
 * Cuts both cars into the lobby, side by side.
 *
 * The bank goes on the wall OPPOSITE the lobby's own doorway when that wall will
 * take it, which is what makes the arrival read as a sequence rather than as a
 * room: the doors part, the lobby is in front of you, and the way into the
 * building is across it and straight ahead. `carveBank` walks the other three
 * walls itself when it has to.
 *
 * The connectivity proof inside `carveLift` is run from a CORRIDOR tile, which
 * has to be outside the room being cut into — the corridor network is connected
 * by construction and every live room opens onto it, so one tile of it is a
 * fixed point the whole floor can be measured from before and after.
 */

/**
 * Cuts both cars into the lobby, side by side.
 *
 * The bank goes on the wall OPPOSITE the lobby's own doorway when that wall will
 * take it, which is what makes the arrival read as a sequence rather than as a
 * room: the doors part, the lobby is in front of you, and the way into the
 * building is across it and straight ahead. `carveBank` walks the other three
 * walls itself when it has to.
 *
 * The connectivity proof inside `carveLift` is run from a CORRIDOR tile, which
 * has to be outside the room being cut into — the corridor network is connected
 * by construction and every live room opens onto it, so one tile of it is a
 * fixed point the whole floor can be measured from before and after.
 */
function carveLifts(layout, doors) {
  const { tiles, W, H, spawnRoom } = layout;
  let seed = null;
  for (let i = 0; i < W * H && !seed; i++) {
    if (tiles[i] === CORRIDOR) seed = { x: i % W, y: (i / W) | 0 };
  }
  if (!seed) return { arrival: null, departure: null };

  // The doorway the player actually leaves by, which is the one onto a corridor
  // where the room has one. `doorsOnRoom` rather than `room.doors`, for the
  // reason generatorRoom gives: a room's own list holds only the doors IT cut,
  // and the one that matters may have been cut by the room next door into a wall
  // they share.
  const onRoom = doorsOnRoom(doors, spawnRoom);
  const out = onRoom.find((d) => opensOntoCorridor(d, W, tiles)) ?? onRoom[0];
  const wall = out ? (doorSide(out, spawnRoom) + 2) & 3 : 0;

  return carveBank(layout, spawnRoom, doors, wall, seed);
}

// --- generation internals ---------------------------------------------------

// `count` positions inside [min,max] that are at least `sep` apart.
