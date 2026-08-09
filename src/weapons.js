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
const WEAPONS = [
  {
    name: 'Pistol', file: 'models/1_pistol.glb', length: 0.30, flip: false, yaw: 0,
    rpm: 420, auto: false, damage: 34, pellets: 1, spread: 0.004,
    kick: 0.016, punch: 0.75, mag: 12, reload: 1.1, range: 200,
    sound: 'pistol-fire',
  },
  {
    name: 'SMG', file: 'models/2_smg.glb', length: 0.42, flip: false, yaw: 0,
    rpm: 900, auto: true, damage: 16, pellets: 1, spread: 0.019,
    kick: 0.011, punch: 0.65, mag: 30, reload: 1.4, range: 160,
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
    kick: 0.055, punch: 1.35, mag: 6, reload: 2.4, range: 45,
    sound: 'shotgun-fire',
  },
  {
    name: 'Assault Rifle', file: 'models/4_assault_rifle.glb', length: 0.62, flip: false, yaw: 0,
    rpm: 620, auto: true, damage: 26, pellets: 1, spread: 0.011,
    kick: 0.019, punch: 0.95, mag: 30, reload: 1.9, range: 300,
    sound: 'rifle-fire',
  },
  {
    name: 'Sniper Rifle', file: 'models/5_sniper.glb', length: 0.80, flip: false, yaw: 0,
    rpm: 48, auto: false, damage: 130, pellets: 1, spread: 0.0008,
    kick: 0.06, punch: 1.4, mag: 5, reload: 2.8, range: 500,
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

    // Center the model, then wrap it so the group's transform is clean.
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    model.position.sub(center);

    // The model's own orientation/scale live on an inner group, so the outer
    // rig's transform stays clean camera-space (recoil/reload animate it).
    const inner = new THREE.Group();
    inner.add(model);

    // Auto-orient: the longest horizontal axis is the barrel — align it to -z.
    if (size.x >= size.z) inner.rotation.y = Math.PI / 2; // barrel along X -> Z
    if (cfg.flip) inner.rotation.y += Math.PI;
    inner.rotation.y += cfg.yaw;

    // Scale so the barrel reads at the configured on-screen length.
    const barrelLen = Math.max(size.x, size.z) || 1;
    inner.scale.setScalar(cfg.length / barrelLen);

    const rig = new THREE.Group();
    rig.add(inner);
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
  rig.updateMatrixWorld(true);

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
