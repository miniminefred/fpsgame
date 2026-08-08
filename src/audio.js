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

// name -> mix. `gain` is its level and `pitch` the ± playback-rate jitter.
//
// There are no caps and no throttles in this table, because there are none in
// the engine either. Whatever the game says happened gets played, however many
// of them are already ringing: the SMG's 0.7 s clip at 900 rpm is ten shots
// overlapping before anything else joins in, and a firefight stacks a room of
// return fire, impacts, boots and screaming on top. That pile-up is the sound of
// a firefight. Holding the sum inside full scale is the limiter's job on the
// master bus — dropping events is nobody's.
//
// Which leaves `gain` doing real work: with nothing being discarded, the only
// thing keeping a floor of enemies from burying the gun in your hands is that
// each clip is mixed to the size of the thing that made it.
const LIBRARY = {
  'pistol-fire':  { variants: 3, gain: 0.80, pitch: 0.05 },
  'smg-fire':     { variants: 3, gain: 0.62, pitch: 0.06 },
  'shotgun-fire': { variants: 3, gain: 0.95, pitch: 0.04 },
  'rifle-fire':   { variants: 3, gain: 0.80, pitch: 0.05 },
  'sniper-fire':  { variants: 2, gain: 1.00, pitch: 0.03 },

  'mag-out':  { variants: 2, gain: 0.45, pitch: 0.07 },
  'mag-in':   { variants: 2, gain: 0.50, pitch: 0.07 },
  'dry-fire': { variants: 2, gain: 0.40, pitch: 0.08 },

  // A floor holds up to 28 of these, and on a bad one they all shoot at once.
  'enemy-fire':  { variants: 3, gain: 0.75, pitch: 0.09 },
  'melee-swing': { variants: 2, gain: 0.50, pitch: 0.12 },
  'melee-hit':   { variants: 2, gain: 0.80, pitch: 0.10 },

  // The office staff, who shout actual sentences at you. This is the one clip in
  // the set with *content*, and content is the thing variation cannot fake:
  // pitch jitter hides a repeated gunshot completely and does nothing whatsoever
  // for a repeated punchline. Hence twenty-five of them, where three would do
  // for anything else.
  'enemy-alert': { variants: 26, gain: 0.75, pitch: 0.04 },
  'enemy-pain':  { variants: 3, gain: 0.65, pitch: 0.09 },
  'enemy-death': { variants: 3, gain: 0.80, pitch: 0.07 },
  // Idle muttering is the one vocal that is atmosphere rather than an event, so
  // its spacing lives in the enemy that does the muttering (see _mutter), not in
  // a throttle here.
  'enemy-idle':  { variants: 2, gain: 0.45, pitch: 0.10 },

  // The green ones, up from further down. Same events, a different throat.
  'zombie-alert': { variants: 3, gain: 0.75, pitch: 0.08 },
  'zombie-pain':  { variants: 3, gain: 0.70, pitch: 0.09 },
  'zombie-death': { variants: 3, gain: 0.85, pitch: 0.07 },
  'zombie-idle':  { variants: 2, gain: 0.55, pitch: 0.10 },

  // The sentry units. Pitch jitter stays low here — a servo that wanders in
  // pitch stops sounding like a machine.
  'robot-alert': { variants: 3, gain: 0.70, pitch: 0.03 },
  'robot-pain':  { variants: 3, gain: 0.65, pitch: 0.04 },
  'robot-death': { variants: 3, gain: 0.85, pitch: 0.03 },
  'robot-idle':  { variants: 2, gain: 0.50, pitch: 0.04 },
  'robot-step':  { variants: 3, gain: 0.60, pitch: 0.06 },

  'enemy-step': { variants: 3, gain: 0.55, pitch: 0.14 },

  // What the bullet landed on. Every surface in the building answers back in its
  // own material — see SUBSTANCE below for which prop is made of what.
  'hit-flesh':        { variants: 3, gain: 0.70, pitch: 0.12 },
  'impact-wall':      { variants: 3, gain: 0.45, pitch: 0.13 },
  'impact-metal':     { variants: 3, gain: 0.50, pitch: 0.13 },
  'impact-glass':     { variants: 3, gain: 0.55, pitch: 0.12 },
  'impact-wood':      { variants: 3, gain: 0.50, pitch: 0.13 },
  'impact-plastic':   { variants: 3, gain: 0.50, pitch: 0.14 },
  'impact-fabric':    { variants: 3, gain: 0.42, pitch: 0.14 },
  'impact-cardboard': { variants: 3, gain: 0.45, pitch: 0.14 },
  'impact-electronic':{ variants: 3, gain: 0.52, pitch: 0.12 },
  'impact-foliage':   { variants: 3, gain: 0.45, pitch: 0.15 },

  // Every hit you take is heard, including all four of a burst that lands in one
  // second. Being shot four times should sound like being shot four times.
  'player-hurt':  { variants: 3, gain: 0.80, pitch: 0.07 },
  'player-death': { gain: 1.00, pitch: 0.03 },
  jump:   { variants: 3, gain: 0.40, pitch: 0.08 },
  breath: { variants: 3, gain: 0.30, pitch: 0.08 },

  // Coming apart, one per substance. `prop-break` is the wooden one — it kept
  // its original name because it is on disk under it.
  'glass-break':      { variants: 3, gain: 0.75, pitch: 0.10 },
  'prop-break':       { variants: 3, gain: 0.70, pitch: 0.10 },
  'tube-break':       { variants: 2, gain: 0.65, pitch: 0.12 },
  'break-metal':      { variants: 3, gain: 0.78, pitch: 0.10 },
  'break-plastic':    { variants: 3, gain: 0.68, pitch: 0.11 },
  'break-fabric':     { variants: 3, gain: 0.55, pitch: 0.11 },
  'break-cardboard':  { variants: 3, gain: 0.60, pitch: 0.12 },
  'break-electronic': { variants: 3, gain: 0.75, pitch: 0.10 },
  'break-foliage':    { variants: 3, gain: 0.68, pitch: 0.11 },

  // ...and the tail a second later, as the pieces stop moving.
  'debris-settle':     { variants: 3, gain: 0.45, pitch: 0.12 },
  'settle-wood':       { variants: 3, gain: 0.45, pitch: 0.13 },
  'settle-metal':      { variants: 3, gain: 0.48, pitch: 0.13 },
  'settle-glass':      { variants: 3, gain: 0.50, pitch: 0.13 },
  'settle-plastic':    { variants: 3, gain: 0.45, pitch: 0.14 },
  'settle-electronic': { variants: 3, gain: 0.45, pitch: 0.13 },
  // Leaning on a desk is one shove, not sixty a second — but that is a fact
  // about the collision, so game.js decides when a shove has happened and this
  // plays every time it says so.
  'prop-shove':    { variants: 3, gain: 0.40, pitch: 0.12 },

  step: { variants: 4, gain: 0.30, pitch: 0.14 },
  land: { variants: 2, gain: 0.50, pitch: 0.10 },

  'shell-casing': { variants: 3, gain: 0.28, pitch: 0.16 },

  'floor-clear': { gain: 0.55, pitch: 0.01 },
  descend:       { gain: 0.70, pitch: 0.02 },
  'low-health':  { variants: 2, gain: 0.45, pitch: 0.02 },
  heal:          { gain: 0.45, pitch: 0.02 },

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

// What the office is made of. Every destructible carries a `substance` (see
// gen/props.js) and each one answers in its own voice three times over: when a
// bullet hits it, when it finally comes apart, and again a moment later as the
// pieces stop moving. A filing cabinet and a pot plant have no business sounding
// alike in any of those three.
//
// `settle` is allowed to be missing — a torn partition and a burst box do not
// clatter afterwards, they just stop.
const SUBSTANCE = {
  wood:       { impact: 'impact-wood',       break: 'prop-break',       settle: 'settle-wood' },
  metal:      { impact: 'impact-metal',      break: 'break-metal',      settle: 'settle-metal' },
  glass:      { impact: 'impact-glass',      break: 'glass-break',      settle: 'settle-glass' },
  plastic:    { impact: 'impact-plastic',    break: 'break-plastic',    settle: 'settle-plastic' },
  electronic: { impact: 'impact-electronic', break: 'break-electronic', settle: 'settle-electronic' },
  foliage:    { impact: 'impact-foliage',    break: 'break-foliage',    settle: 'settle-wood' },
  cardboard:  { impact: 'impact-cardboard',  break: 'break-cardboard',  settle: 'debris-settle' },
  fabric:     { impact: 'impact-fabric',     break: 'break-fabric' },
  // A fluorescent tube is steel to shoot at and glass to break, which is why it
  // is its own substance rather than either one.
  tube:       { impact: 'impact-metal',      break: 'tube-break',       settle: 'settle-glass' },
};

// The two destructibles that are part of the building rather than furniture, and
// so have no entry in the prop catalogue to carry a substance.
const KIND_SUBSTANCE = { glass: 'glass', panel: 'tube' };

// Anything whose substance never got set falls back to laminate panel, which is
// what most of an office is.
const DEFAULT_SUBSTANCE = 'wood';

const CASING_DELAY = 0.26;    // seconds after the shot before brass lands
const DEBRIS_DELAY = 0.8;     // ...and before the wreckage stops moving

// How far away a sound is still worth placing. This is not a budget — it is the
// range past which the panner's own falloff has already taken the clip below
// audible, so spawning it would be inaudible work rather than a sound you lose.
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
   * A bullet landed on something breakable. `kind` is the destructible's kind
   * ('glass', 'panel' for a ceiling tube, 'prop'); `substance` is what a prop is
   * made of, and is ignored for the two kinds that are part of the building.
   */
  bulletHitMaterial(kind, substance, point) {
    this.sfx.play(substanceOf(kind, substance).impact, {
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

  /** Something came apart. Same arguments as bulletHitMaterial. */
  breakThing(kind, substance, point) {
    const at = this._place(point);
    const spec = substanceOf(kind, substance);
    this.sfx.play(spec.break, { at });
    // The tail is what makes destruction read as heavy: the thing breaks, and a
    // second later its pieces stop moving. Some substances have no tail — a torn
    // partition does not clatter.
    if (spec.settle) {
      this.sfx.play(spec.settle, { at, delay: DEBRIS_DELAY + Math.random() * 0.4 });
    }
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

// Window glazing and ceiling tubes are part of the building and never went
// through the prop catalogue, so their kind names their substance; everything
// else is furniture and brought its own.
function substanceOf(kind, substance) {
  return SUBSTANCE[KIND_SUBSTANCE[kind] ?? substance] ?? SUBSTANCE[DEFAULT_SUBSTANCE];
}
