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
// the brightest visor in the building and a Loader Unit is nearly the darkest,
// for exactly the reasons an Intern and a Manager are.
//
// `voice` names the set of vocals a type uses (see audio.js). Left off, a type
// gobbles like the rest of the office; the green ones brought their own.
//
// Multipliers are applied to the floor's base tuning (see tuningFor in
// game.js), so types scale with depth instead of going obsolete.
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

  // --- the machines -----------------------------------------------------------
  //
  // The Automated floor's staff. Every one of them is a `chassis` rather than a
  // rig (see CHASSIS in rigs.js) and every one of them is `weight: 0`, which is
  // the whole of how the theme stays a place rather than a tint: outside an
  // Automated floor none of these is ever rolled, so meeting a Loader Unit means
  // you are on the floor that has loaders on it. The Sentry Unit is the
  // exception and always was — it is Facilities' cost saving rather than the
  // plant's own fleet, and it turns up anywhere.
  //
  // They wear greys off the same ramp as everybody else, and that is a rule
  // being kept rather than a palette being copied: hue answers "do I shoot
  // this" and shade answers "which one", and neither question changes because
  // the thing in the corridor has wheels. A machine floor is a floor where the
  // answer to the first one is nearly always yes, which is exactly why the
  // second one has to keep working.
  clerk: {
    // Whatever used to sit at the desk. The baseline machine and the one there
    // are a hundred of, so its numbers are deliberately near an Analyst's: a
    // floor of these has to feel like an office being worked, and the ones with
    // forks and torches read as exceptions to it.
    name: 'Clerk Unit', hp: 1.15, speed: 1.02, damage: 0.95, rate: 1, spread: 1.15,
    range: 14, melee: false, scale: 1, chassis: 'clerk', voice: 'robot',
    // Faster onto a target than the man it replaced, and nowhere near the
    // Sentry: it was doing a spreadsheet ninety seconds ago too, it just does
    // not have to put anything down first.
    aimMul: 0.95,
    suit: 0x8d949c, shirt: 0x4a5058, visor: 0x949ba3, unlockFloor: 1, weight: 0,
  },
  loader: {
    // Three hundred kilograms of pallet handling with a grab on the end of the
    // arm. The slowest thing on the floor and the hardest single hit in the
    // building — you are meant to hear it coming, decide, and be somewhere
    // else. The clamp is what makes that possible: the second longest reach on
    // the roster after the mop, so the arc is legible from outside it.
    name: 'Loader Unit', hp: 3, speed: 0.86, damage: 2.1, rate: 1.5, spread: 1,
    range: 2.4, melee: true, scale: 1.16, blunt: ['clamp'],
    chassis: 'loader', voice: 'robot',
    suit: 0xd8a12a, shirt: 0x3d4149, visor: 0x454a51, unlockFloor: 1, weight: 0,
  },
  welder: {
    // The quick one. Half a Loader's damage and twice its pace, with almost no
    // reach at all — it has to be against you, which is the trade for being the
    // fastest thing on the floor that can hurt you.
    name: 'Welder Unit', hp: 1.3, speed: 1.35, damage: 1.25, rate: 0.95, spread: 1,
    range: 2.1, melee: true, scale: 0.98, blunt: ['torch'],
    chassis: 'welder', voice: 'robot',
    suit: 0x2f6f5e, shirt: 0x9aa0a6, visor: 0x6e757d, unlockFloor: 1, weight: 0,
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
  porter: {
    // Deliveries. The machine floor's Courier and the same joke told about the
    // building instead of about a man: it has a load, it is taking it
    // somewhere, and a firefight is not on its route. Neutral, so it counts
    // toward nothing and walking past it costs nothing.
    //
    // Violet, because the neutrals are the only things in the building wearing
    // an actual colour and no two of them may share one — white, brown, yellow,
    // blue and hi-vis orange are all spoken for, and this has to be told from
    // the courier it is standing in for at the range you first see it.
    name: 'Porter Unit', hp: 0.8, speed: 1.2, damage: 0, rate: 99, spread: 1,
    range: 0, melee: false, scale: 1, neutral: true,
    chassis: 'porter', voice: 'robot', screams: 'robot-alert',
    suit: 0x6f7681, shirt: 0x3a3f47, visor: 0xc46bff, unlockFloor: 1, weight: 0,
  },

  // --- the neutrals -----------------------------------------------------------
  //
  // Nobody on this side of the roster is fighting you, and none of them counts
  // toward clearing the floor — you can walk past every one of them and take the
  // exit. None of them wears a grey visor, and they all show up yellow on the
  // minimap, because "do I have to shoot this" is a question you need answered
  // from the far end of a corridor, not once it is already swinging at you.
  // Unlike the hostiles they do not share one colour: three harmless people in
  // identical visors read as one repeated joke, and the toilet guy in
  // particular has to be recognisable before he is close enough to hear. All
  // are placed by hand rather than rolled (see spawn), which is why the weights
  // are zero.
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
    // Facilities' idea of a cost saving. Armoured and slow, accurate at range,
    // and it never gets bored — the darkest visor on the floor is the one that
    // means the thing looking at you is not going to wander off.
    //
    // The one machine on the roster that is rolled rather than placed by a
    // theme, which is why it is filed with the staff and not with the fleet
    // below: it was bought in to watch a corridor in a building full of people,
    // so it turns up in one. On tracks, and the only thing in the building that
    // arrives at the height it left at.
    name: 'Sentry Unit', hp: 3.2, speed: 0.78, damage: 1.45, rate: 1.35, spread: 0.7,
    range: 17, melee: false, scale: 1.18, chassis: 'sentry',
    // Quickest onto a target in the building, and the one that should be: it was
    // bought to watch a corridor, it is not carrying anything it has to put down,
    // and the darkest visor on the floor ought to mean the thing wearing it is
    // the one you cannot walk out in front of.
    aimMul: 0.65,
    suit: 0x474d55, shirt: 0x9aa3ab, visor: 0x3a4048, voice: 'robot',
    unlockFloor: 2, weight: 3,
  },
};

// The neutrals that are not the toilet guy. He is guaranteed on every floor;
// these fill in around him so the harmless staff are not one repeated joke.
export const BYSTANDERS = [TYPES.cleaner, TYPES.courier];

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
// `bystanders` is the last one and it is about the corridors: the harmless
// traffic is a night cleaner and a courier unless a theme names its own, and on
// a floor run by machines the deliveries are done by one. The toilet guy is
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
  // corridors, loaders shifting stock, welders on the racks and a few drones
  // over all of it.
  { name: 'Automated', weight: 3, light: 0.72, tint: 0x7fb4ff,
    rats: [0, 0], patrols: [0, 1], cleaners: [3, 5], bystanders: ['porter'],
    conveyors: [5, 9],
    share: { clerk: 0.34, sentry: 0.2, loader: 0.14, welder: 0.13, drone: 0.09 },
    boost: { sysadmin: 6, facilities: 3, reanimated: 0 } },
  { name: 'Lockdown', weight: 2, light: 0.75, rats: [1, 1], patrols: [3, 4], boost: { security: 6, manager: 4 } },
  { name: 'Night shift', weight: 2, light: 0.5, rats: [2, 3], patrols: [1, 2], boost: { reanimated: 4, sentry: 4, facilities: 3 } },
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
