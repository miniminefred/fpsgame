import * as THREE from 'three';
import { CORRIDOR, FACING, SOLID, worldX, worldZ } from './gen/tiles.js';
import { getTech } from './tech-textures.js';

/**
 * Service openings: a hole in the wall with the building's wiring hanging out.
 *
 * The fifth thing a theme does to the BUILDING rather than to who is standing in
 * it, alongside the tint, the floor units, the parcel lines and a washing
 * machine that gets off the ground. A floor being worked by machines is a floor
 * with its covers off — an access panel swung open, a loom of conduit pulled out
 * of it, and somebody stood in front of it with both arms in the wall (see the
 * `panel` job in chores.js, which is the only reason these exist).
 *
 * IT IS FITTED FLAT AGAINST THE PLASTER, and that is what makes it safe to put
 * into a finished floor without re-proving one invariant. The deepest thing here
 * stands 0.22 m off a wall face at chest height, in a corridor 3 m wide: it
 * touches no nav tile, reserves no floor, blocks no doorway and cannot make a
 * room unreachable however it lands. It is the same licence conveyors.js takes
 * for the opposite reason — that one clears everything by being ABOVE it, this
 * one by being barely there — and it is the reason neither needs a collider from
 * the player's point of view. A badge reader has stood proud of a jamb since the
 * first floor was generated on exactly this argument.
 *
 * The meshes ARE hittable, though, which is a different question: a bullet that
 * passes through a bundle of cables and marks the wall ten centimetres behind
 * them is the one way this reads as a decal rather than as an object.
 *
 * WHERE THEY GO is the cameras' and the parcel lines' walk, for their reason: a
 * shuffled list of every corridor tile with a wall beside it, taken in order
 * until enough have survived every test. Throwing darts at the grid delivers two
 * on this floor and nine on the next, because a tile that passes everything is a
 * few percent of a floor.
 */

// The opening itself: wide enough to get both arms into, and centred at the
// height a body can actually reach — an arm here has no elbow and its hand tops
// out at 1.96 m (see `armAt` in enemy-anim.js), so a panel any higher is one
// nobody can be shown working on.
const OPEN_W = 0.62;
const OPEN_H = 0.78;
const OPEN_Y = 1.55;

// THE HOLE IS PAINTED ON, and it has to be: a wall in this game is one merged
// box in a batched chunk (see gen/geom.js) and nothing at runtime may cut a
// piece out of it. So the dark that reads as an opening is a near-black plate
// standing a few millimetres PROUD of the plaster, and what sells the depth is
// the lip around it standing proud of THAT — look into it and the frame's inner
// faces are between you and the black, which is what a recess looks like.
//
// It is the same trick the windows use one wall along, from the other side: the
// sky behind the glazing is a permanent backdrop rather than a hole in the
// shell, because the shell is never cut either.
const DARK_D = 0.03;           // the black plate, barely off the plaster
const FRAME_T = 0.05;          // the lip's bars, across
const FRAME_D = 0.09;          // ...and how far they stand proud of the black
const COVER_T = 0.02;          // the swung-open door
// ...and how far it is swung. Well past square, so the leaf lies back toward
// the plaster and keeps out of the walkway — a corridor is 3 m and a door
// standing at a right angle to the wall is 0.6 m of it, at chest height, with
// nothing to collide against. It is deliberately not flat against the wall
// either: a door swung the whole way back is a door with nothing holding it,
// and the gap is what catches the light along its edge.
const SWING = 2.1;
const PROUD = 0.012;           // clear of the plaster, so nothing z-fights

// The trunking the loom runs into, above and below the opening. It is what stops
// a hole in a wall reading as damage: wires coming out of a duct were installed,
// wires coming out of bare plaster were torn out.
const DUCT_W = 0.17;
const DUCT_D = 0.05;

// The loom. Deliberately a real spread of colours and pointedly NOT charred or
// dulled, for the reason the generator's severed wiring gives: this is the only
// colour on an otherwise grey wall, and a few centimetres of red and blue is
// what says the thing is wired.
const WIRES = [6, 10];
const WIRE_R = 0.010;
const WIRE_SEGS = 3;           // per wire, drooping a joint at a time
// Short. Three of these plus the droop reaches about a third of a metre out of
// the wall, which is a loom pulled out to be worked on; twice that is a bundle
// of cable lying across the corridor, and the corridor is only 3 m wide.
const WIRE_SEG = [0.09, 0.17];
const WIRE_COLS = [0xc0392b, 0x2b6cc0, 0xd8a12a, 0x2f9e52, 0xdededa, 0x6a4b2a];

// How far in front of the wall FACE somebody stands to work on it.
//
// Derived rather than chosen: the site is a corridor tile against the wall, so
// its centre is half a tile off the plaster, and a body standing there does not
// fit — `fits` is the walk grid eroded by a body's radius, and a tile with a
// solid neighbour is exactly what that erosion takes. One tile further in is the
// nearest a body can legally stand, so that is where the spot goes, and it is
// then asked rather than assumed.
const STAND_TILES = 1;

const MIN_GAP = 11;            // metres between two of them

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Panels {
  constructor({ scene }) {
    this.scene = scene;
    this.groups = [];
    this.meshes = [];          // what bullets test against
    // Where somebody stands to work on one, handed to chores.js. The one station
    // pool on the floor that does NOT come down the furnisher's `workstation`
    // pipe, because these are fitted after the floor is finished — the same
    // position the parcel lines are in.
    this.spots = [];

    // Shared by every panel the game will ever build, released on dispose. One
    // unit box and one unit cylinder scaled per piece: there is nothing else to
    // say about the geometry of a hole in a wall.
    this.geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      wire: new THREE.CylinderGeometry(WIRE_R, WIRE_R, 1, 5),
    };
    const tech = getTech();
    this.mats = {
      // The lip and the trunking, in the same plating finish the machines wear —
      // which is the point of using it here: this is plant, not furniture.
      frame: new THREE.MeshStandardMaterial({
        map: tech.plate, color: 0x454b53, roughness: 0.55, metalness: 0.45,
      }),
      cover: new THREE.MeshStandardMaterial({
        map: tech.plate, color: 0x585f68, roughness: 0.5, metalness: 0.5,
      }),
      // The inside of the opening. Nearly black and rough, because what makes a
      // recess read as a recess is that no light comes back out of it.
      dark: new THREE.MeshStandardMaterial({ color: 0x0d0f11, roughness: 1 }),
      wires: WIRE_COLS.map((color) => new THREE.MeshStandardMaterial({
        color, roughness: 0.85,
      })),
    };
  }

  /**
   * Cuts this floor's service openings, if its theme has any.
   *
   * `nav` is needed and not optional: the whole placement rests on being able to
   * ask whether a body fits at the spot in front of the wall, and a panel nobody
   * can stand at is a panel nobody can be found working on — which is the only
   * thing these are for.
   */
  spawn(layout, nav, rng, theme) {
    this.clear();
    const want = theme?.panels;
    if (!want || !nav) return;

    // Scaled by how the slab came out, like the cameras, the corridor crowd and
    // the parcel lines: a fixed count over a floor half again the usual size is
    // a quieter floor for no reason the player could read.
    const n = Math.max(1, Math.round(rng.int(want[0], want[1]) * (layout.areaRatio ?? 1)));

    const sites = this._sites(layout, rng);
    let next = 0;
    for (let i = 0; i < n; i++) {
      let site = null;
      while (next < sites.length && !site) site = this._measure(layout, nav, sites[next++]);
      if (!site) break;
      this._build(site, rng);
    }
  }

  // Every corridor tile with a wall beside it, shuffled. Corridors only, for the
  // parcel line's reason: this is the building's own services, and a hole in the
  // wall of somebody's private office is a different kind of story.
  _sites(layout, rng) {
    const { W, H, tiles } = layout;
    const out = [];
    for (let ty = 1; ty < H - 1; ty++) {
      for (let tx = 1; tx < W - 1; tx++) {
        const i = ty * W + tx;
        if (tiles[i] !== CORRIDOR) continue;
        if (tiles[i - 1] === SOLID || tiles[i + 1] === SOLID
          || tiles[i - W] === SOLID || tiles[i + W] === SOLID) out.push(i);
      }
    }
    return rng.shuffle(out);
  }

  /**
   * Which wall this tile hangs a panel off, where the panel goes, and where the
   * body that works on it stands — or null, if any of the three does not answer.
   *
   * The standing spot is proved with `fitsAt` rather than `clear`, and that is
   * the distinction `deskPool` in enemies.js paid for at length: `clear` is a
   * point test and `fitsAt` is the same test at the TILE CENTRE, which is what
   * every flood and every `descendOn` actually runs on. A spot that passes one
   * and fails the other is a spot a body walks to and can then never leave.
   */
  _measure(layout, nav, i) {
    const { W, tiles, TILE } = layout;
    const tx = i % W, ty = (i / W) | 0;

    for (const [wx, wz] of DIRS) {
      if (tiles[(ty + wz) * W + tx + wx] !== SOLID) continue;
      // Never the facade. `buildWindows` glazes the first solid a facade sees,
      // up to seven tiles in, and a service riser cut into a window is not a
      // thing a building has — it is two pieces of geometry in the same place.
      // Asked of the wall rather than of a distance from the edge, because the
      // glazing is not at a fixed depth: it follows the first open tile in each
      // row, so a corridor forty tiles long can be facade at one end and not at
      // the other. Measured on one floor before this was here: one panel in
      // four landed on glass.
      if (outerWall(layout, tx, ty, wx, wz)) continue;
      // The tile a body stands on: one in from the wall, and it has to be
      // corridor and it has to hold a body.
      const sx = tx - wx * STAND_TILES;
      const sy = ty - wz * STAND_TILES;
      if (tiles[sy * W + sx] !== CORRIDOR) continue;
      if (!nav.fitsAt(sx, sy)) continue;

      // The wall face, and the panel just clear of it.
      const face = TILE / 2 - PROUD;
      const x = worldX(layout, tx + 0.5) + wx * face;
      const z = worldZ(layout, ty + 0.5) + wz * face;

      const site = {
        x, z, wx, wz,
        // Turned so the frame's local -Z points OUT of the wall, which is the
        // convention every prop and every body in this game faces on and what
        // lets everything below be written as metres across, up and out.
        //
        // A body at yaw t faces (-sin t, -cos t) — that is `standAt` in
        // enemies.js and FACING read together. Out of the wall is (-wx, -wz),
        // so sin t = wx and cos t = wz. Getting this backwards is not subtle
        // and it is not obvious either: it turns the frame end for end, which
        // buries the black plate inside the plaster where nothing can see it and
        // hangs every wire in the loom behind the wall. What you get is a bare
        // dark rectangle standing off the corridor with no cables on it, which
        // looks like a deliberately plain prop rather than like a mistake.
        yaw: Math.atan2(wx, wz),
        stand: {
          x: worldX(layout, sx + 0.5),
          z: worldZ(layout, sy + 0.5),
          // The quarter turn that faces the wall, which is `FACING` read
          // backwards — the wall is at (wx, wz) from where the body stands.
          rot: FACING.findIndex(([fx, fz]) => fx === wx && fz === wz),
        },
      };

      // Not on top of another one. Two openings in one stretch of corridor is
      // one opening's worth of story, however you count them.
      if (this.spots.some((s) => Math.hypot(s.x - site.stand.x, s.z - site.stand.z) < MIN_GAP)) {
        return null;
      }
      return site;
    }
    return null;
  }

  _build(site, rng) {
    // Turned so its local -Z points out of the wall, which is the convention
    // every prop and every body in this game faces on. Everything below is then
    // measured in metres across, up, and out, with no trigonometry in it.
    const group = new THREE.Group();
    group.position.set(site.x, 0, site.z);
    group.rotation.y = site.yaw;
    this.scene.add(group);
    this.groups.push(group);
    this.spots.push(site.stand);

    const slab = (mat, w, h, d, x, y, z, hittable = true) => {
      const m = new THREE.Mesh(this.geo.box, mat);
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      m.castShadow = true;
      group.add(m);
      if (hittable) this.meshes.push(m);
      return m;
    };

    // The black that reads as the opening, a few millimetres off the plaster.
    // Not hittable: a round that goes into a hole in the wall should mark the
    // wall, and there is nothing here for it to stop on.
    slab(this.mats.dark, OPEN_W, OPEN_H, DARK_D, 0, OPEN_Y, -DARK_D / 2, false);

    // The lip around it: four bars standing proud of the black, the two uprights
    // running the full height so the corners are closed. This is what makes the
    // black read as a recess rather than as a poster.
    for (const sx of [-1, 1]) {
      slab(this.mats.frame, FRAME_T, OPEN_H + FRAME_T * 2, FRAME_D,
        sx * (OPEN_W + FRAME_T) / 2, OPEN_Y, -FRAME_D / 2);
    }
    for (const sy of [-1, 1]) {
      slab(this.mats.frame, OPEN_W, FRAME_T, FRAME_D,
        0, OPEN_Y + sy * (OPEN_H + FRAME_T) / 2, -FRAME_D / 2);
    }

    // The trunking the loom disappears into. Above and below, because a service
    // riser runs the height of the building and this is one window onto it.
    for (const sy of [-1, 1]) {
      const h = sy < 0 ? OPEN_Y - OPEN_H / 2 : 1.2;
      slab(this.mats.frame, DUCT_W, h, DUCT_D,
        0, sy < 0 ? h / 2 : OPEN_Y + OPEN_H / 2 + h / 2, -DUCT_D / 2);
    }

    // The cover, hung off one side and swung open against the wall. It is the
    // cheapest thing here and it does most of the work: a rectangle of dark in a
    // wall could be anything, and a rectangle of dark with its own door standing
    // open beside it is a panel somebody opened.
    const hinge = rng.chance(0.5) ? -1 : 1;
    const cover = new THREE.Group();
    cover.position.set(hinge * (OPEN_W + FRAME_T) / 2, OPEN_Y, -FRAME_D);
    // MINUS the hinge, and the sign is the whole of whether this is a door or a
    // slab buried in the plaster. A positive turn about Y takes local -X toward
    // -Z... on the far side of the frame and toward +Z on the near one, so one
    // of the two hinges has to swing the other way round to end up outside the
    // wall. Both were positive at first and the right-hand one swung its leaf
    // straight into the building.
    cover.rotation.y = -hinge * SWING;
    group.add(cover);
    const leaf = new THREE.Mesh(this.geo.box, this.mats.cover);
    leaf.scale.set(OPEN_W, OPEN_H, COVER_T);
    leaf.position.set(-hinge * OPEN_W / 2, 0, 0);
    leaf.castShadow = true;
    cover.add(leaf);
    this.meshes.push(leaf);

    // ...and the loom itself. Each wire leaves the back of the opening pointing
    // out and then droops a joint at a time, which is the whole difference
    // between a cable and a spike — the same trick the generator's severed
    // wiring uses, and the same reason it is worth the three segments.
    const n = rng.int(WIRES[0], WIRES[1]);
    for (let i = 0; i < n; i++) {
      const mat = this.mats.wires[rng.int(0, this.mats.wires.length - 1)];
      let x = rng.range(-OPEN_W / 2 + 0.05, OPEN_W / 2 - 0.05);
      let y = OPEN_Y + rng.range(-OPEN_H / 2 + 0.06, OPEN_H / 2 - 0.06);
      let z = -DARK_D;
      // Out of the wall first, then increasingly downward: a cable with no
      // stiffness left over hangs, and one that has just left a clip does not.
      let pitch = rng.range(-0.35, 0.35);
      for (let s = 0; s < WIRE_SEGS; s++) {
        const len = rng.range(WIRE_SEG[0], WIRE_SEG[1]);
        const dz = -Math.cos(pitch) * len;
        const dy = -Math.sin(pitch) * len;
        const seg = new THREE.Mesh(this.geo.wire, mat);
        seg.scale.set(1, len, 1);
        seg.position.set(x, y + dy / 2, z + dz / 2);
        // A cylinder is authored up its own +Y, so it is turned onto the
        // direction it runs in. Turning +Y by `a` about X points it at
        // (0, cos a, sin a) — note the sign, which is the one that matters here
        // — and the segment runs along (0, -sin p, -cos p), so a = -(PI/2 + p).
        //
        // Worth being exact about, because the failure is not a wire at a funny
        // angle. Every segment's POSITION is computed from the direction and
        // chained onto the end of the last one, so an axis that disagrees leaves
        // each piece centred where it belongs and pointing somewhere else: what
        // comes out is not a bent cable, it is a hole in the wall with a dozen
        // coloured sticks floating in front of it. Both wrong signs were tried
        // before this one, and from head-on, where a wire coming straight at you
        // is foreshortened to nothing, both looked plausible. It reads only from
        // the side.
        seg.rotation.x = -(Math.PI / 2 + pitch);
        group.add(seg);
        this.meshes.push(seg);
        x += rng.range(-0.02, 0.02);
        y += dy;
        z += dz;
        pitch += rng.range(0.35, 0.95);
      }
    }
  }

  clear() {
    for (const group of this.groups) {
      this.scene.remove(group);
      group.clear();
    }
    this.groups.length = 0;
    this.meshes.length = 0;
    this.spots.length = 0;
  }

  dispose() {
    this.clear();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mats)) {
      if (Array.isArray(m)) for (const one of m) one.dispose();
      else m.dispose();
    }
  }
}

/**
 * Whether the wall next to this tile is the outside of the building.
 *
 * Walks outward from the wall and asks whether anything opens up again before
 * the grid runs out. Nothing does on a facade, by definition — which is exactly
 * the question `buildWindows` in gen/build.js answers from the other end when it
 * decides where the glazing goes.
 */
function outerWall(layout, tx, ty, wx, wz) {
  const { W, H, tiles } = layout;
  let x = tx + wx;
  let y = ty + wz;
  while (x > 0 && y > 0 && x < W - 1 && y < H - 1) {
    if (tiles[y * W + x] !== SOLID) return false;
    x += wx;
    y += wz;
  }
  return true;
}
