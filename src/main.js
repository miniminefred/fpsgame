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
import { Destruction } from './destruction.js';
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

const destruction = new Destruction({ scene, physics, effects, audio, shooting, lighting });

const game = new Game({
  scene, camera, player, weapons, shooting, enemies,
  effects, audio, hud, minimap, lighting, physics, destruction,
});

onDigitKeys((n) => {
  if (n >= weapons.count || n === weapons.active) return;
  weapons.select(n);
  shooting.onWeaponChange();
});
addEventListener('resize', () => weapons.layout());

// Any click after you die starts a new run.
addEventListener('mousedown', () => game.restartIfDead());

// Dev-only handle for poking at a running floor from the console. Stripped from
// production builds by the bundler.
if (import.meta.env.DEV) {
  window.dev = {
    game, player, enemies, shooting, keys, physics, destruction,
    scene, camera, weapons, renderer,
  };
}

// Furniture models want to be in hand before the first floor is furnished, or
// that floor falls back to boxes. But they are optional dressing, and the game
// must never fail to start because a download is slow or missing — that leaves
// you staring at an empty HUD with no way in. So the wait is bounded, and any
// failure just means boxes.
const MODEL_TIMEOUT = 8000;

async function boot() {
  try {
    await Promise.race([
      loadModels(modelKeysUsed()),
      new Promise((resolve) => setTimeout(resolve, MODEL_TIMEOUT)),
    ]);
  } catch (err) {
    console.warn('[boot] furniture models unavailable — using procedural fallback', err);
  }
  game.start();
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

// The render loop starts straight away and tolerates having no floor yet, so
// pointer lock and the HUD are live from the first frame rather than after the
// models finish downloading.
animate();
boot();
