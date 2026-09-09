import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getFx } from './fx-textures.js';

// Classic FPS loadout, light -> heavy. Number keys 1..5 select these in order.
//
// Viewmodel fields: `length` is the target on-screen barrel length (view-space
// units) — heavier guns are drawn a little bigger; `flip` reverses the
// auto-detected muzzle direction; `yaw` is a small cosmetic angle offset.
//
// Combat fields: `rpm` rounds/minute, `auto` holds-to-fire, `damage` per
// projectile, `pellets` projectiles per shot, `spread` cone half-angle in
// radians, `kick` view recoil per shot in radians, `mag`/`reload` ammo handling,
// `sound` the clip in the sound library this gun fires (see audio.js).
//
// `throwMul`/`throwTo` are how hard a KILLING shot throws the body, and over
// what range that survives — the point-blank multiplier on the gun's `punch`,
// and the distance at which there is nothing left of it. They are per-weapon
// rather than one curve because the two heavy guns are heavy in different
// shapes: a shotgun is devastating in a doorway and irrelevant across a room,
// and a rifle round reaching thirty metres arrives with everything it left
// with. A pistol barely gets to do this at all, which is what makes it read as
// a pistol. See throwPunch in shooting.js.
/**
 * The spray can in slot 1, built in code because there is no GLB of one.
 *
 * Authored at its FINAL on-screen size -- 26 mm across and 118 mm tall, a real
 * 400 ml can -- which is what `raw` on the config buys: see `buildWeaponRig`.
 *
 * TILTED, not upright and not levelled like a barrel. A can held straight up is
 * a can somebody is carrying; a can held like a pistol is a gun. What reads as
 * spraying is the middle: the body leant forward so the top comes into the
 * frame and the nozzle points roughly where the crosshair is, which is also how
 * you hold one at a wall.
 *
 * The nozzle is a real stub sticking out of the cap rather than a mark on it,
 * for one concrete reason: `measureMuzzle` averages the frontmost slice of
 * geometry to find where the hiss comes from, so the front-most thing on the
 * model has to BE the nozzle.
 *
 * Its own paint is the colour it sprays (PAINT_COLOUR), because a can whose
 * label does not match what comes out of it is a prop nobody can read.
 */
function sprayCan() {
  const R = 0.026, H = 0.118;
  const steel = new THREE.MeshLambertMaterial({ color: 0xd8dade });
  const label = new THREE.MeshLambertMaterial({ color: PAINT_COLOUR });
  const cap = new THREE.MeshLambertMaterial({ color: 0x2b2e33 });

  const can = new THREE.Group();
  const add = (geo, mat, y, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(0, y, z);
    can.add(m);
    return m;
  };

  // Body, with the label band round the middle and a bare strip of steel top
  // and bottom -- the same reasoning as the drinks in drinks.js: the band is
  // what says which colour, and the bare metal is what says it is a can.
  add(new THREE.CylinderGeometry(R, R, H, 20), steel, 0);
  add(new THREE.CylinderGeometry(R * 1.02, R * 1.02, H * 0.46, 20), label, 0);
  // Rolled rim at each end, which is most of what stops it reading as a tube.
  add(new THREE.CylinderGeometry(R * 1.05, R * 1.05, 0.006, 20), steel, H / 2 - 0.003);
  add(new THREE.CylinderGeometry(R * 1.05, R * 1.05, 0.006, 20), steel, -H / 2 + 0.003);
  // Shoulder into the cap.
  add(new THREE.CylinderGeometry(R * 0.62, R, 0.014, 20), steel, H / 2 + 0.007);
  add(new THREE.CylinderGeometry(R * 0.62, R * 0.62, 0.016, 16), cap, H / 2 + 0.022);
  // ...and the nozzle, the frontmost thing on the model. See `measureMuzzle`.
  const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.016, 8), cap);
  stub.rotation.x = Math.PI / 2;
  stub.position.set(0, H / 2 + 0.026, -0.012);
  can.add(stub);

  can.traverse((o) => { if (o.isMesh) o.castShadow = false; });

  // Leant forward so the nozzle comes round to the front. Wrapped rather than
  // rotated in place so `buildWeaponRig` still measures and centres the whole
  // can rather than a tilted bounding box of one part of it.
  const held = new THREE.Group();
  held.add(can);
  held.rotation.x = -0.95;
  return held;
}

/**
 * What the can is full of, and the one colour on the floor that is the player's
 * rather than the building's.
 *
 * It is deliberately NOT on the visor ramp and does not have to be, even though
 * it also lands on people: `flashSet` in rigs.js picks the materials a hit flash
 * whitens by filtering for `emissive`, which excludes a visor because a visor is
 * MeshBasicMaterial. So paint tints somebody's clothes and never their eyes, and
 * "hue says threat, shade says which one" survives a floor covered in it.
 */
export const PAINT_COLOUR = 0xff2d95;

const WEAPONS = [
  {
    // SLOT 1 IS NOT A GUN. It paints, it does no damage at all, and everything
    // that follows from that is deliberate:
    //
    //   damage 0    so it is never a way to clear a floor. The player carries
    //               all five slots from the first floor (there is no unlock
    //               anywhere in this table), so the SMG next door is still the
    //               starting weapon and nothing about the difficulty moved.
    //   range 3.2   a can's throw and no further. It is the one weapon you have
    //               to walk up to something to use.
    //   auto        a held trigger, because drawing is a stroke rather than a
    //               shot -- `spread` is what gives it a cone to lay down.
    //   flash false a hiss and no muzzle flash: see `fired`.
    //   paint       the one flag shooting.js branches on. See `_trace`.
    //
    // `raw` and `build` are the other half of it: this is the only weapon in the
    // game with no GLB, so it is authored in code at its final on-screen size.
    // See `sprayCan` and the `raw` path in `buildWeaponRig`.
    name: 'Spray Can', build: sprayCan, raw: true, length: 0.13, flip: false, yaw: 0,
    rpm: 780, auto: true, damage: 0, pellets: 1, spread: 0.055,
    kick: 0.002, punch: 0, throwMul: 0, throwTo: 1, mag: 200, reload: 1.6, range: 3.2,
    sound: 'extinguisher-jet', flash: false, paint: true,
  },
  {
    name: 'SMG', file: 'models/2_smg.glb', length: 0.42, flip: false, yaw: 0,
    rpm: 900, auto: true, damage: 16, pellets: 1, spread: 0.019,
    kick: 0.011, punch: 0.65, throwMul: 1.1, throwTo: 5, mag: 30, reload: 1.4, range: 160,
    sound: 'smg-fire',
  },
  {
    // The one gun with a range profile rather than a range number. Up close it
    // is the most lethal thing you own — twelve pellets at 26 puts down anything
    // on the roster in one trigger pull. Past a few metres the cone opens and
    // each pellet softens, so the same shot that erases a Reanimated at two
    // metres is an irritation at fifteen. See `falloff` in shooting.js.
    name: 'Shotgun', file: 'models/3_shotgun.glb', length: 0.58, flip: false, yaw: 0,
    rpm: 75, auto: false, damage: 26, pellets: 12, spread: 0.095,
    falloffFrom: 4, falloffTo: 18, falloffMin: 0.25,
    kick: 0.055, punch: 1.35, throwMul: 2.1, throwTo: 7, mag: 6, reload: 2.4, range: 45,
    sound: 'shotgun-fire',
  },
  {
    name: 'Assault Rifle', file: 'models/4_assault_rifle.glb', length: 0.62, flip: false, yaw: 0,
    rpm: 620, auto: true, damage: 26, pellets: 1, spread: 0.011,
    kick: 0.019, punch: 0.95, throwMul: 1.35, throwTo: 12, mag: 30, reload: 1.9, range: 300,
    sound: 'rifle-fire',
  },
  {
    name: 'Sniper Rifle', file: 'models/5_sniper.glb', length: 0.80, flip: false, yaw: 0,
    rpm: 48, auto: false, damage: 130, pellets: 1, spread: 0.0008,
    kick: 0.06, punch: 1.4, throwMul: 2.0, throwTo: 34, mag: 5, reload: 2.8, range: 500,
    sound: 'sniper-fire',
  },
];

// Viewmodel anchor in camera space. The horizontal offset is computed from the
// frustum width (see _computeX) so the gun keeps the same relative spot and
// doesn't clip off-screen in narrow/portrait views; y and z are fixed.
const HAND_Y = -0.26;
const HAND_Z = -0.5;
const X_FRAC = 0.52; // fraction of the horizontal half-frustum to sit from center
const X_MAX = 0.32;  // cap so wide/ultrawide keeps the (fine) widescreen placement

// Viewmodel recoil: the gun snaps back along +z and pitches up, then springs
// home. These are the visual counterpart to the camera kick in shooting.js.
const RECOIL_BACK = 0.055;    // units the gun slides toward the camera per shot
const RECOIL_PITCH = 0.16;    // radians the muzzle rises per shot
const RECOIL_RETURN = 9;      // spring stiffness (1/s) pulling recoil back to 0
const RECOIL_MAX = 1.6;       // cap on accumulated recoil so it can't fold up

const FLASH_TIME = 0.045;     // seconds the muzzle flash stays lit

export class Weapons {
  constructor(camera, onChange) {
    this.camera = camera;
    this.onChange = onChange;      // (index, name) => void, for the HUD
    this.rigs = new Array(WEAPONS.length).fill(null);
    // Where each gun's barrel ends, in that gun's rig space. Measured off the
    // geometry once the model lands — see measureMuzzle.
    this.muzzles = new Array(WEAPONS.length).fill(null);
    this.active = 0;
    this.count = WEAPONS.length;
    this.handX = this._computeX();
    this.recoil = 0;               // 0..RECOIL_MAX, decays every frame
    this.flash = 0;                // remaining muzzle-flash time
    this.reloadTime = 0;
    this.reloadLeft = 0;

    this._muzzle = new THREE.Vector3();
    this._buildMuzzleFlash();

    const loader = new GLTFLoader();
    WEAPONS.forEach((w, i) => {
      // Built in code rather than fetched. Straight to the same `_onLoaded` a
      // GLB lands in, so the rig, the muzzle measurement and the swap all work
      // on it exactly as they do on the other four -- and /dev-guns.html, which
      // drives this same builder, shows it beside them without knowing.
      if (w.build) { this._onLoaded(i, w, w.build()); return; }
      loader.load(
        w.file,
        (gltf) => this._onLoaded(i, w, gltf.scene),
        undefined,
        (err) => console.error(`Failed to load ${w.file}`, err)
      );
    });

    this.onChange?.(this.active, WEAPONS[this.active].name);
  }

  // Combat stats for the equipped weapon, and for any slot.
  get stats() { return WEAPONS[this.active]; }
  statsAt(index) { return WEAPONS[index]; }

  _onLoaded(i, cfg, model) {
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;      // viewmodels shouldn't cast into the world
        o.frustumCulled = false;   // always draw — it hugs the near plane
        o.renderOrder = 999;
      }
    });

    const rig = buildWeaponRig(cfg, model);
    rig.position.set(this.handX, HAND_Y, HAND_Z);
    rig.visible = i === this.active;

    this.camera.add(rig);
    this.rigs[i] = rig;
    this.muzzles[i] = measureMuzzle(rig, cfg);
  }

  /**
   * The muzzle flash, parented to the camera so it stays welded to a barrel that
   * is swinging around in front of the face. Three parts, because a flash is not
   * one thing:
   *
   *   star   the burn itself, spun to a new angle every shot
   *   halo   a soft ball of light around it, which is what makes the star read
   *          as bright rather than as a picture of a star
   *   plume  a stubby cone thrown forward down the barrel line, so the flash has
   *          somewhere to go instead of hanging flat in the air
   *
   * Plus a point light, which is the only part of it that touches the room.
   */
  _buildMuzzleFlash() {
    const { group, halo, star, plume } = makeMuzzleFlash();
    this.flashGroup = group;
    this.flashHalo = halo;
    this.flashStar = star;
    this.flashPlume = plume;
    // Drawn over the world and never clipped by it: the viewmodel hugs the near
    // plane, and a flash that depth-tests against a wall you are standing next
    // to disappears into it.
    for (const part of [halo, star, plume]) {
      part.material.depthTest = false;
      part.renderOrder = 1000;
    }
    this.flashGroup.visible = false;
    this.camera.add(this.flashGroup);

    // A brief light so the flash also brushes nearby geometry.
    this.flashLight = new THREE.PointLight(0xffc36a, 0, 8, 2);
    this.camera.add(this.flashLight);
  }

  // Horizontal offset as a fraction of the frustum half-width at the gun's
  // depth, capped so widescreen keeps its placement and narrow views pull in.
  _computeX() {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const halfWidth = Math.abs(HAND_Z) * Math.tan(vFov / 2) * this.camera.aspect;
    return Math.min(X_FRAC * halfWidth, X_MAX);
  }

  // Reposition the viewmodel after an aspect-ratio change (call on resize).
  layout() {
    this.handX = this._computeX();
    for (const rig of this.rigs) if (rig) rig.position.x = this.handX;
  }

  select(index) {
    if (index < 0 || index >= this.count || index === this.active) return;
    this.active = index;
    this.rigs.forEach((rig, i) => { if (rig) rig.visible = i === index; });
    this.recoil = 0;
    this.reloadLeft = 0;           // switching cancels an in-progress reload
    this._resetRig(this.rigs[index]);
    this.onChange?.(index, WEAPONS[index].name);
  }

  /**
   * Muzzle tip in camera space. Taken through the rig's live transform rather
   * than from a fixed offset, so the flash and the tracer both leave the barrel
   * where the barrel actually is this frame — mid-recoil, mid-reload, mid-swing.
   */
  muzzleLocal(out = this._muzzle) {
    const rig = this.rigs[this.active];
    const local = this.muzzles[this.active];
    if (!rig || !local) {
      return out.set(this.handX, HAND_Y, HAND_Z - this.stats.length * 0.5);
    }
    rig.updateMatrix();
    return out.copy(local).applyMatrix4(rig.matrix);
  }

  // Same point in world space — where tracers should start from.
  muzzleWorld(out = new THREE.Vector3()) {
    return this.camera.localToWorld(this.muzzleLocal(out));
  }

  // Viewmodel response to a shot: bump recoil and light the muzzle flash.
  fired() {
    this.recoil = Math.min(RECOIL_MAX, this.recoil + 1);
    // A CAN DOES NOT FLASH. Everything below this line builds the muzzle flash
    // and aims it down the bore; a nozzle has neither, and a burn hanging off
    // the top of a spray can is the one thing that would make it read as a gun.
    // The recoil above still runs, because `kick` is nearly zero anyway and the
    // tiny shake is what makes a held trigger feel like it is doing something.
    if (this.stats.flash === false) return;
    this.flash = FLASH_TIME;

    const p = this.muzzleLocal();
    this.flashGroup.position.copy(p);
    this._aimFlash();
    // Sprites do not turn with their parent, so the star spins itself. Its
    // material angle is the only thing that changes shot to shot, and it is
    // enough: nine spikes never land in the same place twice.
    this.flashStar.material.rotation = Math.random() * Math.PI * 2;
    const scale = 0.7 + this.stats.punch * 0.6;
    this.flashGroup.scale.setScalar(scale * (0.9 + Math.random() * 0.2));
    this.flashPlume.rotation.z = Math.random() * Math.PI * 2;
    this.flashGroup.visible = true;

    this.flashLight.position.copy(p);
    this.flashLight.intensity = 6 * this.stats.punch;
  }

  // Parks the flash on the live muzzle, turned the way the barrel is turned so
  // the plume goes down the bore rather than down the camera's -Z.
  _aimFlash() {
    this.flashGroup.position.copy(this.muzzleLocal());
    const rig = this.rigs[this.active];
    if (rig) this.flashGroup.quaternion.copy(rig.quaternion);
    this.flashLight.position.copy(this.flashGroup.position);
  }

  // Plays the reload as a full roll of the gun out of and back into view.
  startReload(duration) {
    this.reloadTime = duration;
    this.reloadLeft = duration;
  }

  update(dt) {
    // Recoil springs back toward rest.
    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - this.recoil * RECOIL_RETURN * dt - dt * 0.4);
    }

    if (this.flash > 0) {
      this.flash -= dt;
      if (this.flash <= 0) {
        this.flashGroup.visible = false;
        this.flashLight.intensity = 0;
      } else {
        // Squared: full brightness for an instant and then gone. A flash that
        // fades off linearly reads as a lamp being switched off.
        const k = (this.flash / FLASH_TIME) ** 2;
        // Re-read every frame: the gun is mid-recoil and mid-reload while the
        // flash is lit, and a flash pinned to where the barrel WAS reads as a
        // sprite hanging in the air next to the gun.
        this._aimFlash();
        this.flashStar.material.opacity = k;
        this.flashHalo.material.opacity = k * 0.85;
        // The plume is the fastest thing here — the gas is past the muzzle
        // before the burn has finished — so it stretches out as it dies.
        this.flashPlume.material.opacity = k * 0.55;
        this.flashPlume.scale.z = 1 + (1 - k) * 0.8;
        this.flashLight.intensity = 6 * this.stats.punch * k;
      }
    }

    if (this.reloadLeft > 0) this.reloadLeft = Math.max(0, this.reloadLeft - dt);

    const rig = this.rigs[this.active];
    if (!rig) return;

    // Reload dips the gun down and rolls it; 0 at both ends of the animation.
    let dip = 0;
    let roll = 0;
    if (this.reloadLeft > 0) {
      const k = Math.sin(Math.PI * (1 - this.reloadLeft / this.reloadTime));
      dip = k * 0.22;
      roll = k * 0.9;
    }

    rig.position.set(this.handX, HAND_Y - dip, HAND_Z + this.recoil * RECOIL_BACK);
    rig.rotation.x = -this.recoil * RECOIL_PITCH;
    rig.rotation.z = roll;
  }

  _resetRig(rig) {
    if (!rig) return;
    rig.position.set(this.handX, HAND_Y, HAND_Z);
    rig.rotation.x = 0;
    rig.rotation.z = 0;
  }
}

/**
 * A loaded GLB, centred and turned into a viewmodel rig.
 *
 * Exported because `/dev-guns.html` has to build the guns exactly the way the
 * game does or it is measuring a weapon nobody ever holds — and it used to do
 * that by keeping a line-for-line copy of this code, under a comment warning
 * that any drift between the two made the harness a liar. A copy that documents
 * its own fragility is still a copy.
 *
 * The model's orientation and scale live on an INNER group so the outer rig's
 * transform stays clean camera-space, which is what recoil and reload animate.
 */
export function buildWeaponRig(cfg, model) {
  // Centre the model, then wrap it so the group's transform is clean.
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  model.position.sub(center);

  const inner = new THREE.Group();
  inner.add(model);

  // AUTHORED AT ON-SCREEN SIZE, so neither of the two fits below applies. Both
  // are about a downloaded gun: the auto-orient finds a barrel by taking the
  // longest horizontal axis, and the scale stretches that axis to `length`. A
  // spray can has no barrel and its longest axis is the one it stands up on --
  // measured, the fit would take a 26 mm can, call its diameter the barrel, and
  // blow it up five times to match. Something written in code can simply be
  // written the right size, and `sprayCan` is.
  if (cfg.raw) {
    inner.rotation.y = cfg.yaw;
  } else {
    // Auto-orient: the longest horizontal axis is the barrel — align it to -z.
    if (size.x >= size.z) inner.rotation.y = Math.PI / 2; // barrel along X -> Z
    if (cfg.flip) inner.rotation.y += Math.PI;
    inner.rotation.y += cfg.yaw;

    // Scale so the barrel reads at the configured on-screen length.
    const barrelLen = Math.max(size.x, size.z) || 1;
    inner.scale.setScalar(cfg.length / barrelLen);
  }

  const rig = new THREE.Group();
  rig.add(inner);
  return rig;
}

/**
 * Where the barrel actually ends, in the rig's own space.
 *
 * The old answer was "half the configured length in front of the hand", which
 * is the middle of the front face of the model's bounding box — and a gun is
 * not a box. On a pistol that puts the flash a hand's width below the bore,
 * hanging over the trigger guard; on the sniper it sits inside the scope.
 *
 * So it is measured off the geometry instead. Take every vertex in the frontmost
 * slice of the model and average it: the frontmost thing on a gun IS the muzzle,
 * and averaging a slice rather than taking one extreme vertex stops a foresight
 * or a sling loop from dragging the answer off the bore.
 */
const MUZZLE_SLICE = 0.07;   // fraction of the model's depth counted as "the end"

export function measureMuzzle(rig, cfg) {
  // PARENTS AS WELL AS CHILDREN. `updateMatrixWorld` refreshes this subtree and
  // trusts whatever the ancestors already hold, and the loop below cancels the
  // camera out by taking every vertex to world space and back through
  // `rig.worldToLocal` — which only cancels if both ends were computed against
  // the SAME camera matrix. The four downloaded guns get that for free by
  // arriving a frame or more into the run, with a camera that has been placed;
  // the spray can is built synchronously during construction, before the camera
  // has been anywhere, and came out with the player's own world position left
  // in it — measured, a 0.12 m can whose muzzle read 1.67 m below the hand.
  // `updateWorldMatrix(true, true)` walks up first, so it cannot depend on when
  // it is called.
  rig.updateWorldMatrix(true, true);

  const v = new THREE.Vector3();
  const local = new THREE.Vector3();
  let minZ = Infinity;
  let maxZ = -Infinity;
  const points = [];

  rig.traverse((o) => {
    const pos = o.isMesh && o.geometry?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      rig.worldToLocal(local.copy(v));
      points.push(local.x, local.y, local.z);
      if (local.z < minZ) minZ = local.z;
      if (local.z > maxZ) maxZ = local.z;
    }
  });

  if (!points.length || !Number.isFinite(minZ)) {
    return new THREE.Vector3(0, 0, -(cfg.length ?? 0.4) * 0.5);
  }

  const cut = minZ + (maxZ - minZ) * MUZZLE_SLICE;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < points.length; i += 3) {
    if (points[i + 2] > cut) continue;
    sx += points[i]; sy += points[i + 1]; n++;
  }

  const out = new THREE.Vector3(n ? sx / n : 0, n ? sy / n : 0, minZ - 0.02);
  // Per-gun correction, for the ones where the frontmost slice is not the bore
  // — a shotgun's magazine tube reaches as far forward as its barrel, and the
  // average of the two lands between them.
  const nudge = cfg.muzzle;
  if (nudge) out.set(out.x + (nudge[0] ?? 0), out.y + (nudge[1] ?? 0), out.z + (nudge[2] ?? 0));
  return out;
}

export { WEAPONS };

/**
 * The muzzle flash, in three parts, because a flash is not one thing:
 *
 *   star   the burn itself, spun to a new angle every shot
 *   halo   a soft ball of light around it, which is what makes the star read as
 *          bright rather than as a picture of a star
 *   plume  a stubby cone thrown forward down the barrel line, so the flash has
 *          somewhere to go instead of hanging flat in the air
 *
 * Exported so /dev-guns.html shows the same object the game does. The first
 * version of that harness built its own copy and the two drifted immediately,
 * which meant the placement was tuned against a flash nobody would ever see.
 *
 * Sized against the guns rather than by eye: a pistol is 0.30 units of barrel,
 * so a 0.30 star is a flash the length of the whole weapon. These are what fit
 * a barrel — the shot's own `punch` scales them from there.
 */
export function makeMuzzleFlash() {
  const fx = getFx();
  const sprite = (map, color, scale) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    s.scale.setScalar(scale);
    s.frustumCulled = false;
    return s;
  };

  const halo = sprite(fx.glow, 0xffb356, 0.20);
  const star = sprite(fx.flash, 0xffffff, 0.145);

  // A cone rather than a quad so it survives being looked at from the side,
  // which is exactly what happens every time the gun kicks.
  const coneGeo = new THREE.ConeGeometry(0.026, 0.10, 8, 1, true);
  coneGeo.rotateX(-Math.PI / 2);
  coneGeo.translate(0, 0, -0.05);
  const plume = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
    color: 0xffd08a, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  plume.frustumCulled = false;

  const group = new THREE.Group();
  group.add(halo, plume, star);
  return { group, halo, star, plume };
}
