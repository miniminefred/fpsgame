import * as THREE from 'three';
import { Level, distanceToExit } from './level.js';
import { makeRng, randomSeed } from './gen/rng.js';

// The run: generate a floor, clear it, take the exit down, repeat forever.
//
// Nothing here is authored per level — difficulty is a handful of curves over
// the floor number, and the floor itself comes out of the generator. That is
// the whole point of the design: the game can keep going as long as you can.

const EXIT_RADIUS = 1.6;       // how close you must get to the pad to descend
const HEAL_ON_DESCEND = 25;
const PUSH_IMPULSE = 110;      // N·s per second of contact, walking into props
const DEBRIS_LIFETIME = 16;    // seconds a fragment lies around before it fades
const MAX_DEBRIS = 80;         // hard cap on live fragments, oldest recycled first

export class Game {
  constructor({ scene, camera, player, weapons, shooting, enemies, effects, audio, hud, minimap, lighting, physics }) {
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

    this.level = new Level(scene);
    // Player-facing colliders for this floor's loose props, refreshed from the
    // physics bodies every frame.
    this.pushColliders = [];
    // Fragments of props that have been shot apart.
    this.debris = [];

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
    };

    this.shooting.onPropHit = (dyn, dir, point, damage) => this._damageProp(dyn, dir, point, damage);
  }

  // --- destructible props ---------------------------------------------------

  _damageProp(dyn, dir, point, damage) {
    if (!dyn.hp || dyn.broken) return;
    dyn.hp -= damage;
    if (dyn.hp <= 0) this._breakProp(dyn, dir, point);
  }

  // Retires the intact prop and re-emits the boxes it was built from as
  // independent bodies, thrown outward from the shot that finished it.
  _breakProp(dyn, dir, point) {
    dyn.broken = true;

    if (dyn.handle) this.physics?.remove(dyn.handle);
    dyn.handle = null;
    this.scene.remove(dyn.group);
    this.shooting.removeHittables(dyn.group.children);

    // Retire its collider without disturbing the array the player is holding.
    if (dyn.collider) {
      dyn.collider.push = null;
      dyn.collider.top = -1;
    }

    const origin = dyn.group.position;
    const yaw = new THREE.Euler().setFromQuaternion(dyn.group.quaternion, 'YXZ').y;
    const volume = Math.max(1e-4, dyn.size.x * dyn.size.y * dyn.size.z);

    for (const part of dyn.parts) {
      const sx = part.x1 - part.x0, sy = part.y1 - part.y0, sz = part.z1 - part.z0;
      if (sx < 1e-3 || sy < 1e-3 || sz < 1e-3) continue;

      _local.set((part.x0 + part.x1) / 2, (part.y0 + part.y1) / 2, (part.z0 + part.z1) / 2);
      const world = _local.applyQuaternion(dyn.group.quaternion).add(origin).clone();

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), part.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.copy(world);
      this.scene.add(mesh);

      // Mass shared out by volume so a chair's base still outweighs its arm.
      const mass = Math.max(0.4, dyn.mass * ((sx * sy * sz) / volume));
      const handle = this.physics?.addBox({
        size: { x: sx, y: sy, z: sz }, position: world, yaw, mass,
      });

      if (handle) {
        // Blown away from the impact and slightly upward; the impulse is
        // applied at the hit point rather than the centre, so pieces spin.
        _away.copy(world).sub(point);
        if (_away.lengthSq() < 1e-6) _away.copy(dir);
        _away.normalize();
        _away.y += 0.75;
        _away.normalize();
        this.physics.impulse(handle, _away, mass * (2.2 + Math.random() * 2.4), point);
      }

      this.debris.push({ mesh, handle, life: DEBRIS_LIFETIME });
    }

    this.effects.impact(point, _up.set(0, 1, 0), 0xffe4b0);
    this.audio.click(0.7, 0.25);

    while (this.debris.length > MAX_DEBRIS) this._retireDebris(this.debris.shift());
  }

  _retireDebris(entry) {
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    if (entry.handle) this.physics?.remove(entry.handle);
  }

  _updateDebris(dt) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const entry = this.debris[i];
      entry.life -= dt;
      if (entry.life <= 0) {
        this._retireDebris(entry);
        this.debris.splice(i, 1);
        continue;
      }
      if (entry.handle && !this.physics.isSleeping(entry.handle)) {
        this.physics.syncMesh(entry.mesh, entry.handle);
      }
    }
  }

  _clearDebris() {
    for (const entry of this.debris) this._retireDebris(entry);
    this.debris.length = 0;
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

    this._initPhysics(level);
    this.player.setColliders([...level.colliders, ...this.pushColliders]);
    this.player.placeAt(level.spawn.x, level.spawn.z);

    this.enemies.spawn(level.layout, level.nav, rng, tuningFor(this.floor));

    // Bullets stop on this floor's geometry and this floor's occupants.
    this.shooting.setHittables([...level.meshes, ...this.enemies.meshes]);

    this.lighting.setFixtures(level.fixtures);
    this.lighting.setOcclusion((ax, az, bx, bz) => level.nav.losClear(ax, az, bx, bz));
    this.minimap.setLevel(level.map);

    this.cleared = false;
    this.descendLock = 1.2;     // grace period so you can't fall straight through
    this.hud.setFloor(this.floor);
    this.hud.message(`FLOOR ${this.floor}`, 1800);
    this._syncObjective();
  }

  // Hands this floor's walls and furniture to the physics world, and turns each
  // loose prop into a body the player and bullets can shove.
  _initPhysics(level) {
    this.pushColliders = [];
    this._clearDebris();
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
      this._updateDebris(dt);
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

const _local = new THREE.Vector3();
const _away = new THREE.Vector3();
const _up = new THREE.Vector3();

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
