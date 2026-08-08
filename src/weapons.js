import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
    name: 'Shotgun', file: 'models/3_shotgun.glb', length: 0.58, flip: false, yaw: 0,
    rpm: 75, auto: false, damage: 14, pellets: 9, spread: 0.055,
    kick: 0.045, punch: 1.25, mag: 6, reload: 2.4, range: 45,
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
  }

  // A pair of crossed additive quads parented to the camera, parked at the
  // active weapon's muzzle and shown for a few frames per shot.
  _buildMuzzleFlash() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd27a, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.PlaneGeometry(0.22, 0.22);

    this.flashGroup = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const quad = new THREE.Mesh(geo, mat);
      quad.rotation.z = i * Math.PI / 4;
      quad.renderOrder = 1000;
      quad.frustumCulled = false;
      this.flashGroup.add(quad);
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

  // Muzzle tip in camera space: the barrel runs along -z from the hand anchor.
  muzzleLocal(out = this._muzzle) {
    return out.set(this.handX, HAND_Y, HAND_Z - this.stats.length * 0.5);
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
    this.flashGroup.rotation.z = Math.random() * Math.PI;
    const scale = 0.7 + this.stats.punch * 0.6;
    this.flashGroup.scale.setScalar(scale);
    this.flashGroup.visible = true;

    this.flashLight.position.copy(p);
    this.flashLight.intensity = 6 * this.stats.punch;
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
        const k = this.flash / FLASH_TIME;
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
