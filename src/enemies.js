import * as THREE from 'three';
import { BODY_RADIUS as RADIUS } from './nav.js';
import { CORRIDOR, worldX, worldZ } from './gen/layout.js';
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
const DEATH_TIME = 2.2;
const HIT_FLASH = 0.1;
const SWING_TIME = 0.5;    // wind-up plus follow-through on a melee swing

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
    name: 'Security', hp: 1.7, speed: 0.98, damage: 1.5, rate: 1.15, spread: 2.1,
    range: 9, melee: false, scale: 1.07,
    suit: 0x272c33, shirt: 0xffc93a, visor: 0x7d7973, unlockFloor: 4, weight: 3,
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
const THEMES = [
  { name: 'Business as usual', weight: 4, light: 1, boost: {} },
  { name: 'Infestation', weight: 3, light: 0.34, boost: { reanimated: 7, intern: 2 } },
  { name: 'Automated', weight: 3, light: 0.9, boost: { sentry: 7, sysadmin: 3 } },
  { name: 'Lockdown', weight: 2, light: 0.75, boost: { security: 6, manager: 4 } },
  { name: 'Night shift', weight: 2, light: 0.5, boost: { reanimated: 4, sentry: 4, facilities: 3 } },
  { name: 'All-hands', weight: 2, light: 1, boost: { analyst: 6, intern: 5, manager: 3 } },
];

export class Enemies {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.meshes = [];       // what bullets test against
    this.time = 0;
    this.shoutTimer = 0;    // floor-wide, so only one of them calls you out
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

  // Populates a floor. `tuning` scales with depth — see game.js.
  spawn(layout, nav, rng, tuning) {
    this.clear();
    this.nav = nav;
    this.tuning = tuning;
    this.shoutTimer = 0;
    this.theme = pickTheme(layout.floorNumber, rng);
    this.corridors = collectCorridors(layout, nav);

    const spots = this._spawnPoints(layout, nav, rng, tuning.count);
    for (const spot of spots) {
      this._add(spot.x, spot.z, rng, tuning, pickType(layout.floorNumber, rng, this.theme));
    }

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
    for (const spot of this._loose(layout, nav, rng, rng.int(3, 6))) {
      this._add(spot.x, spot.z, rng, tuning, TYPES.rat);
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

  // Walkable tiles well away from where the player arrives, spread over as many
  // different rooms as possible so a floor is never one big ambush.
  _spawnPoints(layout, nav, rng, count) {
    const spots = [];
    const rooms = rng.shuffle(layout.rooms.filter((r) => r.role !== 'lobby'));
    if (!rooms.length) return spots;

    const minDist = 14;
    for (let pass = 0; spots.length < count && pass < 8; pass++) {
      for (const room of rooms) {
        if (spots.length >= count) break;
        for (let tries = 0; tries < 12; tries++) {
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

          spots.push({ x, z });
          break;
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
      blunt, bluntReach: rig.bluntReach,
      // Rat parts. Null on everything else, and the animation branches on the
      // rig rather than on the type, so a second four-legged thing costs a rig
      // and nothing else.
      rig: rig.rig, legs: rig.legs ?? null, tail: rig.tail ?? null,
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
      // Vermin only: bolt, stop, bolt again.
      darting: true, dartTimer: rng.range(0.2, 1), moving: true,
      // Where a neutral is currently headed — the toilet, the next corridor to
      // mop — plus their own distance field to get there. See _repick.
      wanderX: 0, wanderZ: 0, wanderTimer: 0, field: null, stuck: 0,
    };

    if (type.neutral) {
      enemy.state = 'wander';
      enemy.voiceTimer = type.panic ? rng.range(0.2, 2.5) : rng.range(3, 14);
    }

    // Only the torso and head stop bullets; hitboxes on limbs this narrow
    // would make hit detection feel arbitrary.
    torso.userData.enemy = enemy;
    head.userData.enemy = enemy;
    head.userData.headshot = 2.2;
    torso.userData.isEnemyPart = true;
    head.userData.isEnemyPart = true;

    this.scene.add(group);
    this.items.push(enemy);
    this.meshes.push(torso, head);
    return enemy;
  }

  // A bullet landed. Returns 'kill' | 'hit' | null (already down).
  hit(mesh, damage) {
    const e = mesh.userData?.enemy;
    if (!e || !e.alive) return null;
    return this._damage(e, damage * (mesh.userData.headshot ?? 1));
  }

  // Damage from any source, once it is known who took it and how much.
  _damage(e, damage) {
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
    e.torso.userData.enemy = null;
    e.head.userData.enemy = null;
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

      const outcome = this._damage(e, damage * (1 - dist / radius));
      if (outcome === 'kill') { kills++; audio?.enemyDeath(e); }
      else if (outcome === 'hit') audio?.enemyPain(e);
    }
    return kills;
  }

  update(dt, ctx) {
    this.time += dt;
    const { player, effects, audio, hud } = ctx;
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
    // Wedged against something the grid thinks is passable. One more plan.
    if (!movedX && !movedZ) {
      e.stuck += dt;
      if (e.stuck > 0.4) this._repick(e);
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

  _move(e, dt, dx, dz, dist, sees) {
    const speed = this.tuning.speed * e.type.speed;
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
      const circle = e.type.melee ? 0.15 : 0.45;
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
      // Bounced off a wall while circling? Circle the other way instead of
      // grinding along it.
      if ((blockedX || blockedZ) && e.state === 'fight') e.strafe *= -1;
    }

    this._separate(e, dt);

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
        hud.damage(Math.min(1, damage / 22));
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
      hud.damage(Math.min(1, damage / 25));
    }
  }

  _animate(e, dt, audio) {
    if (e.rig === 'rat') return this._animateRat(e, dt, audio);

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
        e.blunt.rotation.x = lerp(e.blunt.rotation.x, arm + 0.5, k);
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
      e.mats.suit.emissive.setScalar(k * 0.9);
      e.mats.skin.emissive.setScalar(k * 0.9);
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
      e.mats.suit.emissive.setScalar(k * 0.9);
      e.mats.skin.emissive.setScalar(k * 0.9);
    }
  }

  // Topple forward, then sink through the floor and disappear.
  _die(e, dt) {
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
