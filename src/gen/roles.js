// What a room turns out to be.
//
// The carve in gen/carve.js produces rectangles; this decides which of them is
// the lift lobby, which is the canteen, and what each of the rest is for. It is
// deliberately separate from the carving, because the two answer different
// questions and are tuned against different things: a change here moves what is
// IN a building without moving one wall of it.

import { PAD } from './carve.js';
import { doorsOnRoom, opensOntoCorridor } from './locks.js';
import { fitsLifts } from './lifts.js';

// The biggest a lift lobby is allowed to be. There is no floor to go with it:
// what the room has to be able to hold is stated once, in `fitsLifts`, and
// restating it here in square metres is the FIRST_CONTACT_GAP failure in
// miniature — a room that passes an area test and cannot hold a car is a floor
// that arrives by standing in the middle of the carpet.
const LOBBY_MAX = 110;   // m²

// How far off the middle of the slab a lobby may sit, as a fraction of the
// width — a sixth either way, so the middle third. It is the band the minimap
// reads as "the middle" rather than a tolerance on the ranking: the whole point
// of the lobby being where it is, is that a player looking at the map finds the
// way out at the bottom middle every time.
const LOBBY_BAND = 1 / 6;

// ...and how far DOWN it has to be, as a fraction of the depth: the bottom
// third. Asked as a second filter rather than left to `off` because the two
// halves of "down in the middle" trade against each other — a band on x alone
// hands a central room higher up the floor to a floor that had a bottom-edge
// room slightly off-centre, which measured as 98.8% central and only 86.5% down
// against 97.5% before. Both, then either, then whatever there is.
const LOBBY_DOWN = 2 / 3;

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
export function pickLobbyRoom(rooms, tiles, W, H, doors, cafeteria) {
  const canHold = rooms.filter(fitsLifts);
  const onHall = canHold.filter((r) =>
    doorsOnRoom(doors, r).some((d) => opensOntoCorridor(d, W, tiles)));
  const spare = onHall.filter((r) =>
    r !== cafeteria && r.areaM2 <= LOBBY_MAX && !fitsGenerator(r, doors));

  // THE BOTTOM MIDDLE OF THE MAP, which is the middle of the far-z edge: the
  // minimap draws world +z down the screen (`_my` in minimap.js), so the bottom
  // of the map a player is reading is the high-z side of the slab. Measured to
  // the slab's own edge rather than to the corridor spine, because the spine is
  // a handful of bands and the middle of the building need not be on one.
  //
  // It used to be the middle of the slab, and the difference is what a floor
  // IS: from the centre, clearing one is a loop out and back with every wing the
  // same walk away; from the bottom edge it is a push up the floor and a walk
  // home. The lifts are where the plan says they are either way — this is the
  // only line that decides it.
  //
  // `PAD` off the edge rather than the edge itself, because the outermost tiles
  // are the exterior shell and no room's centre can be in them; the target is
  // the nearest a room could actually get.
  const mx = W / 2, my = H - PAD;
  const off = (r) => (r.cx - mx) ** 2 + (r.cy - my) ** 2;
  const nearest = (pool) => pool.reduce((best, r) => (off(r) < off(best) ? r : best));

  // WHERE IT IS BEATS WHAT IT IS, and that is the inversion. Ranking every
  // qualifying room by `off` and taking the nearest sounds like it says "the
  // bottom middle", and it does not: on a floor whose central rooms are all too
  // big or open onto nobody, the nearest SURVIVOR is whatever sat at the bottom
  // edge off to one side, or dead centre half way up. Measured over 600 floors,
  // the lobby landed in the middle third on 84% and in the bottom third on 96%
  // — and in BOTH on 81%, so about one floor in five put the way out somewhere
  // a player reading the minimap does not look for it.
  //
  // So the box is asked FIRST and the three requirements are relaxed under it,
  // in the order that costs least: the size cap goes before the canteen and the
  // canteen before the plant room, because a lobby that is bigger than a lobby
  // ought to be is still a lobby, where a floor that loses its only canteen or
  // its one-in-thirty plant room has lost a set piece. 99% now land in the box.
  const inBox = (r) => Math.abs(r.cx / W - 0.5) <= LOBBY_BAND && r.cy / H >= LOBBY_DOWN;
  for (const tier of [
    spare,
    // ...the size cap dropped: still never the canteen and never the plant room.
    onHall.filter((r) => r !== cafeteria && !fitsGenerator(r, doors)),
    // ...then the canteen, which costs that floor its canteen and nothing else.
    onHall.filter((r) => !fitsGenerator(r, doors)),
    // ...then a room the plant room could have had, which is the dearest of the
    // three and so is asked last.
    onHall,
    // ...and last, a room with no corridor doorway. NOT `rooms`, which is where
    // this first had it and is a hole rather than one more relaxation: every
    // tier above is filtered by `fitsLifts`, and a room that cannot hold the
    // bank is a floor promising a lift it cannot build. It put the lobby in a
    // 20 m² room on s1006/f1 — nine tiles on an axis that needs fourteen — whose
    // departure car then had nowhere to go, so the way down fell back to the lit
    // pad at the room's centre 1.68 m from the arrival, and `2.exit-apart`
    // caught it. `rooms` stays where it always was, in the fallback below, which
    // is reached only when no room on the floor can hold lifts at all.
    canHold,
  ]) {
    const box = tier.filter(inBox);
    if (box.length) return nearest(box);
  }

  // NOTHING ANYWHERE IN THE BOTTOM MIDDLE, which is an ordinary answer on a
  // floor whose rooms simply are not there — back to the strictest tier that
  // holds anything and the nearest room in it. A floor with an odd lobby is a
  // floor, and a floor with no arrival room is not.
  return nearest(spare.length ? spare
    : (onHall.length ? onHall : (canHold.length ? canHold : rooms)));
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
export function pickCafeteria(rooms, tiles, W, doors) {
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

export function assignRoles(rooms, spawnRoom, exitRoom, cafeteria, doors, rng) {
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
