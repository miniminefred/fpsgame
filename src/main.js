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
import { Physics } from './physics.js';
import { loadModels } from './gen/models.js';
import { modelKeysUsed } from './gen/props.js';
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

const physics = new Physics();
const weapons = new Weapons(camera, (i, name) => hud.setWeapon(i, name));
const shooting = new Shooting({
  camera, controls: player.controls, keys, weapons, effects, enemies, hud, audio, physics,
});

const game = new Game({
  scene, camera, player, weapons, shooting, enemies,
  effects, audio, hud, minimap, lighting, physics,
});

onDigitKeys((n) => {
  if (n >= weapons.count || n === weapons.active) return;
  weapons.select(n);
  shooting.onWeaponChange();
});
addEventListener('resize', () => weapons.layout());

// Any click after you die starts a new run.
addEventListener('mousedown', () => game.restartIfDead());

// Furniture models have to be in hand before the first floor is furnished, or
// that floor silently falls back to boxes. Everything else is procedural, so
// this is the only asset the generator waits on.
await loadModels(modelKeysUsed());
game.start();

// Dev-only handle for poking at a running floor from the console. Stripped from
// production builds by the bundler.
if (import.meta.env.DEV) {
  window.dev = { game, player, enemies, shooting, physics, scene, camera, weapons, renderer };
}

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
