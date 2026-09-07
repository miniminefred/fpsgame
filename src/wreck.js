// The generator, after it has gone up.
//
// One prop in the building is destroyed and yet still THERE, and this is the
// thousand lines that answer what is left. Everything else on a floor vanishes
// when it breaks, which is right for a filing cabinet and wrong for the reason
// the plant room exists at all — a machine you shot to cut the power to the
// floor should leave the machine, with the blasts in it that stopped it.
//
// It is here rather than in destruction.js because it shares nothing with the
// rest of that file: not one of its sixty-odd constants, and not one of its
// helpers, is read by anything else in the game. What it does share is the
// class, so it goes back on as a method — see the note by
// `Object.defineProperties` at the bottom of destruction.js.
//
// FIVE CAUSES WITH FIVE SIGNATURES, which is the design rather than the
// implementation: damage spread evenly over a wreck is texture, and damage you
// can point at is an event. The corner that was blown clean off, the dish that
// deformed the plating around it, the shrapnel that came back off the machine,
// the round the player actually aimed, and the two extras that are always there
// because something inside a generator goes up with it. See CLAUDE.md, "The
// generator room", which is where the arguments for every number in here live.
//
// The one thing to know before touching any of it: `hulk === true` names the
// machine's own MASS and everything else on it is trim. The difference is only
// that this file measures the machine off the first set — where its corners
// are, how big a corner is worth blowing off one this long, which of its faces
// the room is on — and a fitting standing 1.7 m proud of the housing answers
// all three wrongly.

import * as THREE from 'three';
import { Arcs } from './arcs.js';

// How much of its own colour a burnt surface keeps (see `_wreck`). Scorched
// rather than black: derived from each surface's own material instead of one
// flat soot colour, so a wreck still reads as the several materials it was
// welded out of and not as an untextured slab. Roughness goes near matte and
// metalness to nothing, because what is left is oxide, not steel.
const CHAR = 0.24;

const CHAR_ROUGHNESS = 0.94;

// ...and what a burnt LAMP keeps, which is a different question. Everything
// above is about a surface being scorched, and scaling a colour is the right
// model for that: dark grey plating and a dark yellow hazard band are both
// still recognisably what they were. A lit indicator is not. Its colour is not
// what it is painted, it is the fact that it is ON — so scaling it leaves a
// dimmer green light, and a machine that has just blacked out the floor sits
// there in the dark with eight rows of green still showing. The colour has to
// go, not just the brightness: a lamp that is out is a piece of dark plastic.
//
// Saturation is therefore cut almost out, and lightness is CAPPED rather than
// scaled, because these are two different things wearing one material type. A
// bright lens is pulled down to dead plastic; a screen that was already a dark
// slate stays exactly as dark as it was and merely stops being blue. A cap does
// both; a scale would brighten nothing and a fixed value would lift the screen.
const DEAD_LENS_SAT = 0.15;

const DEAD_LENS_MAX_L = 0.42;

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
// is damaged by five causes with five signatures, and every one of them is the
// same sphere with a centre and a radius, which is what lets one loop cut them
// all and one loop hang torn metal round them:
//
//   the corner    one end blown clean off, and the only one that goes THROUGH
//   the dish      the same blast deforming the plating for a way around it
//   the shrapnel  what came off the machine, hitting the rest of it
//   the round     the crater from the shot that finished it, aimed by the player
//   the extras    two more, always: something inside it went up as it died
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
//   plating for a way around the corner is pushed in, and without it the corner
//   is a shape subtracted from an otherwise mint machine. Its radius is a
//   multiple of the corner's, and it is CAPPED in depth — left as a plain
//   sphere it is deeper than the machine everywhere it reaches and simply makes
//   the hole bigger, which is the opposite of the point.
//
//   The cap has to stay under the RIBS' depth (0.12 — see the generator's own
//   build in gen/props.js), and that is the one number here that is a threshold
//   rather than a taste. A rib is 12 cm proud of the housing, so a dish deeper
//   than that does not dent it, it deletes it: at 0.22 every rib within the
//   dish's radius vanished, which stripped the machine's whole vertical rhythm
//   over a four-metre span and was most of what made the wreck read as a chewed
//   mess rather than as a machine with a hole in it. Under 0.12 the ribs stay
//   and only the skin behind them is pushed back.
const DISH_SCALE = 1.4;

const DISH_DEPTH = 0.09;

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

//   Two more, always: whatever finished the machine, something inside it went
//   up with it. One crater the size of the round's and one small one, so a
//   wreck is never the corner plus a single hole however it died — and so a
//   machine taken out by somebody else's explosion, which leaves no round at
//   all, is still a machine that came apart rather than one with a bite out of
//   its end. They sit at least EXTRA_FROM_CORNER along the machine from the
//   corner: any nearer and they read as two large pieces of shrapnel instead
//   of as their own events, which is ground the shrapnel already covers.
const EXTRA_TINY_R = 0.26;

const EXTRA_FROM_CORNER = 0.25;

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
// All three were dialled back hard after the first pass: at 0.7 / 0.05 / 0.13
// the metal around a hole came out as a cloud of separately-tilted chips, and
// the clean round crater the hole is supposed to be was lost inside it. The job
// here is to stop the edge being suspiciously flat, not to shatter it — the rim
// spikes are what make it violent. Small enough that you notice it only by
// noticing the plating is no longer true.
const BUCKLE_REACH = 0.45;

const BUCKLE_SHIFT = 0.02;

const BUCKLE_TILT = 0.05;      // radians, on a piece big enough to earn it

const BUCKLE_FULL = 0.3;       // ...the FACE size at which it gets all of that

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

// ...and how far INTO that metal the root is then buried, as a fraction of the
// bar's own thickness. Landing a bar's end face exactly on the surface is
// touching, and touching is enough from most angles: at a grazing one the
// rectangular section pokes through the plating on one side and opens a wedge
// of daylight under the other. A bite closes it.
//
// It goes along the surface normal rather than back down the bar, which looks
// like the long way round and is the only one that works. Back down the bar is
// into the metal for the 30% that bend inward through the hole, and into the
// HOLE for the 70% that peel outward — the same offset lands on opposite sides
// of the plating depending on which way the shard went. The normal is into the
// metal by construction. Scaled by thickness because it is a fixed distance
// that must not exceed what it is burying: half of a shard's own section is
// always enough to close the wedge, and always leaves the other half proud even
// where a shard has been laid flat against the plating.
const ROOT_BITE = 0.5;

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

const _rootIn = new THREE.Vector3();

const _deadHsl = { h: 0, s: 0, l: 0 };

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
 * Buries a root `dist` into the bay it was pulled onto, along the inward normal
 * `rimPoint` left in `_rootIn` — and never THROUGH it, which is the whole
 * reason this is a function and not a line.
 *
 * A bay is not always plating. The rim of a hole is where the buckling is
 * worst, so the nearest kept metal to a sample is regularly a 4 mm sliver of
 * trim rather than the 9 cm block next to it, and a bite sized off the bar goes
 * clean out of the far side — the root pops out of the back of the very piece
 * it is anchored in, which is the fault it was added to fix, one step smaller.
 * Clamping the offset back into the box caps the bite at the far face: a sliver
 * anchors flush, anything thicker anchors properly buried. It was 9 roots in
 * 374 before the clamp.
 */

function biteInto(at, bay, dist) {
  at.addScaledVector(_rootIn, dist);
  return at.set(
    Math.min(Math.max(at.x, bay.x0), bay.x1),
    Math.min(Math.max(at.y, bay.y0), bay.y1),
    Math.min(Math.max(at.z, bay.z0), bay.z1),
  );
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
    if (!near) return null;

    // ...and then PULLED ONTO IT, which is the difference between a shard that
    // was torn off the machine and one hanging in the room beside it. The
    // sample is a point on the blast sphere: that is where the rim runs, but
    // the rim is ragged and the metal under it is boxes, so `SPIKE_REACH`
    // admits a sample up to 0.42 m clear of the nearest bay — and a shard drawn
    // from there begins in mid-air with nothing behind it. Measured over ten
    // machines before this, the median root stood 8 cm off the metal, a third
    // of them over 15 cm, and one in eleven over 30 cm.
    //
    // The nearest point on the bay is the honest place for it, and it does not
    // move the rim: the nearest kept metal to a point on the rim IS the rim.
    // Clamping per axis is the whole of it, and a sample that landed inside
    // kept metal is already its own nearest point, so it is left alone.
    _rootIn.copy(atOut);
    atOut.set(
      Math.min(Math.max(atOut.x, near.x0), near.x1),
      Math.min(Math.max(atOut.y, near.y0), near.y1),
      Math.min(Math.max(atOut.z, near.z0), near.z1),
    );
    // Which way is INTO the metal, kept as a unit normal for the bite at the
    // call sites. A sample that was already inside kept metal is its own
    // nearest point, so there is no direction and nothing to bite.
    _rootIn.subVectors(atOut, _rootIn);
    if (_rootIn.lengthSq() > 1e-8) _rootIn.normalize();
    else _rootIn.set(0, 0, 0);
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
    // Bitten into the metal rather than stood against it. See ROOT_BITE.
    const section = long ? thick * 0.55 : thick;
    list.push(barStamp(biteInto(_spikeAt, near, section * ROOT_BITE),
      _spikeDir, lo + Math.random() * (hi - lo), section));
  }

  // --- severed wiring ---------------------------------------------------------
  // A fist-sized pock has not opened a loom; only a real tear has. Each wire
  // leaves the rim pointing outward and then hangs, one joint at a time, which
  // is what stops it being another spike in a different colour.
  if (blast.r < WIRE_MIN_R) return;
  const wires = WIRES[0] + Math.floor(Math.random() * (WIRES[1] - WIRES[0] + 1));
  for (let i = 0; i < wires; i++) {
    const rooted = rimPoint(_wireDir, _wireAt);
    if (!rooted) continue;

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
    // The first joint is bitten in like a shard's root: a cable that begins at
    // the surface reads as laid across the hole rather than as coming out of it.
    biteInto(_wireAt, rooted, thick * ROOT_BITE);
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
      // A lens and a screen are drawn UNLIT (MeshBasicMaterial) — being immune
      // to the room's lighting is exactly what makes them read as lit. Charring
      // one by darkening its colour is therefore not enough: it goes on
      // ignoring the blackout it just caused, and a dead indicator ends up the
      // brightest thing left in a black room, on the machine that switched the
      // lights off. A burnt-out lens is a piece of dark plastic, so it becomes
      // an ordinary lit material like the rest of the hulk.
      const burnt = material.isMeshBasicMaterial
        ? new THREE.MeshStandardMaterial({
          color: material.color?.clone() ?? 0xffffff,
          side: material.side,
        })
        : material.clone();
      // Being unlit is the same evidence twice: it is what made this read as a
      // lamp, so it is also what says the COLOUR was the lamp being on rather
      // than paint. See DEAD_LENS_SAT — without this the indicators come
      // through as dimmer green and go on being the brightest thing in a room
      // the machine itself has just put in the dark.
      if (material.isMeshBasicMaterial && burnt.color) {
        burnt.color.getHSL(_deadHsl);
        burnt.color.setHSL(
          _deadHsl.h,
          _deadHsl.s * DEAD_LENS_SAT,
          Math.min(_deadHsl.l, DEAD_LENS_MAX_L),
        );
      }
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

/**
 * Mixed onto `Destruction.prototype` by destruction.js.
 */
export const wreckMethods = {
    _wreck(entry, point) {
      // --- the machine's own extent, which is what says where its corners are,
      // how big a corner ought to be on a machine this long, and which way it is
      // facing. All three have to be known BEFORE anything is cut up.
      const welded = entry.parts.filter((part) => part.hulk && part.material);
      if (!welded.length) return false;
      // Measured off the WELDED STRUCTURE alone, never the trim bolted to it (see
      // `hulk` in gen/sink.js). Every one of these numbers is an answer about the
      // machine — where its corners are, how big a corner is worth blowing off one
      // this long, which of its faces the room is on — and a fitting that stands
      // clear of the plating answers all three wrongly: exhaust stacks reaching
      // 1.7 m over the housing would put the corner blast in the air above it, and
      // a gantry 0.3 m proud of the front would call the front of the machine a
      // third of a metre further out than the plating a round actually lands on.
      // Trim is cut and carved with the rest; it just does not get a vote here.
      const frame = welded.filter((part) => part.hulk === true);
      if (!frame.length) return false;
      let floorY = Infinity;
      let minX = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const b of frame) {
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

      // ...and the two that are always there: something inside the machine let go
      // as it died. Cratered like the round — never `through`, so they are bites
      // out of the near face like everything but the corner — placed along the
      // machine away from the corner, at any height clear of the plinth.
      //
      // Both take `bayFor`'s grid, which for the small one is the BAY_MIN floor,
      // and that is the opposite of what SHRAPNEL_GRID decided one blast up. It
      // is the same trade read the other way round: a pock is a mark and does not
      // have to survive being looked at, so it is not worth cutting a coarse box
      // into eighty pieces for. A hole is a hole, and a hole with the grid's
      // resolution across it is a rasterised circle you can count the pixels of.
      // Measured over the same ten machines, the small one costs 18 ms of _wreck
      // at BAY_MIN against 3 ms at SHRAPNEL_GRID; the full-size one costs 30 ms
      // whatever it is given, and the pair together take _wreck from 55 ms to
      // 95 ms. Those are one machine's numbers at about 3x the reference the
      // 18-26 ms band was measured on, so the honest reading is high twenties
      // rather than mid teens: this frame got dearer, and it is still a long way
      // from the 181 ms the stamper was written to fix (see BAY_PER_RADIUS).
      for (const r of [HOLE_R, EXTRA_TINY_R]) {
        const t = EXTRA_FROM_CORNER + spread() * (1 - EXTRA_FROM_CORNER);
        const at = cornerAt + (farAt - cornerAt) * t;
        // Whole, which is why the height is inset by the radius at both ends
        // rather than drawn over the machine's own rise the way the shrapnel's
        // is. The bottom KEEP_BASE is protected, so a crater centred just above
        // it comes out with its lower half simply missing — which reads as a bite
        // out of the plinth line rather than as a hole, and reads worse the
        // smaller the hole is. A pock can be clipped and still be a pock; a hole
        // the size of the round's cannot.
        const yLo = floorY + KEEP_BASE + r;
        const yHi = Math.max(yLo, maxY - r);
        const y = yLo + spread() * (yHi - yLo);
        blasts.push({
          x: alongX ? at : nearFace,
          y,
          z: alongX ? nearFace : at,
          r,
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
        // Clamped to the bay at BOTH ends, not just the far one. `at` sits on the
        // structure's near face, and trim stands proud of it — a handrail is a
        // 6 cm bar 0.3 m in front of the plating — so a shallow cut can land in
        // front of a bay entirely, and the unclamped face would then move the
        // bay's back wall BACKWARD and stretch the bar into a slab. Nothing in
        // front of a blast is ever added to by it.
        if (Math.abs(at - bay[lo]) <= Math.abs(at - bay[hi])) {
          const face = Math.min(bay[hi], Math.max(bay[lo], at + cut));
          if (face >= bay[hi] - 1e-3) return 'gone';
          bay[lo] = face;
        } else {
          const face = Math.max(bay[lo], Math.min(bay[hi], at - cut));
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
        // Sized off the bay's FACE — the two axes it was cut on — and not off its
        // largest dimension, which is always the machine's full depth because bays
        // are never cut across it. Measuring the max meant every bay scored 1 and
        // the scaling did nothing at all: a 9 cm chip was thrown as hard as a
        // panel, which is exactly the cloud of separately-tilted chips this term
        // exists to prevent.
        const face = depthAxis === 'x'
          ? Math.min(item.sy, item.sz)
          : Math.min(item.sx, item.sy);
        const wrench = bay._buckle && off < BUCKLE_REACH
          ? (1 - Math.max(0, off) / BUCKLE_REACH) * Math.min(1, face / BUCKLE_FULL)
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
      this.arcs = new Arcs(this.scene, anchors, { light: this.lighting?.spark, audio: this.audio });

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
     */,
};
