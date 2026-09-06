import * as THREE from 'three';
import { CEIL_H } from './gen/layout.js';

/**
 * The washing machines, and the fact that they will not stand still.
 *
 * There is no explanation for one being in the corridor of an office block and
 * that is the joke. It is on an unbalanced spin cycle, it is losing, and it
 * hammers its way around the hallway hitting whatever is there. Shoot it and it
 * goes up.
 *
 * WHAT IT IS. A loose prop — `washingMachine` in gen/props.js — so almost
 * everything here comes for free from machinery that already exists, and that is
 * the whole reason it is built this way round:
 *
 *   - it has a cannon-es body, so the thrashing is REAL rather than animated.
 *     This module only shoves; where it ends up is the solver's business, which
 *     is why it skitters and turns and wedges itself against a wall.
 *   - it is already shootable, damageable and destructible (`userData.dynamic`
 *     → `damageProp`), already collides with the player and the staff off a
 *     collider game.js re-syncs every frame, and already puts water on the
 *     carpet, because the prop declares `spills: 'water'`.
 *   - it already breaks into the boxes it was authored from.
 *
 * So what is left for this file is the four things that are actually new: the
 * shoving, the racket, everything it does to what it hits, and the bang.
 *
 * TWO MODES, and the difference is one flag on the theme.
 *
 *   GROUNDED, everywhere. It kicks only when it is ON THE FLOOR, so the height
 *   is bounded by construction rather than by a number, and it comes out as a
 *   machine hammering its feet and skidding about.
 *
 *   FLYING, on an Automated floor (`washersFly`). It kicks whether or not it has
 *   landed, so the kicks accumulate and it climbs, spinning, up into the ceiling
 *   tiles. That is a thing a floor run by machines can have and an ordinary
 *   office cannot.
 *
 * The grounded check is a FIX, and the flying mode is what the fix turned out to
 * be worth keeping. The first version kicked on a timer alone and the arithmetic
 * says what happened: HOP over the body's mass is 3.6 m/s of upward kick, and
 * gravity needs 0.37 s to cancel that against a HOP_GAP of 0.14–0.30 s. So it
 * never landed — it climbed until it hit `MAX_LINEAR_SPEED` in physics.js and
 * hung there spinning against `MAX_ANGULAR_SPEED`, which is a helicopter. Those
 * two clamps are ceilings, not brakes, and something that saturates both of them
 * is not being simulated, it is being held. Worth knowing that a short
 * measurement PASSED this — 0.9 s of sampling showed a healthy 0.33 m hop,
 * because 0.9 s is not long enough to accumulate.
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

// ON THE FLOOR, for the purpose of being allowed to kick again. Both halves are
// needed and neither is enough: the height alone lets it kick on the way up
// through the band, and the velocity alone lets it kick at the top of an arc
// where it is momentarily not moving vertically at all.
const GROUND_LIFT = 0.09;   // metres above resting centre height
const GROUND_RISE = 0.7;    // m/s upward

// How fast it may spin. cannon's own MAX_ANGULAR_SPEED is a long way above
// anything that reads as a washing machine, so this is applied per kick on top
// of it — and it is the whole difference between rocking and autorotating.
const SPIN_CAP = 2.6;       // rad/s, grounded
const SPIN_CAP_FLY = 5.5;   // ...and airborne, where the spin IS the point
// Angular damping, set on the body directly rather than threaded through
// game.js's generic addBox. cannon's default 0.2 lets torque accumulate over
// dozens of kicks; a machine bolted to nothing still has a floor's worth of
// friction working on it.
const SPIN_DAMP = 0.72;

// How far it may wander from where the floor put it before it is shoved back.
// Not a wall — a soft bias added to the lateral kick — because a hard clamp on a
// physics body fights the solver, and the thing that must not happen is a
// machine that has hammered its way into somebody's office and out of the
// corridor the racket is meant to be in.
const LEASH = 1.9;
// How much room a flying one leaves itself under the ceiling before it stops
// kicking. DERIVED from `CEIL_H` rather than written down, which is the rule this
// repo has a monument to: the first version was a flat 1.75 on its centre, and
// measured over 40 simulated seconds the machine's top reached 2.92 m against a
// suspended ceiling at 3.0 — eight centimetres of margin, arrived at by
// accident. Raise the ceiling and that becomes a machine hovering inside the
// tiles.
//
// The headroom is generous because momentum is not bounded by a kick gate: the
// kicks stop here and the machine coasts on for most of a metre, which is what
// `_ceiling` is for.
const FLY_HEADROOM = 0.55;
// ...and how close the top gets to the tiles before it counts as hitting them.
const CEIL_CLEAR = 0.05;
// What is left of a rise when it meets the ceiling: reversed and mostly spent,
// so it comes off the tiles rather than grinding along under them.
const CEIL_BOUNCE = 0.35;
const CEIL_BOUNCE_MIN = 0.7;   // m/s, so a slow drift still comes back down

// --- what it does to whatever it hits --------------------------------------

// Below this the contact is the machine settling onto the floor, and voicing
// those would be a crash three times a second for the whole floor. Measured
// along the contact normal, so a hard landing counts and a slide does not.
const HIT_MIN = 1.6;        // m/s
// ...and the speed a hit is considered full force at, for the sound and the
// damage. A hop tops out around 3.6 m/s and a fall from the fly ceiling is
// faster, so this is comfortably reachable without being the common case.
const HIT_FULL = 5.5;

// One impact's blast. Deliberately TINY in radius next to an extinguisher's
// 4.6 m: this is a machine barging into the thing next to it, not an explosion,
// and the whole point is that the damage is where the impact was. It is routed
// through the same three calls an explosion uses because those already know how
// to damage static furniture, shove loose furniture and hurt bodies — a fourth
// way of doing it would be a fourth thing to get wrong.
const HIT_RADIUS = 1.15;
const HIT_PROP_DAMAGE = 26;   // to static furniture, at full force
const HIT_BODY_DAMAGE = 17;   // ...and to anybody standing in the way
const HIT_PUSH = 5.5;         // and the shove that goes into loose props
// What the player takes, which is well under what a body takes for the reason
// the extinguisher's blast is: you can see this coming and you are supposed to
// get out of its way, so being clipped by it is a warning rather than a third of
// your health.
const HIT_PLAYER_DAMAGE = 11;

// At most this often, per machine. A cannon body in contact with a wall fires
// `collide` every step it stays there, so without this a machine wedged in a
// corner is a hundred crashes a second and a hundred blasts with them.
const HIT_COOLDOWN = 0.22;

// The mark it leaves. Scaled by force, so a shunt scuffs and a full-speed slam
// leaves something you can see from down the corridor.
const MARK_MIN = 0.34;
const MARK_MAX = 0.85;

// The bang, when it is finally shot. Bigger than an extinguisher's on every axis,
// because it is a bigger object full of water and this is the payoff for having
// noticed it.
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
    this.flying = false;
    this._at = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._point = new THREE.Vector3();
    this._normal = new THREE.Vector3();
  }

  /**
   * Adopts this floor's machines.
   *
   * Called after the physics bodies have been made, because the shoving needs
   * `dyn.handle` — a machine adopted before that has nothing to push on and the
   * floor comes out with a silent, motionless washing machine in the corridor,
   * which is the one way this prop can fail without erroring.
   */
  spawn(level, theme) {
    this.clear();
    if (!level) return;
    this.flying = !!theme?.washersFly;

    for (const dyn of level.dynamics) {
      if (!dyn.washer) continue;
      const p = dyn.group.position;
      const m = {
        dyn,
        // Where the floor put it, which is what the leash is measured from.
        homeX: p.x,
        homeZ: p.z,
        // Its resting centre height, which is what "on the floor" is measured
        // against. Read off the body rather than assumed, so re-authoring the
        // prop taller cannot quietly break the grounded check.
        rest: dyn.size.y / 2,
        timer: Math.random() * HOP_GAP[1],
        // The racket starts on the first update rather than here, so a floor
        // generated before the player has clicked anything does not try to
        // start a voice the audio context will refuse. `sfx.loopAt` returns null
        // until it is ready and this is what retries.
        loop: null,
        hitWait: 0,
        onCeiling: false,
        gone: false,
        onCollide: null,
      };

      const body = dyn.handle?.body;
      if (body) {
        // A floor's worth of friction, which cannon's own default does not
        // provide — see SPIN_DAMP.
        body.angularDamping = SPIN_DAMP;
        // Everything it does to what it hits hangs off this. cannon fires it on
        // both bodies of a pair, so the machine hears about walls, furniture and
        // ragdolls alike without this file having to ask what any of them are.
        m.onCollide = (ev) => this._collide(m, ev);
        body.addEventListener('collide', m.onCollide);
      }

      this.items.push(m);
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

      if (m.hitWait > 0) m.hitWait -= dt;

      const p = m.dyn.group.position;

      // The racket follows it. Started late and retried, because the audio
      // context is not open until the player has clicked something.
      if (!m.loop) m.loop = this.audio?.startWasher(p.x, p.y, p.z) ?? null;
      else this.audio?.moveMotor(m.loop, p.x, p.y, p.z);

      // The ceiling, for a floor where they fly. This is where the marks on the
      // TILES come from: the suspended ceiling is geometry with no collider
      // behind it — the solver's own lid is metres higher, up with the roof (see
      // GUARD_MARGIN in physics.js) — so nothing would ever report this contact.
      // It is synthesised instead, which is honest here because the height it is
      // tested against IS the ceiling's own.
      if (this.flying) this._ceiling(m, p);

      // The spin ceiling, EVERY frame rather than only on a kick. Measured over
      // 30 simulated seconds with it applied at kick time only, a grounded
      // machine reached 3.79 rad/s against a cap of 2.6 — because most of what
      // spins it is not the kick, it is the collision response between kicks, and
      // a ceiling that is only checked when you happen to push is not a ceiling.
      this._capSpin(m);

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
    const body = m.dyn.handle?.body;
    if (!body) return;

    // WHETHER IT MAY KICK AT ALL, which is the whole of the two modes. A
    // grounded machine has to have landed first; a flying one only has to be
    // under the ceiling. See the header.
    if (this.flying) {
      if (p.y + m.rest > CEIL_H - FLY_HEADROOM) return;
    } else if (p.y > m.rest + GROUND_LIFT || body.velocity.y > GROUND_RISE) {
      return;
    }

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
    // Straight away, so the torque this kick just added is inside the ceiling
    // before the next step runs.
    this._capSpin(m);
  }

  /**
   * Holds the spin down.
   *
   * cannon's own MAX_ANGULAR_SPEED is a long way above anything that reads as a
   * washing machine, and `angularDamping` is a rate rather than a limit — it
   * slows a spin down but does not say how fast is too fast. This is the ceiling,
   * and it is what keeps the difference between a machine rocking on its feet and
   * a machine autorotating.
   */
  _capSpin(m) {
    const body = m.dyn.handle?.body;
    if (!body) return;
    const cap = this.flying ? SPIN_CAP_FLY : SPIN_CAP;
    const w = body.angularVelocity;
    const ws = Math.hypot(w.x, w.y, w.z);
    if (ws > cap) w.scale(cap / ws, w);
  }

  /**
   * A flying one meeting the tiles.
   *
   * `onCeiling` is what makes it one impact rather than one per frame for as long
   * as it is up there, the same job `hitWait` does for a real contact.
   */
  _ceiling(m, p) {
    const body = m.dyn.handle?.body;
    if (!body) return;
    if (p.y + m.rest < CEIL_H - CEIL_CLEAR) { m.onCeiling = false; return; }

    const rise = body.velocity.y;
    if (rise > 0) body.velocity.y = -Math.max(CEIL_BOUNCE_MIN, rise * CEIL_BOUNCE);
    if (m.onCeiling) return;
    m.onCeiling = true;

    // Force off the rise it arrived with, so drifting up leaves a scuff and
    // being flung into the tiles leaves a dent.
    const force = Math.min(1, Math.max(0, (rise - HIT_MIN) / (HIT_FULL - HIT_MIN)));
    // On the underside of the tiles, facing DOWN — which is the face they are
    // drawn on and the only face anybody can see (see buildShell in gen/shell.js).
    this._at.set(p.x, CEIL_H - 0.01, p.z);
    this._normal.set(0, -1, 0);
    this._impact(m, this._at, this._normal, force);
  }

  /**
   * It hit something.
   *
   * cannon fires `collide` on both bodies of a pair, so this hears about the
   * building, the furniture, the staff and a ragdoll's shin without having to
   * ask what any of them are — which is exactly what is wanted, because the
   * answer is the same for all of them: hurt what is there, mark what it hit,
   * and make a noise about it.
   *
   * The damage goes through the same three calls an explosion uses, at a radius
   * a quarter the size. That is a reuse rather than a shortcut: those three
   * already know how to damage a batched static prop, shove a loose one and hurt
   * a body on a falloff, and a fourth way of doing it would be a fourth thing to
   * get wrong. What makes it read as a collision rather than a bomb is the
   * radius and the fact that it happens at the contact point.
   */
  _collide(m, ev) {
    if (m.gone || m.hitWait > 0) return;

    const contact = ev.contact;
    if (!contact) return;
    // Along the normal, so a hard landing counts and a long slide down a wall
    // does not. cannon's sign depends on which body of the pair is which, so the
    // magnitude is what matters.
    const speed = Math.abs(contact.getImpactVelocityAlongNormal());
    if (!(speed > HIT_MIN)) return;

    m.hitWait = HIT_COOLDOWN;
    const force = Math.min(1, (speed - HIT_MIN) / (HIT_FULL - HIT_MIN));

    // WHERE it hit, in world space. `ri` is the contact point relative to the
    // first body of the pair, which cannon gives in world orientation already —
    // so this is the machine's centre plus that, and it is the difference
    // between a mark on the wall the machine struck and a mark in the middle of
    // the corridor.
    const p = m.dyn.group.position;
    const bodyIsSelf = ev.target === m.dyn.handle?.body;
    const r = bodyIsSelf ? contact.ri : contact.rj;
    this._at.set(p.x + (r?.x ?? 0), p.y + (r?.y ?? 0), p.z + (r?.z ?? 0));

    // ...and which way the surface faces, so the mark lies ON it. Flipped to
    // point back at the machine, which is the side of the wall it can be seen
    // from.
    const n = contact.ni;
    this._normal.set(n?.x ?? 0, n?.y ?? 1, n?.z ?? 0);
    if (this._normal.lengthSq() < 1e-6) this._normal.set(0, 1, 0);
    this._normal.normalize();
    if (this._normal.dot(this._up) < -0.99) this._normal.set(0, 1, 0);
    // The normal runs from one body to the other; the mark wants the face the
    // machine is on. Testing it against the direction back to the centre settles
    // it without knowing which body cannon put first.
    this._dir.set(p.x - this._at.x, p.y - this._at.y, p.z - this._at.z);
    if (this._normal.dot(this._dir) < 0) this._normal.negate();

    this._impact(m, this._at, this._normal, force);
  }

  /** Everything one impact does, once its point, facing and force are known. */
  _impact(m, at, normal, force) {
    // The noise. Two of them, and the second is the one the player will care
    // about: the crash is the machine, and `bulletHitFlesh` is what it just hit
    // if what it hit was a person. Asked BEFORE the splash rather than after,
    // so the thud and the scream are not a frame apart.
    this.audio?.washerCrash?.(at, force);
    // `anyNear` wants a level as well as a radius — its whole job elsewhere is
    // deciding whether a body walked over a carton, and a body in the attic
    // above one has not. The machine's own y is the right level to ask about.
    if (this.enemies?.anyNear?.(at.x, at.z, m.dyn.group.position.y, HIT_RADIUS)) {
      this.audio?.bulletHitFlesh?.(at);
    }

    // A mark on whatever it is. `decal` probes for the surface the mark claims
    // to be lying on and refuses if there is not one there (see `_reach` in
    // effects.js), so a contact in mid-air with a ragdoll silently leaves
    // nothing — which is right, and is why this is safe to call on every impact
    // without knowing what was struck. The wall, the floor and, on a floor where
    // they fly, the ceiling all come out of the same call.
    this.effects?.decal(at, normal, MARK_MIN + (MARK_MAX - MARK_MIN) * force);
    this.effects?.impact(at, normal, 0xdfe6ee, 0.6 + force);

    // And the damage, on a falloff, at a quarter of an explosion's reach.
    const k = 0.35 + force * 0.65;
    this.physics?.blast(at, HIT_RADIUS, HIT_PUSH * k);
    this.destruction?.blast(at, HIT_RADIUS, HIT_PROP_DAMAGE * k);
    this.enemies?.splash(at.x, at.z, HIT_RADIUS, HIT_BODY_DAMAGE * k, this.audio);

    const o = this.player?.object?.position;
    if (!o) return;
    const dist = Math.hypot(o.x - at.x, o.y - at.y, o.z - at.z);
    if (dist > HIT_RADIUS) return;
    const damage = HIT_PLAYER_DAMAGE * k * (1 - dist / HIT_RADIUS);
    if (damage <= 0) return;
    this.player.takeDamage(damage);
    // Pointed at the machine rather than at the contact point, because what the
    // player wants to be told is where the thing that hit them IS.
    const p = m.dyn.group.position;
    this.hud?.damage(Math.min(1, damage / 20), p.x, p.z);
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
    this._detach(m);

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
   * The collide listener off the body.
   *
   * It has to come off explicitly: `physics.reset()` drops the world and the
   * bodies with it, but a listener holds a closure over `m`, and a machine that
   * is `gone` while its body is mid-teardown would otherwise still be running
   * `_impact` against a level that has been disposed.
   */
  _detach(m) {
    const body = m.dyn.handle?.body;
    if (body && m.onCollide) body.removeEventListener('collide', m.onCollide);
    m.onCollide = null;
  }

  /**
   * Every voice off, every listener off, and the list emptied.
   *
   * The meshes, the bodies and the colliders are the level's and go with it —
   * this owns the loops and the listeners, which is exactly why it has to be the
   * thing that clears them: a floor is torn down without telling the audio
   * engine anything, and three positional loops would survive into the next one.
   */
  clear() {
    for (const m of this.items) {
      if (m.loop) this.audio?.stopMotor(m.loop);
      this._detach(m);
    }
    this.items.length = 0;
    this.flying = false;
  }
}
