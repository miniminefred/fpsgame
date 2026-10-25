// A floor of the building that is a car park.
//
// One floor in ten comes out of the lift into concrete instead of carpet: the
// whole floor is one parking deck with rows of cars in painted bays and pillars
// down the middle, the corridors are asphalt lanes, and the attics and basements the stairs
// already reach (gen/stairs.js) are split-level decks of their own, reached up a
// concrete ramp and parked full of more cars.
//
// It is planned as an office floor and then KNOCKED THROUGH (`openGarage`): the
// corridor spine, the BSP and the lift lobby are planned exactly as on any other
// floor, which is what keeps it connected and gives it its lanes and its column
// grid, and then every partition and every door but the lobby's comes down. So
// the whole floor is the car park — one open deck, lanes where the corridors
// were, parking bays in what were rooms — and there is nothing left to lock:
// no keycard rooms, no manager, no broom closet. The roster copes with all three
// being absent, because each of them was always opportunistic.

import * as THREE from 'three';
import { makeRng } from './rng.js';
import { tryPlace } from './props.js';
import { FLIGHT_TILES, RAMP_RUN, RAMP_SLOPE, RISER, rampSpec } from './stairs.js';
import { CORRIDOR, ROOM, SOLID, slidePocketSide } from './tiles.js';
import { doorsOnRoom } from './locks.js';

// TEST: 1.0 while garage floors are being looked at. The design value is 0.1.
export const GARAGE_CHANCE = 1.0;

/**
 * Whether this floor is a car park. Its own stream, mixed with the floor number,
 * for `floorSpans`'s two reasons: drawing it from the floor's rng would re-roll
 * the whole building off a die that has nothing to do with it, and a stream of
 * the seed alone would make every floor of one seed the same kind.
 */
export function rollGarage(seed, floorNumber) {
  const rng = makeRng((seed ^ 0x6a4a7a9e) + Math.imul(floorNumber, 0x2545f491));
  return rng() < GARAGE_CHANCE;
}

/**
 * Knocks the floor through, all of it: every tile inside the building's outer wall
 * comes down to concrete except the rooms that stay rooms (`kept` — the lift lobby
 * and the security office, tucked into a corner) and the wall either side of their
 * doors that their panels slide into. Every other door goes with its wall.
 *
 * "Inside the outer wall" is the bounding box of the open floor as planned, which
 * is the slab less its exterior shell: a car park is one rectangle of deck, so the
 * unused leaves the BSP left solid come down too. Opening only ever adds floor, so
 * the connectivity proved before this still holds after it.
 *
 * Returns that rectangle, in tiles with an exclusive max — the deck every storey of
 * the car park stands on.
 */
export function openGarage(tiles, W, H, rooms, doors, kept) {
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (tiles[y * W + x] === SOLID) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x + 1 > x1) x1 = x + 1;
      if (y + 1 > y1) y1 = y + 1;
    }
  }

  const ringOf = (r) => (x, y) => x >= r.x0 - 1 && x <= r.x1 && y >= r.y0 - 1 && y <= r.y1;
  const rings = kept.filter(Boolean).map(ringOf);
  const inRing = (x, y) => rings.some((f) => f(x, y));

  // The doors first, as the floor either side of them: a hall door stood in a
  // corridor and becomes lane, a room's stood in a wall and becomes deck.
  const keep = new Set(kept.filter(Boolean).flatMap((r) => doorsOnRoom(doors, r)));
  for (let i = doors.length - 1; i >= 0; i--) {
    const d = doors[i];
    if (keep.has(d)) continue;
    for (let y = d.y0; y < d.y1; y++) {
      for (let x = d.x0; x < d.x1; x++) tiles[y * W + x] = d.hall ? CORRIDOR : ROOM;
    }
    doors.splice(i, 1);
  }
  for (const r of rooms) r.doors = r.doors.filter((d) => keep.has(d));

  // ...and the wall either side of a kept doorway, for as far as its panels slide.
  // A door retracts into the wall beside its opening (`slidePocketRun`), and a
  // room's ring can end before the pocket does — the wall used to carry on into
  // the office next door. Knocked through, one lobby in seven had a door with
  // nowhere to put its leaves.
  const pocket = new Uint8Array(W * H);
  for (const d of keep) {
    const reach = Math.max(d.x1 - d.x0, d.y1 - d.y0) + 2;
    for (let y = d.y0 - reach; y < d.y1 + reach; y++) {
      for (let x = d.x0 - reach; x < d.x1 + reach; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (d.vertical ? (x >= d.x0 && x < d.x1) : (y >= d.y0 && y < d.y1)) pocket[y * W + x] = 1;
      }
    }
  }

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      if (tiles[i] !== SOLID || inRing(x, y) || pocket[i]) continue;
      tiles[i] = ROOM;
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * The one room besides the lobby that stays a room: the security office, the
 * nearest room to the lifts that is a sensible size for one and has a door of its
 * own (one shared with the lobby would be locked on the way out of it).
 */
export function pickSecurity(rooms, tiles, W, H, doors, lobby) {
  const lobbyDoors = new Set(doorsOnRoom(doors, lobby));
  const fit = rooms.filter((r) => {
    if (r === lobby || r.areaM2 < 12 || r.areaM2 > 70) return false;
    const own = doorsOnRoom(doors, r);
    if (!own.length || own.some((d) => lobbyDoors.has(d) || d.hall)) return false;
    // It is locked, so every door it has must be able to hold a panel.
    return own.every((d) => slidePocketSide(tiles, W, H, d) !== 0);
  });
  if (!fit.length) return null;
  const off = (r) => (r.cx - lobby.cx) ** 2 + (r.cy - lobby.cy) ** 2;
  return fit.reduce((best, r) => (off(r) < off(best) ? r : best));
}

/** Every room a parking deck; the lobby the lobby, and security the security office. */
export function parkingRoles(rooms, lobby, security) {
  for (const r of rooms) { r.role = 'parking'; r.forcedRole = true; }
  lobby.role = 'exit';
  if (security) security.role = 'security';
}

/**
 * The car park's only lock: blue, on the security office, which is the card the
 * guards on rounds carry (`_security` in roster.js). Shaped exactly as
 * `assignLocks` would hand it over, so everything downstream reads it unchanged.
 */
export function garageLocks(doors, security) {
  if (!security) return [];
  const own = doorsOnRoom(doors, security);
  security.lock = 'blue';
  security.staffOnly = true;
  for (const d of own) d.lock = 'blue';
  return [{ room: security, tier: 'blue', doors: own, staffOnly: true }];
}

// --- the ramps -----------------------------------------------------------------

// How many decks a car park has, counting the ground: the ground, and two stacked
// on it. The ramp pair in the middle joins them one to the next.
export const DECKS = 3;

// How wide a ramp is, in tiles: a car park's ramp is driven, so it is a lane wide
// rather than a staircase wide.
const RAMP_W = 8;
// Clear floor kept at both ends of the pair, beyond the foot and the landing.
const RAMP_CLEAR = 3;

/**
 * One big ramp in the middle of the floor, in the shape a car park actually has:
 * a SWITCHBACK. The lower half climbs from the ground to the first deck running
 * one way, and the upper half sits right beside it climbing from the first deck to
 * the second running back the other way — so you come off the top of one and turn
 * round onto the next.
 *
 * Each is an ordinary flight plan with a `level` on it (gen/stairs.js), so the
 * builder, nav and both validators treat them as the attic stairs they are built
 * like: treads underneath, a deck at the top with a hole in it for the flight.
 * `deck` is the whole floor, and both levels cover all of it; the lower one is
 * `covered`, because the upper deck is its lid.
 */
export function planRamps(tiles, W, H, deck, kept) {
  const ft = FLIGHT_TILES;
  const w = RAMP_W * 2;
  const near = (x, y) => kept.filter(Boolean).some((r) =>
    x >= r.x0 - 1 - RAMP_CLEAR && x <= r.x1 + RAMP_CLEAR && y >= r.y0 - 1 - RAMP_CLEAR && y <= r.y1 + RAMP_CLEAR);
  const clearAt = (x0, y0) => {
    for (let y = y0 - RAMP_CLEAR; y < y0 + w + RAMP_CLEAR; y++) {
      for (let x = x0 - RAMP_CLEAR; x < x0 + ft + RAMP_CLEAR; x++) {
        if (x < deck.x0 || y < deck.y0 || x >= deck.x1 || y >= deck.y1) return false;
        if (tiles[y * W + x] === SOLID || near(x, y)) return false;
      }
    }
    return true;
  };

  // The middle of the deck, walked outward until the pair and its clearances fit.
  const cx = Math.round((deck.x0 + deck.x1) / 2 - ft / 2);
  const cy = Math.round((deck.y0 + deck.y1) / 2 - w / 2);
  let at = null;
  for (let r = 0; r <= 40 && !at; r++) {
    for (let dy = -r; dy <= r && !at; dy++) {
      for (let dx = -r; dx <= r && !at; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (clearAt(cx + dx, cy + dy)) at = { x: cx + dx, y: cy + dy };
      }
    }
  }
  if (!at) return [];

  const room = { x0: deck.x0, y0: deck.y0, x1: deck.x1, y1: deck.y1, role: 'parking' };
  const base = { room, side: 0, axis: 'x', dir: 1, x0: at.x, x1: at.x + ft };
  return [
    { ...base, up: 1, level: 1, covered: DECKS > 2, y0: at.y, y1: at.y + RAMP_W },
    { ...base, up: -1, level: 2, covered: false, y0: at.y + RAMP_W, y1: at.y + w },
  ].slice(0, DECKS - 1);
}

// --- the columns -----------------------------------------------------------------

// Every seven and a half metres each way: a car park's structural grid, three bays
// wide. Stood on the open deck as single wall tiles, so the shell draws them, nav
// steps round them and the validators measure them exactly as they do any wall.
const PILLAR_PITCH = 15;
const PILLAR_KEEP = 4;    // tiles a column keeps off doors, rooms and the ramps

/**
 * Stands the columns, and returns where they are so the decks above can stand
 * theirs on the same grid. A column only goes where it stands alone on open
 * floor — all eight neighbours open — so it can never close a gap, only stand in
 * the middle of one.
 */
export function standPillars(tiles, W, H, deck, kept, doors, ramps, rooms = []) {
  const avoid = new Uint8Array(W * H);
  const mark = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) avoid[y * W + x] = 1;
    }
  };
  const k = PILLAR_KEEP;
  for (const r of kept.filter(Boolean)) mark(r.x0 - 1 - k, r.y0 - 1 - k, r.x1 + 1 + k, r.y1 + 1 + k);
  for (const d of doors) mark(d.x0 - k - 2, d.y0 - k - 2, d.x1 + k + 2, d.y1 + k + 2);
  for (const p of ramps) mark(p.x0 - k - 2, p.y0 - k, p.x1 + k + 2, p.y1 + k);
  // ...and off every room's CENTRE tile, which half the generator and the roster use
  // as the one tile that stands for a room (see the centre-tile refusal in
  // gen/lifts.js): a column there makes a whole parking bay read as unreachable.
  for (const r of rooms) {
    const cx = Math.round(r.cx), cy = Math.round(r.cy);
    mark(cx - 1, cy - 1, cx + 2, cy + 2);
  }

  const out = [];
  for (let y = deck.y0 + 7; y < deck.y1 - 2; y += PILLAR_PITCH) {
    for (let x = deck.x0 + 7; x < deck.x1 - 2; x += PILLAR_PITCH) {
      if (avoid[y * W + x] || tiles[y * W + x] === CORRIDOR) continue;
      let alone = true;
      for (let dy = -1; dy <= 1 && alone; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (tiles[(y + dy) * W + x + dx] === SOLID) { alone = false; break; }
      }
      if (!alone) continue;
      tiles[y * W + x] = SOLID;
      out.push({ x, y });
    }
  }
  return out;
}

// --- the deck ----------------------------------------------------------------

const BAY_W = 2.5;        // one bay across, which is the `car` prop's footprint
const BAY_D = 5.0;        // ...and one bay deep
const LANE = 3.2;         // the drive aisle in front of a row
const STRIP = 0.8;        // between two rows parked back to back
const GANG = 1.2;         // clear at both ends of every row, so no row is a wall

/**
 * Rows of bays across the room's short side with a lane in front of each, the
 * way a car park is laid out: a row backed onto the wall, a lane, then two rows
 * parked back to back with pillars between them, a lane, and so on.
 *
 * Bays are placed SNAPPED to the tile grid, and that is load-bearing rather than
 * neat: a footprint is rounded outward to whole tiles, so two bays at an honest
 * 2.5 m pitch but off the grid each claim a sliver of the other's tile and the
 * second one is refused. Snapped, they share an edge exactly.
 */
export function parkingDeck(sink, bounds, rng) {
  // Rows run along one axis and stack across the other, and which way round is
  // whichever parks more cars: a 12 x 14 m room holds one row across its short
  // side and two across its long one.
  const plans = [true, false].map((alongX) => planDeck(bounds, alongX));
  const plan = plans[0].bays * plans[0].rows.length >= plans[1].bays * plans[1].rows.length
    ? plans[0] : plans[1];
  // Too shallow for a row and its lane either way, and it stays open concrete.
  // It used to fall back to cars along the walls, which is right for a room with
  // walls and wrong on an open deck: a room this shallow is a PASSAGE between two
  // parts of the floor, and one 4.5 m car across a 5.5 m gap shut it — sixteen
  // floors in three hundred had a bay of the deck nobody could get into.
  if (!plan.rows.length || !plan.bays) return;
  const { alongX, rows } = plan;
  const { x0, z0, x1, z1 } = bounds;
  const [a0, a1, b0] = alongX ? [x0, x1, z0] : [z0, z1, x0];

  // Bays along each row, snapped: the width axis centres on a tile centre (5
  // tiles across, odd) and the depth axis on a tile boundary (10 deep, even).
  const snapA = (a) => {
    const [sx, sz] = alongX ? sink.snap(a, b0) : sink.snap(b0, a);
    return alongX ? sx : sz;
  };
  const snapB = (b) => {
    const [sx, sz] = alongX ? sink.snap(a0, b) : sink.snap(b, a0);
    return (alongX ? sz : sx) - 0.25;
  };

  const first = snapA(a0 + GANG + BAY_W / 2);
  const bays = [];
  for (let a = first; a + BAY_W / 2 <= a1 - GANG + 1e-6; a += BAY_W) bays.push(a);

  const [, , , bEnd] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  for (const row of rows) {
    // Snapping rounds DOWN, which near the room's first edge pushes the row out
    // of the room and half a metre into the lane beyond it. Walked back in.
    let b = snapB(row.c + 0.25);
    while (b - BAY_D / 2 < b0 - 1e-6) b += 0.5;
    while (b + BAY_D / 2 > bEnd + 1e-6) b -= 0.5;
    // A prop is authored facing -Z, so a car on the x axis nosing toward +z is a
    // half turn, and one on the z axis nosing toward +x is a quarter turn.
    const rot = alongX ? (row.face > 0 ? 2 : 0) : (row.face > 0 ? 3 : 1);
    for (const a of bays) {
      const [cx, cz] = alongX ? [a, b] : [b, a];
      tryPlace(sink, 'car', cx, cz, rot, rng);
    }
  }
}

/**
 * Where the rows go across the room and which way each faces, for rows running
 * along one axis. `face` is +1 for a car whose nose points toward +b.
 */
function planDeck({ x0, z0, x1, z1 }, alongX) {
  const [a0, a1, b0, b1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const rows = [];
  const strips = [];
  const bays = Math.max(0, Math.floor((a1 - a0 - GANG * 2) / BAY_W));
  let y = b0;
  if (y + BAY_D + LANE > b1) return { alongX, rows, strips, bays };
  rows.push({ c: y + BAY_D / 2, face: 1 });
  y += BAY_D + LANE;
  for (;;) {
    if (y + BAY_D > b1) break;
    rows.push({ c: y + BAY_D / 2, face: -1 });
    y += BAY_D;
    // Another pair needs the strip, a row, and a lane in front of that row.
    if (y + STRIP + BAY_D + LANE > b1) break;
    strips.push(y + STRIP / 2);
    y += STRIP;
    rows.push({ c: y + BAY_D / 2, face: 1 });
    y += BAY_D + LANE;
  }
  return { alongX, rows, strips, bays };
}

// --- what it is made of --------------------------------------------------------

// The shell's materials, swapped for a car park's. Read by the shell and by the
// stair builder through `garageKey`, so a building pass asks for `wall` and gets
// concrete on this floor without knowing why.
const GARAGE_MATERIAL = {
  wall: 'concreteWall',
  carpet: 'concrete',
  vinyl: 'asphalt',
  ceiling: 'soffit',
};

export function garageKey(layout, key) {
  return layout?.garage ? (GARAGE_MATERIAL[key] ?? key) : key;
}

// --- the ramp ----------------------------------------------------------------

const RAMP_T = 0.28;      // the slab's own thickness

/**
 * A flight as a concrete ramp: one sloped slab over the whole run, in place of
 * the treads and their nosing.
 *
 * Only the PICTURE changes. The treads are still the colliders (stairBoxes), and
 * that is deliberate: nav, the player's step test and both validators already
 * agree about them, and a sloped collider is a thing this engine has never had.
 * The slab is laid half a riser above the line through the tread nosings, so
 * wherever a foot is on a tread it is within a tenth of a metre of the concrete.
 */
export function rampGeometry(layout, plan) {
  const spec = rampSpec(layout, plan);
  const alongX = spec.alongX;
  const c0 = alongX ? layout.oz + plan.y0 * 0.5 : layout.ox + plan.x0 * 0.5;
  const c1 = alongX ? layout.oz + plan.y1 * 0.5 : layout.ox + plan.x1 * 0.5;
  const across = c1 - c0;

  const rise = RAMP_RUN * RAMP_SLOPE * spec.dir;
  const len = Math.hypot(RAMP_RUN, rise);
  const geo = new THREE.BoxGeometry(alongX ? len : across, RAMP_T, alongX ? across : len);

  // Tilt it about the across axis so it climbs `up` along the run.
  const angle = Math.atan2(rise, RAMP_RUN) * spec.up;
  if (alongX) geo.rotateZ(angle);
  else geo.rotateX(-angle);

  const mid = spec.foot + spec.up * RAMP_RUN / 2;
  // Half a riser toward the treads: they stand ABOVE the nosing line going up
  // and hang BELOW it going down, so the offset follows the flight's direction.
  const y = rise / 2 + spec.dir * RISER / 2 - RAMP_T / 2;
  const cMid = (c0 + c1) / 2;
  geo.translate(alongX ? mid : cMid, y, alongX ? cMid : mid);
  return geo;
}
