// Looking down the sniper's scope.
//
// Hold the right mouse button with a gun that has a `scope` (weapons.js — the
// sniper, at 4x) and the view zooms, the screen goes black round a round lens with
// a fine crosshair in it, and the gun itself is not drawn. On a phone there is no
// right button, so tapping the sniper's own weapon chip again toggles it
// (`aimLatched`, see selectWeapon in main.js).
//
// Three things move together, and they have to:
//
//   the camera's field of view   — the zoom itself
//   the look sensitivity         — a pixel of mouse is four times the angle on
//                                  screen at four times the zoom, and a scope you
//                                  cannot hold still on a head is not a scope.
//                                  Scaled by the ratio of the two view tangents,
//                                  which is exactly how much bigger the world got
//   the overlay and the viewmodel — snapped over at most of the way in, not faded:
//                                  half a gun drawn through half a black mask is
//                                  the one picture of this nobody wants to see
//
// A reload drops you out of it — the gun is down by your hip and the bolt is
// open — and the bolt worked between shots does not, because that is the shot
// you are lining up the next one from.

import { setLookScale } from './input.js';

const IN_TIME = 0.14;          // seconds to zoom fully in, and out
const SNAP = 0.7;              // how far in before the black lens is up

export class Scope {
  constructor({ camera, weapons, shooting, controls, keys }) {
    this.camera = camera;
    this.weapons = weapons;
    this.shooting = shooting;
    this.controls = controls;
    this.keys = keys;
    this.baseFov = camera.fov;
    this.k = 0;                  // 0 = hip, 1 = all the way down the scope
    this.on = false;
    this.el = document.getElementById('scope');
  }

  /** `active`: the player is playing and alive, so a scope may be up at all. */
  update(dt, active) {
    const stats = this.weapons.stats;
    const want = active && !!stats.scope && (this.keys.aim || this.keys.aimLatched)
      && !this.shooting.reloading;
    const k = Math.max(0, Math.min(1, this.k + (want ? dt : -dt) / IN_TIME));
    if (k === this.k && k === 0) return;
    this.k = k;

    // The zoom is worked in tangents, which is what a field of view scales by:
    // 4x is a quarter of tan(fov/2), not a quarter of the angle.
    const zoom = 1 + ((stats.scope || 1) - 1) * k;
    const baseTan = Math.tan((this.baseFov * Math.PI) / 360);
    const tan = baseTan / zoom;
    this.camera.fov = (Math.atan(tan) * 360) / Math.PI;
    this.camera.updateProjectionMatrix();

    const sense = tan / baseTan;
    this.controls.pointerSpeed = sense;
    setLookScale(sense);

    const on = k >= SNAP;
    if (on !== this.on) {
      this.on = on;
      this.weapons.scoped = on;
      this.el?.classList.toggle('on', on);
      document.body.classList.toggle('scoped', on);
    }
  }
}
