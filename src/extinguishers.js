import * as THREE from 'three';
import { getFx } from './fx-textures.js';

// The one prop on the floor that fights back.
//
// Shoot any other extinguisher-shaped thing and it comes apart into boxes. Shoot
// this one and it springs a leak: the cylinder is holed, everything inside it
// leaves through that hole, and for the next second and a half nobody in the
// room — including you — has any say in where nine kilos of steel goes.
//
// The flight is not scripted. Thrust is applied along the body's OWN axis and
// off its centre, so the tumble the thrust causes turns the thrust, which causes
// more tumble. That feedback loop is the whole effect: it is why the thing
// cannons off a desk and comes back at you, and it is why no two are alike. A
// scripted arc would have to fake all of that and would still read as fake.
//
// Then it goes off, and the blast is the same event routed four ways: an impulse
// on every loose prop nearby, damage to everyone standing in it, damage to the
// furniture (so one of these can set off the next), and the pieces of the
// extinguisher itself.

const FUSE = [1.1, 1.8];       // seconds of flight before it lets go
const THRUST = 26;             // newtons out of the puncture
const WOBBLE = 5;              // ...of which this much wanders, so it never flies straight
const JET_OFFSET = 0.16;       // metres off centre the thrust is applied, which is the tumble
const SPIN_UP = 9;             // one-off kick at the puncture, so it leaves in a hurry

const BLAST_RADIUS = 4.4;
const BLAST_DAMAGE = 55;       // at the centre, falling off to nothing at the rim
const BLAST_PUSH = 26;         // impulse on loose furniture
const BLAST_PROP_DAMAGE = 140; // what it does to the furniture it is standing among

// The gas. A pooled set of soft billboards puffed out of the nozzle, growing and
// thinning as they go — the trail is what tells you where the thing has been,
// and after it goes off it is the only thing left in the air.
const PUFF_COUNT = 90;
const PUFF_LIFE = 1.3;
const PUFF_RATE = 45;          // puffs per second while it is venting

export class Extinguishers {
  constructor({ scene, physics, effects, audio, destruction, enemies, player, hud }) {
    this.scene = scene;
    this.physics = physics;
    this.effects = effects;
    this.audio = audio;
    this.destruction = destruction;
    this.enemies = enemies;
    this.player = player;
    this.hud = hud;

    this.live = [];
    this._jet = new THREE.Vector3();
    this._thrust = new THREE.Vector3();
    this._at = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);

    const glow = getFx().glow;
    this.puffs = [];
    this.puffCursor = 0;
    for (let i = 0; i < PUFF_COUNT; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow, color: 0xf2f6ff, transparent: true, opacity: 0, depthWrite: false,
      }));
      sprite.visible = false;
      sprite.frustumCulled = false;
      scene.add(sprite);
      this.puffs.push({ sprite, life: 0, grow: 1, drift: new THREE.Vector3() });
    }
  }

  /**
   * A destructible marked `volatile` has run out of hit points. Instead of
   * breaking, it leaves — as a rigid body built from the very boxes it would
   * have broken into, so what flies across the room is the thing that was
   * standing there a moment ago, in its own colours.
   */
  launch(entry, dir, point) {
    const parts = entry.parts ?? [];
    if (!parts.length) return false;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of parts) {
      minX = Math.min(minX, p.x0); maxX = Math.max(maxX, p.x1);
      minY = Math.min(minY, p.y0); maxY = Math.max(maxY, p.y1);
      minZ = Math.min(minZ, p.z0); maxZ = Math.max(maxZ, p.z1);
    }

    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const group = new THREE.Group();
    group.position.set(cx, cy, cz);

    const ownGeo = [];
    for (const p of parts) {
      const geo = new THREE.BoxGeometry(p.x1 - p.x0, p.y1 - p.y0, p.z1 - p.z0);
      ownGeo.push(geo);
      const mesh = new THREE.Mesh(geo, p.material);
      mesh.position.set((p.x0 + p.x1) / 2 - cx, (p.y0 + p.y1) / 2 - cy, (p.z0 + p.z1) / 2 - cz);
      mesh.castShadow = true;
      group.add(mesh);
    }
    this.scene.add(group);

    const handle = this.physics?.addBox({
      size: { x: Math.max(0.12, maxX - minX), y: Math.max(0.2, maxY - minY), z: Math.max(0.12, maxZ - minZ) },
      position: { x: cx, y: cy, z: cz },
      mass: 9,
    });

    // The kick that gets it off the floor, away from the shot and upward. After
    // this the body's own tumble is in charge.
    if (handle) {
      this._jet.set(dir.x * 0.5, 1, dir.z * 0.5).normalize();
      this.physics.impulse(handle, this._jet, SPIN_UP, point);
    }

    this.live.push({
      group, handle, ownGeo,
      fuse: FUSE[0] + Math.random() * (FUSE[1] - FUSE[0]),
      puffDebt: 0,
      parts,
      substance: entry.substance,
    });

    this.audio.extinguisherJet(group.position);
    return true;
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const rocket = this.live[i];
      const group = rocket.group;

      if (rocket.handle) {
        this.physics.syncMesh(group, rocket.handle);

        // Out of the base, in the body's own frame — so the direction of thrust
        // is whatever way the cylinder happens to be pointing this instant.
        this._jet.set(0, -1, 0).applyQuaternion(group.quaternion);
        this._jet.x += (Math.random() - 0.5) * 0.35;
        this._jet.z += (Math.random() - 0.5) * 0.35;
        this._jet.normalize();

        // Applied at the nozzle rather than the centre of mass: that offset is
        // the entire difference between a firework and a bottle rocket.
        this._at.copy(group.position).addScaledVector(this._jet, JET_OFFSET);
        this._thrust.copy(this._jet).negate();
        this.physics.impulse(
          rocket.handle, this._thrust,
          (THRUST + Math.random() * WOBBLE) * dt, this._at);

        rocket.puffDebt += PUFF_RATE * dt;
        while (rocket.puffDebt >= 1) {
          rocket.puffDebt -= 1;
          this._puff(this._at, this._jet);
        }
      }

      rocket.fuse -= dt;
      if (rocket.fuse <= 0) {
        this._burst(rocket);
        this.live.splice(i, 1);
      }
    }

    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sprite.visible = false; continue; }
      const k = p.life / PUFF_LIFE;
      p.sprite.material.opacity = k * 0.5;
      p.sprite.scale.setScalar(p.grow * (1.6 - k));
      // The gas keeps going and rises as it thins.
      p.sprite.position.addScaledVector(p.drift, dt);
      p.sprite.position.y += dt * 0.25;
    }
  }

  /** Everything on this floor, gone with the floor. */
  clear() {
    for (const rocket of this.live) this._retire(rocket);
    this.live.length = 0;
    for (const p of this.puffs) {
      p.life = 0;
      p.sprite.visible = false;
    }
  }

  // --- internals --------------------------------------------------------------

  _puff(at, dir) {
    const p = this.puffs[this.puffCursor];
    this.puffCursor = (this.puffCursor + 1) % this.puffs.length;

    p.sprite.position.copy(at);
    p.drift.copy(dir).multiplyScalar(1.6 + Math.random() * 1.6);
    p.drift.x += (Math.random() - 0.5) * 0.8;
    p.drift.z += (Math.random() - 0.5) * 0.8;
    p.grow = 0.22 + Math.random() * 0.24;
    p.sprite.scale.setScalar(p.grow * 0.6);
    p.sprite.material.opacity = 0.5;
    p.sprite.visible = true;
    p.life = PUFF_LIFE;
  }

  _burst(rocket) {
    const at = rocket.group.position.clone();

    this._retire(rocket);

    // The bang, then the flash, then a last shove of gas in every direction.
    this.audio.extinguisherBurst(at);
    this.effects.impact(at, this._up, 0xfff0cc, 7);
    for (let i = 0; i < 26; i++) {
      this._jet.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this._puff(at, this._jet);
    }

    // Loose furniture is thrown, static furniture is damaged — which is how one
    // of these sets off the next one across the room.
    this.physics?.blast(at, BLAST_RADIUS, BLAST_PUSH);
    this.destruction?.blast(at, BLAST_RADIUS, BLAST_PROP_DAMAGE);

    // Anyone standing in it. Falls off with distance, so the edge of the blast
    // is a scare and the middle of it is not survivable by an intern.
    this.enemies?.splash(at.x, at.z, BLAST_RADIUS, BLAST_DAMAGE, this.audio);

    const dx = this.player.object.position.x - at.x;
    const dy = this.player.object.position.y - at.y;
    const dz = this.player.object.position.z - at.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < BLAST_RADIUS) {
      const damage = BLAST_DAMAGE * (1 - dist / BLAST_RADIUS);
      this.player.takeDamage(damage);
      this.hud?.damage(Math.min(1, damage / 25));
    }

    // And what is left of the cylinder.
    this.destruction?.scatter(rocket.parts, at);
  }

  _retire(rocket) {
    this.scene.remove(rocket.group);
    for (const geo of rocket.ownGeo) geo.dispose();
    if (rocket.handle) this.physics?.remove(rocket.handle);
    rocket.handle = null;
  }
}
