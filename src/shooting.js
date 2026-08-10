import * as THREE from 'three';

// Hitscan shooting: fire rate, ammo/reload, spread, camera recoil, damage.
//
// Every shot raycasts from the camera center (where the crosshair is) rather
// than from the muzzle, so what you point at is what you hit; the tracer is
// then drawn from the muzzle to the impact point for looks. Shotguns fire
// `pellets` rays per trigger pull, each with its own spread offset.

const RECOIL_RECOVER = 7;     // radians/s the view drifts back down after kick
const HIT_COLOR = 0xff6b5a;   // impact flash on a drone
const WORLD_COLOR = 0xffe0a0; // impact flash on world geometry
const PITCH_LIMIT = 1.5;      // ~86°: recoil must not tip the view past vertical
const IMPULSE = 7;            // N·s per unit of weapon punch, into loose props

// Inside this many metres a killing shot is worth its weapon's full `throwMul`;
// from here it fades to nothing at the weapon's own `throwTo`. See throwPunch.
const THROW_NEAR = 3;

export class Shooting {
  constructor({ camera, controls, keys, weapons, effects, enemies, hud, audio, physics, casings }) {
    this.camera = camera;
    this.controls = controls;
    this.keys = keys;
    this.weapons = weapons;
    this.effects = effects;
    this.enemies = enemies;
    this.hud = hud;
    this.audio = audio;
    this.physics = physics;
    this.casings = casings;

    // Everything a bullet can stop on. Rebuilt for each floor — see
    // setHittables, called by the game when a level loads.
    this.hittables = [];
    this.onKill = null;
    // Set by the game: (dyn, dir, point, damage) => void for loose props, and
    // (hit, dir, damage) => boolean for batched level geometry, where the
    // return says whether the thing hit was destructible.
    this.onPropHit = null;
    this.onSurfaceHit = null;
    // (cam, damage, point, normal) => boolean — true if that shot destroyed it.
    this.onCameraHit = null;
    // Gunfire is loud: enemies out of sight use this to come looking.
    this.noise = 0;

    this.raycaster = new THREE.Raycaster();
    this.cooldown = 0;          // seconds until the next shot is allowed
    this.reloadLeft = 0;
    this.viewKick = 0;          // pitch we've added and still owe back
    this.kills = 0;
    this.hits = 0;

    // Ammo per weapon slot; the reserve is effectively infinite. Filled by
    // refill() below, which is also what every new floor calls.
    this.mags = new Array(weapons.count).fill(0);

    this._aim = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._end = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    // PointerLockControls keeps the camera in YXZ, so reading pitch back the
    // same way lets us clamp recoil without fighting the controls.
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    this.refill();
  }

  get mag() { return this.mags[this.weapons.active]; }
  get reloading() { return this.reloadLeft > 0; }

  /**
   * Full magazines in everything, and nothing left half-loaded.
   *
   * Called on arrival at every floor (see game.js). The reserve was always
   * infinite, so this is not about supply — it is about not carrying the last
   * thirty seconds of the previous floor into the first thirty of the next one.
   * Coming out of the lift with an empty shotgun is a floor that opens by taking
   * a decision away from you rather than giving you one.
   *
   * The rig's own reload animation is stood down too, or a descent taken
   * mid-reload arrives with the gun still dipped over a magazine that is already
   * full.
   */
  refill() {
    for (let i = 0; i < this.mags.length; i++) this.mags[i] = this.weapons.statsAt(i).mag;
    this.reloadLeft = 0;
    this.weapons.startReload(0);
    this._syncHud();
  }

  // Called once per floor with that floor's geometry plus its enemies.
  setHittables(list) {
    this.hittables = list;
  }

  // Anybody who was not on the floor when it was generated — the security
  // response to an alarm. Without this a body that arrived late is one bullets
  // go straight through, which looks exactly like a broken gun.
  addHittables(meshes) {
    if (meshes?.length) this.hittables.push(...meshes);
  }

  // A destroyed prop's meshes leave the scene graph but their matrices don't
  // update any more, so leaving them in the raycast list would leave an
  // invisible collider hanging in the air where the prop used to be.
  removeHittables(meshes) {
    const drop = new Set(meshes);
    this.hittables = this.hittables.filter((m) => !drop.has(m));
  }

  update(dt) {
    const stats = this.weapons.stats;

    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.noise > 0) this.noise -= dt;

    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        this.mags[this.weapons.active] = stats.mag;
        this._syncHud();
      }
    }

    // Recoil recovery: pull the view back down toward where it was aimed.
    if (this.viewKick > 0) {
      const back = Math.min(this.viewKick, RECOIL_RECOVER * dt * (0.4 + this.viewKick * 6));
      this._pitch(-back);
      this.viewKick -= back;
    }

    const pressed = this.keys.firePressed;
    this.keys.firePressed = false;   // consume the edge either way

    if (!this.controls.isLocked && !this.controls.engaged) return;

    if (this.keys.reload) this.reload();

    const wantsFire = stats.auto ? this.keys.fire : pressed;
    if (!wantsFire || this.cooldown > 0 || this.reloading) return;

    if (this.mag <= 0) {
      // Empty: click on the trigger edge, then start reloading automatically.
      if (pressed) this.audio.dryFire();
      this.reload();
      return;
    }

    this._fire(stats);
  }

  reload() {
    const stats = this.weapons.stats;
    if (this.reloading || this.mag >= stats.mag) return;
    this.reloadLeft = stats.reload;
    this.weapons.startReload(stats.reload);
    this.audio.reload(stats.reload);
    this._syncHud();
  }

  // Called when the player switches weapons — the HUD ammo must follow, and a
  // half-finished reload on the old gun is dropped.
  onWeaponChange() {
    this.reloadLeft = 0;
    this.cooldown = Math.max(this.cooldown, 0.25);   // brief swap delay
    this.audio.weaponSwitch();
    this._syncHud();
  }

  _fire(stats) {
    this.mags[this.weapons.active]--;
    this.cooldown = 60 / stats.rpm;
    this.noise = 1.5;

    this.weapons.fired();
    this.weapons.muzzleWorld(this._muzzle);
    this.audio.playerShot(stats);
    this.casings?.eject(this.camera, this._muzzle);

    this.camera.getWorldPosition(this._origin);
    this.camera.getWorldDirection(this._aim);

    let hitAny = false;
    let killedAny = false;

    for (let p = 0; p < stats.pellets; p++) {
      // Spread: nudge the aim inside a small cone. The first pellet of a
      // multi-pellet shot still gets spread — shotguns are never pinpoint.
      this._dir.copy(this._aim);
      if (stats.spread > 0) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * stats.spread;
        this._dir.x += Math.cos(a) * r;
        this._dir.y += Math.sin(a) * r;
        this._dir.z += (Math.random() - 0.5) * r * 0.2;
        this._dir.normalize();
      }

      const result = this._trace(this._origin, this._dir, stats);
      if (result === 'kill') { hitAny = true; killedAny = true; }
      else if (result === 'hit') hitAny = true;
    }

    // View kick, applied on the camera's local X so it's independent of yaw.
    this.viewKick += this._pitch(stats.kick * (0.8 + Math.random() * 0.4));

    if (hitAny) {
      this.hits++;
      if (killedAny) { this.kills++; this.onKill?.(); }
      this.hud.hitmarker(killedAny);
      this.audio.ping(killedAny);
    }

    this._syncHud();
  }

  // Casts one ray, draws its tracer/impact, and applies damage. Returns
  // 'kill' | 'hit' | null.
  _trace(origin, dir, stats) {
    this.raycaster.set(origin, dir);
    this.raycaster.far = stats.range;
    const hits = this.raycaster.intersectObjects(this.hittables, false);

    for (const hit of hits) {
      const enemy = hit.object.userData.enemy;

      // Bodies stay in the raycast list while they topple — shoot straight
      // through them rather than wasting the round on a corpse.
      if (hit.object.userData.isEnemyPart && !enemy) continue;

      if (hit.face) {
        this._normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      } else {
        this._normal.copy(dir).negate();   // no face data — face the shooter
      }

      this.effects.tracer(this._muzzle, hit.point);

      // What is left of the round at this range. Only the shotgun declares a
      // falloff: a pellet is a ball of soft lead with no ballistic profile
      // whatsoever, and everything else here is a rifle round that does not care
      // how far away you were standing.
      const damage = stats.damage * falloff(hit.distance, stats);

      if (enemy) {
        // The direction, the contact point and the weight of the shot go with
        // the damage: if this is the shot that kills them, it is all of what the
        // ragdoll is thrown by.
        const outcome = this.enemies.hit(hit.object, damage, dir, hit.point,
          throwPunch(stats, hit.distance));
        this.effects.impact(hit.point, this._normal, HIT_COLOR);
        this.audio.bulletHitFlesh(hit.point);
        // The vocal is played from here rather than from enemies.hit, because
        // this is the only place that still knows who was shot: a kill clears
        // the enemy off its own hitboxes on the way out.
        if (outcome === 'kill') this.audio.enemyDeath(enemy);
        else if (outcome === 'hit') this.audio.enemyPain(enemy);
        return outcome;
      }

      // A security camera or a laser emitter. One round each — see cameras.js —
      // so this either kills it, which earns the marker, or it is already dead
      // and falls through to be treated as the piece of wall furniture it now
      // is.
      const cctv = hit.object.userData.cctv;
      if (cctv && this.onCameraHit?.(cctv, damage, hit.point, this._normal)) return 'hit';

      // Loose furniture takes the hit as a shove. Heavier-hitting guns move it
      // further, which is what makes a shotgun feel like a shotgun.
      const dyn = hit.object.userData.dynamic;
      if (dyn) {
        this.physics?.impulse(dyn.handle, dir, IMPULSE * stats.punch, hit.point);
        // The impact sound comes back through onPropHit, which is the only side
        // that knows what the prop is made of.
        this.onPropHit?.(dyn, dir, hit.point, damage);
      }

      this.effects.impact(hit.point, this._normal, WORLD_COLOR);

      // Everything else on the floor is either destructible or it is the
      // building. Only the building keeps a bullet hole: a decal on a desk
      // outlives the desk, and hangs in the air once it has been shot apart.
      // It is also the only thing that sounds like a wall — a destructible
      // answers in its own material, from destruction.js.
      if (!dyn && !this.onSurfaceHit?.(hit, dir, damage)) {
        this.effects.decal(hit.point, this._normal);
        this.audio.bulletHitWall(hit.point, this._normal);
      }
      return null;
    }

    // Nothing hit — run the tracer out to the weapon's max range.
    this._end.copy(origin).addScaledVector(dir, stats.range);
    this.effects.tracer(this._muzzle, this._end);
    return null;
  }

  // Pitches the view by `delta` radians (positive = up), clamped to just short
  // of vertical. Returns how much was actually applied, so recoil recovery
  // never owes back more than it took.
  _pitch(delta) {
    this._euler.setFromQuaternion(this.camera.quaternion);
    const target = THREE.MathUtils.clamp(this._euler.x + delta, -PITCH_LIMIT, PITCH_LIMIT);
    const applied = target - this._euler.x;
    if (applied !== 0) this.camera.rotateX(applied);
    return applied;
  }

  _syncHud() {
    this.hud.setAmmo(this.mag, this.weapons.stats.mag, this.reloading);
    this.hud.setScore(this.kills, this.hits);
  }
}

/**
 * How much of a round's damage survives the distance it travelled. Flat 1 for
 * anything that does not declare a falloff.
 *
 * This is the second half of what makes the shotgun a shotgun. The first half is
 * the cone, which is what makes it miss at range; this is what makes the pellets
 * that DO land at range stop mattering. Either one alone gives you a gun that is
 * merely inaccurate or merely weak — together they give you one that owns a
 * doorway and embarrasses you across an open floor.
 */
/**
 * How hard a killing shot throws the body it lands in — the weapon's own weight,
 * multiplied up as the range closes. ragdolls.js spends it; see HIT_IMPULSE.
 *
 * Range is in it because the same shotgun shell is two completely different
 * events at two metres and at twenty, and only one of them should take somebody
 * off their feet. But the range each gun keeps it over is the gun's own
 * (`throwTo`), not one shared curve, because that IS the difference between
 * them: the shotgun owns a doorway and nothing further, and the sniper is a
 * rifle round that arrives across the floor with everything it left with. Two
 * guns that throw bodies, and you have to be in two completely different places
 * to see either of them do it.
 *
 * It is deliberately not the damage falloff above: that is about what a
 * spreading pattern still has left, and this is about how much of the shot the
 * body absorbed at once. The curve is linear rather than inverse-square for the
 * same reason blast is — the honest one puts everything in the last metre and
 * leaves every other range looking identical.
 */
function throwPunch(stats, distance) {
  const to = stats.throwTo ?? THROW_NEAR;
  const k = clamp01((to - distance) / Math.max(0.01, to - THROW_NEAR));
  return (stats.punch ?? 1) * (1 + ((stats.throwMul ?? 1) - 1) * k);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function falloff(distance, stats) {
  const from = stats.falloffFrom;
  if (!from || !(distance > from)) return 1;
  const k = Math.min(1, (distance - from) / Math.max(0.01, stats.falloffTo - from));
  return 1 + (stats.falloffMin - 1) * k;
}
