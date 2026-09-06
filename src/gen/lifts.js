// The two lift cars a floor is entered and left by.
//
// A floor used to begin with the player simply standing in the middle of a room
// and end with a lit pad on the carpet. Both are places rather than arrivals:
// nothing about either says you came from the floor above, or that there is one
// below. So a floor now opens the way an office opens — you are in a lift car,
// its doors part, and the room in front of you is the lift lobby.
//
// Both cars are in THAT ONE ROOM, side by side, and the room is the one nearest
// the middle of the slab — which is where a building puts its core, and what
// makes a floor a loop out and back rather than a march from one corner to the
// other. See `carveBank` below and `pickLobbyRoom` in gen/layout.js. The way out
// of the lobby is a pair of doors onto the office, and the way down is the car
// next to the one you came up in, lit green.
//
// A car is a TINY ROOM CARVED INTO A ROOM, not a structure stood inside one, and
// that is the whole reason this file is tile arithmetic rather than a mesh
// builder. Everything the shell already does for a room it does for the car for
// free: SOLID tiles become walls with colliders, the open tiles inside take
// flooring and a suspended ceiling, the DOOR tiles take a frame and a header,
// and nav blocks the walls and walks the opening without being told any of it
// exists. What gen/build.js adds on top (see buildLifts) is the fit-out — the
// lining, the light and the doors that part in the middle — and none of that is
// structural.
//
// It runs LAST, after roles, locks and stairs, and that ordering is the whole of
// its safety. Every pass that reasons about doors reads `layout.doors`:
// `assignLocks` would badge a lift door as an ordinary way into the exit room,
// `fitsGenerator` counts a room's doorways to decide what it can be, and
// `cafeteria` and `generatorRoom` are both composed around `doorsOnRoom(...)[0]`.
// A lift door is none of those things, and running after all of them is cheaper
// and far more certain than teaching each one to ignore it.

import { SOLID, ROOM, DOOR, isOpen, bfs, centreX, centreZ } from './tiles.js';

// The car, in tiles, measured on its inside.
//
// 2.0 x 1.5 m, which is a small office lift and not a goods one — this is
// somewhere you stand for a moment, and a big empty box would read as a room the
// generator forgot to furnish. The depth is what the number is really about:
// three tiles is the shallowest car whose back wall is not close enough to the
// opening to be taken in whole from out in the room.
export const CAR_W = 4;        // tiles across the front — 2.0 m
export const CAR_D = 3;        // tiles deep — 1.5 m

/**
 * How wide the opening is, and why it is not the building's own DOOR_W.
 *
 * Two tiles, one metre — and the reason is the pocket rather than the look. A
 * sliding panel retracts into the wall beside its opening and needs that wall to
 * be there for the panel's whole length (`slidePocketSide` in gen/tiles.js), and
 * the only wall a car has beside its doors is the strip of its own front between
 * the opening and the corner post. So the arithmetic has to close: the front is
 * CAR_W + 2 tiles, the opening takes LIFT_DOOR_W out of the middle, and what is
 * left is one tile a side. With two leaves parting in the middle each leaf is
 * LIFT_DOOR_W / 2 wide, so each one wants a tile of pocket and gets exactly it.
 *
 * A 1.5 m opening on a 2.0 m car would leave a quarter of a tile a side, which
 * is a pair of leaves standing out in the middle of the car when they are open.
 */
export const LIFT_DOOR_W = 2;  // tiles — a 1.0 m opening

// How much room a car has to leave the room it is carved into, in tiles. Two
// tiles of floor either side of the block, so the reception reads as a room with
// a lift in it rather than as a lift with a skirting round it; and four in
// front, which is DOOR_CLEAR — the square every doorway in the building keeps
// clear anyway, and here it is also the floor you step out onto.
const SIDE_ROOM = 2;
const FRONT_ROOM = 4;

// The narrowest strip of floor a body can actually use, in tiles — one metre
// against a 0.8 m body. It is the same number `SCATTER_LANE` and
// `reserveThroughRoutes` in gen/furnish.js are built on, and it is what both
// refusals below are really about: a car may stand against a wall, and it may
// stand a lane away from one, and what it may not do is leave anything in
// between.
const LANE = 2;

// The block the car occupies, including its own walls: a side wall either side
// of the interior, and a front wall it cuts its opening in. The BACK wall is the
// room's own perimeter — a lift shaft belongs in the fabric of a building, and a
// car standing off the wall with a strip of carpet behind it is a cupboard.
const BLOCK_A = CAR_W + 2;
const BLOCK_D = CAR_D + 1;

/**
 * How much clear room the BANK has to leave in front of it, in tiles.
 *
 * FRONT_ROOM is the floor you step out onto and it is what a single car needs.
 * The two extra tiles here are not a margin either, and they are the whole
 * reason a lobby is asked for ten tiles across rather than eight: they keep the
 * room's own CENTRE TILE out of the block.
 *
 * `tryCarve` refuses to stand on that tile — half the generator uses
 * `round(cx), round(cy)` as the one tile that stands for a room, and a car walled
 * over it makes `assignLocks`, the exit ranking and the layout sweep all answer
 * "unreachable" about a room that is fine. With one car that refusal cost a wall
 * and not a lift, because the wall opposite always had room. With two cars on
 * ONE wall it costs the bank: the pair is twelve tiles across a sixteen-tile
 * wall, so the room's centre column is inside one of them nearly every time, and
 * the only thing keeping the centre TILE clear is that the centre ROW is deeper
 * into the room than the block is. Four tiles of block plus two of clearance is
 * what makes that true on either long wall.
 */
const BANK_FRONT = FRONT_ROOM + 2;

/**
 * Whether a room could hold the floor's whole lift bank.
 *
 * Named and exported rather than written out at its call site, which is the
 * FIRST_CONTACT_GAP lesson: `pickLobbyRoom` refuses a room that cannot hold both
 * cars, and `carveBank` is what actually cuts them — the two asking slightly
 * different questions is exactly how a floor ends up promising a lift it cannot
 * build.
 *
 * The bank goes against any of the four walls, so a room needs the long
 * requirement on one axis and the short one on the other, either way round.
 */
export function fitsLifts(r) {
  const long = Math.max(r.wTiles, r.hTiles);
  const short = Math.min(r.wTiles, r.hTiles);
  return short >= BLOCK_D + BANK_FRONT && long >= BLOCK_A * 2 + SIDE_ROOM * 2;
}

/**
 * Both cars, side by side on one wall of one room.
 *
 * The floor is entered and left by the same lobby, so the two cars are a BANK
 * rather than two lifts at opposite ends of a building — which is what a lift
 * lobby is, and it is also what makes the departure car legible: you have stood
 * in front of it since before you moved, and the only thing that tells the two
 * apart is that one of them is lit green (see buildExit in gen/fitout.js).
 *
 * They are carved one at a time by the same `carveLift` the floor has always
 * used, and the second one is handed the first one's wall as its preference. Two
 * consequences fall out of that and both are wanted: the second car cannot
 * overlap the first, because every tile a block stands on has to be plain ROOM
 * floor and the first car's walls are not; and the second is free to walk round
 * to another wall when the first one has no room left, which is a bank that has
 * turned a corner rather than a floor with one lift in it.
 *
 * `bias` is what centres the PAIR rather than the first car. `carveLift` walks
 * out from the middle of the wall, so with no bias the arrival takes the centre
 * and the departure ends up beside it and the two of them sit off to one side.
 * Half a block each way puts the gap between them on the middle of the wall.
 *
 * Either may come back null and a null car is an ordinary answer — see
 * `carveLift`.
 */
export function carveBank(layout, room, doors, prefer, seed) {
  const arrival = carveLift(layout, room, doors, prefer, seed, -BLOCK_A / 2);
  if (!arrival) return { arrival: null, departure: null };
  return {
    arrival,
    departure: carveLift(layout, room, doors, arrival.side, seed, BLOCK_A / 2),
  };
}

/**
 * Cuts a car into one wall of `room` and hands back what it cut.
 *
 * `prefer` is the wall it would rather use, in the game's own side numbering
 * (0 = the +z wall, 1 = -x, 2 = -z, 3 = +x — see `edgeProp` in gen/rooms.js).
 * For the arrival room that is the wall OPPOSITE the room's own doorway, which
 * is what makes the composition read: the doors part, the reception is in front
 * of you, and the way into the building is across it and straight ahead.
 *
 * `seed` is any open tile the whole floor is reachable from; it is what the
 * connectivity proof below is run from, and it must not be inside `room`.
 *
 * Returns null when nothing fits, and a null lift is an ordinary answer: the
 * arrival falls back to standing in the room and the exit to the lit pad it has
 * always been. A floor with no lift in it is a worse floor; a floor that fails
 * to generate is not a floor.
 */
export function carveLift(layout, room, doors, prefer, seed, bias = 0) {
  const { tiles, W, H } = layout;

  // What was reachable before, so the carve can be proved to have taken nothing
  // away. Three of a car's four walls are new plaster in the middle of a room,
  // and the room's own doorway can be behind, beside or in front of them: the
  // cheap tests below catch a doorway the block would stand ON, and this catches
  // the one it would corner off. The same proof `goesRound` makes before it
  // dares badge a hall door, and for the same reason — this runs after
  // connectivity has been established and must not be able to undo it.
  const before = bfs(tiles, W, H, seed.x, seed.y);

  for (const side of [prefer, (prefer + 1) & 3, (prefer + 3) & 3, (prefer + 2) & 3]) {
    const geom = carGeometry(room, side);
    if (!geom) continue;
    // Centred on the wall first, then walked out to either side of centre a tile
    // at a time. A car centred on the reception's back wall is what a lift lobby
    // looks like; being able to step off centre is what gets one built at all in
    // a room whose own doorway happens to be dead behind the middle of it.
    for (const a0 of offsets(geom, bias)) {
      const lift = tryCarve(layout, room, doors, side, geom, a0, before, seed);
      if (lift) return lift;
    }
  }
  return null;
}

// Where along the wall the block may start, centred first and stepping outward.
// `bias` moves the point it starts from — see `carveBank`, which is the only
// caller that wants anywhere but the middle.
function* offsets({ aMin, aMax }, bias = 0) {
  const centre = Math.round((aMin + aMax) / 2 + bias);
  for (let step = 0; step <= aMax - aMin; step++) {
    for (const a0 of step === 0 ? [centre] : [centre - step, centre + step]) {
      if (a0 >= aMin && a0 <= aMax) yield a0;
    }
  }
}

/**
 * The mapping from car coordinates to tiles, for one wall.
 *
 * `a` runs along the wall across the front of the car, 0 and BLOCK_A - 1 being
 * its two corner posts; `d` runs into the room, 0 being against the back wall
 * and BLOCK_D - 1 being the front the doors are cut in. `d === -1` is the room's
 * own perimeter wall behind the car.
 *
 * One origin and two step vectors rather than four cases, which is the
 * `edgeProp` lesson in another file: four sets of coordinates written out by
 * hand come out with half of them backwards, and here the failure would be
 * silent — a car carved through the wall into the room next door.
 *
 * `along` says which axis `a` runs on, so the caller can put `a0` into the right
 * half of the origin; the other half is the wall the car backs onto.
 */
function carGeometry(room, side) {
  const { x0, y0, x1, y1 } = room;
  const map = [
    { along: 'x', base: y1 - 1, ua: [1, 0], ud: [0, -1], aMin: x0, aMax: x1 - BLOCK_A },
    { along: 'y', base: x0, ua: [0, 1], ud: [1, 0], aMin: y0, aMax: y1 - BLOCK_A },
    { along: 'x', base: y0, ua: [1, 0], ud: [0, 1], aMin: x0, aMax: x1 - BLOCK_A },
    { along: 'y', base: x1 - 1, ua: [0, 1], ud: [-1, 0], aMin: y0, aMax: y1 - BLOCK_A },
  ][side];
  return map.aMax >= map.aMin ? map : null;
}

function tryCarve(layout, room, doors, side, geom, a0, before, seed) {
  const { tiles, W, H } = layout;
  const { ua, ud } = geom;
  // The block's origin: its corner post, hard against the back wall.
  const ox = geom.along === 'x' ? a0 : geom.base;
  const oy = geom.along === 'x' ? geom.base : a0;
  const cell = (a, d) => ({
    x: ox + ua[0] * a + ud[0] * d,
    y: oy + ua[1] * a + ud[1] * d,
  });
  const at = (a, d) => {
    const c = cell(a, d);
    return (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) ? SOLID : tiles[c.y * W + c.x];
  };
  const put = (a, d, v) => {
    const c = cell(a, d);
    tiles[c.y * W + c.x] = v;
  };

  // Every tile the block will stand on has to be this room's own plain floor,
  // and the wall behind it has to really be a wall. A DOOR tile in either place
  // is a doorway the car would seal, and a SOLID one inside the block is the
  // room's own corner — both are refusals rather than something to work around.
  for (let a = 0; a < BLOCK_A; a++) {
    if (at(a, -1) !== SOLID) return null;
    for (let d = 0; d < BLOCK_D; d++) if (at(a, d) !== ROOM) return null;
  }

  // Nothing the block TOUCHES may be a doorway. A car with its flank flush
  // against the inside of the room's own opening seals that opening from the
  // room, and the connectivity proof below sails through it: the room has other
  // doors and is still perfectly reachable, so what is left is a door frame in a
  // corridor wall with a panel in it that opens onto plaster.
  for (let a = -1; a <= BLOCK_A; a++) {
    for (let d = -1; d <= BLOCK_D; d++) {
      const outside = a < 0 || a >= BLOCK_A || d < 0 || d >= BLOCK_D;
      if (outside && at(a, d) === DOOR) return null;
    }
  }

  // LANE tiles of the room's own floor across the front, which is where you
  // stand when the doors part and the only side of the car anybody has to use.
  for (let a = 0; a < BLOCK_A; a++) {
    for (let d = BLOCK_D; d < BLOCK_D + LANE; d++) if (at(a, d) !== ROOM) return null;
  }

  // And no SLIVER down either flank. A car pushed hard into the corner of a
  // reception is the best place for it and leaves no gap at all, which is why
  // this is not a margin: nought is right and two is right, and the one thing
  // that must not happen is ONE — half a metre of floor between the car and
  // whatever is beside it, which the tile grid calls floor and a 0.8 m body
  // cannot get down. It is quiet in exactly the way the doorway above is: the
  // room stays reachable, the car stays reachable, and a doorway at the far end
  // of that sliver is a doorway you cannot walk out of. The props sweep found it
  // as one exit room in three hundred with 1% of its own floor reachable from
  // its own door — the geometric check catching what the tile flood cannot see.
  //
  // WALKED out from the block rather than measured off the room's rectangle,
  // which is the same answer against the room's own wall and the only right one
  // against THE OTHER CAR. A floor's two cars stand in one room now, side by
  // side on one wall (see carveBank), so the tile beside this block is as likely
  // to be its neighbour's corner post as the room's plaster — and arithmetic off
  // `aMin`/`aMax` cannot see a wall that was not there when the room was cut.
  // Every row of the block is asked, not just one: they all give the same answer
  // for a rectangular room and for a car parked alongside, and asking all four
  // costs nothing and is the version that stays true if either stops being a
  // clean rectangle.
  for (let d = 0; d < BLOCK_D; d++) {
    for (const dir of [-1, 1]) {
      let gap = 0;
      while (gap < LANE && at(dir < 0 ? -1 - gap : BLOCK_A + gap, d) === ROOM) gap++;
      if (gap === 1) return null;
    }
  }

  // And it may not stand on the room's own CENTRE TILE, which is not a look but
  // a contract. Half the generator uses `round(cx), round(cy)` as the one tile
  // that stands for a room — `assignLocks` asks whether a candidate is still
  // reachable there, the exit is ranked by the distance to it, and the layout
  // sweep decides a white room is stranded by flooding to it. A car walled over
  // that tile makes every one of those questions answer "unreachable" about a
  // room that is perfectly reachable, which showed up as five floors in six
  // hundred reporting a white room cut off behind locks that had nothing to do
  // with it. Refusing here rather than widening FRONT_ROOM to make it
  // arithmetically impossible: the requirement belongs to the tile, and a margin
  // wide enough today is one BLOCK_D away from being quietly wrong. The wall
  // opposite always has room for it, so a refusal here costs a wall and not a
  // lift.
  const mid = { x: Math.round(room.cx), y: Math.round(room.cy) };
  for (let a = 0; a < BLOCK_A; a++) {
    for (let d = 0; d < BLOCK_D; d++) {
      const c = cell(a, d);
      if (c.x === mid.x && c.y === mid.y) return null;
    }
  }

  // Cut it, then prove it. The shell first, then the opening back out of the
  // front of it.
  const doorA = (BLOCK_A - LIFT_DOOR_W) >> 1;
  for (let a = 0; a < BLOCK_A; a++) {
    for (let d = 0; d < BLOCK_D; d++) {
      if (a === 0 || a === BLOCK_A - 1 || d === BLOCK_D - 1) put(a, d, SOLID);
    }
  }
  for (let a = doorA; a < doorA + LIFT_DOOR_W; a++) put(a, BLOCK_D - 1, DOOR);

  const after = bfs(tiles, W, H, seed.x, seed.y);
  const kept = before.every((d, i) => d < 0 || after[i] >= 0 || !isOpen(tiles[i]));
  if (!kept) {
    // Put the room back exactly as it was. Everything the block touched was
    // plain ROOM floor — which is what the test above proved — so restoring it
    // is one value rather than a saved copy.
    for (let a = 0; a < BLOCK_A; a++) {
      for (let d = 0; d < BLOCK_D; d++) put(a, d, ROOM);
    }
    return null;
  }

  const carTiles = [];
  for (let a = 1; a <= CAR_W; a++) {
    for (let d = 0; d < CAR_D; d++) {
      const c = cell(a, d);
      carTiles.push(c.y * W + c.x);
    }
  }

  const dA = cell(doorA, BLOCK_D - 1);
  const dB = cell(doorA + LIFT_DOOR_W - 1, BLOCK_D - 1);
  const door = {
    x0: Math.min(dA.x, dB.x), x1: Math.max(dA.x, dB.x) + 1,
    y0: Math.min(dA.y, dB.y), y1: Math.max(dA.y, dB.y) + 1,
    // A doorway is one tile thick across itself, so which way it runs is which
    // way the wall it is cut in runs — and the car's front runs along `ua`.
    vertical: ua[0] === 0,
    // Not a room doorway and not a hall door: a third kind, and everything that
    // walks `layout.doors` has to be able to say so. gen/build.js fits it with a
    // pair of parting leaves rather than a single panel, and the layout sweep
    // holds it to its own width rather than to DOOR_W.
    lift: true,
  };
  doors.push(door);

  const first = cell(1, 0), last = cell(CAR_W, CAR_D - 1);
  const b0 = cell(0, 0), b1 = cell(BLOCK_A - 1, BLOCK_D - 1);
  return {
    room, side, door, tiles: carTiles,
    tx0: Math.min(first.x, last.x), tx1: Math.max(first.x, last.x) + 1,
    ty0: Math.min(first.y, last.y), ty1: Math.max(first.y, last.y) + 1,
    // The whole block, walls and all. The interior above is what is walkable;
    // this is what the room LOST, and anything that treats a room's rect as its
    // own open floor has to subtract it — see gen/build.js's furnishing and the
    // room-tile checks in tools/validate-layout.mjs.
    bx0: Math.min(b0.x, b1.x), bx1: Math.max(b0.x, b1.x) + 1,
    by0: Math.min(b0.y, b1.y), by1: Math.max(b0.y, b1.y) + 1,
    // The middle of the car in world metres — where the player materialises, and
    // where the way down is. Averaged over the two opposite interior tiles
    // rather than taken off the block, because the car is an even number of
    // tiles on one axis and an odd number on the other, so a tile centre and the
    // block's centre are half a tile apart in exactly one of the two.
    x: (centreX(layout, first.x) + centreX(layout, last.x)) / 2,
    z: (centreZ(layout, first.y) + centreZ(layout, last.y)) / 2,
    // Which way the car faces, as a rotation in the game's own numbering — so
    // `FACING[lift.facing]` is the direction the doors open into the room.
    //
    // It is the SIDE, not the opposite of it, and the two are easy to swap. A
    // side number is already the quarter turn that puts a thing's front into the
    // room: `edgeProp` in gen/rooms.js documents at length that a prop backed
    // against side 0 — the +z wall — faces -z, which is rotation 0. A car is
    // backed against its wall in exactly that sense, so what its doors face is
    // `ud`, the direction this file has been walking into the room all along.
    facing: side,
  };
}
