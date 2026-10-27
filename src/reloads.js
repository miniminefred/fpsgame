// How each gun is reloaded: what the viewmodel does, and what you hear while it
// does it.
//
// Every gun used to reload the same way — one dip and one roll of the rig, with a
// magazine sound at each end — which is five guns sharing one pair of hands. A
// shotgun is loaded a shell at a time and a bolt-action rifle has its bolt worked,
// and those are the sounds a player learns to listen for in a fight: four clicks
// and a pump is a shotgun that is nearly ready, a bolt going forward is a sniper
// that is.
//
// An animation is a list of KEYS — a fraction of the way through, and the offset
// of the rig from its rest pose at that moment — eased between with smoothstep,
// plus a list of CUES, the sounds, at fractions of their own. Rest is all zeros,
// and every animation starts and ends there, so nothing has to blend in or out.
//
// The cues are fired as the animation PASSES them (see `cuesBetween`), not
// scheduled up front with a delay: a reload cut short by a weapon switch must not
// go on clicking a magazine into a gun that has been put away.
//
// Offsets are in the rig's camera space: x right, y up, z toward the eye; rx is
// pitch (positive lifts the muzzle), ry yaw (positive turns it left), rz roll.

// A sound at a fraction of the way through.
const cue = (at, name, opts) => ({ at, name, opts });

const PISTOL = {
  duration: 1.1,
  keys: [
    [0, {}],
    [0.15, { rx: 0.35, rz: -0.25, y: 0.02 }],                 // muzzle up, grip toward you
    [0.3, { rx: 0.35, rz: -0.25, y: -0.01 }],                 // mag drops out
    [0.5, { rx: 0.3, rz: -0.2, y: 0.03 }],                    // new one slapped home
    [0.68, { rx: 0.1, rz: -0.1, x: -0.03 }],                  // brought over for the slide
    [0.76, { rx: 0.1, rz: -0.1, x: -0.03, z: 0.045 }],        // slide racked back...
    [0.82, { rx: 0.06, rz: -0.06, x: -0.02 }],                // ...and snapped forward
    [1, {}],
  ],
  cues: [cue(0.22, 'mag-out'), cue(0.5, 'mag-in'), cue(0.74, 'pistol-slide')],
};

// The SMG and the rifle are the same sentence at different weights: tip it on
// its side, magazine out, magazine rocked in, charging handle back.
function magSwap(duration, weight) {
  return {
    duration,
    keys: [
      [0, {}],
      [0.18, { rz: 0.75 * weight, y: -0.08 * weight, rx: -0.12 * weight }],
      [0.32, { rz: 0.8 * weight, y: -0.11 * weight, rx: -0.12 * weight }],    // mag out
      [0.55, { rz: 0.7 * weight, y: -0.06 * weight, rx: -0.05 * weight }],    // rocked in
      [0.7, { rz: 0.35 * weight, y: -0.04, ry: 0.25, x: 0.02 }],             // over for the handle
      [0.8, { rz: 0.35 * weight, y: -0.04, ry: 0.25, x: 0.02, z: 0.05 }],    // yanked back
      [0.86, { rz: 0.25 * weight, y: -0.02, ry: 0.15 }],
      [1, {}],
    ],
    cues: [cue(0.25, 'mag-out'), cue(0.55, 'mag-in'), cue(0.79, 'charging-handle')],
  };
}

const SMG = magSwap(1.4, 0.85);
const RIFLE = magSwap(1.9, 1);

// The shotgun's length depends on how empty it is: a shell a beat, then one pump.
const SHELL_TIME = 0.38;
const SHELL_LEAD = 0.35;      // rolling it over before the first shell
const PUMP_TIME = 0.55;

function shotgun(missing) {
  const n = Math.max(1, missing);
  const duration = SHELL_LEAD + n * SHELL_TIME + PUMP_TIME;
  const f = (s) => s / duration;
  const loaded = { rz: 0.95, y: -0.06, rx: 0.05 };
  const keys = [[0, {}], [f(SHELL_LEAD), loaded]];
  const cues = [];
  for (let i = 0; i < n; i++) {
    const t0 = SHELL_LEAD + i * SHELL_TIME;
    // Each shell is a small shove up into the port and back.
    keys.push([f(t0 + SHELL_TIME * 0.45), { ...loaded, y: loaded.y + 0.025, z: -0.01 }]);
    keys.push([f(t0 + SHELL_TIME), loaded]);
    cues.push(cue(f(t0 + SHELL_TIME * 0.45), 'shell-insert'));
  }
  const p0 = SHELL_LEAD + n * SHELL_TIME;
  keys.push([f(p0 + PUMP_TIME * 0.3), { rx: 0.04, y: -0.02 }]);
  keys.push([f(p0 + PUMP_TIME * 0.55), { rx: 0.04, y: -0.02, z: 0.07 }]);    // pump back...
  keys.push([f(p0 + PUMP_TIME * 0.75), { rx: 0.02 }]);                         // ...and home
  keys.push([1, {}]);
  cues.push(cue(f(p0 + PUMP_TIME * 0.5), 'shotgun-pump'));
  return { duration, keys, cues };
}

// Bolt up and back, magazine out and in, bolt forward and down. Long on purpose:
// a gun that kills with one headshot pays for it here.
const SNIPER = {
  duration: 5.0,
  keys: [
    [0, {}],
    [0.08, { rz: 0.3, ry: -0.18, x: 0.02 }],
    [0.13, { rz: 0.35, ry: -0.18, x: 0.02, z: 0.06 }],       // bolt open
    [0.24, { rz: 0.2, rx: -0.25, y: -0.12 }],
    [0.36, { rz: 0.25, rx: -0.28, y: -0.16 }],                // mag out
    [0.58, { rz: 0.2, rx: -0.22, y: -0.12 }],
    [0.66, { rz: 0.15, rx: -0.18, y: -0.08 }],                // mag in
    [0.8, { rz: 0.35, ry: -0.18, x: 0.02, z: 0.06 }],
    [0.88, { rz: 0.3, ry: -0.18, x: 0.02 }],                  // bolt home
    [1, {}],
  ],
  cues: [cue(0.1, 'bolt-open'), cue(0.33, 'mag-out'), cue(0.66, 'mag-in'), cue(0.86, 'bolt-close')],
};

// Working the bolt after a shot: the round is out, the next one goes in. Only the
// sniper has one (`cycle` on the gun), and it is what the gun's fire-rate wait
// was always standing in for.
export const BOLT_CYCLE = {
  duration: 1.0,
  keys: [
    [0, {}],
    [0.18, { rz: 0.22, ry: -0.12, x: 0.015 }],
    [0.3, { rz: 0.26, ry: -0.12, x: 0.015, z: 0.06 }],        // back
    [0.55, { rz: 0.24, ry: -0.12, x: 0.015 }],                // forward
    [0.68, { rz: 0.12, ry: -0.05 }],
    [1, {}],
  ],
  cues: [cue(0.25, 'bolt-open'), cue(0.52, 'bolt-close')],
};

/**
 * The reload for this gun, given how many rounds it is short. Keyed by the gun's
 * name, because that is what weapons.js's table already uses to say which gun is
 * which — and a gun with no entry gets the SMG's, which is a reload rather than
 * a gun that cannot be reloaded.
 */
export function reloadFor(stats, missing) {
  switch (stats.name) {
    case 'Pistol': return PISTOL;
    case 'SMG': return SMG;
    case 'Shotgun': return shotgun(missing);
    case 'Assault Rifle': return RIFLE;
    case 'Sniper Rifle': return SNIPER;
    default: return SMG;
  }
}
const POSE_KEYS = ['x', 'y', 'z', 'rx', 'ry', 'rz'];

/** The rig's offset `t` (0..1) of the way through `anim`, written into `out`. */
export function poseAt(anim, t, out) {
  for (const k of POSE_KEYS) out[k] = 0;
  if (!anim) return out;
  const keys = anim.keys;
  let i = 1;
  while (i < keys.length - 1 && keys[i][0] < t) i++;
  const [t0, a] = keys[i - 1];
  const [t1, b] = keys[i];
  const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1;
  const s = u * u * (3 - 2 * u);
  for (const k of POSE_KEYS) out[k] = (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * s;
  return out;
}

/** Every cue in `anim` crossed going from `t0` to `t1`. */
export function cuesBetween(anim, t0, t1) {
  if (!anim) return [];
  return anim.cues.filter((c) => c.at > t0 && c.at <= t1);
}
