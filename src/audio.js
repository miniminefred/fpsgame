// Procedural weapon audio — no sample assets, everything is synthesised with
// WebAudio: a filtered noise burst for the crack, a pitched sine for the thump.
// The AudioContext is created lazily on the first sound (browsers require a
// user gesture, which by then has happened: the click that locked the pointer).

const NOISE_SECONDS = 1;

export class GunAudio {
  constructor() {
    this.ctx = null;
    this.noise = null;
    this.master = null;
  }

  _ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;

    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);

    // One reusable white-noise buffer; every shot plays a slice of it.
    const len = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    return true;
  }

  // A gunshot. `pitch` scales the noise playback rate and body frequency
  // (>1 = snappier/lighter), `punch` scales loudness and low-end weight,
  // `decay` is the tail length in seconds.
  shot({ pitch = 1, punch = 1, decay = 0.18 } = {}) {
    if (!this._ensure()) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    // Crack: noise through a lowpass that sweeps down as it decays.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = pitch;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200 * pitch, t0);
    lp.frequency.exponentialRampToValueAtTime(320, t0 + decay);
    lp.Q.value = 1.2;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 160;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.9 * punch, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);

    src.connect(lp).connect(hp).connect(g).connect(this.master);
    src.start(t0, Math.random() * (NOISE_SECONDS - decay - 0.05));
    src.stop(t0 + decay + 0.02);

    // Body: a short falling sine that gives the shot its weight.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180 * pitch, t0);
    osc.frequency.exponentialRampToValueAtTime(48, t0 + decay * 0.8);

    const og = ctx.createGain();
    og.gain.setValueAtTime(0.55 * punch, t0);
    og.gain.exponentialRampToValueAtTime(0.0008, t0 + decay * 0.9);

    osc.connect(og).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + decay + 0.02);
  }

  // Short mechanical tick — dry fire, and the two ends of a reload.
  click(pitch = 1, gain = 0.5) {
    if (!this._ensure()) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1.6;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200 * pitch;
    bp.Q.value = 3;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);

    src.connect(bp).connect(g).connect(this.master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + 0.06);
  }

  reload(duration) {
    this.click(0.8, 0.35);                                  // magazine out
    setTimeout(() => this.click(1.2, 0.45), duration * 600); // magazine in
  }

  // Rising blip on a hit, falling two-note on a kill.
  ping(kill = false) {
    if (!this._ensure()) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const notes = kill ? [1180, 780] : [1560];

    notes.forEach((freq, i) => {
      const t = t0 + i * 0.07;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.1);
    });
  }
}
