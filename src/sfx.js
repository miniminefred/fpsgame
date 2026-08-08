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

const BASE = '/sounds/';

const DEFAULT_PITCH = 0.06;   // ±6% playback rate unless a sound asks otherwise
const DEFAULT_GAIN_VAR = 0.12;
const MAX_VOICES = 28;        // global cap; a shotgun into a crowd is not 40 sounds

// Distance falloff for placed sounds. refDistance is generous because office
// rooms are small and a gunshot two rooms away still has to read as a threat.
const REF_DISTANCE = 4;
const MAX_DISTANCE = 70;
const ROLLOFF = 1.15;

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
   * `gain` is its mix level, `pitch` the ± playback-rate jitter per play, and
   * `minGap` a per-sound throttle — nine shotgun pellets landing on the same
   * wall must not be nine impact sounds stacked on the same millisecond.
   */
  define(name, { variants = 1, gain = 1, pitch = DEFAULT_PITCH,
                 gainVar = DEFAULT_GAIN_VAR, minGap = 0, maxVoices = 6 } = {}) {
    const urls = variants > 1
      ? Array.from({ length: variants }, (_, i) => `${BASE}${name}-${i + 1}.mp3`)
      : [`${BASE}${name}.mp3`];

    this.library.set(name, {
      name, urls, gain, pitch, gainVar, minGap, maxVoices,
      raw: new Array(urls.length).fill(null),
      buffers: new Array(urls.length).fill(null),
      last: -1,        // index of the take played last, so it isn't played twice
      lastAt: -1e9,
      live: 0,
    });
  }

  /** Starts every download. Safe to call before any user gesture. */
  preload() {
    if (this._fetched) return;
    this._fetched = true;
    for (const entry of this.library.values()) {
      entry.urls.forEach((url, i) => {
        fetch(url)
          .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(res.status)))
          .then((raw) => {
            entry.raw[i] = raw;
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

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);

    // Two buses so ambience can sit under the action without the action having
    // to be mixed against it clip by clip.
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);

    this.ambienceBus = this.ctx.createGain();
    this.ambienceBus.gain.value = 0;   // faded in by _flushLoops
    this.ambienceBus.connect(this.master);

    for (const entry of this.library.values()) {
      entry.raw.forEach((_, i) => this._decode(entry, i));
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
   * the camera — your own gun, your own pain). Returns true if it played, so a
   * caller that layers two clips can tell whether the first was throttled away.
   */
  play(name, { gain = 1, rate = 1, at = null, delay = 0 } = {}) {
    if (!this.ctx) return false;
    const entry = this.library.get(name);
    if (!entry) return false;

    const now = this.ctx.currentTime;
    if (now - entry.lastAt < entry.minGap) return false;
    if (entry.live >= entry.maxVoices || this.voices >= MAX_VOICES) return false;

    const index = pick(entry);
    const buffer = entry.buffers[index];
    if (!buffer) return false;

    entry.last = index;
    entry.lastAt = now;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * entry.pitch);

    const g = this.ctx.createGain();
    g.gain.value = entry.gain * gain * (1 + (Math.random() * 2 - 1) * entry.gainVar);

    if (at) {
      const panner = this.ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = REF_DISTANCE;
      panner.maxDistance = MAX_DISTANCE;
      panner.rolloffFactor = ROLLOFF;
      setPosition(panner, at.x, at.y, at.z);
      src.connect(g).connect(panner).connect(this.sfxBus);
    } else {
      src.connect(g).connect(this.sfxBus);
    }

    entry.live++;
    this.voices++;
    src.onended = () => { entry.live--; this.voices--; };

    src.start(now + delay);
    return true;
  }

  /** An ambience bed. Starts as soon as its clip has decoded, and stays up. */
  loop(name, { gain = 1 } = {}) {
    const handle = { name, gain, source: null };
    this.loops.push(handle);
    this._flushLoops();
    return handle;
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
    const raw = entry.raw[i];
    if (!raw || entry.buffers[i]) return;
    entry.raw[i] = null;   // decodeAudioData detaches the buffer — only ever once
    this.ctx.decodeAudioData(
      raw,
      (buffer) => { entry.buffers[i] = buffer; this._flushLoops(); },
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
      const buffer = entry?.buffers[0];
      if (!buffer) continue;

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const g = this.ctx.createGain();
      g.gain.value = (entry.gain ?? 1) * handle.gain;

      src.connect(g).connect(this.ambienceBus);
      // Beds start at a random offset so two floors in a row don't open on the
      // same swell of air conditioning.
      src.start(0, Math.random() * buffer.duration);
      handle.source = src;
      started = true;
    }

    if (started && this.ambienceBus.gain.value === 0) this.setAmbience(1, 3);
  }
}

// Never the same take twice in a row: with three variants a plain random pick
// repeats a third of the time, and a repeat is exactly what the ear notices.
function pick(entry) {
  const n = entry.urls.length;
  if (n === 1) return 0;
  let i = (Math.random() * n) | 0;
  if (i === entry.last) i = (i + 1 + ((Math.random() * (n - 1)) | 0)) % n;
  return i;
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
