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
  generate(seed, floorNumber, theme = null) {
    this.dispose();

    const layout = generateLayout(seed, floorNumber);
    // The shift, purely so the furnisher can ask what KIND of floor this is —
    // one flag today (`chargers`, the dock in a break room). Everything else a
    // theme does to the building is fitted into the finished floor afterwards
    // by a module of its own; this one is furniture, so it has to be here.
    const built = buildLevel(this.scene, layout, theme);
    const nav = new NavGrid(built.nav);

    this.current = {
      layout,
      floorNumber,
      seed,
      nav,
      meshes: built.meshes,
      // The door panels, which a bullet has to stop on. A SEPARATE list from
      // `meshes` on purpose — that one is also what a decal is clipped against,
      // and a bullet hole left on a panel that then slides into its pocket
      // hangs in the middle of the doorway. See the note in gen/build.js.
      //
      // This record is hand-built rather than spread from `built`, so a field
      // added there reaches nobody until it is named here. That cost a real
      // error rather than a silent miss, which is the good outcome: game.js
      // spreads this into the hittable list, `[...undefined]` throws, and the
      // whole list came out EMPTY — no bullet hit anything at all, which the
      // browser said on the first frame.
      doorMeshes: built.doorMeshes,
      objects: built.objects,
      colliders: built.colliders,
      // The rectangle the player may not leave. It travels with the colliders
      // because it is what stands behind them — see _contain in player.js.
      bounds: built.bounds,
      dynamics: built.dynamics,
      destructibles: built.destructibles,
      doors: built.doors,
      fixtures: built.fixtures,
      exitObject: built.exitObject,
      // Where the staff are found working, handed to enemies.spawn — see
      // `workstation` in gen/sink.js.
      workstations: built.workstations,
      spawn: layout.spawn,
      exit: layout.exit,
      // What the minimap needs, in one flat object.
      map: {
        W: layout.W, H: layout.H, TILE: layout.TILE,
        ox: layout.ox, oz: layout.oz,
        tiles: layout.tiles, rooms: layout.rooms,
        exit: layout.exit,
        locks: layout.locks,
        // A car park's decks, each drawn as a map of its own (gen/garage.js).
        garage: layout.garage,
        deck: layout.deck,
        stairs: layout.stairs,
        pillars: layout.pillars,
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
