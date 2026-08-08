import { SOLID, isOpen } from './gen/layout.js';

// Navigation over the floor's tile grid.
//
// Enemies all chase the same target, so instead of pathfinding per enemy we
// flood one distance field out from the player and let every enemy walk
// downhill on it. One BFS a few times a second serves the whole floor, and it
// gives naturally converging routes through doorways without any steering
// cleverness.

const REPATH_INTERVAL = 0.3;   // seconds between flood fills
const LOS_STEP = 0.25;         // metres between line-of-sight samples

// Enemy body radius. Lives here rather than in enemies.js because the nav grid
// has to be eroded by it — see `fits` below.
export const BODY_RADIUS = 0.36;

export class NavGrid {
  constructor(nav) {
    this.W = nav.W;
    this.H = nav.H;
    this.TILE = nav.TILE;
    this.ox = nav.ox;
    this.oz = nav.oz;
    this.walk = nav.walk;
    this.tiles = nav.tiles;

    this.field = new Int32Array(this.W * this.H);
    this.queue = new Int32Array(this.W * this.H);
    this.fieldAge = Infinity;
    this.fieldOrigin = -1;

    // `walk` is where a *point* may stand; `fits` is where a whole body may.
    // Routing on `walk` and then moving with a radius test is a contradiction:
    // the field happily leads an enemy into a 0.4 m gap between two desks that
    // its 0.72 m body then refuses to enter, and it stalls there forever. So we
    // erode the grid by the body radius once per floor and path on that.
    this.fits = new Uint8Array(this.W * this.H);
    for (let ty = 0; ty < this.H; ty++) {
      for (let tx = 0; tx < this.W; tx++) {
        if (!this.walk[ty * this.W + tx]) continue;
        if (this.clear(this.wx(tx), this.wz(ty), BODY_RADIUS)) this.fits[ty * this.W + tx] = 1;
      }
    }
  }

  // A destroyed prop stops standing in the enemies' way. `indices` are the tiles
  // it was blocking, recorded when it was placed.
  //
  // Reopening a tile is not enough on its own: pathing runs on `fits`, the grid
  // eroded by the body radius, so the neighbours of a freed tile can become
  // passable too. They are re-tested out to the erosion radius, and the distance
  // field is invalidated so the next update floods through the new gap instead
  // of leaving everyone walking into a desk that is no longer there.
  openTiles(indices) {
    if (!indices?.length) return;

    let opened = false;
    for (const i of indices) {
      if (this.walk[i] || !isOpen(this.tiles[i])) continue;
      this.walk[i] = 1;
      opened = true;
    }
    if (!opened) return;

    const R = Math.ceil(BODY_RADIUS / this.TILE) + 1;
    for (const i of indices) {
      const cx = i % this.W, cy = (i / this.W) | 0;
      for (let ty = cy - R; ty <= cy + R; ty++) {
        for (let tx = cx - R; tx <= cx + R; tx++) {
          if (!this.inBounds(tx, ty)) continue;
          const j = ty * this.W + tx;
          this.fits[j] = this.walk[j] && this.clear(this.wx(tx), this.wz(ty), BODY_RADIUS) ? 1 : 0;
        }
      }
    }

    this.fieldAge = Infinity;
  }

  tx(x) { return Math.floor((x - this.ox) / this.TILE); }
  ty(z) { return Math.floor((z - this.oz) / this.TILE); }
  wx(tx) { return (tx + 0.5) * this.TILE + this.ox; }
  wz(ty) { return (ty + 0.5) * this.TILE + this.oz; }

  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.W && ty < this.H; }

  walkable(tx, ty) {
    return this.inBounds(tx, ty) && this.walk[ty * this.W + tx] === 1;
  }

  // Can a whole body stand centred on this tile? This is what pathing uses.
  fitsAt(tx, ty) {
    return this.inBounds(tx, ty) && this.fits[ty * this.W + tx] === 1;
  }

  // Is a body of the given radius clear of walls and furniture here?
  clear(x, z, radius) {
    const t0x = this.tx(x - radius), t1x = this.tx(x + radius);
    const t0z = this.ty(z - radius), t1z = this.ty(z + radius);
    for (let ty = t0z; ty <= t1z; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        if (!this.walkable(tx, ty)) return false;
      }
    }
    return true;
  }

  // Nothing solid between two points at the same height. Sampled rather than
  // stepped exactly — walls are half a metre thick, so quarter-metre samples
  // cannot slip through one.
  losClear(ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    const steps = Math.ceil(dist / LOS_STEP);
    if (steps === 0) return true;

    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const tx = this.tx(ax + dx * t);
      const ty = this.ty(az + dz * t);
      if (!this.inBounds(tx, ty) || this.tiles[ty * this.W + tx] === SOLID) return false;
    }
    return true;
  }

  // Refreshes the distance field if it has gone stale or the target has moved
  // to a different tile. Cheap enough to call every frame.
  updateField(dt, targetX, targetZ) {
    this.fieldAge += dt;
    const tx = this.tx(targetX);
    const ty = this.ty(targetZ);
    if (!this.inBounds(tx, ty)) return;

    const origin = ty * this.W + tx;
    if (this.fieldAge < REPATH_INTERVAL && origin === this.fieldOrigin) return;

    this.fieldAge = 0;
    this.fieldOrigin = origin;
    this._flood(tx, ty);
  }

  _flood(sx, sy) {
    const { W, H, fits, field, queue } = this;
    field.fill(-1);

    // The player is often standing somewhere no enemy body fits (on a desk, in
    // a corner) — start from the nearest tile where one does.
    if (!this.fitsAt(sx, sy)) {
      let found = false;
      for (let r = 1; r <= 8 && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            if (this.fitsAt(sx + dx, sy + dy)) { sx += dx; sy += dy; found = true; }
          }
        }
      }
      if (!found) return;
    }

    let head = 0, tail = 0;
    const start = sy * W + sx;
    field[start] = 0;
    queue[tail++] = start;

    while (head < tail) {
      const i = queue[head++];
      const x = i % W, y = (i / W) | 0;
      const d = field[i] + 1;

      if (x > 0 && field[i - 1] === -1 && fits[i - 1]) { field[i - 1] = d; queue[tail++] = i - 1; }
      if (x < W - 1 && field[i + 1] === -1 && fits[i + 1]) { field[i + 1] = d; queue[tail++] = i + 1; }
      if (y > 0 && field[i - W] === -1 && fits[i - W]) { field[i - W] = d; queue[tail++] = i - W; }
      if (y < H - 1 && field[i + W] === -1 && fits[i + W]) { field[i + W] = d; queue[tail++] = i + W; }
    }
  }

  // Direction of steepest descent on the field, as a world-space unit vector.
  // Returns null when the mover is stranded off the field.
  descend(x, z, out) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return null;

    const here = this.field[ty * this.W + tx];
    if (here < 0) return null;

    let bestX = 0, bestZ = 0, best = here;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (!this.fitsAt(tx + dx, ty + dy)) continue;
        // Diagonals are only legal if both orthogonal neighbours are open, so
        // nobody clips a wall corner.
        if (dx && dy && (!this.fitsAt(tx + dx, ty) || !this.fitsAt(tx, ty + dy))) continue;

        const d = this.field[(ty + dy) * this.W + (tx + dx)];
        if (d >= 0 && d < best) { best = d; bestX = dx; bestZ = dy; }
      }
    }

    if (!bestX && !bestZ) return null;
    // Aim at the centre of the chosen tile rather than along the raw tile
    // offset, which keeps movement off the diagonals of the grid.
    const dx = this.wx(tx + bestX) - x;
    const dz = this.wz(ty + bestZ) - z;
    const len = Math.hypot(dx, dz) || 1;
    out.set(dx / len, 0, dz / len);
    return out;
  }

  // How far, in tiles, this point is from the field's origin (-1 if unreached).
  distanceAt(x, z) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return -1;
    return this.field[ty * this.W + tx];
  }
}
