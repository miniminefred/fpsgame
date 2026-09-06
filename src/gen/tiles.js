// The tile vocabulary the whole floor is written in.
//
// A floorplan is a Uint8Array of TILE-metre cells plus the handful of operations
// everything else performs on it: what a cell can be, whether you can stand in
// it, where it is in world space, how far it is from somewhere else, and how to
// fill or seal a rectangle of them.
//
// It is its own file because it has NO dependencies and three unrelated callers.
// gen/layout.js generates the grid, gen/locks.js proves things about it, and
// gen/build.js turns it into meshes — and outside gen/, so do nav.js, enemies.js,
// cameras.js and minimap.js. Anything all of those need is vocabulary rather than
// anybody's implementation detail, and keeping it here is what stops layout.js
// and locks.js having to import each other.

export const TILE = 0.5;           // metres per tile
export const WALL_H = 3.2;         // structural wall height
export const CEIL_H = 3.0;         // suspended ceiling height
export const DOOR_H = 2.1;

// Tiles of floor kept clear on either side of a doorway. It lives here because
// two unrelated things have to honour it and neither can import the other:
// `reserveClearances` in gen/build.js stamps it so no prop is ever furnished into
// a door swing, and gen/stairs.js keeps a staircase out of the same square. They
// were briefly 4 and 3, and the sweep found it immediately as a crate standing in
// a doorway — which is the FIRST_CONTACT_GAP failure in miniature.
export const DOOR_CLEAR = 4;

export const SOLID = 0;
export const ROOM = 1;
export const CORRIDOR = 2;
export const DOOR = 3;

export const isOpen = (t) => t !== SOLID;

/**
 * What is at a tile, with anything off the grid reading SOLID.
 *
 * Five files wrote this line out for themselves, which is four more chances to
 * get the bounds test wrong in a loop that is walking a wall. Off the grid is
 * SOLID rather than undefined for the same reason the building has a PAD of
 * shell around it: every caller is asking "can I put something here", and the
 * honest answer outside the building is no.
 */
export const tileAt = (tiles, W, H, x, y) =>
  (x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : SOLID);

/**
 * The four quarter turns, as the directions they face.
 *
 * Everything in this game that faces somewhere faces -Z at rotation 0 and turns
 * toward +X — a prop authored in gen/props.js, a body whose yaw `standAt` sets
 * from a station's `rot`, the `side` an `edgeProp` is backed against. This is
 * that convention written down once as a table, because it is needed in the
 * three files that have to turn a rotation back into a direction (enemies.js,
 * chores.js, panels.js) and `edgeProp` in gen/rooms.js documents at length what
 * happens when it is written out by hand at each site: it comes out as four
 * pairs of coordinates and half of them are backwards.
 *
 * It is `QUARTER[rot](0, -1)` from gen/props.js, evaluated. Kept here rather
 * than imported from there because the three callers have no other business
 * with the furniture catalogue.
 *
 * It doubles as the four orthogonal TILE steps — `FACING[side]` is `[dx, dy]` on
 * the grid as readily as `[dx, dz]` in metres, because a tile is square and the
 * axes are the same two. `wallBeside` below indexes it that way.
 */
export const FACING = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * The same four steps in the order the PLACERS walk them, which is not the same
 * order and deliberately so.
 *
 * `FACING` is indexed by a rotation, so its order is the game's rotation order
 * and cannot move. This one is only ever iterated — "try each wall beside this
 * tile" — so its order is arbitrary, and it is written down once here because
 * cameras.js, conveyors.js and panels.js each had their own copy of the same
 * literal. Two tables rather than one is the honest answer: they are the same
 * four directions asked two different questions.
 */
export const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Tile <-> world helpers. The building is centred on the origin.
//
// There are two world positions for a tile and they are half a tile apart:
// `worldX` gives its CORNER, `centreX` gives its middle. That distinction is not
// pedantry — it is the prologue bug written down. The generator measured the
// first-contact gap from one and the consumer measured it from the other, and
// the half tile between round() and floor() on the spawn tile moved the count by
// nine, which is how a floor you could not start shipped. Whenever you convert,
// say which of the two you meant.
export const worldX = (l, tx) => tx * l.TILE + l.ox;
export const worldZ = (l, ty) => ty * l.TILE + l.oz;
export const centreX = (l, tx) => (tx + 0.5) * l.TILE + l.ox;
export const centreZ = (l, ty) => (ty + 0.5) * l.TILE + l.oz;
export const tileX = (l, x) => Math.floor((x - l.ox) / l.TILE);
export const tileY = (l, z) => Math.floor((z - l.oz) / l.TILE);

// Breadth-first tile distances over open floor. -1 means unreachable.
export function bfs(tiles, W, H, sx, sy) {
  const dist = new Int32Array(W * H).fill(-1);
  if (!isOpen(tiles[sy * W + sx])) {
    // Nudge to the nearest open tile so a bad seed point can't kill the flood.
    let found = false;
    for (let r = 1; r < 12 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          const x = sx + dx, y = sy + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          if (isOpen(tiles[y * W + x])) { sx = x; sy = y; found = true; }
        }
      }
    }
    if (!found) return dist;
  }

  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  dist[sy * W + sx] = 0;
  queue[tail++] = sy * W + sx;

  while (head < tail) {
    const i = queue[head++];
    const x = i % W, y = (i / W) | 0;
    const d = dist[i] + 1;

    if (x > 0 && dist[i - 1] === -1 && isOpen(tiles[i - 1])) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < W - 1 && dist[i + 1] === -1 && isOpen(tiles[i + 1])) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (y > 0 && dist[i - W] === -1 && isOpen(tiles[i - W])) { dist[i - W] = d; queue[tail++] = i - W; }
    if (y < H - 1 && dist[i + W] === -1 && isOpen(tiles[i + W])) { dist[i + W] = d; queue[tail++] = i + W; }
  }

  return dist;
}

/**
 * Which way a sliding panel in this doorway could retract, or 0 for neither.
 *
 * A retracted panel has to go somewhere, and where it goes is inside the wall
 * beside the opening — so the wall has to BE there: the full width of the panel,
 * on the same line, solid the whole way. Near a corner it is not, and a door
 * fitted there would slide out into the corridor and hang in mid-air at right
 * angles to its own frame.
 *
 * It lives here rather than in gen/build.js, which is what actually fits the
 * doors, because assignLocks has to ask the same question: a doorway that cannot
 * hold a panel cannot hold a locked one either, and a lock with no door in it is
 * a hole with a badge reader next to it.
 *
 * Which is also why it is in THIS file rather than in gen/locks.js beside the
 * only generator code that calls it. Both askers have to get the same answer, and
 * the two of them — the lock pass and the door fitter — sit on opposite sides of
 * generation with no import between them. Putting the question in the vocabulary
 * is what keeps there being exactly one of it.
 */
/**
 * How many consecutive SOLID tiles the wall carries on beyond an opening, in one
 * direction, up to `max`.
 *
 * `slidePocketSide` above answers whether a panel FITS; this answers how much room
 * it has, which is a different question and the one the builder needs. A panel
 * slides a hair further than its own width so that its trailing edge finishes
 * inside the jamb rather than flush with it — and on the doorways where the wall
 * carries on for exactly the proven minimum, that hair put the panel's far end 3 cm
 * out the other side of the wall and into the next room. Measured over five floors:
 * 3 to 6 doors each, 3-4 cm of panel edge standing in open space.
 */
export function slidePocketRun(tiles, W, H, door, dir, max = 12) {
  let run = 0;
  for (let i = 1; i <= max; i++) {
    const step = dir > 0 ? doorSpan(door) - 1 + i : -i;
    const ok = door.vertical
      ? tileAt(tiles, W, H, door.x0, door.y0 + step) === SOLID
      : tileAt(tiles, W, H, door.x0 + step, door.y0) === SOLID;
    if (!ok) break;
    run++;
  }
  return run;
}

// How many tiles wide the opening is, along the wall it is cut in.
export const doorSpan = (d) => (d.vertical ? d.y1 - d.y0 : d.x1 - d.x0);

/**
 * ...and the same question asked as a yes/no: is there a pocket at least a
 * panel long, on `prefer` if possible and on the other side if not.
 *
 * It is `slidePocketRun` measured against the panel's own width, and it used to
 * be a second copy of the same wall walk with the loop written inside out. Two
 * copies of "walk the wall beside a doorway" is exactly the drift this file
 * exists to prevent — they disagreeing by one tile is a door that slides into
 * the room next door.
 */
export function slidePocketSide(tiles, W, H, door, prefer = 1) {
  const span = doorSpan(door);
  const fits = (dir) => slidePocketRun(tiles, W, H, door, dir, span) === span;
  return fits(prefer) ? prefer : fits(-prefer) ? -prefer : 0;
}

/**
 * Which of a room's four walls a door sits on, in the same 0/1/2/3 = +z/-x/-z/+x
 * convention `edgeProp` and `QUARTER` use in gen/props.js — the door's own
 * side IS the quarter-turn a wall-backed prop needs to face into the room from
 * that wall, so a caller wanting "the wall opposite the door" just adds 2 mod 4.
 *
 * Measured from the door's centre to each of the room's four walls rather than
 * compared against `room.x0/x1/y0/y1` directly, because that comparison has to
 * get the door rect's inclusive/exclusive edges exactly right and a door is a
 * wall-thickness tile OUTSIDE the room, not one of its interior tiles. Nearest
 * wall is right regardless, and a door only has one wall to be near.
 */
export function doorSide(door, room) {
  const cx = (door.x0 + door.x1) / 2, cy = (door.y0 + door.y1) / 2;
  const dist = [room.y1 - cy, cx - room.x0, cy - room.y0, room.x1 - cx];
  let best = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(dist[i]) < Math.abs(dist[best])) best = i;
  return best;
}

/**
 * Somewhere to put something, in a shuffled order — every tile of the floor that
 * passes the test, walked rather than sampled.
 *
 * FOUR modules had their own copy of this loop and CLAUDE.md records the same
 * lesson under each of them, which is the tell: a tile that survives a placer's
 * own tests is a few percent of a floor, so throwing darts at the grid delivers
 * three parcel lines on one floor and nine on the next, four cameras and then
 * ten, one washing machine and then five. Walking a shuffled list of every
 * candidate is what makes a count a count.
 *
 * The four differed in two details and nothing else, so both are options:
 *
 *  - `kinds` is what the tile itself has to be. Corridors only for the parcel
 *    lines, the service openings and the washing machines — all three are the
 *    building's own services and belong where the traffic is, and one running
 *    the length of somebody's private office is a different building. Cameras
 *    take rooms too, because a camera in an office is an ordinary camera.
 *  - `wall` asks for a SOLID neighbour, because a thing that hangs off a wall
 *    needs one; a washing machine stands on the floor and does not.
 *
 * `locked` skips the rooms behind a badge reader. A camera you cannot walk up to
 * can neither catch you nor be shot out, which is two thirds of what one is for.
 *
 * `margin` is how far off the edge of the grid to start. It is 1 for anything
 * that only looks at its own four neighbours and 2 for anything that needs a
 * little more room; below that the neighbour reads would run off the grid, which
 * is what `tileAt` is for everywhere else and what an explicit margin is for in
 * a hot double loop.
 */
export function siteWalk(layout, rng, { kinds, wall = false, locked = false, margin = 1 }) {
  const { W, H, tiles } = layout;
  const out = [];
  for (let ty = margin; ty < H - margin; ty++) {
    for (let tx = margin; tx < W - margin; tx++) {
      const i = ty * W + tx;
      if (!kinds.includes(tiles[i])) continue;
      if (locked && layout.locked?.[i]) continue;
      if (wall && tiles[i - 1] !== SOLID && tiles[i + 1] !== SOLID
        && tiles[i - W] !== SOLID && tiles[i + W] !== SOLID) continue;
      out.push(i);
    }
  }
  return rng.shuffle(out);
}

/**
 * Which of a tile's four neighbours is wall, starting the search at `from`.
 *
 * The three things that hang off a corridor wall — a camera, a parcel line, a
 * service opening — each wrote this out, and a camera's copy carries the reason
 * the start point is an argument: begun at the same side every time, a floor's
 * cameras all end up on their tiles' east wall.
 *
 * Returns the STEP toward the wall, which is `FACING[side]`, or null.
 */
export function wallBeside(tiles, W, H, tx, ty, from = 0) {
  for (let k = 0; k < 4; k++) {
    const side = (from + k) & 3;
    const [dx, dy] = FACING[side];
    if (tileAt(tiles, W, H, tx + dx, ty + dy) === SOLID) return [dx, dy];
  }
  return null;
}

// --- rectangle fills and tile tests -----------------------------------------
//
// A room and a doorway are both just rectangles of tiles, and the lock proofs
// spend all their time filling them in, sealing them shut, or asking whether a
// given cell is one of them. None of these knows anything about locks.

export function fillRect(tiles, W, r, value) {
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) tiles[y * W + x] = value;
  }
}

// Sealing a doorway is filling its rect with wall. It had a name of its own and
// an identical body; a room and a doorway are both rectangles of tiles, which is
// the whole reason this section is not about rooms or about doors.
export const sealDoor = (tiles, W, d) => fillRect(tiles, W, d, SOLID);

export const rectHasTile = (r, W, i) => {
  const x = i % W, y = (i / W) | 0;
  return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
};

export const anyRectTile = (r, W, hit) => {
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) if (hit(y * W + x)) return true;
  }
  return false;
};
