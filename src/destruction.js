import * as THREE from 'three';
import { eraseSpan } from './gen/geom.js';
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
// How fine the grid is, and it is not one number — it is per HOLE, because what
// a circle costs is cells across its radius, not cells per metre. A boundary
// drawn on a grid of cubes is only as circular as the cubes are small relative
// to the arc: at 0.42 the 2.3 m corner was already smooth while the 0.55 m
// bullet hole came out as a five-cell PLUS, which is what a rasterised circle
// looks like when you can count the pixels. Sizing off the machine therefore
// gets it wrong at both ends at once — too coarse for the small hole, or far
// too fine for the big one, which is the same waste multiplied over the much
// larger boundary.
//
// So each blast picks its own: `r / BAY_PER_RADIUS`, six cells to the radius,
// clamped. The corner lands near 0.3 and the bullet hole on the floor of 0.09,
// and the fine grid goes where the arc is tight instead of everywhere.
const BAY_PER_RADIUS = 6;
const BAY_MIN = 0.09;
// Everything else is cut at this, and never looked at closely: a coarse bay no
// blast boundary crosses is wholly gone or wholly kept, and a 0.85 m box in the
// middle of a solid machine looks exactly like the fifty small ones it would
// have been cut into.
//
// Together with stamping the boxes from one cube rather than merging a geometry
// each (see stampBoxes), that is what makes the resolution a choice about how
// the hole LOOKS rather than what it costs. It matters on this frame in
// particular: the generator's death is also a ceiling coming down, four hundred
// fragments and a floor-wide relight (see BLACKOUT_RAIN), and it is the last
// frame in the game that can afford a stall.
const BAY_COARSE = 0.85;

const bayFor = (r) => Math.min(BAY_COARSE, Math.max(BAY_MIN, r / BAY_PER_RADIUS));

// Damage scattered evenly over a wreck is texture — it reads as corrosion, or as
// a mesh with holes in it. Damage you can point at is an EVENT. So the machine
// is damaged by four causes with four signatures, and every one of them is the
// same sphere with a centre and a radius, which is what lets one loop cut them
// all and one loop hang torn metal round them:
//
//   the corner    one end blown clean off, and the only one that goes THROUGH
//   the dish      the same blast deforming the plating for a way around it
//   the shrapnel  what came off the machine, hitting the rest of it
//   the round     the crater from the shot that finished it, aimed by the player
//
// The rule that keeps it reading as a machine rather than as a colander is that
// only ONE of them goes through. A generator you can see daylight through in six
// places has been deleted in six places; one you can see through once and that
// is battered everywhere else has been blown up.
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
//   The last round: a crater about an arm across, wherever it landed. It has to
//   stay obviously smaller than the corner or there are just two blasts.
const HOLE_R = 0.55;
// How deep the crater must bite before that spot counts as its floor rather
// than as the taper at its rim — an arc struck on the taper is an arc on
// undamaged plating.
const CRATER_BITE = 0.12;

//   The dish: a blast does not stop at the edge of the hole it makes. The
//   plating for a good way around the corner is pushed in, and without it the
//   corner is a shape subtracted from an otherwise mint machine. Its radius is a
//   multiple of the corner's, and it is CAPPED in depth — left as a plain
//   sphere it is deeper than the machine everywhere it reaches and simply makes
//   the hole bigger, which is the opposite of the point.
const DISH_SCALE = 1.8;
const DISH_DEPTH = 0.22;

//   The shrapnel: a machine that comes apart throws its own casing through
//   itself. Small pocks, clustered toward the blast because that is where they
//   came from, and never through — they are what a fragment does, not what a
//   charge does.
//
//   Both numbers below have been dialled DOWN twice, and for one reason: a spray
//   of small round marks spread over a big flat machine stops reading as damage
//   and starts reading as spots. What makes a pock look like it was thrown from
//   somewhere is that it is near the other pocks and near where they came from,
//   so there are now one to three of them and they sit hard against the corner.
//   That is close to the machine as it was before shrapnel existed — which is
//   the point. They are seasoning on the corner blast, not a feature of the
//   whole casing, and the far end of the machine is clean because nothing hit it.
const SHRAPNEL = [1, 3];
const SHRAPNEL_R = [0.09, 0.3];
const SHRAPNEL_BIAS = 0.92;    // 0 spreads them evenly, 1 piles them on the corner
// ...and they carry their own grid instead of taking `bayFor`'s, which is the
// difference between this being affordable and not. bayFor sizes for cells
// across a radius, and for a 0.2 m pock that bottoms out at BAY_MIN — so every
// coarse box a pock so much as touches would be cut into eighty-odd pieces, for
// a dent the size of a fist seen from across a plant room. A pock does not have
// to survive being counted; it has to be there.
const SHRAPNEL_GRID = 0.17;

// Plating near a blast is not flat any more: bays are nudged along the machine's
// depth and tilted, which costs nothing — the stamper takes a quaternion per box
// already — and does more for "this was hit" than any amount of extra hole.
//
// Two things keep it from turning the machine into a cloud of shards, and the
// first version had neither. It FALLS OFF from the edge of the damage, over
// BUCKLE_REACH, so a panel is wrenched where it was torn and flat where it was
// not; applied evenly to every fine bay, a whole end of the machine came out as
// a mosaic of separately-tilted chips. And the amplitude scales with the size of
// the piece, because the same 8° on a 9 cm bay opens a gap as wide as the bay
// itself, which reads as detached rather than as bent.
const BUCKLE_REACH = 0.7;
const BUCKLE_SHIFT = 0.05;
const BUCKLE_TILT = 0.13;      // radians, on a piece big enough to earn it
const BUCKLE_FULL = 0.35;      // ...the size at which it gets all of that

// Soot. The char is not even either: metal near where it went up is burnt harder
// than metal at the far end, so bays within reach of a blast take a second,
// darker variant of their own charred material. Two buckets, not a gradient —
// the colour lives on the material and there is one material per bucket.
const SOOT_REACH = 1.5;
const SOOT = 0.45;             // ...keeping this much of the ordinary charred colour
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

// Severed wiring hanging out of the tear. Everything else on a wreck is a shade
// of burnt, so these few centimetres of insulation are the only colour on it and
// they carry a lot: they say the thing was WIRED, that something came apart
// rather than a shape being subtracted, and they give the eye somewhere to land
// on an otherwise black mass. They are deliberately NOT charred — a burnt wire
// is a black wire, and a black wire on a black machine is nothing.
//
// Only the big tears get them; a fist-sized shrapnel pock has not opened a loom.
const WIRE_MIN_R = 0.4;         // blasts smaller than this have not cut anything
const WIRES = [1, 3];
const WIRE_SEGMENTS = 4;
const WIRE_LEN = [0.28, 0.85];
const WIRE_THICK = [0.014, 0.026];
// Each joint bends further down than the last, so a wire hangs instead of
// pointing — which is the whole difference between a cable and another spike.
const WIRE_DROOP = 0.55;
const WIRE_COLORS = [0xc8352b, 0x2f6fd0, 0xd8b12a, 0x2f9e4f, 0xe8e4dc];

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
 * How far a blast at (px,py,pz) is from a bay, measured to the bay's MIDDLE on
 * the two axes it was cut on and to its BOX on the machine's depth — and that
 * split is what makes a hole both round and punched through.
 *
 * Middles on the cut axes: those are the axes of the hole's face, so measuring
 * to the middle removes exactly the bays inside the radius and the boundary
 * follows the circle. Measuring to the nearest FACE instead takes every bay the
 * sphere so much as grazes, which fattens the hole by a bay all round and
 * squares it off, since a cube is nearest along its flat side.
 *
 * The box on the depth: bays are not cut across the machine's depth (see
 * baysOf), so a bay's middle sits a metre and a bit behind the front face, and
 * a round that hits the plating is nowhere near the middle of the box it hit.
 * Measuring to middles there meant the small hole could only ever be punched by
 * an explosion standing INSIDE the machine, never by a shot.
 */
function distToBay(bay, px, py, pz, depthAxis) {
  const mid = (lo, hi, p) => Math.abs((lo + hi) / 2 - p);
  const box = (lo, hi, p) => Math.max(lo - p, 0, p - hi);
  return Math.hypot(
    (depthAxis === 'x' ? box : mid)(bay.x0, bay.x1, px),
    mid(bay.y0, bay.y1, py),
    (depthAxis === 'z' ? box : mid)(bay.z0, bay.z1, pz),
  );
}

/**
 * Cuts one box into a grid of bays across the machine's FACE — every axis but
 * `depthAxis` — so the blast has something smaller than a whole wall of machine
 * to take away. A box already under a bay across is one bay, which is most of
 * the ribs and every strap.
 *
 * The depth is named by the caller rather than worked out here, and that is the
 * whole of whether a hole comes out round. This used to cut "the two longest
 * axes", which is right for a machine's own boxes — a housing is long, tall and
 * shallow — and wrong the moment it is used a second time on a COARSE bay of
 * that housing: those are 0.85 x 0.85 x 2, so the two longest are the depth and
 * one lateral axis, and the other lateral axis is never cut at all. The hole
 * then has the grid's resolution across and a flat 0.85 m band up and down,
 * which traced as a perfectly square outline no matter how fine the grid got.
 */
function baysOf(box, size, depthAxis) {
  const d = { x: box.x1 - box.x0, y: box.y1 - box.y0, z: box.z1 - box.z0 };
  const n = { x: 1, y: 1, z: 1 };
  for (const a of ['x', 'y', 'z']) {
    if (a !== depthAxis) n[a] = Math.max(1, Math.round(d[a] / size));
  }

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

// One cube, read once, stamped into a merged buffer for every box a wreck is
// made of. The obvious way — a BoxGeometry each, handed to mergeGeometries — is
// what made the wreck expensive: at the resolution a round hole needs, that was
// 27 ms of allocation and well over a hundred more in the merge, on the worst
// frame in the game to spend it (see BAY_PER_RADIUS). Copying a template into
// preallocated arrays is the same triangles for a fraction of the work, and it
// reuses three's own winding and normals rather than hand-rolling a cube, the
// half of this that would otherwise be a source of inside-out faces.
//
// No UVs: every charred material has had its map removed (see charOf), so
// nothing samples a texture off this geometry.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const _stampV = new THREE.Vector3();

function stampBoxes(items) {
  const n = items.length;
  const up = UNIT_BOX.attributes.position.array;
  const un = UNIT_BOX.attributes.normal.array;
  const ui = UNIT_BOX.index.array;

  const position = new Float32Array(n * 24 * 3);
  const normal = new Float32Array(n * 24 * 3);
  const index = new Uint32Array(n * 36);

  for (let b = 0; b < n; b++) {
    const it = items[b];
    const at = b * 72;
    for (let i = 0; i < 24; i++) {
      const o = i * 3;
      _stampV.set(up[o] * it.sx, up[o + 1] * it.sy, up[o + 2] * it.sz);
      if (it.q) _stampV.applyQuaternion(it.q);
      position[at + o] = _stampV.x + it.cx;
      position[at + o + 1] = _stampV.y + it.cy;
      position[at + o + 2] = _stampV.z + it.cz;

      _stampV.set(un[o], un[o + 1], un[o + 2]);
      if (it.q) _stampV.applyQuaternion(it.q);
      normal[at + o] = _stampV.x;
      normal[at + o + 1] = _stampV.y;
      normal[at + o + 2] = _stampV.z;
    }
    const ai = b * 36;
    const base = b * 24;
    for (let k = 0; k < 36; k++) index[ai + k] = ui[k] + base;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

const _spikeFwd = new THREE.Vector3(0, 0, 1);
const _spikeDir = new THREE.Vector3();
const _spikeAt = new THREE.Vector3();
const _barMid = new THREE.Vector3();
const _wireDir = new THREE.Vector3();
const _wireAt = new THREE.Vector3();
const _spikeQ = new THREE.Quaternion();
const _spikeM = new THREE.Matrix4();
const _spikeOne = new THREE.Vector3(1, 1, 1);

/**
 * A small bar rooted at `at` and pointing along `dir`, as a stamp for
 * stampBoxes: a shard of torn plating, or one straight run of a hanging wire.
 *
 * Rotated, unlike everything else the wreck is built from — the bays are all
 * axis-aligned because they are cut out of axis-aligned boxes, and a rim of
 * axis-aligned spikes would be a row of little pillars rather than metal that
 * was ripped.
 *
 * `thickY` defaults to a random squash, which is what makes a shard read as
 * peeled sheet rather than as a rod; a wire passes its own thickness to get a
 * square section back.
 */
function barStamp(at, dir, length, thick, thickY = thick * (0.4 + Math.random())) {
  const q = new THREE.Quaternion().setFromUnitVectors(_spikeFwd, dir);
  const mid = _barMid.copy(at).addScaledVector(dir, length / 2);
  return {
    cx: mid.x, cy: mid.y, cz: mid.z,
    sx: thick, sy: thickY, sz: length,
    q,
  };
}

/**
 * Builds what hangs off the rim of one blast — torn plating, and the severed
 * wiring where the tear is big enough to have cut a loom — as geometry keyed by
 * the material to merge it into.
 *
 * Sampled on the sphere the bays were removed against rather than laid out on a
 * flat circle, because the corner blast is a bite out of a 3-D corner and its
 * rim runs over the front, the end and the top. A sample only becomes anything
 * if kept material is within `SPIKE_REACH` of it, which is what confines all of
 * this to where the hole actually has an edge.
 */
function rimSpikes(blast, kept, out) {
  // Only bays that could possibly root a spike, worked out once for the blast
  // instead of walked in full for every sample on it. With one hole that was a
  // nested loop nobody noticed; with a corner, a crater and eight shrapnel pocks
  // it is eighty-odd samples each scanning a thousand bays.
  const range = blast.r + SPIKE_REACH + BAY_COARSE;
  const local = kept.filter((bay) => Math.hypot(
    Math.max(bay.x0 - blast.x, 0, blast.x - bay.x1),
    Math.max(bay.y0 - blast.y, 0, blast.y - bay.y1),
    Math.max(bay.z0 - blast.z, 0, blast.z - bay.z1),
  ) < range);
  if (!local.length) return;

  // A point on the blast sphere with kept metal within reach, written into the
  // vectors handed in; returns the bay it is rooted on, or null for a sample
  // that came down over open air. Shared by the shards and the wiring, which
  // grow off the same rim and would otherwise each have a copy of this.
  const rimPoint = (dirOut, atOut) => {
    // Even in solid angle, so the rim does not bunch at the poles.
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    dirOut.set(s * Math.cos(theta), u, s * Math.sin(theta));
    atOut.copy(dirOut).multiplyScalar(blast.r * (0.86 + Math.random() * 0.2)).add(blast);

    let near = null, bestD = SPIKE_REACH;
    for (const bay of local) {
      const d = Math.hypot(
        Math.max(bay.x0 - atOut.x, 0, atOut.x - bay.x1),
        Math.max(bay.y0 - atOut.y, 0, atOut.y - bay.y1),
        Math.max(bay.z0 - atOut.z, 0, atOut.z - bay.z1),
      );
      if (d < bestD) { bestD = d; near = bay; }
    }
    return near;
  };

  const count = Math.max(6, Math.round(blast.r * SPIKES_PER_M));
  for (let i = 0; i < count; i++) {
    // Root it on real metal, or it is a spike floating in the room.
    const near = rimPoint(_spikeDir, _spikeAt);
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

    // Always the sooty variant: a shard on the lip of a hole is the most burnt
    // metal on the machine, and it is seen against the hole rather than against
    // the plating, so the darker one is also what reads.
    const material = charOf(near.material, true);
    let list = out.get(material);
    if (!list) out.set(material, list = []);
    list.push(barStamp(_spikeAt, _spikeDir, lo + Math.random() * (hi - lo),
      long ? thick * 0.55 : thick));
  }

  // --- severed wiring ---------------------------------------------------------
  // A fist-sized pock has not opened a loom; only a real tear has. Each wire
  // leaves the rim pointing outward and then hangs, one joint at a time, which
  // is what stops it being another spike in a different colour.
  if (blast.r < WIRE_MIN_R) return;
  const wires = WIRES[0] + Math.floor(Math.random() * (WIRES[1] - WIRES[0] + 1));
  for (let i = 0; i < wires; i++) {
    if (!rimPoint(_wireDir, _wireAt)) continue;

    // Out of the tear rather than along it, and never starting upward — a cut
    // cable end that rises out of the hole is a cable under tension, which this
    // one is conspicuously not.
    _wireDir.y = -Math.abs(_wireDir.y) * 0.35;
    if (_wireDir.lengthSq() < 1e-6) continue;
    _wireDir.normalize();

    const material = wireOf(WIRE_COLORS[(Math.random() * WIRE_COLORS.length) | 0]);
    let list = out.get(material);
    if (!list) out.set(material, list = []);

    const thick = WIRE_THICK[0] + Math.random() * (WIRE_THICK[1] - WIRE_THICK[0]);
    const seg = (WIRE_LEN[0] + Math.random() * (WIRE_LEN[1] - WIRE_LEN[0])) / WIRE_SEGMENTS;
    for (let s = 0; s < WIRE_SEGMENTS; s++) {
      list.push(barStamp(_wireAt, _wireDir, seg, thick, thick));
      _wireAt.addScaledVector(_wireDir, seg);
      _wireDir.y -= WIRE_DROOP;
      _wireDir.normalize();
    }
  }
}

/**
 * The charred variant of one of the machine's materials — twice over, because
 * metal near where it went up is burnt harder than metal at the far end and the
 * colour lives on the material, so "harder" means a second material rather than
 * a gradient. See SOOT.
 */
// One material per insulation colour, made once and shared by every wreck on
// every floor — the same bargain `_charred` makes, and the same reason a wreck
// mesh must not be marked `ownMaterial`.
const _wires = new Map();

function wireOf(color) {
  let material = _wires.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 });
    _wires.set(color, material);
  }
  return material;
}

function charOf(material, sooty = false) {
  let pair = _charred.get(material);
  if (!pair) {
    const burn = (keep) => {
      const burnt = material.clone();
      burnt.color?.multiplyScalar(CHAR * keep);
      if (burnt.emissive) burnt.emissive.multiplyScalar(0);
      if ('roughness' in burnt) burnt.roughness = CHAR_ROUGHNESS;
      if ('metalness' in burnt) burnt.metalness = 0;
      burnt.map = null;
      return burnt;
    };
    pair = { plain: burn(1), sooty: burn(SOOT) };
    _charred.set(material, pair);
  }
  return sooty ? pair.sooty : pair.plain;
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
   * What is left is not the whole structure: it is cut into bays (see bayFor)
   * and then damaged, in the several ways a machine that has actually blown up
   * is damaged rather than in one: an upper corner blown clean off, the plating
   * around it dished by the same blast, shrapnel pocks scattered over the rest
   * of it, and the crater from the round that finished it. Only the corner goes
   * THROUGH — everything else is a bite out of the near face, because a machine
   * you can see daylight through in six places is a colander, not a wreck.
   *
   * The damage is the point twice more: it is where the arcs are struck from,
   * because electricity crawling out of unbroken plating looks painted on, and
   * the bays it took are handed back to the caller to be thrown, so the plating
   * that left the machine is the plating lying on the carpet.
   */
  _wreck(entry, point) {
    // --- the machine's own extent, which is what says where its corners are,
    // how big a corner ought to be on a machine this long, and which way it is
    // facing. All three have to be known BEFORE anything is cut up.
    const welded = entry.parts.filter((part) => part.hulk && part.material);
    if (!welded.length) return false;
    let floorY = Infinity;
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of welded) {
      floorY = Math.min(floorY, b.y0);
      minX = Math.min(minX, b.x0); maxX = Math.max(maxX, b.x1);
      maxY = Math.max(maxY, b.y1);
      minZ = Math.min(minZ, b.z0); maxZ = Math.max(maxZ, b.z1);
    }

    // Which way the machine runs. It is backed against a wall, so one axis is
    // its length and the other its depth, and the corners worth blowing out are
    // at the ends of the LONG one — a "corner" across a 2.4 m depth is a dent.
    const alongX = (maxX - minX) >= (maxZ - minZ);
    // The one axis no bay is ever cut on: a hole should go straight through the
    // machine, and cutting the depth up would only add boxes nobody can see.
    const depthAxis = alongX ? 'z' : 'x';

    const coarse = [];
    for (const part of welded) coarse.push(...baysOf(part, BAY_COARSE, depthAxis));
    if (!coarse.length) return false;

    const long = alongX ? maxX - minX : maxZ - minZ;
    // Measured against the height that can actually be taken, not the machine's
    // full height, since the bottom KEEP_BASE of it is never going anywhere.
    const rise = maxY - (floorY + KEEP_BASE);
    const radius = Math.min(
      CORNER_MAX,
      Math.max(CORNER_MIN, Math.min(long * CORNER_SHARE, rise * CORNER_RISE)),
    );

    // Every cause is the same sphere, and they differ in ONE flag. `through`
    // takes everything inside it, depth included — that end of the machine is
    // not there any more and you can see the wall. Everything else CARVES: the
    // sphere eats into the near face and the machine behind it stays. A hole
    // punched clean through a generator by one pistol round reads as a tunnel
    // rather than as damage, and six of them read as a colander.
    const atMax = Math.random() < 0.5;
    const cornerAlong = alongX
      ? { x: atMax ? maxX : minX, z: (minZ + maxZ) / 2 }
      : { x: (minX + maxX) / 2, z: atMax ? maxZ : minZ };

    // Everything that carves does so from the face the ROOM is on, and the floor
    // is what says which face that is: the machine is backed against a wall, so
    // the open side is the one a body can stand on.
    //
    // The obvious source is the shot — the player was in the room when they
    // fired, so the point the round landed on is the near side — and it is
    // wrong whenever the machine goes up in somebody else's explosion instead.
    // Then the point is INSIDE it, every carve starts from the middle of the
    // depth, and the shallow dish that should dent the front instead deletes
    // the whole front half of everything it reaches. Asking nav costs two
    // lookups and cannot be wrong that way.
    const faceLo = alongX ? minZ : minX;
    const faceHi = alongX ? maxZ : maxX;
    const nav = this.level?.nav;
    const openAt = (v) => (alongX
      ? nav?.clear((minX + maxX) / 2, v, 0.4)
      : nav?.clear(v, (minZ + maxZ) / 2, 0.4));
    let nearFace;
    if (openAt(faceHi + 0.8)) nearFace = faceHi;
    else if (openAt(faceLo - 0.8)) nearFace = faceLo;
    else if (point) nearFace = point[depthAxis];
    else nearFace = (faceLo + faceHi) / 2;

    const blasts = [
      { ...cornerAlong, y: maxY, r: radius, through: true },
      // The same blast, wider and shallow, deforming the plating around it.
      {
        x: alongX ? cornerAlong.x : nearFace,
        y: maxY,
        z: alongX ? nearFace : cornerAlong.z,
        r: radius * DISH_SCALE,
        maxCut: DISH_DEPTH,
      },
    ];
    // Where the round landed across the face, but at the face's own depth for
    // the same reason as the dish: a hit resolved by a raycast already sits on
    // the plating, and one synthesised by an explosion inside the machine would
    // otherwise crater it from the inside out.
    if (point) {
      blasts.push({
        x: depthAxis === 'x' ? nearFace : point.x,
        y: point.y,
        z: depthAxis === 'z' ? nearFace : point.z,
        r: HOLE_R,
      });
    }

    // Shrapnel, thrown from the corner across the face of the machine. Placed in
    // the machine's own two face axes and pinned to the near face, so a pock is
    // always a bite out of the side you are looking at.
    const spread = Math.random;
    const shrapnel = SHRAPNEL[0] + Math.floor(spread() * (SHRAPNEL[1] - SHRAPNEL[0] + 1));
    const cornerAt = alongX ? cornerAlong.x : cornerAlong.z;
    const farAt = alongX
      ? (atMax ? minX : maxX)
      : (atMax ? minZ : maxZ);
    for (let i = 0; i < shrapnel; i++) {
      // Biased toward the corner by taking the nearer of two draws, which piles
      // them up where the casing came from without ever leaving the far end bare.
      const a = spread(), b = spread();
      const t = spread() < SHRAPNEL_BIAS ? Math.min(a, b) : a;
      const at = cornerAt + (farAt - cornerAt) * t;
      const y = floorY + KEEP_BASE + spread() * Math.max(0.1, maxY - floorY - KEEP_BASE);
      blasts.push({
        x: alongX ? at : nearFace,
        y,
        z: alongX ? nearFace : at,
        r: SHRAPNEL_R[0] + spread() * (SHRAPNEL_R[1] - SHRAPNEL_R[0]),
        grid: SHRAPNEL_GRID,
      });
    }

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
    // to a middle on the cut axes, which lies between the two — so a box the
    // ragged edge cannot possibly cross can be settled whole, in either
    // direction, without ever cutting it up.
    // ...and, when it does need cutting, at whose grid: the FINEST of the blasts
    // that reach it, since a box the bullet hole crosses has to describe the
    // bullet hole's arc however big the corner next to it is.
    const decide = (b) => {
      if (b.y0 < floorY + KEEP_BASE) return { verdict: 'keep' };
      let grid = Infinity;
      for (const bl of blasts) {
        const { near, far } = nearFar(b, bl);
        // Only a `through` blast can settle a box as simply gone. A crater
        // never empties a box outright — it takes a bite out of the face of it
        // — so anything it reaches has to be cut up and carved individually.
        if (bl.through && far <= bl.r * (1 - RAG)) return { verdict: 'gone' };
        if (near < bl.r * (1 + RAG)) grid = Math.min(grid, bl.grid ?? bayFor(bl.r));
      }
      return grid === Infinity ? { verdict: 'keep' } : { verdict: 'cut', grid };
    };

    // Eats a crater into the face of one bay: the sphere reaches `cut` deep at
    // this bay's distance off its axis, so the bay's NEAR face — the side the
    // round came from — moves in by that much. Returns whether anything is left.
    //
    // Which face is near is read off where the blast centre sits rather than
    // assumed, because a machine can be backed against a wall on either side
    // and the shot always comes from the room.
    const lo = `${depthAxis}0`, hi = `${depthAxis}1`;
    const carve = (bay, bl, edge) => {
      const dy = (bay.y0 + bay.y1) / 2 - bl.y;
      const dl = depthAxis === 'x'
        ? (bay.z0 + bay.z1) / 2 - bl.z
        : (bay.x0 + bay.x1) / 2 - bl.x;
      const off = Math.hypot(dy, dl);
      if (off >= edge) return 'miss';

      // `maxCut` is what makes a DISH a dish. A plain sphere wide enough to
      // deform the plating around the corner is also deeper than the machine
      // everywhere it reaches, so it would simply enlarge the hole.
      const cut = Math.min(bl.maxCut ?? Infinity, Math.sqrt(edge * edge - off * off));
      const at = depthAxis === 'x' ? bl.x : bl.z;
      if (Math.abs(at - bay[lo]) <= Math.abs(at - bay[hi])) {
        const face = Math.min(bay[hi], at + cut);
        if (face >= bay[hi] - 1e-3) return 'gone';
        bay[lo] = face;
      } else {
        const face = Math.max(bay[lo], at - cut);
        if (face <= bay[lo] + 1e-3) return 'gone';
        bay[hi] = face;
      }
      return 'carved';
    };

    const gone = [], kept = [], craterFloor = [];
    for (const b of coarse) {
      const { verdict, grid } = decide(b);
      if (verdict === 'gone') { b._gone = true; gone.push(b); continue; }
      if (verdict === 'keep') { kept.push(b); continue; }

      // Only the shell around a hole is worth the fine grid.
      for (const fine of baysOf(b, grid, depthAxis)) {
        if (fine.y0 < floorY + KEEP_BASE) { kept.push(fine); continue; }
        let out = false;
        for (const bl of blasts) {
          // A wobble on the radius, small enough that the circle survives it —
          // see RAG. What makes the edge look violent is the rim, not this.
          const edge = bl.r * (1 - RAG + Math.random() * RAG * 2);
          if (bl.through) {
            if (distToBay(fine, bl.x, bl.y, bl.z, depthAxis) < edge) { out = true; break; }
            continue;
          }
          const bit = carve(fine, bl, edge);
          if (bit === 'gone') { out = true; break; }
          // The floor of the crater is where the arcs live — see the anchors
          // below. Only bays it really bit into, or a shallow graze at the rim
          // puts an arc on undamaged plating; and never the dish, which barely
          // bites anywhere and would spray arcs over the whole end of the
          // machine rather than over the damage.
          if (bit === 'carved' && !bl.maxCut && edge - Math.hypot(
            (fine.y0 + fine.y1) / 2 - bl.y,
            depthAxis === 'x' ? (fine.z0 + fine.z1) / 2 - bl.z : (fine.x0 + fine.x1) / 2 - bl.x,
          ) > CRATER_BITE) {
            craterFloor.push({
              x: (fine.x0 + fine.x1) / 2, y: (fine.y0 + fine.y1) / 2, z: (fine.z0 + fine.z1) / 2,
            });
          }
        }
        if (out) { fine._gone = true; gone.push(fine); continue; }
        // A fine bay is by construction a bay near damage, so all of them are
        // knocked out of true — see BUCKLE_SHIFT. Doing this to the coarse bays
        // as well would buckle plating nothing ever hit.
        fine._buckle = true;
        kept.push(fine);
      }
    }
    // Every bay scoring its way out at once would be a machine that vanished
    // with extra steps; the caller has already erased the batch by this point,
    // so there would be nothing left to stand there.
    if (!kept.length) return false;

    // How far this bay is from the nearest edge of any damage — negative inside
    // one. Both the soot and the buckling are read off it, so the metal that is
    // burnt is the metal that is bent, which is the metal that was hit.
    const offDamage = (bay) => {
      let near = Infinity;
      for (const bl of blasts) {
        near = Math.min(near, Math.hypot(
          Math.max(bay.x0 - bl.x, 0, bl.x - bay.x1),
          Math.max(bay.y0 - bl.y, 0, bl.y - bay.y1),
          Math.max(bay.z0 - bl.z, 0, bl.z - bay.z1),
        ) - bl.r);
      }
      return near;
    };

    const byMaterial = new Map();
    for (const bay of kept) {
      const off = offDamage(bay);
      const burnt = charOf(bay.material, off < SOOT_REACH);
      let list = byMaterial.get(burnt);
      if (!list) byMaterial.set(burnt, list = []);

      const item = {
        cx: (bay.x0 + bay.x1) / 2, cy: (bay.y0 + bay.y1) / 2, cz: (bay.z0 + bay.z1) / 2,
        sx: bay.x1 - bay.x0, sy: bay.y1 - bay.y0, sz: bay.z1 - bay.z0,
      };

      // Pushed along the depth and tilted. The gaps this opens between
      // neighbouring bays are the point rather than a defect — that is what a
      // seam looks like once the panel either side of it has moved — but only
      // near the damage, and only in proportion to the size of the piece.
      const wrench = bay._buckle && off < BUCKLE_REACH
        ? (1 - Math.max(0, off) / BUCKLE_REACH)
          * Math.min(1, Math.max(item.sx, item.sy, item.sz) / BUCKLE_FULL)
        : 0;
      if (wrench > 0.02) {
        const shift = (Math.random() * 2 - 1) * BUCKLE_SHIFT * wrench;
        if (depthAxis === 'x') item.cx += shift; else item.cz += shift;
        const tilt = BUCKLE_TILT * wrench;
        item.q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          (Math.random() * 2 - 1) * tilt,
          (Math.random() * 2 - 1) * tilt,
          (Math.random() * 2 - 1) * tilt,
        ));
      }
      list.push(item);
    }
    // Torn metal round every rim, into the same material buckets, so it merges
    // into the hulk rather than becoming meshes of its own. Not round the dish:
    // nothing was torn there, the plating was pushed — and at nearly twice the
    // corner's radius it would hang a hundred shards over undamaged metal.
    for (const blast of blasts) {
      if (!blast.maxCut) rimSpikes(blast, kept, byMaterial);
    }
    if (!byMaterial.size) return false;

    const raised = [];
    for (const [material, items] of byMaterial) {
      if (!items.length) continue;
      const mesh = new THREE.Mesh(stampBoxes(items), material);
      mesh.name = 'wreck';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      raised.push(mesh);
    }
    // Nothing standing means the caller has to hear about it, or the floor keeps
    // a collider around a machine that is not there.
    if (!raised.length) return false;

    this.level?.objects?.push(...raised);
    this.level?.meshes?.push(...raised);
    this.shooting?.addHittables(raised);
    if (this.level?.meshes) this.effects?.setSurfaces(this.level.meshes);

    // Struck from the holes, falling back to the top of what is left if the
    // blast happened to tear nothing out — a wreck with no arcs at all would be
    // the one that scored unluckily, which is not a thing the player can know.
    this.arcs?.dispose();
    // Struck from the damage: the bays the corner took, and the floor of the
    // crater — which contributes no missing bays at all, because carving one
    // does not remove it. Falling back to the top of what is left if neither
    // produced anything, since a wreck with no arcs is the one that scored
    // unluckily and that is not a thing the player can know.
    const torn = [
      ...gone.map((b) => ({
        x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2,
      })),
      ...craterFloor,
    ];
    const anchors = torn.length ? torn : kept.map((b) => ({
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
