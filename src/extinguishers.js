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
const MASS = 6;                // kilos of steel and pressurised nothing
// Thrust has to beat its own weight by a wide margin or the cylinder just sits
// there hissing: 6 kg weighs 59 N, so anything under that is a fire
// extinguisher having a bad day rather than one leaving the room.
const THRUST = 190;            // newtons out of the puncture
const WOBBLE = 60;             // ...of which this much wanders, so it never flies straight
const JET_OFFSET = 0.16;       // metres off centre the thrust is applied, which is the tumble
const SPIN_UP = 22;            // one-off kick at the puncture, so it leaves in a hurry

// Thrust plus a wall is a press, not a flight: the cylinder drives itself into
// the plaster, prop-against-world friction is 0.45 with next to no bounce, and
// it stays there hissing until the fuse runs out. So a stall is watched for and
// broken. The kick goes back the way it came — which is the best guess at the
// wall's normal that costs nothing — with a hard upward bias and a long lever
// arm, so it comes off the wall spinning and pointing somewhere new.
const STALL_SPEED = 1.4;       // m/s under which it is not really going anywhere
const STALL_TIME = 0.1;        // ...and for how long before that counts
const KICK = 16;               // N·s off the wall
const KICK_ARM = 0.5;          // metres of lever on that kick, i.e. how hard it tumbles
// Two windows follow a kick, and they are different lengths for different
// reasons. The jet is cut briefly so 190 N does not simply re-pin it inside two
// frames — but only briefly, or a cylinder scraping along the floor spends its
// whole life being kicked with the jet off and never goes anywhere. The heading
// is held for longer, because the kick's own motion must not become the heading:
// that turns the next kick around and the thing hovers at the wall arguing with
// itself until the fuse runs out.
const KICK_HOLD = 0.25;
const KICK_CUT = 0.1;
const LIFT_FLOOR = 0.3;        // the thrust may never point further down than this

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
    this._move = new THREE.Vector3();
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
      mass: MASS,
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
      // Where it was last frame and which way it was going, so a stall can be
      // told from a turn and broken back the way it came.
      last: new THREE.Vector3(cx, cy, cz),
      heading: new THREE.Vector3(0, 1, 0),
      stalled: 0,
      recover: 0,
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

        // The one place the physics is cheated, and only where it has to be.
        // Land the thing on its head and the jet points at the ceiling, which
        // means 190 N holding it against the carpet: it stops dead, hisses for a
        // second and a half and goes off where it fell. So once it has stopped
        // going anywhere the thrust is not allowed to point below the horizon
        // any more. In free flight it stays honest — the lie is what gets it off
        // the floor, not what flies it around the room.
        if (rocket.stalled > 0 && this._thrust.y < LIFT_FLOOR) {
          this._thrust.y = LIFT_FLOOR;
          this._thrust.normalize();
        }
        if (rocket.recover <= KICK_HOLD - KICK_CUT) {
          this.physics.impulse(
            rocket.handle, this._thrust,
            (THRUST + Math.random() * WOBBLE) * dt, this._at);
        }

        rocket.puffDebt += PUFF_RATE * dt;
        while (rocket.puffDebt >= 1) {
          rocket.puffDebt -= 1;
          this._puff(this._at, this._jet);
        }

        this._unstick(rocket, dt);
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

  /**
   * Keeps it off the walls. Measured from where it actually got to rather than
   * from the solver's velocity, because being pinned and being slow look
   * identical to the solver and quite different on the floor: a body driving
   * itself into plaster has plenty of force on it and is going nowhere.
   */
  _unstick(rocket, dt) {
    const now = rocket.group.position;
    this._move.copy(now).sub(rocket.last);
    rocket.last.copy(now);

    if (rocket.recover > 0) {
      // Coming off a wall. Whatever it does in this window is the kick's doing,
      // not its own, and must not be mistaken for where it was trying to go.
      rocket.recover -= dt;
      rocket.stalled = 0;
      return;
    }

    const speed = this._move.length() / Math.max(dt, 1e-4);
    if (speed > STALL_SPEED) {
      rocket.heading.copy(this._move).normalize();
      rocket.stalled = 0;
      return;
    }

    rocket.stalled += dt;
    if (rocket.stalled < STALL_TIME) return;
    rocket.stalled = 0;
    rocket.recover = KICK_HOLD;

    // Back the way it came, upward, and never quite the same twice — two kicks
    // along the same line would just walk it up the wall.
    this._thrust.copy(rocket.heading).negate();
    this._thrust.y = Math.abs(this._thrust.y) + 0.9;
    this._thrust.x += (Math.random() - 0.5) * 1.2;
    this._thrust.z += (Math.random() - 0.5) * 1.2;
    this._thrust.normalize();

    // Applied a long way off centre, so it leaves spinning and the jet is
    // pointing somewhere else by the time it lands.
    this._at.set(
      now.x + (Math.random() - 0.5) * KICK_ARM,
      now.y + (Math.random() - 0.5) * KICK_ARM,
      now.z + (Math.random() - 0.5) * KICK_ARM);
    this.physics.impulse(rocket.handle, this._thrust, KICK, this._at);
  }

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
    // And a mark on the carpet underneath, which is the only part of this that
    // is still there in a minute's time. Clipped to the floor like any other, so
    // one going off in a doorway does not paint the wall it is up against.
    //
    // Exactly on the floor plane, not a hair above it: the clip probes for the
    // surface the mark claims to be lying on, and a mark floating two
    // centimetres over the carpet is correctly told it is lying on nothing.
    this._at.set(at.x, 0, at.z);
    this.effects.decal(this._at, this._up, 0.75);
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
      // The seat of the blast, so being caught by one points at the cylinder
      // rather than at nothing.
      this.hud?.damage(Math.min(1, damage / 25), at.x, at.z);
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
