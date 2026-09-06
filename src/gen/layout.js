import { makeRng } from './rng.js';
import { clamp } from '../util.js';
import {
  TILE, SOLID, ROOM, CORRIDOR, DOOR, isOpen, bfs, worldX, worldZ, doorSide,
} from './tiles.js';
import {
  assignLocks, lockedMask, prologueRegion, doorsOnRoom, opensOntoCorridor,
} from './locks.js';
import { planStairs } from './stairs.js';
import { carveBank, fitsLifts } from './lifts.js';

// Procedural office floorplan.
//
// Real office floors aren't mazes — they're a corridor spine with rooms packed
// against it. So we generate in that order: carve 1-2 horizontal and 1-3
// vertical corridors across the slab (guaranteed to intersect, so the corridor
// network is connected by construction), then subdivide each leftover block
// into rooms with BSP and cut a door from each room onto whatever it touches.
//
// Everything is done on a tile grid of TILE-metre cells. Walls are exactly one
// tile thick, which is why rooms are carved inset by one tile on their min
// sides only — two neighbouring rooms then share a single wall tile instead of
// stacking two.
//
// This file is the CARVING half of generation, and it is deliberately only that.
// The vocabulary the floorplan is written in lives in gen/tiles.js, and the badge
// readers — which are proofs about a finished floor rather than dice rolled over
// it — live in gen/locks.js. Both are re-exported below, because everything
// downstream asks gen/layout.js for a floor and should not have to know which of
// three files a constant ended up in.

// Re-exported so the rest of the tree keeps one address for the floorplan. The
// tile vocabulary in particular is imported by gen/build.js, nav.js, enemies.js,
// cameras.js, minimap.js and both validators, and none of them cares that it now
// has a file of its own.
export {
  TILE, WALL_H, CEIL_H, DOOR_H, DOOR_CLEAR,
  SOLID, ROOM, CORRIDOR, DOOR, isOpen, FACING,
  worldX, worldZ, centreX, centreZ, tileX, tileY,
  bfs, slidePocketSide, slidePocketRun, doorSide,
} from './tiles.js';
// FIRST_CONTACT_GAP is re-exported rather than re-declared, and that is not
// tidiness — enemies.js imports it from here and measures the prologue guarantee
// against the same number the generator proved. See its comment in gen/locks.js
// for what happened the one time there were two of them.
export { FIRST_CONTACT_GAP, PROLOGUE_MIN, STAFF_ONLY, doorsOnRoom } from './locks.js';

// PAD, CORRIDOR_W and DOOR_W are exported because tools/validate-layout.mjs
// checks against them, and a validator holding its own copy of the number it is
// checking is the FIRST_CONTACT_GAP failure exactly: the sweep stops testing the
// generator and starts asserting its own arithmetic back at it.
export const PAD = 2;              // solid tiles of exterior wall on each side
export const CORRIDOR_W = 6;       // 3 m corridors
const MIN_LEAF = 10;               // smallest room block (=> 4.5 m interior)
const MAX_LEAF = 26;               // above this a block always splits again

/**
 * How much of a floor's room area is OPEN FLOOR, and how big one of them gets.
 *
 * An office building is mostly open plan with the cellular offices round the
 * edge of it, and this generator was the other way round: `MAX_LEAF` caps a BSP
 * leaf at 26 tiles a side, so the biggest room a floor could ever have was
 * 13 x 13 m, the median room was 37 m², and 2.5% of rooms came out on the `big`
 * branch at all. Every floor was a warren of small rooms with the occasional
 * slightly larger small room, and "open plan" was a label on a 9 x 8 m office.
 *
 * So a share of each floor's room area is claimed for open floor BEFORE the
 * subdivision reaches it, and a block that qualifies stops splitting whole.
 * Measured against the area the BSP has to hand out rather than against the
 * slab, because corridors and structural core are not somebody's office.
 *
 * The cap is what keeps it an office rather than a warehouse: a block between
 * two corridors can be sixty tiles across on a deep floor, and a 30 x 30 m room
 * with no interior wall in it is a distribution centre. It is a good deal wider
 * than MAX_LEAF even so — the whole point is that the biggest thing on the floor
 * is somewhere people work rather than somewhere they store things.
 */
const OPEN_SHARE = 0.4;
const OPEN_LEAF = 44;              // tiles a side — 22 m
const OPEN_MIN = 20;               // ...and 10 m, under which it is just a room
// How often a qualifying block is taken rather than split again. It is what
// SPREADS the open floors: the budget alone would hand the first blocks the BSP
// walks the whole share, and the blocks are walked in a fixed order across the
// slab, so every open floor on the floor would be in one corner of it.
const OPEN_TAKE = 0.8;
export const DOOR_W = 3;           // 1.5 m doorways
// Minimum solid wall left between two openings. Without this, two rooms either
// side of a shared wall each cut their own doorway and the second lands flush
// against the first, merging them into one 3 m hole with a loose doorpost
// floating in the middle of it.
const DOOR_GAP = 2;

// Doors across the corridors themselves — see cutHallDoors. A range per corridor
// rather than a count per floor, because what they are for is breaking up the
// long ones; the short spurs can go without.
const HALL_DOORS = [0, 2];
const HALL_END = 10;               // tiles clear of where a corridor stops
const HALL_APART = 26;             // tiles between two doors on the same corridor

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
const BASE_W_MAX = 300;
const BASE_H_MAX = 252;
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
  for (const d of doorsOnRoom(doors, spawnRoom)) {
    d.free = true;
    d.double = true;
  }

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
function pickLines(rng, min, max, count, sep) {
  const lines = [];
  if (max <= min) return lines;
  for (let tries = 0; tries < 60 && lines.length < count; tries++) {
    const v = rng.int(min, max);
    if (lines.every((l) => Math.abs(l - v) >= sep)) lines.push(v);
  }
  return lines.sort((a, b) => a - b);
}

/**
 * Pulls corridors back over any room block that shortening left stranded.
 *
 * Rooms are carved into the blocks between corridors, and every room needs a way
 * out. That works because a block always fronts onto a corridor — until a
 * shortened corridor stops before reaching it, and a block can end up ringed by
 * four solid stretches. BSP then buries its rooms behind each other with no exit
 * at all, and the connectivity repair downstream can only respond by walling the
 * whole block off, which quietly deletes a quarter of the floor.
 *
 * So the frontage is restored here, while corridors are still just numbers and
 * before anything is carved: any unserved block extends one of its neighbours
 * back over itself. Cheaper and far more predictable than discovering the
 * problem later as a hole in the map.
 */
function ensureFrontage(vBands, hBands, inner) {
  const xSpans = complement(inner.x0, inner.x1, vBands);
  const ySpans = complement(inner.y0, inner.y1, hBands);
  const enough = DOOR_W + 2;   // a frontage too short to hold a doorway is none

  for (const xs of xSpans) {
    if (xs.hi - xs.lo < MIN_LEAF + 1) continue;   // too thin to become rooms
    for (const ys of ySpans) {
      if (ys.hi - ys.lo < MIN_LEAF + 1) continue;

      const vAdj = vBands.filter((b) => b.hi === xs.lo || b.lo === xs.hi);
      const hAdj = hBands.filter((b) => b.hi === ys.lo || b.lo === ys.hi);
      const served =
        vAdj.some((b) => overlap(b.from, b.to, ys.lo, ys.hi) >= enough) ||
        hAdj.some((b) => overlap(b.from, b.to, xs.lo, xs.hi) >= enough);
      if (served) continue;

      // Prefer extending a vertical neighbour; either restores frontage.
      const band = vAdj[0] ?? hAdj[0];
      if (!band) continue;
      const span = vAdj.length ? ys : xs;
      band.from = Math.min(band.from, span.lo);
      band.to = Math.max(band.to, span.hi);
    }
  }
}

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

// Stops a corridor short of one or both exterior walls. `must` is the primary
// corridor on the other axis, and the run has to keep covering it with a decent
// stub either side — a corridor that ended exactly at the junction would read as
// a T rather than as a corridor that carries on a bit and then stops.
function shorten(rng, b, lo, hi, must) {
  const stub = CORRIDOR_W * 2;
  const latestStart = Math.max(lo, must.lo - stub);
  const earliestEnd = Math.min(hi, must.hi + stub);
  if (rng.chance(0.6)) b.from = rng.int(lo, latestStart);
  if (rng.chance(0.6)) b.to = rng.int(earliestEnd, hi);
}

// A corridor: `lo..hi` is its width across the slab, `from..to` how far it runs
// along it. Only `from..to` is ever shortened — the width and therefore the room
// blocks either side of it stay exactly as they were, so a stopped corridor
// leaves solid structural core behind it rather than a hole in the blocking.
function band(center, lo, hi, from, to) {
  return {
    from, to,
    lo: Math.max(lo, center - Math.floor(CORRIDOR_W / 2)),
    hi: Math.min(hi, center + Math.ceil(CORRIDOR_W / 2)),
  };
}

// The gaps left between a set of bands inside [lo,hi).
function complement(lo, hi, bands) {
  const spans = [];
  let cursor = lo;
  for (const b of [...bands].sort((a, c) => a.lo - c.lo)) {
    if (b.lo > cursor) spans.push({ lo: cursor, hi: b.lo });
    cursor = Math.max(cursor, b.hi);
  }
  if (cursor < hi) spans.push({ lo: cursor, hi });
  return spans;
}

/**
 * Subdivides one block into rooms.
 *
 * `open` is the floor's open-plan budget — `{ left }` in tiles, shared by every
 * block on the floor and spent as blocks are claimed. See OPEN_SHARE.
 */
function bsp(rect, rng, out, open) {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const canX = w >= MIN_LEAF * 2;
  const canY = h >= MIN_LEAF * 2;

  if (!canX && !canY) { out.push(rect); return; }

  // An OPEN FLOOR: taken whole, and taken here rather than further down.
  //
  // The order is the whole of it. Offered a rect that has already been halved
  // twice, the budget spends itself on rooms that are merely large — and what
  // makes an open plan office read as one is that it is the biggest thing on the
  // floor, with the cellular offices around it rather than beside it. So the
  // first rect on each path that is inside the cap is the one that gets asked,
  // and anything wider than the cap goes on splitting until it fits.
  if (open.left > 0
    && w <= OPEN_LEAF && h <= OPEN_LEAF
    && w >= OPEN_MIN && h >= OPEN_MIN
    && rng.chance(OPEN_TAKE)) {
    open.left -= w * h;
    rect.open = true;
    out.push(rect);
    return;
  }

  // Stop early now and then, which is what a floor's merely-large rooms are.
  if (w <= MAX_LEAF && h <= MAX_LEAF && rng.chance(0.22)) { out.push(rect); return; }

  let splitX;
  if (canX && canY) splitX = w > h ? rng.chance(0.82) : rng.chance(0.18);
  else splitX = canX;

  if (splitX) {
    const cut = rng.int(rect.x0 + MIN_LEAF, rect.x1 - MIN_LEAF);
    bsp({ x0: rect.x0, y0: rect.y0, x1: cut, y1: rect.y1 }, rng, out, open);
    bsp({ x0: cut, y0: rect.y0, x1: rect.x1, y1: rect.y1 }, rng, out, open);
  } else {
    const cut = rng.int(rect.y0 + MIN_LEAF, rect.y1 - MIN_LEAF);
    bsp({ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: cut }, rng, out, open);
    bsp({ x0: rect.x0, y0: cut, x1: rect.x1, y1: rect.y1 }, rng, out, open);
  }
}

// Runs of wall along each side of a room that have open floor on the far side.
function doorCandidates(room, tiles, W, H) {
  const { leaf } = room;
  const out = [];

  const tileAt = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : SOLID);

  // Is there already an opening within DOOR_GAP tiles along this wall line?
  // Rooms are doored one at a time, so this is what stops the next room's
  // doorway from landing flush against one already cut from the other side.
  const doorNear = (axis, line, i) => {
    for (let k = -DOOR_GAP; k <= DOOR_GAP; k++) {
      if ((axis === 'v' ? tileAt(line, i + k) : tileAt(i + k, line)) === DOOR) return true;
    }
    return false;
  };

  // Walks one side of the room collecting maximal runs of wall that have the
  // same kind of open floor on the far side; runs at least a doorway wide are
  // door candidates.
  const scan = (axis, wallLine, outsideLine, from, to) => {
    let run = null;
    const flush = () => {
      if (run && run.to - run.from >= DOOR_W) out.push(run);
      run = null;
    };

    for (let i = from; i < to; i++) {
      const ox = axis === 'v' ? outsideLine : i;
      const oy = axis === 'v' ? i : outsideLine;
      const wx = axis === 'v' ? wallLine : i;
      const wy = axis === 'v' ? i : wallLine;

      const kind = tileAt(ox, oy);
      // The wall tile itself must still be wall — a corridor may have eaten it.
      const usable = (kind === CORRIDOR || kind === ROOM)
        && tiles[wy * W + wx] === SOLID
        && !doorNear(axis, wallLine, i);

      if (usable && run && run.kind === kind) {
        run.to = i + 1;
      } else {
        flush();
        if (usable) run = { axis, wallLine, outsideLine, kind, from: i, to: i + 1 };
      }
    }
    flush();
  };

  // Skip the first and last tile of each side so doors never land in a corner.
  scan('v', leaf.x0, leaf.x0 - 1, room.y0 + 1, room.y1 - 1);
  scan('v', leaf.x1, leaf.x1 + 1, room.y0 + 1, room.y1 - 1);
  scan('h', leaf.y0, leaf.y0 - 1, room.x0 + 1, room.x1 - 1);
  scan('h', leaf.y1, leaf.y1 + 1, room.x0 + 1, room.x1 - 1);

  return out;
}

function cutDoor(run, rng, tiles, W, doors, room) {
  const span = run.to - run.from;
  const start = run.from + (span > DOOR_W ? rng.int(0, span - DOOR_W) : 0);
  const end = Math.min(run.to, start + DOOR_W);

  for (let i = start; i < end; i++) {
    if (run.axis === 'v') tiles[i * W + run.wallLine] = DOOR;
    else tiles[run.wallLine * W + i] = DOOR;
  }

  const door = run.axis === 'v'
    ? { x0: run.wallLine, x1: run.wallLine + 1, y0: start, y1: end, vertical: true }
    : { x0: start, x1: end, y0: run.wallLine, y1: run.wallLine + 1, vertical: false };

  doors.push(door);
  room.doors.push(door);
}

/**
 * The doors across the corridors — the ones you walk through rather than into.
 *
 * A floor without them is one continuous open hallway network, which is the one
 * place in the building that reads as a level rather than as an office: real
 * corridors are broken up by fire doors every so often, and having to push
 * through one is what makes a corridor feel like it has a far end.
 *
 * They are the odd ones out in two ways, and both fall out of there being no
 * wall across a corridor to cut a hole in:
 *
 *  - They span the corridor's ENTIRE width, so the opening is a 3 m one rather
 *    than the 1.5 m every room doorway gets. `hall` says so, since the width
 *    invariant is different for them.
 *  - They cannot slide. A retracted panel goes inside the wall beside its
 *    opening (see slidePocketSide) and beside a corridor there is one tile of
 *    wall with somebody's office behind it. So these are two hinged leaves that
 *    swing back flat against the corridor walls, which is what the doors they
 *    are modelled on do anyway.
 *
 * That second point is the whole of the placement rule. A leaf needs the wall it
 * swings back against to actually be there for its own length, which is what
 * `swing` picks a direction for and what the flank sweep below proves. It also
 * does three other jobs for free: it puts the door somewhere the frame has a
 * jamb at both ends, it keeps a leaf from swinging across a room's doorway and
 * sealing it, and it refuses junctions outright, because at a crossing the
 * flanking wall is the other corridor.
 *
 * None of them is ever locked by the room passes. They are not on any room, so
 * the LOCK_PLAN loop in gen/locks.js never sees them; what badges them is
 * hallLocks, which proves a way round before it dares, because a badged door
 * across the one route everybody takes would be a floor locked in half.
 */
function cutHallDoors(tiles, W, H, doors, bands, alongY, rng) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : SOLID);
  // `p` walks along the corridor; `k` walks across it. A vertical corridor runs
  // along y, so its cross-section is a row and its flanks are columns — and the
  // other way round for a horizontal one. That is the only difference between
  // the two axes, so it is the only thing this pair of helpers hides.
  const cross = (b, p, k) => (alongY ? at(b.lo + k, p) : at(p, b.lo + k));
  const flank = (b, p, side) =>
    (alongY ? at(side < 0 ? b.lo - 1 : b.hi, p) : at(p, side < 0 ? b.lo - 1 : b.hi));

  for (const b of bands) {
    const width = b.hi - b.lo;
    const leaf = Math.ceil(width / 2);
    // Too short to hold one anywhere that is not its own mouth.
    if (b.to - b.from < HALL_END * 2 + 2) continue;

    const placed = [];
    for (let n = rng.int(HALL_DOORS[0], HALL_DOORS[1]); n > 0; n--) {
      for (let tries = 0; tries < 40; tries++) {
        const p = rng.int(b.from + HALL_END, b.to - HALL_END - 1);
        if (placed.some((q) => Math.abs(q - p) < HALL_APART)) continue;

        // Clear across, and clear on both flanks for a leaf's length the way the
        // leaves fold. One tile the other way as well, so the frame never lands
        // flush against a doorway cut in the corridor wall opposite.
        const swing = rng.chance(0.5) ? 1 : -1;
        let ok = true;
        for (let k = 0; k < width && ok; k++) if (cross(b, p, k) !== CORRIDOR) ok = false;
        const lo = swing > 0 ? p - 1 : p - leaf;
        const hi = swing > 0 ? p + leaf : p + 1;
        for (let q = lo; q <= hi && ok; q++) {
          if (flank(b, q, -1) !== SOLID || flank(b, q, 1) !== SOLID) ok = false;
        }
        if (!ok) continue;

        for (let k = 0; k < width; k++) {
          if (alongY) tiles[p * W + (b.lo + k)] = DOOR;
          else tiles[(b.lo + k) * W + p] = DOOR;
        }
        doors.push(alongY
          ? { x0: b.lo, x1: b.hi, y0: p, y1: p + 1, vertical: false, hall: true, swing }
          : { x0: p, x1: p + 1, y0: b.lo, y1: b.hi, vertical: true, hall: true, swing });
        placed.push(p);
        break;
      }
    }
  }
}

// Flood the floor from the corridor network; any room left stranded gets an
// extra door punched toward reachable floor, and anything still stranded after
// a few passes is filled back in so the player can never see an orphan room.
function connectAll(tiles, W, H, rooms, doors, vBand, hBand, rng) {
  const seedX = vBand ? vBand.lo : PAD + 1;
  const seedY = hBand ? hBand.lo : PAD + 1;

  for (let pass = 0; pass < 5; pass++) {
    const dist = bfs(tiles, W, H, seedX, seedY);
    const stranded = rooms.filter((r) => dist[Math.round((r.y0 + r.y1) / 2) * W + Math.round((r.x0 + r.x1) / 2)] < 0);
    if (!stranded.length) return;

    let cut = false;
    for (const room of stranded) {
      const options = doorCandidates(room, tiles, W, H).filter((run) => {
        const ox = run.axis === 'v' ? run.outsideLine : run.from;
        const oy = run.axis === 'v' ? run.from : run.outsideLine;
        if (ox < 0 || oy < 0 || ox >= W || oy >= H) return false;
        return dist[oy * W + ox] >= 0;
      });
      if (options.length) {
        cutDoor(rng.pick(options), rng, tiles, W, doors, room);
        cut = true;
      }
    }
    if (!cut) break;
  }

  // Give up on the rest: wall them off entirely.
  const dist = bfs(tiles, W, H, seedX, seedY);
  for (const room of rooms) {
    if (dist[Math.round((room.y0 + room.y1) / 2) * W + Math.round((room.x0 + room.x1) / 2)] >= 0) continue;
    for (let y = room.y0; y < room.y1; y++) {
      for (let x = room.x0; x < room.x1; x++) tiles[y * W + x] = SOLID;
    }
    room.doors.length = 0;
  }
}

// The biggest a lift lobby is allowed to be. There is no floor to go with it:
// what the room has to be able to hold is stated once, in `fitsLifts`, and
// restating it here in square metres is the FIRST_CONTACT_GAP failure in
// miniature — a room that passes an area test and cannot hold a car is a floor
// that arrives by standing in the middle of the carpet.
const LOBBY_MAX = 110;   // m²

/**
 * The lift lobby: the room the floor arrives in AND the room it leaves by.
 *
 * Both cars stand in it, which is what a building core is, and it is picked
 * NEAREST THE MIDDLE OF THE SLAB for the same reason a real one is there — every
 * wing of the floor is then the same walk away, and clearing a floor is a loop
 * out and back rather than a diagonal march from one corner to the far one.
 *
 * Three requirements, and only the last of them is about size:
 *
 *  - It can hold the whole bank. Everything about the arrival and the departure
 *    is the two cars, so a room that cannot take both is not a lobby.
 *  - It has a doorway onto a CORRIDOR. Those are the doors you go through to
 *    find the rest of the office, and it is also the part of the floor the
 *    prologue is measured over — a lobby whose only way out is somebody's office
 *    starts the floor by walking through a stranger's office to reach the
 *    building.
 *  - It is not the canteen and not a room the plant room could have had. Both
 *    are set pieces that want the biggest rooms on the floor and both are rare;
 *    a lobby is a modest room by nature, so it should never be the thing that
 *    takes one of them away.
 *
 * Each requirement is dropped in turn if nothing survives it, rather than
 * failing: a floor with an odd lobby is a floor, and a floor with no arrival
 * room is not.
 *
 * Deterministic — the qualifying room nearest the middle — rather than a draw,
 * and that is the argument `pickCafeteria` and `assignLocks` both make: this
 * runs before the floor's own rng has been spent on anything, so a die here
 * would re-roll the contents of every room in the building off a number that has
 * nothing to do with them. Which room is the lobby already varies with the floor,
 * because the floorplan it is picked out of does.
 */
function pickLobbyRoom(rooms, tiles, W, H, doors, cafeteria) {
  const canHold = rooms.filter(fitsLifts);
  const onHall = canHold.filter((r) =>
    doorsOnRoom(doors, r).some((d) => opensOntoCorridor(d, W, tiles)));
  const spare = onHall.filter((r) =>
    r !== cafeteria && r.areaM2 <= LOBBY_MAX && !fitsGenerator(r, doors));

  const pool = spare.length ? spare : (onHall.length ? onHall : (canHold.length ? canHold : rooms));
  // Measured to the middle of the SLAB rather than to the middle of the corridor
  // spine, because the spine is a handful of bands and the middle of the
  // building is not necessarily on one of them. The nearest qualifying room is
  // as central as the floorplan allows, which is the claim being made.
  const mx = W / 2, my = H / 2;
  const off = (r) => (r.cx - mx) ** 2 + (r.cy - my) ** 2;
  return pool.reduce((best, r) => (off(r) < off(best) ? r : best));
}

// How big a room has to be before it is a canteen rather than a room with a
// counter in it, and how deep before the rows behind the queue lane have
// anywhere to go. A long thin room of the same area comes out as a corridor
// with a servery at one end, which is why the short side is asked for
// separately.
const CAFE_MIN_AREA = 85;    // m²
const CAFE_MIN_SHORT = 12;   // tiles, so 6 m

/**
 * The floor's canteen, and the room the player arrives in.
 *
 * Picked before anything else about the floor is decided, because it BECOMES the
 * spawn room — and the exit's distance ranking, every lock, the prologue and
 * where a staircase may go are all measured from the spawn.
 *
 * The corridor doorway is the load-bearing requirement rather than the size. This
 * is the room the player is standing in holding nothing at all, so the way out of
 * it has to be the part of the floor the prologue is measured over; a big room
 * whose only door opens into somebody's office starts the floor by walking
 * through a stranger's office to reach the building.
 *
 * And it stays off any room the plant room could have had. The generator wants
 * the biggest, most rectangular room on the floor and only about one floor in
 * thirty rolls one that qualifies at all, so a canteen claiming rooms by size
 * would quietly cost the game its rarest set piece on the few floors that have
 * it. Generator-capable rooms are a last resort here, not the first pick.
 *
 * Deterministic — the biggest room that qualifies — rather than a draw, and that
 * is the same argument assignLocks makes: this runs before the floor's rng has
 * been spent on anything at all, so a die here would re-roll the contents of
 * every room in the building off a number that has nothing to do with them.
 * Which room is the canteen already varies with the floor, because the floorplan
 * it is picked out of does.
 */
function pickCafeteria(rooms, tiles, W, doors) {
  const fits = rooms.filter((r) =>
    r.areaM2 >= CAFE_MIN_AREA
    && Math.min(r.wTiles, r.hTiles) >= CAFE_MIN_SHORT
    && doorsOnRoom(doors, r).some((d) => opensOntoCorridor(d, W, tiles)));
  if (!fits.length) return null;

  const spare = fits.filter((r) => !fitsGenerator(r, doors));
  return (spare.length ? spare : fits).sort((a, b) => b.areaM2 - a.areaM2)[0];
}

// Where the role ladder splits. Aspect is tested before area on purpose: a long
// thin room is a service room whatever its floor area, and testing area first
// made that branch unreachable.
const LONG_THIN = 1.9;   // longest side / shortest side
const BIG_ROOM = 85;     // m², open plan and canteens
const MID_ROOM = 40;     // m², the meeting-room band

/**
 * Which branch of the role table a room's shape lands in.
 *
 * Exported because `validate-layout.mjs` reports this distribution, and its own
 * copy of the ladder had drifted: it tested area before aspect and used 2.1 for
 * the aspect cut, so it reported zero long-thin rooms on every sweep while the
 * generator was in fact producing thousands of them — which is the whole
 * storage/archive/utility supply. A tool asserting its own wrong number back at
 * the generator is exactly the failure FIRST_CONTACT_GAP is a monument to, so
 * there is one ladder now and both ends call it.
 */
export function roleBranch(r) {
  const long = Math.max(r.wTiles, r.hTiles) / Math.min(r.wTiles, r.hTiles);
  if (long > LONG_THIN) return 'longThin';
  if (r.areaM2 > BIG_ROOM) return 'big';
  if (r.areaM2 > MID_ROOM) return 'mid';
  return 'small';
}

// What each branch may be. Long-thin rooms furnish as ranks with an aisle
// between them, which is why they are back-of-house whatever their area.
//
// `utility` is NOT in here and that is the point of it: it is not a room you
// roll, it is what a room turns out to be when nothing else will go in it. See
// `furnish` in gen/rooms.js, which asks whether the one prop that makes a room
// what it is can actually be placed and falls back to a cupboard when it cannot.
// A small room is a private office by default instead, which is what a small
// room in an office building is.
const ROLE_PICKS = {
  longThin: ['storage', 'copyroom', 'server', 'storage', 'archive', 'mailroom'],
  big: ['openplan', 'openplan', 'openplan', 'presentation'],
  // No `openplan` here any more, and that is the point of the open-floor budget
  // rather than a side effect of it. An open plan office is the biggest thing on
  // the floor and it is decided by the BSP (see OPEN_SHARE) — a 45 m² room
  // labelled open plan was the game calling a modest office a floorplate, which
  // is exactly what made the label mean nothing.
  mid: ['meeting', 'breakroom', 'storage', 'presentation', 'itbay', 'reception', 'office'],
  // A private office is a SMALL room, and now that the open floors are big
  // enough to hold the shift, this is where most of the building's cellular
  // space goes: five in eight rather than three.
  small: ['office', 'office', 'office', 'office', 'office', 'copyroom', 'storage', 'breakroom'],
};

// Whether a room could be the plant room. Named rather than written inline in
// the wants list below, because pickCafeteria has to ask the same question to
// keep off the one room a generator could have had — and two copies of a
// predicate this specific is how the sweep ends up certifying a floor the
// generator never builds. See FIRST_CONTACT_GAP for the version of this that
// shipped.
function fitsGenerator(r, doors) {
  const long = Math.max(r.wTiles, r.hTiles), short = Math.min(r.wTiles, r.hTiles);
  return r.areaM2 > 110 && short >= 15 && long / short >= 1.35
    && doorsOnRoom(doors, r).length === 1;
}

function assignRoles(rooms, spawnRoom, exitRoom, cafeteria, doors, rng) {
  // An open floor is an open plan office and is nothing else. It is not a roll —
  // the BSP already decided, by handing the block over whole (see OPEN_SHARE),
  // and a die here would put a broom cupboard on 400 m² of floorplate.
  for (const r of rooms) {
    r.role = r.open ? 'openplan' : rng.pick(ROLE_PICKS[roleBranch(r)]);
  }

  // Guarantee the flavour rooms the floor is meant to have — but only in rooms
  // the right size for them, so no floor gets a 150 m² "storage cupboard". The
  // first four are on every floor because the building needs them; the rest is
  // a shuffled draw, so which back-of-house rooms a floor has is part of what
  // tells one floor from another.
  const wants = [
    // The generator room goes first: it wants the biggest, most RECTANGULAR
    // room on the floor — a hall, not a square hangar — and every other entry
    // below it is happy with something smaller, so it gets first pick before
    // a less demanding role claims the one room that could have held it. A
    // BSP leaf tops out at MAX_LEAF (26 tiles, 13 m) on a side, so past
    // roughly 110 m² a rectangular room is already pushed up against that
    // ceiling on its long axis — which is the point: this asks for as close
    // to that ceiling as the floor rolled. It also wants exactly one door: the
    // generator sits on the wall facing it (see generatorRoom in gen/rooms.js),
    // and a second doorway would either land behind the generator or give the
    // room a second "front", neither of which reads as the one-way plant room
    // this is meant to be. Checked with `doorsOnRoom` rather than `r.doors`,
    // which counts only the doors the room itself cut — the room next door may
    // have cut its own into a wall shared with this one (see doorsOnRoom's own
    // comment in gen/locks.js), and a hidden second doorway is worse than
    // whatever a real one would have been: the generator's own wall-facing
    // placement, and every clearance lane a hidden door pulls in behind it
    // (see reserveClearances), start fighting over the same floor. Not every
    // floor manages all of this, and that's fine: see buildLevel's generator
    // handling, which is opportunistic the same way the security office and
    // broom closet are.
    ['generator', (r) => fitsGenerator(r, doors)],
    ['storage', (r) => r.areaM2 < 90],
    ['copyroom', (r) => r.areaM2 < 55],
    ['server', (r) => r.areaM2 < 70],
    ['breakroom', (r) => r.areaM2 > 30],
    ...rng.shuffle([
      ['archive', (r) => r.areaM2 < 90],
      ['mailroom', (r) => r.areaM2 > 25 && r.areaM2 < 90],
      ['itbay', (r) => r.areaM2 > 25 && r.areaM2 < 90],
      ['presentation', (r) => r.areaM2 > 35],
      ['reception', (r) => r.areaM2 > 25],
    ]).slice(0, 4),
  ];
  const pool = rng.shuffle(rooms.filter(
    (r) => r !== spawnRoom && r !== exitRoom && r !== cafeteria));
  for (const [role, fits] of wants) {
    // An open floor is never any of these, THE PLANT ROOM INCLUDED, and that
    // last one is a decision worth stating because it looks like the one
    // exception that should be made.
    //
    // `fitsGenerator` asks for a big rectangular room with exactly one door, and
    // what made that rare was MAX_LEAF: a BSP leaf could not exceed 13 m a side,
    // so a room that qualified at all was a room pushed hard against the cap and
    // about 3% of floors had one. An open floor clears the bar by a mile, so
    // letting the plant room have one took it from 20 floors in 600 to 527 —
    // measured, on the sweep — which is a set piece you meet every thirty floors
    // becoming a fixture of nearly all of them. The rarity is the design (see
    // CLAUDE.md), so the population it is drawn from stays exactly the one it
    // has always been drawn from: the rooms the subdivision made.
    //
    // Everything else in this list would be a storeroom or a copy room on 400 m²
    // of floorplate — the area predicates below mostly say so already, and the
    // ones that do not (breakroom, presentation, reception) are open-ended on
    // purpose.
    const room = pool.find((r) => !r.forcedRole && !r.open && fits(r));
    if (room) { room.role = role; room.forcedRole = true; }
  }

  // The two rooms the floor is composed around, assigned last so the shuffled
  // draw above can never land a storeroom on one of them.
  //
  // There used to be three, and the lobby is why there are two: the arrival room
  // and the exit room are one room now (see pickLobbyRoom), so `reception` and
  // `exit` were two roles competing for the same object with the later
  // assignment quietly winning. It takes `exit` — the room is furnished as a
  // lobby with a counter in it either way, and `exit` is the name the minimap
  // and the props sweep already look for.
  //
  // The canteen is the other one and is a different room, which it has not always
  // been: it used to BE the arrival. The lunch cycle in enemies.js is about a
  // room people walk to at lunchtime, which is what it was always describing.
  spawnRoom.role = 'exit';
  spawnRoom.forcedRole = true;
  if (cafeteria && cafeteria !== spawnRoom) {
    cafeteria.role = 'cafeteria';
    cafeteria.forcedRole = true;
  }
}
