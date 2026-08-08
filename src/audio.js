import * as THREE from 'three';
import { Sfx } from './sfx.js';

// The game's voice: every sound the office makes, named by what happened rather
// than by what it sounds like.
//
// Two layers, and the split is deliberate. Everything physical — guns, glass,
// boots, the people — is a sampled clip through sfx.js, because those are events
// with a real-world referent and synthesis of them lands somewhere between
// "retro" and "wrong". The hitmarker is still synthesised, because it is not a
// sound in the world at all: it is a readout, it fires many times a second, and a
// sampled blip repeated that fast is exactly the monotony samples were meant to
// fix.
//
// Nothing here plays a clip at a fixed pitch. Every play draws a take at random
// and a playback rate around it, and the enemy voices are pitched by body size on
// top of that, so six types out of three recordings still sound like six people.

// name -> mix. `gain` is level, `pitch` the ± playback-rate jitter, `minGap` a
// throttle for anything that can fire in a burst (nine shotgun pellets land on
// one wall in one frame), `maxVoices` the per-sound concurrency cap.
const LIBRARY = {
  'pistol-fire':  { variants: 3, gain: 0.80, pitch: 0.05, maxVoices: 6 },
  'smg-fire':     { variants: 3, gain: 0.62, pitch: 0.06, maxVoices: 8 },
  'shotgun-fire': { variants: 3, gain: 0.95, pitch: 0.04, maxVoices: 4 },
  'rifle-fire':   { variants: 3, gain: 0.80, pitch: 0.05, maxVoices: 8 },
  'sniper-fire':  { variants: 2, gain: 1.00, pitch: 0.03, maxVoices: 3 },

  'mag-out':  { variants: 2, gain: 0.45, pitch: 0.07 },
  'mag-in':   { variants: 2, gain: 0.50, pitch: 0.07 },
  'dry-fire': { variants: 2, gain: 0.40, pitch: 0.08, minGap: 0.08 },

  'enemy-fire':  { variants: 3, gain: 0.75, pitch: 0.09, minGap: 0.03, maxVoices: 8 },
  'melee-swing': { variants: 2, gain: 0.50, pitch: 0.12, minGap: 0.05, maxVoices: 4 },
  'melee-hit':   { variants: 2, gain: 0.80, pitch: 0.10, minGap: 0.05, maxVoices: 3 },

  'enemy-alert': { variants: 3, gain: 0.70, pitch: 0.08, minGap: 0.10, maxVoices: 3 },
  'enemy-pain':  { variants: 3, gain: 0.65, pitch: 0.09, minGap: 0.06, maxVoices: 4 },
  'enemy-death': { variants: 3, gain: 0.80, pitch: 0.07, minGap: 0.08, maxVoices: 4 },
  'enemy-idle':  { variants: 2, gain: 0.45, pitch: 0.10, minGap: 0.50, maxVoices: 2 },
  'enemy-step':  { variants: 3, gain: 0.55, pitch: 0.14, minGap: 0.05, maxVoices: 6 },

  'hit-flesh':   { variants: 3, gain: 0.70, pitch: 0.12, minGap: 0.05, maxVoices: 4 },
  'impact-wall': { variants: 3, gain: 0.45, pitch: 0.13, minGap: 0.04, maxVoices: 4 },

  'player-hurt':  { variants: 3, gain: 0.80, pitch: 0.07, minGap: 0.35, maxVoices: 2 },
  'player-death': { gain: 1.00, pitch: 0.03, maxVoices: 1 },

  'glass-break': { variants: 3, gain: 0.75, pitch: 0.10, minGap: 0.04, maxVoices: 4 },
  'prop-break':  { variants: 3, gain: 0.70, pitch: 0.10, minGap: 0.04, maxVoices: 4 },
  'tube-break':  { variants: 2, gain: 0.65, pitch: 0.12, minGap: 0.04, maxVoices: 3 },

  step:   { variants: 4, gain: 0.30, pitch: 0.14, minGap: 0.10, maxVoices: 3 },
  land:   { variants: 2, gain: 0.50, pitch: 0.10, minGap: 0.10, maxVoices: 2 },

  'floor-clear': { gain: 0.55, pitch: 0.01, maxVoices: 1 },
  descend:       { gain: 0.70, pitch: 0.02, maxVoices: 1 },

  'amb-office': { gain: 0.30, pitch: 0 },
  'amb-drone':  { gain: 0.22, pitch: 0 },
};

// How far a placed sound is still worth spawning a voice for. The panner would
// make it inaudible anyway; this stops a floor of 28 enemies spending the voice
// budget on footsteps in rooms you cannot hear.
const AUDIBLE = 26;
const AUDIBLE_STEP = 15;

// Enemy voices are pitched by body size. The scale spread across the six types
// is only 0.9–1.14, far too narrow to hear, so it is exaggerated hard: an intern
// ends up a fourth above a manager.
const VOICE_EXPONENT = -2.4;

export class GameAudio {
  constructor() {
    this.sfx = new Sfx();
    for (const [name, spec] of Object.entries(LIBRARY)) this.sfx.define(name, spec);
    this.sfx.preload();

    this._pos = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._at = { x: 0, y: 0, z: 0 };
    this._listener = null;   // the camera, once the game hands it over
  }

  /**
   * Wakes the audio context and brings the ambience up. Must be called from a
   * user gesture — the click that locks the pointer — or the browser refuses,
   * so this is idempotent and safe to call on every click.
   */
  start() {
    if (!this.sfx.resume()) return;
    if (!this._ambient) {
      this._ambient = true;
      this.sfx.loop('amb-office');
      this.sfx.loop('amb-drone');
    }
  }

  /** Keeps the ears on the camera, so placed sounds pan and fall off correctly. */
  update(dt, camera) {
    if (!this.sfx.ready) return;
    camera.getWorldPosition(this._pos);
    camera.getWorldDirection(this._fwd);
    this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.sfx.setListener(
      this._pos.x, this._pos.y, this._pos.z,
      this._fwd.x, this._fwd.y, this._fwd.z,
      this._up.x, this._up.y, this._up.z
    );
  }

  // --- the player's gun ---------------------------------------------------------

  /** `stats` is the weapon entry from weapons.js; `stats.sound` names its clip. */
  playerShot(stats) {
    this.sfx.play(stats.sound ?? 'pistol-fire');
  }

  dryFire() {
    this.sfx.play('dry-fire');
  }

  /** Magazine out now, magazine in near the end of the animation. */
  reload(duration) {
    this.sfx.play('mag-out');
    this.sfx.play('mag-in', { delay: duration * 0.55 });
  }

  weaponSwitch() {
    this.sfx.play('mag-in', { gain: 0.5, rate: 1.15 });
  }

  // --- bullets landing ----------------------------------------------------------

  bulletHitFlesh(point) {
    this.sfx.play('hit-flesh', { at: this._place(point) });
  }

  bulletHitWall(point) {
    this.sfx.play('impact-wall', { at: this._place(point) });
  }

  /**
   * The hitmarker: a rising blip on a hit, a falling two-note on a kill. Kept
   * synthesised on purpose — see the note at the top of the file.
   */
  ping(kill = false) {
    const ctx = this.sfx.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const notes = kill ? [1180, 780] : [1560];

    notes.forEach((freq, i) => {
      const t = t0 + i * 0.07;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      // Even the readout drifts a little, so a long burst doesn't turn into a
      // single sustained tone.
      osc.frequency.value = freq * (0.97 + Math.random() * 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.13, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.connect(g).connect(this.sfx.sfxBus);
      osc.start(t);
      osc.stop(t + 0.1);
    });
  }

  // --- the staff ----------------------------------------------------------------

  enemyShot(enemy) {
    if (!this._near(enemy, AUDIBLE)) return;
    // Bigger types fire lower, so you can hear what is shooting at you.
    this.sfx.play('enemy-fire', {
      at: this._at, rate: Math.pow(enemy.type.scale, -1.4),
    });
  }

  enemyMeleeSwing(enemy) {
    if (!this._near(enemy, AUDIBLE)) return;
    this.sfx.play('melee-swing', { at: this._at, rate: Math.pow(enemy.type.scale, -1.2) });
  }

  /** A swing that connected. At the camera — it happened to you, not near you. */
  meleeHit() {
    this.sfx.play('melee-hit');
  }

  enemyAlert(enemy) { this._voice(enemy, 'enemy-alert', AUDIBLE); }
  enemyPain(enemy)  { this._voice(enemy, 'enemy-pain', AUDIBLE); }
  enemyDeath(enemy) { this._voice(enemy, 'enemy-death', AUDIBLE); }
  enemyIdle(enemy)  { this._voice(enemy, 'enemy-idle', AUDIBLE_STEP); }

  enemyStep(enemy) {
    if (!this._near(enemy, AUDIBLE_STEP)) return;
    this.sfx.play('enemy-step', { at: this._at, rate: Math.pow(enemy.type.scale, -0.8) });
  }

  // --- the player ---------------------------------------------------------------

  playerHurt(amount) {
    this.sfx.play('player-hurt', { gain: 0.6 + Math.min(1, amount / 20) * 0.5 });
  }

  playerDeath() {
    this.sfx.play('player-death');
  }

  /** `fast` is true while sprinting: a harder, slightly quicker footfall. */
  step(fast = false) {
    this.sfx.play('step', { gain: fast ? 1.25 : 1, rate: fast ? 1.08 : 1 });
  }

  /** `impact` is 0..1, how hard the landing was. */
  land(impact = 1) {
    this.sfx.play('land', { gain: 0.5 + impact * 0.6 });
  }

  // --- the building coming apart ------------------------------------------------

  /** `kind` is a destructible's kind: 'glass', 'panel' (a ceiling tube), 'prop'. */
  breakThing(kind, point) {
    const name = kind === 'glass' ? 'glass-break'
      : kind === 'panel' ? 'tube-break'
      : 'prop-break';
    this.sfx.play(name, { at: this._place(point) });
  }

  // --- the run ------------------------------------------------------------------

  floorClear() { this.sfx.play('floor-clear'); }
  descend() { this.sfx.play('descend'); }

  // --- internals ----------------------------------------------------------------

  _voice(enemy, name, range) {
    if (!this._near(enemy, range)) return;
    this.sfx.play(name, { at: this._at, rate: Math.pow(enemy.type.scale, VOICE_EXPONENT) });
  }

  // Fills the shared placement scratch from an enemy, and says whether they are
  // close enough to be worth a voice at all.
  _near(enemy, range) {
    if (!this.sfx.ready) return false;
    const dx = enemy.x - this._pos.x;
    const dz = enemy.z - this._pos.z;
    if (dx * dx + dz * dz > range * range) return false;
    this._at.x = enemy.x;
    this._at.y = 1.2;
    this._at.z = enemy.z;
    return true;
  }

  _place(point) {
    this._at.x = point.x;
    this._at.y = point.y;
    this._at.z = point.z;
    return this._at;
  }
}
