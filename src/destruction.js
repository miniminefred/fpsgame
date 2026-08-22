import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { eraseSpan, boxBetween } from './gen/geom.js';
import { BodyPool } from './body-pool.js';
import { Arcs } from './arcs.js';

// Everything on the floor coming apart.
//
// There are two kinds of destructible and they are destroyed by opposite means,
// which is the whole reason this module exists:
//
//   * Loose props (chairs, crates) are already their own mesh and their own
//     rigid body. Breaking one is "delete the mesh, re-emit its boxes".
//   * Everything else — desks, shelving, vending machines, window glazing,
//     ceiling tubes — was merged into a batched chunk at generation time and has
//     no mesh of its own to delete. Breaking one means erasing its vertices in
//     place (see `eraseSpan`) and then re-emitting the boxes it was authored
//     from, which the generator captured for exactly this purpose.
//
// Both paths converge on the same debris pool: a capped, timed-out set of loose
// boxes, so a long run can never accumulate rubble until the frame rate dies.
//
// Routing a bullet to the right destructible is the other half of the problem. A
// raycast against a batched chunk hits a mesh shared by a hundred props, so the
// mesh identity tells us nothing. What it does give us is `faceIndex`, and a
// prop's vertices are a contiguous run inside that buffer — so a binary search
// over the runs on that mesh names the prop exactly. No spatial guessing, no
// tolerance to tune, and it stays correct for a pane of glass sitting three
// centimetres in front of a wall.

const DEBRIS_LIFETIME = 16;    // seconds a fragment lies around before it fades
const MAX_DEBRIS = 120;        // hard cap on live fragments, oldest recycled first
const MAX_FRAGMENTS = 14;      // pieces one prop may break into, largest first

// A fragment is judged on its LONGEST side, not its shortest. Office furniture
// is panel goods — a desktop, a monitor, a shelf, a pane of glass are all a
// centimetre or two thick — so a filter that wanted every dimension to clear a
// threshold threw away almost everything worth watching fall.
const MIN_FRAGMENT = 0.06;     // metres, longest side
// Thin slabs are given a little body to collide with. Cannon will happily
// simulate a 2 mm box, but it tunnels and jitters through the floor; the visible
// mesh keeps its real thickness, only the collision box is padded.
const MIN_BODY = 0.03;

// Effective density for a fragment whose prop never declared a mass. Office
// furniture is mostly air and thin panel, so this is far below solid timber.
const DENSITY = 300;
const MAX_FRAGMENT_MASS = 40;

// How long the ceiling keeps coming down after the generator goes. See
// blackoutPanels: this is a budget for the WORK, not a delay on the sound, and
// that is the whole point of it. Long enough that two hundred tubes are two
// hundred tubes rather than one crack, short enough to still read as one event.
const BLACKOUT_RAIN = 1.2;
// And a ceiling on how much of that budget one frame may spend, so a frame that
// was already long cannot cash in the whole backlog and undo the spreading.
const BLACKOUT_MAX_PER_FRAME = 8;

// How many of those panels are allowed to make a NOISE, and this is the number
// the whole bug came down to. Two hundred tubes and two hundred falls of glass
// is ~400 voices, each with a panner and most with a lowpass, all started inside
// a second and all lasting longer than that — and a measurement taken while
// somebody was hearing the fault found 388 of them live at once and the audio
// clock 2.7 SECONDS behind the wall clock. A WebAudio context that far behind
// real time has stopped being able to render, which is the floor going silent.
//
// The engine is right not to have a voice cap (see sfx.js) and this is the other
// half of that bargain: deciding a sound should not have been ASKED for belongs
// to whoever understands the event. Two hundred tubes going across a whole
// building is one ceiling coming down to a player standing in one room of it,
// and the tubes out of earshot were never audible — the panner's falloff and the
// occlusion filter had already taken them to nothing. They were pure cost.
const BLACKOUT_VOICES = 16;

// How much of its own colour a burnt surface keeps (see `_wreck`). Scorched
// rather than black: derived from each surface's own material instead of one
// flat soot colour, so a wreck still reads as the several materials it was
// welded out of and not as an untextured slab. Roughness goes near matte and
// metalness to nothing, because what is left is oxide, not steel.
const CHAR = 0.24;
const CHAR_ROUGHNESS = 0.94;

// A wreck is cut into BAYS before any of it is kept, because the machine is
// authored as a few enormous boxes — one housing 15 m long — and a hole has to
// be smaller than the thing it is a hole in. Cut on the two longest axes only:
// the shallow one stays whole, since a hole you cannot see into is triangles.
//
// The size is what a ROUND hole costs, and it is set by the SMALLEST hole, not
// by the machine. A blast boundary drawn on a grid of cubes is only as circular
// as the cubes are small: at 0.85 the corner came out as a flight of stairs, and
// at 0.42 the corner was fine but the bullet hole — 0.55 m of radius, barely
// two and a half bays across — came out as a five-cell PLUS, which is what a
// rasterised circle looks like when you can count the pixels. A hole wants
// roughly four bays across its radius before the eye stops seeing the grid, so
// this is HOLE_R / 2 and not a number chosen by eye.
//
// It is not free — a bay is twelve triangles, and quartering the size quadruples
// how many of them there are — and at this size the whole machine came to two
// thousand boxes and the frame that built it took 181 ms. That is a quarter of
// a second of freeze on the ONE frame the game already works hardest to keep
// cheap: the generator's own death, which is also a ceiling coming down, four
// hundred fragments and a floor-wide relight (see BLACKOUT_RAIN).
//
// So the fine grid is spent only where it is looked at. A coarse bay that a
// blast boundary does not cross is either wholly gone or wholly kept, and a
// 0.85 m box in the middle of a solid machine looks exactly like the nine small
// ones it would have been cut into. Only the shell around each hole is cut fine.
const BAY = 0.26;
const BAY_COARSE = 0.85;

// The machine comes apart in exactly TWO places, and that is the whole design of
// it. Damage scattered evenly over a wreck is texture — it reads as corrosion,
// or as a mesh with holes in it. Damage you can point at is an EVENT: this went
// up at one end, and that little hole is where the round that finished it went
// in. Two causes, two sizes, and the small one is aimed by the player.
//
//   The corner: one upper end of the machine, picked at random, taken out to a
//   radius set by how long the machine is — a fixed 3 m is most of a five-metre
//   machine and a dent in a fifteen-metre one.
const CORNER_SHARE = 0.3;
const CORNER_MIN = 1.8;
const CORNER_MAX = 3.6;
//   ...and capped again against how TALL it is, which is what keeps it an upper
//   corner. A generator is 4.2 m to the cap and only 0.55 of that is protected,
//   so a radius chosen off a twelve-metre length alone reaches the plinth and
//   the machine reads as having lost that whole END rather than its corner.
const CORNER_RISE = 0.62;
//   The last round: a hole you could put an arm through, wherever it landed. It
//   has to stay obviously smaller than the corner or there are just two blasts.
const HOLE_R = 0.55;
// Neither edge may be a perfect arc — but only just. This was 0.3 back when the
// boundary was a flight of 0.85 m steps and no amount of wobble could have made
// it look drawn with a compass; now that the bays are small enough to describe a
// circle, that much noise is the only thing stopping it from being one. The
// TORN metal is what makes an edge look violent (see SPIKES below), not a
// wandering radius, and the two do different jobs: the rim is jagged, the hole
// is round.
const RAG = 0.1;

// Torn plating around the rim of each hole. This is what actually sells a round
// hole in a world made of boxes: the eye reads the ring of spikes as the circle,
// and it reads them as metal that was ripped rather than a shape that was
// subtracted. They are generated ON the blast sphere, so they follow the same
// curve the bays were removed against, and only where the sphere actually cut
// material — a spike hanging in the air where the machine never reached is the
// one thing that would give the trick away.
const SPIKES_PER_M = 13;        // round the rim, so a big corner gets more than a bullet hole
const SPIKE_LEN = [0.1, 0.42];
const SPIKE_LONG_CHANCE = 0.18; // a few are conduit or a bent rod rather than plating
const SPIKE_LONG = [0.45, 0.95];
const SPIKE_THICK = [0.025, 0.075];
const SPIKE_TILT = 0.85;        // radians of wander off dead-radial
const SPIKE_INWARD = 0.3;       // ...and how many bend back INTO the hole instead
const SPIKE_REACH = 0.42;       // how close kept material must be for a spike to root

// Bays this close to the bottom of the machine are never taken. A hulk with its
// feet blown out from under it does not read as damage, it reads as floating —
// and the plinth is what sells the rest of it as still bolted down.
const KEEP_BASE = 0.55;

// One charred variant per source material, made once and shared by every wreck
// on every floor — the same bargain the cached materials in textures.js make,
// and the reason a wreck mesh must NOT be marked `ownMaterial`: level teardown
// would dispose a material the next floor is about to use.
const _charred = new Map();

/**
 * How far a blast at (px,py,pz) is from a bay, measured per axis by whether the
 * bay is THIN or THICK on that axis — and the split is what makes the hole both
 * round and punched-through.
 *
 * On a thin axis, measure to the bay's middle. Those are the axes the bay was
 * actually cut on, so this is the axis of the hole's face: measuring to the
 * middle removes exactly the bays inside the radius and the boundary follows
 * the circle. Measuring to the nearest FACE instead takes every bay the sphere
 * so much as grazes, which fattens the hole by a bay all round and squares it
 * off — a cube is nearest along its flat side, so the boundary bulges towards
 * the diagonals.
 *
 * On a thick axis, measure to the box. Bays are not cut across the machine's
 * depth (see baysOf), so a bay's middle sits a metre and a bit behind the front
 * face, and a round that hits the plating is nowhere near the middle of the box
 * it hit. Measuring to middles there meant the small hole could only ever be
 * punched by an explosion standing INSIDE the machine, never by a shot.
 */
function distToBay(bay, px, py, pz) {
  const axis = (lo, hi, p) => (hi - lo <= BAY
    ? Math.abs((lo + hi) / 2 - p)
    : Math.max(lo - p, 0, p - hi));
  return Math.hypot(
    axis(bay.x0, bay.x1, px),
    axis(bay.y0, bay.y1, py),
    axis(bay.z0, bay.z1, pz),
  );
}

/**
 * Cuts one box into a grid of bays on its two longest axes, so the blast has
 * something smaller than a whole wall of machine to take away. A box already
 * under a bay across is one bay, which is most of the ribs and every strap.
 */
function baysOf(box, size) {
  const d = { x: box.x1 - box.x0, y: box.y1 - box.y0, z: box.z1 - box.z0 };
  const [a, b] = Object.keys(d).sort((p, q) => d[q] - d[p]);
  const n = { x: 1, y: 1, z: 1 };
  n[a] = Math.max(1, Math.round(d[a] / size));
  n[b] = Math.max(1, Math.round(d[b] / size));

  const out = [];
  for (let i = 0; i < n.x; i++) {
    for (let j = 0; j < n.y; j++) {
      for (let k = 0; k < n.z; k++) {
        out.push({
          x0: box.x0 + (d.x * i) / n.x, x1: box.x0 + (d.x * (i + 1)) / n.x,
          y0: box.y0 + (d.y * j) / n.y, y1: box.y0 + (d.y * (j + 1)) / n.y,
          z0: box.z0 + (d.z * k) / n.z, z1: box.z0 + (d.z * (k + 1)) / n.z,
          key: box.key, material: box.material,
        });
      }
    }
  }
  return out;
}

const _spikeFwd = new THREE.Vector3(0, 0, 1);
const _spikeDir = new THREE.Vector3();
const _spikeAt = new THREE.Vector3();
const _spikeQ = new THREE.Quaternion();
const _spikeM = new THREE.Matrix4();
const _spikeOne = new THREE.Vector3(1, 1, 1);

/**
 * A shard of torn plating rooted at `at` and pointing along `dir`.
 *
 * Rotated, unlike everything else the wreck is built from — the bays are all
 * axis-aligned because they are cut out of axis-aligned boxes, and a rim of
 * axis-aligned spikes would be a row of little pillars rather than metal that
 * was ripped. `mergeGeometries` does not care that the matrix has been baked in,
 * so this still costs nothing beyond its own twelve triangles.
 */
function spikeGeo(at, dir, length, thick) {
  const geo = new THREE.BoxGeometry(thick, thick * (0.4 + Math.random()), length);
  _spikeQ.setFromUnitVectors(_spikeFwd, dir);
  _spikeM.compose(_spikeAt.copy(at).addScaledVector(dir, length / 2), _spikeQ, _spikeOne);
  geo.applyMatrix4(_spikeM);
  return geo;
}

/**
 * Builds the ring of torn metal around one blast, as geometry keyed by the
 * charred material to merge it into.
 *
 * Sampled on the sphere the bays were removed against rather than laid out on a
 * flat circle, because the corner blast is a bite out of a 3-D corner and its
 * rim runs over the front, the end and the top. Each sample only becomes a
 * spike if kept material is within `SPIKE_REACH` of it, which is what confines
 * the rim to where the hole actually has an edge.
 */
function rimSpikes(blast, kept, out) {
  const count = Math.max(6, Math.round(blast.r * SPIKES_PER_M));
  for (let i = 0; i < count; i++) {
    // Even in solid angle, so the rim does not bunch at the poles.
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    _spikeDir.set(s * Math.cos(theta), u, s * Math.sin(theta));

    _spikeAt.copy(_spikeDir).multiplyScalar(blast.r * (0.86 + Math.random() * 0.2))
      .add(blast);

    // Root it on real metal, or it is a spike floating in the room.
    let near = null, bestD = SPIKE_REACH;
    for (const bay of kept) {
      const d = Math.hypot(
        Math.max(bay.x0 - _spikeAt.x, 0, _spikeAt.x - bay.x1),
        Math.max(bay.y0 - _spikeAt.y, 0, _spikeAt.y - bay.y1),
        Math.max(bay.z0 - _spikeAt.z, 0, _spikeAt.z - bay.z1),
      );
      if (d < bestD) { bestD = d; near = bay; }
    }
    if (!near) continue;

    // Mostly peeled outward, some bent back through the hole.
    if (Math.random() < SPIKE_INWARD) _spikeDir.negate();
    _spikeDir.x += (Math.random() * 2 - 1) * SPIKE_TILT;
    _spikeDir.y += (Math.random() * 2 - 1) * SPIKE_TILT;
    _spikeDir.z += (Math.random() * 2 - 1) * SPIKE_TILT;
    if (_spikeDir.lengthSq() < 1e-6) continue;
    _spikeDir.normalize();

    const long = Math.random() < SPIKE_LONG_CHANCE;
    const [lo, hi] = long ? SPIKE_LONG : SPIKE_LEN;
    const thick = SPIKE_THICK[0] + Math.random() * (SPIKE_THICK[1] - SPIKE_THICK[0]);

    const material = charOf(near.material);
    let list = out.get(material);
    if (!list) out.set(material, list = []);
    list.push(spikeGeo(_spikeAt, _spikeDir, lo + Math.random() * (hi - lo),
      long ? thick * 0.55 : thick));
  }
}

function charOf(material) {
  let burnt = _charred.get(material);
  if (!burnt) {
    burnt = material.clone();
    burnt.color?.multiplyScalar(CHAR);
    if (burnt.emissive) burnt.emissive.multiplyScalar(0);
    if ('roughness' in burnt) burnt.roughness = CHAR_ROUGHNESS;
    if ('metalness' in burnt) burnt.metalness = 0;
    burnt.map = null;
    _charred.set(material, burnt);
  }
  return burnt;
}

export class Destruction {
  constructor({ scene, physics, effects, audio, shooting, lighting }) {
    this.scene = scene;
    this.physics = physics;
    this.effects = effects;
    this.audio = audio;
    this.shooting = shooting;
    this.lighting = lighting;

    this.level = null;
    // The ceiling still coming down from a power cut, if one is — see
    // blackoutPanels. Null the rest of the time, which is almost always.
    this._blackout = null;
    // Electricity crawling over a wreck, once there is one on this floor.
    this.arcs = null;
    // Every fragment builds its own geometry, so the pool disposes it on retire.
    this.debris = new BodyPool({
      scene, physics, max: MAX_DEBRIS, life: DEBRIS_LIFETIME, ownGeometry: true,
    });
  }

  // Called once per floor, after the level's meshes exist. Indexes each
  // destructible's vertex runs onto the mesh they ended up in, so a hit can be
  // traced back in a binary search rather than a scan.
  setLevel(level) {
    this.level = level;
    // A floor you left takes its unfinished ceiling with it. Without this, taking
    // the exit while the glass is still coming down would go on shattering the
    // OLD floor's panels against the new floor's nav grid and physics world.
    this._blackout = null;
    // And its wreck, which the level teardown has already taken out of the
    // scene — leaving the arcs behind would go on flickering a light over an
    // empty patch of the floor you just walked onto.
    this.arcs?.dispose();
    this.arcs = null;

    const touched = new Set();
    for (const entry of level.destructibles ?? []) {
      for (const span of entry.spans) {
        if (!span.mesh) continue;
        const runs = span.mesh.userData.runs ??= [];
        runs.push({ start: span.start, end: span.start + span.count, entry });
        touched.add(span.mesh);
      }
    }
    for (const mesh of touched) mesh.userData.runs.sort((a, b) => a.start - b.start);
  }

  // --- damage -----------------------------------------------------------------

  /**
   * A bullet landed on world geometry. Returns true if it landed on something
   * destructible, so the caller can skip the scorch decal — a hole in a desk
   * that is about to stop existing is wasted, and a decal left floating where
   * the desk used to be is worse.
   */
  damageSurface(hit, dir, damage) {
    const entry = resolve(hit);
    if (!entry) return false;
    if (entry.broken) return true;

    // Glass, a steel tube and a pot plant are all "world geometry" to the
    // raycast, and all sound completely different when you shoot them.
    this.audio.bulletHitMaterial(entry.kind, entry.substance, hit.point);

    entry.hp -= damage;
    if (entry.hp <= 0) this._shatter(entry, dir, hit.point);
    return true;
  }

  /** A bullet landed on a loose prop that is already its own body. */
  damageProp(dyn, dir, point, damage) {
    if (dyn.broken) return;
    // Ahead of the hp check: a prop you cannot destroy still answers when shot.
    this.audio.bulletHitMaterial('prop', dyn.substance, point);
    if (!dyn.hp) return;
    dyn.hp -= damage;
    if (dyn.hp <= 0) this._breakProp(dyn, dir, point);
  }

  // --- breaking ---------------------------------------------------------------

  /**
   * Everything within `radius` of an explosion takes `damage`, falling off to
   * nothing at the rim. Distance is measured to the nearest point of a
   * destructible's own footprint rather than its centre, so a three-metre
   * meeting table is inside a blast that touches any part of it.
   *
   * This is what lets one extinguisher set off the next one across the room.
   */
  blast(point, radius, damage) {
    if (!this.level) return;
    for (const entry of this.level.destructibles ?? []) {
      if (entry.broken || !entry.colliders?.length) continue;

      let near = Infinity;
      for (const c of entry.colliders) {
        const dx = Math.max(c.minX - point.x, 0, point.x - c.maxX);
        const dz = Math.max(c.minZ - point.z, 0, point.z - c.maxZ);
        near = Math.min(near, Math.hypot(dx, dz));
      }
      if (near > radius) continue;

      entry.hp -= damage * (1 - near / radius);
      // Its own scratch vector: _shatter hands the point straight on to
      // _scatter, which measures every fragment against it while using _away
      // itself. Passing that one in would have it subtracted from itself.
      if (entry.hp <= 0) this._shatter(entry, _up.set(0, 1, 0), _blast.copy(point));
    }
  }

  /**
   * Scatter a set of boxes as debris from `point`, with nothing being destroyed
   * to produce them. The extinguisher uses this for its own remains: by the time
   * it goes off it has not been part of the floor for over a second.
   */
  scatter(parts, point) {
    this._scatter(parts, null, _up.set(0, 1, 0), point);
  }

  // Static destructible: erase it from the batch it was merged into, hand back
  // the floor it was standing on, and scatter the boxes it was authored from.
  // `silent` is for a caller breaking many things at once that has decided this
  // particular one is not one of the sounds — see blackoutPanels. Everything
  // else about the destruction is unchanged: it still goes, still throws debris,
  // still gives back its collider and its light.
  _shatter(entry, dir, point, silent = false) {
    entry.broken = true;

    for (const span of entry.spans) eraseSpan(span);

    // A prop that declared welded structure does not vanish — it is redrawn as
    // a burnt-out hulk standing where it stood. The spans are erased either way
    // and the survivors are RE-DRAWN rather than left in the batch, because a
    // batched chunk is one shared material and there is no way to scorch part
    // of it in place; see `_wreck`.
    const wrecked = entry.hulkSpans ? this._wreck(entry, point) : false;

    // A retired collider is left in the array rather than spliced out of it:
    // the player is holding that array, and `top` below the floor is already
    // how a collider says "walk through me" (see player.js). The solver keeps
    // its own static body per collider, and that has to go too or the debris
    // lands on the shape of the thing it just came out of.
    //
    // A wreck gives back NEITHER, and that is the whole difference between it
    // and everything else here: it is still standing, so it still blocks, and
    // the nav grid must go on routing round it. Which is also why nothing has
    // to be re-measured — the hulk keeps the machine's own full-height housing,
    // so the collider that was over it is still the right shape and the debris
    // that lands on it lands on the thing you can see.
    if (!wrecked) {
      for (const collider of entry.colliders) {
        collider.top = -1;
        this.physics?.removeStatic(collider);
      }
      this.level?.nav?.openTiles(entry.navTiles);
    }

    for (const fixture of entry.fixtures) this.lighting?.removeFixture(fixture);

    // A volatile prop does not break where it stands. It takes its own boxes
    // with it and comes apart somewhere else, loudly — see extinguishers.js.
    if (entry.volatile && this.extinguishers?.launch(entry, dir, point)) return;

    // Only what came OFF is thrown: the fittings, plus the bays the blast tore
    // out of the structure, which `_wreck` hands back for exactly this. Throwing
    // the welded structure as well would have the hulk stand there while a copy
    // of it tumbles across the room — and `_scatter` keeps the biggest
    // fragments, which is the housing and the plinth, so it would have been the
    // whole machine twice.
    this._scatter(
      wrecked ? [...entry.parts.filter((p) => !p.hulk), ...wrecked] : entry.parts,
      null, dir, point,
    );

    const glassy = entry.kind !== 'prop';
    this.effects.impact(point, _up.set(0, 1, 0), glassy ? 0xdff0ff : 0xffe4b0);
    if (!silent) this.audio.breakThing(entry.kind, entry.substance, point);

    // The one destructible that fans its own kill out floor-wide, the same
    // shape as `volatile` above: one flag on the entry, read here, handed to
    // whoever wants to do something about it — see game.js's `_onPowerCut`.
    if (entry.powerCore) this.onPowerCut?.(entry, point);
  }

  /**
   * Redraws a destroyed prop's welded structure as a burnt-out hulk, and
   * returns whether one was actually raised.
   *
   * The survivors cannot simply be left in the batch. A batched chunk is one
   * mesh sharing one material with a hundred other props, so there is nothing
   * to scorch that would not scorch every desk on the floor with it — and a
   * machine that loses its pipework and its lights but keeps its factory finish
   * reads as unfinished rather than as burnt. So the whole prop is erased as
   * usual and the structure comes back as a mesh of its own, in charred
   * variants of its own materials, at exactly the coordinates it already had:
   * `parts` are world-space, so nothing has to be transformed.
   *
   * One mesh per material, merged, so a wreck is two or three draw calls rather
   * than the twenty-odd boxes it is made of. It joins the floor's `objects` for
   * teardown (geometry only — see `charOf` on why the materials are shared and
   * must outlive the level), its `meshes` so decals clip against it, and the
   * hittable list so a bullet stops on it like any other part of the building.
   *
   * What is left is not the whole structure: it is cut into bays (see BAY) and
   * two things take some away — the blast blows out one upper corner, and the
   * round that finished it leaves a hole where it landed. So the hulk is torn
   * open rather than merely stripped and blackened, and it is torn open where
   * something happened rather than all over. The holes are the point twice more
   * — they are where the arcs are struck from, because electricity crawling out
   * of unbroken plating looks painted on, and the bays they took are handed
   * back to the caller to be thrown, so the plating that left the machine is
   * the plating lying on the carpet.
   */
  _wreck(entry, point) {
    // --- cut into bays and decide which the blast took
    const coarse = [];
    let floorY = Infinity;
    for (const part of entry.parts) {
      if (!part.hulk || !part.material) continue;
      floorY = Math.min(floorY, part.y0);
      coarse.push(...baysOf(part, BAY_COARSE));
    }
    if (!coarse.length) return false;

    // The machine's own extent, which is what says where its corners are and
    // how big a corner ought to be on a machine this long.
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of coarse) {
      minX = Math.min(minX, b.x0); maxX = Math.max(maxX, b.x1);
      maxY = Math.max(maxY, b.y1);
      minZ = Math.min(minZ, b.z0); maxZ = Math.max(maxZ, b.z1);
    }

    // Which way the machine runs. It is backed against a wall, so one axis is
    // its length and the other its depth, and the corners worth blowing out are
    // at the ends of the LONG one — a "corner" across a 2.4 m depth is a dent.
    const alongX = (maxX - minX) >= (maxZ - minZ);
    const long = alongX ? maxX - minX : maxZ - minZ;
    // Measured against the height that can actually be taken, not the machine's
    // full height, since the bottom KEEP_BASE of it is never going anywhere.
    const rise = maxY - (floorY + KEEP_BASE);
    const radius = Math.min(
      CORNER_MAX,
      Math.max(CORNER_MIN, Math.min(long * CORNER_SHARE, rise * CORNER_RISE)),
    );

    // One end, tossed for, at the top and through the full depth. Both causes
    // are the same shape — a sphere with a centre and a radius — which is what
    // lets one loop cut them and one loop hang torn metal round them.
    const atMax = Math.random() < 0.5;
    const blasts = [{
      x: alongX ? (atMax ? maxX : minX) : (minX + maxX) / 2,
      y: maxY,
      z: alongX ? (minZ + maxZ) / 2 : (atMax ? maxZ : minZ),
      r: radius,
    }];
    if (point) blasts.push({ x: point.x, y: point.y, z: point.z, r: HOLE_R });

    // The nearest and farthest any part of a box is from a blast's centre. True
    // geometry, not distToBay's thin/thick rule — this only decides whether a
    // coarse box needs cutting up, and it has to be conservative at both ends.
    const nearFar = (b, bl) => {
      const near = Math.hypot(
        Math.max(b.x0 - bl.x, 0, bl.x - b.x1),
        Math.max(b.y0 - bl.y, 0, bl.y - b.y1),
        Math.max(b.z0 - bl.z, 0, bl.z - b.z1),
      );
      const far = Math.hypot(
        Math.max(Math.abs(b.x0 - bl.x), Math.abs(b.x1 - bl.x)),
        Math.max(Math.abs(b.y0 - bl.y), Math.abs(b.y1 - bl.y)),
        Math.max(Math.abs(b.z0 - bl.z), Math.abs(b.z1 - bl.z)),
      );
      return { near, far };
    };

    // distToBay is never smaller than `near` nor larger than `far` — it measures
    // to a middle on the thin axes, which lies between the two — so a box the
    // ragged edge cannot possibly cross can be settled whole, in either
    // direction, without ever cutting it up.
    const decide = (b) => {
      if (b.y0 < floorY + KEEP_BASE) return 'keep';
      let straddles = false;
      for (const bl of blasts) {
        const { near, far } = nearFar(b, bl);
        if (far <= bl.r * (1 - RAG)) return 'gone';
        if (near < bl.r * (1 + RAG)) straddles = true;
      }
      return straddles ? 'cut' : 'keep';
    };

    const gone = [], kept = [];
    for (const b of coarse) {
      const verdict = decide(b);
      if (verdict === 'gone') { b._gone = true; gone.push(b); continue; }
      if (verdict === 'keep') { kept.push(b); continue; }

      // Only the shell around a hole is worth the fine grid.
      for (const fine of baysOf(b, BAY)) {
        if (fine.y0 < floorY + KEEP_BASE) { kept.push(fine); continue; }
        let out = false;
        for (const bl of blasts) {
          // A wobble on the radius, small enough that the circle survives it —
          // see RAG. What makes the edge look violent is the rim, not this.
          const edge = bl.r * (1 - RAG + Math.random() * RAG * 2);
          if (distToBay(fine, bl.x, bl.y, bl.z) < edge) { out = true; break; }
        }
        if (out) { fine._gone = true; gone.push(fine); } else kept.push(fine);
      }
    }
    // Every bay scoring its way out at once would be a machine that vanished
    // with extra steps; the caller has already erased the batch by this point,
    // so there would be nothing left to stand there.
    if (!kept.length) return false;

    const byMaterial = new Map();
    for (const bay of kept) {
      const burnt = charOf(bay.material);
      let geos = byMaterial.get(burnt);
      if (!geos) byMaterial.set(burnt, geos = []);
      geos.push(boxBetween(bay.x0, bay.y0, bay.z0, bay.x1, bay.y1, bay.z1));
    }
    // Torn metal round both rims, into the same material buckets, so it merges
    // into the hulk rather than becoming meshes of its own.
    for (const blast of blasts) rimSpikes(blast, kept, byMaterial);
    if (!byMaterial.size) return false;

    const raised = [];
    for (const [material, geos] of byMaterial) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = 'wreck';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      raised.push(mesh);
    }
    // Every merge failing leaves nothing standing, and the caller has to hear
    // about it or the floor keeps a collider around a machine that is not there.
    if (!raised.length) return false;

    this.level?.objects?.push(...raised);
    this.level?.meshes?.push(...raised);
    this.shooting?.addHittables(raised);
    if (this.level?.meshes) this.effects?.setSurfaces(this.level.meshes);

    // Struck from the holes, falling back to the top of what is left if the
    // blast happened to tear nothing out — a wreck with no arcs at all would be
    // the one that scored unluckily, which is not a thing the player can know.
    this.arcs?.dispose();
    const anchors = (gone.length ? gone : kept).map((b) => ({
      x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2,
    }));
    this.arcs = new Arcs(this.scene, anchors, this.lighting?.spark ?? null);

    return gone;
  }

  /**
   * A fraction of the floor's ceiling panels, chosen at random, broken the
   * same way a bullet would — same span erasure, same debris, same
   * `lighting.removeFixture`. Used by the generator's power cut: dropping the
   * floor to quarter power (see `lighting.setPower`) reads as "the lights are
   * down", but a floor whose power just died should look like it, not just
   * feel darker.
   *
   * It is QUEUED rather than done, and that is the point of this function.
   * Breaking every panel in one loop was the single most expensive frame in the
   * game: two hundred span erasures, two hundred fixtures out of the light pool,
   * two hundred lots of debris, and then ~400 placed sounds each walking
   * `nav.soundPath` to find its way round the building — all before the frame
   * could end. Nothing is dropped, it is spent over BLACKOUT_RAIN instead.
   *
   * Which fixes the sound for free, and the two are the same fact: a sound is
   * placed when its panel breaks, so spreading the work spreads the noise. Two
   * hundred tubes starting on the identical sample is one white crack that lands
   * on top of the only explosion in the game (see `audio.generatorBlast`) and
   * buries it; two hundred tubes over a second is a ceiling coming down, which
   * is what happened. Same idea as IMPACT_SCATTER in audio.js, at floor scale.
   *
   * The lights still drop on the frame you shot it — that is `setPower` in
   * game.js and it is instant. This is only the glass following them down.
   */
  blackoutPanels(fraction) {
    if (!this.level) return;
    const panels = (this.level.destructibles ?? []).filter((e) => e.kind === 'panel' && !e.broken);
    const n = Math.round(panels.length * fraction);
    if (!n) return;

    // Shuffled, so the ceiling fails all over the floor at once rather than
    // sweeping across it in whatever order the builder happened to emit it.
    for (let i = panels.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [panels[i], panels[j]] = [panels[j], panels[i]];
    }
    this._blackout = {
      queue: panels.slice(0, n), rate: n / BLACKOUT_RAIN, owed: 0, voices: BLACKOUT_VOICES,
    };
  }

  // Spends the blackout budget for one frame. `owed` carries the fraction of a
  // panel between frames, so the rate does not quietly depend on the frame rate.
  _drainBlackout(dt) {
    const b = this._blackout;
    if (!b) return;

    b.owed += b.rate * dt;
    let take = Math.min(Math.floor(b.owed), BLACKOUT_MAX_PER_FRAME);
    b.owed -= take;

    while (take-- > 0 && b.queue.length) {
      const entry = b.queue.pop();
      // It may have been shot, or caught by the blast, since it was queued.
      if (entry.broken) continue;
      const f = entry.fixtures[0];
      // Near enough to hear, and there is still a voice left for it. Both halves
      // matter: the range test alone still leaves a hundred tubes in earshot on a
      // big floor, and a budget alone would spend itself on the far side of the
      // building. Everything else breaks in silence — see BLACKOUT_VOICES.
      const heard = b.voices > 0 && this.audio.audibleAt(f.x, f.z);
      if (heard) b.voices--;
      this._shatter(entry, _up.set(0, -1, 0), _blast.set(f.x, f.y, f.z), !heard);
    }
    if (!b.queue.length) this._blackout = null;
  }

  // Loose prop: retire the intact body and re-emit its boxes as independent
  // ones, thrown outward from the shot that finished it.
  _breakProp(dyn, dir, point) {
    dyn.broken = true;

    if (dyn.handle) this.physics?.remove(dyn.handle);
    dyn.handle = null;
    this.scene.remove(dyn.group);
    this.shooting.removeHittables(dyn.group.children);
    this.effects.removeSurfaces(dyn.group.children);

    // Retire its collider without disturbing the array the player is holding.
    if (dyn.collider) {
      dyn.collider.push = null;
      dyn.collider.top = -1;
    }

    this._scatter(dyn.parts, dyn, dir, point);

    this.effects.impact(point, _up.set(0, 1, 0), 0xffe4b0);
    this.audio.breakThing('prop', dyn.substance, point);
  }

  /**
   * Turns a list of boxes into debris. `dyn` is the loose prop they came from,
   * whose parts are in ITS local space and have to be brought into the world;
   * for a static destructible it is null and the boxes are already in world
   * space, because a static prop never moved from where it was generated.
   */
  _scatter(parts, dyn, dir, point) {
    if (!parts?.length) return;

    const volume = dyn ? Math.max(1e-4, dyn.size.x * dyn.size.y * dyn.size.z) : 0;
    const yaw = dyn ? new THREE.Euler().setFromQuaternion(dyn.group.quaternion, 'YXZ').y : 0;

    // A shelving unit is authored from forty boxes and a ceiling tube from two.
    // Capping by size keeps the big, readable pieces and drops the ring binders,
    // so one shot can't spend the whole debris budget.
    const chosen = parts
      .filter((p) => longestSide(p) >= MIN_FRAGMENT)
      .sort((a, b) => longestSide(b) - longestSide(a))
      .slice(0, MAX_FRAGMENTS);

    for (const part of chosen) {
      const sx = part.x1 - part.x0, sy = part.y1 - part.y0, sz = part.z1 - part.z0;

      _local.set((part.x0 + part.x1) / 2, (part.y0 + part.y1) / 2, (part.z0 + part.z1) / 2);
      const world = dyn
        ? _local.applyQuaternion(dyn.group.quaternion).add(dyn.group.position).clone()
        : _local.clone();

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), part.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.copy(world);
      this.scene.add(mesh);

      // A loose prop knows what it weighed, so its pieces share that out by
      // volume and a chair's base still outweighs its arm. A static one never
      // had a mass, so its pieces are weighed from their own size instead.
      const mass = dyn
        ? Math.max(0.4, dyn.mass * ((sx * sy * sz) / volume))
        : THREE.MathUtils.clamp(sx * sy * sz * DENSITY, 0.4, MAX_FRAGMENT_MASS);

      const handle = this.physics?.addBox({
        size: {
          x: Math.max(sx, MIN_BODY), y: Math.max(sy, MIN_BODY), z: Math.max(sz, MIN_BODY),
        },
        position: world, yaw, mass,
      });

      if (handle) {
        // Blown away from the impact and slightly upward; the impulse is
        // applied at the hit point rather than the centre, so pieces spin.
        _away.copy(world).sub(point);
        if (_away.lengthSq() < 1e-6) _away.copy(dir);
        _away.normalize();
        _away.y += 0.75;
        _away.normalize();
        this.physics.impulse(handle, _away, mass * (2.2 + Math.random() * 2.4), point);
      }

      this.debris.add(mesh, handle);
    }
  }

  // --- debris lifecycle -------------------------------------------------------

  update(dt) {
    this._drainBlackout(dt);
    this.debris.update(dt);
    this.arcs?.update(dt);
  }

  // Must run while the physics world the handles belong to is still alive.
  clear() {
    this.debris.clear();
    this._blackout = null;
    this.arcs?.dispose();
    this.arcs = null;
    this.level = null;
  }
}

// Names the destructible a raycast hit landed on, or null for plain scenery.
// `faceIndex` counts triangles in the merged buffer; the first vertex of that
// triangle is what the vertex runs are indexed by.
function resolve(hit) {
  const runs = hit.object.userData.runs;
  if (!runs || hit.faceIndex == null) return null;

  const index = hit.object.geometry.index;
  const vertex = index ? index.getX(hit.faceIndex * 3) : hit.faceIndex * 3;

  let lo = 0, hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid];
    if (vertex < run.start) hi = mid - 1;
    else if (vertex >= run.end) lo = mid + 1;
    else return run.entry;
  }
  return null;
}

function longestSide(p) {
  return Math.max(p.x1 - p.x0, p.y1 - p.y0, p.z1 - p.z0);
}

const _local = new THREE.Vector3();
const _away = new THREE.Vector3();
const _up = new THREE.Vector3();
const _blast = new THREE.Vector3();
