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
  constructor({ scene, camera, player, weapons, shooting, enemies, effects, audio, hud, minimap, lighting, physics, destruction, extinguishers, doors, casings, keycards, wallet, ragdolls }) {
    this.scene = scene;
    this.camera = camera;
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
    if (this.doors) this.doors.onRefused = (door) => this._onDoorRefused(door);
    this.wallet.onChange = (wallet, tier) => this._onCardTaken(wallet, tier);
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
   * The black card is the exception to all of it, and it is the reason the
   * manager's office is worth walking back for: it is not carried by anybody in
   * particular, it is what the LAST hostile on the floor turns out to have been
   * holding. Impossible to get early, impossible to miss, and impossible to lose
   * — you cannot clear a floor without producing it.
   */
  _onEnemyDeath(e) {
    if (!this.keycards) return;
    const at = e.group.position;
    // Not if you already hold one, and not if one is already lying somewhere
    // waiting for you — six grey cards on the carpet is not six times the
    // information, it is five red herrings.
    if (e.card && !this.wallet.has(e.card) && !this.keycards.pending(e.card)) {
      this.keycards.drop(e.card, at.x, 0, at.z);
    }

    if (e.neutral || this.enemies.hostileCount > 0) return;
    if (!this.level.current?.layout.locks?.some((l) => l.tier === 'black')) return;
    // Offset a little in case they were also carrying something, so two cards
    // never float inside each other.
    this.keycards.drop('black', at.x + (e.card ? 0.55 : 0), 0, at.z);
    // Not announced here. This fires on the same frame as the floor going
    // clear, and _checkFloorState's toast would land on top of it a few lines
    // later — so the two are said as one thing, which they are.
    this.droppedBlack = true;
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
    this.extinguishers?.clear();
    this.casings?.clear();
    // Cards do not travel between floors. A building where the card you found on
    // eight opens nine has exactly one locked door in it, on floor one.
    this.keycards?.clear();
    this.wallet?.clear();
    // Before the level is generated, because enemies.spawn disposes the
    // materials these corpses are still drawn with.
    this.ragdolls?.clear();

    const level = this.level.generate(seed, this.floor);

    this._initPhysics(level);
    this.destruction.setLevel(level);
    this.player.setColliders([...level.colliders, ...this.pushColliders]);
    // The doors own colliders that are already in that list; all they do at
    // runtime is drop them below the floor when the panel is out of the way.
    this.doors?.setDoors(level.doors);
    this.player.placeAt(level.spawn.x, level.spawn.z);

    this.enemies.spawn(level.layout, level.nav, rng, tuningFor(this.floor));

    // Bullets stop on this floor's geometry and this floor's occupants.
    this.shooting.setHittables([...level.meshes, ...this.enemies.meshes]);
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
    this.lighting.setOcclusion((ax, az, bx, bz) => level.nav.losClear(ax, az, bx, bz));
    this.minimap.setLevel(level.map);

    this.cleared = false;
    this.droppedBlack = false;
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
      this.destruction.update(dt);
      this.extinguishers?.update(dt);
      this.doors?.update(dt, this.player, this.enemies.items);
      this.casings?.update(dt);
      this.keycards?.update(dt, this.player);
      this.ragdolls?.update(dt);
    }

    if (this.state === 'playing') {
      this.enemies.update(dt, {
        player: this.player,
        effects: this.effects,
        audio: this.audio,
        hud: this.hud,
        noise: this.shooting.noise,
      });

      this._checkFloorState(dt, level);
      this._vitals(dt);
    }

    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setScore(this.kills, this.floorsCleared);
    this.minimap.update(
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
      this.hud.message(this.droppedBlack
        ? 'FLOOR CLEAR — THE LAST ONE HAD A BLACK KEYCARD'
        : 'FLOOR CLEAR — FIND THE EXIT', 2600);
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
function tuningFor(floor) {
  const t = floor - 1;
  return {
    // Scaled with the slab: floors are four times the area they used to be, and
    // the old count left them feeling abandoned rather than dangerous. Doubled
    // again on top of that — a floor this size swallows thirty people without
    // ever feeling occupied, and the walk between contacts was the dead part.
    count: Math.min(200, 70 + Math.round(t * 18)),
    health: Math.min(260, 100 + t * 10),
    damage: Math.min(18, 7 + t * 0.7),
    speed: Math.min(4.2, 2.5 + t * 0.09),
    fireInterval: Math.max(0.55, 1.5 - t * 0.06),
    // Tighter cone with depth: later floors punish standing in the open.
    spread: Math.max(0.022, 0.075 - t * 0.0035),
    reaction: Math.max(0.12, 0.5 - t * 0.025),
  };
}
