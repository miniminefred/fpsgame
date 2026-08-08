import * as THREE from 'three';

const SKY = 0x87ceeb;

export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is deprecated in three r185 (it silently falls back to
  // PCFShadowMap), so ask for PCFShadowMap directly. Edge softness now comes
  // from the light's shadow.radius — see sunlight.js.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);
  return renderer;
}

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 60, 200);

  // Sky fill only — it lifts shadowed faces off black without washing out the
  // sun's cast shadows. The sun itself lives in sunlight.js.
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x6b7a58, 0.7);
  scene.add(hemi);

  return scene;
}

export function createCamera() {
  return new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
}

export function handleResize(renderer, camera) {
  addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
