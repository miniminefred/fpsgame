import * as THREE from 'three';

// The canvas textures the shooting effects are drawn with.
//
// Deliberately not in textures.js: nothing here is a surface of the building.
// These are the two ends of a bullet — the flash at the muzzle and the mess it
// leaves at the other end — and they are drawn with alpha, additively blended,
// and never tiled, which is the opposite of everything that file does.
//
// Built once and shared. A level teardown disposes geometry, never these.

const PUDDLE_PX = 128;
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
  const spray = [];
  for (let i = 0; i < SPRAY_VARIANTS; i++) spray.push(texture(sprayBlob(i * 613 + 41)));
  return {
    scorch, spray, flash: texture(flashStar()), glow: texture(softGlow()),
    puddle: texture(wetPatch()),
  };
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

/**
 * A patch of water on the floor: soft in the middle, ragged at the edge.
 *
 * Blobs rather than one gradient, for the same reason the scorch marks are —
 * water does not spread in a circle, it goes where the floor lets it, and the
 * lopsided edge is most of what stops it reading as a decal somebody stamped
 * there. The rim is drawn brighter than the middle because that is where a
 * shallow puddle catches the light.
 */
function wetPatch() {
  const canvas = surface(PUDDLE_PX);
  const ctx = canvas.getContext('2d');
  const c = PUDDLE_PX / 2;

  // The body of it, well inside the edge so the blobs below have somewhere to go.
  radial(ctx, c, c, c * 0.78, [
    [0, 'rgba(255,255,255,0.95)'], [0.55, 'rgba(255,255,255,0.8)'],
    [0.85, 'rgba(255,255,255,0.28)'], [1, 'rgba(255,255,255,0)'],
  ]);

  // Lobes reaching out of it, at a fixed set of angles so the shape is the same
  // every time it is built and different every way it is turned.
  let seed = 20240828;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rand() * 0.5;
    const reach = c * (0.42 + rand() * 0.36);
    const r = c * (0.2 + rand() * 0.2);
    radial(ctx, c + Math.cos(a) * reach, c + Math.sin(a) * reach, r, [
      [0, 'rgba(255,255,255,0.6)'], [0.6, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0)'],
    ]);
  }

  // And the wet rim: a ring just inside the edge, brighter than what it encloses.
  ctx.globalCompositeOperation = 'lighter';
  radial(ctx, c, c, c, [
    [0, 'rgba(255,255,255,0)'], [0.72, 'rgba(255,255,255,0)'],
    [0.86, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)'],
  ]);
  ctx.globalCompositeOperation = 'source-over';
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

/**
 * Four spray blobs, for the can in weapon slot 1.
 *
 * WHITE, because the colour is the CAN'S and not the texture's: paint is drawn
 * as one batched mesh with a vertex colour per splat (see `paint` in
 * effects.js), so the sprite carries the SHAPE and the mesh carries the hue. A
 * tinted sprite here would fight it.
 *
 * Three things make it read as aerosol rather than as a sticker, and the third
 * is the one that matters:
 *
 *   core      a soft round mass, dense in the middle and thinning out — which is
 *             what a can does when you hold it still
 *   overspray a scatter of fine dots well outside the core, thickest just past
 *             its edge. A hard-edged blob reads as a decal; the dust around it
 *             is what says the paint arrived through air
 *   runs      a couple of short dribbles off the bottom. They are what stop a
 *             wall of overlapping blobs looking like a texture and make it look
 *             like somebody sprayed it
 *
 * Four variants for the scorch marks' reason: this is the effect the player
 * makes hundreds of and looks straight at, so one sprite repeated is the thing
 * they would notice. `lcg` keeps them the same four every run.
 */
const SPRAY_VARIANTS = 4;

function sprayBlob(seed) {
  const S = 128, R = S / 2;
  const cv = surface(S);
  const g = cv.getContext('2d');
  const rnd = lcg(seed);

  // The core, as a stack of soft blobs rather than one gradient — the same
  // trick the scorch marks use, and for the same reason: a single radial
  // gradient is perfectly round and nothing sprayed is.
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * R * 0.22;
    const r = R * (0.36 + rnd() * 0.2);
    const x = R + Math.cos(a) * d, y = R + Math.sin(a) * d;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.30)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.14)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  // Overspray: fine dust, biased to just outside the core and thinning with
  // distance, so the blob has no edge anywhere.
  for (let i = 0; i < 260; i++) {
    const a = rnd() * Math.PI * 2;
    const t = rnd();
    const d = R * (0.34 + t * 0.62);
    const x = R + Math.cos(a) * d, y = R + Math.sin(a) * d;
    g.fillStyle = `rgba(255,255,255,${(0.5 * (1 - t) ** 1.6).toFixed(3)})`;
    g.beginPath();
    g.arc(x, y, 0.5 + rnd() * 1.3, 0, Math.PI * 2);
    g.fill();
  }

  // ...and one or two runs off the bottom. `+y` is down on a canvas, and down
  // on the splat is down on the wall: `frame` in effects.js spins the quad, so
  // this is only ever approximately downhill — which is enough, because what
  // reads is that the paint went SOMEWHERE rather than exactly where.
  const runs = 1 + ((rnd() * 2) | 0);
  for (let i = 0; i < runs; i++) {
    const x = R + (rnd() - 0.5) * R * 0.7;
    const len = R * (0.25 + rnd() * 0.45);
    const w = 1.4 + rnd() * 2.2;
    const grad = g.createLinearGradient(x, R * 1.25, x, R * 1.25 + len);
    grad.addColorStop(0, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - w / 2, R * 1.25, w, len);
  }

  return cv;
}

// Deterministic noise, so the four scorch variants are the same four every run.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
