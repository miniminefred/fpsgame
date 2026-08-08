// North-up minimap for the current office floor.
//
// The floorplan never changes while you're on a floor, so it is rasterised once
// in `setLevel()` into an offscreen canvas. `update()` runs every frame and does
// nothing but blit that image and stamp a handful of markers on top — no tile
// loops, no allocations.

const SOLID = 0, ROOM = 1, CORRIDOR = 2, DOOR = 3;

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

    this.scale = 1;   // device pixels per tile
    this.offX = 0;
    this.offY = 0;
    this._t = 0;      // animation clock for the pulsing exit marker
  }

  // Rasterise the static floorplan. Call once per floor.
  setLevel(level) {
    this.level = level;
    if (!this.ctx || !level) return;

    const { W, H, tiles, rooms } = level;
    const pad = 6 * this.dpr;
    const s = Math.min((this.size - pad * 2) / W, (this.size - pad * 2) / H);
    this.scale = s;
    this.offX = (this.size - W * s) / 2;
    this.offY = (this.size - H * s) / 2;

    const g = this.plan.getContext('2d');
    g.clearRect(0, 0, this.size, this.size);

    // Row run-length fill: a 150x126 floor becomes a couple of thousand rects
    // instead of ~19 000, and adjacent tiles never leave hairline seams.
    const px = (v) => this.offX + v * s;
    const py = (v) => this.offY + v * s;
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

  // World position -> minimap device pixels.
  _mx(x) { return this.offX + ((x - this.level.ox) / this.level.TILE) * this.scale; }
  _my(z) { return this.offY + ((z - this.level.oz) / this.level.TILE) * this.scale; }

  update(player, enemies) {
    const ctx = this.ctx;
    if (!ctx || !this.level) return;

    this._t += 1 / 60;
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.fillStyle = COLORS.backdrop;
    ctx.fillRect(0, 0, this.size, this.size);
    ctx.drawImage(this.plan, 0, 0);

    const d = this.dpr;

    // Exit: a pulsing ring with a cross through it.
    const exit = this.level.exit;
    if (exit) {
      const ex = this._mx(exit.x), ey = this._my(exit.z);
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
        ctx.arc(this._mx(e.x), this._my(e.z), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Player: a triangle pointing where the camera looks. Three.js yaw 0 faces
    // -Z, which is up on a north-up map, so the canvas rotation is -yaw.
    if (player) {
      const px = this._mx(player.x), py = this._my(player.z);
      ctx.save();
      ctx.translate(px, py);
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
