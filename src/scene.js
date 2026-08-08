import * as THREE from 'three';

// Renderer, camera and the empty scene. Lights live in lighting.js; everything
// you can see is generated per floor by gen/build.js.

// The building's own haze colour. Fog does the heavy lifting indoors: it hides
// the far end of a long corridor, so a floor reveals itself as you walk it
// instead of all at once.
//
// It is a mid grey rather than near-black on purpose. A dark fog turns the end
// of every corridor into a void, which reads as horror; a grey one reads as a
// lit office receding into haze, and still hides what's coming.
const HAZE = 0x4d545c;

export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is deprecated in three r185 (it silently falls back to
  // PCFShadowMap), so ask for PCFShadowMap directly. Edge softness comes from
  // the light's shadow.radius — see lighting.js.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);
  return renderer;
}

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(HAZE);
  scene.fog = new THREE.Fog(HAZE, 13, 58);
  return scene;
}

export function createCamera() {
  // 0.1 near plane keeps the weapon viewmodel out of trouble; 200 far is
  // plenty once fog has swallowed everything past ~46.
  return new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
}

export function handleResize(renderer, camera) {
  addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
