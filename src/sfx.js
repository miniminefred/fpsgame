// Sampled sound playback on WebAudio.
//
// An HTMLAudioElement is the obvious way to play an MP3 and the wrong one for a
// game: one element plays one sound at a time, so a retrigger cuts itself off,
// and it cannot vary pitch. Everything here is a decoded buffer instead, which
// buys the two things that stop game audio sounding cheap — a different take per
// play, and a different playback rate on top of it. Twelve shots a second out of
// three SMG samples never repeats the same waveform twice.
//
// The AudioContext cannot exist before a user gesture, but the downloads can, so
// clips are fetched as raw bytes at boot and decoded the moment a context
// appears. By the time the click-to-play overlay is gone the set is in memory.
//
// This module knows nothing about the game — no Three.js, no scene. The listener
// pose arrives as plain numbers, which keeps the seam narrow enough that the only
// thing to get wrong is the maths, and that lives in audio.js.

import { clamp } from './util.js';

const BASE = '/sounds/';

const DEFAULT_PITCH = 0.06;   // ±6% playback rate unless a sound asks otherwise
const DEFAULT_GAIN_VAR = 0.12;

// There is no voice cap, anywhere, on purpose. If the game says something
// happened, it gets played — a mixer that quietly drops the eleventh gunshot
// turns a burst into a gun that jams at random, and the fault is invisible from
// inside the game because nothing errors. A voice is a BufferSource and two
// nodes, so they are cheap enough to spend, and the only thing standing between
// a pile of them and a clipped output is the limiter on the master bus, which is
// where that job belongs. `voices` below is counted for the harness to report,
// never to gate on.
//
// Deciding that a sound should not have been asked for is the caller's job, not
// this module's: continuous contact is one shove, and the place that knows that
// is the code holding the collider.

// Distance falloff for placed sounds. refDistance is generous because office
// rooms are small and a gunshot two rooms away still has to read as a threat.
const REF_DISTANCE = 4;
const MAX_DISTANCE = 70;
const ROLLOFF = 1.15;

// A sound with a wall in the way. Distance alone is a poor model of an office:
// someone shouting six metres away through drywall and someone shouting six
// metres away down an open corridor are the same distance and nothing like the
// same sound. Muffling is mostly a treble problem — a wall eats the crack of a
// gunshot and leaves the thump — so this is a lowpass first and a level cut
// second, which is also what makes it *informative*: muffled means "not in this
// room", and you can hear the difference without having to think about it.
const OCCLUDED_CUTOFF = 620;   // Hz
const OCCLUDED_GAIN = 0.45;

// Every clip is measured and conditioned as it decodes, because generated audio
// arrives at wildly inconsistent levels — the first pass at this set drew three
// pistol takes at 1/50th the loudness of the shotgun's, which played as silence
// and read as the gun misfiring at random. Two corrections, both cheap:
//
//   * Level. Takes are pulled toward a common RMS so one variant of a gun is
//     never a fiftieth the loudness of the next. Bounded, and never past the
//     point where the peak would clip.
//   * Onset. Leading dead air is skipped. A one-shot sample is expected to crack
//     the instant it is triggered, and a take whose blast sits 480 ms in makes
//     every rapid-fire burst ragged no matter how many voices are free.
const TARGET_RMS = 0.13;
const MAX_BOOST = 8;
const MIN_TRIM = 0.4;
const ONSET_FLOOR = 0.05;     // fraction of peak that counts as the sound starting
const ONSET_LEAD = 0.004;     // seconds kept before it, so the attack survives
const DUD_RATIO = 0.25;       // quieter than this vs its siblings and we complain

export class Sfx {
  constructor({ volume = 0.9 } = {}) {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.ambienceBus = null;
    this.volume = volume;
    this.voices = 0;

    this.library = new Map();
    this.loops = [];
    this._fetched = false;
  }

  get ready() { return !!this.ctx; }

  /**
   * Registers a sound. `variants` > 1 expects files named `<name>-1.mp3`…;
   * `gain` is its mix level and `pitch` the ± playback-rate jitter per play.
   *
   * There is no throttle and no voice count. Every call to `play` plays, clips
   * always run to their end, and nothing truncates a tail to make room — the
   * overlap of those tails is what sustained fire sounds like.
   *
   * `bed` marks a continuous ambience loop, which is exempt from the level and
   * onset conditioning below: it has no transient to find, and trimming its head
   * would break the seam it loops on.
   */
  define(name, { variants = 1, gain = 1, pitch = DEFAULT_PITCH,
                 gainVar = DEFAULT_GAIN_VAR, bed = false } = {}) {
    const urls = variants > 1
      ? Array.from({ length: variants }, (_, i) => `${BASE}${name}-${i + 1}.mp3`)
      : [`${BASE}${name}.mp3`];

    this.library.set(name, {
      name, urls, gain, pitch, gainVar, bed,
      encoded: new Array(urls.length).fill(null),
      // One entry per variant once decoded: { buffer, offset, norm, rms, peak }.
      takes: new Array(urls.length).fill(null),
      last: -1,        // index of the take played last, so it isn't played twice
      live: 0,         // counted for the harness only — never gated on
    });
  }

  /** Every decoded take's measurements. The dev sound harness reports on this. */
  report() {
    const rows = [];
    for (const entry of this.library.values()) {
      entry.takes.forEach((take, i) => {
        rows.push({
          name: entry.name,
          take: entry.urls.length > 1 ? i + 1 : 0,
          loaded: !!take,
          seconds: take ? +take.buffer.duration.toFixed(2) : 0,
          peak: take ? +take.peak.toFixed(3) : 0,
          rms: take ? +take.rms.toFixed(4) : 0,
          onsetMs: take ? Math.round(take.offset * 1000) : 0,
          norm: take ? +take.norm.toFixed(2) : 0,
          mixed: take ? +(take.rms * take.norm * entry.gain).toFixed(4) : 0,
        });
      });
    }
    return rows;
  }

  /** Starts every download. Safe to call before any user gesture. */
  preload() {
    if (this._fetched) return;
    this._fetched = true;
    for (const entry of this.library.values()) {
      entry.urls.forEach((url, i) => {
        fetch(url)
          .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(res.status)))
          .then((bytes) => {
            entry.encoded[i] = bytes;
            if (this.ctx) this._decode(entry, i);
          })
          // A missing clip is not worth breaking the game over: that sound just
          // never plays, and everything else carries on.
          .catch(() => {});
      });
    }
  }

  /** Creates or wakes the AudioContext. Must be called from a user gesture. */
  resume() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._flushLoops();
      return true;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;

    this.ctx = new Ctx();
    // Chrome usually hands back a running context inside a gesture, but not
    // always, and a suspended one plays nothing while looking entirely healthy.
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;

    // A limiter on the way out, and with no voice cap anywhere upstream it is
    // the *only* thing standing between an arbitrary pile of sounds and a
    // clipped output — WebAudio's answer to going past full scale is to clip
    // hard, which arrives as a crackle exactly when the action peaks. So this is
    // set like a brickwall rather than a gentle glue compressor: it has to
    // swallow a hundred voices without distorting, and losing a little dynamic
    // range at the peak is a far better trade than losing the eleventh gunshot.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.25;

    this.master.connect(limiter).connect(this.ctx.destination);

    // Two buses so ambience can sit under the action without the action having
    // to be mixed against it clip by clip.
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);

    this.ambienceBus = this.ctx.createGain();
    this.ambienceBus.gain.value = 0;   // faded in by _flushLoops
    this.ambienceBus.connect(this.master);

    for (const entry of this.library.values()) {
      entry.encoded.forEach((_, i) => this._decode(entry, i));
    }
    this._flushLoops();
    return true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /**
   * Fires a sound. `at` places it in the world (omit for anything happening at
   * the camera — your own gun, your own pain).
   *
   * Always plays. The only false it can return is "there is no audio context
   * yet" or "that clip has not finished downloading" — never "too many already
   * playing", because that decision is not this module's to make.
   */
  play(name, { gain = 1, rate = 1, at = null, delay = 0, muffled = false } = {}) {
    if (!this.ctx) return false;
    const entry = this.library.get(name);
    if (!entry) return false;

    const now = this.ctx.currentTime;
    const index = pick(entry);
    if (index < 0) return false;
    const take = entry.takes[index];

    entry.last = index;

    const src = this.ctx.createBufferSource();
    src.buffer = take.buffer;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * entry.pitch);

    // take.norm is what pulls a quiet variant up to its siblings, so one draw of
    // a gun is never a fiftieth the loudness of the next.
    const g = this.ctx.createGain();
    g.gain.value = entry.gain * gain * take.norm
      * (1 + (Math.random() * 2 - 1) * entry.gainVar)
      * (muffled ? OCCLUDED_GAIN : 1);

    const start = now + delay;

    if (at) {
      const panner = this.ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = REF_DISTANCE;
      panner.maxDistance = MAX_DISTANCE;
      panner.rolloffFactor = ROLLOFF;
      setPosition(panner, at.x, at.y, at.z);

      if (muffled) {
        const wall = this.ctx.createBiquadFilter();
        wall.type = 'lowpass';
        wall.frequency.value = OCCLUDED_CUTOFF;
        src.connect(g).connect(wall).connect(panner).connect(this.sfxBus);
      } else {
        src.connect(g).connect(panner).connect(this.sfxBus);
      }
    } else {
      src.connect(g).connect(this.sfxBus);
    }

    entry.live++;
    this.voices++;
    src.onended = () => { entry.live--; this.voices--; };

    // Started at the take's onset, not at zero: a one-shot has to crack the
    // instant the trigger is pulled, whatever dead air the clip shipped with.
    src.start(start, take.offset);
    return true;
  }

  /** An ambience bed. Starts as soon as its clip has decoded, and stays up. */
  loop(name, { gain = 1 } = {}) {
    const handle = { name, gain, source: null };
    this.loops.push(handle);
    this._flushLoops();
    return handle;
  }

  /**
   * A loop that comes from somewhere in the room and can move — a machine
   * rather than the building. Same decode-and-wait path as a bed, but panned
   * from a point you keep updating, and on the effects bus rather than the
   * ambience one: it is a thing in the world, and it should duck under gunfire
   * the way everything else in the world does.
   */
  loopAt(name, { gain = 1, x = 0, y = 0, z = 0 } = {}) {
    const handle = { name, gain, source: null, panner: null, positional: true, x, y, z };
    this.loops.push(handle);
    this._flushLoops();
    return handle;
  }

  /** Where a positional loop is now. Safe before it has started. */
  moveLoop(handle, x, y, z) {
    if (!handle) return;
    handle.x = x; handle.y = y; handle.z = z;
    if (handle.panner) setPosition(handle.panner, x, y, z);
  }

  /** Silences a loop and forgets it. */
  stopLoop(handle) {
    if (!handle) return;
    const i = this.loops.indexOf(handle);
    if (i !== -1) this.loops.splice(i, 1);
    if (handle.source) {
      try { handle.source.stop(); } catch { /* already ended */ }
      handle.source = null;
    }
  }

  /** Cross-fades the ambience bus. 0 silences it without stopping the loops. */
  setAmbience(level, seconds = 1.5) {
    if (!this.ambienceBus) return;
    const now = this.ctx.currentTime;
    this.ambienceBus.gain.cancelScheduledValues(now);
    this.ambienceBus.gain.setValueAtTime(this.ambienceBus.gain.value, now);
    this.ambienceBus.gain.linearRampToValueAtTime(level, now + seconds);
  }

  /**
   * Where the ears are. Called every frame with world position, the direction
   * they face and which way is up, all as plain numbers.
   */
  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    if (!this.ctx) return;
    const l = this.ctx.listener;

    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(px, t);
      l.positionY.setValueAtTime(py, t);
      l.positionZ.setValueAtTime(pz, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(ux, t);
      l.upY.setValueAtTime(uy, t);
      l.upZ.setValueAtTime(uz, t);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // --- internals ---------------------------------------------------------------

  _decode(entry, i) {
    const bytes = entry.encoded[i];
    if (!bytes || entry.takes[i]) return;
    entry.encoded[i] = null;   // decodeAudioData detaches it — only ever once
    this.ctx.decodeAudioData(
      bytes,
      (buffer) => {
        entry.takes[i] = measure(buffer, entry.bed);
        this._flushLoops();
        if (import.meta.env?.DEV) warnIfDud(entry);
      },
      () => {}
    );
  }

  // Ambience is asked for at the click that starts the game, which is usually
  // before a 26-second bed has finished decoding. So starting is retried rather
  // than assumed, from here and from every decode that completes.
  _flushLoops() {
    if (!this.ctx) return;
    let started = false;

    for (const handle of this.loops) {
      if (handle.source) continue;
      const entry = this.library.get(handle.name);
      const buffer = entry?.takes[0]?.buffer;
      if (!buffer) continue;

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const g = this.ctx.createGain();
      g.gain.value = (entry.gain ?? 1) * handle.gain;

      if (handle.positional) {
        const panner = this.ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = REF_DISTANCE;
        panner.maxDistance = MAX_DISTANCE;
        panner.rolloffFactor = ROLLOFF;
        setPosition(panner, handle.x, handle.y, handle.z);
        handle.panner = panner;
        src.connect(g).connect(panner).connect(this.sfxBus);
      } else {
        src.connect(g).connect(this.ambienceBus);
      }

      // Beds start at a random offset so two floors in a row don't open on the
      // same swell of air conditioning.
      src.start(0, Math.random() * buffer.duration);
      handle.source = src;
      started = true;
    }

    if (started && this.ambienceBus.gain.value === 0) this.setAmbience(1, 3);
  }
}

/**
 * Measures a decoded clip and works out the two corrections it needs: how much
 * to scale it so it sits with everything else, and how far in its sound actually
 * starts. A bed is measured but left alone.
 */
function measure(buffer, bed) {
  const x = buffer.getChannelData(0);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] < 0 ? -x[i] : x[i];
    if (a > peak) peak = a;
    sum += x[i] * x[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, x.length));

  if (bed || rms <= 0) return { buffer, offset: 0, norm: 1, rms, peak };

  // Pull toward a common loudness, but never so far that the peak clips.
  let norm = clamp(TARGET_RMS / rms, MIN_TRIM, MAX_BOOST);
  if (peak > 0) norm = Math.min(norm, 0.99 / peak);

  const threshold = peak * ONSET_FLOOR;
  let i = 0;
  while (i < x.length && (x[i] < 0 ? -x[i] : x[i]) < threshold) i++;
  const lead = Math.round(ONSET_LEAD * buffer.sampleRate);
  const offset = Math.max(0, i - lead) / buffer.sampleRate;

  return { buffer, offset, norm, rms, peak };
}

// A generated set is drawn one clip at a time and the draws are not consistent,
// so a variant can come back near-silent while its siblings are fine. Levelling
// hides that in play; this says so out loud, because the real fix is to
// regenerate the take, not to amplify a recording of nothing.
function warnIfDud(entry) {
  const takes = entry.takes.filter(Boolean);
  if (entry.bed || takes.length < 2 || takes.length !== entry.urls.length) return;

  const sorted = takes.map((t) => t.rms).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  entry.takes.forEach((take, i) => {
    if (take.rms < median * DUD_RATIO) {
      console.warn(
        `[sfx] ${entry.name}-${i + 1} is ${(take.rms / median).toFixed(2)}x its ` +
        `siblings' loudness (rms ${take.rms.toFixed(4)} vs ${median.toFixed(4)}) — regenerate it`
      );
    }
  });
}

// Never the same take twice in a row: with three variants a plain random pick
// repeats a third of the time, and a repeat is exactly what the ear notices.
//
// Then walk forward past any take that isn't there. preload() swallows a failed
// fetch and _decode() swallows a failed decode, both deliberately, so one bad
// file among fifty leaves a hole in an otherwise healthy set. Landing on that
// hole used to return no index at all and play() dropped the sound — a silent
// gunshot, which is the one fault this engine is built so you never get, and
// the one you cannot hear from inside the game. Walking on may repeat a take;
// a repeat is a far smaller lie than silence.
function pick(entry) {
  const n = entry.urls.length;
  let i = (Math.random() * n) | 0;
  if (n > 1 && i === entry.last) i = (i + 1 + ((Math.random() * (n - 1)) | 0)) % n;
  for (let k = 0; k < n; k++) {
    const j = (i + k) % n;
    if (entry.takes[j]) return j;
  }
  return -1;   // nothing in this set decoded at all
}

function setPosition(panner, x, y, z) {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
}
