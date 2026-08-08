// Seeded PRNG (mulberry32). Every floor is generated from one integer seed, so
// a floor can be rebuilt bit-for-bit from its seed — handy for debugging a bad
// layout without having to reproduce it by playing.

export function makeRng(seed) {
  let s = seed >>> 0;

  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Inclusive integer range.
  rng.int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  rng.range = (min, max) => min + rng() * (max - min);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  rng.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  return rng;
}

// A fresh seed for a new run / a new floor.
export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}
