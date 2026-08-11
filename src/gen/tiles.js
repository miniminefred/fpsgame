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
export function slidePocketSide(tiles, W, H, door, prefer = 1) {
  const at = (tx, ty) => (tx >= 0 && ty >= 0 && tx < W && ty < H ? tiles[ty * W + tx] : SOLID);
  const span = door.vertical ? door.y1 - door.y0 : door.x1 - door.x0;

  const fits = (dir) => {
    for (let i = 1; i <= span; i++) {
      if (door.vertical) {
        const ty = dir > 0 ? door.y1 - 1 + i : door.y0 - i;
        if (at(door.x0, ty) !== SOLID) return false;
      } else {
        const tx = dir > 0 ? door.x1 - 1 + i : door.x0 - i;
        if (at(tx, door.y0) !== SOLID) return false;
      }
    }
    return true;
  };

  return fits(prefer) ? prefer : fits(-prefer) ? -prefer : 0;
}

// --- rectangle fills and tile tests -----------------------------------------
//
// A room and a doorway are both just rectangles of tiles, and the lock proofs
// spend all their time filling them in, sealing them shut, or asking whether a
// given cell is one of them. None of these knows anything about locks.

export function fillRoom(tiles, W, room, value) {
  for (let y = room.y0; y < room.y1; y++) {
    for (let x = room.x0; x < room.x1; x++) tiles[y * W + x] = value;
  }
}

export function sealDoor(tiles, W, d) {
  for (let y = d.y0; y < d.y1; y++) {
    for (let x = d.x0; x < d.x1; x++) tiles[y * W + x] = SOLID;
  }
}

export const doorHasTile = (d, W, i) => {
  const x = i % W, y = (i / W) | 0;
  return x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1;
};

export const anyDoorTile = (d, W, reached) => {
  for (let y = d.y0; y < d.y1; y++) {
    for (let x = d.x0; x < d.x1; x++) if (reached(y * W + x)) return true;
  }
  return false;
};
