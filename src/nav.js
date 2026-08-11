import { isOpen } from './gen/layout.js';
import { BODY_RADIUS } from './metrics.js';
import { MAX_TILE_RISE, rampHeight } from './gen/stairs.js';

// Navigation over the floor's tile grid.
//
// Enemies all chase the same target, so instead of pathfinding per enemy we
// flood one distance field out from the player and let every enemy walk
// downhill on it. One BFS a few times a second serves the whole floor, and it
// gives naturally converging routes through doorways without any steering
// cleverness.
//
// **The grid has two LAYERS**, because the building has attics and basements
// (gen/stairs.js) and one of them sits on exactly the same tiles as the room it
// belongs to. Layer 0 is the ground floor. Layer 1 is every other level at once —
// which works because no two of them ever overlap: a room gets at most one
// staircase, so at most one level above or below it.
//
// Every grid here is therefore `2 * W * H` long, with layer 1 at offset `W * H`,
// and every index is `layer * WH + ty * W + tx`. Layer 0 sits at offset zero on
// purpose: everything that only ever meant the ground floor — a door opening, a
// badge grid, a sound walking round a corner — keeps indexing exactly as it did.
//
// The two layers are joined at the STAIRWELLS and nowhere else. `cross` marks
// those tiles, the flood steps between layers on them, and `descendOn` will take
// that step if it is downhill — which is the whole of how an enemy follows you up
// a staircase. A flight is one continuous ramp, so a body's HEIGHT inside a
// stairwell comes from where it is along the flight rather than from its layer
// (`rampY`), and switching layer half way up is invisible.

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
    this.tiles = nav.tiles;

    const WH = this.W * this.H;
    this.WH = WH;

    // Layer 0 is the ground floor and layer 1 is every attic and basement — see
    // the note at the top of the file for why one layer holds all of them.
    const levels = nav.levels ?? null;
    this.walk = new Uint8Array(WH * 2);
    this.walk.set(nav.walk, 0);
    if (levels) this.walk.set(levels.walk, WH);

    // Where the two layers are joined, which is the stairwells and nothing else.
    this.cross = levels ? levels.cross : new Uint8Array(WH);
    // The height of the walking surface. On a level it is that level's floor; inside
    // a stairwell it is the flight, sampled CONTINUOUSLY from the ramp rather than
    // per tile — a body climbing must rise smoothly, not in 33 cm jerks — and the
    // layer does not come into it, because a flight is one surface.
    this.levelY = levels ? levels.levelY : new Float32Array(WH);
    this.ramps = levels ? levels.ramps : [];
    this.rampAt = levels ? levels.rampAt : new Int8Array(WH).fill(-1);

    // ...and the same heights at tile centres, which is what the flood and the
    // downhill step compare. Precomputed because they ask per neighbour per tile.
    this.surfaceY = new Float32Array(WH * 2);
    for (let layer = 0; layer < 2; layer++) {
      for (let ty = 0; ty < this.H; ty++) {
        for (let tx = 0; tx < this.W; tx++) {
          this.surfaceY[layer * WH + ty * this.W + tx] =
            this.heightAt(this.wx(tx), this.wz(ty), layer);
        }
      }
    }

    this.field = new Int32Array(WH * 2);
    this.queue = new Int32Array(WH * 2);
    this.fieldAge = Infinity;
    this.fieldOrigin = -1;

    // The second grid, for whoever is carrying a badge — nothing until
    // setBadgeTiles says otherwise. See it for why it exists at all.
    this.badgeWalk = null;
    this.badgeFits = null;
    this.badgeField = null;
    this.badgeAge = Infinity;
    this.badgeOrigin = -1;

    // `walk` is where a *point* may stand; `fits` is where a whole body may.
    // Routing on `walk` and then moving with a radius test is a contradiction:
    // the field happily leads an enemy into a 0.4 m gap between two desks that
    // its 0.72 m body then refuses to enter, and it stalls there forever. So we
    // erode the grid by the body radius once per floor and path on that.
    this.fits = new Uint8Array(WH * 2);
    for (let layer = 0; layer < 2; layer++) {
      const base = layer * WH;
      for (let ty = 0; ty < this.H; ty++) {
        for (let tx = 0; tx < this.W; tx++) {
          if (!this.walk[base + ty * this.W + tx]) continue;
          if (this._clearOn(this.walk, this.wx(tx), this.wz(ty), BODY_RADIUS, base)) {
            this.fits[base + ty * this.W + tx] = 1;
          }
        }
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
    this.sight = new Uint8Array(WH * 2);
    for (let i = 0; i < WH; i++) this.sight[i] = isOpen(this.tiles[i]) ? 1 : 0;
    // A level is one open room with a lid — there is nothing inside it to see
    // through, so its own walkable floor is exactly what can be seen across.
    if (levels) for (let i = 0; i < WH; i++) this.sight[WH + i] = levels.sight[i];
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
      // The badge grid is a superset of this one, so whatever opens here opens
      // there — and it has to be told, or a badge holder keeps routing round a
      // desk that is no longer standing.
      if (this.badgeWalk) this.badgeWalk[i] = 1;
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
          const x = this.wx(tx), z = this.wz(ty);
          this.fits[j] = this.walk[j] && this._clearOn(this.walk, x, z, BODY_RADIUS) ? 1 : 0;
          if (this.badgeFits) {
            this.badgeFits[j] =
              this.badgeWalk[j] && this._clearOn(this.badgeWalk, x, z, BODY_RADIUS) ? 1 : 0;
          }
        }
      }
    }

    this.fieldAge = Infinity;
    this.badgeAge = Infinity;
  }

  /**
   * The openings a badge gets you through, and the grid that comes with them.
   *
   * A locked doorway is out of the nav grid entirely (see gen/build.js), which
   * is what stops a chase piling up against a door the chasers cannot open. That
   * is the right default and it stays the default — but it is also a statement
   * about who is walking, not about the building, and one group on the floor is
   * carrying the badge: the security response to an alarm, who are coming
   * through their own office door whatever it says on the reader.
   *
   * So they get a grid of their own: `walk` plus these tiles, eroded by the body
   * radius the same way, and a distance field flooded over it. Everybody else
   * keeps routing on the grid that has the locks in it, so the exception is
   * exactly as wide as the people it was granted to.
   *
   * `indices` comes from doors.js rather than from here, because which locks a
   * badge actually opens is the door's business — and the sensor that swings the
   * panel and the field that routes a body into it must not be able to disagree.
   */
  setBadgeTiles(indices) {
    this.badgeWalk = null;
    this.badgeFits = null;
    this.badgeField = null;
    this.badgeAge = Infinity;
    this.badgeOrigin = -1;
    if (!indices?.length) return;

    // Ground floor only, and deliberately: the alarm response comes through its own
    // office door, not up somebody's attic stairs. Layer 1 stays empty, so the flood
    // simply never crosses for them.
    const walk = Uint8Array.from(this.walk);
    let any = false;
    for (const i of indices) {
      if (i < 0 || i >= this.WH || walk[i] || !isOpen(this.tiles[i])) continue;
      walk[i] = 1;
      any = true;
    }
    // Nothing on this floor is shut to them that is not already open, so the
    // second field would be a copy of the first and is not worth flooding.
    if (!any) return;

    this.badgeWalk = walk;
    this.badgeFits = new Uint8Array(this.WH * 2);
    for (let ty = 0; ty < this.H; ty++) {
      for (let tx = 0; tx < this.W; tx++) {
        const i = ty * this.W + tx;
        if (!walk[i]) continue;
        if (this._clearOn(walk, this.wx(tx), this.wz(ty), BODY_RADIUS)) this.badgeFits[i] = 1;
      }
    }
    this.badgeField = new Int32Array(this.WH * 2);
  }

  tx(x) { return Math.floor((x - this.ox) / this.TILE); }
  ty(z) { return Math.floor((z - this.oz) / this.TILE); }
  wx(tx) { return (tx + 0.5) * this.TILE + this.ox; }
  wz(ty) { return (ty + 0.5) * this.TILE + this.oz; }

  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.W && ty < this.H; }

  walkable(tx, ty, layer = 0) {
    return this.inBounds(tx, ty) && this.walk[layer * this.WH + ty * this.W + tx] === 1;
  }

  // Can a whole body stand centred on this tile? This is what pathing uses.
  // `fits` names which eroded grid is being asked — see setBadgeTiles.
  fitsAt(tx, ty, fits = this.fits, layer = 0) {
    return this.inBounds(tx, ty) && fits[layer * this.WH + ty * this.W + tx] === 1;
  }

  // Is a body of the given radius clear of walls and furniture here?
  clear(x, z, radius, layer = 0) {
    return this._clearOn(this.walk, x, z, radius, layer * this.WH);
  }

  /**
   * How high the walking surface is at a point, on a given layer.
   *
   * Inside a stairwell it is the ramp, and the layer does not come into it: a
   * flight is one surface, so an enemy half way up is half way up whichever layer
   * the field currently has it on. That is what makes switching layer invisible.
   */
  heightAt(x, z, layer = 0) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return 0;
    const i = ty * this.W + tx;
    const r = this.rampAt[i];
    if (r >= 0) return rampHeight(this.ramps[r], x, z);
    return layer ? this.levelY[i] : 0;
  }

  /** Which layer a point belongs to if it is standing on a level, else 0. */
  layerAt(x, z) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return 0;
    return this.walk[this.WH + ty * this.W + tx] ? 1 : 0;
  }

  // The same question asked by somebody who can open a locked door. Routing on
  // the badge field and then testing against `walk` is the contradiction the
  // erosion note above warns about, one lock further out: the field would lead
  // them into a doorway their own collision test then refuses to enter.
  clearBadge(x, z, radius) {
    return this._clearOn(this.badgeWalk ?? this.walk, x, z, radius);
  }

  _clearOn(grid, x, z, radius, base = 0) {
    const t0x = this.tx(x - radius), t1x = this.tx(x + radius);
    const t0z = this.ty(z - radius), t1z = this.ty(z + radius);
    for (let ty = t0z; ty <= t1z; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        if (!this.inBounds(tx, ty) || grid[base + ty * this.W + tx] !== 1) return false;
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
  losClear(ax, az, bx, bz, aLayer = 0, bLayer = 0) {
    // Across layers there is a floor slab in the way, and the one place you can see
    // through it is the hole the stairs come through. Both ends inside the same
    // stairwell is the case that matters: somebody at the foot of a flight and
    // somebody at the head of it are looking straight at each other.
    if (aLayer !== bLayer) {
      if (!this._inWell(ax, az) || !this._inWell(bx, bz)) return false;
    }
    const base = aLayer * this.WH;

    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    const steps = Math.ceil(dist / LOS_STEP);
    if (steps === 0) return true;

    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const tx = this.tx(ax + dx * t);
      const ty = this.ty(az + dz * t);
      if (!this.inBounds(tx, ty)) return false;
      const j = ty * this.W + tx;
      // A stairwell is open on both layers, so a line through one is never stopped
      // by whichever layer it was measured on.
      if (this.rampAt[j] >= 0) continue;
      if (!this.sight[base + j]) return false;
    }
    return true;
  }

  // On a flight of stairs — the whole shaft, not just the landing where the two
  // layers are joined. Somebody at the foot and somebody at the head are looking
  // straight at each other, and only one of them is standing on the join.
  _inWell(x, z) {
    const tx = this.tx(x), ty = this.ty(z);
    return this.inBounds(tx, ty) && this.rampAt[ty * this.W + tx] >= 0;
  }

  // Refreshes the distance field if it has gone stale or the target has moved
  // to a different tile. Cheap enough to call every frame.
  //
  // `badge` asks for the second field as well (see setBadgeTiles). It is a whole
  // extra flood of the floor, so it is paid for only while somebody who can walk
  // it is alive — which on most floors, for most of their length, is nobody.
  updateField(dt, targetX, targetZ, targetLayer = 0, badge = false) {
    this.fieldAge += dt;
    this.badgeAge += dt;
    const tx = this.tx(targetX);
    const ty = this.ty(targetZ);
    if (!this.inBounds(tx, ty)) return;

    const origin = targetLayer * this.WH + ty * this.W + tx;
    if (this.fieldAge >= REPATH_INTERVAL || origin !== this.fieldOrigin) {
      this.fieldAge = 0;
      this.fieldOrigin = origin;
      this._flood(tx, ty, targetLayer, this.field);
    }

    if (!badge || !this.badgeField) return;
    if (this.badgeAge < REPATH_INTERVAL && origin === this.badgeOrigin) return;
    this.badgeAge = 0;
    this.badgeOrigin = origin;
    // The response walks the ground floor, so their field is flooded on it — if you
    // are up an attic staircase they come to the foot of it like everybody else.
    this._flood(tx, ty, 0, this.badgeField, this.badgeFits);
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
    this._flood(tx, ty, 0, field);
    return field[ty * this.W + tx] >= 0 || this.fitsAt(tx, ty);
  }

  /** A field sized for this floor, for floodTo to fill. */
  makeField() {
    return new Int32Array(this.WH * 2);
  }

  _flood(sx, sy, sLayer, field, fits = this.fits) {
    const { W, H, WH, queue, cross, surfaceY } = this;
    field.fill(-1);
    // A step is a step, not a cliff — the same rule the player's collision has, and
    // nav needs it now that the floor is not all at one height. It is what stops a
    // body on a landing stepping sideways off it into the middle of the shaft, which
    // it happily did until the nav sweep caught a walker changing height by 3 m in
    // one step. The tolerance is a flight's own rise over a tile, so walking UP a
    // staircase is still walking and only walking ACROSS one is refused.
    const near = (a, b) => Math.abs(surfaceY[a] - surfaceY[b]) <= MAX_TILE_RISE + 1e-6;

    // The origin is often somewhere no body fits (on a desk, in a corner, a
    // metre inside a wall) — start from the nearest tile where one does, on the
    // origin's own layer.
    if (!this.fitsAt(sx, sy, fits, sLayer)) {
      let found = false;
      for (let r = 1; r <= 8 && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            if (this.fitsAt(sx + dx, sy + dy, fits, sLayer)) { sx += dx; sy += dy; found = true; }
          }
        }
      }
      if (!found) return;
    }

    let head = 0, tail = 0;
    const start = sLayer * WH + sy * W + sx;
    field[start] = 0;
    queue[tail++] = start;

    while (head < tail) {
      const i = queue[head++];
      const base = i < WH ? 0 : WH;
      const j = i - base;                 // the tile, without its layer
      const x = j % W, y = (j / W) | 0;
      const d = field[i] + 1;

      if (x > 0 && field[i - 1] === -1 && fits[i - 1] && near(i, i - 1)) { field[i - 1] = d; queue[tail++] = i - 1; }
      if (x < W - 1 && field[i + 1] === -1 && fits[i + 1] && near(i, i + 1)) { field[i + 1] = d; queue[tail++] = i + 1; }
      if (y > 0 && field[i - W] === -1 && fits[i - W] && near(i, i - W)) { field[i - W] = d; queue[tail++] = i - W; }
      if (y < H - 1 && field[i + W] === -1 && fits[i + W] && near(i, i + W)) { field[i + W] = d; queue[tail++] = i + W; }

      // ...and the staircase. One step, straight up or down, on the tiles where the
      // two layers are joined — which is what makes a route between floors a route
      // rather than a special case somewhere else in the code.
      if (cross[j]) {
        const other = base ? j : WH + j;
        if (field[other] === -1 && fits[other]) { field[other] = d; queue[tail++] = other; }
      }
    }
  }

  // How far a point is from the field's origin (the player) *through the
  // building* rather than through its walls, in metres. -1 when off the field.
  //
  // This is the honest measure of "how far away is that", and the flood has
  // already paid for it. Straight-line distance says an enemy on the far side of
  // a wall is close by; it is one metre away and a thirty metre walk.
  pathDistance(x, z, layer = 0) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return -1;
    const d = this.field[layer * this.WH + ty * this.W + tx];
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
  soundPath(sx, sz, lx, lz, sLayer = 0, lLayer = 0) {
    if (this.losClear(sx, sz, lx, lz, sLayer, lLayer)) {
      return { x: sx, z: sz, detour: 0, occluded: false };
    }

    let tx = this.tx(sx), ty = this.ty(sz);
    if (!this.inBounds(tx, ty)) return null;
    const base = sLayer * this.WH;
    let here = this.field[base + ty * this.W + tx];
    if (here < 0) return null;

    const { W, field } = this;
    for (let step = 1; step <= MAX_SOUND_STEPS; step++) {
      // Steepest descent, four-connected to match the flood.
      let bx = 0, by = 0, best = here;
      if (tx > 0 && field[base + ty * W + tx - 1] >= 0 && field[base + ty * W + tx - 1] < best) {
        best = field[base + ty * W + tx - 1]; bx = -1; by = 0;
      }
      if (tx < W - 1 && field[base + ty * W + tx + 1] >= 0 && field[base + ty * W + tx + 1] < best) {
        best = field[base + ty * W + tx + 1]; bx = 1; by = 0;
      }
      if (ty > 0 && field[base + (ty - 1) * W + tx] >= 0 && field[base + (ty - 1) * W + tx] < best) {
        best = field[base + (ty - 1) * W + tx]; bx = 0; by = -1;
      }
      if (ty < this.H - 1 && field[base + (ty + 1) * W + tx] >= 0 && field[base + (ty + 1) * W + tx] < best) {
        best = field[base + (ty + 1) * W + tx]; bx = 0; by = 1;
      }
      if (!bx && !by) break;   // a local minimum that still cannot see the ear

      tx += bx; ty += by; here = best;
      const wx = this.wx(tx), wz = this.wz(ty);
      if (this.losClear(wx, wz, lx, lz, sLayer, lLayer)) {
        return { x: wx, z: wz, detour: step * this.TILE, occluded: true };
      }
    }

    return null;
  }

  // Direction of steepest descent on the shared player field.
  descend(x, z, out, layer = 0) {
    return this.descendOn(this.field, x, z, out, this.fits, layer);
  }

  // The same, for somebody who can open a locked door. Falls back to the shared
  // field on a floor with no badge grid, which is the same answer: without a
  // lock in the way the two fields agree tile for tile.
  descendBadge(x, z, out, layer = 0) {
    if (!this.badgeField) return this.descend(x, z, out, layer);
    return this.descendOn(this.badgeField, x, z, out, this.badgeFits, layer);
  }

  /**
   * Direction of steepest descent on any field, as a world-space unit vector.
   *
   * Returns null when the mover is stranded off the field. `out.layer` is set to
   * the layer the step lands on, which is how a body ends up on a staircase: the
   * cross-layer neighbour of a stairwell tile is just another neighbour, and it is
   * taken when it is the downhill one. It never changes the direction of travel —
   * a flight is a ramp and the mover keeps walking along it — so the caller only
   * has to remember which layer it is on now.
   */
  descendOn(field, x, z, out, fits = this.fits, layer = 0) {
    const tx = this.tx(x), ty = this.ty(z);
    if (!this.inBounds(tx, ty)) return null;

    const WH = this.WH;
    const here = field[layer * WH + ty * this.W + tx];
    if (here < 0) return null;

    const WHl = layer * WH;
    const hereY = this.surfaceY[WHl + ty * this.W + tx];
    let bestX = 0, bestZ = 0, best = here, bestLayer = layer;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (!this.fitsAt(tx + dx, ty + dy, fits, layer)) continue;
        // The same no-cliff rule the flood uses, or a body would be sent over the
        // edge of a landing by a field that never routed it there.
        if (Math.abs(this.surfaceY[WHl + (ty + dy) * this.W + (tx + dx)] - hereY)
            > MAX_TILE_RISE + 1e-6) continue;
        // Diagonals are only legal if both orthogonal neighbours are open, so
        // nobody clips a wall corner.
        if (dx && dy &&
            (!this.fitsAt(tx + dx, ty, fits, layer) ||
             !this.fitsAt(tx, ty + dy, fits, layer))) continue;

        const d = field[layer * WH + (ty + dy) * this.W + (tx + dx)];
        if (d >= 0 && d < best) { best = d; bestX = dx; bestZ = dy; bestLayer = layer; }
      }
    }

    // The step onto the other layer, where the stairwell joins them. Taken on its
    // own if it is the steepest, and then the walk continues in the direction the
    // new layer wants — otherwise a body switching layer would stall for a frame at
    // the top of every flight.
    const tile = ty * this.W + tx;
    if (this.cross[tile]) {
      const other = layer ? 0 : 1;
      const d = field[other * WH + tile];
      if (d >= 0 && d < best && fits[other * WH + tile]) {
        const stepped = this.descendOn(field, x, z, out, fits, other);
        out.layer = other;
        return stepped ?? out.set(0, 0, 0);
      }
    }

    if (!bestX && !bestZ) return null;
    // Aim at the centre of the chosen tile rather than along the raw tile
    // offset, which keeps movement off the diagonals of the grid.
    const dx = this.wx(tx + bestX) - x;
    const dz = this.wz(ty + bestZ) - z;
    const len = Math.hypot(dx, dz) || 1;
    out.set(dx / len, 0, dz / len);
    out.layer = bestLayer;
    return out;
  }
}
