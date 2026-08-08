// Combat HUD: weapon name, ammo counter, score, and the crosshair hitmarker.
// Owns the DOM so no other module has to touch elements directly.

const HITMARKER_MS = 110;

export class Hud {
  constructor() {
    this.weaponEl = document.getElementById('weapon');
    this.ammoEl = document.getElementById('ammo');
    this.scoreEl = document.getElementById('score');
    this.markerEl = document.getElementById('hitmarker');
    this._markerTimer = 0;
  }

  setWeapon(index, name) {
    this.weaponEl.textContent = `${index + 1} · ${name}`;
  }

  setAmmo(mag, size, reloading) {
    this.ammoEl.textContent = reloading ? 'RELOADING' : `${mag} / ${size}`;
    this.ammoEl.classList.toggle('reloading', reloading);
    this.ammoEl.classList.toggle('empty', !reloading && mag === 0);
  }

  setScore(kills, hits) {
    this.scoreEl.textContent = `${kills} kills · ${hits} hits`;
  }

  // Flash the X over the crosshair; a kill shows it bigger and red.
  hitmarker(kill) {
    const el = this.markerEl;
    el.classList.remove('show', 'kill');
    void el.offsetWidth;               // restart the CSS transition
    el.classList.add('show');
    if (kill) el.classList.add('kill');

    clearTimeout(this._markerTimer);
    this._markerTimer = setTimeout(() => el.classList.remove('show', 'kill'), HITMARKER_MS);
  }
}
