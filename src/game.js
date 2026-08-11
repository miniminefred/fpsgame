import { Level, distanceToExit } from './level.js';
import { makeRng, randomSeed } from './gen/rng.js';
import { CARDS } from './keycards.js';

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
  constructor({ scene, camera, player, weapons, shooting, enemies, effects, audio, hud, minimap, lighting, physics, destruction, extinguishers, doors, casings, keycards, wallet, ragdolls, cameras }) {
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
    this.doors = doors;
    this.casings = casings;
    this.keycards = keycards;
    this.wallet = wallet;
    this.ragdolls = ragdolls;
    this.cameras = cameras;

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

    this.shooting.onPropHit = (dyn, dir, point, damage) =>
      this.destruction.damageProp(dyn, dir, point, damage);
    this.shooting.onSurfaceHit = (hit, dir, damage) =>
      this.destruction.damageSurface(hit, dir, damage);

    this.enemies.onDeath = (e) => this._onEnemyDeath(e);
    this.doors.onRefused = (door) => this._onDoorRefused(door);
    this.wallet.onChange = (wallet, tier) => this._onCardTaken(wallet, tier);

    this.cameras.onSpotted = (cam) => this.audio.cameraSpotted(cam.at);
    this.cameras.onAlarm = () => this._onAlarm();
    this.shooting.onCameraHit = (cam, damage, point, normal) =>
      this.cameras.damage(cam, damage, point, normal);
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
    const response = this.enemies.alarm(
      this.player.object.position.x, this.player.object.position.z);

    this.shooting.addHittables(response.meshes);
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
    const coming = response.spawned.length + response.roused + response.heard;
    this.hud.message('ALARM ALARM — INTRUDER', 1700,
      coming ? { text: `${coming} COMING FOR YOU`, ms: 2300 } : null);
    this._syncObjective();
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

  // Fresh run from floor 1.
  start() {
    this.floor = 0;
    this.kills = 0;
    this.floorsCleared = 0;
    this.state = 'playing';
    this.player.reset();
    this.hud.gameOver(false, {});
    this.nextFloor();
  }

  nextFloor() {
    this.floor++;
    const seed = randomSeed();
    const rng = makeRng(seed ^ 0x9e3779b9);

    // Debris and brass from the last floor have to go before its physics world
    // does — the handles they hold only mean anything inside that world.
    this.destruction.clear();
    this.extinguishers.clear();
    this.casings.clear();
    // Cards do not travel between floors. A building where the card you found on
    // eight opens nine has exactly one locked door in it, on floor one.
    this.keycards.clear();
    this.wallet.clear();
    // Before the level is generated, because enemies.spawn disposes the
    // materials these corpses are still drawn with.
    this.ragdolls.clear();

    const level = this.level.generate(seed, this.floor);

    this._initPhysics(level);
    this.destruction.setLevel(level);
    // Split rather than concatenated: the building holds still and gets indexed,
    // the loose furniture moves every frame and cannot be. See setColliders.
    this.player.setColliders(level.colliders, this.pushColliders);
    // The doors own colliders that are already in that list; all they do at
    // runtime is drop them below the floor when the panel is out of the way.
    this.doors.setDoors(level.doors, level.nav);
    // What an alarm response is allowed to walk through. The door list is asked
    // rather than the lock list, because the doors are what will actually open
    // for them — see badgeTiles there and setBadgeTiles in nav.js.
    level.nav.setBadgeTiles(this.doors.badgeTiles());
    this.player.placeAt(level.spawn.x, level.spawn.z);
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
      tuningFor(this.floor, level.layout.areaRatio));
    // After the staff, because the cameras are watching the floor rather than
    // watching them — nothing about where one goes depends on who is standing
    // where, and taking the roster's dice first keeps enemy placement reading
    // off the same stream it always did.
    this.cameras.spawn(level.layout, level.nav, rng);

    // Bullets stop on this floor's geometry, this floor's occupants, and the
    // things on its walls looking at them.
    this.shooting.setHittables([
      ...level.meshes, ...this.enemies.meshes, ...this.cameras.meshes,
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
    this.lighting.setOcclusion(level.nav.losClear.bind(level.nav));
    this.minimap.setLevel(level.map);

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
      const collider = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0, push: dyn };
      dyn.collider = collider;
      this.pushColliders.push(collider);
      this._syncCollider(dyn);
    }
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
    this.doors.update(dt, this.player, this.enemies.items);
    this.casings.update(dt);
    this.keycards.update(dt, this.player);
    this.ragdolls.update(dt);

    if (this.state === 'playing') {
      this.enemies.update(dt, {
        player: this.player,
        effects: this.effects,
        audio: this.audio,
        hud: this.hud,
        noise: this.shooting.noise,
      });

      // After the enemies, because that is what floods the distance field this
      // frame — and an alarm raised here places its response by walked distance
      // from the player, off exactly that field.
      this.cameras.update(dt, this.player);
      this.hud.setWatch(this.cameras.watch);

      this._checkFloorState(dt, level);
      this._vitals(dt);
    }

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

  _checkFloorState(dt, level) {
    // Hostiles only — the neutral staff are alive, on the map, and none of your
    // business. See enemies.js.
    const remaining = this.enemies.hostileCount;

    if (!this.cleared && remaining === 0) {
      this.cleared = true;
      this.floorsCleared++;
      // No longer competes with the black card: that now drops one kill earlier,
      // on the last hostile outside the manager's office.
      this.hud.message('FLOOR CLEAR — FIND THE EXIT', 2200);
      this.audio.floorClear();
    }
    this._syncObjective(remaining);

    if (this.descendLock > 0) this.descendLock -= dt;
    if (!this.cleared || this.descendLock > 0) return;

    if (distanceToExit(level, this.player.object.position) < EXIT_RADIUS) {
      this.player.heal(HEAL_ON_DESCEND);
      this.audio.descend();
      this.nextFloor();
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

  _syncObjective(remaining = this.enemies.hostileCount) {
    this.hud.setObjective(this.cleared
      ? 'Find the exit'
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
    this.start();
    return true;
  }
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
  };
}
