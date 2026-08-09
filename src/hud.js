// Combat HUD: floor + objective, minimap frame, health, weapon/ammo, score,
// crosshair hitmarker, damage vignette, toasts and the death screen.
//
// The HUD owns its DOM: no other module touches these elements. Every timed
// effect is driven from `update(dt)` off the render loop rather than setTimeout,
// so effects pause exactly when the game does.

const HIT_S = 0.11;        // hitmarker flash
const KILL_S = 0.20;       // kill marker lingers a little longer
const VIGNETTE_DECAY = 2.4; // full-strength damage flash fades in ~0.4 s
const TOAST_FADE = 0.35;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Hud {
  constructor() {
    const $ = (id) => document.getElementById(id);

    this.floorEl = $('floor');
    this.objectiveEl = $('objective');
    this.scoreEl = $('score');

    this.healthEl = $('health');
    this.healthFillEl = $('health-fill');
    this.healthValueEl = $('health-value');

    this.weaponEl = $('weapon');
    this.ammoEl = $('ammo');
    this.keycardsEl = $('keycards');

    this.markerEl = $('hitmarker');
    this.vignetteEl = $('vignette');
    this.toastEl = $('toast');

    this.gameOverEl = $('gameover');
    this.goFloorEl = $('go-floor');
    this.goKillsEl = $('go-kills');

    this._marker = 0;    // seconds of hitmarker left
    this._vignette = 0;  // 0..1 damage flash
    this._toast = 0;     // seconds of toast left
  }

  // --- persistent readouts ---------------------------------------------------

  setWeapon(index, name) {
    this.weaponEl.textContent = `${index + 1} · ${name}`;
  }

  setAmmo(mag, size, reloading) {
    this.ammoEl.textContent = reloading ? 'RELOADING' : `${mag} / ${size}`;
    this.ammoEl.classList.toggle('reloading', !!reloading);
    this.ammoEl.classList.toggle('empty', !reloading && mag === 0);
    this.ammoEl.classList.toggle('low', !reloading && mag > 0 && mag <= size * 0.25);
  }

  setHealth(hp, max = 100) {
    const frac = clamp01(max > 0 ? hp / max : 0);
    this.healthFillEl.style.width = `${frac * 100}%`;
    this.healthValueEl.textContent = String(Math.max(0, Math.ceil(hp)));
    this.healthEl.classList.toggle('low', frac < 0.5 && frac >= 0.25);
    this.healthEl.classList.toggle('critical', frac < 0.25);
  }

  setFloor(n) {
    this.floorEl.textContent = `FLOOR ${n}`;
  }

  // The cards in hand, already in rank order (see keycards.js). Rebuilt whole
  // rather than diffed: it changes a handful of times a floor and never holds
  // more than five chips.
  setKeycards(tiers) {
    if (!this.keycardsEl) return;
    this.keycardsEl.replaceChildren(...tiers.map(({ name, css }) => {
      const el = document.createElement('div');
      el.className = 'card';
      el.style.background = css;
      el.title = `${name} keycard`;
      return el;
    }));
  }

  setObjective(text) {
    this.objectiveEl.textContent = text;
  }

  setScore(kills, floorsCleared) {
    const f = floorsCleared === 1 ? 'floor' : 'floors';
    this.scoreEl.textContent = `${kills} kills · ${floorsCleared} ${f}`;
  }

  // --- transient effects -----------------------------------------------------

  // Flash the X over the crosshair; a kill shows it bigger and red.
  hitmarker(kill) {
    const el = this.markerEl;
    el.classList.remove('show', 'kill');
    void el.offsetWidth;                 // restart the CSS transition
    el.classList.add('show');
    if (kill) el.classList.add('kill');
    this._marker = kill ? KILL_S : HIT_S;
  }

  // Red vignette pulse when the player takes a hit. `intensity` is 0..1; a
  // stronger hit overrides a fading one rather than stacking with it.
  damage(intensity = 0.6) {
    this._vignette = Math.max(this._vignette, clamp01(intensity));
    this.vignetteEl.style.opacity = String(this._vignette);
  }

  // Big centred toast: "FLOOR 3", "FLOOR CLEAR", "EXIT UNLOCKED".
  message(text, ms = 1600) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
    this._toast = ms / 1000;
  }

  gameOver(show, stats = {}) {
    if (show) {
      this.goFloorEl.textContent = String(stats.floor ?? 1);
      this.goKillsEl.textContent = String(stats.kills ?? 0);
    }
    this.gameOverEl.classList.toggle('show', !!show);
    document.body.classList.toggle('dead', !!show);   // fades the live HUD out
    if (show) {
      // Clear anything mid-flight so the death screen reads clean.
      this._toast = 0;
      this.toastEl.classList.remove('show');
      this._vignette = 0;
      this.vignetteEl.style.opacity = '0';
    }
  }

  // --- per frame -------------------------------------------------------------

  update(dt) {
    if (dt > 1) dt /= 1000;              // tolerate a caller passing milliseconds

    if (this._marker > 0) {
      this._marker -= dt;
      if (this._marker <= 0) this.markerEl.classList.remove('show', 'kill');
    }

    if (this._vignette > 0) {
      this._vignette = Math.max(0, this._vignette - dt * VIGNETTE_DECAY);
      this.vignetteEl.style.opacity = String(this._vignette);
    }

    if (this._toast > 0) {
      this._toast -= dt;
      if (this._toast <= TOAST_FADE) this.toastEl.classList.remove('show');
      if (this._toast <= 0) this._toast = 0;
    }
  }
}
