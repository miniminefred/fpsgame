import * as THREE from 'three';

/**
 * The washing machines, and the fact that they will not stand still.
 *
 * There is no explanation for one being in the corridor of an office block and
 * that is the joke. It is on an unbalanced spin cycle, it is losing, and it is
 * hammering its way around the hallway making a noise you can hear two rooms
 * off. Shoot it and it goes up.
 *
 * WHAT IT IS. A loose prop — `washingMachine` in gen/props.js — so almost
 * everything here comes for free from machinery that already exists, and that is
 * the whole reason it is built this way round:
 *
 *   - it has a cannon-es body, so the thrashing is REAL rather than animated.
 *     This module only shoves; where it ends up is the solver's business, which
 *     is why it skitters and turns and wedges itself against a wall instead of
 *     doing a tidy little sine hop in place.
 *   - it is already shootable, damageable and destructible (`userData.dynamic`
 *     → `damageProp`), already collides with the player and the staff off a
 *     collider that game.js re-syncs every frame, and already puts water on the
 *     carpet when it is hit, because the prop declares `spills: 'water'`.
 *   - it already breaks into the boxes it was authored from.
 *
 * So what is left for this file is the three things that are actually new: the
 * shoving, the racket, and the bang.
 *
 * HOW IT KNOWS IT DIED. It watches `dyn.broken`, which destruction.js sets, and
 * fires on the frame it flips. There IS a hook that would be one frame earlier
 * (`onBreakProp`) and it is deliberately not used: game.js owns it for the co-op
 * wire, and a second consumer of a single-slot callback is how one of them
 * quietly stops being called. One frame of a sixtieth of a second is not visible
 * and this needs nothing from destruction.js at all.
 */

// How hard and how often it throws itself about. `HOP` is an impulse in
// newton-seconds against a 68 kg body, so roughly 3.6 m/s of upward kick — high
// enough to leave the floor and low enough that it does not clear its own
// height, which would read as the prop being launched rather than as a machine
// jumping.
const HOP = 245;
const HOP_GAP = [0.14, 0.30];
// Sideways, as a fraction of the hop. Small on purpose: it is the LATERAL shove
// that makes it travel, and a machine that crosses the corridor in five seconds
// has escaped rather than misbehaved.
const SKID = 0.22;
// ...and the lever arm the hop is applied through, which is what makes it rock
// and turn rather than rise flat. Measured from the body's centre, in metres,
// and cannon-es clamps it to the body's own radius anyway (see impulse in
// physics.js) — this is well inside that, because a hop applied at the very
// corner tips the thing straight over onto its side and it stops being a washing
// machine and becomes a fallen box.
const LEVER = 0.22;

// How far it may wander from where the floor put it before it is shoved back.
// Not a wall — a soft bias added to the lateral kick — because a hard clamp on a
// physics body fights the solver, and the thing that must not happen is a
// machine that has hammered its way into somebody's office and out of the
// corridor the racket is meant to be in.
const LEASH = 1.9;

// The bang. Bigger than an extinguisher's on every axis, because it is a bigger
// object full of water and this is the payoff for having noticed it.
const BLAST_RADIUS = 4.6;
const BLAST_DAMAGE = 46;
const BLAST_PUSH = 15;
const BLAST_PROP_DAMAGE = 55;

// Debris thrown up out of the drum. Two-thirds of the point of the explosion is
// that a washing machine is FULL of something, so it does not simply come apart
// into panels — it throws its load across the corridor as well.
const WASH_BITS = [7, 11];

export class Washers {
  constructor({ scene, audio, effects, physics, destruction, enemies, player, hud }) {
    this.scene = scene;
    this.audio = audio;
    this.effects = effects;
    this.physics = physics;
    this.destruction = destruction;
    this.enemies = enemies;
    this.player = player;
    this.hud = hud;

    this.items = [];
    this._at = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._point = new THREE.Vector3();
  }

  /**
   * Adopts this floor's machines.
   *
   * Called after the physics bodies have been made, because the shoving needs
   * `dyn.handle` — a machine adopted before that has nothing to push on and the
   * floor comes out with a silent, motionless washing machine in the corridor,
   * which is the one way this prop can fail without erroring.
   */
  spawn(level) {
    this.clear();
    if (!level) return;
    for (const dyn of level.dynamics) {
      if (!dyn.washer) continue;
      const p = dyn.group.position;
      this.items.push({
        dyn,
        // Where the floor put it, which is what the leash is measured from.
        homeX: p.x,
        homeZ: p.z,
        timer: Math.random() * HOP_GAP[1],
        // The racket starts on the first update rather than here, so a floor
        // generated before the player has clicked anything does not try to
        // start a voice the audio context will refuse. `sfx.loopAt` returns null
        // until it is ready and this is what retries.
        loop: null,
        gone: false,
      });
    }
  }

  update(dt) {
    if (!this.items.length) return;

    for (const m of this.items) {
      if (m.gone) continue;

      // Destroyed, this frame or a previous one. `broken` is destruction.js's
      // own flag and is set before the prop's pieces are thrown, so the position
      // read here is still the machine's.
      if (m.dyn.broken) {
        this._explode(m);
        continue;
      }

      const p = m.dyn.group.position;

      // The racket follows it. Started late and retried, because the audio
      // context is not open until the player has clicked something.
      if (!m.loop) m.loop = this.audio?.startWasher(p.x, p.y, p.z) ?? null;
      else this.audio?.moveMotor(m.loop, p.x, p.y, p.z);

      m.timer -= dt;
      if (m.timer > 0) continue;
      m.timer = HOP_GAP[0] + Math.random() * (HOP_GAP[1] - HOP_GAP[0]);
      this._hop(m, p);
    }

    // Compacted rather than spliced inside the loop above, which is the same
    // reason `_finish` in jobs.js copies its list: a machine removes itself.
    if (this.items.some((m) => m.gone)) {
      this.items = this.items.filter((m) => !m.gone);
    }
  }

  /**
   * One kick.
   *
   * Mostly up, a little sideways, and applied off-centre so the body rocks. The
   * lateral direction is a random bearing biased back toward where the machine
   * started, which is the leash: at the home spot the bias is nothing and the
   * kick is a pure random walk, and the further out it has hammered the more of
   * the kick points home. A machine therefore mills about its own patch of
   * corridor for ever without anything ever hard-clamping its position.
   */
  _hop(m, p) {
    const away = Math.hypot(p.x - m.homeX, p.z - m.homeZ);
    const pull = Math.min(1, away / LEASH);

    const a = Math.random() * Math.PI * 2;
    let lx = Math.cos(a);
    let lz = Math.sin(a);
    if (away > 1e-3) {
      // Toward home, weighted by how far out it is.
      lx = lx * (1 - pull) + ((m.homeX - p.x) / away) * pull;
      lz = lz * (1 - pull) + ((m.homeZ - p.z) / away) * pull;
    }

    this._dir.set(lx * SKID, 1, lz * SKID).normalize();
    // Off-centre, on a random side, which is where the rocking and the turning
    // come from. Kept well inside the body's radius — see LEVER.
    this._point.set(
      p.x + (Math.random() - 0.5) * 2 * LEVER,
      p.y,
      p.z + (Math.random() - 0.5) * 2 * LEVER,
    );
    this.physics?.impulse(m.dyn.handle, this._dir, HOP, this._point);
  }

  /**
   * It goes up.
   *
   * The same event routed the same five ways an extinguisher's is — see `_burst`
   * in extinguishers.js, which this deliberately mirrors rather than reinventing:
   * loose furniture is thrown, static furniture is damaged (so one of these takes
   * out the desks around it), anybody standing in it is hurt on a falloff, the
   * player is hurt and told which direction it came from, and there is a mark on
   * the carpet afterwards.
   *
   * What is different is the water and the wash. A washing machine is full of
   * both, so the burst spills the big puddle rather than the small one and throws
   * a load of debris up out of the drum on top of the panels destruction.js is
   * already scattering.
   */
  _explode(m) {
    m.gone = true;

    // The loop stops FIRST. A voice left running on a prop that no longer exists
    // is a racket coming out of an empty corridor for the rest of the floor, and
    // nothing else in the game would ever clear it.
    if (m.loop) { this.audio?.stopMotor(m.loop); m.loop = null; }

    const p = m.dyn.group.position;
    this._at.set(p.x, p.y, p.z);
    const at = this._at;

    this.audio?.washerBurst(at);
    this.effects?.impact(at, this._up, 0xdff4ff, 6);

    // On the floor under it, not at the body's centre — the clip probe looks for
    // the surface a mark claims to be lying on, and one floating half a metre up
    // is correctly told it is lying on nothing.
    this._point.set(at.x, 0, at.z);
    this.effects?.decal(this._point, this._up, 0.8);

    // The drum's contents. Thrown from the machine's own middle so they come out
    // of it rather than off the floor beside it.
    const bits = WASH_BITS[0] + ((Math.random() * (WASH_BITS[1] - WASH_BITS[0] + 1)) | 0);
    for (let i = 0; i < bits; i++) {
      this._dir.set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5)
        .normalize();
      this.effects?.impact(at, this._dir, 0xe8e4d8, 0.8);
    }

    this.physics?.blast(at, BLAST_RADIUS, BLAST_PUSH);
    this.destruction?.blast(at, BLAST_RADIUS, BLAST_PROP_DAMAGE);
    this.enemies?.splash(at.x, at.z, BLAST_RADIUS, BLAST_DAMAGE, this.audio);

    const o = this.player?.object?.position;
    if (o) {
      const dist = Math.hypot(o.x - at.x, o.y - at.y, o.z - at.z);
      if (dist < BLAST_RADIUS) {
        const damage = BLAST_DAMAGE * (1 - dist / BLAST_RADIUS);
        this.player.takeDamage(damage);
        // The seat of the blast, so being caught by one points at the machine
        // rather than at nothing.
        this.hud?.damage(Math.min(1, damage / 25), at.x, at.z);
      }
    }
  }

  /**
   * Every voice off, and the list emptied.
   *
   * The meshes, the bodies and the colliders are the level's and go with it —
   * this owns nothing but the loops, which is exactly why it has to be the thing
   * that stops them: a floor is torn down without telling the audio engine
   * anything, and three positional loops would survive into the next one.
   */
  clear() {
    for (const m of this.items) {
      if (m.loop) this.audio?.stopMotor(m.loop);
    }
    this.items.length = 0;
  }
}
