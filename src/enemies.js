import * as THREE from 'three';
import { BODY_RADIUS as RADIUS } from './nav.js';
import { CORRIDOR, STAFF_ONLY, worldX, worldZ } from './gen/layout.js';
import { buildRig } from './rigs.js';

// The people still working here.
//
// Movement is grid-based (see nav.js): everyone walks downhill on one shared
// distance field flooded from the player, so a whole floor of them routes
// through doorways correctly without per-enemy pathfinding. Combat is
// probabilistic but geometric — a shot's spread is sampled as a real angle and
// converted into a miss distance at the player's range, so backing off actually
// makes you harder to hit instead of just changing a magic number.

const EYE = 1.55;
const SIGHT = 22;          // metres they can notice you at, with line of sight
// How far gunfire carries — measured *through the building*, not through its
// walls. A straight-line radius was the bug: someone one metre away through
// drywall and a thirty metre walk from the nearest door counted as right next to
// you, so firing anywhere turned the whole floor around at once. Walking the
// distance field instead means noise spreads the way it actually would, down
// corridors and out of doorways, and this can afford to be generous because it
// is now an honest number.
const HEARING = 14;
// Being heard is a real contact, so it holds them as long as you keep shooting.
// Without this an enemy who heard you two rooms away walks toward the noise for
// GIVE_UP seconds, gives up short of arriving, and goes back to work — which
// makes hearing you look broken rather than lethal.
const HEARD_MEMORY = 4;
// One of them calls it out and the rest just come. Every enemy shouting the
// instant it notices you is a chorus, and it was the single loudest thing on the
// floor.
const SHOUT_GAP = 1.8;

// The neutral staff. They pick somewhere to be, walk there, pick again — which
// is what "still going about your day" looks like without a plan, and it keeps
// them moving through doorways rather than pacing one room.
const PANIC_HOP = 30;          // metres they will commit to in one direction
const PANIC_PATIENCE = 6;      // ...and how long before they change their mind
const PANIC_SHOUT = [1.6, 3.4];
const CORRIDOR_SAMPLE = 10;    // keep every Nth corridor tile as a waypoint

// Shoot a neutral and they do not draw a weapon they never had — they bolt.
// Fleeing is the same wander loop with the destination filtered to somewhere
// further from you, so it routes through doorways like everything else; when it
// runs out they go back to whatever they were doing.
const FLEE_TIME = 8;
const FLEE_SPEED = 1.45;
const FLEE_AWAY = 4;           // metres a flee destination must gain on you
const PREFERRED = 7;       // range a shooter tries to hold
const TOO_CLOSE = 3.5;
const GIVE_UP = 7;         // seconds of no contact before they settle down
// What an explosion is worth as a throw, at the seat of it. Above anything a gun
// can do, which is the point of standing next to one. See splash.
const BLAST_PUNCH = 3.5;
// What a round is worth by where it lands. A head is worth more than a chest and
// a chest more than a limb, which is the ordering every shooter has and the one
// the player is already aiming as if it were true.
//
// The ordering is the whole of it and the SPREAD is deliberately tiny — a nudge,
// not a rule. A head worth double turns every gun into a one-shot gun against
// anything that is not armoured, and a limb worth half turns a clean hit at
// twenty metres into a punishment for the 14 cm of arm that happened to be in
// front of the chest. Neither of those is aim, they are luck with a multiplier
// on it. At a tenth either way the head is still the shot worth taking and a
// limb still costs you something, and no single round decides a fight on
// geometry the player could not have controlled.
const HIT_ZONES = { head: 1.12, torso: 1, limb: 0.92 };
const DEATH_TIME = 2.2;
const HIT_FLASH = 0.1;
const SWING_TIME = 0.5;    // wind-up plus follow-through on a melee swing

// How many of the staff, beyond the guaranteed holders, are carrying a spare
// keycard. Low on purpose: at seventy to two hundred people a floor even this
// leaves a dozen or so on the carpet, and a card you trip over every ten seconds
// is not a key, it is confetti.
const CARD_SPARE_CHANCE = 0.06;

// The prologue. Until the player has a white card the only people they can reach
// are the ones in the corridors, so these two numbers decide how long a floor
// takes to start: how far the first one may be, and how many there are at all.
// See _cardOutside.
const FIRST_CONTACT = 34;      // metres from the lifts
const OUTSIDE_MIN = 5;
const MIN_SPAWN_GAP = 11;      // ...but never close enough to be there on arrival

// The cleaning staff. Doing rounds in the corridors, plus the two on their
// break in the broom closet. See _janitors.
const JANITORS = [1, 3];
const CLOSET_JANITORS = 2;

// The security staff, on the same shape: the ones walking the halls carry the
// blue card, and the ones in the security office are behind the door it opens.
// See _security. The office is the one room on the floor with a crowd in it —
// the wall of screens is what they are all looking at — which is why the number
// is what it is and why they are not all carrying the same thing.
const OFFICE_GUARDS = [2, 5];
const GUARD_BATON = 0.4;       // how much of the shift drew a baton instead
const GUARD_GAP = 0.8;         // metres between two men in one room
// How far a seated body drops, and how far its legs come up to meet the floor.
const SIT_DROP = 0.42;
const SIT_LEGS = -1.5;         // radians — straight out in front

// The security uniform, shared by the two halves of the shift — the one with a
// sidearm and the one with a baton. It is one set of clothes on one kind of
// person, so it is written down once and both types wear it; `guard` is what
// the rest of the file tests instead of naming either of them, and it is what
// the blue card is dealt on.
const GUARD = {
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
const TYPES = {
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
const BYSTANDERS = [TYPES.cleaner, TYPES.courier];

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
const THEMES = [
  { name: 'Business as usual', weight: 4, light: 1, rats: [1, 1], patrols: [1, 3], boost: {} },
  { name: 'Infestation', weight: 3, light: 0.34, rats: [4, 6], patrols: [0, 0], boost: { reanimated: 7, intern: 2 } },
  { name: 'Automated', weight: 3, light: 0.9, rats: [0, 1], patrols: [1, 2], boost: { sentry: 7, sysadmin: 3 } },
  { name: 'Lockdown', weight: 2, light: 0.75, rats: [1, 1], patrols: [3, 4], boost: { security: 6, manager: 4 } },
  { name: 'Night shift', weight: 2, light: 0.5, rats: [2, 3], patrols: [1, 2], boost: { reanimated: 4, sentry: 4, facilities: 3 } },
  { name: 'All-hands', weight: 2, light: 1, rats: [1, 1], patrols: [2, 4], boost: { analyst: 6, intern: 5, manager: 3 } },
];

export class Enemies {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.meshes = [];       // what bullets test against
    this.time = 0;
    this.shoutTimer = 0;    // floor-wide, so only one of them calls you out
    this.onDeath = null;    // set by game.js — see _damage
    this.ragdolls = null;   // likewise; what happens to a body after _damage
    this._v = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._aim = new THREE.Vector3();
  }

  get aliveCount() {
    let n = 0;
    for (const e of this.items) if (e.alive) n++;
    return n;
  }

  // What the floor objective counts. The neutrals are alive and on the floor and
  // are deliberately not in this number — clearing a floor means clearing the
  // people shooting at you, not hunting down a cleaner.
  get hostileCount() {
    let n = 0;
    for (const e of this.items) if (e.alive && !e.neutral) n++;
    return n;
  }

  /**
   * Hostiles you can get to without opening anything you have not got the card
   * for. Everyone on the floor except the manager, sitting behind his own door.
   *
   * This is what decides when the black card drops: the moment this reaches zero
   * the player has killed everyone they are able to, and the card has to be on
   * the carpet or the floor cannot be finished. See game.js.
   */
  get openHostileCount() {
    let n = 0;
    for (const e of this.items) if (e.alive && !e.neutral && !e.behindLock) n++;
    return n;
  }

  // Populates a floor. `tuning` scales with depth — see game.js.
  spawn(layout, nav, rng, tuning) {
    this.clear();
    this.nav = nav;
    this.tuning = tuning;
    this.shoutTimer = 0;
    this.theme = pickTheme(layout.floorNumber, rng);
    this.corridors = collectCorridors(layout, nav);

    const spots = this._spawnPoints(layout, nav, rng, tuning.count);
    // A room holds a team, not a headcount. Whoever is in a room is in it
    // together — same type, working the same job — because a room of one intern,
    // one manager and one sentry is a spawn list, and a room of three interns is
    // a room. Some rooms get nobody, which is what makes the occupied ones feel
    // deliberate rather than sprinkled.
    let team = null;
    let left = 0;
    for (const spot of spots) {
      if (left <= 0 || spot.room !== team?.room) {
        team = { room: spot.room, type: pickType(layout.floorNumber, rng, this.theme) };
        left = rng.chance(0.45) ? 1 : (rng.chance(0.72) ? 2 : 3);
      }
      left--;
      this._add(spot.x, spot.z, rng, tuning, team.type);
    }

    this._security(layout, nav, rng, tuning);

    // A handful of neutrals on every floor, placed rather than rolled: they are
    // a fixture of the building, not a difficulty ingredient, and leaving them
    // to the weighted draw would mean floors without any. They all start in a
    // corridor because that is where the point of them is — you are supposed to
    // see one cross the end of a hallway and have to decide, quickly, whether it
    // mattered.
    const neutrals = [];
    for (let i = rng.int(1, 2); i > 0; i--) neutrals.push(TYPES.panicker);
    for (let i = rng.int(1, 3); i > 0; i--) neutrals.push(rng.pick(BYSTANDERS));

    for (let i = 0; i < neutrals.length; i++) {
      const spot = this.corridors.length ? rng.pick(this.corridors) : spots[i];
      if (spot) this._add(spot.x, spot.z, rng, tuning, neutrals[i]);
    }

    // And the rats, which go anywhere rather than starting in a corridor: the
    // point of the staff is that you see them cross a hallway and have to
    // decide, and the point of a rat is that it is already in the room with you.
    const [ratMin, ratMax] = this.theme.rats ?? [1, 1];
    for (const spot of this._loose(layout, nav, rng, rng.int(ratMin, ratMax))) {
      this._add(spot.x, spot.z, rng, tuning, TYPES.rat);
    }

    // And exactly one floor cleaner, which is the joke.
    for (const spot of this._loose(layout, nav, rng, 1)) {
      this._add(spot.x, spot.z, rng, tuning, TYPES.roomba);
    }

    this._cardOutside(layout, nav, rng, tuning);
    this._janitors(layout, nav, rng, tuning);
    this._manager(layout, nav, rng, tuning);
    this._dealCards(layout, rng);
  }

  /**
   * Security: the shift walking the halls, and the ones sat in their own office.
   *
   * Same shape as the janitors and the broom closet one tier along, and for the
   * same reason. The blue card comes off security and off nobody else, so where
   * they stand is a correctness question: the ones on rounds are in the
   * corridors, outside every lock, which is what guarantees the card is
   * reachable with nothing in your pocket. The two-to-five in the security
   * office are marked `behindLock` and dealt nothing, because men sitting in the
   * room their own key opens, holding that key, is the failure the whole system
   * exists to prevent.
   *
   * The one place it differs is that a patrol is not just a card holder. Every
   * other hostile is found where they work, which makes a floor a series of
   * rooms you clear; a patrol is the one thing that comes to YOU, down a hallway
   * you have already been down. That is what `patrols` on a theme tunes — except
   * that a theme is allowed to say nobody is doing rounds tonight, and a floor
   * with a security office and nobody outside it is a door with no key. So the
   * theme sets the number and the office sets the floor under it.
   */
  _security(layout, nav, rng, tuning) {
    const office = layout.locks?.find((l) => l.tier === 'blue');

    // Corridors outside every lock, preferring the ones that are not on top of
    // the lifts — being close to where the player arrives is fine, standing on
    // it is not.
    const free = this.corridors.filter((s) => !this._behindALock(layout, s.x, s.z));
    const away = free.filter((s) =>
      Math.hypot(s.x - layout.spawn.x, s.z - layout.spawn.z) > MIN_SPAWN_GAP);
    const halls = away.length ? away : free;

    const [patMin, patMax] = this.theme.patrols ?? [1, 3];
    const wanted = Math.max(rng.int(patMin, patMax), office ? 1 : 0);

    let onRounds = 0;
    for (let i = wanted; i > 0 && halls.length; i--) {
      const spot = rng.pick(halls);
      this._add(spot.x, spot.z, rng, tuning, this._guardType(rng));
      onRounds++;
    }

    // And the office. Only if somebody outside is carrying the key to it: these
    // count toward clearing the floor, so posting them behind a door with no
    // reachable blue card anywhere is a floor that cannot be finished.
    if (!office || !onRounds) return;

    const room = office.room;
    let posted = 0;
    const want = rng.int(OFFICE_GUARDS[0], OFFICE_GUARDS[1]);
    for (let tries = 0; tries < 120 && posted < want; tries++) {
      const tx = rng.int(room.x0, room.x1 - 1);
      const ty = rng.int(room.y0, room.y1 - 1);
      if (!nav.walkable(tx, ty)) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;
      // Five men in one small room will otherwise be dealt the same two tiles.
      if (this.items.some((e) => Math.hypot(e.x - x, e.z - z) < GUARD_GAP)) continue;

      const e = this._add(x, z, rng, tuning, this._guardType(rng));
      e.behindLock = true;
      posted++;
    }
  }

  // Which half of the shift this one is. A room of guards is meant to come at
  // you as a room rather than as a firing line: whoever drew a baton is the one
  // closing the distance while the rest of them shoot over him.
  _guardType(rng) {
    return rng.chance(GUARD_BATON) ? TYPES.guardBaton : TYPES.security;
  }

  /**
   * The cleaning staff: a few doing rounds, and the two on their break.
   *
   * They are the only source of the yellow card, so where they stand is a
   * correctness question rather than a flavour one. The ones on rounds go in the
   * corridors — outside every lock, which is what guarantees the card is
   * reachable with nothing in your pocket — and the two in the broom closet are
   * marked `behindLock` so they are not dealt one. Two men sitting in the room
   * their own key opens, holding that key, is the exact failure the whole
   * keycard system is built to avoid.
   *
   * So the closet is the same shape as the manager's office one tier down: you
   * take the card off somebody in a hallway, and it buys you a door with two
   * more of them behind it who did not hear you coming.
   */
  _janitors(layout, nav, rng, tuning) {
    // On rounds. Corridors, because a mop is used in corridors and because that
    // is the one place on the floor no card can shut you out of.
    const free = this.corridors.filter((s) => !this._behindALock(layout, s.x, s.z));
    const away = free.filter((s) =>
      Math.hypot(s.x - layout.spawn.x, s.z - layout.spawn.z) > MIN_SPAWN_GAP);
    // Standing on the lift lobby is worse than being close to it, so the
    // distance filter is a preference rather than a requirement.
    const spots = away.length ? away : free;

    let onRounds = 0;
    for (let i = rng.int(JANITORS[0], JANITORS[1]); i > 0 && spots.length; i--) {
      const spot = rng.pick(spots);
      this._add(spot.x, spot.z, rng, tuning, TYPES.janitor);
      onRounds++;
    }

    // And the two on their break, sitting it out behind their own door.
    //
    // They only exist if somebody outside is carrying the key to it. The two of
    // them count toward clearing the floor, so seating them behind a door with
    // no reachable yellow card anywhere would be a floor that cannot be
    // finished — the one bug this whole system is arranged to make impossible.
    const closet = layout.locks?.find((l) => l.tier === 'yellow');
    if (!closet || !onRounds) return;

    const room = closet.room;
    let seated = 0;
    for (let tries = 0; tries < 60 && seated < CLOSET_JANITORS; tries++) {
      const tx = rng.int(room.x0, room.x1 - 1);
      const ty = rng.int(room.y0, room.y1 - 1);
      if (!nav.walkable(tx, ty)) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;
      if (this.items.some((e) => e.seated && Math.hypot(e.x - x, e.z - z) < 0.9)) continue;

      const e = this._add(x, z, rng, tuning, TYPES.janitor);
      e.behindLock = true;
      // They get up the moment anything happens — see _animate. Until then they
      // are on the floor with their backs to a shelf, which is what a broom
      // closet is for.
      e.seated = true;
      seated++;
    }
  }

  /**
   * The manager, in the manager's office, behind the manager's door.
   *
   * He is the only person on the floor who works behind a real lock, and he is
   * the reason the black card is worth having: every other badged room is loot
   * you can walk past, and this one is the last thing between you and the lift.
   *
   * That inverts the usual rule — the black room IS on the critical path, where
   * grey, blue and yellow never are — and it only works because of when his card
   * arrives. The black card comes off the last hostile OUTSIDE this room (see
   * game.js), so by the time he is the only one left you are already holding the
   * key to his door. There is no order of events in which the floor locks up.
   *
   * He is a Manager whatever floor this is, `unlockFloor` notwithstanding. A
   * manager's office with an intern in it is a joke that only works once, and
   * the room is announced by a black keycard — it has to be worth the walk back.
   */
  _manager(layout, nav, rng, tuning) {
    const lock = layout.locks?.find((l) => l.tier === 'black');
    if (!lock) return;

    const room = lock.room;
    for (let tries = 0; tries < 40; tries++) {
      const tx = rng.int(room.x0, room.x1 - 1);
      const ty = rng.int(room.y0, room.y1 - 1);
      if (!nav.walkable(tx, ty)) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;

      const boss = this._add(x, z, rng, tuning, TYPES.manager);
      // What keeps him out of openHostileCount, and out of _dealCards — a card
      // in his pocket is a card behind his own door.
      boss.behindLock = true;
      return;
    }
  }

  /**
   * The people with a badge who are standing where no badge is needed to reach
   * them.
   *
   * This is the load-bearing guarantee of the whole keycard system, and it falls
   * out of one decision: white is on every door. Every employee is carrying a
   * white card and nearly every employee is behind a white door, so until you
   * have taken one off somebody the floor is a corridor network with two hundred
   * shut rooms off it. Nobody comes out to meet you either — a badged door is
   * shut to the staff as well, at the nav grid.
   *
   * So the opening of a floor is a short prologue, and this decides how short.
   * One hostile in a corridor would technically satisfy the invariant and would
   * make every floor start with a five-minute walk looking for one man. A
   * handful, with at least one close enough to walk into, makes it thirty
   * seconds: find somebody, take the badge, and the building comes on.
   *
   * Security patrols usually cover this already — they are in the corridors by
   * construction — but there may be as few as one of them, and on a floor with
   * no security office to guard there may be none at all. So the top-up is
   * whatever is working this floor rather than more security. On an Infestation
   * that is something shambling down a hallway, which is what an Infestation
   * looks like anyway.
   */
  _cardOutside(layout, nav, rng, tuning) {
    // "Outside a lock" is not enough on its own any more: the corridors have
    // readers on them too, so a corridor can be outside every ROOM lock and
    // still be on the far side of a hall door the player has no badge for.
    // `layout.prologue` is what they can actually walk to on arrival holding
    // nothing, and the generator guarantees there is room out there to stand in
    // (see hallLocks).
    const free = (x, z) => !this._behindALock(layout, x, z) && this._reachable(layout, x, z);
    let have = 0;
    let nearest = Infinity;
    for (const e of this.items) {
      if (e.neutral || !free(e.x, e.z)) continue;
      have++;
      nearest = Math.min(nearest, Math.hypot(e.x - layout.spawn.x, e.z - layout.spawn.z));
    }

    // Sorted by how far the walk is, so the top-up fills in from the near end —
    // the point is the first contact, not the head count.
    const spots = this.corridors
      .filter((s) => free(s.x, s.z))
      .map((s) => ({ s, d: Math.hypot(s.x - layout.spawn.x, s.z - layout.spawn.z) }))
      .filter((e) => e.d > MIN_SPAWN_GAP)
      .sort((a, b) => a.d - b.d);
    if (!spots.length) return;

    // Somebody inside FIRST_CONTACT of the lifts, and OUTSIDE_MIN of them in
    // total. Both are floors, not targets: a floor that already has a patrol
    // walking past the lobby gets nothing added.
    if (nearest > FIRST_CONTACT && spots[0].d <= FIRST_CONTACT) {
      this._add(spots[0].s.x, spots[0].s.z, rng, tuning, pickType(layout.floorNumber, rng, this.theme));
      have++;
    }
    for (let i = 1; have < OUTSIDE_MIN && i < spots.length; i++, have++) {
      const spot = rng.pick(spots.slice(0, Math.max(8, (spots.length * 0.4) | 0)));
      this._add(spot.s.x, spot.s.z, rng, tuning, pickType(layout.floorNumber, rng, this.theme));
    }
  }

  // Can the player get here before they have badged anything at all? Only the
  // first white card cares — everything else on the floor is placed for a player
  // who is already holding one.
  _reachable(layout, x, z) {
    if (!layout.prologue) return true;
    const tx = Math.floor((x - layout.ox) / layout.TILE);
    const ty = Math.floor((z - layout.oz) / layout.TILE);
    if (tx < 0 || ty < 0 || tx >= layout.W || ty >= layout.H) return false;
    return layout.prologue[ty * layout.W + tx] >= 0;
  }

  _behindALock(layout, x, z) {
    if (!layout.locked) return false;
    const tx = Math.floor((x - layout.ox) / layout.TILE);
    const ty = Math.floor((z - layout.oz) / layout.TILE);
    if (tx < 0 || ty < 0 || tx >= layout.W || ty >= layout.H) return true;
    return layout.locked[ty * layout.W + tx] !== 0;
  }

  /**
   * Who is carrying a keycard.
   *
   * Everybody is carrying the white one, because everybody who works here has a
   * staff badge — that is what makes white on every door fair rather than
   * cruel. The real cards replace the white they would otherwise have had
   * (there are a hundred and forty others carrying that), and they go to
   * specific people: grey to whoever the shuffle turns up, but yellow and blue
   * to the two trades that own a room on this floor.
   *
   * Dealt after everyone is placed rather than during placement, because the
   * question it has to answer is about the floor as a whole: every lock on it
   * needs a holder who is not behind it. For grey, blue and yellow that is free
   * — nobody is placed inside a staff-only room at all — and for white it is
   * _cardOutside above.
   *
   * Only hostiles carry. The neutrals are the people you are explicitly allowed
   * to walk past, and putting the security card in a cleaner's pocket turns
   * "you never have to shoot these" into a lie told once per floor.
   *
   * Black is not dealt at all. It comes off the last hostile standing, which is
   * both why the manager's office is the last room on the floor and why it can
   * be a skeleton key without unlocking the floor early.
   */
  _dealCards(layout, rng) {
    // `behindLock` is excluded: the manager's pockets are behind the manager's
    // door, so anything dealt to him is a key locked in with its own lock. The
    // same goes for the two janitors sitting in the broom closet.
    const hostiles = rng.shuffle(this.items.filter((e) => !e.neutral && !e.behindLock));
    for (const e of hostiles) e.card = 'white';

    const tiers = [...new Set((layout.locks ?? []).map((l) => l.tier))]
      .filter((t) => t !== 'black' && t !== 'white');

    // Two of them are not dealt with the rest, because they belong to a trade
    // rather than to whoever came up first in the shuffle: yellow is the
    // cleaning staff's and blue is security's, and every one of them on rounds
    // is carrying it. Which makes the broom closet and the security office rooms
    // you open because of who you shot, not because of what happened to fall out
    // of a body.
    const OWNED = { yellow: (e) => e.type === TYPES.janitor, blue: (e) => e.type.guard };
    for (const [tier, owns] of Object.entries(OWNED)) {
      if (!tiers.includes(tier)) continue;
      for (const e of hostiles) if (owns(e)) e.card = tier;
    }

    let i = 0;
    for (const tier of tiers) {
      if (OWNED[tier]) continue;
      // Never take a card off a janitor or a guard to hand out somebody else's.
      while (i < hostiles.length && hostiles[i].card !== 'white') i++;
      if (i >= hostiles.length) break;
      hostiles[i++].card = tier;
    }
    // Spares for the tiers that have more than one door, so a grey card is
    // something the floor hands you on the way past rather than one specific
    // body among a hundred and forty. Only ever over a white card: the shuffle
    // interleaves the owners with everybody else, so a spare pass that wrote
    // over whatever it landed on would quietly take the yellow off a janitor.
    const spares = tiers.filter((t) => t === 'grey');
    if (!spares.length) return;
    for (; i < hostiles.length; i++) {
      if (hostiles[i].card === 'white' && rng.chance(CARD_SPARE_CHANCE)) {
        hostiles[i].card = rng.pick(spares);
      }
    }
  }

  // Walkable spots anywhere on the floor, spawn included — used for things that
  // are scenery rather than opposition.
  _loose(layout, nav, rng, count) {
    const spots = [];
    for (let tries = 0; spots.length < count && tries < count * 40; tries++) {
      const tx = rng.int(0, layout.W - 1);
      const ty = rng.int(0, layout.H - 1);
      if (!nav.walkable(tx, ty)) continue;
      if (layout.locked?.[ty * layout.W + tx] === STAFF_ONLY) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;
      spots.push({ x, z });
    }
    return spots;
  }

  // Head count per type on this floor — the HUD and the debug harness use it.
  get roster() {
    const counts = {};
    for (const e of this.items) {
      if (e.alive) counts[e.type.name] = (counts[e.type.name] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Walkable tiles well away from where the player arrives.
   *
   * Room by room rather than scattered, and each spot remembers which room it
   * came from, because who ends up standing together is decided from that (see
   * spawn). Rooms are visited in a shuffled order and a random number of spots
   * are taken from each, so the floor gets crowded rooms, quiet rooms and empty
   * ones instead of an even sprinkle of exactly one person everywhere.
   */
  _spawnPoints(layout, nav, rng, count) {
    const spots = [];
    // Nobody works behind a REAL lock — grey, blue, yellow, black. That is the
    // rule that makes those four survivable: the card is never on the wrong side
    // of the door it opens. It costs half a dozen rooms of headcount out of a
    // hundred and forty, which is nothing next to a floor that cannot be
    // finished.
    //
    // White rooms are the opposite case and are staffed normally. White is on
    // every door in the building and on every employee in it, so a white room is
    // a room with the key to itself standing in it — and the guarantee that
    // makes the FIRST one openable is _cardOutside below, not this.
    const rooms = rng.shuffle(layout.rooms.filter((r) => r.role !== 'lobby' && !r.staffOnly));
    if (!rooms.length) return spots;

    const minDist = 14;
    // One group per room per pass, so the passes have to outnumber the enemies
    // per room — at seventy-plus on a twenty-room floor, eight passes ran out
    // long before the roster did and every floor quietly shipped half of it.
    const passes = Math.max(8, Math.ceil(count / Math.max(1, rooms.length)) + 4);

    for (let pass = 0; spots.length < count && pass < passes; pass++) {
      for (const room of rooms) {
        if (spots.length >= count) break;
        // How many this room takes this time round. Most of the floor's empty
        // rooms come from here rather than from being skipped outright: a room
        // that draws nobody on every pass simply never gets anybody.
        const want = rng.chance(0.28) ? 0 : rng.int(1, 3);

        for (let placed = 0; placed < want && spots.length < count; placed++) {
          for (let tries = 0; tries < 14; tries++) {
            const tx = rng.int(room.x0, room.x1 - 1);
            const ty = rng.int(room.y0, room.y1 - 1);
            if (!nav.walkable(tx, ty)) continue;

            const x = nav.wx(tx), z = nav.wz(ty);
            // A single walkable tile is not enough: movement tests a whole body
            // radius, so a tile wedged against furniture is one an enemy can
            // stand on but never leave. Spawning there makes it a statue.
            if (!nav.clear(x, z, RADIUS)) continue;
            if (Math.hypot(x - layout.spawn.x, z - layout.spawn.z) < minDist) continue;
            if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 1.6)) continue;

            spots.push({ x, z, room });
            break;
          }
        }
      }
    }
    return spots;
  }

  _add(x, z, rng, tuning, type) {
    // The body is rigs.js's business; everything below is behaviour.
    const rig = buildRig(type, rng);
    const { group, mats, ownGeo, torso, head, armL, armR, legL, legR, gun, blunt } = rig;
    group.position.set(x, 0, z);

    const enemy = {
      group, mats, ownGeo, torso, head, armL, armR, legL, legR, gun,
      blunt, bluntReach: rig.bluntReach, bluntRest: rig.bluntRest ?? 0.5,
      // Rat parts. Null on everything else, and the animation branches on the
      // rig rather than on the type, so a second four-legged thing costs a rig
      // and nothing else.
      rig: rig.rig, legs: rig.legs ?? null, tail: rig.tail ?? null,
      brush: rig.brush ?? null, motor: null,
      type,
      // Flat, because the minimap reads it every frame alongside `alive` and has
      // no business knowing what a type is.
      neutral: !!type.neutral,
      // The minimap answers "is there somebody in that room". A rat is not
      // somebody, so it is not on it.
      offMap: !!type.offMap,
      flee: 0,
      x, z,
      yaw: group.rotation.y,
      health: tuning.health * type.hp,
      maxHealth: tuning.health * type.hp,
      alive: true,
      state: 'idle',
      timer: rng.range(0, 1),
      fireCooldown: rng.range(0.4, 1.6),
      contact: 0,          // seconds since last seen the player
      lastSeen: null,
      walkPhase: rng.range(0, 6),
      hitFlash: 0,
      deathTime: 0,
      knockX: 0, knockZ: 0,
      swing: 0,
      swingLanded: true,
      dist: Infinity,
      strafe: rng.chance(0.5) ? 1 : -1,
      voiceTimer: rng.range(1, 14),   // staggered, or a floor mutters in chorus
      lastStep: 0,
      // The keycard on their belt, if any. Dealt after the whole floor is
      // placed — see _dealCards.
      card: null,
      // Vermin only: bolt, stop, bolt again.
      darting: true, dartTimer: rng.range(0.2, 1), moving: true,
      // Where a neutral is currently headed — the toilet, the next corridor to
      // mop — plus their own distance field to get there. See _repick.
      wanderX: 0, wanderZ: 0, wanderTimer: 0, field: null, stuck: 0,
      // How this body comes apart when it stops working (rigs.js), and whether
      // something took that offer up. `ragdoll` is what stands the toppling
      // animation down — see _die.
      bones: rig.bones ?? null,
      ragdoll: false,
      // Set on the people who work behind a real lock — the manager, and the two
      // janitors on their break. It keeps them out of openHostileCount and out
      // of the card deal.
      behindLock: false,
      // Sitting it out until something happens. See _animateSeated.
      seated: false,
      // The materials a hit whitens: whatever this one is actually wearing.
      flash: rig.flash ?? [],
    };

    if (type.neutral) {
      enemy.state = 'wander';
      enemy.voiceTimer = type.panic ? rng.range(0.2, 2.5) : rng.range(3, 14);
    }

    // Where a bullet can land, and what it is worth there.
    //
    // Limbs used to stop nothing at all, on the grounds that the box on an arm
    // is 14 cm across and catching one instead of the chest is luck rather than
    // aim. That is true, and it is an argument for a limb hit being CHEAP, not
    // for it being nothing: a round that goes through somebody's forearm and
    // does not scratch them is the more obvious lie, and it is the one the
    // player sees, because the tracer ends on the wall behind a man who did not
    // react. So all six boxes stop a round now and the arithmetic carries the
    // meaning instead.
    enemy.hitboxes = [];
    for (const [mesh, scale] of [
      [head, HIT_ZONES.head], [torso, HIT_ZONES.torso],
      [armL, HIT_ZONES.limb], [armR, HIT_ZONES.limb],
      [legL, HIT_ZONES.limb], [legR, HIT_ZONES.limb],
    ]) {
      if (!mesh) continue;              // a rat has a body and a head and that is all
      mesh.userData.enemy = enemy;
      mesh.userData.hitScale = scale;
      mesh.userData.isEnemyPart = true;
      enemy.hitboxes.push(mesh);
      this.meshes.push(mesh);
    }

    this.scene.add(group);
    this.items.push(enemy);
    return enemy;
  }

  /**
   * A bullet landed. Returns 'kill' | 'hit' | null (already down).
   *
   * `dir`, `point` and `punch` are the shot itself, and they are carried this
   * far for one reason: if this is the killing hit, the ragdoll needs to be
   * thrown the way the bullet was going, from the part it went into, as hard as
   * the gun that fired it. A body that folds straight down whatever hit it is a
   * body that died of natural causes.
   */
  hit(mesh, damage, dir = null, point = null, punch = 1) {
    const e = mesh.userData?.enemy;
    if (!e || !e.alive) return null;
    return this._damage(e, damage * (mesh.userData.hitScale ?? 1),
      dir ? { dir, point, mesh, punch } : null);
  }

  // Damage from any source, once it is known who took it and how much.
  _damage(e, damage, hit = null) {
    if (!e.alive) return null;
    e.health -= damage;
    e.hitFlash = HIT_FLASH;
    // Being shot at is a reliable way to get someone's attention.
    if (e.neutral) {
      // They have nothing to fight you with and never did. Zeroing the timer
      // makes the next tick pick a destination away from you instead of
      // finishing the walk they were already on.
      e.flee = FLEE_TIME;
      e.wanderTimer = 0;
    } else if (e.state === 'idle') {
      e.state = 'alert';
      e.timer = 0.15;
    }

    if (e.health > 0) return 'hit';

    e.alive = false;
    e.deathTime = DEATH_TIME;
    // A dead machine stops making machine noise. Nothing else clears this, and
    // the loop would otherwise run on out of a wreck for the rest of the floor.
    if (e.motor) { this.audio?.stopMotor(e.motor); e.motor = null; }
    // Every box this one was stopping rounds with goes quiet at once. They stay
    // in the raycast list — shooting.js walks past anything flagged as a body
    // part with nobody behind it — so the next round goes through the corpse
    // rather than being spent on it.
    for (const m of e.hitboxes) m.userData.enemy = null;
    // Hand the body to the solver. It can refuse — no physics, no skeleton, or
    // simply too many already falling — and refusing costs nothing, because the
    // animation below is still sitting there.
    e.ragdoll = !!this.ragdolls?.spawn(e, hit);
    // The visor going dark is the one bit of the death animation that survives
    // being ragdolled, because it is what says "this one is done" from across a
    // room. Everything else is now the solver's.
    if (e.ragdoll) e.mats.visor.color.setRGB(0.25, 0.05, 0.04);
    // Whatever they were carrying is now on the carpet. What that means — a
    // keycard, the black card off the last one standing — is game.js's, because
    // it is about the floor and this file is about the person.
    this.onDeath?.(e);
    return 'kill';
  }

  /**
   * An explosion. Everyone inside `radius` takes damage falling off to nothing
   * at the rim, and the neutrals who live through it take the hint and run.
   *
   * Distance is straight-line and ignores walls, which is wrong and stays wrong:
   * the blast that reaches through a partition is a smaller lie than the one
   * that goes off at somebody's feet and leaves them standing because the tile
   * they are on belongs to the next room.
   */
  splash(x, z, radius, damage, audio) {
    let kills = 0;
    for (const e of this.items) {
      if (!e.alive) continue;
      const dist = Math.hypot(e.x - x, e.z - z);
      if (dist > radius) continue;

      // Thrown outward from the seat of it, and upward — a body that only slides
      // away from an explosion looks like it was pushed. Straight up for anyone
      // standing exactly on it, since there is no outward to speak of.
      const k = 1 / (dist || 1);
      const blast = {
        dir: dist > 0.05
          ? { x: (e.x - x) * k, y: 0.55, z: (e.z - z) * k }
          : { x: 0, y: 1, z: 0 },
        point: { x: e.x, y: 0.9, z: e.z },
        // An explosion is the heaviest thing that happens to anybody on this
        // floor, and it falls off the same way its damage does — everything
        // near the seat of it leaves the ground, and the ones at the rim are
        // knocked over. See _throw in ragdolls.js.
        punch: BLAST_PUNCH * (1 - dist / radius),
      };

      const outcome = this._damage(e, damage * (1 - dist / radius), blast);
      if (outcome === 'kill') { kills++; audio?.enemyDeath(e); }
      else if (outcome === 'hit') audio?.enemyPain(e);
    }
    return kills;
  }

  update(dt, ctx) {
    this.time += dt;
    const { player, effects, audio, hud } = ctx;
    // Held so the paths that are not the update loop can reach it — a machine
    // shot dead has to stop running, and the bullet arrives from shooting.js.
    this.audio = audio;
    const px = player.object.position.x;
    const pz = player.object.position.z;
    const py = player.object.position.y;

    if (this.nav) this.nav.updateField(dt, px, pz);
    if (this.shoutTimer > 0) this.shoutTimer -= dt;

    // Where a fleeing neutral is running away from — _repick needs it and is
    // called from places that have no player to hand.
    this.playerX = px;
    this.playerZ = pz;

    for (const e of this.items) {
      if (!e.alive) { this._die(e, dt); continue; }

      const dx = px - e.x;
      const dz = pz - e.z;
      const dist = Math.hypot(dx, dz) || 0.001;
      const sees = dist < SIGHT && this.nav.losClear(e.x, e.z, px, pz);
      // Hearing only matters when they cannot see you — if they can, sight has
      // already told them everything, and at a longer range. The distance is the
      // walked one: the field is flooded from the player, so it is already paid
      // for, and a negative value means there is no route at all.
      const along = this.nav.pathDistance(e.x, e.z);
      const hears = !sees && ctx.noise > 0 && along >= 0 && along < HEARING;
      e.dist = dist;

      if (sees) {
        e.contact = 0;
        e.lastSeen = { x: px, z: pz };
      } else if (hears) {
        // Not a sighting, so they still do not know exactly where you are — but
        // it counts as contact, which is what keeps them walking your way
        // instead of losing interest halfway down the corridor.
        e.contact = Math.min(e.contact, HEARD_MEMORY);
        e.lastSeen = { x: px, z: pz };
      } else {
        e.contact += dt;
      }

      // Neutrals are not in the state machine at all: no alert, no chase, no
      // weapon. Seeing you and hearing you change nothing — the only thing that
      // does is being shot, and that makes them run rather than fight.
      if (e.neutral) {
        this._wander(e, dt, audio);
        this._animate(e, dt, audio);
        continue;
      }

      this._think(e, dt, dist, sees, hears, ctx);
      this._move(e, dt, dx, dz, dist, sees);
      this._shoot(e, dt, dist, sees, px, py, pz, player, effects, audio, hud);
      this._animate(e, dt, audio);
      this._mutter(e, dt, audio);
    }
  }

  // Walks somewhere, says something about it, walks somewhere else. Deliberately
  // not pathfinding to anything real: he does not know where the bathroom is
  // either, and the cleaner is not working a route.
  //
  // Shoot one and `flee` runs for a few seconds: same loop, quicker, and only
  // picking destinations that put distance between the two of you. When it
  // expires they go back to the day they were having.
  _wander(e, dt, audio) {
    if (e.flee > 0) e.flee -= dt;

    // The toilet guy shouts constantly because that is the whole character.
    // Everyone else is quiet until you shoot them, and then they are not.
    const shouting = e.type.panic || e.flee > 0;
    e.voiceTimer -= dt;
    if (e.voiceTimer <= 0) {
      if (shouting) {
        e.voiceTimer = PANIC_SHOUT[0] + Math.random() * (PANIC_SHOUT[1] - PANIC_SHOUT[0]);
        // The type names what it screams. A cleaner running from a firefight has
        // nothing to say about the toilet, and the rat has nothing to say at all.
        audio.enemyScream(e, e.type.screams ?? 'flee');
      } else {
        e.voiceTimer = 7 + Math.random() * 11;
        audio.enemyIdle(e);
      }
    }

    e.wanderTimer -= dt;
    const togo = Math.hypot(e.wanderX - e.x, e.wanderZ - e.z);

    if (e.wanderTimer <= 0 || togo < 0.8) {
      this._repick(e);
      return;
    }

    // Vermin do not walk anywhere. They bolt, stop dead, think about it, and
    // bolt again — and the stopping is what makes the bolting read as fast.
    if (e.type.darts) {
      e.dartTimer -= dt;
      if (e.dartTimer <= 0) {
        e.darting = !e.darting;
        e.dartTimer = e.darting ? 0.35 + Math.random() * 0.8 : 0.25 + Math.random() * 0.9;
      }
      // Frozen mid-scurry, not stuck: the stall counter has to be told, or the
      // pause gets mistaken for wedged furniture and it repicks every time.
      if (!e.darting) {
        e.stuck = 0;
        e.moving = false;
        return;
      }
    }

    // Downhill on his own field, not straight at the destination: the whole
    // point of giving him one is that he goes round the wall instead of into it.
    const dir = this.nav.descendOn(e.field, e.x, e.z, this._v);
    if (!dir) { this._repick(e); return; }

    const speed = this.tuning.speed * e.type.speed * (e.flee > 0 ? FLEE_SPEED : 1);
    const movedX = this._tryMove(e, dir.x * speed * dt, 0);
    const movedZ = this._tryMove(e, 0, dir.z * speed * dt);
    // Wedged against something the grid thinks is passable. Sidestep first —
    // it is usually a doorway they are half a metre to the side of — and only
    // make a whole new plan if that gets nowhere either.
    if (!movedX && !movedZ) {
      e.stuck += dt;
      const step = speed * dt;
      if (!this._tryMove(e, -dir.z * e.strafe * step, dir.x * e.strafe * step)) {
        e.strafe *= -1;
      }
      if (e.stuck > 0.6) this._repick(e);
    } else {
      e.stuck = 0;
    }

    e.moving = true;
    e.group.position.x = e.x;
    e.group.position.z = e.z;
    e.yaw = angleLerp(e.yaw, Math.atan2(-dir.x, -dir.z), 1 - Math.exp(-9 * dt));
    e.group.rotation.y = e.yaw;
  }

  // Somewhere else, and a route to it. Sampled rather than searched: a handful
  // of tries is enough to find open floor, and failing simply means standing
  // still for a moment, which is entirely in character. Corridors are the
  // preferred destination: that is where they can actually run, and where you
  // get to watch them do it.
  //
  // While fleeing the pick also has to gain ground on the player — but only for
  // the first ten attempts, because a neutral cornered in a dead end with
  // nowhere further to go still needs to end up somewhere rather than freeze.
  _repick(e) {
    e.wanderTimer = PANIC_PATIENCE * (0.6 + Math.random() * 0.8);
    e.stuck = 0;
    e.field ??= this.nav.makeField();

    const spots = this.corridors;
    const fromPlayer = e.flee > 0
      ? Math.hypot(this.playerX - e.x, this.playerZ - e.z)
      : 0;

    for (let attempt = 0; attempt < 12; attempt++) {
      let x, z;
      if (spots?.length && attempt < 8) {
        const s = spots[(Math.random() * spots.length) | 0];
        x = s.x; z = s.z;
      } else {
        const angle = Math.random() * Math.PI * 2;
        const reach = 4 + Math.random() * 12;
        x = e.x + Math.cos(angle) * reach;
        z = e.z + Math.sin(angle) * reach;
      }

      const away = Math.hypot(x - e.x, z - e.z);
      if (away < 4 || away > PANIC_HOP) continue;
      if (!this.nav.clear(x, z, RADIUS)) continue;
      if (e.flee > 0 && attempt < 10 &&
          Math.hypot(this.playerX - x, this.playerZ - z) < fromPlayer + FLEE_AWAY) continue;

      // Flooded from the destination, so descending it walks him there. If he is
      // not on the resulting field there is no route and the pick is wasted.
      if (!this.nav.floodTo(e.field, x, z)) continue;
      if (!this.nav.descendOn(e.field, e.x, e.z, this._v)) continue;

      e.wanderX = x;
      e.wanderZ = z;
      return;
    }

    // Nowhere to go this time; stand and shout, and try again shortly.
    e.wanderX = e.x;
    e.wanderZ = e.z;
    e.wanderTimer = 0.6;
  }

  // Idle staff grumble to themselves now and then, which is what tells you a
  // room is occupied before you can see into it.
  _mutter(e, dt, audio) {
    e.voiceTimer -= dt;
    if (e.voiceTimer > 0) return;
    e.voiceTimer = 7 + Math.random() * 11;
    if (e.state === 'idle') audio.enemyIdle(e);
  }

  _think(e, dt, dist, sees, hears, ctx) {
    e.timer -= dt;

    switch (e.state) {
      case 'idle':
        // Noticed by sight, or by the racket you make shooting.
        if (sees || hears) {
          e.state = 'alert';
          e.timer = this.tuning.reaction;
          e.lastSeen = { x: ctx.player.object.position.x, z: ctx.player.object.position.z };
          // Whoever spots you first does the shouting. The rest of the room has
          // heard him and does not need to say it again.
          if (this.shoutTimer <= 0) {
            this.shoutTimer = SHOUT_GAP;
            ctx.audio.enemyAlert(e);
          }
        }
        break;

      case 'alert':
        if (e.timer <= 0) e.state = 'chase';
        break;

      case 'chase':
        if (sees && dist < e.type.range) e.state = 'fight';
        else if (e.contact > GIVE_UP) { e.state = 'idle'; e.lastSeen = null; }
        break;

      case 'fight':
        if (!sees || dist > e.type.range + 3) { e.state = 'chase'; }
        break;
    }
  }

  /**
   * Walk. The route comes off the shared distance field; everything here is
   * about the last metre of it, which is where a floor full of people actually
   * comes unstuck — in a doorway, behind each other.
   *
   * A doorway is 1.5 m and a body is 0.72 m across, so two of them fit through
   * it side by side with nothing to spare. That is the geometry that has to be
   * survived, and three things here do it: they stop shoving each other in tight
   * spots, they stop circling in them, and when they do get wedged they sidestep
   * along the wall instead of standing there pushing into it.
   */
  _move(e, dt, dx, dz, dist, sees) {
    const speed = this.tuning.speed * e.type.speed;
    // "Tight" is anywhere a body and a half does not fit: a doorway, the gap
    // between two desks, the corner of a stairwell.
    const tight = !this.nav.clear(e.x, e.z, RADIUS * 1.7);
    let vx = 0, vz = 0;

    if (e.state === 'chase' && e.lastSeen) {
      const dir = this.nav.descend(e.x, e.z, this._v);
      if (dir) { vx = dir.x * speed; vz = dir.z * speed; }
      else if (dist > 1.2) { vx = (dx / dist) * speed * 0.5; vz = (dz / dist) * speed * 0.5; }
    } else if (e.state === 'fight') {
      // Hold a firing distance and sidestep, so a firefight isn't two statues.
      // Melee types have no standoff to hold — they just keep coming.
      const nx = dx / dist, nz = dz / dist;
      let advance = 0;
      if (e.type.melee) advance = dist > 1.1 ? 1 : 0;
      else if (dist > PREFERRED + 1.5) advance = 1;
      else if (dist < TOO_CLOSE) advance = -1;

      vx = nx * advance * speed;
      vz = nz * advance * speed;
      // Circling is for open floor. In a doorway it is just grinding along the
      // jamb, and with a queue behind you it is what turns a doorway into a plug.
      const circle = tight ? 0 : (e.type.melee ? 0.15 : 0.45);
      vx += -nz * e.strafe * speed * circle;
      vz += nx * e.strafe * speed * circle;
    }

    // Decaying shove from being shot.
    vx += e.knockX;
    vz += e.knockZ;
    e.knockX *= Math.max(0, 1 - dt * 6);
    e.knockZ *= Math.max(0, 1 - dt * 6);

    if (vx || vz) {
      const blockedX = !this._tryMove(e, vx * dt, 0);
      const blockedZ = !this._tryMove(e, 0, vz * dt);

      if (blockedX && blockedZ) {
        // Nose-first into something. Axis-splitting already handles a wall you
        // hit at an angle; what is left is walking straight at one, which is
        // what a doorway you are half a metre to the side of looks like. So
        // sidestep — one way, then the other — and let the field take over
        // again as soon as anything opens up.
        e.stuck += dt;
        const len = Math.hypot(vx, vz) || 1;
        const px = -vz / len, pz = vx / len;
        const step = speed * dt;
        if (!this._tryMove(e, px * e.strafe * step, pz * e.strafe * step)) {
          e.strafe *= -1;
          this._tryMove(e, px * e.strafe * step, pz * e.strafe * step);
        }
      } else {
        e.stuck = 0;
        // Bounced off a wall while circling? Circle the other way instead of
        // grinding along it.
        if ((blockedX || blockedZ) && e.state === 'fight') e.strafe *= -1;
      }
    }

    // Not in a doorway. Two bodies that barely fit through one will push each
    // other into the jamb and both stop, and everyone behind them stops too —
    // so in tight spots they queue instead of jostling.
    if (!tight) this._separate(e, dt);

    e.group.position.x = e.x;
    e.group.position.z = e.z;

    // Face the player when engaged, otherwise face where you're walking.
    const wantYaw = (e.state === 'fight' || e.state === 'alert' || sees)
      ? Math.atan2(-dx, -dz)
      : (vx || vz) ? Math.atan2(-vx, -vz) : e.yaw;
    e.yaw = angleLerp(e.yaw, wantYaw, 1 - Math.exp(-9 * dt));
    e.group.rotation.y = e.yaw;
  }

  _tryMove(e, dx, dz) {
    const nx = e.x + dx;
    const nz = e.z + dz;
    if (!this.nav.clear(nx, nz, RADIUS)) return false;
    e.x = nx;
    e.z = nz;
    return true;
  }

  // Keep bodies from occupying the same tile — cheap O(n^2), but n is small.
  _separate(e, dt) {
    for (const other of this.items) {
      if (other === e || !other.alive) continue;
      const dx = e.x - other.x;
      const dz = e.z - other.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0.64 || d2 < 1e-6) continue;

      const d = Math.sqrt(d2);
      const push = (0.8 - d) * dt * 4;
      this._tryMove(e, (dx / d) * push, (dz / d) * push);
    }
  }

  _shoot(e, dt, dist, sees, px, py, pz, player, effects, audio, hud) {
    e.fireCooldown -= dt;

    // A swing already in flight connects part-way through, and only if you're
    // still inside the weapon's reach when it comes down.
    if (e.swing > 0 && !e.swingLanded && e.swing <= SWING_TIME * 0.45) {
      e.swingLanded = true;
      if (dist < e.type.range + e.bluntReach) {
        const damage = this.tuning.damage * e.type.damage;
        player.takeDamage(damage);
        hud.damage(Math.min(1, damage / 22), e.x, e.z);
        audio.meleeHit();
      }
    }

    if (e.state !== 'fight' || !sees || dist > e.type.range) return;
    if (e.fireCooldown > 0) return;

    const type = e.type;
    e.fireCooldown = this.tuning.fireInterval * type.rate * (0.75 + Math.random() * 0.5);

    // Melee types don't shoot: they swing, and the hit lands mid-swing rather
    // than on the wind-up, so you get a moment to back out of reach.
    if (type.melee) {
      e.swing = SWING_TIME;
      e.swingLanded = false;
      audio.enemyMeleeSwing(e);
      return;
    }

    // Muzzle in world space, from the gun the model is actually holding.
    e.gun.getWorldPosition(this._muzzle);

    // Sample the spread as a real angle, then turn it into a miss distance at
    // the player's range: distance genuinely protects you.
    const angle = this.tuning.spread * type.spread * Math.sqrt(Math.random());
    const miss = Math.tan(angle) * dist;
    const hit = miss < 0.5;

    const spin = Math.random() * Math.PI * 2;
    this._aim.set(
      px + Math.cos(spin) * miss,
      py - 0.1 + (Math.random() - 0.5) * 0.2,
      pz + Math.sin(spin) * miss
    );
    if (hit) this._aim.set(px, py - 0.15, pz);

    effects.tracer(this._muzzle, this._aim);
    // Bigger types carry bigger guns, and a flash you can size up across a room
    // is half of knowing what is shooting at you.
    effects.muzzle(this._muzzle, type.scale);
    // Heavier types fire lower, so you can hear what's shooting you.
    audio.enemyShot(e);

    if (hit) {
      const damage = this.tuning.damage * type.damage;
      player.takeDamage(damage);
      hud.damage(Math.min(1, damage / 25), e.x, e.z);
    }
  }

  _animate(e, dt, audio) {
    if (e.rig === 'rat') return this._animateRat(e, dt, audio);
    if (e.rig === 'roomba') return this._animateRoomba(e, dt, audio);

    // Sitting is a state of the body, not of the AI: the moment they stop being
    // idle they are standing up, and from then on they animate like anybody
    // else. Which means nothing downstream — pathing, swinging, ragdolling —
    // ever has to know this was a thing.
    if (e.seated && e.state !== 'idle') {
      e.seated = false;
      // Everything else the seated pose touched is written every frame by the
      // walk cycle below and recovers on its own; the torso lean is not, so it
      // is the one thing that has to be put back by hand.
      e.torso.rotation.x = 0;
    }
    if (e.seated) return this._animateSeated(e, dt);

    const moving = e.state === 'chase' || e.state === 'fight' || e.state === 'wander';
    e.walkPhase += dt * (moving ? 9 : 1.4);

    // One footfall per half stride cycle, taken off the leg animation itself so
    // the sound lands with the foot rather than on a timer of its own.
    const stride = Math.floor(e.walkPhase / Math.PI);
    if (stride !== e.lastStep) {
      e.lastStep = stride;
      if (moving) audio.enemyStep(e);
    }

    const swing = moving ? Math.sin(e.walkPhase) * 0.6 : Math.sin(e.walkPhase) * 0.05;
    e.legL.rotation.x = swing;
    e.legR.rotation.x = -swing;
    e.group.position.y = moving ? Math.abs(Math.sin(e.walkPhase)) * 0.045 : 0;

    // Weapon comes up as soon as they mean it. Melee types instead throw both
    // arms forward on the swing and drop them again.
    const aiming = e.state === 'fight';
    if (e.swing > 0) e.swing -= dt;

    if (e.type.melee) {
      // Wind up behind the head, then bring it down hard. The weapon rides the
      // right arm so the two read as one motion.
      const winding = e.swing > SWING_TIME * 0.55;
      const arm = e.swing > 0 ? (winding ? 1.5 : -2.4) : (aiming ? -0.9 : -swing * 0.5);
      const k = 1 - Math.exp(-(e.swing > 0 ? 24 : 9) * dt);
      e.armL.rotation.x = lerp(e.armL.rotation.x, arm * 0.6, k);
      e.armR.rotation.x = lerp(e.armR.rotation.x, arm, k);
      if (e.blunt) {
        // Held out in front while it is being used, and carried the way its own
        // kind is carried the rest of the time — which for a mop is dragging,
        // head on the floor. See BLUNT in rigs.js.
        const want = e.swing > 0 || aiming ? arm + 0.5 : e.bluntRest;
        e.blunt.rotation.x = lerp(e.blunt.rotation.x, want, k);
        e.blunt.position.y = 1.12 + Math.sin(e.walkPhase) * 0.02;
      }
    } else {
      const armX = aiming ? -1.45 : swing * -0.5;
      e.armL.rotation.x = lerp(e.armL.rotation.x, aiming ? -1.2 : -swing * 0.5, 1 - Math.exp(-10 * dt));
      e.armR.rotation.x = lerp(e.armR.rotation.x, armX, 1 - Math.exp(-10 * dt));
      e.gun.position.set(0.3, aiming ? 1.32 : 1.1, aiming ? -0.55 : -0.3);
      e.gun.rotation.x = aiming ? 0 : 0.5;
    }

    if (e.hitFlash > 0) {
      e.hitFlash -= dt;
      const k = Math.max(0, e.hitFlash / HIT_FLASH);
      for (const m of e.flash) m.emissive.setScalar(k * 0.9);
    }
  }

  /**
   * On the floor with their legs out in front of them, mop across the knees.
   *
   * Done by dropping the whole rig and folding the legs forward rather than by
   * authoring a second skeleton: the hip joint is already at the top of the leg
   * (see rigs.js), so rotating there is genuinely what sitting down does, and the
   * bones ragdolls.js reads are the ones it was always going to read.
   *
   * The lean is a slow breath rather than a pose held rigid — two men waiting out
   * a shift should not read as two mannequins somebody left in a cupboard.
   */
  _animateSeated(e, dt) {
    e.walkPhase += dt * 0.9;
    const breath = Math.sin(e.walkPhase) * 0.03;

    e.group.position.y = -SIT_DROP;
    e.legL.rotation.x = SIT_LEGS;
    e.legR.rotation.x = SIT_LEGS - 0.12;
    e.armL.rotation.x = -0.35 + breath;
    e.armR.rotation.x = -0.5 + breath;
    e.torso.rotation.x = 0.12 + breath;
    if (e.blunt) {
      // Mop across the lap, handle out, which is where you put it when you are
      // not using it and is also why it is the first thing back in his hands.
      e.blunt.rotation.x = -1.35;
      e.blunt.position.y = 0.82;
    }

    if (e.hitFlash > 0) {
      e.hitFlash -= dt;
      const k = Math.max(0, e.hitFlash / HIT_FLASH);
      for (const m of e.flash) m.emissive.setScalar(k * 0.9);
    }
  }

  /**
   * Four legs, a nose and a tail. The legs run at four times a person's cadence
   * because the stride is a tenth as long, and the tail is driven one segment
   * behind the next so a single sine wave at the root travels down it.
   *
   * When it stops it does not stand still: the nose keeps working. That twitch
   * is the difference between a rat that has paused and a prop that has frozen.
   */
  _animateRat(e, dt, audio) {
    const moving = e.moving !== false && e.darting !== false;
    e.walkPhase += dt * (moving ? 34 : 3);

    const stride = Math.floor(e.walkPhase / Math.PI);
    if (stride !== e.lastStep) {
      e.lastStep = stride;
      // Every fourth footfall: at this cadence one clip per step is a machine
      // gun of tiny claws.
      if (moving && (stride & 3) === 0) audio.enemyStep(e);
    }

    const gait = Math.sin(e.walkPhase);
    if (e.legs) {
      const swing = moving ? gait * 0.9 : 0;
      e.legs[0].rotation.x = swing;
      e.legs[1].rotation.x = -swing;
      e.legs[2].rotation.x = -swing;
      e.legs[3].rotation.x = swing;
    }

    // Body bobs with the gait; nose dips and lifts when it has stopped to think.
    e.group.position.y = moving ? Math.abs(gait) * 0.018 : 0;
    e.head.rotation.x = moving ? gait * 0.08 : Math.sin(e.walkPhase * 2.2) * 0.16;

    if (e.tail) {
      let link = e.tail;
      for (let i = 0; i < 3 && link; i++) {
        link.rotation.y = Math.sin(e.walkPhase * 0.7 - i * 0.9) * (moving ? 0.34 : 0.12);
        if (i === 0) link.rotation.x = -0.5;   // carried clear of the floor
        link = link.children.find((c) => c.isGroup);
      }
    }

    if (e.hitFlash > 0) {
      e.hitFlash -= dt;
      const k = Math.max(0, e.hitFlash / HIT_FLASH);
      for (const m of e.flash) m.emissive.setScalar(k * 0.9);
    }
  }

  /**
   * The floor cleaner: a brush that turns, a status light, and a motor you can
   * hear from the next room. There is no gait to animate — it slides, because
   * that is what it does.
   *
   * The motor is a positional loop rather than a repeated clip: this thing runs
   * continuously for as long as the floor lasts, and a one-shot retriggered
   * forever would chop on every seam.
   */
  _animateRoomba(e, dt, audio) {
    if (e.brush) e.brush.rotation.y += dt * 9;

    if (!e.motor) e.motor = audio.startMotor(e);
    else audio.moveMotor(e.motor, e.x, 0.1, e.z);

    if (e.hitFlash > 0) {
      e.hitFlash -= dt;
      const k = Math.max(0, e.hitFlash / HIT_FLASH);
      for (const m of e.flash) m.emissive.setScalar(k * 0.9);
    }
  }

  // Topple forward, then sink through the floor and disappear.
  //
  // This is now the fallback rather than the usual case — a body that got a
  // ragdoll is ragdolls.js's from the moment it stopped breathing, and touching
  // its group here would fight the solver for it. It stays because a ragdoll is
  // allowed to be refused, and a floor with no physics has to keep working.
  _die(e, dt) {
    if (e.ragdoll) return;
    if (e.deathTime <= 0) return;
    e.deathTime -= dt;

    const k = 1 - e.deathTime / DEATH_TIME;
    e.group.rotation.x = Math.min(Math.PI / 2, k * 4);
    e.mats.visor.color.setRGB(0.25 * (1 - k), 0.05, 0.04);

    if (k > 0.75) {
      const sink = (k - 0.75) / 0.25;
      e.group.position.y = -sink * 1.2;
    }
    if (e.deathTime <= 0) e.group.visible = false;
  }

  // Called on every new floor. Materials are per-enemy (so a hit flash on one
  // doesn't light up the floor) and weapon geometry is per-enemy, so both have
  // to be released here or a long run bleeds GPU memory one floor at a time.
  clear() {
    for (const e of this.items) {
      // A running motor outlives its floor otherwise: the loop is held by the
      // audio engine, not by the scene graph, so removing the mesh leaves it
      // droning over the next floor from wherever this one used to be.
      if (e.motor) { this.audio?.stopMotor(e.motor); e.motor = null; }
      this.scene.remove(e.group);
      for (const m of Object.values(e.mats)) m.dispose();
      for (const g of e.ownGeo) g.dispose();
    }
    this.items.length = 0;
    this.meshes.length = 0;
  }

  dispose() { this.clear(); }
}

// Weighted pick from the types unlocked at this depth. Early floors are all
// analysts and interns; the nastier staff join as you descend, and because
// weights are relative the mix keeps shifting rather than simply adding.
// Corridor waypoints for the panicking staffer. Sampled rather than exhaustive:
// he only needs somewhere to be running to, and a floor holds thousands of
// corridor tiles.
function collectCorridors(layout, nav) {
  const spots = [];
  const { W, H, tiles } = layout;
  let n = 0;
  for (let ty = 1; ty < H - 1; ty++) {
    for (let tx = 1; tx < W - 1; tx++) {
      if (tiles[ty * W + tx] !== CORRIDOR) continue;
      if (n++ % CORRIDOR_SAMPLE) continue;
      const x = worldX(layout, tx + 0.5);
      const z = worldZ(layout, ty + 0.5);
      if (nav.clear(x, z, RADIUS)) spots.push({ x, z });
    }
  }
  return spots;
}

function pickType(floorNumber, rng, theme) {
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
function pickTheme(floorNumber, rng) {
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

const lerp = (a, b, t) => a + (b - a) * t;

function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
