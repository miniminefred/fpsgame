// The numbers the roster is tuned by that more than one of its files needs.
//
// A LEAF: it imports nothing, so nothing can cycle through it. That is the whole
// reason it exists rather than each number living beside its own code —
// stations.js needs the pace somebody walks to lunch at and breaks.js needs the
// band a seat can be found in, and with each owning its own the two would import
// each other. A cycle whose names are read while the modules are still evaluating
// is not a warning, it is a crash.
//
// It is the argument metrics.js already makes one scale down: a number two files
// have to agree on lives in one of them, and that one has no opinions.

// How far back from a machine a body may be moved to find somewhere it fits, and
// in what steps. See `standable`: about one tile, because the failure this
// recovers from is landing on the wrong side of a tile boundary rather than
// standing too close.
export const STAND_NUDGE = 0.5;

export const NUDGE_STEP = 0.125;

export const LUNCH_FIRST = 25;        // seconds before the first employee downs tools

export const LUNCH_GAP = [14, 34];    // ...and between one and the next

// How far out in front of a sofa the game will look for somewhere to step off
// it. A little over two tiles, which is what the erosion in `fits` costs beside
// anything fitted: the sofa's own tile is blocked and its neighbours are eroded,
// so the first tile a body fits in is the second one out. See `sittable`.
export const LOUNGE_STEP = 1.3;

// The height band a thing you can sit on tops out in: a stool at 0.45, a sofa at
// 0.82, an armchair at 0.86. Wide enough to take all three and short enough that
// a filing cabinet standing behind the sofa is not mistaken for it.
export const SEAT_LOW = 0.3;

export const SEAT_HIGH = 1.0;

export const LUNCH_PACE = 0.85;       // somebody walking to lunch has not noticed you

export const LUNCH_ARRIVE = 1.1;      // metres: near enough to a counter or a rack

// A seated pose is drawn relative to furniture, and furniture on this floor can
// be shot apart and shoved about. See _seatGone.
//
// SEAT_DRIFT is how far the chair may wander before the body is no longer on it.
// Generous: a loose prop settles against its neighbours for a second after the
// floor is built and jitters when anything lands near it, and a canteen that
// stands itself up because a chair twitched is a worse bug than the one this
// fixes. A body is 0.4 m across, so half a metre is already past the seat.
export const SEAT_DRIFT = 0.5;
