import * as THREE from 'three';

// Builds the static flat-plane world: ground, reference grid, and scattered boxes.
export function buildWorld(scene) {
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x4f7a43, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(500, 250, 0x2f5030, 0x3d6640);
  grid.position.y = 0.01;
  scene.add(grid);

  // A few reference boxes so movement is legible. Deterministic scatter
  // (golden-angle) so the world is stable across reloads.
  const boxGeo = new THREE.BoxGeometry(2, 2, 2);
  const boxColors = [0xd9534f, 0xf0ad4e, 0x5bc0de, 0x9b59b6, 0xe0e0e0];
  for (let i = 0; i < 24; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: boxColors[i % boxColors.length], roughness: 0.7 });
    const box = new THREE.Mesh(boxGeo, mat);
    const a = i * 2.3999632; // golden angle
    const r = 8 + (i % 8) * 5;
    box.position.set(Math.cos(a) * r, 1, Math.sin(a) * r);
    box.castShadow = true;
    box.receiveShadow = true;
    scene.add(box);
  }
}
