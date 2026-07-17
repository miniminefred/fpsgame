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

// Viewmodel anchor in camera space: right (+x), down (-y), forward (-z).
const HAND = new THREE.Vector3(0.32, -0.26, -0.5);

export class Weapons {
  constructor(camera, onChange) {
    this.camera = camera;
    this.onChange = onChange;      // (index, name) => void, for the HUD
    this.rigs = new Array(WEAPONS.length).fill(null);
    this.active = 0;
    this.count = WEAPONS.length;

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

    rig.position.copy(HAND);
    rig.visible = i === this.active;

    this.camera.add(rig);
    this.rigs[i] = rig;
  }

  select(index) {
    if (index < 0 || index >= this.count || index === this.active) return;
    this.active = index;
    this.rigs.forEach((rig, i) => { if (rig) rig.visible = i === index; });
    this.onChange?.(index, WEAPONS[index].name);
  }
}
