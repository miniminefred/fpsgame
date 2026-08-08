import { generateLayout } from './gen/layout.js';
import { buildLevel } from './gen/build.js';
import { NavGrid } from './nav.js';

// One floor of the building, from seed to teardown.
//
// Floors are disposable: everything a floor owns is created here and released
// in dispose(), so descending never leaks. Shared assets (textures, materials,
// prop geometry) deliberately live outside a level and are never disposed.

export class Level {
  constructor(scene) {
    this.scene = scene;
    this.current = null;
  }

  // Replaces whatever floor is loaded with a freshly generated one.
  generate(seed, floorNumber) {
    this.dispose();

    const layout = generateLayout(seed, floorNumber);
    const built = buildLevel(this.scene, layout);
    const nav = new NavGrid(built.nav);

    this.current = {
      layout,
      floorNumber,
      seed,
      nav,
      meshes: built.meshes,
      objects: built.objects,
      colliders: built.colliders,
      fixtures: built.fixtures,
      exitObject: built.exitObject,
      spawn: layout.spawn,
      exit: layout.exit,
      // What the minimap needs, in one flat object.
      map: {
        W: layout.W, H: layout.H, TILE: layout.TILE,
        ox: layout.ox, oz: layout.oz,
        tiles: layout.tiles, rooms: layout.rooms,
        exit: layout.exit,
      },
    };

    return this.current;
  }

  // Gentle pulse on the exit so it reads as active from across a dark floor.
  update(dt, time) {
    const level = this.current;
    if (!level?.exitObject) return;

    const ring = level.exitObject.userData.ring;
    const shaft = level.exitObject.userData.shaft;
    if (ring) {
      ring.rotation.z += dt * 1.1;
      ring.position.y = 0.08 + Math.sin(time * 2) * 0.03;
    }
    if (shaft) shaft.material.opacity = 0.07 + Math.sin(time * 2.2) * 0.03;
  }

  dispose() {
    if (!this.current) return;

    for (const obj of this.current.objects) {
      this.scene.remove(obj);
      obj.traverse?.((child) => {
        if (child.geometry) child.geometry.dispose();
        // Materials on the exit marker are one-offs; batched level meshes share
        // the cached materials from textures.js, which must survive.
        if (child.userData.ownMaterial && child.material) child.material.dispose();
      });
    }

    this.current = null;
  }
}

// Distance from the player to the exit pad, on the floor plane.
export function distanceToExit(level, position) {
  const dx = position.x - level.exit.x;
  const dz = position.z - level.exit.z;
  return Math.hypot(dx, dz);
}
