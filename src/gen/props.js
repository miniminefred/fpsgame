// Office furniture. Every prop is a handful of axis-aligned boxes plus one
// collision footprint, authored in the prop's local space (width along +x,
// depth along +z, "front" facing -z) and stamped into the world at a quarter-
// turn rotation. Keeping rotation to 90° steps means the collision AABBs stay
// axis-aligned, which is all the player and the nav grid ever need.
//
// The palette is intentionally drab — greys, off-whites, beige cardboard — so
// the only bright things in a room are monitors, LEDs and the exit.

const QUARTER = [
  (x, z) => [x, z],
  (x, z) => [-z, x],
  (x, z) => [-x, -z],
  (x, z) => [z, -x],
];

// Wraps the sink so a prop can be authored around a local origin and dropped in
// at any quarter turn.
function placer(sink, cx, cz, rot) {
  const turn = QUARTER[rot & 3];
  return {
    box(key, lx0, y0, lz0, lx1, y1, lz1) {
      const [ax, az] = turn(lx0, lz0);
      const [bx, bz] = turn(lx1, lz1);
      sink.box(key,
        cx + Math.min(ax, bx), y0, cz + Math.min(az, bz),
        cx + Math.max(ax, bx), y1, cz + Math.max(az, bz));
    },
    obstacle(lx0, lz0, lx1, lz1, top) {
      const [ax, az] = turn(lx0, lz0);
      const [bx, bz] = turn(lx1, lz1);
      sink.obstacle(
        cx + Math.min(ax, bx), cz + Math.min(az, bz),
        cx + Math.max(ax, bx), cz + Math.max(az, bz), top);
    },
  };
}

// A monitor standing on a desk at (x, z) in the desk's local space, screen
// facing the near side where the chair goes. Not a catalogue entry of its own —
// it's only ever part of a workstation.
function monitorAt(p, x, z, rng) {
  const H = 0.74;
  p.box('metalDark', x - 0.11, H, z - 0.07, x + 0.11, H + 0.02, z + 0.07);
  p.box('metalDark', x - 0.025, H + 0.02, z - 0.02, x + 0.025, H + 0.2, z + 0.02);
  p.box('plastic', x - 0.28, H + 0.17, z - 0.03, x + 0.28, H + 0.54, z + 0.02);
  // Most of them are still logged in.
  p.box(rng.chance(0.7) ? 'screenOn' : 'screen',
    x - 0.26, H + 0.2, z - 0.036, x + 0.26, H + 0.51, z - 0.029);
}

// --- prop catalogue ---------------------------------------------------------
// `w`/`d` are the footprint used for fit tests before anything is emitted.

export const PROPS = {
  desk: {
    w: 1.6, d: 0.8,
    build(p, rng) {
      const H = 0.74;
      p.box('laminate', -0.8, H - 0.04, -0.4, 0.8, H, 0.4);
      p.box('metal', -0.78, 0, -0.38, -0.68, H - 0.04, 0.38);
      p.box('metal', 0.68, 0, -0.38, 0.78, H - 0.04, 0.38);
      // Modesty panel at the back.
      p.box('metal', -0.7, 0.25, 0.33, 0.7, H - 0.06, 0.38);
      p.obstacle(-0.8, -0.4, 0.8, 0.4, H);

      // Desktop clutter.
      const mx = rng.range(-0.35, 0.35);
      monitorAt(p, mx, 0.18, rng);
      p.box('plastic', mx - 0.22, H, -0.32, mx + 0.22, H + 0.02, -0.18); // keyboard
      if (rng.chance(0.5)) p.box('paper', 0.35, H, -0.05, 0.62, H + 0.03, 0.22);
      if (rng.chance(0.35)) p.box('plastic', -0.62, H, 0.05, -0.5, H + 0.1, 0.17); // mug
    },
  },

  chair: {
    w: 0.62, d: 0.62, mass: 9, hp: 45,
    build(p) {
      p.box('metalDark', -0.22, 0.02, -0.22, 0.22, 0.08, 0.22);   // star base
      p.box('metalDark', -0.04, 0.08, -0.04, 0.04, 0.42, 0.04);   // gas lift
      p.box('fabric', -0.24, 0.42, -0.24, 0.24, 0.5, 0.24);       // seat
      p.box('fabric', -0.24, 0.5, 0.16, 0.24, 1.02, 0.26);        // back
      p.obstacle(-0.26, -0.26, 0.26, 0.26, 0.5);
    },
  },

  partition: {
    w: 1.6, d: 0.1,
    build(p) {
      p.box('partition', -0.8, 0.06, -0.05, 0.8, 1.38, 0.05);
      p.box('metal', -0.8, 1.38, -0.055, 0.8, 1.44, 0.055);
      p.box('metal', -0.8, 0, -0.05, 0.8, 0.06, 0.05);
      p.obstacle(-0.8, -0.06, 0.8, 0.06, 1.44);
    },
  },

  cabinet: {
    w: 0.5, d: 0.66,
    build(p, rng) {
      const H = rng.chance(0.4) ? 1.32 : 0.72;
      p.box('metal', -0.25, 0, -0.33, 0.25, H, 0.33);
      const drawers = H > 1 ? 4 : 2;
      for (let i = 0; i < drawers; i++) {
        const y = 0.08 + i * (H - 0.12) / drawers;
        p.box('metalDark', -0.2, y, -0.34, 0.2, y + 0.02, -0.325);
      }
      if (rng.chance(0.3)) p.box('cardboard', -0.18, H, -0.2, 0.18, H + 0.22, 0.2);
      p.obstacle(-0.25, -0.33, 0.25, 0.33, H);
    },
  },

  shelving: {
    w: 1.9, d: 0.6,
    build(p, rng) {
      const H = 2.1;
      for (const sx of [-0.93, 0.93]) {
        for (const sz of [-0.28, 0.28]) {
          p.box('metalDark', sx - 0.04, 0, sz - 0.04, sx + 0.04, H, sz + 0.04);
        }
      }
      for (let i = 0; i < 4; i++) {
        const y = 0.35 + i * 0.55;
        p.box('metal', -0.95, y, -0.3, 0.95, y + 0.04, 0.3);
        // Stock: cardboard boxes and ring binders, patchily filled.
        let x = -0.88;
        while (x < 0.78) {
          const w = rng.range(0.22, 0.42);
          if (rng.chance(0.72)) {
            const h = rng.range(0.18, 0.4);
            p.box(rng.chance(0.7) ? 'cardboard' : 'paper', x, y + 0.04, -0.26, x + w, y + 0.04 + h, 0.26);
          }
          x += w + 0.04;
        }
      }
      p.obstacle(-0.95, -0.3, 0.95, 0.3, H);
    },
  },

  crateStack: {
    w: 0.66, d: 0.66, mass: 6, hp: 28,
    build(p, rng) {
      let y = 0;
      const layers = rng.int(1, 3);
      for (let i = 0; i < layers; i++) {
        const s = rng.range(0.22, 0.31);
        const h = rng.range(0.24, 0.36);
        const jx = rng.range(-0.05, 0.05);
        const jz = rng.range(-0.05, 0.05);
        p.box('cardboard', jx - s, y, jz - s, jx + s, y + h, jz + s);
        p.box('hazard', jx - s * 0.5, y + h * 0.55, jz - s - 0.005, jx + s * 0.5, y + h * 0.7, jz - s + 0.005);
        y += h;
      }
      p.obstacle(-0.33, -0.33, 0.33, 0.33, y);
    },
  },

  printer: {
    w: 0.86, d: 0.72,
    build(p, rng) {
      const big = rng.chance(0.45);
      const H = big ? 1.15 : 0.78;
      p.box('metalDark', -0.4, 0, -0.34, 0.4, 0.12, 0.34);            // plinth
      p.box('paper', -0.42, 0.12, -0.35, 0.42, H - 0.18, 0.35);       // body
      p.box('metalDark', -0.42, H - 0.18, -0.35, 0.42, H - 0.04, 0.35); // scanner lid
      p.box('screen', -0.16, H - 0.04, -0.3, 0.16, H, -0.1);          // control panel
      p.box('led', 0.2, H - 0.03, -0.28, 0.28, H, -0.22);
      // Output tray, always with a few sheets nobody collected.
      p.box('metal', -0.3, H - 0.34, -0.44, 0.3, H - 0.3, -0.34);
      if (rng.chance(0.7)) p.box('paper', -0.22, H - 0.3, -0.42, 0.22, H - 0.27, -0.36);
      p.obstacle(-0.42, -0.44, 0.42, 0.35, H);
    },
  },

  coffeeTable: {
    w: 1.1, d: 0.7, mass: 14, hp: 60,
    build(p, rng) {
      const H = 0.42;
      p.box('laminateDark', -0.52, H - 0.05, -0.32, 0.52, H, 0.32);
      for (const sx of [-0.46, 0.46]) {
        for (const sz of [-0.26, 0.26]) {
          p.box('metal', sx - 0.03, 0, sz - 0.03, sx + 0.03, H - 0.05, sz + 0.03);
        }
      }
      if (rng.chance(0.7)) p.box('paper', -0.2, H, -0.14, 0.16, H + 0.02, 0.12);   // magazines
      if (rng.chance(0.6)) p.box('paper', 0.24, H, -0.06, 0.36, H + 0.11, 0.06);   // cup
      p.obstacle(-0.52, -0.32, 0.52, 0.32, H);
    },
  },

  sofa: {
    w: 1.8, d: 0.82,
    build(p) {
      p.box('fabric', -0.9, 0.1, -0.41, 0.9, 0.44, 0.41);
      p.box('fabric', -0.9, 0.44, 0.22, 0.9, 0.86, 0.41);
      p.box('fabric', -0.9, 0.44, -0.41, -0.72, 0.66, 0.41);
      p.box('fabric', 0.72, 0.44, -0.41, 0.9, 0.66, 0.41);
      p.box('metalDark', -0.86, 0, -0.38, 0.86, 0.1, 0.38);
      p.obstacle(-0.9, -0.41, 0.9, 0.41, 0.44);
    },
  },

  counter: {
    w: 2.2, d: 0.66,
    build(p, rng) {
      const H = 0.92;
      p.box('laminateDark', -1.1, H - 0.05, -0.33, 1.1, H, 0.33);
      p.box('paper', -1.08, 0, -0.3, 1.08, H - 0.05, 0.3);
      p.box('metal', -0.35, H, -0.22, 0.25, H + 0.02, 0.22);          // sink
      // Coffee machine — the one thing on this floor anybody cares about.
      p.box('metalDark', 0.42, H, -0.18, 0.86, H + 0.44, 0.2);
      p.box('screen', 0.5, H + 0.3, -0.19, 0.78, H + 0.4, -0.17);
      p.box('led', 0.55, H + 0.05, -0.2, 0.72, H + 0.1, -0.18);
      if (rng.chance(0.8)) p.box('paper', -0.8, H, -0.1, -0.68, H + 0.1, 0.02);
      p.obstacle(-1.1, -0.33, 1.1, 0.33, H);
    },
  },

  waterCooler: {
    w: 0.4, d: 0.4, mass: 11, hp: 35,
    build(p) {
      p.box('metal', -0.18, 0, -0.18, 0.18, 1.0, 0.18);
      p.box('screenOn', -0.14, 1.0, -0.14, 0.14, 1.42, 0.14);   // the bottle
      p.box('metalDark', -0.1, 0.62, -0.2, 0.1, 0.72, -0.17);
      p.obstacle(-0.18, -0.18, 0.18, 0.18, 1.42);
    },
  },

  vending: {
    w: 1.0, d: 0.78,
    build(p) {
      p.box('metalDark', -0.5, 0, -0.39, 0.5, 1.92, 0.39);
      p.box('screenOn', -0.42, 0.5, -0.4, 0.16, 1.76, -0.38);   // lit display window
      p.box('plastic', 0.22, 0.9, -0.41, 0.44, 1.5, -0.38);     // keypad
      p.box('metal', -0.38, 0.16, -0.41, 0.2, 0.36, -0.38);     // collection slot
      p.obstacle(-0.5, -0.39, 0.5, 0.39, 1.92);
    },
  },

  serverRack: {
    w: 0.7, d: 1.0,
    build(p, rng) {
      const H = 2.05;
      p.box('metalDark', -0.34, 0, -0.5, 0.34, H, 0.5);
      for (let i = 0; i < 9; i++) {
        const y = 0.18 + i * 0.2;
        p.box('plastic', -0.3, y, -0.52, 0.3, y + 0.16, -0.49);
        if (rng.chance(0.75)) {
          p.box('led', 0.14, y + 0.05, -0.53, 0.26, y + 0.1, -0.52);
        }
      }
      p.obstacle(-0.34, -0.5, 0.34, 0.5, H);
    },
  },

  plant: {
    w: 0.6, d: 0.6,
    build(p, rng) {
      p.box('plastic', -0.16, 0, -0.16, 0.16, 0.34, 0.16);
      const blades = rng.int(4, 7);
      for (let i = 0; i < blades; i++) {
        const a = (i / blades) * Math.PI * 2;
        const r = rng.range(0.08, 0.26);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const h = rng.range(0.4, 0.95);
        p.box('plant', x - 0.07, 0.3, z - 0.07, x + 0.07, 0.3 + h, z + 0.07);
      }
      p.obstacle(-0.18, -0.18, 0.18, 0.18, 0.34);
    },
  },

  meetingTable: {
    w: 3.0, d: 1.3,
    build(p, rng) {
      const H = 0.75;
      p.box('laminateDark', -1.5, H - 0.06, -0.65, 1.5, H, 0.65);
      for (const sx of [-1.2, 1.2]) {
        p.box('metal', sx - 0.06, 0, -0.3, sx + 0.06, H - 0.06, 0.3);
        p.box('metalDark', sx - 0.35, 0, -0.35, sx + 0.35, 0.05, 0.35);
      }
      // Speakerphone, and the whiteboard markers nobody put back.
      p.box('plastic', -0.16, H, -0.16, 0.16, H + 0.06, 0.16);
      if (rng.chance(0.6)) p.box('paper', 0.6, H, -0.3, 1.0, H + 0.02, 0.1);
      p.obstacle(-1.5, -0.65, 1.5, 0.65, H);
    },
  },
};

// --- placement --------------------------------------------------------------

// Emits `kind` at (cx,cz) if its footprint is clear. Returns whether it landed.
//
// Props carrying a `mass` are loose: they become rigid bodies instead of static
// geometry, so shooting a chair sends it skidding across the carpet. Those that
// also carry `hp` come apart when that runs out, into exactly the boxes they
// were authored from.
export function tryPlace(sink, kind, cx, cz, rot, rng) {
  const spec = PROPS[kind];
  const swap = (rot & 1) === 1;
  const w = (swap ? spec.d : spec.w) / 2;
  const d = (swap ? spec.w : spec.d) / 2;

  if (!sink.canPlace(cx - w, cz - d, cx + w, cz + d)) return false;

  if (spec.mass) sink.beginDynamic(spec.mass, spec.hp);
  spec.build(placer(sink, cx, cz, rot), rng);
  if (spec.mass) sink.endDynamic();

  sink.occupy(cx - w, cz - d, cx + w, cz + d);
  return true;
}

// Fills a room according to its role. Room bounds arrive in world metres,
// already shrunk by the wall clearance the builder wants to keep.
export function furnish(sink, room, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const w = x1 - x0;
  const d = z1 - z0;
  if (w < 1.5 || d < 1.5) return;

  switch (room.role) {
    case 'openplan': return openPlan(sink, bounds, rng);
    case 'meeting': return meetingRoom(sink, bounds, rng);
    case 'breakroom': return breakRoom(sink, bounds, rng);
    case 'storage': return storage(sink, bounds, rng);
    case 'copyroom': return copyRoom(sink, bounds, rng);
    case 'server': return serverRoom(sink, bounds, rng);
    case 'office': return privateOffice(sink, bounds, rng);
    case 'lobby': return lobby(sink, bounds, rng);
    case 'exit': return lobby(sink, bounds, rng);
    default: return privateOffice(sink, bounds, rng);
  }
}

// Cubicle farm: pods on a 3.4 x 3.0 m pitch, each a desk backed by an L of
// partitions, with the whole grid facing a consistent direction like real ones.
function openPlan(sink, { x0, z0, x1, z1 }, rng) {
  const PITCH_X = 3.4;
  const PITCH_Z = 3.0;
  const cols = Math.floor((x1 - x0) / PITCH_X);
  const rows = Math.floor((z1 - z0) / PITCH_Z);
  if (cols < 1 || rows < 1) return privateOffice(sink, { x0, z0, x1, z1 }, rng);

  const padX = (x1 - x0 - cols * PITCH_X) / 2;
  const padZ = (z1 - z0 - rows * PITCH_Z) / 2;
  const rot = rng.chance(0.5) ? 0 : 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x0 + padX + (c + 0.5) * PITCH_X;
      const cz = z0 + padZ + (r + 0.5) * PITCH_Z;
      const facing = rot === 0 ? 1 : -1;

      tryPlace(sink, 'desk', cx, cz, rot, rng);
      tryPlace(sink, 'chair', cx, cz - facing * 0.85, rot, rng);
      tryPlace(sink, 'partition', cx, cz + facing * 0.62, 0, rng);
      if (c < cols - 1) tryPlace(sink, 'partition', cx + PITCH_X / 2 - 0.05, cz, 1, rng);
      if (rng.chance(0.25)) tryPlace(sink, 'cabinet', cx + 1.05, cz + facing * 0.3, rot, rng);
    }
  }

  // A shared printer and a sad plant, as is traditional.
  edgeProp(sink, { x0, z0, x1, z1 }, 'printer', rng);
  if (rng.chance(0.7)) edgeProp(sink, { x0, z0, x1, z1 }, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, { x0, z0, x1, z1 }, 'waterCooler', rng);
}

function meetingRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const alongX = (x1 - x0) >= (z1 - z0);
  const rot = alongX ? 0 : 1;

  if (tryPlace(sink, 'meetingTable', cx, cz, rot, rng)) {
    const seats = Math.floor((alongX ? x1 - x0 : z1 - z0) / 0.85) - 1;
    for (let i = 0; i < seats; i++) {
      const t = (i - (seats - 1) / 2) * 0.85;
      if (alongX) {
        tryPlace(sink, 'chair', cx + t, cz - 1.0, 0, rng);
        tryPlace(sink, 'chair', cx + t, cz + 1.0, 2, rng);
      } else {
        tryPlace(sink, 'chair', cx - 1.0, cz + t, 1, rng);
        tryPlace(sink, 'chair', cx + 1.0, cz + t, 3, rng);
      }
    }
  } else {
    tryPlace(sink, 'coffeeTable', cx, cz, rot, rng);
  }

  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'cabinet', rng);
}

function breakRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  edgeProp(sink, bounds, 'counter', rng);
  edgeProp(sink, bounds, 'vending', rng);
  edgeProp(sink, bounds, 'waterCooler', rng);

  // Coffee tables with seating scattered through the middle.
  const tables = Math.max(1, Math.floor(((x1 - x0) * (z1 - z0)) / 9));
  for (let i = 0; i < tables; i++) {
    const cx = rng.range(x0 + 1.2, x1 - 1.2);
    const cz = rng.range(z0 + 1.2, z1 - 1.2);
    if (!tryPlace(sink, 'coffeeTable', cx, cz, rng.int(0, 3), rng)) continue;
    if (rng.chance(0.8)) tryPlace(sink, 'chair', cx, cz - 1.0, 0, rng);
    if (rng.chance(0.6)) tryPlace(sink, 'chair', cx, cz + 1.0, 2, rng);
    if (rng.chance(0.4)) tryPlace(sink, 'sofa', cx + 1.9, cz, 1, rng);
  }
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'plant', rng);
}

function storage(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  const AISLE = 1.9;

  // Rows of shelving with walking aisles between them.
  if (alongX) {
    for (let z = z0 + 0.5; z < z1 - 0.4; z += AISLE) {
      for (let x = x0 + 1.0; x < x1 - 0.9; x += 2.0) {
        tryPlace(sink, 'shelving', x, z, 0, rng);
      }
    }
  } else {
    for (let x = x0 + 0.5; x < x1 - 0.4; x += AISLE) {
      for (let z = z0 + 1.0; z < z1 - 0.9; z += 2.0) {
        tryPlace(sink, 'shelving', x, z, 1, rng);
      }
    }
  }

  // Boxes that never made it onto a shelf.
  const stacks = 2 + Math.floor(((x1 - x0) * (z1 - z0)) / 12);
  for (let i = 0; i < stacks; i++) {
    tryPlace(sink, 'crateStack', rng.range(x0 + 0.5, x1 - 0.5), rng.range(z0 + 0.5, z1 - 0.5), rng.int(0, 3), rng);
  }
}

function copyRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const count = Math.max(1, Math.floor(Math.max(x1 - x0, z1 - z0) / 1.6));
  for (let i = 0; i < count; i++) edgeProp(sink, bounds, 'printer', rng);
  for (let i = 0; i < 2; i++) edgeProp(sink, bounds, 'cabinet', rng);
  const stacks = 1 + Math.floor(((x1 - x0) * (z1 - z0)) / 14);
  for (let i = 0; i < stacks; i++) {
    tryPlace(sink, 'crateStack', rng.range(x0 + 0.5, x1 - 0.5), rng.range(z0 + 0.5, z1 - 0.5), rng.int(0, 3), rng);
  }
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'shelving', rng);
}

function serverRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  if (alongX) {
    for (let z = z0 + 0.6; z < z1 - 0.5; z += 2.2) {
      for (let x = x0 + 0.5; x < x1 - 0.4; x += 0.85) tryPlace(sink, 'serverRack', x, z, 0, rng);
    }
  } else {
    for (let x = x0 + 0.6; x < x1 - 0.5; x += 2.2) {
      for (let z = z0 + 0.5; z < z1 - 0.4; z += 0.85) tryPlace(sink, 'serverRack', x, z, 1, rng);
    }
  }
}

function privateOffice(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const rot = rng.int(0, 3);

  if (tryPlace(sink, 'desk', cx, cz, rot, rng)) {
    const back = QUARTER[rot & 3](0, -0.95);
    tryPlace(sink, 'chair', cx + back[0], cz + back[1], (rot + 2) & 3, rng);
  }
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'cabinet', rng);
  if (rng.chance(0.45)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.3)) edgeProp(sink, bounds, 'shelving', rng);
}

function lobby(sink, bounds, rng) {
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'coffeeTable', rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'plant', rng);
}

// Tries to seat a prop against a random wall, back to the wall, a few times.
function edgeProp(sink, { x0, z0, x1, z1 }, kind, rng) {
  const spec = PROPS[kind];
  for (let tries = 0; tries < 12; tries++) {
    const side = rng.int(0, 3);
    const swap = side === 1 || side === 3;
    const halfD = (swap ? spec.w : spec.d) / 2;
    let cx, cz, rot;

    switch (side) {
      case 0: cx = rng.range(x0 + 1, x1 - 1); cz = z1 - halfD; rot = 2; break;  // back to +z wall
      case 1: cx = x0 + halfD; cz = rng.range(z0 + 1, z1 - 1); rot = 1; break;
      case 2: cx = rng.range(x0 + 1, x1 - 1); cz = z0 + halfD; rot = 0; break;
      default: cx = x1 - halfD; cz = rng.range(z0 + 1, z1 - 1); rot = 3; break;
    }
    if (tryPlace(sink, kind, cx, cz, rot, rng)) return true;
  }
  return false;
}
