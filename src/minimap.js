// North-up minimap for the current office floor.
//
// The floorplan never changes while you're on a floor, so it is rasterised once
// in `setLevel()` into an offscreen canvas. `update()` runs every frame and does
// nothing but blit that image and stamp a handful of markers on top — no tile
// loops, no allocations.
//
// It is drawn at a FIXED zoom and scrolled to keep the player centred, rather
// than fitted to the floor. Fitting looks tidy and tells you nothing: floors
// keep growing as you descend, so the scale shrinks with every one, and by the
// time it matters the corridor you are standing in is two pixels wide. A fixed
// scale means a metre is always the same distance on the map, and the part of it
// you can see is the part you are about to walk into.

const SOLID = 0, ROOM = 1, CORRIDOR = 2, DOOR = 3;

// CSS pixels per tile. A tile is 0.5 m, so 2.6 puts about 33 m across the widget
// — a couple of rooms in every direction, which is the range at which knowing
// where an enemy is actually changes what you do.
const ZOOM = 2.6;

const COLORS = {
  backdrop: 'rgba(12, 15, 18, 0.68)',
  room:     '#39434b',
  corridor: '#6b7783',
  door:     '#7fd8e8',
  seam:     'rgba(10, 13, 16, 0.7)',
  exitRoom: 'rgba(127, 216, 232, 0.16)',
  exit:     '#7fd8e8',
  enemy:    '#ff4d4d',
  player:   '#ffffff',
};

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.level = null;
    this.plan = document.createElement('canvas');

    // Back the canvas with device pixels; CSS decides the on-screen size.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const css = canvas ? (canvas.clientWidth || 170) : 170;
    this.dpr = dpr;
    this.size = Math.round(css * dpr);
    if (canvas) {
      canvas.width = this.size;
      canvas.height = this.size;
    }
    this.plan.width = this.size;
    this.plan.height = this.size;

    this.scale = ZOOM * dpr;   // device pixels per tile, fixed for every floor
    this._t = 0;               // animation clock for the pulsing exit marker
  }

  // Rasterise the static floorplan. Call once per floor.
  setLevel(level) {
    this.level = level;
    if (!this.ctx || !level) return;

    const { W, H, tiles, rooms } = level;
    const s = this.scale;

    // The plan is now the size of the floor, not the size of the widget: it is
    // scrolled under a fixed viewport rather than squeezed into one.
    this.plan.width = Math.ceil(W * s);
    this.plan.height = Math.ceil(H * s);

    const g = this.plan.getContext('2d');
    g.clearRect(0, 0, this.plan.width, this.plan.height);

    // Row run-length fill: a 150x126 floor becomes a couple of thousand rects
    // instead of ~19 000, and adjacent tiles never leave hairline seams.
    const px = (v) => v * s;
    const py = (v) => v * s;
    const cell = Math.ceil(s) + 0.5;

    for (let y = 0; y < H; y++) {
      let runStart = 0;
      let runVal = tiles[y * W];
      for (let x = 1; x <= W; x++) {
        const v = x < W ? tiles[y * W + x] : -1;
        if (v !== runVal) {
          if (runVal !== SOLID) {
            g.fillStyle = runVal === CORRIDOR ? COLORS.corridor
              : runVal === DOOR ? COLORS.door
              : COLORS.room;
            g.fillRect(px(runStart), py(y), (x - runStart) * s + 0.5, cell);
          }
          runStart = x;
          runVal = v;
        }
      }
    }

    // Thin seams around rooms so neighbouring offices read as separate boxes.
    g.lineWidth = Math.max(1, s * 0.35);
    g.strokeStyle = COLORS.seam;
    for (const r of rooms || []) {
      g.strokeRect(px(r.x0), py(r.y0), (r.x1 - r.x0) * s, (r.y1 - r.y0) * s);
    }

    // Tint the exit room.
    const exitRoom = (rooms || []).find((r) => r.role === 'exit');
    if (exitRoom) {
      g.fillStyle = COLORS.exitRoom;
      g.fillRect(px(exitRoom.x0), py(exitRoom.y0),
        (exitRoom.x1 - exitRoom.x0) * s, (exitRoom.y1 - exitRoom.y0) * s);
    }
  }

  // World position -> device pixels inside the rasterised plan.
  _mx(x) { return ((x - this.level.ox) / this.level.TILE) * this.scale; }
  _my(z) { return ((z - this.level.oz) / this.level.TILE) * this.scale; }

  update(player, enemies) {
    const ctx = this.ctx;
    if (!ctx || !this.level) return;

    this._t += 1 / 60;
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.fillStyle = COLORS.backdrop;
    ctx.fillRect(0, 0, this.size, this.size);

    // Scroll the plan so the player sits dead centre. Everything stamped on top
    // is offset by the same amount, so markers stay glued to the floorplan.
    const centre = this.size / 2;
    const sx = player ? centre - this._mx(player.x) : 0;
    const sy = player ? centre - this._my(player.z) : 0;
    ctx.drawImage(this.plan, sx, sy);

    const d = this.dpr;

    // Exit: a pulsing ring with a cross through it.
    const exit = this.level.exit;
    if (exit) {
      const ex = this._mx(exit.x) + sx, ey = this._my(exit.z) + sy;
      const pulse = 4.2 + Math.sin(this._t * 3) * 1.2;
      ctx.strokeStyle = COLORS.exit;
      ctx.lineWidth = 1.6 * d;
      ctx.beginPath();
      ctx.arc(ex, ey, pulse * d, 0, Math.PI * 2);
      ctx.moveTo(ex - 2.4 * d, ey); ctx.lineTo(ex + 2.4 * d, ey);
      ctx.moveTo(ex, ey - 2.4 * d); ctx.lineTo(ex, ey + 2.4 * d);
      ctx.stroke();
    }

    // Living hostiles.
    if (enemies && enemies.length) {
      ctx.fillStyle = COLORS.enemy;
      const r = 1.9 * d;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e || e.alive === false) continue;
        ctx.beginPath();
        ctx.arc(this._mx(e.x) + sx, this._my(e.z) + sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Player: a triangle pointing where the camera looks. Three.js yaw 0 faces
    // -Z, which is up on a north-up map, so the canvas rotation is -yaw.
    if (player) {
      ctx.save();
      ctx.translate(centre, centre);
      ctx.rotate(-(player.yaw || 0));
      ctx.beginPath();
      ctx.moveTo(0, -5.2 * d);
      ctx.lineTo(3.6 * d, 4.2 * d);
      ctx.lineTo(0, 2.2 * d);
      ctx.lineTo(-3.6 * d, 4.2 * d);
      ctx.closePath();
      ctx.fillStyle = COLORS.player;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.lineWidth = 1 * d;
      ctx.stroke();
      ctx.restore();
    }
  }
}
