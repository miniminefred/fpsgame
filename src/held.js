// Everything a body can be carrying, as a table.
//
// Four things end up in somebody's hands — a parcel crate, a drink out of the
// machine, a bundle of paper off the printer, a canteen tray — and each used to
// be a give/take pair of its own in enemies.js, with its own bit in the co-op
// snapshot, its own branch in `applySnapshot`, and its own string comparison in
// `chores.js`. Eight methods, four bits, four apply branches and five string
// tests, for four objects that differ in three things: what builds the mesh,
// what it is parented to, and whether anything else has to be remembered.
//
// So adding a fifth cost six edits across four files, and every one of them was
// somewhere a fifth could be forgotten. It is one entry now.
//
// It is the `BLUNT`, `CHORES` and `ROLES` shape a fourth time, and for the
// reason all three of those give: one builder plus a table of what differs beats
// four builders that are nearly the same.

import { buildCan, buildCrate, buildPapers, buildTray } from './rigs.js';

// How long somebody keeps the drink they just bought, and it is the whole of the
// can's lifetime — there is no `_lunchEnd` for a can and nothing else would ever
// take it off them. Long enough to walk it back to wherever they were going,
// which is the point of having bought it; not so long that a floor left alone
// for five minutes is a floor where everybody is holding one.
const CAN_TIME = [26, 52];

/**
 * The four, and the three ways they differ.
 *
 * `field` is where the mesh lives on the body — `carry` rather than `crate` for
 * the parcel, because that name is on the wire, in the animator and in three
 * other files and renaming it would be a change of a different kind.
 *
 * `snap` is its bit in the co-op snapshot's sixth slot. Every one of these is a
 * VISIBLE thing in a body's hand that a joiner has no way to derive: the errands
 * that hand them out are host-only and cross nothing, so without the bit one
 * browser has a man walking a corridor with a drink and the other has him
 * walking it empty-handed.
 *
 * `hand` says it is carried in ONE hand and hangs there, which is why those two
 * need no pose at all: the mesh is parented to the arm and inherits its swing,
 * its hinge and the body's own scale for free. A crate and a tray are carried in
 * BOTH hands, so they hang off the body and have to fight the walk cycle for the
 * arms — see `animate` in enemy-anim.js.
 */
export const HELD = {
  // The parcel crate: the same object a parcel run carries (jobs.js), a
  // stocktake moves (chores.js) and a contractor wheels out of the building.
  crate: {
    field: 'carry',
    snap: 64,
    // Keyed, because a crate carries a small carton on top of some of them and
    // which ones has to be a hash rather than a die — see `buildCrate`.
    make: (key) => buildCrate(key),
    // Onto the truck's toe plate if this one brought a truck, and into the
    // body's own frame otherwise. Parenting rather than positioning is the whole
    // point: the plate's height is arithmetic in rigs.js, and a box placed at a
    // number the animator keeps is that arithmetic written down twice.
    parent: (e) => e.load ?? e.group,
  },

  // The canteen tray, which is the break cycle's and nothing else's.
  tray: {
    field: 'tray',
    snap: 32,
    make: () => buildTray(),
    parent: (e) => e.group,
  },

  // A drink out of the vending machine, and the only one of the four with a
  // clock of its own — nothing else would ever take it off them.
  can: {
    field: 'can',
    snap: 128,
    // The seed picks the flavour AND whether this one came out already shot
    // through; see `drinkFrom` in drinks.js.
    make: (key) => buildCan(key),
    // HELD, rather than hanging off the bottom of the hand. `drop` is negative,
    // so the can's middle sits 2.6 cm ABOVE the point the hand is at and the
    // fist closes round its lower third — which is how a can is actually
    // carried, and the whole difference between somebody holding a drink and
    // somebody with a drink stuck to their wrist.
    //
    // ...and further FORWARD, because it is 9.4 cm across against an arm 14 cm
    // deep. At the paper's 3.5 cm the can is more inside the forearm than
    // outside it; at 7.2 the back of it is still buried in the hand, which is
    // what makes it read as gripped rather than as balanced on top of a fist.
    hand: { drop: -0.026, forward: 0.072 },
    given: (e) => { e.canTimer = CAN_TIME[0] + Math.random() * (CAN_TIME[1] - CAN_TIME[0]); },
    taken: (e) => { e.canTimer = 0; },
  },

  // The paperwork, out of the printer and on its way to a filing rack. No clock:
  // it is carried for exactly as long as the errand that produced it, and a
  // bundle left on a body afterwards is somebody walking the floor holding a
  // report they have already filed.
  papers: {
    field: 'papers',
    snap: 256,
    make: () => buildPapers(),
    // A little higher than a can and flat rather than upright: a stack of paper
    // tucked against the hip, not something with a lid on it.
    hand: { drop: -0.02 },
  },
};

/** Every kind, and every kind carried in one hand — both wanted by name. */
export const HELD_KINDS = Object.keys(HELD);

/**
 * Puts one in a body's hands. Already holding one is a no-op, not an error:
 * `giveCrate` is called from three unrelated errands and from the co-op wire,
 * and none of them wants to know whether it was first.
 *
 * `key` is a stable integer for this body at this moment, and it decides which
 * hand and — for a can — which drink. HASHED rather than rolled, because it has
 * to be identical in both browsers of a co-op session: there is a wire bit for
 * WHETHER the thing is held and nothing for which side it is on or what colour
 * it is. `armHalf` comes off the rig's own joints, because a hand is not in the
 * same place on a Porter Unit as on a person, and this game has paid for that
 * assumption three times (see `gunRest`, `boxAt` and `joints` in rigs.js).
 */
export function give(e, what, key = 0) {
  const spec = HELD[what];
  if (!spec || e[spec.field]) return;
  const mesh = spec.make(key);

  if (spec.hand) {
    const hash = Math.abs(Math.round(key)) || 1;
    const arm = (hash & 1) ? e.armR : e.armL;
    if (!arm) return;
    const half = e.joints?.armHalf ?? 0.27;
    mesh.position.set(0, -half - (spec.hand.drop ?? 0.03), -(spec.hand.forward ?? 0.035));
    arm.add(mesh);
    e[`${spec.field}Arm`] = arm;
  } else {
    spec.parent(e).add(mesh);
  }

  e[spec.field] = mesh;
  spec.given?.(e);
}

/**
 * ...and takes it back.
 *
 * Geometry and materials are shared and module-level (see `buildCan`), so
 * dropping the mesh is the whole of it — there is nothing to dispose.
 *
 * Removed from whatever it was PARENTED to rather than from the group, because a
 * one-handed thing never was on the group: a can that outlived its arm's
 * reference would be a drink floating beside a corpse.
 */
export function take(e, what) {
  const spec = HELD[what];
  if (!spec || !e[spec.field]) return;
  const from = spec.hand ? (e[`${spec.field}Arm`] ?? e.group) : spec.parent(e);
  from?.remove(e[spec.field]);
  e[spec.field] = null;
  if (spec.hand) e[`${spec.field}Arm`] = null;
  spec.taken?.(e);
}

/** Whatever this body is holding, for the snapshot's sixth slot. */
export function packHeld(e) {
  let bits = 0;
  for (const spec of Object.values(HELD)) if (e[spec.field]) bits += spec.snap;
  return bits;
}

/**
 * ...and the other end: hand over or take back whatever the packed bits disagree
 * with.
 *
 * `key` is the body's own index rather than the machine the thing came out of,
 * and that is the one place a DERIVED value beats a sent one: which hand a can
 * is in and what flavour it is are hashed, the joiner has no idea which machine
 * it came from, and it does not need to agree with the host on either. What it
 * must not do is hold the drink in a hand that is not there — so the hash is the
 * index, which both ends have.
 */
export function applyHeld(e, bits, key) {
  for (const [what, spec] of Object.entries(HELD)) {
    const wanted = !!(bits & spec.snap);
    if (wanted === !!e[spec.field]) continue;
    if (wanted) give(e, what, key); else take(e, what);
  }
}
