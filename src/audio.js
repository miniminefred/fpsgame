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
  // Five takes and mixed hot: it is the loudest thing in the building and
  // the whole point of carrying it.
  'shotgun-fire': { variants: 5, gain: 1.35, pitch: 0.035 },
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
  'enemy-alert': { variants: 50, gain: 0.75, pitch: 0.04 },
  'enemy-pain':  { variants: 3, gain: 0.65, pitch: 0.09 },
  'enemy-death': { variants: 3, gain: 0.80, pitch: 0.07 },
  // Idle muttering is the one vocal that is atmosphere rather than an event, so
  // its spacing lives in the enemy that does the muttering (see _mutter), not in
  // a throttle here.
  'enemy-idle':  { variants: 2, gain: 0.45, pitch: 0.10 },
  // The staffer with somewhere to be. Loud, because he is not confiding in you.
  //
  // Fourteen, not the forty that are on disk. panic-15..40 were generated and
  // are still there, and this number is the only thing standing between them and
  // the game — but the original fourteen are the ones that land, and a set is
  // only as good as its worst line, because that is the one you hear on the
  // floor you are losing.
  panic:         { variants: 14, gain: 0.85, pitch: 0.05 },
  // The contractors, once somebody starts shooting. Their emergency is not his:
  // they are agency staff, this is not their floor, and they would like that on
  // the record while they leave.
  flee:          { variants: 10, gain: 0.85, pitch: 0.06 },

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

  // The rats. Same four events as anybody else, in a much smaller throat — they
  // have no alert and no pain because nothing they meet survives long enough to
  // need either.
  'rat-idle':  { variants: 4, gain: 0.40, pitch: 0.18 },
  'rat-death': { variants: 3, gain: 0.50, pitch: 0.16 },
  'rat-step':  { variants: 3, gain: 0.30, pitch: 0.20 },

  // The extinguisher, from the moment it is holed to the moment it stops being
  // an extinguisher.
  'extinguisher-jet':   { variants: 2, gain: 0.70, pitch: 0.08 },
  'extinguisher-burst': { variants: 3, gain: 1.10, pitch: 0.06 },

  // The generator going up. Above the extinguisher because it is a bigger
  // event, and the limiter on the master bus is what stops that being a
  // problem — see the note about there being no voice cap in sfx.js. Three
  // takes for something you hear at most once a floor is not about back-to-
  // back repetition, it is so the tenth floor of a run does not open the same
  // way the second one did.
  'generator-blast': { variants: 3, gain: 1.30, pitch: 0.05 },
  // A washing machine coming apart. Under the generator's and about level with
  // the extinguisher's: it is a domestic appliance rather than the floor's power
  // plant, and the drum and the water are what make it read big rather than the
  // level. Three takes because a floor can hold three machines and a player who
  // finds them funny will shoot all of them.
  'washer-burst': { variants: 3, gain: 1.15, pitch: 0.06 },

  // ...and the wreck it leaves, arcing for as long as the player is on the
  // floor. A low transformer buzz rather than a bright spark, which is a mix
  // decision as much as a taste one: a snap two or three times a second sits on
  // top of the gunfire and reads as a fault in the sound engine, where something
  // mains-frequency sits UNDER it and reads as a room that has lost its power.
  // Widest pitch jitter in the set, because what would give this one away is not
  // its level, it is hearing the same take twice.
  'generator-arc': { variants: 4, gain: 0.45, pitch: 0.16 },

  // What the bullet landed on. Every surface in the building answers back in its
  // own material — see SUBSTANCE below for which prop is made of what.
  'hit-flesh':        { variants: 3, gain: 0.70, pitch: 0.12 },
  // The shell itself, told apart by the hit normal rather than by any extra
  // bookkeeping: the building already knows which way its surfaces face.
  'impact-wall':      { variants: 3, gain: 0.45, pitch: 0.13 },
  'impact-floor':     { variants: 3, gain: 0.45, pitch: 0.13 },
  'impact-ceiling':   { variants: 3, gain: 0.42, pitch: 0.14 },
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
  breath: { variants: 6, gain: 0.42, pitch: 0.09 },

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
  // A carton going flat under somebody's boots. Its own clip rather than
  // break-cardboard, because the two are different events: one is a box coming
  // apart because it was shot, the other is a box losing an argument with a body
  // that never broke stride. Mixed low — it happens as a by-product of somebody
  // walking, so it belongs under the footsteps rather than over them.
  'crush-cardboard': { variants: 3, gain: 0.42, pitch: 0.16 },
  // The water cooler: the bottle glugging when it is hit, the gush when it goes,
  // and what is left dripping onto the carpet afterwards. See spills.js.
  'water-gush': { variants: 2, gain: 0.55, pitch: 0.10 },
  'water-glug': { variants: 3, gain: 0.50, pitch: 0.14 },
  'water-drip': { variants: 3, gain: 0.34, pitch: 0.18 },

  step: { variants: 4, gain: 0.30, pitch: 0.14 },
  land: { variants: 2, gain: 0.50, pitch: 0.10 },

  'shell-casing': { variants: 3, gain: 0.28, pitch: 0.16 },

  // The sliding doors. Placed rather than played flat, because the one you can
  // hear and cannot see is the interesting one: something opened a door.
  'door-open':  { variants: 3, gain: 0.55, pitch: 0.06 },
  'door-close': { variants: 3, gain: 0.50, pitch: 0.06 },

  // The cow. One per floor at most and never more than that, so it is mixed to
  // carry — the whole point of it is being heard from well outside the room it
  // is standing in.
  moo: { variants: 2, gain: 1.1, pitch: 0.05 },

  'floor-clear': { gain: 0.55, pitch: 0.01 },
  descend:       { gain: 0.70, pitch: 0.02 },
  'low-health':  { variants: 2, gain: 0.45, pitch: 0.02 },
  heal:          { gain: 0.45, pitch: 0.02 },

  // The floor cleaner's motor. A bed as far as decoding goes — measured but not
  // level-corrected or onset-trimmed, because both would break the seam it
  // loops on — but played through a panner that follows it around the floor.
  // Gain in line with the other beds below rather than nearly double them: it is
  // positional with a 4 m refDistance (see sfx.js), so standing anywhere near it
  // — which is the only way to ever hear it — was full volume, for as long as it
  // stayed in the room, which a one-shot sound never has to survive.
  roomba: { gain: 0.28, pitch: 0, bed: true },

  // A parcel line running on a corridor wall (see conveyors.js). Mixed to sit
  // UNDER the floor cleaner — a floor runs several of these at once and each of
  // them runs for as long as the player is on it, which is the argument the
  // generator's arcs already make — and the gain is high for a bed because the
  // clip itself came back quiet, not because the belt is loud.
  //
  // That distinction is the whole reason the number is 1 and not 0.25. Beds are
  // exempt from the level conditioning every one-shot gets (`bed` below), so a
  // bed's gain IS its level: measured in half-second windows this clip runs a
  // dead-flat 2.5-3.0 for all twelve seconds, against the floor cleaner's 22,
  // and at a bed's usual quarter it would have been eighteen decibels down and
  // simply inaudible. At 1 it mixes to 0.025 against the cleaner's 0.059, which
  // is the 45% it was wanted at. Peak is 0.156, so there is no headroom
  // question. Regenerate it louder and this comes back down.
  conveyor: { gain: 1, pitch: 0, bed: true },

  // A washing machine on an unbalanced spin cycle, following the machine around
  // the corridor (see washers.js). A `bed`, so it is exempt from the level
  // conditioning every one-shot gets and this gain IS its level — the same
  // argument the conveyor's 1 documents at length. Mixed above both the other
  // positional loops on purpose: it is the loudest thing in the building that is
  // not an event, and the whole design of the prop is that you hear it from down
  // the corridor and go and look. Its range is the other half of that
  // (WASHER_AUDIBLE), because a loud loop that also carries is a loop that sits
  // under the entire floor.
  //
  // 0.55 rather than the 0.75 it was first given, and the number came off a
  // measurement rather than off taste. A bed's gain IS its level, and the clip
  // measures 0.14 RMS — so 0.75 put a CONTINUOUS sound at 0.108 against the
  // 0.1495 every one-shot in the set is conditioned to, which is 72% of a
  // gunshot playing for as long as the player is on the floor. That is the
  // `blackoutPanels` mistake in a different key: something that never stops
  // being asked for has to sit under the fight rather than in it. At 0.55 it
  // mixes to 0.079 — 1.6x the floor cleaner, comfortably the loudest loop in the
  // building, and about half a gunshot.
  //
  // It is also the one bed that needs no loop-window rescue, and that is worth
  // recording because the floor cleaner's clip did (see loopWindow in sfx.js).
  // Measured in half-second windows across all twelve seconds: RMS 12.0 to 15.6,
  // worst window 77% of the best, no dead air anywhere. The roomba clip ran 8.7
  // down to 0.7 over its first 2.4 seconds — a ratio of 0.03 — which is what
  // switched the vacuum off for a third of every cycle. Asking the prompt for
  // "full intensity from the very first instant with no fade in" is what bought
  // that, and it is worth asking for on every bed.
  'washer-thrash': { gain: 0.55, pitch: 0, bed: true },

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
const STEP_CLIP = { robot: 'robot-step', rat: 'rat-step' };

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
// He carries further than anything else on the floor, which is the point: you
// are meant to hear him two rooms away and go and find out what that is.
const PANIC_AUDIBLE = 44;
// The wrecked generator's arcs, and the shortest range here on purpose. Every
// other sound in the building is an event: it happens, it is over, and hearing
// one from the far end of the floor tells you something. An arc is not — nothing
// ever stops asking for it while the player is on this floor, so a range that
// carried would put a buzz under the whole rest of the fight. This is the room it
// is standing in and the corridor outside it.
const ARC_AUDIBLE = 18;
// And the floor cleaner's motor, shorter still — the only sound in the game that
// never stops AND never gets muffled by a wall (see startMotor). At 18 m a buzz
// out of a wrecked machine is information: something over there is broken. A
// vacuum cleaner three rooms away is not information, it is a hum on the mix, and
// a player asked for it to stop carrying. This is the room it is in and no more.
const MOTOR_AUDIBLE = 12;
// ...and a belt's, which is shorter. It is the same untreated positional loop
// with the same lack of occlusion, but there are several running at once on a
// floor rather than one following a body about, and a hum that carries is a hum
// under everything else in the building.
const BELT_AUDIBLE = 10;
// ...and a washing machine destroying itself, which is the loudest of the three
// and so the furthest-carrying. Still well short of the 26 m an EVENT carries,
// for the reason ARC_AUDIBLE is: every other sound in this building is something
// that just happened, so hearing one from the far end of the floor tells you
// something, while a continuous noise that carries sits under the whole fight.
// This one is meant to be a thing you walk toward.
const WASHER_AUDIBLE = 15;

// Roughly where a voice leaves a body, so a shout does not come from their shoes.
const MOUTH_HEIGHT = 1.35;

// Metres of detour that halve a sound. Matches the panner's reference distance
// closely enough that the walk round the corner and the walk across the room are
// paid for at the same rate.
const DETOUR_REFERENCE = 5;

// The alarm klaxon (see `alarm`). A minor sixth apart, which is the interval
// every emergency two-tone in the world is built on and the reason one is
// recognisable as an alarm before you have registered what it is attached to.
const ALARM_TONES = [740, 466];
const ALARM_PERIOD = 0.9;      // seconds for both tones
const ALARM_CYCLES = 4;
const ALARM_GAIN = 0.16;

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
    this._source = { x: 0, y: 0, z: 0 };
    // Reused so a firefight is not allocating an options object per gunshot.
    this._opts = { at: null, muffled: false, gain: 1, rate: 1, delay: 0 };
    // The floor's nav grid, which is what knows where the doorways are.
    this.nav = null;
  }

  /** Called once per floor: sound routing needs that floor's walls. */
  setNav(nav) {
    this.nav = nav;
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
    this._placed('hit-flesh', point, { delay: Math.random() * IMPACT_SCATTER });
  }

  /**
   * A bullet landed on the building itself. `normal` says which way the surface
   * faces, which is all it takes to tell drywall from carpet from ceiling tile —
   * up is floor, down is ceiling, anything else is wall.
   */
  bulletHitWall(point, normal) {
    const facing = normal ? normal.y : 0;
    const clip = facing > 0.7 ? 'impact-floor'
      : facing < -0.7 ? 'impact-ceiling'
      : 'impact-wall';
    this._placed(clip, point, { delay: Math.random() * IMPACT_SCATTER });
  }

  /**
   * A bullet landed on something breakable. `kind` is the destructible's kind
   * ('glass', 'panel' for a ceiling tube, 'prop'); `substance` is what a prop is
   * made of, and is ignored for the two kinds that are part of the building.
   */
  bulletHitMaterial(kind, substance, point) {
    this._placed(substanceOf(kind, substance).impact, point,
      { delay: Math.random() * IMPACT_SCATTER });
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
    const at = this._near(enemy, AUDIBLE);
    // Bigger types fire lower, so you can hear what is shooting at you.
    if (at) this._placed('enemy-fire', at, { rate: Math.pow(enemy.type.scale, -1.4) });
  }

  enemyMeleeSwing(enemy) {
    const at = this._near(enemy, AUDIBLE);
    if (at) this._placed('melee-swing', at, { rate: Math.pow(enemy.type.scale, -1.2) });
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

  /**
   * Someone who has stopped caring that there is a firefight on. Which clip is
   * the type's own business (`screams`, in enemies.js): the toilet guy has an
   * emergency of his own, the contractors would like it on the record that this
   * is not their floor, and the rat just squeaks.
   */
  enemyScream(enemy, clip = 'panic') {
    const at = this._near(enemy, PANIC_AUDIBLE);
    if (at) this._placed(clip, at, { rate: Math.pow(enemy.type.scale, VOICE_EXPONENT) });
  }

  /**
   * A machine that runs continuously and moves while it does — the floor
   * cleaner, and anything else that ever needs a motor. Returns a handle to
   * hand back to moveMotor and stopMotor.
   *
   * Unlike everything else in this file this does not go through _placed: a loop
   * has no onset to route round a doorway, and re-routing it every frame as the
   * player walks would swing the source across the room. A straight panner is
   * the honest treatment of a noise that is simply always on.
   *
   * Which makes it the one sound in the game with no occlusion at all, and so the
   * one that has to be kept local by its falloff instead — everything else loses
   * its treble and half its level through a wall, while this arrived from the far
   * end of the floor at full brightness. See MOTOR_AUDIBLE, and `loopFalloff` in
   * sfx.js for how a range becomes a falloff.
   */
  startMotor(enemy) {
    const clip = enemy.type.motor;
    if (!clip || !this.sfx.ready) return null;
    // Louder up close than it was, and gone by MOTOR_AUDIBLE: the two go
    // together, or making it local just makes it quiet.
    return this.sfx.loopAt(clip, {
      gain: 0.95, x: enemy.x, y: 0.1, z: enemy.z, range: MOTOR_AUDIBLE });
  }

  moveMotor(handle, x, y, z) { this.sfx.moveLoop(handle, x, y, z); }
  stopMotor(handle) { this.sfx.stopLoop(handle); }

  /**
   * A machine that runs continuously and does NOT move: a parcel line on a
   * wall. Everything the note above startMotor says applies here and one thing
   * does not — there is nothing to follow, so the handle only ever needs
   * stopping, which stopMotor already does.
   *
   * A long line asks for several of these down its length. That is the point of
   * it: a twenty metre belt heard from one point is a machine in a corner.
   */
  startBelt(x, y, z) {
    if (!this.sfx.ready) return null;
    return this.sfx.loopAt('conveyor', { gain: 0.9, x, y, z, range: BELT_AUDIBLE });
  }

  /**
   * A washing machine losing a fight with its own drum. Positional, moving, and
   * mixed hot — it is the loudest continuous thing in the building and it is
   * meant to be: the prop's whole job is that you hear it before you see it and
   * go and look.
   *
   * It MOVES, so it is `moveMotor` that follows it, exactly like the floor
   * cleaner. Everything the note above startMotor says about a positional loop
   * applies: no occlusion, a linear falloff, and a named range, because inverse
   * falloff never reaches zero and "audible within fifteen metres" would come
   * out as a hum that is merely quiet everywhere.
   */
  startWasher(x, y, z) {
    if (!this.sfx.ready) return null;
    return this.sfx.loopAt('washer-thrash', {
      gain: 1.15, x, y, z, range: WASHER_AUDIBLE });
  }

  /** ...and the end of it. Placed, so it points at whichever one you shot. */
  washerBurst(point) {
    this._placed('washer-burst', point);
  }

  enemyStep(enemy) {
    const at = this._near(enemy, AUDIBLE_STEP);
    if (at) {
      this._placed(STEP_CLIP[enemy.type.voice] ?? 'enemy-step', at,
        { rate: Math.pow(enemy.type.scale, -0.8) });
    }
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
    const spec = substanceOf(kind, substance);
    this._placed(spec.break, point);
    // The tail is what makes destruction read as heavy: the thing breaks, and a
    // second later its pieces stop moving. Some substances have no tail — a torn
    // partition does not clatter.
    if (spec.settle) {
      this._placed(spec.settle, point, { delay: DEBRIS_DELAY + Math.random() * 0.4 });
    }
  }

  /** An extinguisher holed and venting, and the bang at the end of that. */
  extinguisherJet(point) { this._placed('extinguisher-jet', point); }
  extinguisherBurst(point) { this._placed('extinguisher-burst', point); }

  /**
   * The generator going up — the loudest single thing on a floor, and the only
   * one you get once. It plays ON TOP of the prop's own `break-electronic`
   * rather than instead of it: the crackle is the machine coming apart and the
   * boom is what it was holding, and the two together are what a floor's worth
   * of power sounds like leaving at once.
   */
  generatorBlast(point) { this._placed('generator-blast', point); }

  /**
   * One arc out of the wreck's torn plating (`arcs.js`) — the noise the machine
   * goes on making after it has stopped being a machine. Rejected by range here
   * rather than by the caller for the same reason `_near`'s is: an arc knows
   * where it struck and nothing about where the player is standing. See
   * ARC_AUDIBLE for why it is the shortest range in the file.
   */
  generatorArc(point) {
    if (!this.audibleAt(point.x, point.z, ARC_AUDIBLE)) return;
    this._placed('generator-arc', point);
  }

  /** A sliding door, from wherever in the building it is. */
  doorOpen(point) { this._placed('door-open', point); }
  doorClose(point) { this._placed('door-close', point); }

  // --- badge readers ------------------------------------------------------------
  //
  // The three keycard sounds are the one part of the set that is borrowed rather
  // than generated: a reader accepting a card, refusing one, and a card being
  // picked up off the carpet. They are pitched well away from the clips they are
  // borrowed from — a refusal is a dry-fire click dropped most of an octave, a
  // long way from the sound of your own gun going nowhere — so nothing here is
  // mistakable for the thing it came from. Dedicated clips would still be
  // better; see the sound-generation skill.

  /** Card accepted: the reader clunks and the panel starts moving. */
  doorUnlock(point) {
    this._placed('door-open', point, { gain: 1.3, rate: 1.24 });
  }

  /** Card refused, or no card at all. */
  doorRefused(point) {
    this._placed('dry-fire', point, { gain: 0.9, rate: 0.62 });
  }

  /** A keycard picked up off the floor. */
  keycardPickup(point) {
    this._placed('heal', point, { gain: 0.8, rate: 1.35 });
  }

  /** Furniture shoved aside by the player walking into it. */
  propShove(point) {
    this._placed('prop-shove', point);
  }

  /** A cardboard box flattened by somebody walking over it. */
  crushProp(point) {
    this._placed('crush-cardboard', point);
  }

  // --- the water cooler ---------------------------------------------------------
  //
  // Three clips for three moments of the same event, which is what makes it read
  // as a thing happening rather than as one sound effect: the bottle answers a
  // round with a glug, a killed cooler empties itself onto the floor, and then the
  // carpet drips for a while afterwards. See spills.js for the timing.

  /** A round into the bottle: air going in where the water is coming out. */
  waterGlug(point) {
    this._placed('water-glug', point);
  }

  /** The bottle emptying itself over the floor. */
  waterGush(point) {
    this._placed('water-gush', point);
  }

  /** The tail of it, one drip at a time. */
  waterDrip(point) {
    this._placed('water-drip', point);
  }

  /** The cow, announcing itself. */
  moo(point) {
    this._placed('moo', point);
  }

  // --- building security --------------------------------------------------------

  /**
   * A camera has just got you, or a laser has just been crossed. Borrowed, like
   * the reader sounds above: a magazine seating, pitched up most of an octave
   * into a servo click. Placed, because the whole value of it is that it comes
   * from a direction — it is the half second in which you get to work out which
   * wall to look at.
   */
  cameraSpotted(point) {
    this._placed('mag-in', point, { gain: 0.6, rate: 1.95 });
  }

  /**
   * The alarm itself: a two-tone klaxon over the building's PA.
   *
   * Synthesised rather than sampled, and for the same reason the hitmarker is —
   * it is not a sound anywhere in the world. It comes out of every ceiling on
   * the floor at once, so it has no position to be placed at and nothing to be
   * occluded by, and a klaxon is two square-ish tones alternating, which is a
   * thing an oscillator is genuinely better at than a recording of one.
   *
   * The whole burst is scheduled in one go: it has to keep sounding while the
   * response walks in, and hanging that off the frame loop would make an alarm
   * something that can be interrupted by a lag spike.
   */
  alarm() {
    const ctx = this.sfx.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;

    for (let cycle = 0; cycle < ALARM_CYCLES; cycle++) {
      ALARM_TONES.forEach((freq, i) => {
        const t = t0 + cycle * ALARM_PERIOD + i * (ALARM_PERIOD / 2);
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;

        // Off the top of it, or a sawtooth klaxon is all fizz and no weight.
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 1700;

        const g = ctx.createGain();
        const hold = ALARM_PERIOD / 2 - 0.1;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(ALARM_GAIN, t + 0.035);
        g.gain.setValueAtTime(ALARM_GAIN, t + hold);
        g.gain.exponentialRampToValueAtTime(0.0001, t + hold + 0.09);

        osc.connect(tone).connect(g).connect(this.sfx.sfxBus);
        osc.start(t);
        osc.stop(t + hold + 0.11);
      });
    }
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
    const at = this._near(enemy, range);
    if (!at) return;
    const set = enemy.type.voice ?? 'enemy';
    this._placed(`${set}-${event}`, at, { rate: Math.pow(enemy.type.scale, VOICE_EXPONENT) });
  }

  /**
   * The same rejection `_near` makes for an enemy, for anything else that knows
   * it is about to ask for a great many sounds at once and wants to drop the
   * ones nobody could hear. `blackoutPanels` in destruction.js is the caller
   * this exists for — see AUDIBLE above for what the range means.
   *
   * Public because the decision belongs to whoever understands the event. This
   * module plays what it is asked for; knowing that two hundred ceiling tubes
   * across a whole building is not two hundred sounds to a player standing in
   * one room of it is not something it can work out.
   */
  audibleAt(x, z, range = AUDIBLE) {
    if (!this.sfx.ready) return false;
    const dx = x - this._pos.x;
    const dz = z - this._pos.z;
    return dx * dx + dz * dz <= range * range;
  }

  // Where an enemy's noise comes from, or null if they are too far away to be
  // worth placing. The range test is straight-line on purpose: it is a cheap
  // rejection, and _placed does the honest routing for whatever survives it.
  _near(enemy, range) {
    if (!this.sfx.ready) return null;
    const dx = enemy.x - this._pos.x;
    const dz = enemy.z - this._pos.z;
    if (dx * dx + dz * dz > range * range) return null;
    this._source.x = enemy.x;
    this._source.y = MOUTH_HEIGHT;
    this._source.z = enemy.z;
    return this._source;
  }

  /**
   * Plays a sound that happened somewhere in the building, from where it would
   * actually be heard.
   *
   * The true position is only right when you can see the thing making the noise.
   * Otherwise the sound comes out of a doorway, arriving from a direction that
   * can be nothing like the direction of its source — and quieter, for having
   * gone the long way round. nav.soundPath works both out; all this does is
   * spend them.
   */
  _placed(name, point, extra = null) {
    const path = this.nav?.soundPath(point.x, point.z, this._pos.x, this._pos.z);

    this._at.x = path ? path.x : point.x;
    this._at.y = point.y;
    this._at.z = path ? path.z : point.z;

    const opts = this._opts;
    opts.at = this._at;
    // No path at all means the source is off the nav field — off the floor, or
    // inside something. Treat it as muffled rather than pretending it is clear.
    opts.muffled = path ? path.occluded : true;
    opts.gain = (extra?.gain ?? 1) * detourGain(path ? path.detour : 0);
    opts.rate = extra?.rate ?? 1;
    opts.delay = extra?.delay ?? 0;
    return this.sfx.play(name, opts);
  }
}

// Going round two corners costs you the same as walking it. Mirrors the inverse
// falloff the panner applies to the straight-line part, so the two halves of the
// journey are attenuated on the same curve.
function detourGain(detour) {
  return detour > 0 ? DETOUR_REFERENCE / (DETOUR_REFERENCE + detour) : 1;
}

// Window glazing and ceiling tubes are part of the building and never went
// through the prop catalogue, so their kind names their substance; everything
// else is furniture and brought its own.
function substanceOf(kind, substance) {
  return SUBSTANCE[KIND_SUBSTANCE[kind] ?? substance] ?? SUBSTANCE[DEFAULT_SUBSTANCE];
}
