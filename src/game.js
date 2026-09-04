import { Level, distanceToExit } from './level.js';
import { makeRng, randomSeed } from './gen/rng.js';
import { CARDS } from './keycards.js';
import { pickTheme } from './enemy-types.js';

// The run: generate a floor, clear it, take the exit down, repeat forever.
//
// Nothing here is authored per level — difficulty is a handful of curves over
// the floor number, and the floor itself comes out of the generator. That is
// the whole point of the design: the game can keep going as long as you can.
//
// Things being shot apart lives in destruction.js, not here: this file owns the
// shape of a run, and that owns the shape of the furniture.

const EXIT_RADIUS = 1.6;       // how close you must get to the pad to descend
const HEAL_ON_DESCEND = 25;
const PUSH_IMPULSE = 110;      // N·s per second of contact, walking into props

// Vitals audio: the two sounds that report on the player rather than the world.
const LOW_HEALTH = 0.35;       // fraction of max below which the pulse starts
const PULSE_SLOW = 1.35;       // seconds between beats at the threshold...
const PULSE_FAST = 0.55;       // ...and at nearly dead
const BREATH_INTERVAL = 1.4;
const BREATH_SPEED = 4;        // moving at least this fast to be out of breath

// Leaning on a desk reports a collision every frame, so without this a single
// shove would be a hundred scrapes a second. The audio engine plays everything
// it is asked to, by design — so deciding that continuous contact is one shove
// has to happen here, where the collision is actually understood.
const SHOVE_INTERVAL = 0.4;

// How close a body has to get to a cardboard box before it goes flat under them.
//
// A body is 0.4 m of radius and a carton about 0.2, so this is the two of them
// touching plus a little: what it must NOT be is generous, or a box is flattened
// by somebody who walked past it. The staff have no idea the box is there — it is
// not on the nav grid, because it is loose — so a body walks straight through
// where it stood, and this is what makes that read as flattening it rather than
// as clipping through it.
const CRUSH_REACH = 0.62;
// ...and how many boxes are tested per frame.
//
// A floor carries about 200 crushable props and each test walks the 25 bucket
// cells that could hold a body near it, so testing all of them every frame is
// five thousand lookups for an event that happens a few times a minute. A
// round-robin over the list covers the whole floor in four frames, which is 70 ms
// — less than the time a body takes to cross the box it is flattening, and the
// same trick `snapshot` in enemies.js uses on the same reasoning.
const CRUSH_SLICE = 48;

// How often an intact water cooler burbles to itself, and how far away one has to
// be to bother. A cooler that is not doing anything is still a bottle of water
// with air getting into it, and one glug every ten seconds or so from the corner
// of a breakroom is the kind of noise that makes a floor sound occupied. Rolled
// against the nearest one rather than all of them: a floor can carry twenty-odd
// and hearing them all is a pond.
const COOLER_GLUG = [7, 15];   // seconds between burbles
const COOLER_RANGE = 9;        // metres — the room you are standing in

// The cow (see placeCow in gen/build.js), on the rare floor that has one: how
// long between one moo and the next, randomised so it doesn't read as a loop.
const MOO_INTERVAL = [7, 16];

// The generator (see gen/props.js), on the floor that has one.
//
// `POWER_CUT_POWER` is what the building supplies once the machine is dead: a
// quarter of normal, everywhere. It goes through `lighting.setPower` rather
// than `setMood` and that is the whole point of there being two — a mood is a
// statement about the floor (how much of it is lit, how bright the fill
// between the fixtures is) and deliberately leaves the tubes near full, so
// spending it here left a floor whose ceiling was still blazing while the
// rooms went dark. The supply dims the tubes, their pools and the fill
// together, which is what "quarter power" actually looks like.
//
// The blast is deliberately smaller than the extinguisher's
// (BLAST_RADIUS/BLAST_DAMAGE in extinguishers.js) — this is a consequence of a
// fight, not a weapon.
const POWER_CUT_POWER = 0.25;
const BLACKOUT_PANEL_FRACTION = 0.35;
const POWER_CUT_BLAST_RADIUS = 5;
const POWER_CUT_BLAST_DAMAGE = 45;
const POWER_CUT_BLAST_PUSH = 6;

export class Game {
  /**
   * Every collaborator is required. main.js is the only thing that constructs a
   * Game and it supplies all of them, so there is no `?.` on any of them below —
   * this file used to guard the same field three different ways in three
   * different places (`this.wallet.onChange` unguarded, `this.wallet?.clear()`
   * guarded), which reads as "this might be absent" while being provably false
   * and hides the one dependency that genuinely is conditional.
   *
   * `physics` is the exception and stays guarded, because the solver really can
   * be absent and the game is meant to keep running without it.
   */
  constructor({ scene, camera, player, weapons, shooting, enemies, effects, audio, hud, minimap, lighting, physics, destruction, extinguishers, spills, doors, casings, keycards, wallet, ragdolls, cameras, conveyors, jobs, chores, panels, washers }) {
    this.player = player;
    this.weapons = weapons;
    this.shooting = shooting;
    this.enemies = enemies;
    this.effects = effects;
    this.audio = audio;
    this.hud = hud;
    this.minimap = minimap;
    this.lighting = lighting;
    this.physics = physics;
    this.destruction = destruction;
    this.extinguishers = extinguishers;
    this.spills = spills ?? null;
    this.doors = doors;
    this.casings = casings;
    this.keycards = keycards;
    this.wallet = wallet;
    this.ragdolls = ragdolls;
    this.cameras = cameras;
    this.conveyors = conveyors;
    this.jobs = jobs;
    this.chores = chores;
    this.panels = panels;
    this.washers = washers;

    // Co-op. Wired after construction by main.js, because NetPlay needs a Game
    // and a Game would then need a NetPlay — and it is the third genuinely
    // optional collaborator alongside `physics`: the dev harnesses build a Game
    // with no wire at all, and `?.` here means an absent one is a single-player
    // run rather than a crash. A PRESENT one is not a session: it answers
    // `online` false until somebody actually connects.
    this.netplay = null;

    this.level = new Level(scene);
    // Player-facing colliders for this floor's loose props, refreshed from the
    // physics bodies every frame.
    this.pushColliders = [];

    this.floor = 0;
    this.kills = 0;
    this.floorsCleared = 0;
    this.time = 0;
    this.state = 'playing';     // 'playing' | 'dead'
    this.cleared = false;
    this.descendLock = 0;
    // Set on the floor where the manager's card lands. Declared here with the
    // rest of the run state; it used to be created on first write, so its first
    // read every floor was `undefined` and only worked by being falsy.
    this.droppedBlack = false;

    this.player.onDeath = () => this._onDeath();
    this.shooting.onKill = () => { this.kills++; };

    // Walking into loose furniture shoves it. Scaled by frame time so the
    // impulse doesn't depend on frame rate.
    this.player.onPush = (collider, dx, dz) => {
      this.physics?.impulse(
        collider.push.handle,
        { x: dx, y: 0, z: dz },
        PUSH_IMPULSE * this.player.dt,
        { x: this.player.object.position.x, y: 0.45, z: this.player.object.position.z }
      );
      if (this.shoveTimer <= 0) {
        this.shoveTimer = SHOVE_INTERVAL;
        this.audio.propShove(collider.push.group.position);
      }
    };

    this.player.onStep = (sprinting) => this.audio.step(sprinting);
    this.player.onLand = (impact) => this.audio.land(impact);
    this.player.onHurt = (amount) => this.audio.playerHurt(amount);
    this.player.onJump = () => this.audio.jump();
    this.player.onRegen = () => this.audio.heal();

    this.pulseTimer = 0;
    this.breathTimer = 0;
    this.shoveTimer = 0;
    this.coolerTimer = COOLER_GLUG[0];
    this.cow = null;
    this.mooTimer = 0;

    this.shooting.onPropHit = (dyn, dir, point, damage) =>
      this.destruction.damageProp(dyn, dir, point, damage);
    this.shooting.onSurfaceHit = (hit, dir, damage) =>
      this.destruction.damageSurface(hit, dir, damage);

    this.enemies.onDeath = (e) => this._onEnemyDeath(e);
    this.doors.onRefused = (door) => this._onDoorRefused(door);
    this.wallet.onChange = (wallet, tier) => this._onCardTaken(wallet, tier);
    this.destruction.onPowerCut = (entry, point) => this._onPowerCut(point);

    this.cameras.onSpotted = (cam) => this.audio.cameraSpotted(cam.at);
    this.cameras.onAlarm = () => this._onAlarm();
    this.shooting.onCameraHit = (cam, damage, point, normal) =>
      this.cameras.damage(cam, damage, point, normal);
    // A parcel on a belt, which is the only thing on a conveyor a round can
    // take off it — the line itself is building services, like the ceiling.
    this.shooting.onParcelHit = (parcel, point) => this.conveyors.hit(parcel, point);
  }

  // --- building security --------------------------------------------------------

  /**
   * A camera watched you long enough, or you walked through a laser.
   *
   * Everything about WHO turns up is enemies.js's (see `alarm` there); this is
   * only what a floor does about it. Two of those things exist because the
   * response is people who were not on the floor when it was generated: bullets
   * have to be told about them, and the objective counter is now wrong by
   * however many arrived. The objective moves for a second reason as well — the
   * men in the security office stop being behind a lock the moment they open it
   * themselves, so they join the count of hostiles you can actually reach.
   */
  _onAlarm() {
    // In a co-op session the roster belongs to the host, and an alarm APPENDS to
    // it — so a joiner raising its own would leave the two browsers holding
    // rosters of different lengths, and every index after that landing on the
    // wrong person. It asks instead, and the host's response comes back as a
    // message. See `alarmFrom` in netplay.js.
    if (this.netplay?.alarmFrom(
      this.player.object.position.x, this.player.object.position.z)) return;

    const response = this.enemies.alarm(
      this.player.object.position.x, this.player.object.position.z);
    this.applyAlarm(response);
    this.netplay?.announceAlarm(response);
  }

  /** What a floor does about an alarm, whichever browser raised it. */
  applyAlarm(response) {
    this.shooting.addHittables(response.meshes);
    this.alarmSignal(response.spawned.length + response.roused + response.heard);
  }

  /**
   * The klaxon, the wash and the two lines — the part of an alarm that is about
   * being told rather than about who is coming.
   *
   * Separate from `applyAlarm` because a co-op joiner gets exactly this and not
   * the rest: the men were placed on the host and arrive as a list to rebuild,
   * but the noise and the red rim happen in both browsers.
   */
  alarmSignal(coming = 0) {
    this.audio.alarm();
    this.hud.alarm();
    // The building says it first, in the building's own words, because that is
    // what the klaxon and the red wash are already doing and the line should
    // sound like the same thing rather than like a status report.
    //
    // Then what it cost you, a beat later and as one number: the men sent up,
    // the ones coming out of the office, and everybody who heard it and is now
    // walking this way. Three separate counts is three things to read in the
    // half second before the first of them arrives, and only their sum changes
    // what the player does about it.
    this.hud.message('ALARM ALARM — INTRUDER', 1700,
      coming ? { text: `${coming} COMING FOR YOU`, ms: 2300 } : null);
    this._syncObjective();
  }

  /**
   * The generator's own kill (see `powerCore` in gen/props.js), fanned out the
   * same way an alarm is: `destruction.js` only knows that ONE flagged prop
   * died and hands the point back here, and this is what a floor actually does
   * about it. Two things sell "the power just died" rather than "the room got
   * a bit darker": the whole floor drops to quarter power — tubes, the pools
   * under them and the fill alike — and a real fraction of the floor's ceiling
   * panels break outright on top of that. The blast is a consequence of the
   * room you were just standing in coming apart, not a weapon — see the
   * constants above for how it compares to the extinguisher's.
   */
  _onPowerCut(point) {
    // The bang first, because it is the thing that happened and everything
    // below is a consequence of it.
    this.audio.generatorBlast(point);

    this.lighting.setPower(POWER_CUT_POWER);
    this.destruction.blackoutPanels(BLACKOUT_PANEL_FRACTION);

    this.physics?.blast(point, POWER_CUT_BLAST_RADIUS, POWER_CUT_BLAST_PUSH);
    this.destruction.blast(point, POWER_CUT_BLAST_RADIUS, POWER_CUT_BLAST_DAMAGE);
    this.enemies.splash(point.x, point.z, POWER_CUT_BLAST_RADIUS, POWER_CUT_BLAST_DAMAGE, this.audio);

    const dx = this.player.object.position.x - point.x;
    const dy = this.player.object.position.y - point.y;
    const dz = this.player.object.position.z - point.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < POWER_CUT_BLAST_RADIUS) {
      const damage = POWER_CUT_BLAST_DAMAGE * (1 - dist / POWER_CUT_BLAST_RADIUS);
      this.player.takeDamage(damage);
      this.hud.damage(Math.min(1, damage / 25), point.x, point.z);
    }

    this.hud.message('POWER FAILURE', 2200);
  }

  // --- keycards ---------------------------------------------------------------

  /**
   * Somebody went down. Whatever badge they were carrying lands where they did —
   * unless you already have one like it, which almost always you do.
   *
   * Every employee in the building carries a white card, and a floor holds up to
   * two hundred of them. Dropping all of those would bury the floor in pickups
   * that do nothing: after the first one, the two-hundredth white card is not a
   * reward, it is litter with a glow on it. So a card only becomes an object if
   * it would actually change what you can open — which also means the drop you
   * DO see is always worth walking over to.
   *
   * The black card is the exception to all of it, and it is the last beat of a
   * floor. It is not carried by anybody in particular: it is what the last
   * hostile you can REACH turns out to have been holding — the second-last on
   * the floor, because the manager is still sitting behind his own door and you
   * have not been able to get at him.
   *
   * So the order is fixed and cannot come out wrong. Clear the floor, find you
   * are one short, find the card on the last body, and go and open the one door
   * on the floor you have been walking past all this time.
   */
  _onEnemyDeath(e) {
    const at = e.group.position;
    // Not if you already hold one, and not if one is already lying somewhere
    // waiting for you — six grey cards on the carpet is not six times the
    // information, it is five red herrings.
    if (e.card && !this.wallet.has(e.card) && !this.keycards.pending(e.card)) {
      this.keycards.drop(e.card, at.x, 0, at.z);
    }

    if (e.neutral || this.droppedBlack) return;
    if (this.enemies.openHostileCount > 0) return;
    if (!this.level.current?.layout.locks?.some((l) => l.tier === 'black')) return;

    // Offset a little in case they were also carrying something, so two cards
    // never float inside each other.
    this.droppedBlack = true;
    this.keycards.drop('black', at.x + (e.card ? 0.55 : 0), 0, at.z);
    // Only worth saying if somebody is actually still in there. If the black
    // room ended up empty this was simply the last kill, and the pickup toast
    // says everything there is to say.
    if (this.enemies.hostileCount > 0) {
      this.hud.message('BLACK KEYCARD DROPPED — ONE LEFT, AND YOU KNOW WHERE', 2600);
    }
  }

  /**
   * A card went into the pocket, so the building rearranges itself around it.
   *
   * Every door that badge fits opens at once — reader green, opening handed back
   * to the nav grid — rather than one at a time as you walk up to each. With
   * white on two hundred doorways the alternative is a floor that stays sealed
   * to its own occupants until the player has personally visited every door on
   * it, which is not a lock, it is a fog of war made of drywall.
   */
  _onCardTaken(wallet, tier) {
    this.hud.setKeycards(wallet.list());
    if (!this.doors || !tier) return;

    const opened = this.doors.applyWallet(wallet);
    const nav = this.level.current?.nav;
    for (const door of opened) nav?.openTiles(door.navTiles);

    const name = (CARDS[tier]?.name ?? '').toUpperCase();
    this.hud.message(opened.length
      ? `${name} KEYCARD — ${opened.length} DOOR${opened.length === 1 ? '' : 'S'} OPEN`
      : `${name} KEYCARD`, 1800);
  }

  _onDoorRefused(door) {
    const spec = CARDS[door.lock];
    this.hud.message(`LOCKED — NEEDS A ${(spec?.name ?? '').toUpperCase()} KEYCARD`, 1400);
  }

  // Fresh run from floor 1. `seed`, when given, is the floor to build rather
  // than one rolled here — a co-op joiner takes the host's.
  start(seed = null) {
    this.floor = 0;
    this.kills = 0;
    this.floorsCleared = 0;
    this.state = 'playing';
    this.player.reset();
    this.hud.gameOver(false, {});
    this.nextFloor(seed);
  }

  /**
   * A fresh co-op run, on both machines.
   *
   * The host calls this with nothing, rolls floor 1 like any other run, and then
   * announces the seed it landed on; the joiner calls it with what arrived. That
   * asymmetry is the whole of how two browsers end up in one building — see
   * netplay.js, and note that the seed goes out AFTER the floor is built, because
   * a dev build rerolls it looking for a generator room and the number that
   * matters is the one that was actually used.
   */
  startCoop(seed = null) {
    this.start(seed);
    this.netplay?.announceFloor(this.floor, this.level.current.seed, true);
  }

  /** The host has moved the team to a floor. Joiner side. */
  goToFloor(floor, seed) {
    this.floor = floor - 1;
    this.nextFloor(seed);
  }

  /**
   * Take the exit. Host side in a co-op session, and either player standing on
   * the pad is what gets us here — see `requestDescend`.
   */
  descend() {
    this.player.heal(HEAL_ON_DESCEND);
    this.audio.descend();
    this.nextFloor();
    this.netplay?.announceFloor(this.floor, this.level.current.seed, false);
  }

  nextFloor(given = null) {
    this.floor++;
    const seed = given ?? randomSeed();

    const rng = makeRng(seed ^ 0x9e3779b9);

    // Debris and brass from the last floor have to go before its physics world
    // does — the handles they hold only mean anything inside that world.
    this.destruction.clear();
    this.extinguishers.clear();
    // Water is the floor's, the pool of patches is not — same split as debris.
    this.spills?.clear();
    this.casings.clear();
    // Cards do not travel between floors. A building where the card you found on
    // eight opens nine has exactly one locked door in it, on floor one.
    this.keycards.clear();
    this.wallet.clear();
    // Before the level is generated, because enemies.spawn disposes the
    // materials these corpses are still drawn with.
    this.ragdolls.clear();

    // The shift, rolled BEFORE the floor is built, because the building has to
    // know it: a theme that runs parcel lines on the walls has to say so before
    // the floor's colliders are handed to the solver and to the player, and one
    // that puts machines in the building has to say so before its break rooms
    // are furnished — a charging dock on a floor with nothing to charge is a
    // prop that raises a question the floor does not answer. It is still the
    // first draw off this floor's rng (that was enemies.spawn's first line, and
    // `generate` has a seeded stream of its own), so nothing after it moved.
    const theme = pickTheme(this.floor, rng);

    const level = this.level.generate(seed, this.floor, theme);
    // Fitted before the physics, because a run pushes its own collider onto the
    // level's list and both consumers are about to read it. It contributes no
    // nav tile and reserves no floor: a belt is above everything, which is what
    // makes putting geometry into a finished floor safe at all. See conveyors.js.
    this.conveyors.spawn(level.layout, rng, theme, level.colliders);
    // ...and the service openings, on the same terms and immediately after: a
    // panel is flat against the plaster, contributes no collider and no nav
    // tile, and so is as safe to cut into a finished floor as a belt is to hang
    // above one. It takes `nav` because the whole placement rests on proving a
    // body can stand in front of it. See panels.js.
    this.panels.spawn(level.layout, level.nav, rng, theme);

    this._initPhysics(level);
    this.destruction.setLevel(level);
    // Split rather than concatenated: the building holds still and gets indexed,
    // the loose furniture moves every frame and cannot be. See setColliders.
    this.player.setColliders(level.colliders, this.pushColliders);
    // The same two lists, for the one question the roster asks of them: is the
    // chair somebody is sitting on still there. Given rather than copied, so
    // both stay live as props are shot apart and shoved about — see
    // setColliders in enemies.js.
    this.enemies.setColliders(level.colliders, this.pushColliders);
    // ...and the slab it may not leave, which is the one containment guarantee
    // that does not depend on any of them resolving correctly. See _contain.
    this.player.setBounds(level.bounds);
    // The doors own colliders that are already in that list; all they do at
    // runtime is drop them below the floor when the panel is out of the way.
    this.doors.setDoors(level.doors, level.nav);
    // What an alarm response is allowed to walk through. The door list is asked
    // rather than the lock list, because the doors are what will actually open
    // for them — see badgeTiles there and setBadgeTiles in nav.js.
    level.nav.setBadgeTiles(this.doors.badgeTiles());
    // Facing out of the car, when there is a car. `-rot * PI/2` is the game's
    // one conversion from a quarter turn to a yaw — the same line _seat in
    // enemies.js uses to point a body at the desk its chair was placed against.
    const car = level.layout.lifts?.arrival;
    this.player.placeAt(level.spawn.x, level.spawn.z,
      car ? -car.facing * Math.PI / 2 : null);
    // You step out of the lift with your sidearm out and everything loaded. The
    // arrival is the one moment in a floor where the game gets to put you
    // straight, and both halves of that are about starting from a known place:
    // the pistol because it is the gun the floor is balanced around at the door,
    // and full magazines because the alternative is a floor that opens with a
    // reload you did not choose.
    this.weapons.select(0);
    this.shooting.refill();

    // The headcount is a density, not a number — floors of the same depth now
    // come out anywhere from two-thirds to half again the usual size, so the
    // curve is per typical floor and the slab that turned up scales it.
    this.enemies.spawn(level.layout, level.nav, rng,
      tuningFor(this.floor, level.layout.areaRatio), level.workstations, theme);
    // After the staff, because the cameras are watching the floor rather than
    // watching them — nothing about where one goes depends on who is standing
    // where, and taking the roster's dice first keeps enemy placement reading
    // off the same stream it always did.
    this.cameras.spawn(level.layout, level.nav, rng);

    // The parcel runs, and they go LAST of the three because they are the only
    // thing on the floor that needs two of the others to have finished: the
    // shelves come out of the station pool `enemies.spawn` just built, and the
    // belts out of the runs `conveyors.spawn` measured. It takes no dice of its
    // own — whose turn it is to carry a box is a runtime decision, like whose
    // turn it is at the lunch counter, so spending the floor's seeded stream on
    // it would move every roll after it. See jobs.js.
    this.jobs.spawn(level.nav, this.enemies, this.conveyors);
    // The ordinary work, last for the same reason and out of the same two
    // places: the machines come out of the station pools `enemies.spawn` just
    // built, and the wall openings out of the ones `panels.spawn` cut. It takes
    // no dice of its own either — whose turn it is at the copier is a runtime
    // decision, so spending the floor's seeded stream on it would move every
    // roll after it. See chores.js.
    this.chores.spawn(level.nav, this.enemies, this.panels);

    // The washing machines, adopted AFTER _initPhysics has given every loose
    // prop a body: the thrashing is impulses on `dyn.handle`, and a machine
    // adopted before there is one stands in the corridor in silence, which is
    // the one way this prop fails without erroring. See washers.js.
    // The theme as well as the floor, because whether a washing machine gets off
    // the ground is the theme's call (`washersFly`) — see washers.js. Read off
    // `enemies.theme` rather than the local, so a dev-pinned shift is honoured.
    this.washers.spawn(level, this.enemies.theme);

    // Bullets stop on this floor's geometry, this floor's occupants, and the
    // things on its walls looking at them.
    this.shooting.setHittables([
      ...level.meshes, ...this.enemies.meshes, ...this.cameras.meshes,
      ...this.conveyors.meshes, ...this.panels.meshes,
    ]);
    // Scorch marks are clipped to the building only — an enemy standing against
    // a wall is not part of that wall, however flush he is with it.
    this.effects.setSurfaces(level.meshes);

    // Sound has to know where this floor's walls and doorways are, or it comes
    // straight through the plaster.
    this.audio.setNav(level.nav);
    this.lighting.setFixtures(level.fixtures);
    // How much of this floor's lighting is still on. Read off the theme, which
    // enemies.spawn has already rolled by this point.
    this.lighting.setMood(this.enemies.theme?.light ?? 1);
    // ...and what colour it is lit in. Always set, never only when a theme asks
    // for one: the tubes' materials and the scene's fog are shared with the
    // floor that just ended, so a tint left standing is the next floor's too.
    this.lighting.setTint(this.enemies.theme?.tint ?? null);
    this.lighting.setOcclusion(level.nav.losClear.bind(level.nav));
    this.minimap.setLevel(level.map);

    this.cow = level.cow;
    this.mooTimer = this.cow ? randomMooDelay() : 0;

    this.cleared = false;
    this.droppedBlack = false;
    this.hud.setWatch(0);
    this.descendLock = 1.2;     // grace period so you can't fall straight through
    this.hud.setFloor(this.floor);
    this.hud.message(`FLOOR ${this.floor} — ${this.enemies.theme?.name ?? ''}`.trim(), 2200);
    this._syncObjective();
  }

  // Hands this floor's walls and furniture to the physics world, and turns each
  // loose prop into a body the player and bullets can shove.
  _initPhysics(level) {
    this.pushColliders = [];
    // The loose props a body walking over them flattens. See _crushBoxes.
    this.crushables = [];
    this._crushCursor = 0;
    if (!this.physics) return;

    this.physics.reset();
    this.physics.addStatics(level.colliders);

    for (const dyn of level.dynamics) {
      const handle = this.physics.addBox({
        size: dyn.size,
        position: dyn.position,
        mass: dyn.mass,
      });
      if (!handle) continue;
      dyn.handle = handle;

      // Bullets need to get from a hit mesh back to the body.
      for (const child of dyn.group.children) child.userData.dynamic = dyn;

      // A rotating box has no fixed AABB, so the player collides against a
      // square the width of the prop's longest horizontal side. Slightly
      // generous, but a chair you can't quite touch beats one you clip through.
      dyn.reach = Math.max(dyn.size.x, dyn.size.z) / 2;
      if (dyn.crushable) this.crushables.push(dyn);
      const collider = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0, push: dyn };
      dyn.collider = collider;
      this.pushColliders.push(collider);
      this._syncCollider(dyn);
    }
  }

  /**
   * The staff flattening the cardboard they walk over.
   *
   * Host-only in a co-op session for the same reason every other break is: the
   * message goes out through `onBreakProp` and the other end applies it, so two
   * browsers cannot disagree about which boxes are still standing. On a joiner
   * `enemies.anyNear` finds nobody anyway — the bucket grid it reads is only
   * rebuilt by the side running the AI.
   *
   * The list is the crushable props and not every loose prop: a floor carries a
   * few hundred of those and a room's worth of cardboard, and this runs every
   * frame. Entries are dropped as they break, so a floor gets quieter to check
   * the longer it has been fought over.
   */
  _crushBoxes() {
    const list = this.crushables;
    if (!list?.length) return;
    let checked = 0;
    while (checked < CRUSH_SLICE && list.length) {
      if (this._crushCursor >= list.length) this._crushCursor = 0;
      const i = this._crushCursor;
      const dyn = list[i];
      checked++;
      if (dyn.broken) { list.splice(i, 1); continue; }
      this._crushCursor++;
      const p = dyn.group.position;
      // Its own underside, so a box in an attic is only flattened by somebody
      // standing in the attic.
      const foot = p.y - dyn.size.y / 2;
      if (!this.enemies.anyNear(p.x, p.z, foot, CRUSH_REACH + dyn.reach)) continue;
      this.destruction.crush(dyn, { x: p.x, y: foot + 0.05, z: p.z });
      list.splice(i, 1);
      this._crushCursor = i;
    }
  }

  /**
   * The nearest unbroken water cooler, muttering to itself.
   *
   * Cheap by being rare: the scan is over the floor's coolers (a couple of dozen)
   * and it happens once every ten seconds or so, which is nothing next to the
   * per-frame work above. A broken one is skipped — whatever it had to say it said
   * when it emptied itself onto the carpet (see spills.js).
   */
  _coolerGlug(dt) {
    this.coolerTimer -= dt;
    if (this.coolerTimer > 0) return;
    this.coolerTimer = COOLER_GLUG[0] + Math.random() * (COOLER_GLUG[1] - COOLER_GLUG[0]);

    const level = this.level.current;
    if (!level || this.player.dead) return;
    const at = this.player.object.position;
    let best = null, bestD = COOLER_RANGE * COOLER_RANGE;
    for (const dyn of level.dynamics) {
      if (!dyn.spills || dyn.broken) continue;
      const p = dyn.group.position;
      const d2 = (p.x - at.x) * (p.x - at.x) + (p.z - at.z) * (p.z - at.z);
      if (d2 < bestD) { bestD = d2; best = dyn; }
    }
    if (!best) return;
    const p = best.group.position;
    this.audio.waterGlug({ x: p.x, y: p.y + 0.5, z: p.z });
  }

  _syncCollider(dyn) {
    const p = dyn.group.position;
    const c = dyn.collider;
    c.minX = p.x - dyn.reach;
    c.maxX = p.x + dyn.reach;
    c.minZ = p.z - dyn.reach;
    c.maxZ = p.z + dyn.reach;
    c.top = p.y + dyn.size.y / 2;
    // ...and its underside, which for a crate sitting on the floor is zero and makes
    // no difference — but a crate in an attic is three metres up, and without this it
    // is a pillar from the carpet to its own lid: it blocked the room below it and,
    // where the two overlap, the staircase. Every static prop has carried a `base`
    // since the levels arrived (see makeSink in gen/build.js); a loose one is derived
    // from its physics body every frame, so it has to be told here.
    c.base = p.y - dyn.size.y / 2;
  }

  update(dt) {
    this.time += dt;
    this.level.update(dt, this.time);

    const level = this.level.current;
    if (!level) return;

    this._crushBoxes();
    this._coolerGlug(dt);

    // Physics runs even while dead, so anything you knocked over on the way
    // out settles instead of freezing mid-air.
    if (this.physics) {
      this.physics.step(dt);
      for (const dyn of level.dynamics) {
        if (!dyn.handle || this.physics.isSleeping(dyn.handle)) continue;
        this.physics.syncMesh(dyn.group, dyn.handle);
        this._syncCollider(dyn);
      }
    }

    // ...but these are not the solver's business, and they used to sit inside
    // that branch. The guard exists precisely to allow a build with no physics,
    // and in that build the doors stopped opening and the keycards stopped being
    // pickable — a floor you could not leave, from a guard meant to be harmless.
    this.destruction.update(dt);
    this.extinguishers.update(dt);
    this.spills?.update(dt);
    // The other player opens doors too. A panel that only answers to the browser
    // it is running in is one your friend walks into — and worse, one that opens
    // in front of you and stays shut in front of them in the same doorway.
    this.doors.update(dt, this.player, this.enemies.items, this.netplay?.others());
    this.casings.update(dt);
    this.keycards.update(dt, this.player);
    this.ragdolls.update(dt);

    // The roster keeps thinking past this player's death when somebody else is
    // still on the floor: in a co-op session the host's browser is the one
    // simulating the staff, so a dead host used to leave the joiner in a building
    // full of statues. Everything BELOW this is about the player at this
    // keyboard, and stays behind the ordinary check.
    if (this.state === 'playing' || this.netplay?.simulating) {
      this.enemies.update(dt, {
        targets: this.netplay ? this.netplay.targets() : [this._soloTarget()],
        effects: this.effects,
        audio: this.audio,
        noise: this.shooting.noise,
      });
    }

    if (this.state === 'playing') {
      // After the enemies, because that is what floods the distance field this
      // frame — and an alarm raised here places its response by walked distance
      // from the player, off exactly that field.
      this.cameras.update(dt, this.player);
      this.hud.setWatch(this.cameras.watch);
      this.hud.setUnseen(this.player.hidden);
      this.conveyors.update(dt);
      // After the enemies, because a run is walked out of `enemies.update` via
      // the `jobTick` hook — this call only decides whether to START one, and a
      // run cast against a roster that has not moved yet would be casting off
      // last frame's positions.
      this.jobs.update(dt);
      this.chores.update(dt);
      this.washers.update(dt);

      this._checkFloorState(dt, level);
      this._vitals(dt);
      this._cowMoo(dt);
    }

    this.netplay?.update(dt);

    // Before setHealth, because the hit wedges are aimed off this and a hit
    // arriving this frame should be aimed from where the player is now.
    this.hud.setFacing(
      this.player.object.position.x, this.player.object.position.z, this.player.yaw);
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setScore(this.kills, this.floorsCleared);
    this.minimap.update(
      dt,
      { x: this.player.object.position.x, z: this.player.object.position.z, yaw: this.player.yaw },
      this.enemies.items
    );
  }

  /**
   * The player at this keyboard, in the shape enemies.js wants a target in.
   *
   * Only used when there is no wire at all — the dev harnesses. With one,
   * netplay.js owns the list, because it is the thing that knows whether there is
   * a second player to put in it.
   */
  _soloTarget() {
    const p = this.player.object.position;
    const t = this._solo ??= {
      x: 0, y: 0, z: 0, layer: 0, dead: false, hidden: false,
      hurt: (amount, sx, sz) => {
        this.player.takeDamage(amount);
        this.hud.damage(Math.min(1, amount / 25), sx, sz);
      },
    };
    t.x = p.x; t.y = p.y; t.z = p.z;
    t.dead = this.player.dead;
    t.hidden = this.player.hidden;
    return t;
  }

  _checkFloorState(dt, level) {
    // Hostiles only — the neutral staff are alive, on the map, and none of your
    // business. See enemies.js.
    const remaining = this.enemies.hostileCount;

    if (!this.cleared && remaining === 0) {
      this.cleared = true;
      this.floorsCleared++;
      // No longer competes with the black card: that now drops one kill earlier,
      // on the last hostile outside the manager's office.
      this.hud.message('FLOOR CLEAR — TAKE THE LIFT DOWN', 2200);
      this.audio.floorClear();
    }
    this._syncObjective(remaining);

    if (this.descendLock > 0) this.descendLock -= dt;
    if (!this.cleared || this.descendLock > 0) return;

    if (distanceToExit(level, this.player.object.position) < EXIT_RADIUS) {
      // Either player on the pad takes both of you down — standing on it waiting
      // for somebody still going through the drawers on the far side of the floor
      // is not a co-op objective. The host does it; the joiner asks, and the
      // descent arrives as the next floor's seed.
      if (this.netplay?.requestDescend()) {
        // Asked. Hold off asking again every frame until the answer arrives.
        this.descendLock = 1;
        return;
      }
      this.descend();
    }
  }

  // The two sounds that are about you rather than about the floor: how hard you
  // are running, and how close you are to not needing to.
  _vitals(dt) {
    const player = this.player;
    if (this.shoveTimer > 0) this.shoveTimer -= dt;
    if (player.dead) return;

    if (player.keys.sprint && player.speed > BREATH_SPEED && player.airTime === 0) {
      this.breathTimer -= dt;
      if (this.breathTimer <= 0) {
        this.breathTimer = BREATH_INTERVAL;
        this.audio.breath();
      }
    } else {
      // Half-charged when you stop, so a second sprint is not silent for a
      // second and a half.
      this.breathTimer = Math.min(this.breathTimer, BREATH_INTERVAL * 0.5);
    }

    const fraction = player.health / player.maxHealth;
    if (fraction >= LOW_HEALTH) { this.pulseTimer = 0; return; }

    const urgency = 1 - fraction / LOW_HEALTH;
    this.pulseTimer -= dt;
    if (this.pulseTimer <= 0) {
      this.pulseTimer = PULSE_SLOW - urgency * (PULSE_SLOW - PULSE_FAST);
      this.audio.lowHealth(urgency);
    }
  }

  // The cow (see placeCow in gen/build.js), on the rare floor that has one.
  // Its own position rather than the player's — the whole point is that it
  // carries across the floor from a room you are not standing in.
  _cowMoo(dt) {
    if (!this.cow) return;
    this.mooTimer -= dt;
    if (this.mooTimer > 0) return;
    this.mooTimer = randomMooDelay();
    this.audio.moo({ x: this.cow.x, y: 1, z: this.cow.z });
  }

  _syncObjective(remaining = this.enemies.hostileCount) {
    this.hud.setObjective(this.cleared
      ? 'Take the lift down'
      : `Clear the floor — ${remaining} left`);
  }

  // Death keeps the pointer locked on purpose: releasing it would pop the
  // click-to-play overlay up over the death screen.
  _onDeath() {
    this.state = 'dead';
    this.audio.playerDeath();
    this.hud.gameOver(true, { floor: this.floor, kills: this.kills });
    this.hud.setObjective('');
  }

  // Called when the player clicks after dying.
  restartIfDead() {
    if (this.state !== 'dead') return false;
    // The run is the team's, so the restart is too: whichever of you clicks, both
    // of you start again from floor 1. The joiner asks and the host does it, which
    // is the same shape as the descent and for the same reason — one browser rolls
    // the seeds.
    if (this.netplay?.requestRestart()) return true;
    if (this.netplay?.online) { this.startCoop(); return true; }
    this.start();
    return true;
  }
}

function randomMooDelay() {
  return MOO_INTERVAL[0] + Math.random() * (MOO_INTERVAL[1] - MOO_INTERVAL[0]);
}

// Difficulty curves. Every one of these is deliberately gentle — the floors get
// bigger on their own, so the enemies only need to keep pace, not outrun you.
function tuningFor(floor, areaRatio) {
  const t = floor - 1;
  return {
    // Scaled with the slab: floors are four times the area they used to be, and
    // the old count left them feeling abandoned rather than dangerous. Doubled
    // again on top of that — a floor this size swallows thirty people without
    // ever feeling occupied, and the walk between contacts was the dead part.
    //
    // `areaRatio` is this floor's size against the usual one at this depth
    // (gen/layout.js), so the roll that makes a floor small makes it a shorter
    // fight rather than a denser one. The 200 cap is absolute and applies after
    // it — it is what the engine and the roster are built for, not a curve.
    count: Math.min(200, Math.round((70 + t * 18) * areaRatio)),
    health: Math.min(260, 100 + t * 10),
    damage: Math.min(18, 7 + t * 0.7),
    speed: Math.min(4.2, 2.5 + t * 0.09),
    fireInterval: Math.max(0.55, 1.5 - t * 0.06),
    // Tighter cone with depth: later floors punish standing in the open.
    spread: Math.max(0.022, 0.075 - t * 0.0035),
    reaction: Math.max(0.12, 0.5 - t * 0.025),
    // How long a shooter has to hold you before its first round (see AIM_CONE in
    // enemies.js). This is the floor's whole answer to "can I surprise anybody":
    // it is time to see them, pick which one, and fire first. Like every curve
    // here it tightens with depth rather than switching off — a deep floor still
    // gives you a third of a second, which is enough for a shot you had already
    // decided on and not enough to go looking for one.
    aim: Math.max(0.34, 0.85 - t * 0.045),
  };
}
