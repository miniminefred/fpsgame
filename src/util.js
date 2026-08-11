// The small scalar helpers, in one place.
//
// Every one of these existed already, two to five times over, in files that had
// no business knowing about each other: two spellings of `clamp`, two of
// `clamp01`, two byte-identical `angleLerp`s in enemies.js and cameras.js, a
// third formulation of the same angle wrap in hud.js, one `lerp` next to
// fourteen hand-inlined copies, and the hex-to-CSS line written out in four
// files. None of them had drifted yet. The point of collecting them is that the
// ones that matter — see gen/layout.js and FIRST_CONTACT_GAP — always look like
// these right up until they do.
//
// Deliberately scalar-only and dependency-free. The shared *vectors* are not
// here on purpose: destruction.js:135 documents a real bug caused by two call
// sites sharing one scratch Vector3, and a module-level `UP` that anything
// might `.set()` is that bug waiting to be reintroduced. Scratch vectors stay
// private to their owners.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed angle from `a` to `b`, in (-π, π]. */
export const angleDelta = (a, b) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/** Lerp along the short way round, so 350° to 10° is a 20° turn, not a 340° one. */
export const angleLerp = (a, b, t) => a + angleDelta(a, b) * t;

/**
 * Frame-rate independent smoothing: the fraction of the remaining distance to
 * cover this frame, for a rate `k` per second. `x += (want - x) * smoothTo(k, dt)`
 * converges identically at 30 fps and 240 fps, where `x += (want - x) * k * dt`
 * does not — which is why this shape is written out at seven call sites already.
 */
export const smoothTo = (k, dt) => 1 - Math.exp(-k * dt);

/**
 * Squared planar distance. For the very common `distance < R` test this saves a
 * sqrt against `R * R` — worth having a name for in the per-enemy-per-frame
 * loops, where Math.hypot is both slower and doing arithmetic nobody reads.
 */
export const dist2 = (ax, az, bx, bz) => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};

/** 0x3ddc6b -> "#3ddc6b", for the places a Three.js colour has to reach the DOM. */
export const hexCss = (c) => `#${c.toString(16).padStart(6, '0')}`;
