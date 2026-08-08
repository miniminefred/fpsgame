import { Level, distanceToExit } from './level.js';
import { makeRng, randomSeed } from './gen/rng.js';

// The run: generate a floor, clear it, take the exit down, repeat forever.
//
// Nothing here is authored per level — difficulty is a handful of curves over
// the floor number, and the floor itself comes out of the generator. That is
// the whole point of the design: the game can keep going as long as you can.

const EXIT_RADIUS = 1.6;       // how close you must get to the pad to descend
const HEAL_ON_DESCEND = 25;

export class Game {
  constructor({ scene, camera, player, weapons, shooting, enemies, effects, audio, hud, minimap, lighting }) {
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

    this.level = new Level(scene);

    this.floor = 0;
    this.kills = 0;
    this.floorsCleared = 0;
    this.time = 0;
    this.state = 'playing';     // 'playing' | 'dead'
    this.cleared = false;
    this.descendLock = 0;

    this.player.onDeath = () => this._onDeath();
    this.shooting.onKill = () => { this.kills++; };
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

    const level = this.level.generate(seed, this.floor);

    this.player.setColliders(level.colliders);
    this.player.placeAt(level.spawn.x, level.spawn.z);

    this.enemies.spawn(level.layout, level.nav, rng, tuningFor(this.floor));

    // Bullets stop on this floor's geometry and this floor's occupants.
    this.shooting.setHittables([...level.meshes, ...this.enemies.meshes]);

    this.lighting.setFixtures(level.fixtures);
    this.minimap.setLevel(level.map);

    this.cleared = false;
    this.descendLock = 1.2;     // grace period so you can't fall straight through
    this.hud.setFloor(this.floor);
    this.hud.message(`FLOOR ${this.floor}`, 1800);
    this._syncObjective();
  }

  update(dt) {
    this.time += dt;
    this.level.update(dt, this.time);

    const level = this.level.current;
    if (!level) return;

    if (this.state === 'playing') {
      this.enemies.update(dt, {
        player: this.player,
        effects: this.effects,
        audio: this.audio,
        hud: this.hud,
        noise: this.shooting.noise,
      });

      this._checkFloorState(dt, level);
    }

    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setScore(this.kills, this.floorsCleared);
    this.minimap.update(
      { x: this.player.object.position.x, z: this.player.object.position.z, yaw: this.player.yaw },
      this.enemies.items
    );
  }

  _checkFloorState(dt, level) {
    const remaining = this.enemies.aliveCount;

    if (!this.cleared && remaining === 0) {
      this.cleared = true;
      this.floorsCleared++;
      this.hud.message('FLOOR CLEAR — FIND THE EXIT', 2200);
      this.audio.ping(true);
    }
    this._syncObjective(remaining);

    if (this.descendLock > 0) this.descendLock -= dt;
    if (!this.cleared || this.descendLock > 0) return;

    if (distanceToExit(level, this.player.object.position) < EXIT_RADIUS) {
      this.player.heal(HEAL_ON_DESCEND);
      this.nextFloor();
    }
  }

  _syncObjective(remaining = this.enemies.aliveCount) {
    this.hud.setObjective(this.cleared
      ? 'Find the exit'
      : `Clear the floor — ${remaining} left`);
  }

  // Death keeps the pointer locked on purpose: releasing it would pop the
  // click-to-play overlay up over the death screen.
  _onDeath() {
    this.state = 'dead';
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
    count: Math.min(28, 5 + Math.round(t * 1.8)),
    health: Math.min(260, 100 + t * 10),
    damage: Math.min(18, 7 + t * 0.7),
    speed: Math.min(4.2, 2.5 + t * 0.09),
    fireInterval: Math.max(0.55, 1.5 - t * 0.06),
    // Tighter cone with depth: later floors punish standing in the open.
    spread: Math.max(0.022, 0.075 - t * 0.0035),
    reaction: Math.max(0.12, 0.5 - t * 0.025),
  };
}
