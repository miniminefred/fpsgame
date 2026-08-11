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
    name: 'Analyst', hp: 1, speed: 1, damage: 1, rate: 1, spread: 1,
    range: 15, melee: false, scale: 1,
    suit: 0x41464e, shirt: 0xd9dde1, visor: 0x8b9198, unlockFloor: 1, weight: 4,
  },
  sysadmin: {
    // Fast, inaccurate chip damage — the one that punishes standing still.
    name: 'Sysadmin', hp: 0.8, speed: 1.12, damage: 0.45, rate: 0.4, spread: 1.7,
    range: 13, melee: false, scale: 0.97,
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
    name: 'Sentry Unit', hp: 3.2, speed: 0.78, damage: 1.45, rate: 1.35, spread: 0.7,
    range: 17, melee: false, scale: 1.18,
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
export const THEMES = [
  { name: 'Business as usual', weight: 4, light: 1, rats: [1, 1], patrols: [1, 3], boost: {} },
  { name: 'Infestation', weight: 3, light: 0.34, rats: [4, 6], patrols: [0, 0], boost: { reanimated: 7, intern: 2 } },
  { name: 'Automated', weight: 3, light: 0.9, rats: [0, 1], patrols: [1, 2], boost: { sentry: 7, sysadmin: 3 } },
  { name: 'Lockdown', weight: 2, light: 0.75, rats: [1, 1], patrols: [3, 4], boost: { security: 6, manager: 4 } },
  { name: 'Night shift', weight: 2, light: 0.5, rats: [2, 3], patrols: [1, 2], boost: { reanimated: 4, sentry: 4, facilities: 3 } },
  { name: 'All-hands', weight: 2, light: 1, rats: [1, 1], patrols: [2, 4], boost: { analyst: 6, intern: 5, manager: 3 } },
];

// Weighted pick from the types unlocked at this depth. Early floors are all
// analysts and interns; the nastier staff join as you descend, and because
// weights are relative the mix keeps shifting rather than simply adding.
export function pickType(floorNumber, rng, theme) {
  // `weight: 0` types are placed by hand rather than rolled — see spawn.
  const pool = Object.entries(TYPES)
    .filter(([, t]) => t.unlockFloor <= floorNumber && t.weight > 0)
    .map(([key, t]) => ({ t, w: theme?.boost[key] ?? t.weight }));

  let total = 0;
  for (const e of pool) total += e.w;

  let roll = rng() * total;
  for (const e of pool) {
    roll -= e.w;
    if (roll <= 0) return e.t;
  }
  return TYPES.analyst;
}

// Weighted pick over the themes whose signature types this floor can actually
// staff — an Infestation with no Reanimated unlocked is just a normal floor
// wearing a different name.
export function pickTheme(floorNumber, rng) {
  const usable = THEMES.filter((theme) => {
    const keys = Object.keys(theme.boost);
    return !keys.length || keys.some((k) => TYPES[k] && TYPES[k].unlockFloor <= floorNumber);
  });
  let total = 0;
  for (const theme of usable) total += theme.weight;
  let roll = rng() * total;
  for (const theme of usable) {
    roll -= theme.weight;
    if (roll <= 0) return theme;
  }
  return THEMES[0];
}
