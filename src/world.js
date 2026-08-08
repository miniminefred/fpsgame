import * as THREE from 'three';

const BOX_COLORS = [0xd9534f, 0xf0ad4e, 0x5bc0de, 0x9b59b6, 0xe0e0e0, 0x8bc34a];

// Builds the static flat-plane world: ground, reference grid, and a set of
// boxes of varying height/footprint. Returns collider AABBs (in world space,
// resting on the ground) so the player can walk into them and jump on top,
// plus the solid meshes so bullets can be raycast against them.
export function buildWorld(scene) {
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x4f7a43, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(500, 250, 0x2f5030, 0x3d6640);
  grid.position.y = 0.01;
  scene.add(grid);

  const colliders = [];
  const meshes = [ground];

  // Adds a box resting on the ground (bottom at y=0) and records its collider.
  function addBox(x, z, w, h, d, color) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7 })
    );
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshes.push(mesh);
    colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: h });
  }

  // Deterministic scatter of varied boxes (golden-angle spread) — mix of short
  // hop-ups and tall blockers, stable across reloads.
  const heights = [0.6, 1, 1.5, 2, 3, 4];
  for (let i = 0; i < 20; i++) {
    const a = i * 2.3999632; // golden angle
    const r = 10 + (i % 6) * 5;
    const h = heights[i % heights.length];
    const s = 1.2 + (i % 4) * 0.6; // footprint
    addBox(Math.cos(a) * r, Math.sin(a) * r, s, h, s, BOX_COLORS[i % BOX_COLORS.length]);
  }

  // A staircase of rising steps you can jump up, one box at a time.
  for (let i = 0; i < 5; i++) {
    addBox(-7 - i * 2.4, 6, 2, 0.6 + i * 0.8, 2, BOX_COLORS[i % BOX_COLORS.length]);
  }

  return { colliders, meshes };
}
