import * as THREE from 'three';
import { hexCss } from './util.js';

// Every surface in the building is drawn with a canvas texture generated here —
// no image assets. The palette is deliberately narrow: greys and off-whites for
// the building itself, so the few saturated things (monitors, exit sign, enemy
// visors, blood-red hazard tape) read instantly as gameplay.
//
// All world surfaces use world-space UVs where one texture repeat = 2 metres
// (see UV_SCALE in gen/geom.js), so PX pixels below cover 2 metres.

const PX = 256;

let assets = null;

// Built once, lazily, and shared by every floor — level teardown disposes
// geometry only, never these.
export function getAssets() {
  if (!assets) assets = build();
  return assets;
}

function build() {
  const wall = texture(paintedWall(0xdedbd6));
  const carpet = texture(carpetTile());
  const vinyl = texture(vinylTile());
  const ceiling = texture(ceilingTile());

  const std = (map, color, roughness, extra = {}) => new THREE.MeshStandardMaterial({
    map, color, roughness, metalness: 0, ...extra,
  });

  const flat = (color, roughness = 0.8, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness, metalness: 0, ...extra,
  });

  return {
    materials: {
      // --- building shell
      wall: std(wall, 0xffffff, 0.94),
      carpet: std(carpet, 0xffffff, 1),
      vinyl: std(vinyl, 0xffffff, 0.62),
      ceiling: std(ceiling, 0xffffff, 0.95),
      trim: flat(0xa9aaa8, 0.75),
      doorframe: flat(0x8e9095, 0.6),
      // The panel that slides in the frame. A shade darker than its own frame
      // so a shut door reads as a shut door from down the corridor rather than
      // as a wall the same colour as everything else.
      doorPanel: std(texture(doorPanelFace()), 0xffffff, 0.5, { metalness: 0.2 }),

      // --- ceiling light panels and windows (unlit so they stay bright)
      panel: new THREE.MeshBasicMaterial({ color: 0xfdfbf2 }),
      // The tube nobody replaced, in the rooms nobody visits. Warm and a shade
      // down on the cool panels next door, which is the whole point of it.
      panelWarm: new THREE.MeshBasicMaterial({ color: 0xf6e2b4 }),
      window: new THREE.MeshBasicMaterial({ map: texture(skyPane()), color: 0xffffff }),
      // The glazing itself, a few centimetres in front of the sky: nearly
      // invisible until a light catches it, which is the point — you notice the
      // sheen going away when you shoot a pane out, and the view stays.
      glass: new THREE.MeshStandardMaterial({
        color: 0xdfeaf2, roughness: 0.04, metalness: 0.1,
        transparent: true, opacity: 0.16, depthWrite: false,
      }),

      // --- furniture
      laminate: flat(0xd7d3c9, 0.72),          // desk / table tops
      laminateDark: flat(0x6f6b64, 0.72),      // meeting tables, counters
      metal: flat(0x9aa0a6, 0.42, { metalness: 0.35 }),
      metalDark: flat(0x53585e, 0.5, { metalness: 0.45 }),
      plastic: flat(0x3c4046, 0.85),
      partition: std(texture(partitionFabric()), 0xffffff, 1),
      fabric: flat(0x5b6472, 0.98),
      paper: flat(0xf0ece1, 0.9),
      cardboard: flat(0xa98b62, 0.95),
      plant: flat(0x4a7a45, 0.9),
      screen: new THREE.MeshBasicMaterial({ color: 0x2b4a63 }),
      screenOn: new THREE.MeshBasicMaterial({ color: 0x6fd3ff }),
      led: new THREE.MeshBasicMaterial({ color: 0x7dff9a }),
      hazard: flat(0xc8b23a, 0.8),
    },
  };
}

// --- texture painters -------------------------------------------------------

function texture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeCanvas(w = PX, h = PX) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

// Scatters small marks, wrapping them across the edges so the result tiles.
function speckle(g, w, h, count, paint, size = 2) {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const s = size * (0.5 + Math.random());
    paint(g, i);
    for (const dx of [-w, 0, w]) {
      for (const dy of [-h, 0, h]) {
        if (x + dx < -s || x + dx > w + s || y + dy < -s || y + dy > h + s) continue;
        g.fillRect(x + dx, y + dy, s, s);
      }
    }
  }
}

// The sliding door panel: a brushed steel leaf with a vision strip and a kick
// plate. Drawn at panel proportions rather than tiled like a wall — this is the
// one texture in the building that maps to a specific object at a specific size,
// so the UVs on the door mesh are its own rather than world-space.
function doorPanelFace() {
  const [c, g] = makeCanvas(PX, PX);

  g.fillStyle = '#8b9199';
  g.fillRect(0, 0, PX, PX);

  // Vertical brushing.
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 1;
  for (let x = 0; x < PX; x += 2) {
    g.globalAlpha = 0.3 + Math.random() * 0.7;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, PX); g.stroke();
  }
  g.globalAlpha = 1;

  // Vision strip at head height, and the rail it sits in.
  g.fillStyle = '#3a4650';
  g.fillRect(PX * 0.2, PX * 0.16, PX * 0.6, PX * 0.3);
  g.fillStyle = 'rgba(190,225,255,0.30)';
  g.fillRect(PX * 0.21, PX * 0.17, PX * 0.58, PX * 0.28);
  g.strokeStyle = '#6e757d';
  g.lineWidth = 3;
  g.strokeRect(PX * 0.2, PX * 0.16, PX * 0.6, PX * 0.3);

  // Kick plate along the bottom, scuffed by twenty years of trolleys.
  g.fillStyle = '#767c84';
  g.fillRect(0, PX * 0.82, PX, PX * 0.18);
  g.strokeStyle = 'rgba(40,44,48,0.5)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, PX * 0.82); g.lineTo(PX, PX * 0.82); g.stroke();

  speckle(g, PX, PX, 400, (ctx) => {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
  }, 2);

  // The leading edge, darker so a closed door reads as a seam and not a wall.
  g.fillStyle = 'rgba(30,34,38,0.55)';
  g.fillRect(0, 0, PX * 0.02, PX);

  return c;
}

// Flat painted drywall: near-uniform, with just enough grain to catch the light.
function paintedWall(base) {
  const [c, g] = makeCanvas();
  g.fillStyle = hexCss(base);
  g.fillRect(0, 0, PX, PX);

  speckle(g, PX, PX, 900, (ctx) => {
    const v = 0.5 + Math.random() * 0.5;
    ctx.fillStyle = `rgba(255,255,255,${v * 0.05})`;
  }, 3);
  speckle(g, PX, PX, 500, (ctx) => {
    ctx.fillStyle = `rgba(60,60,60,${Math.random() * 0.05})`;
  }, 3);

  return c;
}

// Grey commercial carpet tiles, laid in a 0.5 m checker with alternating grain.
function carpetTile() {
  const [c, g] = makeCanvas();
  const CELL = PX / 4; // 0.5 m

  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const alt = (tx + ty) % 2 === 0;
      g.fillStyle = alt ? '#4b4f55' : '#464a50';
      g.fillRect(tx * CELL, ty * CELL, CELL, CELL);

      // Directional grain: alternating tiles run their fibres the other way.
      g.save();
      g.beginPath();
      g.rect(tx * CELL, ty * CELL, CELL, CELL);
      g.clip();
      g.strokeStyle = 'rgba(255,255,255,0.035)';
      g.lineWidth = 1;
      for (let i = 0; i < CELL; i += 3) {
        g.beginPath();
        if (alt) {
          g.moveTo(tx * CELL + i, ty * CELL);
          g.lineTo(tx * CELL + i, ty * CELL + CELL);
        } else {
          g.moveTo(tx * CELL, ty * CELL + i);
          g.lineTo(tx * CELL + CELL, ty * CELL + i);
        }
        g.stroke();
      }
      g.restore();
    }
  }

  speckle(g, PX, PX, 1600, (ctx) => {
    ctx.fillStyle = Math.random() < 0.5
      ? `rgba(255,255,255,${Math.random() * 0.09})`
      : `rgba(0,0,0,${Math.random() * 0.12})`;
  }, 2);

  // Seams between tiles.
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * CELL, 0); g.lineTo(i * CELL, PX); g.stroke();
    g.beginPath(); g.moveTo(0, i * CELL); g.lineTo(PX, i * CELL); g.stroke();
  }

  return c;
}

// Speckled vinyl composition tile — the corridor / service-room floor.
function vinylTile() {
  const [c, g] = makeCanvas();
  const CELL = PX / 4;

  g.fillStyle = '#b9b9b4';
  g.fillRect(0, 0, PX, PX);

  speckle(g, PX, PX, 2400, (ctx) => {
    const r = Math.random();
    ctx.fillStyle = r < 0.4 ? 'rgba(255,255,255,0.5)'
      : r < 0.75 ? 'rgba(120,120,118,0.45)'
        : 'rgba(70,72,75,0.35)';
  }, 2.5);

  g.strokeStyle = 'rgba(90,90,88,0.35)';
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * CELL, 0); g.lineTo(i * CELL, PX); g.stroke();
    g.beginPath(); g.moveTo(0, i * CELL); g.lineTo(PX, i * CELL); g.stroke();
  }

  return c;
}

// Suspended acoustic ceiling: white perforated tiles in a metal grid.
function ceilingTile() {
  const [c, g] = makeCanvas();
  const CELL = PX / 4;

  g.fillStyle = '#e6e5e0';
  g.fillRect(0, 0, PX, PX);

  speckle(g, PX, PX, 3000, (ctx) => {
    ctx.fillStyle = `rgba(150,150,145,${0.15 + Math.random() * 0.25})`;
  }, 1.6);

  g.strokeStyle = '#b6b6b0';
  g.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * CELL, 0); g.lineTo(i * CELL, PX); g.stroke();
    g.beginPath(); g.moveTo(0, i * CELL); g.lineTo(PX, i * CELL); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * CELL + 1, 0); g.lineTo(i * CELL + 1, PX); g.stroke();
    g.beginPath(); g.moveTo(0, i * CELL + 1); g.lineTo(PX, i * CELL + 1); g.stroke();
  }

  return c;
}

// Cubicle partition felt — flat, slightly fuzzy, office-beige-grey.
function partitionFabric() {
  const [c, g] = makeCanvas(128, 128);
  g.fillStyle = '#8f9296';
  g.fillRect(0, 0, 128, 128);
  speckle(g, 128, 128, 2200, (ctx) => {
    ctx.fillStyle = Math.random() < 0.5
      ? `rgba(255,255,255,${Math.random() * 0.13})`
      : `rgba(40,44,48,${Math.random() * 0.13})`;
  }, 2);
  return c;
}

// What's outside the windows: overcast sky fading into haze. Deliberately
// low-contrast so the interior stays the thing you look at.
function skyPane() {
  const [c, g] = makeCanvas(64, 256);

  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#aebfd0');
  grad.addColorStop(0.55, '#cbd6e0');
  grad.addColorStop(0.8, '#b9bfc4');
  grad.addColorStop(1, '#9aa2a8');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);

  // Suggestion of a neighbouring tower block, well faded back.
  g.fillStyle = 'rgba(120,132,143,0.55)';
  g.fillRect(6, 120, 22, 140);
  g.fillStyle = 'rgba(140,150,160,0.45)';
  g.fillRect(38, 150, 20, 110);
  g.fillStyle = 'rgba(255,255,255,0.10)';
  for (let y = 128; y < 250; y += 10) {
    for (let x = 9; x < 26; x += 6) g.fillRect(x, y, 3, 5);
  }

  return c;
}
