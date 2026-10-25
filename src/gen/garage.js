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
import { CORRIDOR, DOOR, ROOM, SOLID, slidePocketSide } from './tiles.js';
import { DOOR_W } from './carve.js';
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

/** The rectangle the open floor covers, in tiles with an exclusive max: the deck. */
export function openBox(tiles, W, H) {
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
  return { x0, y0, x1, y1 };
}

// --- the office block --------------------------------------------------------------

// The block in the bottom-left corner of the deck: a hall running east to the one
// door into the car park, a row of rooms either side of it. In tiles.
const HALL_W = 4;        // the hall, 2 m
const SOUTH_D = 12;      // the row against the building's outer wall: the lift lobby
const NORTH_D = 10;      // ...and the row on the far side of the hall
const LOBBY_W = 18;      // holds the lift bank (`fitsLifts`: 16 x 10 and more)
const SECURITY_W = 10;
const OFFICE_W = [8, 12];
const LOBBY_DOOR = 6;    // a double door, as wide as the lobby's always is

/**
 * The corner of offices a car park keeps by its lifts: concrete outside, an office
 * inside. A hall runs from the building's west wall to a door in the block's east
 * wall, which is the one way in from the car park; the lift lobby is on the south
 * side of it against the building's outer wall, the security office opposite, and
 * one to five ordinary offices along both sides, three to seven rooms in all. Every
 * room has a door onto the hall, and the offices next to one another sometimes have
 * a door through between them.
 *
 * Carved over whatever the BSP put in that corner: the rect is filled solid first,
 * so nothing of the office floor underneath survives into it, and the caller drops
 * the BSP rooms it covered. Drawn on its own stream for the reason every other
 * planning die is.
 *
 * Returns the block's interior rect (its ring is its own walls), its rooms, the
 * lobby, the security office and the doors it cut.
 */
export function carveOffice(tiles, W, H, deck, seed) {
  const rng = makeRng((seed ^ 0x0ff1ce5) >>> 0);
  const roll = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  const total = roll(3, 7);
  const southOffices = total >= 5 ? 1 : 0;
  const northOffices = total - 2 - southOffices;
  const south = [{ w: LOBBY_W, kind: 'exit' }];
  for (let i = 0; i < southOffices; i++) south.push({ w: roll(...OFFICE_W), kind: 'office' });
  const north = [{ w: SECURITY_W, kind: 'security' }];
  for (let i = 0; i < northOffices; i++) north.push({ w: roll(...OFFICE_W), kind: 'office' });
  // Both rows run the block's whole width, so the shorter one's last room takes up
  // the slack.
  const rowLen = (row) => row.reduce((a, r) => a + r.w, 0) + row.length - 1;
  const BW = Math.max(rowLen(south), rowLen(north));
  south[south.length - 1].w += BW - rowLen(south);
  north[north.length - 1].w += BW - rowLen(north);

  const X0 = deck.x0, X1 = deck.x0 + BW;          // interior, exclusive
  const Y1 = deck.y1;
  const yS0 = Y1 - SOUTH_D;                         // south rooms
  const hy1 = yS0 - 1, hy0 = hy1 - HALL_W;          // the hall, between two wall rows
  const yN1 = hy0 - 1, yN0 = yN1 - NORTH_D;         // north rooms
  const at = (x, y) => y * W + x;

  // The block solid, its own two walls included: the north row of wall and the
  // east column. Its west and south sides are the building's outer wall already.
  for (let y = yN0 - 1; y < Y1; y++) for (let x = X0; x <= X1; x++) tiles[at(x, y)] = SOLID;
  for (let y = hy0; y < hy1; y++) for (let x = X0; x < X1; x++) tiles[at(x, y)] = CORRIDOR;

  const rooms = [];
  const doors = [];
  const room = (x0, y0, x1, y1, kind) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) tiles[at(x, y)] = ROOM;
    const r = {
      id: 10000 + rooms.length, x0, y0, x1, y1, doors: [], kind,
      wTiles: x1 - x0, hTiles: y1 - y0, areaM2: (x1 - x0) * (y1 - y0) * 0.25,
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, office: true,
    };
    rooms.push(r);
    return r;
  };
  const door = (x0, y0, x1, y1, vertical, owner, extra = {}) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) tiles[at(x, y)] = DOOR;
    const d = { x0, y0, x1, y1, vertical, ...extra };
    doors.push(d);
    owner?.doors.push(d);
    return d;
  };

  // The two rows, each room opening onto the hall through the wall between them.
  const rows = [
    { list: south, y0: yS0, y1: Y1, wall: hy1 },
    { list: north, y0: yN0, y1: yN1, wall: yN1 },
  ];
  const byRow = [];
  for (const row of rows) {
    let x = X0;
    const made = [];
    for (const spec of row.list) {
      const r = room(x, row.y0, x + spec.w, row.y1, spec.kind);
      made.push(r);
      const width = spec.kind === 'exit' ? LOBBY_DOOR : DOOR_W;
      // Off the room's corners by a tile, and with at least a door's width of wall
      // on one side of it for the panel to slide into.
      const lo = r.x0 + 1, hi = r.x1 - 1 - width;
      const dx = spec.kind === 'exit'
        ? Math.round((r.x0 + r.x1 - width) / 2)
        : lo + Math.floor(rng() * Math.max(1, hi - lo + 1));
      door(dx, row.wall, dx + width, row.wall + 1, false, r,
        spec.kind === 'exit' ? { free: true, double: true, wide: true } : {});
      x += spec.w + 1;
    }
    byRow.push(made);
  }
  // ...and a door through between two offices standing side by side, now and then.
  for (const made of byRow) {
    for (let i = 0; i + 1 < made.length; i++) {
      const a = made[i], b = made[i + 1];
      if (a.kind !== 'office' || b.kind !== 'office' || rng() < 0.4) continue;
      const lo = a.y0 + 1, hi = a.y1 - 1 - DOOR_W;
      const dy = lo + Math.floor(rng() * Math.max(1, hi - lo + 1));
      door(a.x1, dy, a.x1 + 1, dy + DOOR_W, true, a);
    }
  }
  // The way in from the car park: a door in the block's east wall at the end of the
  // hall. Wall either side of it for its panel, which is the rooms' end walls.
  door(X1, hy0, X1 + 1, hy0 + DOOR_W, true, null, { free: true });

  const lobby = rooms.find((r) => r.kind === 'exit');
  const security = rooms.find((r) => r.kind === 'security');
  return { rect: { x0: X0, y0: yN0, x1: X1, y1: Y1 }, rooms, lobby, security, doors };
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

// --- the columns, and a few walls -----------------------------------------------

// Every seven and a half metres each way: a car park's structural grid, three bays
// wide. A metre square — two tiles each way — stood on the open deck as wall
// tiles, so the shell draws them, nav steps round them and the validators measure
// them exactly as they do any wall.
const PILLAR_PITCH = 15;
const PILLAR_SIZE = 2;
const PILLAR_KEEP = 4;    // tiles a column keeps off doors, rooms and the ramps

// ...and a few free-standing concrete walls, so the deck is not one bare field of
// cars and columns: a car park has its stair cores, its plant enclosures and its
// fire walls. Four metres long and a tile thick, one per this many tiles of deck,
// each with `WALL_MARGIN` of open floor all round it.
const WALL_LEN = 8;
const WALL_PER = 2600;
const WALL_MARGIN = 2;

/**
 * Stands the columns and the walls, and returns where they all are (`kind`
 * 'column' or 'wall', in tiles) so the decks above can stand theirs on the same
 * spots and the minimap can draw them.
 *
 * Every block goes only where it stands ALONE on open floor — a ring of open tiles
 * all round it, two deep for a wall — so none of them can close a gap, only stand
 * in the middle of one. Off the lanes, and `PILLAR_KEEP` clear of doors, the two
 * rooms, the ramps and every room's centre tile (which half the generator and the
 * roster use as the one tile that stands for a room).
 */
export function standPillars(tiles, W, H, deck, kept, doors, ramps, rooms = [], seed = 0) {
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
  for (const r of rooms) {
    const cx = Math.round(r.cx), cy = Math.round(r.cy);
    mark(cx - 1, cy - 1, cx + 2, cy + 2);
  }

  // Whether a w x h block at (x, y) may stand, with `margin` tiles of open floor
  // round it.
  const fits = (x, y, w, h, margin) => {
    if (x - margin < deck.x0 || y - margin < deck.y0) return false;
    if (x + w + margin > deck.x1 || y + h + margin > deck.y1) return false;
    for (let ty = y - margin; ty < y + h + margin; ty++) {
      for (let tx = x - margin; tx < x + w + margin; tx++) {
        const t = tiles[ty * W + tx];
        if (t === SOLID) return false;
        const inside = tx >= x && tx < x + w && ty >= y && ty < y + h;
        if (inside && (avoid[ty * W + tx] || t === CORRIDOR)) return false;
      }
    }
    return true;
  };
  const stand = (x, y, w, h, kind) => {
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) tiles[ty * W + tx] = SOLID;
    return { x, y, w, h, kind };
  };

  const out = [];
  for (let y = deck.y0 + 7; y < deck.y1 - 2; y += PILLAR_PITCH) {
    for (let x = deck.x0 + 7; x < deck.x1 - 2; x += PILLAR_PITCH) {
      if (fits(x, y, PILLAR_SIZE, PILLAR_SIZE, 1)) out.push(stand(x, y, PILLAR_SIZE, PILLAR_SIZE, 'column'));
    }
  }

  // The walls: darts are fine here, because the count is small and a wall that
  // does not land is simply one fewer. On its own stream off the seed, for the
  // reason every other planning die is.
  const rng = makeRng((seed ^ 0x3c6ef372) >>> 0);
  const want = Math.round(((deck.x1 - deck.x0) * (deck.y1 - deck.y0)) / WALL_PER);
  for (let tries = 0, placed = 0; placed < want && tries < want * 40; tries++) {
    const across = rng() < 0.5;
    const w = across ? WALL_LEN : 1, h = across ? 1 : WALL_LEN;
    const x = deck.x0 + Math.floor(rng() * (deck.x1 - deck.x0 - w));
    const y = deck.y0 + Math.floor(rng() * (deck.y1 - deck.y0 - h));
    if (!fits(x, y, w, h, WALL_MARGIN)) continue;
    out.push(stand(x, y, w, h, 'wall'));
    placed++;
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

/**
 * A flight drawn as a concrete ramp: one solid wedge over the whole stairwell, in
 * place of the treads and their nosing.
 *
 * Only the PICTURE changes. The treads are still the colliders (stairBoxes), and
 * that is deliberate: nav, the player's step test and both validators already agree
 * about them, and a sloped collider is a thing this engine has never had.
 *
 * A WEDGE rather than a tilted slab, and that was the bug: a slab rotated about its
 * middle ends short of the well with a lip at the top and pokes its lower corner
 * down through whatever it stands on. The wedge sits flat on the floor its flight
 * starts from, rises along the nosing line half a riser up (so a foot on any tread
 * is within a tenth of a metre of the concrete), and meets the deck it arrives on
 * exactly flush — then runs flat to the end of the well, where the last tread
 * already does.
 */
export function rampGeometry(layout, plan) {
  const spec = rampSpec(layout, plan);
  const alongX = spec.alongX;
  const c0 = alongX ? layout.oz + plan.y0 * 0.5 : layout.ox + plan.x0 * 0.5;
  const c1 = alongX ? layout.oz + plan.y1 * 0.5 : layout.ox + plan.x1 * 0.5;
  const a0 = alongX ? layout.ox + plan.x0 * 0.5 : layout.oz + plan.y0 * 0.5;
  const a1 = alongX ? layout.ox + plan.x1 * 0.5 : layout.oz + plan.y1 * 0.5;
  const foot = spec.foot, up = spec.up;
  const far = up > 0 ? a1 : a0;
  const base = spec.base;
  const top = base + RAMP_RUN * RAMP_SLOPE * spec.dir;
  // Where the sloped face reaches the deck: half a riser of lift means it gets there
  // a little before the end of the run.
  const knee = foot + up * Math.max(0, RAMP_RUN - RISER / 2 / RAMP_SLOPE);

  // The profile along the run, as (along, height) — bottom front, top front, the
  // knee, top far, bottom far — extruded across the stairwell.
  const prof = [[foot, base], [foot, base + RISER / 2], [knee, top], [far, top], [far, base]];
  const P = (a, h, c) => (alongX ? [a, h, c] : [c, h, a]);
  const pos = [];
  const tri = (p, q, r) => pos.push(...p, ...q, ...r);
  const quad = (p, q, r, t) => { tri(p, q, r); tri(p, r, t); };
  // The sloped and flat top faces, and the two ends and the floor.
  for (let i = 1; i < prof.length - 1; i++) {
    const [aA, hA] = prof[i], [aB, hB] = prof[i + 1];
    quad(P(aA, hA, c0), P(aB, hB, c0), P(aB, hB, c1), P(aA, hA, c1));
  }
  quad(P(foot, base, c0), P(foot, base + RISER / 2, c0), P(foot, base + RISER / 2, c1), P(foot, base, c1));
  quad(P(far, top, c0), P(far, base, c0), P(far, base, c1), P(far, top, c1));
  // The two sides, as a fan over the profile.
  for (const c of [c0, c1]) {
    for (let i = 1; i < prof.length - 1; i++) {
      tri(P(prof[0][0], prof[0][1], c), P(prof[i][0], prof[i][1], c), P(prof[i + 1][0], prof[i + 1][1], c));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Faces wound either way above; double-sided normals off a non-indexed mesh are
  // what applyWorldUVs and the lighting want, so make every face face outward by
  // flipping any whose normal points into the wedge.
  orientOutward(geo, alongX ? (foot + far) / 2 : (c0 + c1) / 2, (base + top) / 3,
    alongX ? (c0 + c1) / 2 : (foot + far) / 2);
  geo.computeVertexNormals();
  // Filled in by applyWorldUVs, which writes into an attribute rather than adding one.
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return geo;
}

// Flips any triangle whose normal points toward (cx, cy, cz) — the wedge's inside.
function orientOutward(geo, cx, cy, cz) {
  const a = geo.attributes.position.array;
  for (let i = 0; i < a.length; i += 9) {
    const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2];
    const vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (a[i] + a[i + 3] + a[i + 6]) / 3 - cx;
    const my = (a[i + 1] + a[i + 4] + a[i + 7]) / 3 - cy;
    const mz = (a[i + 2] + a[i + 5] + a[i + 8]) / 3 - cz;
    if (nx * mx + ny * my + nz * mz >= 0) continue;
    for (let k = 0; k < 3; k++) {
      const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t;
    }
  }
}
