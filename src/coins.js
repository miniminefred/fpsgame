// Loose change on the desks, and what it buys.
//
// A handful of coins a floor, left on somebody's desk. E picks one up; E at a
// drinks machine spends it, and the can comes out of the machine's own window
// (vending.js) — so the drink you are handed is the one you watched go from the
// glass. F drinks it: 20 health and a few seconds of quicker legs.
//
// Placed off the floor's own SEED rather than its rng, for the reason `drinkFrom`
// is hashed: nothing downstream of generation may be moved by it, and both
// browsers of a co-op session put the same coins on the same desks. Picking one
// up is local and crosses nothing — change on a desk is not worth a message.

import * as THREE from 'three';
import { makeRng } from './gen/rng.js';

// Roughly one desk in eight has some change on it, and never so few that a floor
// with desks has none to find.
const DESK_SHARE = 0.12;
const MIN_COINS = 4;
const MAX_COINS = 14;

// How close, and how nearly under the crosshair, a coin has to be to be picked
// up. Generous on the angle: a coin is 6 cm across and the player is looking at
// a desk, not aiming at a pixel.
const PICK_RANGE = 2.1;
const PICK_CONE = Math.cos(0.42);

export const DRINK_HEAL = 20;
export const DRINK_BOOST = 8;       // seconds of quicker legs

// Overscaled for the can's reason (see CAN_R in drinks.js): a real coin on a desk
// is invisible from the doorway, and finding it is the whole game here.
const COIN_R = 0.034;
const COIN_H = 0.007;

let coinGeo = null;
let coinMat = null;
function coinMesh() {
  coinGeo ??= new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_H, 20);
  // A little emissive, so a coin under a dim fixture still catches the eye —
  // it is the one pickup in the building you have to go looking for.
  coinMat ??= new THREE.MeshStandardMaterial({
    color: 0xe0b23a, metalness: 0.85, roughness: 0.3, emissive: 0x3a2a05,
  });
  const m = new THREE.Mesh(coinGeo, coinMat);
  m.castShadow = false;
  m.receiveShadow = true;
  return m;
}

export class Coins {
  constructor(scene) {
    this.scene = scene;
    this.items = [];          // { mesh, x, y, z, desk }
    this.coins = 0;           // in the player's pocket
    this.cans = 0;            // ...and drinks, bought and not yet drunk
    this.onChange = null;     // () => void, for the HUD
  }

  clear() {
    for (const c of this.items) this.scene.remove(c.mesh);
    this.items = [];
    // Change does not travel between floors either — see the keycards.
    this.coins = 0;
    this.onChange?.();
  }

  /** Coins onto this floor's desks. */
  spawn(level) {
    this.clear();
    const rng = makeRng((level.seed ^ 0xc0115eed) >>> 0);
    const desks = (level.workstations ?? []).filter((w) =>
      w.at === 'desk' && w.prop && w.prop.top > 0.5 && w.prop.top < 1.3);
    if (!desks.length) return;
    const want = Math.max(MIN_COINS, Math.min(MAX_COINS, Math.round(desks.length * DESK_SHARE)));
    rng.shuffle(desks);

    for (const w of desks.slice(0, want)) {
      const d = w.prop;
      const cx = (d.minX + d.maxX) / 2, cz = (d.minZ + d.maxZ) / 2;
      // Toward the chair is the front edge of the desk, and across it is along
      // the desk: the coin goes near the front and off to one side, which keeps
      // it clear of the monitor in the middle of the back.
      let tx = w.x - cx, tz = w.z - cz;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len; tz /= len;
      const halfFront = Math.abs(tx) > Math.abs(tz) ? (d.maxX - d.minX) / 2 : (d.maxZ - d.minZ) / 2;
      const halfSide = Math.abs(tx) > Math.abs(tz) ? (d.maxZ - d.minZ) / 2 : (d.maxX - d.minX) / 2;
      const side = rng.chance(0.5) ? 1 : -1;
      const along = halfSide * (0.45 + rng() * 0.3) * side;
      const x = cx + tx * (halfFront - 0.16) - tz * along;
      const z = cz + tz * (halfFront - 0.16) + tx * along;
      const y = d.top + COIN_H / 2 + 0.001;

      const mesh = coinMesh();
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      this.items.push({ mesh, x, y, z, desk: d });
    }
  }

  /** The coin under the crosshair, if one is in reach. */
  aimed(eye, dir) {
    let best = null;
    let bestDot = PICK_CONE;
    for (const c of this.items) {
      const dx = c.x - eye.x, dy = c.y - eye.y, dz = c.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > PICK_RANGE || d < 1e-3) continue;
      const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
      if (dot > bestDot) { bestDot = dot; best = c; }
    }
    return best;
  }

  pick(coin) {
    const i = this.items.indexOf(coin);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.scene.remove(coin.mesh);
    this.coins++;
    this.onChange?.();
    return true;
  }

  /**
   * A coin shot off the desk, or a desk shot out from under one, is a coin that
   * is gone — it does not float over the carpet where the desk was.
   */
  update() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i];
      if (c.desk.top >= 0) continue;
      this.scene.remove(c.mesh);
      this.items.splice(i, 1);
    }
  }
}
