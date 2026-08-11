// Loose rigid bodies that exist for a while and then stop being worth anything:
// spent brass, and the fragments a destroyed prop comes apart into.
//
// This was the same five operations written out twice, in casings.js and
// destruction.js — push-and-evict-the-oldest, count-down-and-retire,
// sync-the-mesh-if-the-body-is-awake, clear, and the retire itself — down to the
// identical comment sitting above both `clear()` methods. They differ in three
// things and nothing else: the cap, the lifetime, and whether each mesh owns its
// own geometry or shares one.
//
// The shared comment is the part worth restating, because it is the one that
// bites: `clear()` MUST run while the physics world its handles belong to is
// still alive. `physics.reset()` throws the whole cannon-es World away and
// builds a fresh one, so a handle that outlives it refers to nothing — and
// `physics.remove()` on a stale handle silently does nothing rather than
// erroring, while `syncMesh` goes on writing a frozen transform. Nothing throws,
// nothing logs, and the debris simply hangs in the air on the next floor. That
// is why game.js clears every pool BEFORE it regenerates, and why the ordering
// there is commented rather than left to look arbitrary.

export class BodyPool {
  /**
   * @param scene        where the meshes live
   * @param physics      the solver holding the handles
   * @param max          hard cap; going over retires the OLDEST, never refuses
   *                     the newest — whatever just happened is what you are
   *                     looking at
   * @param life         seconds before a body is taken away
   * @param ownGeometry  true if each mesh's geometry is its own and must be
   *                     disposed with it (debris), false if shared (brass)
   */
  constructor({ scene, physics, max, life, ownGeometry = false }) {
    this.scene = scene;
    this.physics = physics;
    this.max = max;
    this.life = life;
    this.ownGeometry = ownGeometry;
    this.items = [];
  }

  get count() { return this.items.length; }

  /** Takes ownership of a mesh already added to the scene and its body handle. */
  add(mesh, handle) {
    this.items.push({ mesh, handle, life: this.life });
    while (this.items.length > this.max) this.retire(this.items.shift());
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const entry = this.items[i];
      entry.life -= dt;
      if (entry.life <= 0) {
        this.retire(entry);
        this.items.splice(i, 1);
        continue;
      }
      // A sleeping body is not moving, so its mesh is already where it belongs.
      if (entry.handle && !this.physics.isSleeping(entry.handle)) {
        this.physics.syncMesh(entry.mesh, entry.handle);
      }
    }
  }

  // Must run while the physics world the handles belong to is still alive.
  clear() {
    for (const entry of this.items) this.retire(entry);
    this.items.length = 0;
  }

  retire(entry) {
    if (!entry) return;
    this.scene.remove(entry.mesh);
    if (this.ownGeometry) entry.mesh.geometry.dispose();
    if (entry.handle) this.physics?.remove(entry.handle);
  }
}
