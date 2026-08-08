import { Timer } from 'three';
import { createRenderer, createScene, createCamera, handleResize } from './scene.js';
import { createLighting } from './lighting.js';
import { createInput, onDigitKeys } from './input.js';
import { Player } from './player.js';
import { Weapons } from './weapons.js';
import { Effects } from './effects.js';
import { Enemies } from './enemies.js';
import { GunAudio } from './audio.js';
import { Hud } from './hud.js';
import { Minimap } from './minimap.js';
import { Shooting } from './shooting.js';
import { Game } from './game.js';

const renderer = createRenderer();
const scene = createScene();
const camera = createCamera();
handleResize(renderer, camera);

const keys = createInput();
const player = new Player(camera, renderer.domElement, keys, []);

// The camera must be in the scene graph so the weapon viewmodel (a child of
// the camera) gets rendered.
scene.add(camera);

const hud = new Hud();
const minimap = new Minimap(document.getElementById('minimap'));
const effects = new Effects(scene);
const enemies = new Enemies(scene);
const audio = new GunAudio();
const lighting = createLighting(scene);

const weapons = new Weapons(camera, (i, name) => hud.setWeapon(i, name));
const shooting = new Shooting({
  camera, controls: player.controls, keys, weapons, effects, enemies, hud, audio,
});

const game = new Game({
  scene, camera, player, weapons, shooting, enemies, effects, audio, hud, minimap, lighting,
});

onDigitKeys((n) => {
  if (n >= weapons.count || n === weapons.active) return;
  weapons.select(n);
  shooting.onWeaponChange();
});
addEventListener('resize', () => weapons.layout());

// Any click after you die starts a new run.
addEventListener('mousedown', () => game.restartIfDead());

game.start();

const timer = new Timer();

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05); // clamp so a lag spike can't tunnel

  player.update(dt, camera);
  lighting.update(dt, camera.position);
  weapons.update(dt);

  if (game.state === 'playing') shooting.update(dt);
  else keys.firePressed = false;   // don't bank a trigger press through death

  game.update(dt);
  effects.update(dt);
  hud.update(dt);

  renderer.render(scene, camera);
}
animate();
