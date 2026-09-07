// The roster: who works this building, and who is working it tonight.
//
// Pure data plus the two weighted draws that read it. It is its own file because
// nothing in here knows the game is running — no scene, no nav, no instance
// state — so it can be read, edited and reasoned about without any of the
// machinery in enemies.js being in the way. enemies.js is behaviour; this is the
// catalogue that behaviour is applied to.

// The security uniform, shared by the two halves of the shift — the one with a
// sidearm and the one with a baton. It is one set of clothes on one kind of
// person, so it is written down once and both types wear it; `guard` is what
// the rest of the file tests instead of naming either of them, and it is what
// the blue card is dealt on.
export const GUARD = {
  suit: 0x14161a, shirt: 0x2e63b4, pants: 0x14161a, cap: 0x14161a,
  capText: 'SECURITY', visor: 0x7d7973, guard: true,
  // What a guard does when nothing is happening. `works` is the list of jobs a
  // type may be given (chores.js); absent, a body does the general work of the
  // building — a copier, a rack, a bench. There is no such thing as a human job
  // and a robot job here, but there is such a thing as a guard's job, and it is
  // not standing at the photocopier: he walks the corridors and holds a post.
  works: ['patrol'],
};

// Staff. Every type is the same rig with different numbers and a different
// suit, which keeps them readable at a glance in a grey corridor: the colour of
// the visor tells you what is about to happen to you.
//
// The visor palette answers two questions in that order. First "do I shoot
// this": anything hostile wears grey — or green, if it is no longer breathing —
// and anything that leaves you alone wears an actual colour. Then "what is it":
// the greys run a single ramp from near-white to near-black, brightest for the
// ones that die to a look and darkest for the ones that do not, so the shade
// reads as the threat even when the hue does not.
//
// The machines are on that same ramp rather than beside it, and that is a rule
// being kept rather than a palette being copied: neither question changes
// because the thing at the end of the corridor has wheels. A Survey Drone is
// the brightest visor in the building and a Legacy Unit is the darkest thing on
// it, for exactly the reasons an Intern and a Manager are.
//
// `voice` names the set of vocals a type uses (see audio.js). Left off, a type
// gobbles like the rest of the office; the green ones brought their own.
//
// Multipliers are applied to the floor's base tuning (see tuningFor in
// game.js), so types scale with depth instead of going obsolete.
/**
 * The suits a contractor turns up in.
 *
 * Rolled per visit off the floor's own rng, which is what makes it safe in co-op
 * without a byte on the wire: both browsers generate the same roster from the
 * same seed in the same order, so both roll the same suit for the same man.
 *
 * All six are loud, none is a colour this building's staff wear, and none is
 * near the Reanimated's green — a bright green suit walking down a corridor is
 * the one reading that would cost something.
 */
export const CONTRACTOR_SUITS = [
  0xc4142c,   // crimson
  0xe07b1e,   // orange
  0x1f8f4e,   // emerald
  0x7b3fb5,   // purple
  0xd94f9c,   // pink
  0x1d7fc4,   // electric blue
];

export const TYPES = {
  intern: {
    // Cheap, quick, and always in a group. Dies to a look but closes fast.
    name: 'Intern', hp: 0.4, speed: 1.55, damage: 0.5, rate: 0.55, spread: 1,
    range: 1.9, melee: true, scale: 0.9, blunt: ['keyboard', 'stapler', 'mug'],
    suit: 0x5d6675, shirt: 0xeceee9, visor: 0xc8ced4, unlockFloor: 1, weight: 3,
  },
  facilities: {
    // Swings a fire extinguisher. Slower than an intern, hits far harder.
    name: 'Facilities', hp: 1.5, speed: 1.15, damage: 1.6, rate: 1.2, spread: 1,
    range: 2.2, melee: true, scale: 1.05, blunt: ['extinguisher', 'chairLeg'],
    suit: 0x2d3a2e, shirt: 0xf0a63c, visor: 0x63686e, unlockFloor: 2, weight: 2,
  },
  analyst: {
    // The baseline in every column, this one included: `aimMul` is 1 by default,
    // and an analyst is what the floor's aim curve was written against.
    name: 'Analyst', hp: 1, speed: 1, damage: 1, rate: 1, spread: 1,
    range: 15, melee: false, scale: 1,
    suit: 0x41464e, shirt: 0xd9dde1, visor: 0x8b9198, unlockFloor: 1, weight: 4,
  },
  sysadmin: {
    // Fast, inaccurate chip damage — the one that punishes standing still.
    name: 'Sysadmin', hp: 0.8, speed: 1.12, damage: 0.45, rate: 0.4, spread: 1.7,
    range: 13, melee: false, scale: 0.97,
    // Slowest onto a target on the roster, which is the same character the spread
    // already describes: whoever this is spends the fight hosing a doorway.
    aimMul: 1.25,
    suit: 0x2f4448, shirt: 0xbfe3d8, visor: 0xa2b4bf, unlockFloor: 3, weight: 3,
  },
  security: {
    // Close-range bruiser: hits hard, misses at distance, keeps coming.
    //
    // The second uniform in the building, and the only source of the blue card
    // — see _security. Black trousers, a blue shirt and a black cap with the
    // job written across the front of it, which is three readings of the same
    // fact at three ranges: the dark silhouette from the end of a corridor, the
    // blue in the middle distance, the word once he is close enough for it to
    // be too late. Nothing else on the floor is dressed in blue.
    ...GUARD,
    name: 'Security', hp: 1.7, speed: 0.98, damage: 1.5, rate: 1.15, spread: 2.1,
    range: 9, melee: false, scale: 1.07, unlockFloor: 4, weight: 3,
    // Paid to be looking. Not the fastest on target — that is the machine — but
    // quicker than anybody who had to put a spreadsheet down first.
    aimMul: 0.9,
  },
  guardBaton: {
    // The same guard with the sidearm still holstered. Shares the name, because
    // it is not a second kind of person — it is the half of the shift that drew
    // the baton instead, and the roster has no business listing them apart.
    //
    // Hand-placed only (`weight: 0`): the mix belongs in the halls and in the
    // security office, where _security puts it, and a room rolled full of
    // Security is a room of people who were at their desks with a gun on.
    ...GUARD,
    name: 'Security', hp: 1.7, speed: 1.12, damage: 1.55, rate: 1.1, spread: 1,
    range: 2.3, melee: true, blunt: ['baton'], scale: 1.07,
    unlockFloor: 1, weight: 0,
  },
  manager: {
    // Slow, tanky, accurate at range. Deal with it or leave the floor.
    name: 'Manager', hp: 2.7, speed: 0.82, damage: 1.9, rate: 1.6, spread: 0.55,
    range: 21, melee: false, scale: 1.14,
    // The tightest cone on the floor gets the second-quickest draw to go with it:
    // being unhurried is what he is, and it is not the same as being slow.
    aimMul: 0.85,
    suit: 0x1c2126, shirt: 0xd8c08a, visor: 0x4f5460, unlockFloor: 6, weight: 2,
  },
  reanimated: {
    // Green, and no longer on the payroll. Slow and soaks damage, but it only
    // wants to be close to you, and it does not stop coming. The one type that
    // punishes backing into a corner rather than standing in the open.
    name: 'Reanimated', hp: 2.4, speed: 0.86, damage: 1.3, rate: 1.35, spread: 1,
    range: 2.1, melee: true, scale: 1.03, blunt: ['chairLeg', 'extinguisher'],
    // Which is also the whole of why it does not stop for lunch (see _lunchOk in
    // enemies.js). A machine has nowhere to put it; this one has no interest in
    // it. Between them that is every hostile in the building that is not staff.
    undead: true,
    suit: 0x33502c, shirt: 0x8fb063, visor: 0x66ff4d, voice: 'zombie',
    unlockFloor: 1, weight: 3,
  },
  janitor: {
    // The only person on the floor in a uniform, and the only one carrying a
    // yellow card. Everything about him is built to be recognised before he is
    // in range: blue trousers and a blue cap against a yellow shirt is the one
    // colour scheme in the building that is not grey, and the mop gives him
    // nearly a metre of reach — the longest swing on the floor by some way, so
    // the tell has to arrive early enough to back out of.
    //
    // Placed by hand rather than rolled (`weight: 0`), because how many there
    // are and where they are is the whole point of him: one to three doing
    // rounds, and two more sitting in the broom closet. See _janitors.
    name: 'Janitor', hp: 1.6, speed: 1.08, damage: 1.35, rate: 1.3, spread: 1,
    range: 2.6, melee: true, scale: 1.03, blunt: ['mop'],
    // He washes the floor, and that is the whole of the job. See `works` on
    // GUARD above — and note the mop is what he is already carrying, so the one
    // job on the floor that is not at a machine is also the only one whose tool
    // the worker brings with him.
    works: ['mop'],
    suit: 0x2f4d8a, shirt: 0xf2c93c, pants: 0x2f4d8a, cap: 0x2f4d8a,
    visor: 0xb9bec4, unlockFloor: 1, weight: 0,
  },
  technician: {
    // The generator room's own (see the `generator` role in gen/rooms.js and
    // `_generatorRoom` in enemies.js): a handful of the room's workers who are
    // not going to let you near their machine. Hand-placed only (`weight: 0`)
    // like every other room-specific hostile — the mix of these against the
    // room's docile `worker`s is the whole point of the room, not something a
    // weighted roll should ever produce elsewhere.
    name: 'Technician', hp: 1.4, speed: 1.05, damage: 1.5, rate: 1.2, spread: 1,
    range: 2.3, melee: true, scale: 1.02, blunt: ['chairLeg', 'extinguisher'],
    suit: 0x494338, shirt: 0xd97a2e, visor: 0x8f959b, unlockFloor: 1, weight: 0,
  },

  welder: {
    // On the racks, and getting on with it. The quickest chassis on the floor —
    // it kept the pace it had when it was the thing that ran at you, which is
    // most of what makes it worth having here: something moving that fast is
    // read as a threat before it is read as anything, so it is the one neutral
    // whose visor has the most work to do.
    //
    // The torch went with the fight. A harmless thing holding a cutting torch
    // has already answered the question its visor is there to answer, and that
    // is the same argument that took the sidearms off the rest of the neutrals
    // — see gun.visible in rigs.js, which asks about `neutral` for this reason.
    name: 'Welder Unit', hp: 1.3, speed: 1.35, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 0.98, neutral: true,
    chassis: 'welder', voice: 'robot', screams: 'robot-alert',
    // Teal, which nothing else in the building wears — and it is the colour the
    // machine is already painted, so this is the one neutral whose visor and its
    // own shell agree. Clear of the Reanimated's lime and of the floor unit's
    // cyan at the range you first see one down a corridor.
    suit: 0x2f6f5e, shirt: 0x9aa0a6, visor: 0x35d6a8, unlockFloor: 1, weight: 0,
  },
  drone: {
    // Survey. Fast, fragile and inaccurate — the machine floor's answer to the
    // Sysadmin, and the same job: it punishes standing still and dies to a
    // look. The only thing in the building that is not on the floor, which is
    // what makes it worth having on a roster of things that are.
    name: 'Survey Drone', hp: 0.35, speed: 1.6, damage: 0.4, rate: 0.5, spread: 1.9,
    range: 12, melee: false, scale: 0.95, chassis: 'drone', voice: 'robot',
    aimMul: 1.1,
    suit: 0x4d5a66, shirt: 0xc0c7cd, visor: 0xdde2e6, unlockFloor: 1, weight: 0,
  },
  legacy: {
    // The one before all of them, and still walking about.
    //
    // This IS the original Sentry Unit — the same numbers, the same grey shell
    // over a pale under-layer, the same near-black visor — kept because it is a
    // silhouette this building already had and the machine floor is the one
    // place it belongs. What it does NOT have is a chassis, and that is the
    // whole of its character: it is built on the human rig, so it is the only
    // machine on the floor shaped like the people it replaced. An older idea of
    // what a robot should look like, still on the payroll because nobody has
    // signed off decommissioning it.
    //
    // Which makes it the useful thing on a roster of tracks and wheels and
    // fans: at the far end of a corridor it reads as staff, and it is not.
    name: 'Legacy Unit', hp: 3.2, speed: 0.78, damage: 1.45, rate: 1.35, spread: 0.7,
    range: 17, melee: false, scale: 1.18,
    // Quickest onto a target in the building alongside the Sentry it was the
    // first draft of: it was bought to watch a corridor, and it is not carrying
    // anything it has to put down.
    aimMul: 0.65,
    // A hair off the Sentry's near-black rather than the same value, because no
    // two types share a visor and these two are the same numbers under
    // different bodies. It sits between the Sentry and the Loader, which is
    // where its 3.2 hp puts it on the ramp — and at this end of the ramp the
    // shade is only settling an order, since everything down here already means
    // "not the one you walk out in front of". What tells it from the Sentry at
    // range is the silhouette, and that is the whole point of it.
    suit: 0x474d55, shirt: 0x9aa3ab, visor: 0x3f4550, voice: 'robot',
    // The one machine that has to SAY it is one, because it is the one that does
    // not look like one. Everywhere the game asks "is this a machine" it has
    // been able to read the answer off `chassis` — and this is built on the
    // human rig, so `chassis` says no about a thing that is plainly a robot.
    // See isMachine.
    machine: true,
    unlockFloor: 1, weight: 0,
  },
  panicker: {
    // Has one problem, and it is not you: he is looking for a toilet and
    // announcing it. Fast, and dies to a look.
    name: 'Panicking Staffer', hp: 0.3, speed: 1.9, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 0.95, panic: true, neutral: true,
    screams: 'panic',
    suit: 0xa8b2c0, shirt: 0xf6f8fa, visor: 0xffffff, unlockFloor: 1, weight: 0,
  },
  cleaner: {
    // Working a different job to everyone else on the floor and in no hurry
    // about it. Wanders the rooms, mutters, ignores the firefight entirely.
    name: 'Night Cleaner', hp: 0.8, speed: 1.05, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1.02, neutral: true,
    // A mop, and the job that goes with it. He is the second body on the floor
    // to wash it and the only one who is not also a hostile — `melee: false`
    // with a `blunt` is the whole point of the pair being two fields rather than
    // one (see the note in rigs.js): he carries it, he never swings it.
    blunt: ['mop'], works: ['mop'],
    // The brown runs dark on purpose: a mid brown lands within a shade of the
    // skin tone and the visor stops reading as a visor at all.
    suit: 0x4a3a2c, shirt: 0xb98a55, visor: 0x8a4b18, unlockFloor: 1, weight: 0,
  },
  courier: {
    // Has a delivery for someone on this floor and is going to make it. Brisk,
    // corridor-bound, and entirely uninterested in what you are doing.
    name: 'Courier', hp: 0.6, speed: 1.45, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 0.99, neutral: true,
    suit: 0x6b5a1e, shirt: 0xf2c14e, visor: 0xffc93a, unlockFloor: 1, weight: 0,
  },
  diner: {
    // On their break in the canteen the floor arrives in — the only people in
    // the building you meet before you have taken a step, and the reason that
    // room reads as somewhere people work rather than a set. Sitting down, which
    // is the whole of what makes them safe to walk past: a chair means harmless
    // in this building, and these are the first bodies that rule was ever
    // written for. See _diners in enemies.js.
    //
    // A visor of their own, like every other neutral. Hue says threat here and
    // shade says which one, so a harmless type needs a colour no hostile wears:
    // the grey ramp is every hostile human, green is the Reanimated, and blue is
    // nowhere near the courier's yellow or the cleaner's brown at the range you
    // first see one from — which for these is across a room, seated, before you
    // have decided anything.
    name: 'Staff on Break', hp: 0.5, speed: 1.05, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1.0, neutral: true, dines: true,
    suit: 0x3f4a59, shirt: 0xc6d0dc, visor: 0x5aa9ff, unlockFloor: 1, weight: 0,
  },
  receptionist: {
    // Behind the counter in the lift lobby, and the first person on the floor
    // either way — this is the one body you meet before you have gone through a
    // door. Harmless: greets you, watches you cross the lobby, and goes back to
    // whatever was on the screen. Hand-placed only, and there is exactly one of
    // them; see _receptionist in enemies.js.
    //
    // Violet, which was the last hue on the neutral side of the palette with
    // nothing wearing it. Hue says threat and shade says which one, so the whole
    // point of this type is that it is a COLOUR: from the far end of the lobby a
    // violet visor is the promise that this one is not going to shoot, and the
    // grey one three doors down is `angryReceptionist` below.
    //
    // `posted` is the whole of "and does not have any other work": this one has
    // a place to be, and it is the place you meet them. Everybody else on the
    // floor is dealt whatever the building needs doing (see chores.js), which
    // for a receptionist would mean walking off to the photocopier and leaving
    // the lobby empty — so the one body the floor guarantees you will meet would
    // be the one body you might not.
    name: 'Receptionist', hp: 0.5, speed: 1.05, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1.0, neutral: true, posted: true,
    suit: 0x3b4250, shirt: 0xd8dde3, visor: 0xa66bff, unlockFloor: 1, weight: 0,
  },
  angryReceptionist: {
    // ...and the three in ten who are not pleased to see you. The SAME body in
    // the same clothes at the same counter — the only thing that has changed is
    // the visor, and it has changed to a grey off the hostile ramp, which is the
    // one thing in this building that has never lied.
    //
    // That is the whole design of the pair. Every other tell in the game answers
    // "what is this" and this one answers "is it going to be a problem", from
    // across a room, before you are committed — and the answer is a coin the
    // floor tossed rather than a fact about receptionists. It reads as a room
    // you have to look at rather than one you walk through.
    //
    // A warm light grey: bright, because this dies to a look, and warm so it is
    // not mistaken for the Intern's `0xc8ced4` or Security's `0x7d7973` at the
    // range you actually read one from.
    //
    // Every number is a MULTIPLIER on the floor's own tuning (see tuningFor in
    // game.js), and these are the numbers of somebody who keeps a pistol in a
    // drawer and has never used it: dies to a look, shoots slowly, shoots badly,
    // and is slow onto a target because they were looking at a screen. What
    // makes them worth anything at all is where they are standing — behind a
    // counter, in the room you arrive in, before you have taken a step.
    // Posted, like the harmless one and for the same reason — the coin is which
    // of the two is behind the counter, not whether anybody is.
    name: 'Receptionist', hp: 0.5, speed: 1.15, damage: 0.6, rate: 1.35, spread: 1.8,
    range: 11, melee: false, scale: 1.0, aimMul: 1.2, posted: true,
    suit: 0x3b4250, shirt: 0xd8dde3, visor: 0xafa79c, unlockFloor: 1, weight: 0,
  },
  contractor: {
    // NOT STAFF. He comes up in the other lift, walks to a storage rack, takes a
    // crate off it and goes back down with it — see `_visitor` in enemies.js for
    // where he starts and `collection` in chores.js for the errand, which is two
    // legs of the routine table and nothing new at all.
    //
    // THE SUIT IS THE POINT. Everybody in this building is in grey, navy, or a
    // uniform; he is in a colour nobody would wear to an office, and it is a
    // different one every time (see `CONTRACTOR_SUITS`). That is the whole of how
    // he reads as somebody visiting rather than somebody who works here, and it
    // has to carry from across a lobby, because what he is doing — walking, with
    // a box — is exactly what a Maintenance Worker on a parcel run is doing.
    //
    // The visor is a different question and answers the usual one: hue says
    // threat, so a harmless type needs a colour no hostile wears and no other
    // neutral has. The palette is nearly full — brown 26°, orange 30°, yellow
    // 45°, green 112°, teal 162°, cyan 196°, blue 212°, violet 265°, magenta
    // 318°, rose 354° — and the widest gap left in it is the 67° between the
    // Courier's yellow and the Reanimated's green. This sits in the middle of
    // it. Worth knowing that it is 34° off that green rather than a clear field:
    // the two are told apart by being nothing else alike, a man in a red suit
    // against a green corpse in a torn one, rather than by the visor alone.
    name: 'Contractor', hp: 0.6, speed: 1.22, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1.02, neutral: true,
    // His errand and nothing else, the way a janitor only ever mops. Both kinds
    // are `trade` in chores.js, so they are off the general list too — the two
    // halves of "only he does this, and he does only this".
    works: ['takeCrate', 'leaveFloor'],
    // ...and he brought a sack truck, which is what he wheels the crate out on.
    // `truck` is the declaration and nothing else reads it — the same split
    // `blunt` and `melee` are two fields for: what somebody CARRIES and what
    // they do with it are two facts, and there is nothing he does with this one
    // but push it. See `truckOf` in rigs.js.
    truck: true,
    suit: 0xc4142c, shirt: 0xf1f3f5, visor: 0xbdf03c, unlockFloor: 1, weight: 0,
  },
  worker: {
    // The generator room's docile majority — logged in on the terminals
    // around it, or just standing near the thing, and no more interested in
    // you than the cleaner is. Hi-vis orange, which nothing else in the
    // building wears. Hand-placed only, alongside `technician` — see
    // `_generatorRoom` in enemies.js.
    name: 'Maintenance Worker', hp: 0.5, speed: 1.0, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1.0, neutral: true,
    suit: 0x4a4642, shirt: 0xff8c3d, visor: 0xffa64d, unlockFloor: 1, weight: 0,
  },
  rat: {
    // Not staff. Lives under the desks, crosses corridors at the worst moment,
    // and dies to anything that touches it — the joke is entirely on you for
    // spending a round of ammunition and a shout of your own on one.
    //
    // Darts rather than walks: bursts of speed with pauses in between, which is
    // what makes the movement read as vermin instead of as a small courier.
    name: 'Office Rat', hp: 0.05, speed: 2.4, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1, neutral: true, rig: 'rat', darts: true,
    offMap: true,
    voice: 'rat', screams: 'rat-idle',
    suit: 0x4c443d, shirt: 0xb2848a, visor: 0xd8626e, unlockFloor: 1, weight: 0,
  },
  roomba: {
    // The floor cleaner. Has a job, is doing it, and is the only thing on this
    // floor with no opinion whatsoever about you — it will drive around your
    // ankles in the middle of a firefight. One per floor, because two is a
    // running joke and three is a fleet.
    name: 'Floor Unit', hp: 0.4, speed: 0.42, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1, neutral: true, rig: 'roomba',
    offMap: true, motor: 'roomba', screams: 'rat-idle',
    suit: 0x2b2f36, shirt: 0x9aa3ab, visor: 0x63d6ff, unlockFloor: 1, weight: 0,
  },
  sentry: {
    // Facilities' idea of a cost saving, and it turned out to be one: it watches
    // the corridor it was bought to watch and it has no opinion about you. Still
    // armoured, still slow, still on tracks — and still the only thing in the
    // building that arrives at the height it left at.
    //
    // It used to be the one machine on the roster that was ROLLED rather than
    // placed by a theme — bought in to watch a corridor in a building full of
    // people, so it turned up in one — and it is not any more. `weight: 0` puts
    // it with the other five: a machine is something you meet on the floor that
    // has machines on it, and nowhere else.
    //
    // What that cost is worth writing down, because it was argued the other way
    // here for a long time. It was the only neutral in the game with a weight,
    // so a slice of every floor's dealt staff was something you did not have to
    // shoot — 1 to 17% of it, which means `hostileCount` on an ordinary floor
    // has just gone UP by that slice and every non-machine floor is a little
    // longer to clear. It also took Night shift's `sentry: 4` boost with it: a
    // boost multiplies a weight and cannot resurrect a zero, so that entry is
    // gone rather than left to read as if it did something.
    //
    // `unlockFloor` stays at 2 even so, because `themeUsable` reads it off every
    // share and it is what holds Automated back a floor — see there.
    name: 'Sentry Unit', hp: 3.2, speed: 0.78, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1.18, chassis: 'sentry', neutral: true,
    voice: 'robot', screams: 'robot-alert',
    // Magenta, and it is the last hue this roster had left: white, brown,
    // yellow, blue, hi-vis orange, violet, the rat's rose and the floor unit's
    // cyan are all spoken for, the grey ramp is every hostile human and green is
    // the Reanimated. It reads as a startling colour for three hundred kilograms
    // of armour, and that IS the job — the darkest visor in the building used to
    // mean the thing you cannot walk out in front of, so leaving it near-black
    // on something harmless is the exact lie the palette exists to prevent.
    suit: 0x474d55, shirt: 0x9aa3ab, visor: 0xff5cc4,
    unlockFloor: 2, weight: 0,
  },
};

/**
 * Whether this is a machine, which is NOT the same question as whether it has a
 * chassis.
 *
 * Five of the six are drawn by `buildRobot` and answer for themselves; the
 * Legacy Unit is built on the human rig and has to say so (`machine`). The
 * distinction matters wherever the answer is about the THING rather than about
 * how it is drawn — a machine does not stop for lunch, whatever shape it is.
 */
export const isMachine = (type) => !!type.chassis || !!type.machine;

// The neutrals that are not the toilet guy. He is guaranteed on every floor;
// these fill in around him so the harmless staff are not one repeated joke.
//
// The courier ALONE, because the Night Cleaner is the night shift's and nobody
// else's. That is a lever on the building rather than a change to the roster: a
// man mopping a corridor is the one piece of the background traffic that says
// what TIME it is, and something that says so on every floor of every run says
// nothing. He is named in Night shift's own `bystanders`, which is also what
// guarantees him there — the one-of-each-first pass below takes the named kinds
// in order — and being off this list is what makes him impossible anywhere else.
export const BYSTANDERS = [TYPES.courier];

// Who is working this floor tonight. Weights are relative, so a theme does not
// replace the roster — it tilts it, and floors keep their own character without
// any of them becoming one enemy repeated. Picked per floor, and named on the
// way in so you know what you have walked into before it reaches you.
// `light` is how much of the building's lighting is still on, and it is the
// theme's second job: the name tells you what is working this floor, and the
// dark tells you before you have finished reading it. Infestation is the
// darkest — whatever came up the stairwell went through the switchboard first.
// `rats` is how many are in the walls tonight — one is an office with a rat in
// it, which is a joke you notice once; six is an infestation, which is the name
// on the door. `patrols` is how many security are walking the corridors rather
// than sat in their office, and it is zero on the floors where nobody is still
// doing their rounds — though a floor with a security office on it always keeps
// one, because that man is carrying the only key to it (see _security).
// `share` is the one number here that is NOT a weight: it is the fraction of the
// rolled staff that IS this type, and it holds at every depth. A theme reaches
// for it when being mostly one thing is the whole of what the theme is —
// Infestation is four Reanimated in five, and a weight cannot say that, because
// a weight is a ratio against a pool that keeps growing as you descend (see
// pickType). What is left over is still rolled on `boost`, so the fifth of the
// floor that is still breathing keeps a character of its own.
// `tint` is what colour the floor is lit in, `cleaners` how many floor units are
// working it, and `conveyors` how many parcel lines are running on its walls —
// the three levers a theme has on the BUILDING rather than on who is standing in
// it. A tint reaches the tubes, the pools they cast, the fill and the haze at
// once (see setTint in lighting.js), which is what makes it read as a floor lit
// in that colour rather than as coloured bulbs in a beige office.
// `washersFly` is the fourth lever on the building, and it is the narrowest: a
// washing machine hammers its way around a corridor on every floor there has
// ever been (see washers.js), and on THIS one it gets off the ground altogether
// — up into the ceiling tiles, spinning, which is a thing a machine floor can
// have and an ordinary office cannot. Everywhere else the same prop stays down
// and merely thrashes. It is one flag rather than two props for the reason
// `tint` is one number: the difference is what the floor does to the thing, not
// what the thing is.
//
// `panels` is the fifth, and the narrowest after `washersFly`: how many
// service openings are cut into this floor's corridor walls — an access hatch
// swung open with the wiring pulled out of it, and somebody stood in front of it
// with both arms in the wall (see panels.js and the `panel` job in chores.js).
// A floor being worked by machines is a floor with its covers off, and an
// ordinary office is not.
//
// `chargers` is the sixth, and it is the only one that reaches the FURNITURE
// rather than being fitted into the finished floor afterwards: a dock on the
// break room wall for the machines to stand at (see `charger` in gen/props.js
// and the `charge` job in chores.js). It is Automated's alone for the same
// reason the parcel lines are — there are no machines on any other shift to use
// it, and a charging point in an office nobody plugs anything into is a prop
// that raises a question the floor does not answer.
//
// `bystanders` is the last one and it is about the corridors: the harmless
// traffic is a courier unless a theme names its own. Two do — the Night Cleaner
// is Night shift's alone, because a man mopping a corridor should say what time
// it is, and on a floor run by machines the deliveries are done by a Porter — alongside the
// maintenance staff, who are the tenth of the floor this theme's own comment
// promises and who until now were only ever found in a generator room, on the
// 3% of floors that have one. They are also the far end of a parcel run: a box
// comes off a rack, another of these carries it up the corridor, and one takes
// jobs.js. The toilet guy is
// never on that list — he is a flat one or two on every floor there has ever
// been, and the last human on a floor of robots running for a lavatory is the
// joke landing harder rather than a joke out of place.
export const THEMES = [
  { name: 'Business as usual', weight: 4, light: 1, rats: [1, 1], patrols: [1, 3], boost: {} },
  { name: 'Infestation', weight: 3, light: 0.34, rats: [4, 6], patrols: [0, 0], share: { reanimated: 0.8 }, boost: { intern: 2 } },
  // Nine in ten of what is working this floor is a machine, and the tenth is
  // whoever is left to maintain them. Five chassis rather than one — a floor
  // that is 90% one robot is the floor of one enemy repeated that `share` was
  // written to prevent, and it would be that twice over here, since the whole
  // point of this shift is that the building is being WORKED. So the share is
  // split across the jobs: a hundred clerks at the desks, sentries in the
  // corridors, welders on the racks, a few drones over all of it — and the
  // Legacy Units, which have no job at all beyond being the generation before
  // the rest and the only machine here shaped like a person.
  //
  // Two of those jobs are no longer a fight, and the split is tuned so that the
  // floor still comes out THREE QUARTERS hostile. The arithmetic is worth
  // writing down because it is the only thing holding that number: the shares
  // are a fraction of the rolled staff, machines take 0.90 of it and the tenth
  // that is still breathing is `boost`ed humans who all fight. So hostile =
  // (the fighting machines) + 0.10, and they have to sum to 0.65 — clerk 0.37,
  // legacy 0.19, drone 0.09 — leaving 0.25 for the sentry and the welder.
  // Retune any one of the five and that identity is what to re-check; nothing
  // asserts it. The Loader Unit's 0.14 went back into those three in proportion
  // when it came off the roster, which is what kept the identity true.
  //
  // It came out at six tenths when the sentry and the welder first went neutral,
  // which is a thinner floor than this theme should be: an Automated floor
  // clears on fewer kills than its headcount suggests either way, and the
  // difference between a quarter of it being harmless and two fifths is the
  // difference between traffic and an empty building. The harmless quarter is
  // still the fastest thing on the floor and the most heavily armoured thing on
  // the floor, which is most of what stops "harmless" reading as "scenery".
  { name: 'Automated', weight: 3, light: 0.72, tint: 0x7fb4ff,
    rats: [0, 0], patrols: [0, 1], cleaners: [3, 5], bystanders: ['worker'],
    conveyors: [5, 9], washersFly: true, panels: [3, 6], chargers: true,
    share: { clerk: 0.37, sentry: 0.15, legacy: 0.19, welder: 0.10, drone: 0.09 },
    boost: { sysadmin: 6, facilities: 3, reanimated: 0 } },
  { name: 'Lockdown', weight: 2, light: 0.75, rats: [1, 1], patrols: [3, 4], boost: { security: 6, manager: 4 } },
  // The one shift the Night Cleaner works — see BYSTANDERS. He is first in the
  // list, so the one-of-each-first pass guarantees at least one of him even on
  // the smallest slab, and the courier still walks these halls beside him:
  // deliveries do not stop because the lights are down.
  { name: 'Night shift', weight: 2, light: 0.5, rats: [2, 3], patrols: [1, 2],
    bystanders: ['cleaner', 'courier'],
    boost: { reanimated: 4, facilities: 3 } },
  { name: 'All-hands', weight: 2, light: 1, rats: [1, 1], patrols: [2, 4], boost: { analyst: 6, intern: 5, manager: 3 } },
];

// Weighted pick from the types unlocked at this depth. Early floors are all
// analysts and interns; the nastier staff join as you descend, and because
// weights are relative the mix keeps shifting rather than simply adding.
//
// ...which is exactly why a theme that wants to be MOSTLY one thing cannot say
// so with a weight, and this is the trap `share` exists for. A weight is a
// ratio against whatever else is unlocked, and what else is unlocked grows with
// every floor: Infestation's old `reanimated: 7` was 54% of the roster on floor
// 1 and 27% by floor 6 — the same number describing a floor overrun with them
// and a floor with a few about, with the drift going the wrong way as the name
// on the door stayed the same. A share is a fact about the mix rather than
// about the pool, so it holds at every depth.
//
// The shared types are drawn out of the weighted pool entirely and given their
// band of the roll; whatever is left over is rolled among the rest exactly as
// before, still tilted by the theme's `boost`. So Infestation's remaining fifth
// is still its own mix of the living rather than a flat sample of the building.
//
// Deliberately ONE rng() call, as this has always been: the roll's low band
// picks a shared type and the rest is rescaled back over the weighted pool.
// Every floor's contents come off this stream, so a second call here would
// shift every number after it — the same argument floorSpans and assignLocks
// make for rolling on a stream of their own.
export function pickType(floorNumber, rng, theme) {
  // `weight: 0` types are placed by hand rather than rolled — see spawn.
  const unlocked = Object.entries(TYPES)
    .filter(([, t]) => t.unlockFloor <= floorNumber && t.weight > 0);

  // A share only counts if that type is unlocked at this depth. A theme naming
  // one that is not yet in the building is the `pickTheme` case one level down:
  // it must come out as an ordinary floor rather than as a floor that is 80%
  // nothing.
  const shares = Object.entries(theme?.share ?? {})
    .filter(([key]) => TYPES[key] && TYPES[key].unlockFloor <= floorNumber);
  const shared = new Set(shares.map(([key]) => key));

  // A boost of 0 is how a theme says a type is not IN this building tonight —
  // filtered out rather than left in at zero, because a weightless entry can
  // still win the walk below on a roll of exactly zero, and `reanimated: 0` on
  // the machine floor has to mean none rather than almost none.
  const pool = unlocked
    .filter(([key]) => !shared.has(key))
    .map(([key, t]) => ({ t, w: theme?.boost[key] ?? t.weight }))
    .filter((e) => e.w > 0);

  const draw = rng();
  let band = 0;
  for (const [key, s] of shares) {
    band += s;
    if (draw < band) return TYPES[key];
  }
  // Nothing left to be the other fifth — a depth where the shared types are the
  // only ones unlocked. Better the theme's own type than a body from a floor
  // this deep that has not been reached yet.
  if (!pool.length) return shares.length ? TYPES[shares[0][0]] : TYPES.analyst;

  let total = 0;
  for (const e of pool) total += e.w;

  let roll = (band ? (draw - band) / (1 - band) : draw) * total;
  for (const e of pool) {
    roll -= e.w;
    if (roll <= 0) return e.t;
  }
  return TYPES.analyst;
}

/**
 * Whether a theme can be ITSELF at this depth.
 *
 * A SHARE is the theme's identity rather than a tilt — four in five of the staff
 * ARE this — so it is required, not preferred: an Automated floor a depth above
 * the Sentry Unit would be a floor named after machines with no machine on it,
 * which is the same nothing an Infestation with no Reanimated would be. `boost`
 * stays a `some`, because a tilt that only half applies is still a floor with a
 * character.
 *
 * Named rather than written inline in the filter below because forceTheme has to
 * ask the same question to say WHY a shift it was handed is not going to look
 * like itself yet, and a second copy of a predicate this specific is how a tool
 * ends up certifying a floor the game never builds.
 */
function themeUsable(theme, floorNumber) {
  const shares = Object.keys(theme.share ?? {});
  if (shares.some((k) => !TYPES[k] || TYPES[k].unlockFloor > floorNumber)) return false;

  const keys = Object.keys(theme.boost);
  return !keys.length || shares.length
    || keys.some((k) => TYPES[k] && TYPES[k].unlockFloor <= floorNumber);
}

// The shift being worked on, or null for the ordinary weighted draw. DEV ONLY:
// nothing in the shipped game ever sets this — see forceTheme.
let forced = null;

/**
 * Pin every floor to one shift, or pass null to go back to the draw.
 *
 * This is a workbench, not a feature: iterating on a shift means seeing it, and
 * the alternative is descending until the die agrees with you — an Automated
 * floor is three in sixteen, so half the time that is four floors of somebody
 * else's building. `main.js` reaches it from `?shift=` and from `dev.shift()`,
 * both stripped from a production build with the rest of `window.dev`.
 *
 * It is deliberately OFF unless somebody asks for it in the URL or at the
 * console, because a dev aid that is simply on is how the generator room came to
 * be under the player's feet on every floor of every dev build for weeks: the
 * game stops being played the way it ships, and nobody notices, because it works.
 *
 * Matched loosely on the name (case, spaces and dashes) — these are typed into a
 * URL bar by hand. Returns the theme it pinned, or null.
 */
export function forceTheme(name, floorNumber = 1) {
  const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  forced = name == null ? null : THEMES.find((t) => key(t.name) === key(name)) ?? null;

  if (name != null && !forced) {
    console.warn(`[shift] no such shift ${JSON.stringify(name)} — try one of: `
      + THEMES.map((t) => t.name).join(', '));
  } else if (forced && !themeUsable(forced, floorNumber)) {
    // Pinned anyway: the ask was explicit. But a machine floor with no machines
    // yet unlocked reads as the pin not having worked at all, so say which floor
    // it starts being itself on rather than leaving that to be puzzled out.
    // Which floor that is has to be read off themeUsable's own two rules and not
    // off the deepest thing the theme names: EVERY share has to be unlocked (so
    // the latest of them decides), while ONE boost is enough (so the earliest
    // does), and mixing those up names a floor two deeper than the answer.
    const at = (keys) => keys.map((k) => TYPES[k]?.unlockFloor ?? 1);
    const shares = at(Object.keys(forced.share ?? {}));
    const boosts = at(Object.keys(forced.boost ?? {}));
    const floor = shares.length ? Math.max(...shares)
      : (boosts.length ? Math.min(...boosts) : 1);
    console.warn(`[shift] ${forced.name} pinned, but it is not itself until floor ${floor}`
      + ` — dev.game.goToFloor(${floor})`);
  }
  return forced;
}

// Weighted pick over the themes whose signature types this floor can actually
// staff — an Infestation with no Reanimated unlocked is just a normal floor
// wearing a different name.
export function pickTheme(floorNumber, rng) {
  const usable = THEMES.filter((theme) => themeUsable(theme, floorNumber));
  let total = 0;
  for (const theme of usable) total += theme.weight;
  let roll = rng() * total;
  // Rolled even when the answer is already decided, so a pinned floor is the
  // same building as an unpinned one — every number after this comes off the
  // same stream, and a shift you can turn on and off is worth much less if it
  // re-rolls the roster's placement underneath you as you do.
  if (forced) return forced;
  for (const theme of usable) {
    roll -= theme.weight;
    if (roll <= 0) return theme;
  }
  return THEMES[0];
}
