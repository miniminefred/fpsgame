import {
  TILE, SOLID, CORRIDOR,
  bfs, slidePocketSide, fillRoom, sealDoor, doorHasTile, anyDoorTile,
} from './tiles.js';

// --- keycard locks ----------------------------------------------------------
//
// Every door in the building has a reader beside it, because every door in an
// office building does. Which card opens which lock is keycards.js's business;
// this decides which rooms get which lock, and the entire job here is making
// sure a lock can never cost you the floor.
//
// The five cards fall into two groups, and they are governed by two completely
// different rules:
//
//   WHITE is the staff badge, and it goes on EVERYTHING with a door. Every
//   employee in the building is carrying one, so it is not really a lock at all
//   — it is the thirty seconds at the start of a floor before you have taken one
//   off somebody. That is the only reason it can be this indiscriminate. What
//   makes it safe is `staffOnly` below: white rooms are the rooms people work
//   in, so the card is behind the door AND in front of it, several hundred
//   times over, and enemies.js guarantees at least one hostile stands outside
//   every locked room on the floor. The spawn room is the one exception — a
//   badge reader on the lobby you start inside is a floor you cannot leave.
//
//   GREY, BLUE, YELLOW and BLACK are real locks, and they are the ones the
//   proofs below are about. They empty their room of staff, and a room only
//   takes one if FILLING IT IN SOLID still leaves every other room and the exit
//   reachable — so all four are loot, never the route. A candidate must also be
//   reachable with the other three already shut, so no card is ever behind
//   another card's door, and none is behind its own.
//
// The cost is a flood fill per candidate, on a grid the generator has already
// flooded several times. It is worth it: this is the one part of the floor that,
// when it goes wrong, cannot be walked around.
//
// It is its own file because it is a different KIND of code from the generator
// that hands it a floor. gen/layout.js carves geometry and is allowed to roll
// dice about it; everything here is a proof, and every one of these proofs has a
// failure mode — an unstartable floor, an unclearable one, a key locked in with
// its own lock — that is invisible until a player walks into it. The dependency
// runs one way only: this reads a finished floorplan through the tile vocabulary
// in gen/tiles.js and knows nothing about how it was carved.

// The back-of-house roles that read as "staff only" from the doorway — they are
// what the grey card is for.
const GREY_ROLES = new Set(['server', 'archive', 'itbay', 'mailroom', 'utility', 'storage']);

// In order, because the ones with a room role of their own have to get first
// pick. White is not in here: it is not chosen, it is what is left.
//
// `staffOnly` is the flag that does the real work — it says this room is emptied
// of staff, which is what keeps its card from being locked inside it. Every
// entry here sets it, and white does not, and that difference IS the difference
// between the two groups.
const LOCK_PLAN = [
  // The manager sits as far from the lifts as the floor allows, which is both
  // how offices work and where you want the last room on the floor to be.
  { tier: 'black', role: 'manager', count: [1, 1], far: true,
    fits: (r) => r.areaM2 >= 14 && r.areaM2 <= 70 },
  { tier: 'blue', role: 'security', count: [1, 1],
    fits: (r) => r.areaM2 >= 14 && r.areaM2 <= 70 },
  { tier: 'yellow', role: 'closet', count: [1, 1],
    fits: (r) => r.areaM2 <= 34 },
  { tier: 'grey', count: [2, 4], fits: (r) => GREY_ROLES.has(r.role) },
];

// How many candidates a tier will flood-fill before giving up on itself. A floor
// that cannot place a lock simply does not have that lock — there is no card for
// it either, so nothing dangles.
const LOCK_TRIES = 10;

// How many hall doors want a real lock rather than the staff badge. They only
// get one where the corridor network offers a way round — see hallLocks — so
// this is a wish rather than a count.
const HALL_GREY = 0.3;

/**
 * How far from the lifts the first person the player can reach has to be, in
 * METRES: far enough not to be standing on the doormat, near enough that finding
 * them is not the floor.
 *
 * Exported because enemies.js measures the same thing against the same number
 * (see _cardOutside), and the two drifting apart is not a hypothetical — it
 * already shipped once. This file guaranteed corridor at 14 *tiles walked* and
 * enemies.js wanted corridor at 11 *metres straight-line*, which is 22 tiles, so
 * the guarantee was both in the wrong unit and weaker than the thing it was
 * protecting. Result: about one floor in forty had nobody the player could reach
 * and could not be started at all. One constant, one unit, one place.
 */
export const FIRST_CONTACT_GAP = 11;

// How many corridor tiles past that gap have to be reachable with every door
// shut. Counted in tiles rather than in standable spots because the generator
// runs before a stick of furniture is placed and cannot know which of them a
// filing cabinet will end up in — so it is deliberately generous, and
// _cardOutside has a fallback for the rest.
export const PROLOGUE_MIN = 40;

export function assignLocks(tiles, W, H, rooms, doors, spawnRoom, exitRoom, dist, rng) {
  const sx = Math.round(spawnRoom.cx), sy = Math.round(spawnRoom.cy);
  const centre = (r) => Math.round(r.cy) * W + Math.round(r.cx);

  // The floor as it will look with every lock shut. Locks are cumulative, so a
  // candidate is judged against the floor the previous locks left behind.
  const sealed = Uint8Array.from(tiles);
  let reach = bfs(sealed, W, H, sx, sy);

  const locks = [];
  for (const step of LOCK_PLAN) {
    const wanted = rng.int(step.count[0], step.count[1]);

    let pool = rooms.filter((r) =>
      !r.lock && r !== spawnRoom && r !== exitRoom && step.fits(r));
    // A role-bearing lock would rather not eat one of the flavour rooms the
    // floor was promised, so unforced rooms go first.
    pool = rng.shuffle(pool).sort((a, b) => (a.forcedRole ? 1 : 0) - (b.forcedRole ? 1 : 0));
    if (step.far) pool.sort((a, b) => (dist[centre(b)] ?? 0) - (dist[centre(a)] ?? 0));

    let placed = 0;
    for (const room of pool.slice(0, LOCK_TRIES)) {
      if (placed >= wanted) break;

      // Behind a lock already placed: locking it would put its key behind two
      // doors, and the second one may be the one this key opens.
      if (reach[centre(room)] < 0) continue;

      const onRoom = doorsOnRoom(doors, room);
      if (!onRoom.length) continue;
      // Every way in has to be shuttable. One opening on the room with no wall
      // to retract a panel into is a lock you walk straight around.
      if (onRoom.some((d) => slidePocketSide(tiles, W, H, d) === 0)) continue;
      // And no way in may be shared with a room that is already locked to a
      // DIFFERENT tier. A doorway between the security office and the archive
      // has to demand one card or the other, and whichever it demands, the other
      // room is now openable with a card that was never meant to open it. There
      // are four of these locks on a floor of two hundred rooms, so refusing the
      // candidate outright costs nothing and settles the question permanently.
      if (onRoom.some((d) => d.lock)) continue;
      if (!survivesWithout(sealed, W, H, sx, sy, rooms, room, locks, exitRoom, onRoom)) continue;

      room.lock = step.tier;
      room.staffOnly = true;
      if (step.role) { room.role = step.role; room.forcedRole = true; }
      for (const d of onRoom) d.lock = step.tier;
      locks.push({ room, tier: step.tier, doors: onRoom, staffOnly: true });

      fillRoom(sealed, W, room, SOLID);
      reach = bfs(sealed, W, H, sx, sy);
      placed++;
    }
  }

  // The doors across the corridors, which is the last tier decided before white
  // goes on everything left.
  hallLocks(sealed, W, H, sx, sy, doors, reach, rng);

  // And now the one thing white cannot check for itself. Everything above is a
  // lock you meet with an empty pocket, walk away from, and come back to; white
  // is the one you meet before you have anything at all, so the floor has to
  // guarantee a way out of the lobby to somebody worth shooting.
  freeThePrologue(tiles, W, H, sx, sy, spawnRoom.cx, spawnRoom.cy, doors);

  // And white on everything else, with no proof and no flood fill, because
  // there is nothing to prove: white is not a card you go and find, it is a card
  // the next person you shoot is already carrying. The only rooms it skips are
  // the lobby you spawn in — locking that is locking yourself in — and doorways
  // with no wall to retract a panel into, which cannot hold a door at all.
  //
  // The exit room is NOT skipped. Reaching the exit means clearing the floor,
  // clearing the floor means killing somebody, and killing somebody means having
  // a white card, so a badge reader on the exit is a reader you have already
  // walked through forty of.
  for (const room of rooms) {
    if (room.lock || room === spawnRoom) continue;
    const onRoom = doorsOnRoom(doors, room);
    if (!onRoom.length) continue;
    if (onRoom.some((d) => slidePocketSide(tiles, W, H, d) === 0)) continue;
    // A doorway the prologue needs standing open cannot be badged, and a room
    // with one does not get a lock at all — the same deal as the line above, and
    // for the same reason: half a lock is worse than none, because the reader
    // beside it would be lying.
    if (onRoom.some((d) => d.free)) continue;

    room.lock = 'white';
    // Never DOWNGRADE a door. A white room next to the archive shares that
    // doorway, and stamping white over the grey lock on it would open the
    // archive to a staff badge from the room next door.
    for (const d of onRoom) d.lock ??= 'white';
    locks.push({ room, tier: 'white', doors: onRoom, staffOnly: false });
  }

  return locks;
}

/**
 * Badging the doors across the corridors.
 *
 * Every other lock in the building is on a room, and a room is a dead end you
 * choose to open. A corridor is the route, so a reader on one is the only lock
 * in this game that can stand between the player and the rest of the floor —
 * which is why nothing here is left to chance. Two rules, and the floor is safe
 * whichever way the dice fall:
 *
 *  - **A real lock only where the network goes round.** A hall door may take
 *    grey, but only if sealing it strands nothing that was reachable before.
 *    Corridors are a network with more than one way through most of it, so this
 *    is often true — and where it is, the door costs you a detour rather than
 *    the run. The test is cumulative: each door is judged against the floor the
 *    already-badged ones left behind, so two doors that each have a way round
 *    can never be allowed to shut the last one between them.
 *
 *  - **Everything else takes white**, which is the same badge that is already on
 *    every room door on the floor and in every employee's pocket. It costs the
 *    first thirty seconds of a floor and nothing after that.
 *
 * White is what makes the second rule need a guarantee of its own, and that is
 * freeThePrologue below rather than anything here — it is not really a question
 * about hall doors, as it turns out. It is a question about the first thirty
 * seconds of a floor, which hall doors made sharper and did not invent.
 */
function hallLocks(sealed, W, H, sx, sy, doors, reach, rng) {
  for (const d of rng.shuffle(doors.filter((x) => x.hall))) {
    if (rng.chance(HALL_GREY) && goesRound(sealed, W, H, sx, sy, d, reach)) {
      d.lock = 'grey';
      sealDoor(sealed, W, d);
      reach = bfs(sealed, W, H, sx, sy);
    } else {
      d.lock = 'white';
    }
  }
}

/**
 * Leave the player a way out of the lobby, and somebody to meet.
 *
 * Every other lock on this floor is fine to walk up to with nothing in your
 * pocket: you look at the reader, you go and shoot somebody, you come back.
 * White is not, because white is on EVERYTHING — so on arrival the building is
 * shut, and the only cards on the floor are in the pockets of people on the far
 * side of it. The floor has to hand you the first one.
 *
 * Nothing above proves that. The room passes prove things about the floor once
 * you hold a white card; this is the one question asked of the floor before you
 * hold anything, and the answer has to be yes on every seed. So: shut every door
 * on the floor, flood from the lifts, and if what is left is too small to stand
 * the first body in, take the reader off the doorway on the edge of it and ask
 * again. Corridor-fronting doorways go first because corridor is what
 * _cardOutside stands people in, and the nearest one goes first because the
 * point is a short prologue rather than a large one.
 *
 * It terminates in something playable by construction: freeing doorways only
 * ever grows the region, and freeing all of them is a floor with no readers on
 * it at all.
 *
 * This found a real bug the day it was written, and an old one — on about one
 * floor in seven the lobby's only doorway was shared with a neighbouring room,
 * that room's white pass badged it, and the floor began with the player sealed
 * in the lift lobby holding nothing. It had nothing to do with hall doors; it
 * needed a check that asked the question, and hall doors are what made anybody
 * ask it.
 */
// `sx`/`sy` are the tile the flood starts from; `cx`/`cy` are the spawn POINT in
// fractional tiles, which is what layout.spawn denotes and what distances are
// measured from. They are not the same number and must not be conflated.
function freeThePrologue(tiles, W, H, sx, sy, cx, cy, doors) {
  for (let guard = 0; guard <= doors.length; guard++) {
    // Every door shut except the ones already freed — an accurate model, since
    // white is about to go on everything that is still undecided.
    const shut = Uint8Array.from(tiles);
    for (const d of doors) if (!d.free) sealDoor(shut, W, d);

    const dist = bfs(shut, W, H, sx, sy);
    if (prologueRoom(tiles, W, dist, cx, cy) >= PROLOGUE_MIN) return;

    let best = null;
    let bestKey = Infinity;
    for (const d of doors) {
      if (d.free) continue;
      // A doorway already carrying a real tier is the one thing that may not be
      // freed: its room has been marked staff-only and emptied of everybody who
      // works there, and a reader on the room with none on this doorway is the
      // lock undone. Hall doors are exempt — there is no room behind them to
      // contradict.
      if (d.lock && !d.hall) continue;
      const at = doorTouching(d, W, dist);
      if (at < 0) continue;
      // Hall doors go first because freeing one costs nothing but the reader:
      // freeing a ROOM's doorway costs that room its lock entirely (see the
      // white pass), so it is the second choice, and then only where it fronts a
      // corridor. Nearest to the lifts within each group, because the point is a
      // short prologue rather than a large one.
      const rank = d.hall ? 0 : (opensOntoCorridor(d, W, tiles) ? 1e6 : 2e6);
      const key = rank + at;
      if (key >= bestKey) continue;
      best = d; bestKey = key;
    }
    if (!best) return;

    best.free = true;
    best.lock = null;
  }
}

/**
 * Corridor the player can reach on arrival and that is far enough out to stand
 * somebody in — the exact set _cardOutside will be drawing from.
 *
 * Straight-line from the lifts, not walked, because straight-line is what
 * enemies.js measures and this only means anything if the two agree. Walked
 * distance is always the larger of the two, so a guarantee written in it looks
 * satisfied while leaving nowhere legal to stand.
 */
function prologueRoom(tiles, W, dist, cx, cy) {
  const gap = FIRST_CONTACT_GAP / TILE;
  let n = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] < 0 || tiles[i] !== CORRIDOR) continue;
    // Tile CENTRE against the spawn point, in fractional tiles — the same two
    // points enemies.js puts into the same subtraction. Measuring from the
    // rounded spawn tile instead is half a tile out, which sounds like nothing
    // and moved this count by nine tiles at an eleven metre radius.
    const dx = (i % W) + 0.5 - cx;
    const dy = ((i / W) | 0) + 0.5 - cy;
    if (dx * dx + dy * dy > gap * gap) n++;
  }
  return n;
}

// Is either side of this doorway a corridor? Corridor is where the first
// card-holder stands, so it is what the prologue is counting.
function opensOntoCorridor(d, W, tiles) {
  for (let y = d.y0; y < d.y1; y++) {
    for (let x = d.x0; x < d.x1; x++) {
      const sides = d.vertical
        ? [(y * W) + x - 1, (y * W) + x + 1]
        : [((y - 1) * W) + x, ((y + 1) * W) + x];
      for (const i of sides) if (tiles[i] === CORRIDOR) return true;
    }
  }
  return false;
}

// Could you still get everywhere with this door shut? The door's own tiles are
// exempt — they are solid in the trial and are the one thing that is allowed to
// stop being reachable.
function goesRound(sealed, W, H, sx, sy, door, reach) {
  const trial = Uint8Array.from(sealed);
  sealDoor(trial, W, door);
  const after = bfs(trial, W, H, sx, sy);

  for (let i = 0; i < after.length; i++) {
    if (reach[i] >= 0 && after[i] < 0 && !doorHasTile(door, W, i)) return false;
  }
  return true;
}

/**
 * What the player can reach on arrival, holding nothing: a flood from the lifts
 * that refuses to cross any doorway with a reader on it. freeThePrologue above
 * has already guaranteed there is something out there; this is what hands the
 * region to enemies.js so it can put somebody in it.
 */
export function prologueRegion(tiles, W, H, sx, sy, doors) {
  const open = Uint8Array.from(tiles);
  for (const d of doors) if (d.lock) sealDoor(open, W, d);
  return bfs(open, W, H, sx, sy);
}

// How far into the region a door's nearest tile is, or -1 if it is not on its
// edge at all. Doors are sealed in that flood, so a locked door bordering the
// region is found by its NEIGHBOURS being reachable, not its own tiles.
function doorTouching(d, W, dist) {
  let best = -1;
  for (let y = d.y0; y < d.y1; y++) {
    for (let x = d.x0; x < d.x1; x++) {
      const sides = d.vertical
        ? [(y * W) + x - 1, (y * W) + x + 1]
        : [((y - 1) * W) + x, ((y + 1) * W) + x];
      for (const i of sides) {
        if (i < 0 || i >= dist.length || dist[i] < 0) continue;
        if (best < 0 || dist[i] < best) best = dist[i];
      }
    }
  }
  return best;
}

// Would sealing `candidate` strand anything? Every other room has to keep a way
// in from the spawn, and so does the exit. A room already locked counts as
// reachable if any of ITS doorway tiles still is — its interior is solid in this
// model, but you will be opening that door with a card, and the door is the part
// that has to stay in front of you.
function survivesWithout(sealed, W, H, sx, sy, rooms, candidate, locks, exitRoom, ownDoors) {
  const trial = Uint8Array.from(sealed);
  fillRoom(trial, W, candidate, SOLID);

  const after = bfs(trial, W, H, sx, sy);
  const reached = (i) => after[i] >= 0;

  for (const r of rooms) {
    if (r === candidate || r.lock) continue;
    if (!reached(Math.round(r.cy) * W + Math.round(r.cx))) return false;
  }
  // The doors of everything locked, the candidate's own included — a room you
  // can never walk up to is a room whose card does nothing.
  if (!ownDoors.some((d) => anyDoorTile(d, W, reached))) return false;
  for (const lock of locks) {
    if (!lock.doors.some((d) => anyDoorTile(d, W, reached))) return false;
  }
  return reached(Math.round(exitRoom.cy) * W + Math.round(exitRoom.cx));
}

/**
 * Every doorway on a room's boundary, whoever cut it.
 *
 * A room's own `doors` list holds only the openings IT cut. The room next door
 * may well have cut its own into the same shared wall, and half a lock is no
 * lock at all — so locking a room means locking every opening that leads into
 * it, which is what this finds.
 */
function doorsOnRoom(doors, room) {
  const inside = (x, y) => x >= room.x0 && x < room.x1 && y >= room.y0 && y < room.y1;
  return doors.filter((d) => {
    for (let y = d.y0; y < d.y1; y++) {
      for (let x = d.x0; x < d.x1; x++) {
        if (d.vertical ? (inside(x - 1, y) || inside(x + 1, y))
          : (inside(x, y - 1) || inside(x, y + 1))) return true;
      }
    }
    return false;
  });
}

/**
 * One byte per tile, for anything inside a locked room or in one of its
 * doorways:
 *
 *   0  not behind a card
 *   1  behind a white door — a room people work in, so things may stand here
 *   2  behind a real lock — nobody works here, so nothing may be placed here
 *
 * The distinction is the whole safety argument for white being everywhere: a
 * white room full of staff is a white room full of white cards, whereas anything
 * dropped inside a 2 would be a key locked in with its own lock.
 */
export const STAFF_ONLY = 2;

export function lockedMask(W, H, locks) {
  const mask = new Uint8Array(W * H);
  for (const { room, doors, staffOnly } of locks) {
    const v = staffOnly ? STAFF_ONLY : 1;
    for (let y = room.y0; y < room.y1; y++) {
      for (let x = room.x0; x < room.x1; x++) mask[y * W + x] = v;
    }
    for (const d of doors) {
      for (let y = d.y0; y < d.y1; y++) {
        for (let x = d.x0; x < d.x1; x++) mask[y * W + x] = v;
      }
    }
  }
  return mask;
}
