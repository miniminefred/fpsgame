import { Timer } from 'three';
import { createRenderer, createScene, createCamera, handleResize } from './scene.js';
import { buildWorld } from './world.js';
import { createInput } from './input.js';
import { Player } from './player.js';

const renderer = createRenderer();
const scene = createScene();
const camera = createCamera();
handleResize(renderer, camera);

const { colliders } = buildWorld(scene);

const keys = createInput();
const player = new Player(camera, renderer.domElement, keys, colliders);

const timer = new Timer();

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05); // clamp to avoid tunneling on lag spikes
  player.update(dt, camera);
  renderer.render(scene, camera);
}
animate();
