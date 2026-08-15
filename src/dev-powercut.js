// A capture harness for one specific report, and it exists because the report
// could not be reproduced any other way: "when the generator dies, everything
// except the background hum stops for a second or two, then comes back".
//
// Every explanation for that has been checked against code called by hand and
// none of them held — the limiter ducks both buses so it cannot spare the bed,
// the ceiling panels carry no nav tiles so the blackout never touches routing,
// `play` has no gate, and spreading the collapse across frames took the frame it
// costs from 49 ms to 0.5 ms without fixing it. What is missing is a measurement
// taken while somebody is actually hearing the fault.
//
// So this arms itself when the generator dies and writes what it saw to
// localStorage under KEY. Nothing has to be typed into a console and no devtools
// window has to be open — play the floor, shoot the machine, and the answer is
// sitting in the origin's storage afterwards.
//
// The four numbers partition every explanation that is left:
//
//   worstFrameMs   the MAIN thread. Big here and the game could not ask for
//                  sound, whatever else is true.
//   audioDriftMs   the AUDIO thread. ctx.currentTime is driven by the audio
//                  device, not by the page, so if it stops tracking the wall
//                  clock the render quantum is overrunning and the output is
//                  glitching underneath everything.
//   plays          whether the game ASKED. Bucketed at 100 ms, so a hole in the
//                  middle of the run is visible as a hole rather than averaged
//                  away.
//   refused        `play` returning false, which is the only way it can decline.
//
// Frames fine + clock fine + plays continuing through the silence means the
// sounds are being started and are inaudible, and the next place to look is per
// sound: gain, occlusion, and the panner. That is the one outcome none of the
// work so far would explain, which is exactly why it is worth measuring.
//
// DEV ONLY. game.js reaches this behind `import.meta.env.DEV`, so a production
// build drops the call and rollup drops the module.

const KEY = 'fps-powercut';
const WINDOW = 4;        // seconds captured after the bang
const BUCKET = 0.1;      // seconds per bucket

let capturing = false;

/**
 * Arms the capture. Safe to call when there is no audio context yet (nothing
 * to measure) and safe to call twice — a floor only has one generator, but a
 * run has many floors and the first capture is the one worth keeping.
 */
export function capturePowerCut(sfx) {
  if (capturing || !sfx?.ctx) return;
  capturing = true;

  const ctx = sfx.ctx;
  const t0 = performance.now();
  const audio0 = ctx.currentTime;

  const n = Math.ceil(WINDOW / BUCKET);
  const buckets = Array.from({ length: n }, () => ({ plays: 0, refused: 0, frames: 0, worst: 0 }));
  const states = new Set([ctx.state]);
  let audioDrift = 0;

  const at = (elapsed) => buckets[Math.min(n - 1, Math.floor(elapsed / BUCKET))];

  // Wrapped rather than counted inside sfx, because the engine should not grow a
  // counter for a bug hunt — and this way the wrapper comes off again.
  const realPlay = sfx.play.bind(sfx);
  sfx.play = (name, opts) => {
    const ok = realPlay(name, opts);
    const b = at((performance.now() - t0) / 1000);
    b.plays++;
    if (!ok) b.refused++;
    return ok;
  };

  let last = t0;
  const tick = () => {
    const now = performance.now();
    const elapsed = (now - t0) / 1000;

    const b = at(elapsed);
    b.frames++;
    b.worst = Math.max(b.worst, now - last);
    last = now;

    // The audio clock should advance exactly as fast as the wall clock. Where it
    // does not, the audio thread is not keeping up, and no amount of the game
    // asking for sounds will produce any.
    audioDrift = Math.max(audioDrift, Math.abs((ctx.currentTime - audio0) - elapsed) * 1000);
    states.add(ctx.state);

    if (elapsed < WINDOW) { requestAnimationFrame(tick); return; }

    sfx.play = realPlay;
    const report = {
      when: new Date().toISOString(),
      worstFrameMs: +Math.max(...buckets.map((x) => x.worst)).toFixed(1),
      audioDriftMs: +audioDrift.toFixed(1),
      ctxStates: [...states],
      totalPlays: buckets.reduce((s, x) => s + x.plays, 0),
      totalRefused: buckets.reduce((s, x) => s + x.refused, 0),
      voices: sfx.voices,
      ambienceGain: +(sfx.ambienceBus?.gain.value ?? -1).toFixed(3),
      sfxGain: +(sfx.sfxBus?.gain.value ?? -1).toFixed(3),
      // One row per 100 ms: plays / frames rendered / worst frame in it. The
      // shape of this is the answer; the totals above are only a summary of it.
      timeline: buckets.map((x, i) => `${(i * BUCKET).toFixed(1)}s p${x.plays} f${x.frames} w${x.worst.toFixed(0)}`),
    };
    try { localStorage.setItem(KEY, JSON.stringify(report)); } catch { /* full or blocked */ }
    console.log('[powercut]', report);
  };
  requestAnimationFrame(tick);
}
