// The plant room's mezzanine: a deck one storey up over three of its four walls,
// the flight that reaches it, and the workstations along its railing.
//
// Its own file because it is a set piece rather than a system — about one floor
// in thirty has a generator room at all — and because everything in it is
// arithmetic in the room's own two axes, which nothing else in the builder
// works in.

import { applyWorldUVs, boxBetween } from './geom.js';
import { footprintOf, tryPlace } from './props.js';
import { doorSide, doorsOnRoom, TILE, WALL_H, worldX, worldZ } from './layout.js';
import { RISER } from './stairs.js';
import { generatorPanel, LIGHT_PITCH, stampOccupied } from './shell.js';
import { makeSink } from './sink.js';

// A mezzanine over the generator room: a deck reaching three of its four walls,
// with the fourth side open over the machine, and a flight up beside the door.
//
// The deck is colliders-only — pushed straight into `masks.colliders` rather
// than through `sink.obstacle()`, so none of it touches the nav grid: an enemy
// on the ground floor is blind to the height difference, same as the ground is
// blind to a storey's own furniture. That's a real gameplay compromise (nobody
// up here gets shot at, or shoots down), accepted for what's a one-room
// flourish rather than a second attic-and-basement system. Its FURNITURE is not
// colliders-only: the desks go in through a level sink of their own, the same
// machinery furnishLevels uses for an attic, so they are ordinary destructible
// props that come apart when shot.
//
// Everything below is worked in the room's own two axes rather than in x/z, and
// they are worth naming because every number is in them:
//
//   u   from the door wall into the room, 0 at the door wall. The generator is
//       at the far end of u, spanning that entire wall.
//   v   along the door wall, 0 at one side wall and vLen at the other.
//
// So the deck is u in [0, depth] by the full width of v, and the flight runs
// inside a notch cut out of it, flush against a wall — the door wall where the
// run fits beside the opening, a side wall where it does not. That is the whole
// shape of the thing: walk in, turn left or right, and walk straight up.
export function buildGeneratorMezzanine(layout, batcher, materials, masks, rng) {
  const room = layout.rooms.find((r) => r.role === 'generator');
  if (!room) return;
  // `doorsOnRoom`, not `room.doors[0]`: the room's own list only holds doors
  // IT cut, and its one real doorway may belong to the room next door — see
  // the same note in generatorRoom (gen/rooms.js).
  const door = doorsOnRoom(layout.doors, room)[0];
  if (!door) return;

  const DECK_Y = WALL_H;        // one ordinary storey up — the same datum the
                                // attic/basement system uses, just not wired
                                // into it (see the note above).
  const DECK_T = 0.2;
  const RAIL_H = 1.0;
  const RAIL_T = 0.06;
  const GOING = 0.26;           // an industrial access stair is steep
  const STAIR_W = 1.3;
  // How far past the doorway's edge the bottom tread starts. The flight goes
  // flush against the door wall and BESIDE the opening, which is what makes the
  // walk one turn: in, turn left (or right), straight up, with the first tread
  // where the turn puts you. Half a metre is what clears the door furniture —
  // a room's badge reader beds into the jamb 0.16 m past the opening and is
  // 0.15 m wide along the wall, so it ends at 0.235 — with enough left over to
  // stand on to make the step up.
  const DOOR_GAP = 0.5;
  // A body's length of floor. Used twice for the same reason both times: it is
  // how much room the foot of a flight needs in front of it to be climbable at
  // all — once when a side-wall flight decides where to start, and again when
  // the furnisher is told to keep off that floor.
  const FOOT_ROOM = 1.3;
  // The hole in the deck is wider than the flight in it. A notch cut to exactly
  // the stair's width leaves a body climbing it no room to be off-centre: the
  // player is 0.8 m across on a 1.3 m tread, and the moment their shoulder
  // crosses the deck's edge their head meets its underside — which happens
  // around the sixth step, where standing height first reaches the 3.0 m soffit.
  // It reads as the stairs simply stopping half way up. Found by walking, not
  // by looking: a body that climbed to 2.8 m and then would not go on.
  //
  // Only the side away from the wall needs it once the flight is flush: on the
  // near side there is no deck edge to meet, because the wall itself is what
  // the notch stops against, and the wall stops the body a whole step earlier
  // than its head would ever reach the soffit.
  const NOTCH_PAD = 0.5;
  // The deck stops this far off the generator's wall: the machine's own 3.0 m
  // depth (its pipework is inside its footprint — see `generator` in
  // gen/props.js) plus the 0.15 m wall inset, plus a slot to see it down. The
  // machine stands 5.9 m tall against a 6.4 m wall, so what this buys is the
  // whole of it visible from the deck rather than its top half met at waist
  // height.
  const GEN_CLEAR = 0.15 + 3.0 + 0.5;

  // The flight's rise-per-step matches every other staircase in the building
  // (RISER, from gen/stairs.js — small enough to walk up without jumping), so
  // its run is fixed by that and by DECK_Y rather than chosen independently.
  const steps = Math.ceil(DECK_Y / RISER);
  const riser = DECK_Y / steps;
  const RUN = steps * GOING;

  const doorWallSide = doorSide(door, room);
  const x0 = worldX(layout, room.x0), x1 = worldX(layout, room.x1);
  const z0 = worldZ(layout, room.y0), z1 = worldZ(layout, room.y1);

  // v runs along the door wall; u runs away from it into the room.
  const alongX = doorWallSide === 0 || doorWallSide === 2;
  const uWall = doorWallSide === 0 ? z1 : doorWallSide === 2 ? z0
    : doorWallSide === 1 ? x0 : x1;
  const uSign = (doorWallSide === 0 || doorWallSide === 3) ? -1 : 1;
  const vLo = alongX ? x0 : z0;
  const vLen = alongX ? x1 - x0 : z1 - z0;
  const uLen = alongX ? z1 - z0 : x1 - x0;

  const depth = uLen - GEN_CLEAR;
  // Enough deck left over beside a stairwell to be worth climbing to. This is
  // the bar for the door-wall arrangement, which is the shallower of the two;
  // the side-wall one needs a whole RUN of depth and asks for it itself.
  if (depth < STAIR_W + NOTCH_PAD + 1.4) return;   // no deck worth standing on

  // The doorway's extent along that wall. The flight starts just past one edge
  // of it, so what has to fit is the whole run between that edge and the far
  // corner — the opening itself is dead length either way.
  const dA = (alongX ? worldX(layout, door.x0) : worldZ(layout, door.y0)) - vLo;
  const dB = (alongX ? worldX(layout, door.x1) : worldZ(layout, door.y1)) - vLo;
  const dLo = Math.min(dA, dB), dHi = Math.max(dA, dB);

  // Where the flight goes, as the rectangle it occupies plus which way it
  // climbs. There are two arrangements and BOTH are flush against a wall, which
  // is the whole point of them: a flight standing off in the middle of the room
  // reads as a piece of furniture somebody left there rather than as part of
  // the building.
  //
  //   'v'  along the door wall, flush at u = 0, its bottom step DOOR_GAP past
  //        the edge of the opening. First choice, because the walk is one turn:
  //        in, turn left (or right), straight up, with the first tread exactly
  //        where the turn leaves you.
  //   'u'  along a side wall, flush at v = 0 or vLen, climbing away from the
  //        door wall. Second choice, and what it costs is the walk along the
  //        door wall to reach the foot. It is needed because being flush makes
  //        the RUN the constraint: the opening plus a whole run has to fit on
  //        one wall, so a nine-metre door wall with the door in the middle has
  //        not four metres either way. Measured over 198 generator rooms, the
  //        door wall takes it 86% of the time and this takes the other 14%.
  //
  // Either way the flight climbs AWAY from where you come in. One that climbed
  // back toward the door would be one you walk past and turn round in.
  const options = rng.chance(0.5) ? [-1, 1] : [1, -1];
  let plan = null;
  for (const d of options) {
    const f = d < 0 ? dLo - DOOR_GAP : dHi + DOOR_GAP;
    const t = f + d * RUN;
    if (Math.min(f, t) >= 0.25 && Math.max(f, t) <= vLen - 0.25) {
      plan = { axis: 'v', c0: 0, c1: STAIR_W, foot: f, dir: d };
      break;
    }
  }
  if (!plan && depth >= FOOT_ROOM + RUN + 0.25 && vLen >= STAIR_W + NOTCH_PAD + 1.4) {
    // The side wall nearer the door, so the walk to the foot is the shorter of
    // the two. The flight starts FOOT_ROOM off the door wall rather than in the
    // corner: it climbs into the room, so the floor you step onto the bottom
    // tread from is the floor between it and the door wall, and jammed into the
    // corner there is none — you would be stepping onto the flight sideways.
    const near = (dLo + dHi) / 2 < vLen / 2;
    const c0 = near ? 0 : vLen - STAIR_W;
    plan = { axis: 'u', c0, c1: c0 + STAIR_W, foot: FOOT_ROOM, dir: 1 };
  }
  if (!plan) return;   // no wall in this room can take the run

  // The hole in the deck: the flight's own rectangle, padded across its width
  // on any side that is not a wall. Along the run it is not padded at all —
  // the foot end is at floor level so there is nothing to duck, and the head
  // end has to meet the deck exactly or there is a gap to step over.
  const top = plan.foot + plan.dir * RUN;
  const pad = (lo, hi, limit) => [Math.max(0, lo - NOTCH_PAD), Math.min(limit, hi + NOTCH_PAD)];
  const [nu0, nu1] = plan.axis === 'v'
    ? pad(plan.c0, plan.c1, depth)
    : [Math.min(plan.foot, top), Math.max(plan.foot, top)];
  const [nv0, nv1] = plan.axis === 'v'
    ? [Math.min(plan.foot, top), Math.max(plan.foot, top)]
    : pad(plan.c0, plan.c1, vLen);
  // Which edge of that hole is the head of the flight, and so has to stay open:
  // it is the way onto the deck.
  const head = plan.axis === 'v' ? (plan.dir > 0 ? 'v1' : 'v0') : 'u1';

  // One drawing primitive for the whole mezzanine: a u/v rectangle between two
  // heights. u runs either way in world space, so the min/max is taken rather
  // than assumed, and a run that is a line in plan (a railing) is given the
  // thickness it is asked for about that line — a zero-width box draws as
  // nothing and collides with nothing, which is a railing you fall through.
  // u/v rectangle to world box. Separate from `piece` because the furnisher
  // reservation below wants the box without anything being drawn into it.
  const rect = (u0, u1, v0, v1) => {
    const ua = uWall + uSign * u0, ub = uWall + uSign * u1;
    const va = vLo + v0, vb = vLo + v1;
    return {
      bx0: alongX ? Math.min(va, vb) : Math.min(ua, ub),
      bx1: alongX ? Math.max(va, vb) : Math.max(ua, ub),
      bz0: alongX ? Math.min(ua, ub) : Math.min(va, vb),
      bz1: alongX ? Math.max(ua, ub) : Math.max(va, vb),
    };
  };
  const piece = (key, u0, u1, v0, v1, yLo, yHi, opts = {}) => {
    const { uv = false, solid = true, thin = 0 } = opts;
    let { bx0, bx1, bz0, bz1 } = rect(u0, u1, v0, v1);
    if (thin) {
      if (bx1 - bx0 < thin * 2) { const m = (bx0 + bx1) / 2; bx0 = m - thin; bx1 = m + thin; }
      if (bz1 - bz0 < thin * 2) { const m = (bz0 + bz1) / 2; bz0 = m - thin; bz1 = m + thin; }
    }
    const geom = boxBetween(bx0, yLo, bz0, bx1, yHi, bz1);
    batcher.add(key, materials[key], uv ? applyWorldUVs(geom) : geom);
    if (solid) {
      masks.colliders.push({
        minX: bx0, maxX: bx1, minZ: bz0, maxZ: bz1,
        base: yLo, top: yHi, building: true,
      });
    }
    return { bx0, bx1, bz0, bz1 };
  };

  // --- the deck, in four pieces around the stairwell notch ------------------
  // Whatever of [0, depth] x [0, vLen] the notch is not: two strips either side
  // of it on u, then the two ends of its own u band. Written as the complement
  // rather than as named pieces because the notch sits in a different place in
  // each arrangement, and a piece with no width has to drop out rather than be
  // drawn as a sliver. Flush against a wall, the strip on that side is exactly
  // the piece that has no width — the deck still reaches the wall, along its
  // length either side of the run, and the doorway is under one of those ends
  // because the flight starts beside the opening rather than in front of it.
  if (nu0 > 0.05) piece('trim', 0, nu0, 0, vLen, DECK_Y - DECK_T, DECK_Y, { uv: true });
  if (depth - nu1 > 0.05) piece('trim', nu1, depth, 0, vLen, DECK_Y - DECK_T, DECK_Y, { uv: true });
  if (nv0 > 0.05) piece('trim', nu0, nu1, 0, nv0, DECK_Y - DECK_T, DECK_Y, { uv: true });
  if (vLen - nv1 > 0.05) piece('trim', nu0, nu1, nv1, vLen, DECK_Y - DECK_T, DECK_Y, { uv: true });

  // --- lights under the deck --------------------------------------------------
  // Most of the room's floor is UNDER this thing, and both of the room's other
  // mounts are above it: the wall panels at 2.6 m are below the deck but only
  // four of them round the edge of a room up to fifteen metres across, and the
  // high bays are lighting the top of the deck rather than the three metres of
  // headroom beneath it. So the overhang lights what it shades, on the same
  // LIGHT_PITCH grid any other ceiling uses and at an ordinary ceiling's
  // `distance` — it is at an ordinary ceiling's height above the floor, which is
  // the whole difference between these and the high bays.
  //
  // Built here rather than in buildGeneratorLights because that pass runs long
  // before this one and cannot know where the deck ended up, or whether the room
  // got one at all — every early return above is a room with no overhang to
  // light.
  const SOFFIT_DROP = 0.015;
  const nuLights = Math.max(1, Math.round(depth / LIGHT_PITCH));
  const nvLights = Math.max(1, Math.round(vLen / LIGHT_PITCH));
  for (let i = 0; i < nuLights; i++) {
    for (let j = 0; j < nvLights; j++) {
      const u = depth * ((i + 0.5) / nuLights);
      const v = vLen * ((j + 0.5) / nvLights);
      // Nothing overhead to hang it from: that is the stairwell, not deck.
      if (u > nu0 && u < nu1 && v > nv0 && v < nv1) continue;
      const { bx0, bz0 } = rect(u, u, v, v);
      generatorPanel(batcher, materials, masks.fixtures, masks.destructibles,
        bx0, DECK_Y - DECK_T - SOFFIT_DROP, bz0,
        alongX ? 0.62 : 0.16, alongX ? 0.16 : 0.62, 11);
    }
  }

  // --- railings -------------------------------------------------------------
  // Glass with a dark capping rail, so the drop reads as a drop rather than as
  // an edge found with a foot. The long overlook faces the machine; the rest
  // fence the stairwell.
  const railing = (u0, u1, v0, v1) => {
    piece('glass', u0, u1, v0, v1, DECK_Y, DECK_Y + RAIL_H, { thin: RAIL_T });
    piece('metalDark', u0, u1, v0, v1,
      DECK_Y + RAIL_H - 0.03, DECK_Y + RAIL_H + 0.03, { solid: false, thin: RAIL_T + 0.02 });
  };
  railing(depth, depth, 0, vLen);              // the overlook, at the generator
  // Every edge of the stairwell except two kinds. The head of the flight stays
  // open because it is the way onto the deck; an edge with no deck beyond it is
  // a room wall rather than a drop, and a pane of glass standing in the plaster
  // is not a railing. Which edges those are is what differs between the two
  // arrangements, so it is asked of each edge rather than written out per case.
  if (nu0 > 0.05 && head !== 'u0') railing(nu0, nu0, nv0, nv1);
  if (depth - nu1 > 0.05 && head !== 'u1') railing(nu1, nu1, nv0, nv1);
  if (nv0 > 0.05 && head !== 'v0') railing(nu0, nu1, nv0, nv0);
  if (vLen - nv1 > 0.05 && head !== 'v1') railing(nu0, nu1, nv1, nv1);

  // --- the flight -----------------------------------------------------------
  // A straight run of solid pillars climbing flush along a wall, RISER by
  // RISER — the same climbable rise as every other staircase in the building
  // (see gen/stairs.js), just authored directly rather than through the
  // layout-level stairwell system. It needs no landing tread because the floor
  // it starts off is the floor you arrive on: on the door wall the bottom step
  // is DOOR_GAP along from the opening, so the turn out of the doorway puts you
  // square on it, and on a side wall it stands FOOT_ROOM off the door wall for
  // the same reason. The awkward case this replaced was a flight whose bottom
  // step was jammed against a wall with nothing in front of it to stand on.
  //
  // `along` is the run and `across` is the width, whichever way round u and v
  // are for this arrangement — a step is the same box either way.
  const along = (lo, hi) => (plan.axis === 'v' ? [plan.c0, plan.c1, lo, hi] : [lo, hi, plan.c0, plan.c1]);
  for (let i = 0; i < steps; i++) {
    const stepTop = (i + 1) * riser;
    const a = plan.foot + plan.dir * i * GOING, b = plan.foot + plan.dir * (i + 1) * GOING;
    const p = piece('trim', ...along(Math.min(a, b), Math.max(a, b)), 0, stepTop,
      { solid: false });
    // Shell, not furniture, unconditionally — the same call gen/stairs.js makes
    // for every one of its own treads: a step is structure, and `building:
    // true` is what keeps it out of the furniture dimension and doorway-swing
    // checks. `climb: true` is this flight's own problem to solve, not
    // validate-props.mjs's: nothing here is registered in `layout.stairs`, so
    // the generic geometric-reachability flood (which has no notion of
    // climbing, only of "clear at head height") would otherwise see sixteen
    // solid risers and call the room sealed. Pushed by hand rather than through
    // `piece` because a step is stood ON rather than walked under, so it has a
    // `top` and no `base`.
    masks.colliders.push({
      minX: p.bx0, maxX: p.bx1, minZ: p.bz0, maxZ: p.bz1, top: stepTop,
      building: true, climb: true,
    });
  }

  // Only the flight's own footprint is kept off the ground-floor furnisher, and
  // that is the whole of it. The deck now covers most of the room, and
  // reserving the ground under it would leave a plant room with nothing in it —
  // including, since furnishRooms runs after this, the generator. There is 3 m
  // of headroom under the deck; crates and workbenches belong there.
  // Including a body's length of floor beyond the bottom step. That is where you
  // stand to start climbing, and it is not covered by the flight's own
  // footprint — the same thing `approachTiles` does for the layout-level
  // stairwells, and for the same reason: a crate on the tile in front of the
  // first tread is a staircase you cannot get onto, and nothing else would
  // notice, because the deck is off the nav grid.
  const back = plan.foot - plan.dir * FOOT_ROOM;
  const r = rect(...along(Math.min(plan.foot, top, back), Math.max(plan.foot, top, back)));
  stampOccupied(masks.occupied, layout, r.bx0, r.bz0, r.bx1, r.bz1);

  dressMezzanine(layout, batcher, materials, masks, rng, {
    DECK_Y, depth, vLen, vLo, uWall, uSign, alongX, nu0, nu1, nv0, nv1,
  });
}

/**
 * The row of workstations along the mezzanine's railing, facing out over the
 * machine.
 *
 * Placed through a sink of its own at deck height rather than drawn into the
 * batch, which is what makes them real: ordinary destructible props with a
 * model, a monitor and a keyboard on them, that come apart when shot like every
 * other desk in the building. Same machinery as furnishLevels uses for an attic
 * — see the note there on why a level needs its own occupancy — with two
 * differences. `reserved` is inverted, so the only tiles the sink will place
 * into are the deck's; and `blocked` is a throwaway, because the mezzanine is
 * deliberately off the nav grid and a desk up here must not make the floor
 * underneath it impassable.
 */
function dressMezzanine(layout, batcher, materials, masks, rng, m) {
  const { W, H } = layout;
  const { DECK_Y, depth, vLen, vLo, uWall, uSign, alongX, nu0, nu1, nv0, nv1 } = m;

  const reserved = new Uint8Array(W * H).fill(1);
  const open = (u0, u1, v0, v1, val) => {
    const ua = uWall + uSign * u0, ub = uWall + uSign * u1;
    const ax = alongX ? vLo + v0 : Math.min(ua, ub);
    const bx = alongX ? vLo + v1 : Math.max(ua, ub);
    const az = alongX ? Math.min(ua, ub) : vLo + v0;
    const bz = alongX ? Math.max(ua, ub) : vLo + v1;
    const tx0 = Math.max(0, Math.floor((ax - layout.ox) / TILE));
    const tx1 = Math.min(W - 1, Math.ceil((bx - layout.ox) / TILE) - 1);
    const ty0 = Math.max(0, Math.floor((az - layout.oz) / TILE));
    const ty1 = Math.min(H - 1, Math.ceil((bz - layout.oz) / TILE) - 1);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) reserved[ty * W + tx] = val;
    }
  };
  // The deck, then the stairwell taken back out of it. Rounded inward for the
  // deck and outward for the hole, so a prop can never be fitted to a tile that
  // is only half floor.
  open(0.2, depth - 0.2, 0.2, vLen - 0.2, 0);
  open(nu0 - 0.2, nu1 + 0.2, nv0 - 0.2, nv1 + 0.2, 1);

  const sink = makeSink(layout, batcher, materials, {
    level: DECK_Y,
    blocked: new Uint8Array(W * H),
    occupied: new Uint8Array(W * H),
    reserved,
    colliders: masks.colliders,
    dynamics: masks.dynamics,
    destructibles: masks.destructibles,
  });

  // Facing +u, which is out over the railing at the machine. A prop is authored
  // facing -z and the quarter turn puts that face into the room, so the turn
  // that faces +u falls out of which world axis +u is and which way it runs —
  // the same table edgeProp works from (0 = the +z wall, 1 = -x, 2 = -z, 3 = +x).
  const rot = alongX ? (uSign > 0 ? 2 : 0) : (uSign > 0 ? 1 : 3);

  const { w: deskW, d: deskD } = footprintOf(sink, 'desk');
  const uDesk = depth - 0.35 - deskD / 2;   // backed up to the railing
  if (uDesk < nu1 + deskD) return;

  const PITCH = deskW + 0.55;
  const first = 0.5 + deskW / 2;
  const n = Math.floor((vLen - 2 * first + PITCH) / PITCH);
  for (let i = 0; i < n; i++) {
    const v = first + i * PITCH;
    const uw = uWall + uSign * uDesk;
    const cx = alongX ? vLo + v : uw;
    const cz = alongX ? uw : vLo + v;
    if (!tryPlace(sink, 'desk', cx, cz, rot, rng)) continue;
    // A short wall between this station and the last, which is what makes a row
    // of desks read as a bank of workstations rather than as furniture in a
    // line. Failing is fine — it is the desks that matter.
    if (i > 0) {
      const vp = v - PITCH / 2;
      const px = alongX ? vLo + vp : uWall + uSign * (uDesk - 0.1);
      const pz = alongX ? uWall + uSign * (uDesk - 0.1) : vLo + vp;
      tryPlace(sink, 'partition', px, pz, (rot + 1) & 3, rng);
    }
  }
}

// Marks every tile a world-space rectangle touches, rounding outward — the
// same generous rounding `makeSink`'s own `stamp` uses, for the same reason:
// under-reserving is what lets the next thing placed overlap it.
