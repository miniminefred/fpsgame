// How big a body is and what it can do.
//
// These are the numbers more than one module has to agree on, and every one of
// them was previously private to whichever file happened to declare it first —
// so the modules that needed it held a literal copy instead. That is the
// FIRST_CONTACT_GAP failure with the serial numbers filed off, and it had
// already produced two live instances:
//
//   * cameras.js hard-coded 1.7 twice to reconstruct the player's head from
//     their feet, while EYE lived unexported in player.js. Retune the player's
//     height and every laser tripwire in the building silently mis-tests, with
//     nothing to catch it.
//   * tools/validate-props.mjs declared `BODY_R = 0.4  // must match RADIUS in
//     src/player.js`, which is a comment asking a human to be a compiler. The
//     validator existed to catch drift and was itself a copy that could drift.
//
// Deliberately free of Three.js and of every other import, because both headless
// validators in tools/ pull this in and run in plain Node.

export const PLAYER_RADIUS = 0.4;   // horizontal collision radius
export const BODY_RADIUS = 0.36;    // ...and everyone who is not the player
export const EYE = 1.7;             // eye height above the feet
export const STEP_EPS = 0.25;       // within this of the feet is a step up, not a wall
// How tall a body actually is, eyes plus the rest of a head. It exists because a
// collider now has an underside (`base`), so "does this box stand in my way" has
// finally become a question about a body's HEIGHT rather than only its feet — the
// floor slab of the storey above must stop the man walking on it and not the one
// walking underneath. See _moveHorizontal in player.js.
export const BODY_H = EYE + 0.12;

export const GRAVITY = 26;
export const JUMP_SPEED = 8.4;

/**
 * How high a standing jump actually gets, in metres.
 *
 * Derived rather than written down, because it is the number the laser
 * tripwires are designed against: BEAM_Y in cameras.js is set below this on
 * purpose, so vaulting a beam is a real option a player can find rather than a
 * happy accident of two constants in two files. Deriving it means retuning the
 * jump moves the thing that depends on it instead of quietly invalidating it.
 */
export const JUMP_APEX = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
