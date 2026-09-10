// Filling a finished floor: which rooms get furnished, what is kept clear before
// anything is placed, and the handful of things that go in the corridors.
//
// The order in here is load-bearing rather than incidental. Nothing may be
// furnished into a doorway, a lift car or the square where the player arrives,
// so all of that is reserved BEFORE the first prop is placed — a floor should
// not be furnished into a state it then has to be rescued from.

import { tryPlace } from './props.js';
import { furnish } from './rooms.js';
import {
  centreX,
  centreZ,
  CORRIDOR,
  DOOR_CLEAR,
  isOpen,
  NAV_LANE,
  NEIGHBOURS,
  SKIRT,
  tileX,
  tileY,
  worldX,
  worldZ,
} from './layout.js';
import { approachRect } from './stairs.js';

// Re-exported rather than declared: it moved to gen/tiles.js when
// gen/placement.js needed it too, because importing it from here would have
// closed a cycle. Its own note is there. One number, one place.
export { SKIRT };

export function furnishRooms(layout, sink, rng, workstations, theme) {
  for (const room of layout.rooms) {
    // Keep furniture off the walls so nothing clips into the skirting.
    const bounds = {
      x0: worldX(layout, room.x0) + SKIRT,
      z0: worldZ(layout, room.y0) + SKIRT,
      x1: worldX(layout, room.x1) - SKIRT,
      z1: worldZ(layout, room.y1) - SKIRT,
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

export function placeCow(layout, sink, rng) {
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

// Corridors stay walkable, but a few props along the walls stop them reading as
// empty tubes.
export function furnishCorridors(layout, sink, rng) {
  const { W, H, tiles } = layout;
  const step = 7;
  const kinds = ['plant', 'waterCooler', 'crateStack', 'printer', 'cabinet'];

  for (let ty = step; ty < H - step; ty += step) {
    for (let tx = step; tx < W - step; tx += step) {
      if (tiles[ty * W + tx] !== CORRIDOR || !rng.chance(0.4)) continue;
      const x = centreX(layout, tx);
      const z = centreZ(layout, ty);
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
export function placeWashers(layout, sink, rng) {
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
    const x = centreX(layout, tx);
    const z = centreZ(layout, ty);
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

// Doorways, the spawn point and the exit must never be furnished shut.
export function reserveClearances(layout, reserved) {
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
  // pickCafeteria in gen/roles.js), which is the first room this has ever been
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

// How wide a reserved lane is: NAV_LANE, because that is what a lane IS — the
// width a body can actually walk on the nav grid. See its declaration in
// gen/tiles.js, which is also the number the canteen's ranks are spaced by.
const LANE = NAV_LANE;

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
 * `room.doors` holds only the doors that room CUT (see cutDoor in gen/carve.js), and
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
    // A LIFT door has one room on BOTH sides of it, and it is not a doorway of
    // that room in any sense this function is about: a car is a tiny room carved
    // INTO its lobby (gen/lifts.js), so both probes land in the lobby and the
    // lobby came out holding two mouths per car, at tiles inside itself. Every
    // lobby was therefore a room you walk THROUGH — `list.some(m => m.through)`
    // was true of a lobby with one real doorway — and lanes were reserved from
    // its front door to the inside of each car, which is floor no route crosses
    // and the tightest room in the building to be spending it in. Dropping out
    // is what a hall door already does one branch up, and for the same reason:
    // it is not in anybody's room. The apron at a car's doors is kept clear
    // regardless, by the doorway pass above and by the cars being stamped whole.
    if (sides.length === 2 && sides[0].room === sides[1].room) continue;
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
    for (const m of list) reserveLane(layout, plan.room, foot, m.at, stampTiles);
  }
}

function reserveThroughRoutes(layout, mouths, stampTiles) {
  for (const [room, list] of mouths) {
    if (list.length < 2 || !list.some((m) => m.through)) continue;
    // Every other doorway back to the first one, so the lanes of a room with
    // three doors still meet rather than forming two separate legs.
    for (let i = 1; i < list.length; i++) {
      reserveLane(layout, room, list[0].at, list[i].at, stampTiles);
    }
  }
}

/**
 * A lane of reserved floor between two tiles of one room.
 *
 * An L by preference — along z at `a`, then along x at `b` — with both legs
 * widened toward the room's inside, because a doorway sits against a wall and a
 * lane hanging half in the plaster is 0.5 m.
 *
 * THE L IS ONLY A ROUTE IF THE ROOM IS A CLEAR RECTANGLE, and one room in the
 * building is not: a lift car is a tiny room carved INTO its lobby (see
 * gen/lifts.js), so the lobby's own rect has two blocks of SOLID standing in the
 * middle of it. The L is then reserved straight through them, which is the worst
 * of both — it protects tiles nothing can walk on, and it leaves the floor the
 * route actually runs over free to be furnished.
 *
 * That is not a hypothetical. `oneWayIn` seals every doorway of a lobby but one,
 * except where sealing would strand something (3 lobbies in 60 keep a second
 * one), so a lobby really can be the only way into the room behind it. On
 * s148308955/f10 the surviving second doorway was an office's only way out, the
 * L to the lobby's front door ran through the near car — 8 solid tiles, and the
 * office's mouth reached 12 of the L's 46 open tiles with the front door not
 * among them — and the reception counter then legally took the 2 m strip beside
 * the cars, which was the walk. 1.7 m of counter across 2.5 m of room leaves
 * 0.65 m against the 0.8 m of square body needed to pass: the office was sealed,
 * a hostile spawned in it, and the floor could never be cleared. That is
 * `5.geom-connected` in tools/validate-props.mjs, the same check and the same
 * failure the crate-and-shelving copyroom had.
 *
 * So the L is TESTED and not assumed, and a room it does not cross is walked
 * instead. Testing rather than always walking is deliberate: the L is right for
 * every ordinary BSP rectangle, and reserving the same tiles it always did is
 * what keeps this fix to the floors that were broken.
 */
function reserveLane(layout, room, a, b, stampTiles) {
  const [ax, ay] = a, [bx, by] = b;
  const wide = (v, lo, hi) => Math.max(lo, Math.min(v, hi - LANE + 1));
  const laneY = wide(ay, room.y0, room.y1 - 1);
  const laneX = wide(bx, room.x0, room.x1 - 1);

  const legs = [
    [Math.min(ax, bx), laneY, Math.max(ax, bx), laneY + LANE - 1],
    [laneX, Math.min(ay, by), laneX + LANE - 1, Math.max(ay, by)],
  ];
  for (const r of laneConnects(layout, legs, a, b) ? legs : walkedLane(layout, room, a, b, legs)) {
    stampTiles(...r);
  }
}

// Does a body get from `a` to `b` without leaving these rects? Open tiles only —
// a rect covering a wall or a lift car is covering nothing you can walk on.
function laneConnects(layout, rects, [ax, ay], [bx, by]) {
  const { W, tiles } = layout;
  const inRects = (tx, ty) =>
    rects.some(([x0, y0, x1, y1]) => tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1);
  const walkable = (tx, ty) => inRects(tx, ty) && isOpen(tiles[ty * W + tx]);
  if (!walkable(ax, ay) || !walkable(bx, by)) return false;

  const seen = new Set([ay * W + ax]);
  const q = [[ax, ay]];
  for (let head = 0; head < q.length; head++) {
    const [x, y] = q[head];
    if (x === bx && y === by) return true;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (seen.has(k) || !walkable(nx, ny)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return false;
}

/**
 * ...and when the L is not a route, the route is walked and widened.
 *
 * A shortest walk over the room's own open tiles, with a LANE-wide box stamped
 * around each tile of it. Not clipped to the room, on purpose: a walk that runs
 * along a wall would otherwise be reserved two tiles wide, and LANE's own note
 * is about why two is not enough. A tile of plaster marked "keep clear" costs
 * nothing.
 *
 * A room with no walk at all between its own two doorways hands back the L,
 * which is what this has always reserved and no worse than before.
 */
function walkedLane(layout, room, [ax, ay], [bx, by], legs) {
  const { W, tiles } = layout;
  const walkable = (tx, ty) =>
    tx >= room.x0 && tx < room.x1 && ty >= room.y0 && ty < room.y1
    && isOpen(tiles[ty * W + tx]);
  if (!walkable(ax, ay) || !walkable(bx, by)) return legs;

  const from = new Map([[ay * W + ax, -1]]);
  const q = [[ax, ay]];
  let found = false;
  for (let head = 0; head < q.length && !found; head++) {
    const [x, y] = q[head];
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (from.has(k) || !walkable(nx, ny)) continue;
      from.set(k, y * W + x);
      if (nx === bx && ny === by) { found = true; break; }
      q.push([nx, ny]);
    }
  }
  if (!found) return legs;

  // Split either side of the walk rather than halved, so an even LANE would come
  // out LANE wide rather than one short.
  const back = Math.floor((LANE - 1) / 2), fwd = LANE - 1 - back;
  const rects = [];
  for (let k = by * W + bx; k >= 0; k = from.get(k)) {
    const tx = k % W, ty = (k - tx) / W;
    rects.push([tx - back, ty - back, tx + fwd, ty + fwd]);
  }
  return rects;
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
