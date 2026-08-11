// Combat HUD: floor + objective, minimap frame, health, weapon/ammo, score,
// crosshair hitmarker, damage vignette, toasts and the death screen.
//
// The HUD owns its DOM: no other module touches these elements. Every timed
// effect is driven from `update(dt)` off the render loop rather than setTimeout,
// so effects pause exactly when the game does.

import { angleDelta, clamp01 } from './util.js';

const HIT_S = 0.11;        // hitmarker flash
const KILL_S = 0.20;       // kill marker lingers a little longer
const VIGNETTE_DECAY = 2.4; // full-strength damage flash fades in ~0.4 s
const TOAST_FADE = 0.35;

// Hit direction wedges. The pool is fixed and matches the markup — running out
// is not a failure case, it just means the oldest one is reused, and six is well
// past the point where any more would be readable anyway.
const HITDIR_S = 1.15;         // seconds a wedge lives
const HITDIR_HOLD = 0.35;      // ...held at full before it starts fading
// Two hits from about the same place refresh one wedge instead of stacking two
// on top of each other. An SMG burst is one attacker, and it should look like
// one attacker.
const HITDIR_MERGE = 0.3;      // radians

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

    this.watchEl = $('watch');
    this.watchFillEl = $('watch-fill');
    this.alarmEl = $('alarm-flash');
    this._watch = -1;    // last value written, so a still frame writes nothing

    this.gameOverEl = $('gameover');
    this.goFloorEl = $('go-floor');
    this.goKillsEl = $('go-kills');

    this._marker = 0;    // seconds of hitmarker left
    this._vignette = 0;  // 0..1 damage flash
    this._toast = 0;     // seconds of toast left

    // Where the player is and which way they are looking, refreshed every frame
    // by game.js. The wedges need it because they point at a WORLD direction:
    // turning has to swing them, which is the entire point of them.
    this._eyeX = 0;
    this._eyeZ = 0;
    this._facing = 0;

    // `world` is the compass bearing of whoever landed the hit, fixed at the
    // moment it landed. Nothing re-aims it afterwards — it is a memory of where
    // the shot came from, not a tracker.
    this._hitdirs = [...document.querySelectorAll('#hitdirs .hitdir')]
      .map((el) => ({ el, life: 0, world: 0, strength: 0 }));
  }

  // Called every frame from game.js, before anything that reads it.
  setFacing(x, z, yaw) {
    this._eyeX = x;
    this._eyeZ = z;
    this._facing = yaw;
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

  /**
   * How much of a camera's patience is spent, 0..1. Zero hides the whole thing.
   *
   * Written every frame, so it is diffed here rather than at the call site: the
   * value is unchanged on the overwhelming majority of frames — nothing is
   * looking at you — and three style writes a frame for that is three too many.
   */
  setWatch(fraction) {
    // Snapped to nothing at the bottom of the range. The count decays rather
    // than resetting when a camera loses you (see cameras.js), so without this
    // the last hundredth of it takes half a minute to expire and leaves a
    // hairline of bar on screen saying something is still watching.
    const v = fraction > 0.01 ? clamp01(fraction) : 0;
    if (v === this._watch) return;
    this._watch = v;
    this.watchEl?.classList.toggle('show', v > 0);
    this.watchEl?.classList.toggle('close', v > 0.66);
    if (this.watchFillEl) this.watchFillEl.style.width = `${v * 100}%`;
  }

  /** Somebody called it in. One wash of red, restarted if it happens again. */
  alarm() {
    const el = this.alarmEl;
    if (!el) return;
    el.classList.remove('fire');
    void el.offsetWidth;                 // restart the CSS animation
    el.classList.add('fire');
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

  /**
   * The player took a hit. `intensity` is 0..1 and drives the red rim; a
   * stronger hit overrides a fading one rather than stacking with it.
   *
   * `sx`/`sz` are where it came from, and they are what turn "I am being hit"
   * into "I am being hit from behind and to the left", which is the difference
   * between a number going down and a decision. Leave them out and only the rim
   * fires — some damage genuinely has no direction.
   */
  damage(intensity = 0.6, sx = null, sz = null) {
    this._vignette = Math.max(this._vignette, clamp01(intensity));
    this.vignetteEl.style.opacity = String(this._vignette);
    if (sx === null || sz === null) return;

    const dx = sx - this._eyeX;
    const dz = sz - this._eyeZ;
    // Standing inside the blast has no direction to point at.
    if (Math.hypot(dx, dz) < 0.4) return;

    const world = Math.atan2(dx, dz);
    const strength = 0.55 + clamp01(intensity) * 0.45;

    // Same attacker as one already showing? Refresh that wedge rather than
    // spending another on the same information.
    let slot = null;
    for (const w of this._hitdirs) {
      if (w.life > 0 && Math.abs(angleDelta(w.world, world)) < HITDIR_MERGE) { slot = w; break; }
    }
    // Otherwise the deadest one — a free slot if there is one, and the oldest
    // live wedge if there is not.
    if (!slot) {
      slot = this._hitdirs[0];
      for (const w of this._hitdirs) if (w.life < slot.life) slot = w;
    }

    slot.world = world;
    slot.life = HITDIR_S;
    slot.strength = Math.max(slot.strength, strength);
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
      this.setWatch(0);
      this.alarmEl?.classList.remove('fire');
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

    this._placeHitDirs(dt);
  }

  /**
   * Swing the live wedges round to where their attackers are.
   *
   * Re-aimed every frame rather than at the moment of the hit, because the whole
   * job of the thing is that turning toward the shot brings its wedge up to the
   * top of the screen. A fixed screen angle would rotate with you and point at
   * nothing.
   *
   * Screen angle 0 is straight ahead, and it grows clockwise, which is what CSS
   * rotate() already does — so once the bearing is worked out relative to the
   * facing there is nothing left to convert.
   */
  _placeHitDirs(dt) {
    for (const w of this._hitdirs) {
      if (w.life <= 0) continue;

      w.life -= dt;
      if (w.life <= 0) {
        w.life = 0;
        w.strength = 0;
        w.el.style.opacity = '0';
        continue;
      }

      const deg = (this._facing + Math.PI - w.world) * 180 / Math.PI;
      const fade = Math.min(1, w.life / (HITDIR_S - HITDIR_HOLD));
      w.el.style.transform = `rotate(${deg}deg)`;
      w.el.style.opacity = String(fade * w.strength);
    }
  }
}
