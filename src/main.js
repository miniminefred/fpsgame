import { Timer } from 'three';
import { createRenderer, createScene, createCamera, handleResize } from './scene.js';
import { buildWorld } from './world.js';
import { createInput, onDigitKeys } from './input.js';
import { Player } from './player.js';
import { Weapons } from './weapons.js';

const renderer = createRenderer();
const scene = createScene();
const camera = createCamera();
handleResize(renderer, camera);

const { colliders } = buildWorld(scene);

const keys = createInput();
const player = new Player(camera, renderer.domElement, keys, colliders);

// Camera must be in the scene graph so the weapon viewmodel (a child of the
// camera) gets rendered.
scene.add(camera);

const weaponLabel = document.getElementById('weapon');
const weapons = new Weapons(camera, (i, name) => {
  weaponLabel.textContent = `${i + 1} · ${name}`;
});
onDigitKeys((n) => weapons.select(n));
addEventListener('resize', () => weapons.layout());

const timer = new Timer();

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05); // clamp to avoid tunneling on lag spikes
  player.update(dt, camera);
  renderer.render(scene, camera);
}
animate();
