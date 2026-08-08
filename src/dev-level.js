import * as THREE from 'three';
import { Timer } from 'three';
import { createRenderer, createScene, createCamera, handleResize } from './scene.js';
import { createLighting } from './lighting.js';
import { Level } from './level.js';
import { Enemies } from './enemies.js';
import { Effects } from './effects.js';
import { Player } from './player.js';
import { createInput } from './input.js';
import { makeRng, randomSeed } from './gen/rng.js';

// Development harness for the level generator: boots straight into a generated
// floor with no HUD, no weapons and no run structure, so geometry, lighting and
// enemy movement can be inspected in isolation. Press N for a new floor.
// Not part of the shipped game — served only at /dev-level.html.

const renderer = createRenderer();
const scene = createScene();
const camera = createCamera();
handleResize(renderer, camera);
scene.add(camera);

const keys = createInput();
const player = new Player(camera, renderer.domElement, keys, []);
const lighting = createLighting(scene);
const effects = new Effects(scene);
const enemies = new Enemies(scene);
const level = new Level(scene);

const hint = document.getElementById('hint');
player.controls.addEventListener('lock', () => hint.classList.add('hidden'));
player.controls.addEventListener('unlock', () => hint.classList.remove('hidden'));

const info = document.getElementById('info');
const silentAudio = { shot() {}, click() {}, reload() {}, ping() {} };
const noHud = { damage() {} };

let floor = 1;
let stats = {};

function load() {
  const t0 = performance.now();
  const seed = randomSeed();
  const current = level.generate(seed, floor);
  const genMs = performance.now() - t0;

  player.setColliders(current.colliders);
  player.placeAt(current.spawn.x, current.spawn.z);
  player.reset();

  enemies.spawn(current.layout, current.nav, makeRng(seed ^ 0x9e3779b9), {
    count: 10, health: 100, damage: 8, speed: 2.8,
    fireInterval: 1.4, spread: 0.07, reaction: 0.4,
  });

  lighting.setFixtures(current.fixtures);

  let tris = 0;
  for (const m of current.meshes) tris += m.geometry.index
    ? m.geometry.index.count / 3
    : m.geometry.attributes.position.count / 3;

  stats = {
    floor,
    seed,
    grid: `${current.layout.W}x${current.layout.H}`,
    rooms: current.layout.rooms.length,
    doors: current.layout.doors.length,
    drawCalls: current.meshes.length,
    tris: Math.round(tris),
    colliders: current.colliders.length,
    fixtures: current.fixtures.length,
    genMs: genMs.toFixed(1),
  };
}

addEventListener('keydown', (e) => {
  if (e.code === 'KeyN') { floor++; load(); }
});

load();

const timer = new Timer();
let fps = 0;

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  player.update(dt, camera);
  lighting.update(dt, camera.position);
  enemies.update(dt, { player, effects, audio: silentAudio, hud: noHud, noise: 0 });
  level.update(dt, timer.getElapsed());
  effects.update(dt);

  const p = player.object.position;
  const ex = level.current.exit;
  info.textContent =
    `floor ${stats.floor}  seed ${stats.seed}\n` +
    `grid ${stats.grid}  rooms ${stats.rooms}  doors ${stats.doors}\n` +
    `meshes ${stats.drawCalls}  tris ${stats.tris}  colliders ${stats.colliders}\n` +
    `fixtures ${stats.fixtures}  gen ${stats.genMs}ms  fps ${fps.toFixed(0)}\n` +
    `pos ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}\n` +
    `exit ${ex.x.toFixed(1)}, ${ex.z.toFixed(1)}  dist ${Math.hypot(p.x - ex.x, p.z - ex.z).toFixed(1)}m\n` +
    `enemies alive ${enemies.aliveCount}`;

  renderer.render(scene, camera);
}
animate();

// Handy from the console when something looks wrong.
window.dev = { scene, level, enemies, player, THREE, reload: load };
