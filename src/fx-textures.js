import * as THREE from 'three';

// The canvas textures the shooting effects are drawn with.
//
// Deliberately not in textures.js: nothing here is a surface of the building.
// These are the two ends of a bullet — the flash at the muzzle and the mess it
// leaves at the other end — and they are drawn with alpha, additively blended,
// and never tiled, which is the opposite of everything that file does.
//
// Built once and shared. A level teardown disposes geometry, never these.

const SCORCH_PX = 128;
const FLASH_PX = 128;
const GLOW_PX = 64;

// Four scorch marks rather than one. A bullet hole is the one effect the player
// sees a hundred of on the same wall, and a single splat repeated is a wallpaper
// pattern — the eye finds the repeat long before it questions the shape.
const SCORCH_VARIANTS = 4;

let cache = null;

export function getFx() {
  if (!cache) cache = build();
  return cache;
}

function build() {
  const scorch = [];
  for (let i = 0; i < SCORCH_VARIANTS; i++) scorch.push(texture(scorchSplat(i * 977 + 13)));
  return { scorch, flash: texture(flashStar()), glow: texture(softGlow()) };
}

function texture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

/**
 * One scorch mark: a burnt pit, soot thrown out around it unevenly, and a dusty
 * halo past that. Built out of overlapping soft blobs rather than one gradient,
 * because a bullet does not leave a circle — the soot goes where the surface
 * lets it, and the lopsidedness is most of what sells it.
 */
function scorchSplat(seed) {
  const canvas = surface(SCORCH_PX);
  const ctx = canvas.getContext('2d');
  const rnd = lcg(seed);
  const c = SCORCH_PX / 2;

  // Dusty halo: barely there, but it is what stops the mark reading as a decal
  // stuck on the wall. Everything below is drawn over it.
  blob(ctx, c, c, c * 0.94, 'rgba(74,68,62,0.20)', rnd);

  // The soot itself, thrown out in an uneven ring of overlapping puffs.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rnd() * 0.5;
    const r = c * (0.10 + rnd() * 0.34);
    const size = c * (0.24 + rnd() * 0.30);
    blob(ctx, c + Math.cos(a) * r, c + Math.sin(a) * r, size,
      `rgba(26,22,19,${0.30 + rnd() * 0.30})`, rnd);
  }

  // A warm rim right at the hole — the only colour in the whole mark, and the
  // reason it reads as burnt rather than just dirty.
  blob(ctx, c, c, c * 0.30, 'rgba(96,54,30,0.45)', rnd);

  // The pit. Near black, small, and off centre by a pixel or two so it never
  // lines up with the middle of the splat.
  blob(ctx, c + (rnd() - 0.5) * 5, c + (rnd() - 0.5) * 5, c * 0.17, 'rgba(8,6,5,0.96)', rnd);

  // Ejecta: specks flung clear of the impact, denser close in.
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI * 2;
    const r = c * (0.15 + Math.pow(rnd(), 0.6) * 0.82);
    const size = 0.4 + rnd() * 1.5;
    ctx.fillStyle = `rgba(18,15,13,${(0.5 - r / (c * 2.6)) * (0.5 + rnd() * 0.5)})`;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, size, 0, Math.PI * 2);
    ctx.fill();
  }

  // Nothing may reach the edge of the tile: a decal is clipped to the surface it
  // landed on (see effects.js), and a splat that runs to its own border would
  // show that clip as a straight cut.
  fadeBorder(ctx, SCORCH_PX);
  return canvas;
}

/**
 * The muzzle flash: a white-hot core, a ragged corona, and spikes of unequal
 * length. Drawn once and spun to a random angle per shot, which is cheaper than
 * four variants and reads as more varied, because the spikes never land twice in
 * the same place.
 */
function flashStar() {
  const canvas = surface(FLASH_PX);
  const ctx = canvas.getContext('2d');
  const rnd = lcg(4211);
  const c = FLASH_PX / 2;

  // Spikes first, so the core burns over the top of their roots.
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rnd() * 0.35;
    const len = c * (0.45 + Math.pow(rnd(), 1.6) * 0.55);
    const wide = 0.05 + rnd() * 0.12;

    const grad = ctx.createLinearGradient(c, c, c + Math.cos(a) * len, c + Math.sin(a) * len);
    grad.addColorStop(0, 'rgba(255,240,200,0.85)');
    grad.addColorStop(0.45, 'rgba(255,170,70,0.35)');
    grad.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a - wide) * c * 0.16, c + Math.sin(a - wide) * c * 0.16);
    ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
    ctx.lineTo(c + Math.cos(a + wide) * c * 0.16, c + Math.sin(a + wide) * c * 0.16);
    ctx.closePath();
    ctx.fill();
  }

  // Corona, then the core: two gradients, hottest last.
  radial(ctx, c, c, c * 0.55, [
    [0, 'rgba(255,205,120,0.75)'], [0.55, 'rgba(255,150,50,0.30)'], [1, 'rgba(255,110,20,0)'],
  ]);
  radial(ctx, c, c, c * 0.24, [
    [0, 'rgba(255,255,250,1)'], [0.5, 'rgba(255,236,180,0.85)'], [1, 'rgba(255,190,90,0)'],
  ]);

  return canvas;
}

// A plain soft ball of light. Impact flashes and the muzzle bloom are both this
// with a colour and a scale on them.
function softGlow() {
  const canvas = surface(GLOW_PX);
  const ctx = canvas.getContext('2d');
  const c = GLOW_PX / 2;
  radial(ctx, c, c, c, [
    [0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.65)'],
    [0.6, 'rgba(255,255,255,0.16)'], [1, 'rgba(255,255,255,0)'],
  ]);
  return canvas;
}

// --- painting helpers ---------------------------------------------------------

function surface(px) {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  return canvas;
}

function radial(ctx, x, y, r, stops) {
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// A soft-edged puff, squashed and turned at random so no two are the same disc.
function blob(ctx, x, y, r, color, rnd) {
  const transparent = color.replace(/[\d.]+\)$/, '0)');
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rnd() * Math.PI);
  ctx.scale(1, 0.65 + rnd() * 0.5);
  radial(ctx, 0, 0, r, [[0, color], [0.45, color], [1, transparent]]);
  ctx.restore();
}

// Multiplies alpha down to nothing over the outermost few pixels.
function fadeBorder(ctx, px) {
  const img = ctx.getImageData(0, 0, px, px);
  const data = img.data;
  const c = px / 2;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      if (d < 0.86) continue;
      const k = Math.max(0, 1 - (d - 0.86) / 0.14);
      data[(y * px + x) * 4 + 3] *= k;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Deterministic noise, so the four scorch variants are the same four every run.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
