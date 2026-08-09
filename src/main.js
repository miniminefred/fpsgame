import { Timer } from 'three';
import { createRenderer, createScene, createCamera, handleResize } from './scene.js';
import { createLighting } from './lighting.js';
import { createInput, onDigitKeys } from './input.js';
import { Player } from './player.js';
import { Weapons } from './weapons.js';
import { Effects } from './effects.js';
import { Enemies } from './enemies.js';
import { GameAudio } from './audio.js';
import { Hud } from './hud.js';
import { Minimap } from './minimap.js';
import { Shooting } from './shooting.js';
import { Physics } from './physics.js';
import { Destruction } from './destruction.js';
import { Extinguishers } from './extinguishers.js';
import { Doors } from './doors.js';
import { Casings } from './casings.js';
import { Keycards, Wallet } from './keycards.js';
import { Ragdolls } from './ragdolls.js';
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
const audio = new GameAudio();
const lighting = createLighting(scene);

const physics = new Physics();
const weapons = new Weapons(camera, (i, name) => hud.setWeapon(i, name));
const casings = new Casings(scene, physics);
const shooting = new Shooting({
  camera, controls: player.controls, keys, weapons, effects, enemies, hud, audio, physics, casings,
});

const destruction = new Destruction({ scene, physics, effects, audio, shooting, lighting });
const extinguishers = new Extinguishers({
  scene, physics, effects, audio, destruction, enemies, player, hud,
});
// Wired after the fact because the two need each other: destruction hands a
// holed cylinder over, and the blast at the end of its flight comes back
// through destruction to take the furniture around it with it.
destruction.extinguishers = extinguishers;

const doors = new Doors({ scene, audio });
const ragdolls = new Ragdolls({ scene, physics });
enemies.ragdolls = ragdolls;
const wallet = new Wallet();
const keycards = new Keycards({ scene, audio, wallet });

const game = new Game({
  scene, camera, player, weapons, shooting, enemies,
  effects, audio, hud, minimap, lighting, physics, destruction, extinguishers, doors, casings,
  keycards, wallet, ragdolls,
});

onDigitKeys((n) => {
  if (n >= weapons.count || n === weapons.active) return;
  weapons.select(n);
  shooting.onWeaponChange();
});
addEventListener('resize', () => weapons.layout());

// Any click after you die starts a new run. The same click is also the gesture
// the browser wants before it will let an AudioContext exist, so the ambience
// starts here rather than at load — where it would be silently refused.
addEventListener('mousedown', () => {
  audio.start();
  game.restartIfDead();
});

// Dev-only handle for poking at a running floor from the console. Stripped from
// production builds by the bundler.
if (import.meta.env.DEV) {
  window.dev = {
    game, player, enemies, shooting, keys, physics, destruction, extinguishers, doors,
    scene, camera, weapons, renderer, audio, casings, keycards, wallet, ragdolls,
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
  audio.update(dt, camera);   // before anything plays, so this frame pans right

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
