import { Timer } from 'three';
import { createRenderer, createScene, createCamera, handleResize } from './scene.js';
import { createLighting } from './lighting.js';
import { createInput, onDigitKeys } from './input.js';
import { createTouchControls } from './touch.js';
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
import { Cameras } from './cameras.js';
import { Net } from './net.js';
import { createCoopMenu } from './mp-menu.js';
import { NetPlay } from './netplay.js';
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
// Declared before the gun so the weapon-change callback can light the matching
// on-screen chip; it is only ever read after createTouchControls has run.
let touch = null;
const weapons = new Weapons(camera, (i, name) => {
  hud.setWeapon(i, name);
  touch?.setWeapon(i);
});
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
const cameras = new Cameras({ scene, audio, effects });

const game = new Game({
  scene, camera, player, weapons, shooting, enemies,
  effects, audio, hud, minimap, lighting, physics, destruction, extinguishers, doors, casings,
  keycards, wallet, ragdolls, cameras,
});

// Co-op. All three are live from load and none of them touches the game until a
// channel is actually up: the wire, the panel that drives it, and the play layer
// that carries game state over it. NetPlay is built last and wired back into the
// game, because it needs a Game and a Game would then need it.
const net = new Net();
const coopMenu = createCoopMenu({ net });
const netplay = new NetPlay({ net, game, scene, menu: coopMenu });
game.netplay = netplay;

// One way to change weapon, whether it came from a number key or a thumb.
function selectWeapon(n) {
  if (n >= weapons.count || n === weapons.active) return;
  weapons.select(n);
  shooting.onWeaponChange();
}
onDigitKeys(selectWeapon);

touch = createTouchControls({
  keys, camera, controls: player.controls, weapons, selectWeapon,
});
touch?.setWeapon(weapons.active);
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
    scene, camera, weapons, renderer, audio, casings, keycards, wallet, ragdolls, cameras,
    touch, net, netplay, coopMenu,
    // One frame of the world by hand, for measuring something without the
    // render loop moving underneath it — and for driving a tab that is not
    // being looked at, which is how the co-op protocol is tested.
    step: (render = true) => tick(render),
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

// --- how often the world moves -------------------------------------------------
//
// requestAnimationFrame is tied to the compositor, so a tab nobody is looking at
// does not get one — the game simply stops. Alone that is correct and even
// desirable: there is nothing to see and nobody to see it.
//
// In a co-op session it is neither. The host's browser is the one thinking for
// two hundred people, so a host who alt-tabs to paste their code into a chat
// window freezes their friend's floor solid. So while a session is up and this
// tab is hidden, the simulation is driven off a timer instead and the render is
// skipped — there is no point drawing a frame nobody is looking at, and it is by
// far the most expensive part.
//
// Two things make that work better than it sounds. The dt clamp below means a
// throttled tick slows the world down rather than letting anything tunnel
// through a wall. And Chrome exempts a tab that is making a noise from its
// harshest background throttling, which this one is — the ambience is running —
// so the interval keeps something like its asked-for rate rather than dropping
// to once a second.
const HIDDEN_HZ = 30;
let hiddenTimer = 0;

function tick(render) {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05); // clamp so a lag spike can't tunnel

  player.update(dt, camera);
  lighting.update(dt, camera.position);
  weapons.update(dt);
  audio.update(dt, camera);   // before anything plays, so this frame pans right

  // Not while the start screen is up. That used to be unreachable — the only
  // way back to the menu was Esc and the only way out of it was a click that
  // re-locked — but the co-op panel is a screenful of real buttons sitting on
  // that screen, and every press on one is a mousedown the trigger would
  // otherwise take. `engaged` is the flag that already means "the player has
  // asked to play", refused lock or not, so it is the right thing to ask.
  if (game.state === 'playing' && player.controls.engaged) shooting.update(dt);
  else keys.firePressed = false;   // don't bank a trigger press through death

  game.update(dt);
  effects.update(dt);
  hud.update(dt);

  if (render) renderer.render(scene, camera);
}

function animate() {
  requestAnimationFrame(animate);
  tick(true);
}

// Only while hidden, so the two drivers can never both be stepping the world.
addEventListener('visibilitychange', () => {
  clearInterval(hiddenTimer);
  hiddenTimer = 0;
  if (!document.hidden) return;
  hiddenTimer = setInterval(() => {
    if (document.hidden && netplay.online) tick(false);
  }, 1000 / HIDDEN_HZ);
});

// The render loop starts straight away and tolerates having no floor yet, so
// pointer lock and the HUD are live from the first frame rather than after the
// models finish downloading.
animate();
boot();
