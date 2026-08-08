import * as THREE from 'three';

// Floating shootable drones. Each one bobs on the spot, takes damage from
// hitscan shots, flashes white when hit, pops when killed and respawns after a
// short delay at a fresh position — so there's always something to shoot at.

const COUNT = 12;
const HEALTH = 100;
const RESPAWN = 2.5;        // seconds between pop and reappear
const POP_TIME = 0.35;      // death animation length
const RING_SPEED = 1.4;     // rad/s the ring spins
const HIT_FLASH = 0.12;     // seconds the body stays white after a hit

export class Targets {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.meshes = [];       // raycast targets, kept in sync with `items`
    this.time = 0;

    const bodyGeo = new THREE.IcosahedronGeometry(0.45, 1);
    const ringGeo = new THREE.TorusGeometry(0.62, 0.05, 6, 20);

    for (let i = 0; i < COUNT; i++) {
      const group = new THREE.Group();

      const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
        color: 0xc0392b, emissive: 0x3a0b06, roughness: 0.45, metalness: 0.2,
      }));
      body.castShadow = true;
      group.add(body);

      const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({
        color: 0xffd166, emissive: 0x5a3a00, roughness: 0.4, metalness: 0.6,
      }));
      ring.rotation.x = Math.PI / 2;
      group.add(ring);

      scene.add(group);

      const target = {
        group, body, ring,
        health: HEALTH,
        alive: true,
        respawnIn: 0,
        popIn: 0,
        flash: 0,
        phase: i * 1.7,      // desynchronises the bob
        home: new THREE.Vector3(),
      };

      // The body is what bullets test against; hits map back to the target.
      body.userData.target = target;
      this.items.push(target);
      this.meshes.push(body);

      this._place(target, i);
    }
  }

  // Deterministic-ish scatter in a ring around the spawn area, at head height
  // or a little above, avoiding the very center where the player starts.
  _place(target, seed) {
    const a = seed * 2.3999632 + this.time * 0.7;   // golden angle, drifts over time
    const r = 12 + ((seed * 7) % 5) * 4;
    target.home.set(Math.cos(a) * r, 2.2 + ((seed * 3) % 4) * 0.8, Math.sin(a) * r);
    target.group.position.copy(target.home);
  }

  // Applies damage from a bullet. Returns 'kill', 'hit', or null if the target
  // was already down (a pellet arriving in the same frame as the killing shot).
  hit(target, damage) {
    if (!target.alive) return null;
    target.health -= damage;
    target.flash = HIT_FLASH;
    if (target.health > 0) return 'hit';

    target.alive = false;
    target.popIn = POP_TIME;
    target.respawnIn = RESPAWN;
    return 'kill';
  }

  update(dt) {
    this.time += dt;

    for (let i = 0; i < this.items.length; i++) {
      const t = this.items[i];
      t.ring.rotation.z += RING_SPEED * dt;

      if (t.alive) {
        // Bob in place, with a slow yaw so the ring catches the light.
        t.group.position.y = t.home.y + Math.sin(this.time * 1.6 + t.phase) * 0.35;
        t.group.rotation.y += dt * 0.6;

        if (t.flash > 0) {
          t.flash -= dt;
          const k = Math.max(0, t.flash / HIT_FLASH);
          t.body.material.emissive.setRGB(0.23 + k * 0.77, 0.04 + k * 0.77, 0.02 + k * 0.77);
          // Health also tints the body: healthy red -> pale as it breaks down.
          t.body.material.color.setHSL(0.02, 0.6 * (t.health / HEALTH) + 0.15, 0.42);
        }
        continue;
      }

      // Dead: pop outward and fade, then wait out the respawn timer.
      if (t.popIn > 0) {
        t.popIn -= dt;
        const k = Math.max(0, t.popIn / POP_TIME);
        t.group.scale.setScalar(1 + (1 - k) * 1.6);
        t.group.visible = k > 0;
        if (t.popIn <= 0) t.group.visible = false;
      }

      t.respawnIn -= dt;
      if (t.respawnIn <= 0) this._respawn(t, i);
    }
  }

  _respawn(t, i) {
    t.alive = true;
    t.health = HEALTH;
    t.flash = 0;
    t.group.scale.setScalar(1);
    t.group.visible = true;
    t.body.material.color.setHex(0xc0392b);
    t.body.material.emissive.setHex(0x3a0b06);
    this._place(t, i + Math.floor(this.time) * 3);
  }
}
