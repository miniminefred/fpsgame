import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Classic FPS loadout, light -> heavy. Number keys 1..5 select these in order.
// `length` is the target on-screen barrel length (view-space units) — heavier
// guns are drawn a little bigger. `flip` reverses the auto-detected muzzle
// direction; `yaw` is a small cosmetic angle offset. Tune per model as needed.
const WEAPONS = [
  { name: 'Pistol',        file: 'models/1_pistol.glb',        length: 0.30, flip: false, yaw: 0 },
  { name: 'SMG',           file: 'models/2_smg.glb',           length: 0.42, flip: false, yaw: 0 },
  { name: 'Shotgun',       file: 'models/3_shotgun.glb',       length: 0.58, flip: false, yaw: 0 },
  { name: 'Assault Rifle', file: 'models/4_assault_rifle.glb', length: 0.62, flip: false, yaw: 0 },
  { name: 'Sniper Rifle',  file: 'models/5_sniper.glb',        length: 0.80, flip: false, yaw: 0 },
];

// Viewmodel anchor in camera space. The horizontal offset is computed from the
// frustum width (see _computeX) so the gun keeps the same relative spot and
// doesn't clip off-screen in narrow/portrait views; y and z are fixed.
const HAND_Y = -0.26;
const HAND_Z = -0.5;
const X_FRAC = 0.52; // fraction of the horizontal half-frustum to sit from center
const X_MAX = 0.32;  // cap so wide/ultrawide keeps the (fine) widescreen placement

export class Weapons {
  constructor(camera, onChange) {
    this.camera = camera;
    this.onChange = onChange;      // (index, name) => void, for the HUD
    this.rigs = new Array(WEAPONS.length).fill(null);
    this.active = 0;
    this.count = WEAPONS.length;
    this.handX = this._computeX();

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

    const rig = new THREE.Group();
    rig.add(model);

    // Auto-orient: the longest horizontal axis is the barrel — align it to -z.
    if (size.x >= size.z) rig.rotation.y = Math.PI / 2; // barrel along X -> Z
    if (cfg.flip) rig.rotation.y += Math.PI;
    rig.rotation.y += cfg.yaw;

    // Scale so the barrel reads at the configured on-screen length.
    const barrelLen = Math.max(size.x, size.z) || 1;
    rig.scale.setScalar(cfg.length / barrelLen);

    rig.position.set(this.handX, HAND_Y, HAND_Z);
    rig.visible = i === this.active;

    this.camera.add(rig);
    this.rigs[i] = rig;
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
    this.onChange?.(index, WEAPONS[index].name);
  }
}
