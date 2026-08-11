import { isOpen } from './gen/layout.js';
import { BODY_RADIUS } from './metrics.js';

// Navigation over the floor's tile grid.
//
// Enemies all chase the same target, so instead of pathfinding per enemy we
// flood one distance field out from the player and let every enemy walk
// downhill on it. One BFS a few times a second serves the whole floor, and it
// gives naturally converging routes through doorways without any steering
// cleverness.

const REPATH_INTERVAL = 0.3;   // seconds between flood fills
const LOS_STEP = 0.25;         // metres between line-of-sight samples

// How far soundPath will walk looking for the opening a sound comes out of.
// Anything further away than this has been attenuated to nothing anyway, and the
// walk runs per placed sound, so it is not allowed to be unbounded.
const MAX_SOUND_STEPS = 64;

// Enemy body radius. Re-exported here because the nav grid has to be eroded by
// it (see `fits` below) and enemies.js has always taken it from this module;
// the number itself now lives in metrics.js with the rest of the body.
export { BODY_RADIUS };

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

    // And a third grid: what you can see THROUGH. It starts as the shell — a
    // wall stops a line and nothing else does, because furniture is chest high
    // and a doorway with no door in it is a hole.
    //
    // It is separate from `walk` because the two questions genuinely differ in
    // both directions. A filing cabinet is walkable-through-no but see-over-yes;
    // a shut door is the reverse of nothing — it is no to both, but only while
    // it happens to be shut, and doors.js is what knows that. See setSight.
    this.sight = new Uint8Array(this.W * this.H);
    for (let i = 0; i < this.W * this.H; i++) this.sight[i] = isOpen(this.tiles[i]) ? 1 : 0;
  }

  /**
   * A door just opened or shut, and a shut door is not a window.
   *
   * This is the one part of the nav grid that changes several times a second,
   * and it is driven from doors.js rather than sampled here because the door is
   * what knows how far along its travel it is. Only the panel's own tiles are
   * touched, so two doorways into the same room stay independent.
   */
  setSight(indices, clear) {
    if (!indices?.length) return;
    const v = clear ? 1 : 0;
    for (const i of indices) {
      // Never open a line through something the building itself is made of.
      if (v && !isOpen(this.tiles[i])) continue;
      this.sight[i] = v;
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

  // Nothing solid between two points at the same height — walls, and whatever
  // doors are shut right now. Sampled rather than stepped exactly: walls are
  // half a metre thick and a door panel fills its whole tile, so quarter-metre
  // samples cannot slip through either.
  //
  // This one function is what decides whether an enemy has seen you, and — since
  // their fire is not a raycast against the building — whether they can shoot
  // you. It also decides which ceiling fixtures may light you (lighting.js) and
  // which way round a corner a sound arrives from (soundPath below). All three
  // want the same answer, which is why they share it.
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
      if (!this.inBounds(tx, ty) || !this.sight[ty * this.W + tx]) return false;
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
    this._flood(tx, ty, this.field);
  }

  /**
   * A distance field of someone else's, flooded from wherever they are going.
   *
   * The shared field is flooded from the player, which is all any enemy chasing
   * you needs. Anyone going somewhere *else* — the staffer looking for a toilet
   * — has no route in it at all, and walking straight at a destination means
   * walking into the wall between here and there. Giving them a field of their
   * own is the same BFS, and at one flood every few seconds for one or two of
   * them it costs nothing measurable.
   *
   * Returns false when the destination is not reachable, which is the caller's
   * cue to pick a different one.
   */
  floodTo(field, x, z) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return false;
    this._flood(tx, ty, field);
    return field[ty * this.W + tx] >= 0 || this.fitsAt(tx, ty);
  }

  /** A field sized for this floor, for floodTo to fill. */
  makeField() {
    return new Int32Array(this.W * this.H);
  }

  _flood(sx, sy, field) {
    const { W, H, fits, queue } = this;
    field.fill(-1);

    // The origin is often somewhere no body fits (on a desk, in a corner, a
    // metre inside a wall) — start from the nearest tile where one does.
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

  // How far a point is from the field's origin (the player) *through the
  // building* rather than through its walls, in metres. -1 when off the field.
  //
  // This is the honest measure of "how far away is that", and the flood has
  // already paid for it. Straight-line distance says an enemy on the far side of
  // a wall is close by; it is one metre away and a thirty metre walk.
  pathDistance(x, z) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return -1;
    const d = this.field[ty * this.W + tx];
    return d < 0 ? -1 : d * this.TILE;
  }

  /**
   * Where a sound made at (sx, sz) should appear to come from, heard from
   * (lx, lz).
   *
   * Sound does not go through a wall, it goes around it and out of a doorway, so
   * a shout from the next room should arrive from the door — not from the blank
   * plaster it happens to be standing behind. Panning a source at its true
   * position gets that exactly wrong, and the error is worst in precisely the
   * case you most want to trust your ears.
   *
   * The route is already known: the field is flooded from the listener, so
   * walking downhill from the source retraces the path sound would take. The
   * first point on it that the listener can actually see is the opening it comes
   * out of. `detour` is how far it travelled to get there, which is what makes a
   * voice two rooms away quieter than one behind the same wall.
   *
   * Returns null if the source is off the field, in which case the caller should
   * fall back to the true position.
   */
  soundPath(sx, sz, lx, lz) {
    if (this.losClear(sx, sz, lx, lz)) {
      return { x: sx, z: sz, detour: 0, occluded: false };
    }

    let tx = this.tx(sx), ty = this.ty(sz);
    if (!this.inBounds(tx, ty)) return null;
    let here = this.field[ty * this.W + tx];
    if (here < 0) return null;

    const { W, field } = this;
    for (let step = 1; step <= MAX_SOUND_STEPS; step++) {
      // Steepest descent, four-connected to match the flood.
      let bx = 0, by = 0, best = here;
      if (tx > 0 && field[ty * W + tx - 1] >= 0 && field[ty * W + tx - 1] < best) {
        best = field[ty * W + tx - 1]; bx = -1; by = 0;
      }
      if (tx < W - 1 && field[ty * W + tx + 1] >= 0 && field[ty * W + tx + 1] < best) {
        best = field[ty * W + tx + 1]; bx = 1; by = 0;
      }
      if (ty > 0 && field[(ty - 1) * W + tx] >= 0 && field[(ty - 1) * W + tx] < best) {
        best = field[(ty - 1) * W + tx]; bx = 0; by = -1;
      }
      if (ty < this.H - 1 && field[(ty + 1) * W + tx] >= 0 && field[(ty + 1) * W + tx] < best) {
        best = field[(ty + 1) * W + tx]; bx = 0; by = 1;
      }
      if (!bx && !by) break;   // a local minimum that still cannot see the ear

      tx += bx; ty += by; here = best;
      const wx = this.wx(tx), wz = this.wz(ty);
      if (this.losClear(wx, wz, lx, lz)) {
        return { x: wx, z: wz, detour: step * this.TILE, occluded: true };
      }
    }

    return null;
  }

  // Direction of steepest descent on the shared player field.
  descend(x, z, out) {
    return this.descendOn(this.field, x, z, out);
  }

  // Direction of steepest descent on any field, as a world-space unit vector.
  // Returns null when the mover is stranded off it.
  descendOn(field, x, z, out) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return null;

    const here = field[ty * this.W + tx];
    if (here < 0) return null;

    let bestX = 0, bestZ = 0, best = here;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (!this.fitsAt(tx + dx, ty + dy)) continue;
        // Diagonals are only legal if both orthogonal neighbours are open, so
        // nobody clips a wall corner.
        if (dx && dy && (!this.fitsAt(tx + dx, ty) || !this.fitsAt(tx, ty + dy))) continue;

        const d = field[(ty + dy) * this.W + (tx + dx)];
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
