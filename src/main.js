import { Timer } from 'three';
import { createRenderer, createScene, createCamera, handleResize } from './scene.js';
import { buildWorld } from './world.js';
import { createInput, onDigitKeys } from './input.js';
import { Player } from './player.js';
import { Weapons } from './weapons.js';
import { Effects } from './effects.js';
import { Targets } from './targets.js';
import { GunAudio } from './audio.js';
import { Hud } from './hud.js';
import { Shooting } from './shooting.js';

const renderer = createRenderer();
const scene = createScene();
const camera = createCamera();
handleResize(renderer, camera);

const world = buildWorld(scene);

const keys = createInput();
const player = new Player(camera, renderer.domElement, keys, world.colliders);

// Camera must be in the scene graph so the weapon viewmodel (a child of the
// camera) gets rendered.
scene.add(camera);

const hud = new Hud();
const effects = new Effects(scene);
const targets = new Targets(scene);
const audio = new GunAudio();

const weapons = new Weapons(camera, (i, name) => hud.setWeapon(i, name));
const shooting = new Shooting({
  camera, controls: player.controls, keys, weapons, effects, targets, world, hud, audio,
});

onDigitKeys((n) => {
  if (n >= weapons.count || n === weapons.active) return;
  weapons.select(n);
  shooting.onWeaponChange();
});
addEventListener('resize', () => weapons.layout());

const timer = new Timer();

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05); // clamp to avoid tunneling on lag spikes
  player.update(dt, camera);
  weapons.update(dt);
  shooting.update(dt);
  targets.update(dt);
  effects.update(dt);
  renderer.render(scene, camera);
}
animate();
