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

// name -> mix. `gain` is level, `pitch` the ± playback-rate jitter, `maxVoices`
// the per-sound concurrency cap.
//
// Everything overlaps, and the caps sit far above anything the game can actually
// reach. Nothing here rate-limits an event that really happened: a dropped shot
// is silence, and silence in the middle of a burst reads as the gun jamming. The
// arithmetic is just length ÷ interval — the SMG's 0.7 s clip at 900 rpm is ten
// shots ringing at once before anything else joins in, and a firefight puts a
// room of return fire, impacts, boots and screaming on top of that. The pile-up
// is the point. Keeping the sum in range is the limiter's job on the master bus,
// not a voice budget's.
//
// `minGap` is the one exception, and it is only ever used where a single throat
// is making the sound: there is one player, and they cannot grunt four times at
// once. Anything with many sources — footsteps, a floor full of staff — overlaps
// freely.
const LIBRARY = {
  'pistol-fire':  { variants: 3, gain: 0.80, pitch: 0.05, maxVoices: 24 },
  'smg-fire':     { variants: 3, gain: 0.62, pitch: 0.06, maxVoices: 40 },
  'shotgun-fire': { variants: 3, gain: 0.95, pitch: 0.04, maxVoices: 12 },
  'rifle-fire':   { variants: 3, gain: 0.80, pitch: 0.05, maxVoices: 32 },
  'sniper-fire':  { variants: 2, gain: 1.00, pitch: 0.03, maxVoices: 8 },

  'mag-out':  { variants: 2, gain: 0.45, pitch: 0.07, maxVoices: 8 },
  'mag-in':   { variants: 2, gain: 0.50, pitch: 0.07, maxVoices: 8 },
  'dry-fire': { variants: 2, gain: 0.40, pitch: 0.08, maxVoices: 8 },

  // A floor holds up to 28 of these, so the caps are sized for a room of them
  // going off at once rather than for one.
  'enemy-fire':  { variants: 3, gain: 0.75, pitch: 0.09, maxVoices: 40 },
  'melee-swing': { variants: 2, gain: 0.50, pitch: 0.12, maxVoices: 20 },
  'melee-hit':   { variants: 2, gain: 0.80, pitch: 0.10, maxVoices: 8 },

  // The office staff, who shout actual words at you. Twelve takes because these
  // are the only clips in the set with *content* — pitch jitter disguises a
  // repeated gunshot, and does nothing at all for a repeated sentence.
  'enemy-alert': { variants: 12, gain: 0.75, pitch: 0.04, maxVoices: 16 },
  'enemy-pain':  { variants: 3, gain: 0.65, pitch: 0.09, maxVoices: 20 },
  'enemy-death': { variants: 3, gain: 0.80, pitch: 0.07, maxVoices: 20 },
  // Idle muttering is atmosphere, not an event, so this one is spaced — a floor
  // of staff all grumbling at once is a crowd, not an empty office.
  'enemy-idle':  { variants: 2, gain: 0.45, pitch: 0.10, minGap: 0.6, maxVoices: 4 },

  // The green ones, up from further down. Same events, a different throat.
  'zombie-alert': { variants: 3, gain: 0.75, pitch: 0.08, maxVoices: 16 },
  'zombie-pain':  { variants: 3, gain: 0.70, pitch: 0.09, maxVoices: 20 },
  'zombie-death': { variants: 3, gain: 0.85, pitch: 0.07, maxVoices: 20 },
  'zombie-idle':  { variants: 2, gain: 0.55, pitch: 0.10, minGap: 0.6, maxVoices: 4 },

  // The sentry units. Pitch jitter stays low here — a servo that wanders in
  // pitch stops sounding like a machine.
  'robot-alert': { variants: 3, gain: 0.70, pitch: 0.03, maxVoices: 16 },
  'robot-pain':  { variants: 3, gain: 0.65, pitch: 0.04, maxVoices: 20 },
  'robot-death': { variants: 3, gain: 0.85, pitch: 0.03, maxVoices: 20 },
  'robot-idle':  { variants: 2, gain: 0.50, pitch: 0.04, minGap: 0.6, maxVoices: 4 },
  'robot-step':  { variants: 3, gain: 0.60, pitch: 0.06, maxVoices: 32 },

  'enemy-step': { variants: 3, gain: 0.55, pitch: 0.14, maxVoices: 32 },

  // What the bullet landed on. Every surface in the building answers back.
  'hit-flesh':    { variants: 3, gain: 0.70, pitch: 0.12, maxVoices: 32 },
  'impact-wall':  { variants: 3, gain: 0.45, pitch: 0.13, maxVoices: 40 },
  'impact-metal': { variants: 3, gain: 0.50, pitch: 0.13, maxVoices: 32 },
  'impact-glass': { variants: 3, gain: 0.55, pitch: 0.12, maxVoices: 32 },
  'impact-wood':  { variants: 3, gain: 0.50, pitch: 0.13, maxVoices: 32 },

  'player-hurt':  { variants: 3, gain: 0.80, pitch: 0.07, minGap: 0.3, maxVoices: 2 },
  'player-death': { gain: 1.00, pitch: 0.03, maxVoices: 1 },
  // One player, one set of lungs: both of these are spaced rather than stacked.
  jump:   { variants: 3, gain: 0.40, pitch: 0.08, minGap: 0.25, maxVoices: 2 },
  breath: { variants: 3, gain: 0.30, pitch: 0.08, minGap: 0.9, maxVoices: 2 },

  'glass-break':   { variants: 3, gain: 0.75, pitch: 0.10, maxVoices: 16 },
  'prop-break':    { variants: 3, gain: 0.70, pitch: 0.10, maxVoices: 16 },
  'tube-break':    { variants: 2, gain: 0.65, pitch: 0.12, maxVoices: 12 },
  'debris-settle': { variants: 3, gain: 0.45, pitch: 0.12, maxVoices: 12 },
  // Walking into furniture is continuous contact, so this is one scrape rather
  // than one per frame.
  'prop-shove':    { variants: 3, gain: 0.40, pitch: 0.12, minGap: 0.4, maxVoices: 4 },

  step: { variants: 4, gain: 0.30, pitch: 0.14, maxVoices: 16 },
  land: { variants: 2, gain: 0.50, pitch: 0.10, maxVoices: 8 },

  'shell-casing': { variants: 3, gain: 0.28, pitch: 0.16, maxVoices: 24 },

  'floor-clear': { gain: 0.55, pitch: 0.01, maxVoices: 2 },
  descend:       { gain: 0.70, pitch: 0.02, maxVoices: 2 },
  'low-health':  { variants: 2, gain: 0.45, pitch: 0.02, maxVoices: 2 },
  heal:          { gain: 0.45, pitch: 0.02, maxVoices: 2 },

  'amb-office': { gain: 0.30, pitch: 0, bed: true },
  'amb-drone':  { gain: 0.22, pitch: 0, bed: true },
};

// Shotgun pellets all land on the same frame, so their impacts would start on
// the identical sample and sum into one thump instead of nine. Scattering them
// over a few milliseconds keeps every one of them audible — and is what a spray
// of pellets does anyway.
const IMPACT_SCATTER = 0.03;

// Only the sentries walk differently enough to need their own footfall; a
// reanimated colleague still lands like a person in office shoes.
const STEP_CLIP = { robot: 'robot-step' };

// What each destructible is made of, for the bullet that hits it and for the
// noise it makes coming apart.
const IMPACT_CLIP = { glass: 'impact-glass', panel: 'impact-metal', prop: 'impact-wood' };
const BREAK_CLIP = { glass: 'glass-break', panel: 'tube-break', prop: 'prop-break' };

const CASING_DELAY = 0.26;    // seconds after the shot before brass lands
const DEBRIS_DELAY = 0.8;     // ...and before the wreckage stops moving

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
    // Brass lands a moment after the shot, which is most of what sells a gun as
    // a mechanism rather than a sample.
    this.sfx.play('shell-casing', { delay: CASING_DELAY + Math.random() * 0.12 });
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
    this.sfx.play('hit-flesh', { at: this._place(point), delay: Math.random() * IMPACT_SCATTER });
  }

  bulletHitWall(point) {
    this.sfx.play('impact-wall', { at: this._place(point), delay: Math.random() * IMPACT_SCATTER });
  }

  /**
   * A bullet landed on something breakable, which knows what it is made of.
   * `kind` is a destructible's kind: 'glass', 'panel' (a ceiling tube), 'prop'.
   */
  bulletHitMaterial(kind, point) {
    this.sfx.play(IMPACT_CLIP[kind] ?? 'impact-wood', {
      at: this._place(point), delay: Math.random() * IMPACT_SCATTER,
    });
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

  // Which set of vocals a type uses is its own business: the office staff gobble
  // like turkeys, the green ones moan. A type names its set with `voice`.
  enemyAlert(enemy) { this._voice(enemy, 'alert', AUDIBLE); }
  enemyPain(enemy)  { this._voice(enemy, 'pain', AUDIBLE); }
  enemyDeath(enemy) { this._voice(enemy, 'death', AUDIBLE); }
  enemyIdle(enemy)  { this._voice(enemy, 'idle', AUDIBLE_STEP); }

  enemyStep(enemy) {
    if (!this._near(enemy, AUDIBLE_STEP)) return;
    this.sfx.play(STEP_CLIP[enemy.type.voice] ?? 'enemy-step', {
      at: this._at, rate: Math.pow(enemy.type.scale, -0.8),
    });
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
    const at = this._place(point);
    this.sfx.play(BREAK_CLIP[kind] ?? 'prop-break', { at });
    // The tail is what makes destruction read as heavy: the thing breaks, then a
    // second later the pieces stop moving.
    this.sfx.play('debris-settle', { at, delay: DEBRIS_DELAY + Math.random() * 0.4 });
  }

  /** Furniture shoved aside by the player walking into it. */
  propShove(point) {
    this.sfx.play('prop-shove', { at: this._place(point) });
  }

  jump() { this.sfx.play('jump'); }
  breath() { this.sfx.play('breath'); }
  heal() { this.sfx.play('heal'); }
  lowHealth(urgency = 0) { this.sfx.play('low-health', { gain: 0.7 + urgency * 0.6 }); }

  // --- the run ------------------------------------------------------------------

  floorClear() { this.sfx.play('floor-clear'); }
  descend() { this.sfx.play('descend'); }

  // --- internals ----------------------------------------------------------------

  _voice(enemy, event, range) {
    if (!this._near(enemy, range)) return;
    const set = enemy.type.voice ?? 'enemy';
    this.sfx.play(`${set}-${event}`, {
      at: this._at, rate: Math.pow(enemy.type.scale, VOICE_EXPONENT),
    });
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
