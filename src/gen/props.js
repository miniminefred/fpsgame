// Office furniture. Every prop is a handful of axis-aligned boxes plus one
// collision footprint, authored in the prop's local space (width along +x,
// depth along +z, "front" facing -z) and stamped into the world at a quarter-
// turn rotation. Keeping rotation to 90° steps means the collision AABBs stay
// axis-aligned, which is all the player and the nav grid ever need.
//
// The palette is intentionally drab — greys, off-whites, beige cardboard — so
// the only bright things in a room are monitors, LEDs and the exit.
//
// This file is the catalogue and the placement primitive only. Which props a
// room gets, and where they stand in it, lives in gen/rooms.js.

export const QUARTER = [
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

// A run of cartons and ring binders along one deck, patchily filled and never
// hanging off the end. Drawn with the building's own palette rather than as
// downloaded models: the stock is what you see most of on a rack, and a shelf
// of full-colour GLB cartons is the one thing in a grey room shouting for
// attention it hasn't earned.
function stockRun(p, y, x0, x1, rng) {
  let x = x0;
  while (x < x1) {
    const w = Math.min(rng.range(0.22, 0.42), x1 - x);
    if (w < 0.12) break;
    if (rng.chance(0.72)) {
      const h = rng.range(0.18, 0.36);
      p.box(rng.chance(0.7) ? 'cardboard' : 'paper', x, y, -0.26, x + w, y + h, 0.26);
    }
    x += w + 0.04;
  }
}

// --- prop catalogue ---------------------------------------------------------
//
// `w`/`d` are the footprint reserved before anything is emitted, so they must
// bound BOTH the collision box and the visual geometry. Declaring them smaller
// than the obstacle is a silent interpenetration bug: the fit test reserves less
// floor than the prop actually occupies, and the next prop is free to overlap
// the difference. `tools/validate-props.mjs --catalogue` checks all three boxes
// nest correctly.
//
// Two independent flags, and they are NOT the same thing:
//   `mass` — the prop is loose. It becomes a rigid body you can shove around.
//   `hp`   — the prop can be destroyed. Every prop has this.
// A desk is heavy office furniture bolted to nothing but still doesn't skid when
// you walk into it, so it is static-with-hp; a chair is both.

export const PROPS = {
  desk: {
    // Drawn as a model, but `build` is still authored and still matters twice
    // over: it is the fallback when the GLB is missing, and it is the set of
    // pieces the desk comes apart into when it's destroyed.
    w: 1.6, d: 0.8, model: 'desk', hp: 70, substance: 'wood',
    desktop: [
      { key: 'monitor', z: 0.16 },
      { key: 'keyboard', z: -0.18, chance: 0.85 },
      { key: 'coffee_mug', x: -0.55, z: 0.05, chance: 0.4 },
      { key: 'paper_stack', x: 0.55, z: 0.1, chance: 0.35 },
    ],
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
    w: 0.62, d: 0.62, mass: 9, hp: 45, substance: 'plastic',
    build(p) {
      p.box('metalDark', -0.22, 0.02, -0.22, 0.22, 0.08, 0.22);   // star base
      p.box('metalDark', -0.04, 0.08, -0.04, 0.04, 0.42, 0.04);   // gas lift
      p.box('fabric', -0.24, 0.42, -0.24, 0.24, 0.5, 0.24);       // seat
      p.box('fabric', -0.24, 0.5, 0.16, 0.24, 1.02, 0.26);        // back
      p.obstacle(-0.26, -0.26, 0.26, 0.26, 0.5);
    },
  },

  partition: {
    w: 1.6, d: 0.12, hp: 26, substance: 'fabric',
    build(p) {
      p.box('partition', -0.8, 0.06, -0.05, 0.8, 1.38, 0.05);
      p.box('metal', -0.8, 1.38, -0.055, 0.8, 1.44, 0.055);
      p.box('metal', -0.8, 0, -0.05, 0.8, 0.06, 0.05);
      p.obstacle(-0.8, -0.06, 0.8, 0.06, 1.44);
    },
  },

  cabinet: {
    w: 0.52, d: 0.7, model: 'filing_cabinet', hp: 60, substance: 'metal',
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
    w: 1.96, d: 0.62, model: 'shelving_unit', hp: 95, substance: 'metal',
    // The rack is the model; what is ON the rack is not. Deck heights are
    // measured off the GLB (see /dev-models.html) — the gaps between them are
    // about 0.52 m, so nothing taller than a carton goes on one.
    dress(p, rng) {
      for (const y of [0.30, 0.82, 1.42]) stockRun(p, y, -0.85, 0.85, rng);
    },
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
        stockRun(p, y + 0.04, -0.88, 0.88, rng);
      }
      p.obstacle(-0.95, -0.3, 0.95, 0.3, H);
    },
  },

  crateStack: {
    w: 0.72, d: 0.72, mass: 6, hp: 28, substance: 'cardboard',
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
    // 'copier' not 'printer': the latter model is a 24 cm desktop unit, and
    // this prop stands on the floor.
    w: 0.86, d: 0.88, model: 'copier', hp: 55, substance: 'electronic',
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
    w: 1.1, d: 0.7, mass: 14, hp: 60, substance: 'wood',
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
    w: 1.8, d: 0.82, model: 'sofa', hp: 75, substance: 'fabric',
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
    // No model: the candidates are all small appliances, and this is a whole
    // kitchenette run with a sink and a coffee machine on it.
    w: 2.2, d: 0.66, hp: 90, substance: 'wood',
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
    w: 0.4, d: 0.4, mass: 11, hp: 35, substance: 'plastic',
    build(p) {
      p.box('metal', -0.18, 0, -0.18, 0.18, 1.0, 0.18);
      p.box('screenOn', -0.14, 1.0, -0.14, 0.14, 1.42, 0.14);   // the bottle
      p.box('metalDark', -0.1, 0.62, -0.2, 0.1, 0.72, -0.17);
      p.obstacle(-0.18, -0.18, 0.18, 0.18, 1.42);
    },
  },

  vending: {
    w: 1.04, d: 0.82, model: 'vending_machine', hp: 120, substance: 'electronic',
    build(p) {
      p.box('metalDark', -0.5, 0, -0.39, 0.5, 1.92, 0.39);
      p.box('screenOn', -0.42, 0.5, -0.4, 0.16, 1.76, -0.38);   // lit display window
      p.box('plastic', 0.22, 0.9, -0.41, 0.44, 1.5, -0.38);     // keypad
      p.box('metal', -0.38, 0.16, -0.41, 0.2, 0.36, -0.38);     // collection slot
      p.obstacle(-0.5, -0.39, 0.5, 0.39, 1.92);
    },
  },

  serverRack: {
    w: 0.72, d: 1.06, model: 'server_rack', hp: 130, substance: 'electronic',
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
    w: 0.68, d: 0.68, model: 'tall_plant', hp: 22, substance: 'foliage',
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
    w: 3.1, d: 1.32, model: 'meeting_table', hp: 100, substance: 'wood',
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

  // --- what the back-of-house rooms are made of -----------------------------

  bookshelf: {
    w: 1.09, d: 0.39, model: 'bookshelf', hp: 80, substance: 'wood',
    build(p, rng) {
      const H = 2.0;
      for (const sx of [-0.52, 0.52]) p.box('laminateDark', sx - 0.025, 0, -0.19, sx + 0.025, H, 0.19);
      p.box('laminateDark', -0.54, 0, 0.16, 0.54, H, 0.19);   // back panel
      for (let i = 0; i < 5; i++) {
        const y = 0.12 + i * 0.44;
        p.box('laminateDark', -0.5, y, -0.19, 0.5, y + 0.03, 0.19);
        // Ring binders, leaning against each other in a run that stops short.
        let x = -0.48;
        const run = rng.range(0.4, 0.96);
        while (x < -0.48 + run) {
          const w = Math.min(rng.range(0.04, 0.09), -0.48 + run - x);
          if (w < 0.03) break;
          p.box(rng.chance(0.6) ? 'paper' : 'cardboard', x, y + 0.03, -0.16, x + w, y + 0.03 + rng.range(0.24, 0.34), 0.14);
          x += w + 0.005;
        }
      }
      p.obstacle(-0.545, -0.195, 0.545, 0.195, H);
    },
  },

  crate: {
    w: 0.8, d: 0.8, model: 'crate', hp: 45, substance: 'wood',
    build(p, rng) {
      const H = 0.78;
      p.box('cardboard', -0.39, 0, -0.39, 0.39, H, 0.39);
      // Bracing battens, proud of the faces so it reads as boards not a carton.
      for (const y of [0.06, H - 0.12]) {
        p.box('laminateDark', -0.4, y, -0.4, 0.4, y + 0.06, 0.4);
      }
      if (rng.chance(0.5)) p.box('hazard', -0.16, H * 0.5, -0.4, 0.16, H * 0.62, -0.395);
      p.obstacle(-0.4, -0.4, 0.4, 0.4, H);
    },
  },

  // Pallet plus what is stacked on it: the model is the pallet alone, so the
  // stack is a second model dropped on top and the collider has to be told the
  // combined height rather than the pallet's 19 cm.
  pallet: {
    w: 1.02, d: 1.2, model: 'pallet', hp: 40, substance: 'cardboard',
    obstacleTop: 1.29,
    desktop: [{ key: 'box_stack' }],
    build(p, rng) {
      for (const sz of [-0.5, 0, 0.5]) {
        p.box('laminateDark', -0.5, 0, sz - 0.07, 0.5, 0.1, sz + 0.07);
      }
      for (let i = 0; i < 5; i++) {
        const x = -0.5 + i * 0.21;
        p.box('cardboard', x, 0.1, -0.59, x + 0.16, 0.19, 0.59);
      }
      // The stack: cartons in courses, each a little smaller than the one below.
      let y = 0.19;
      const courses = rng.int(2, 3);
      for (let i = 0; i < courses; i++) {
        const hw = 0.44 - i * 0.05;
        const hd = 0.31 - i * 0.03;
        const h = rng.range(0.3, 0.4);
        p.box('cardboard', -hw, y, -hd, hw, y + h, hd);
        p.box('paper', -hw * 0.4, y + h * 0.4, -hd - 0.004, hw * 0.4, y + h * 0.62, -hd + 0.004);
        y += h;
      }
      p.obstacle(-0.51, -0.6, 0.51, 0.6, 1.29);
    },
  },

  lockers: {
    // No model in the set, and a bank of lockers is four boxes and a handle —
    // cheap to author and the clearest thing you can put in a staff room.
    w: 1.8, d: 0.56, hp: 100, substance: 'metal',
    build(p, rng) {
      const H = 1.85;
      p.box('metal', -0.9, 0.06, -0.25, 0.9, H, 0.25);
      p.box('metalDark', -0.88, 0, -0.23, 0.88, 0.06, 0.23);   // plinth
      for (let i = 0; i < 4; i++) {
        const x = -0.9 + i * 0.45;
        p.box('metalDark', x + 0.02, 0.1, -0.26, x + 0.43, H - 0.03, -0.245);
        p.box('metal', x + 0.36, 0.85, -0.27, x + 0.4, 1.0, -0.255);       // handle
        // Vent slots at head height, and the odd door left hanging open.
        for (let v = 0; v < 3; v++) {
          p.box('plastic', x + 0.1, H - 0.16 + v * 0.04, -0.265, x + 0.35, H - 0.14 + v * 0.04, -0.26);
        }
        // A door left ajar would be the nice touch, but it swings outside the
        // footprint and the fit test never knew about it. A dented one instead.
        if (rng.chance(0.2)) p.box('metal', x + 0.08, 0.3, -0.252, x + 0.3, 0.62, -0.244);
      }
      // Depth covers the handles, which stand 2 cm proud of the doors.
      p.obstacle(-0.9, -0.28, 0.9, 0.25, H);
    },
  },

  whiteboard: {
    // Freestanding on castors rather than the wall-hung model, because a prop
    // that has to hang at 0.85 m needs placement machinery nothing else wants.
    w: 1.8, d: 0.5, hp: 30, substance: 'wood',
    build(p, rng) {
      p.box('paper', -0.85, 1.02, -0.03, 0.85, 1.94, 0.03);          // the board
      p.box('metal', -0.88, 0.98, -0.05, 0.88, 1.02, 0.05);          // pen tray
      p.box('metal', -0.88, 1.94, -0.04, 0.88, 1.98, 0.04);
      for (const sx of [-0.78, 0.78]) {
        p.box('metal', sx - 0.03, 0.06, -0.03, sx + 0.03, 1.98, 0.03);
        p.box('metalDark', sx - 0.04, 0, -0.24, sx + 0.04, 0.06, 0.24);  // castor bar
      }
      // Somebody's diagram, still up.
      if (rng.chance(0.8)) p.box('screen', -0.5, 1.3, -0.035, 0.2, 1.7, -0.031);
      p.obstacle(-0.88, -0.24, 0.88, 0.24, 1.98);
    },
  },

  roundTable: {
    w: 2.11, d: 2.11, model: 'round_table', hp: 90, substance: 'wood',
    build(p, rng) {
      const H = 0.75;
      // A disc, near enough: three overlapping slabs read as round from eye
      // height and cost four boxes instead of a lathe.
      p.box('laminate', -1.03, H - 0.05, -0.62, 1.03, H, 0.62);
      p.box('laminate', -0.62, H - 0.05, -1.03, 0.62, H, 1.03);
      p.box('laminate', -0.86, H - 0.05, -0.86, 0.86, H, 0.86);
      p.box('metalDark', -0.09, 0, -0.09, 0.09, H - 0.05, 0.09);
      p.box('metalDark', -0.38, 0, -0.38, 0.38, 0.05, 0.38);
      if (rng.chance(0.7)) p.box('paper', 0.2, H, -0.1, 0.34, H + 0.11, 0.04);
      p.obstacle(-1.03, -1.03, 1.03, 1.03, H);
    },
  },

  stool: {
    w: 0.5, d: 0.5, mass: 7, hp: 25, substance: 'plastic',
    build(p) {
      p.box('fabric', -0.2, 0.58, -0.2, 0.2, 0.64, 0.2);
      for (const sx of [-0.15, 0.15]) {
        for (const sz of [-0.15, 0.15]) {
          p.box('metal', sx - 0.02, 0, sz - 0.02, sx + 0.02, 0.58, sz + 0.02);
        }
      }
      p.box('metal', -0.17, 0.22, -0.17, 0.17, 0.26, 0.17);   // foot ring
      p.obstacle(-0.21, -0.21, 0.21, 0.21, 0.64);
    },
  },

  trashCan: {
    w: 0.44, d: 0.44, mass: 4, hp: 12, substance: 'plastic',
    build(p, rng) {
      p.box('plastic', -0.19, 0, -0.19, 0.19, 0.56, 0.19);
      p.box('metalDark', -0.21, 0.56, -0.21, 0.21, 0.6, 0.21);
      // Overflowing, because nobody on this floor empties anything.
      if (rng.chance(0.6)) p.box('paper', -0.14, 0.6, -0.14, 0.1, 0.72, 0.12);
      p.obstacle(-0.21, -0.21, 0.21, 0.21, 0.6);
    },
  },

  recyclingBin: {
    w: 1.22, d: 0.51, model: 'recycling_bin', hp: 30, substance: 'plastic',
    build(p) {
      const lids = ['hazard', 'plant', 'screen'];
      for (let i = 0; i < 3; i++) {
        const x = -0.6 + i * 0.41;
        p.box('plastic', x, 0, -0.25, x + 0.37, 0.9, 0.25);
        p.box(lids[i], x, 0.9, -0.25, x + 0.37, 0.96, 0.25);
        p.box('metalDark', x + 0.08, 0.94, -0.12, x + 0.29, 0.98, 0.12);   // slot
      }
      p.obstacle(-0.61, -0.255, 0.61, 0.255, 0.98);
    },
  },

  mopBucket: {
    w: 0.62, d: 0.72, model: 'mop_bucket', hp: 14, substance: 'plastic',
    build(p) {
      p.box('plastic', -0.24, 0.06, -0.24, 0.24, 0.42, 0.24);
      p.box('metalDark', -0.26, 0, -0.26, 0.26, 0.06, 0.26);      // castor frame
      p.box('metal', -0.2, 0.42, -0.05, 0.2, 0.6, 0.15);          // wringer
      p.box('metal', -0.03, 0.4, -0.3, 0.03, 0.98, -0.24);        // mop handle
      p.box('fabric', -0.09, 0.1, -0.33, 0.09, 0.4, -0.21);       // the head
      p.obstacle(-0.26, -0.34, 0.26, 0.26, 0.6);
    },
  },

  extinguisher: {
    // The one prop that does not simply break. Hole a pressure vessel and it
    // leaves under its own power — see extinguishers.js.
    w: 0.21, d: 0.31, model: 'fire_extinguisher', hp: 12, substance: 'metal',
    volatile: true,
    build(p) {
      p.box('hazard', -0.09, 0.02, -0.09, 0.09, 0.44, 0.09);
      p.box('metalDark', -0.09, 0, -0.09, 0.09, 0.02, 0.09);
      p.box('metalDark', -0.04, 0.44, -0.04, 0.04, 0.52, 0.04);
      p.box('metal', -0.06, 0.5, -0.12, 0.06, 0.55, 0.06);        // horn
      p.obstacle(-0.1, -0.15, 0.1, 0.15, 0.55);
    },
  },

  receptionDesk: {
    w: 1.13, d: 0.55, model: 'reception_desk', hp: 85, substance: 'wood',
    build(p, rng) {
      const H = 1.1;
      p.box('laminateDark', -0.56, 0, -0.27, 0.56, H - 0.05, 0.2);   // front bulkhead
      p.box('laminate', -0.56, H - 0.05, -0.27, 0.56, H, 0.27);      // transaction top
      p.box('laminate', -0.5, 0.72, -0.2, 0.5, 0.76, 0.26);          // work surface behind
      if (rng.chance(0.8)) {
        p.box('metalDark', -0.2, 0.76, 0.06, 0.2, 0.78, 0.2);
        p.box('screenOn', -0.18, 0.78, 0.1, 0.18, 1.02, 0.13);
      }
      p.obstacle(-0.565, -0.275, 0.565, 0.275, H);
    },
  },

  armchair: {
    w: 1.25, d: 0.95, model: 'armchair', hp: 55, substance: 'fabric',
    build(p) {
      p.box('fabric', -0.5, 0.12, -0.4, 0.5, 0.44, 0.4);
      p.box('fabric', -0.5, 0.44, 0.24, 0.5, 0.82, 0.44);      // back
      p.box('fabric', -0.62, 0.36, -0.44, -0.46, 0.62, 0.44);  // arms
      p.box('fabric', 0.46, 0.36, -0.44, 0.62, 0.62, 0.44);
      p.box('metalDark', -0.5, 0, -0.36, 0.5, 0.12, 0.36);
      p.obstacle(-0.625, -0.475, 0.625, 0.475, 0.44);
    },
  },

  cameraDesk: {
    // The wall of screens the security office exists for. It is the one prop in
    // the catalogue whose job is to identify a room rather than to furnish it:
    // a badged door with a desk and some lockers behind it could be anything,
    // and a badged door with eight live camera feeds behind it could not.
    //
    // Which is why the screens are mostly ON. A dark monitor bank is a prop; a
    // lit one is the only thing in a grey building that is looking back.
    w: 1.9, d: 0.72, hp: 80, substance: 'electronic',
    build(p, rng) {
      const H = 0.74;

      // The console. Darker than an office desk on purpose — this is fitted
      // equipment, not something somebody was issued.
      p.box('laminateDark', -0.95, H - 0.05, -0.36, 0.95, H, 0.36);
      p.box('metalDark', -0.93, 0, -0.34, -0.79, H - 0.05, 0.34);
      p.box('metalDark', 0.79, 0, -0.34, 0.93, H - 0.05, 0.34);
      p.box('metalDark', -0.8, 0.22, 0.28, 0.8, H - 0.07, 0.34);   // modesty panel
      p.box('metal', -0.86, 0.2, -0.3, 0.86, 0.26, 0.3);           // kit shelf under

      // The gantry the bank is bolted to, and the bank itself: four across, two
      // high, on a 0.44 m pitch that lands the outermost bezel inside the
      // console rather than overhanging it.
      p.box('metalDark', -0.9, H, 0.26, 0.9, H + 0.07, 0.34);
      for (let row = 0; row < 2; row++) {
        const y = H + 0.08 + row * 0.32;
        for (let col = 0; col < 4; col++) {
          const x = -0.66 + col * 0.44;
          p.box('plastic', x - 0.21, y, 0.24, x + 0.21, y + 0.3, 0.3);
          // A feed, or a dead channel. Roughly one screen in six is out, which
          // is what a building whose staff have stopped filing tickets looks
          // like from the inside.
          p.box(rng.chance(0.84) ? 'screenOn' : 'screen',
            x - 0.185, y + 0.025, 0.232, x + 0.185, y + 0.275, 0.238);
        }
      }

      // The desk itself: a keyboard, the recorder stack, and the lamp on the
      // rack that says it is still recording.
      p.box('plastic', -0.3, H, -0.3, 0.16, H + 0.02, -0.12);
      p.box('metalDark', 0.34, H, -0.08, 0.86, H + 0.12, 0.2);
      for (let i = 0; i < 3; i++) {
        p.box('led', 0.4 + i * 0.07, H + 0.05, -0.09, 0.43 + i * 0.07, H + 0.08, -0.08);
      }
      if (rng.chance(0.6)) p.box('paper', -0.86, H, -0.28, -0.56, H + 0.02, -0.04);

      p.obstacle(-0.95, -0.36, 0.95, 0.36, H);
    },
  },

  workbench: {
    // The IT bay's bench: a steel frame, a pegboard, and whatever was being
    // fixed on it when the floor went bad.
    w: 2.0, d: 0.8, hp: 85, substance: 'metal',
    build(p, rng) {
      const H = 0.9;
      p.box('laminate', -0.98, H - 0.06, -0.38, 0.98, H, 0.38);
      for (const sx of [-0.92, 0.92]) {
        p.box('metal', sx - 0.05, 0, -0.36, sx + 0.05, H - 0.06, 0.36);
      }
      p.box('metal', -0.9, 0.2, -0.34, 0.9, 0.26, 0.34);         // lower shelf
      p.box('metalDark', -0.95, H, 0.3, 0.95, H + 0.7, 0.36);    // pegboard
      // Guts of whatever is being worked on: towers, boards, a spool of cable.
      const towers = rng.int(1, 3);
      for (let i = 0; i < towers; i++) {
        const x = -0.8 + i * 0.62;
        p.box('metalDark', x, H, -0.24, x + 0.22, H + 0.44, 0.02);
        if (rng.chance(0.6)) p.box('led', x + 0.16, H + 0.3, -0.25, x + 0.2, H + 0.34, -0.24);
      }
      if (rng.chance(0.7)) p.box('plastic', 0.3, H, 0.06, 0.72, H + 0.05, 0.3);
      if (rng.chance(0.6)) p.box('screen', 0.44, H, -0.3, 0.86, H + 0.02, -0.06);
      p.obstacle(-0.99, -0.39, 0.99, 0.39, H);
    },
  },
};

// --- placement --------------------------------------------------------------

// The footprint a prop will REALLY occupy, in world axes, at quarter turn `rot`.
//
// A prop with a downloaded model uses THAT model's measured footprint and not
// the hand-authored `w`/`d`, because the model is what the floor ships with:
// the fit test, the collider and the nav stamp are all cut from it (see
// `tryPlace` below). So the model's footprint is the authoritative one, and the
// catalogue's `w`/`d` is the fallback for a prop that has no model — or whose
// GLB never arrived.
//
// Everything that reasons about where a prop will END UP has to ask the same
// question, or the furnisher lays a room out around one size while the placer
// reserves another. That gap is up to 0.25 m per prop — most of the 0.15 m a
// room keeps clear of its own walls, and enough to turn `openPlan`'s "is there
// a body's width of lane left" test into a guarantee of 0.55 m. `gen/rooms.js`
// had exactly one call site that knew this (`meetingRoom`, for its chair row);
// this is that lookup, made shared, so the wall standoffs and the lane tests
// can stop disagreeing with the thing that actually reserves the floor.
//
// `rot` is the quarter turn the prop is placed at, and the odd turns present
// its depth along x and its width along z — the same swap `tryPlace` makes.
// Leave `rot` off to ask for the prop's own frame, where `d` is always the
// dimension that faces a wall and `w` the one that runs along it.
export function footprintOf(sink, kind, rot = 0) {
  const spec = PROPS[kind];
  const model = spec.model ? sink.modelInfo?.(spec.model) : null;
  const w = model ? model.foot[0] : spec.w;
  const d = model ? model.foot[1] : spec.d;
  return (rot & 1) === 1 ? { w: d, d: w } : { w, d };
}

// Emits `kind` at (cx,cz) if its footprint is clear. Returns whether it landed.
//
// Props carrying a `mass` are loose: they become rigid bodies instead of static
// geometry, so shooting a chair sends it skidding across the carpet. Every prop
// carries `hp` and comes apart when that runs out, into exactly the boxes it was
// authored from — including the model-backed ones, which is why a prop drawn as
// a GLB still runs its `build` here. The boxes are captured without being
// emitted (`captureBoxes`), so the model is what you see and the boxes are only
// what it falls into.
export function tryPlace(sink, kind, cx, cz, rot, rng) {
  const spec = PROPS[kind];

  // A prop with a downloaded model uses THAT model's measured footprint, not
  // the hand-authored one, so collision always matches what you can see. If the
  // model is missing the prop falls back to its boxes and its own footprint.
  // `footprintOf` is that rule, shared with the furnisher so both ends of a
  // placement agree on how much floor is about to disappear.
  const model = spec.model ? sink.modelInfo(spec.model) : null;
  const foot = footprintOf(sink, kind, rot);
  const w = foot.w / 2;
  const d = foot.d / 2;

  if (!sink.canPlace(cx - w, cz - d, cx + w, cz + d)) return false;

  if (spec.mass) {
    // Loose: its own rigid body, and its own mesh so physics can move it.
    sink.beginDynamic(spec.mass, spec.hp, spec.substance);
    spec.build(placer(sink, cx, cz, rot), rng);
    sink.endDynamic();
  } else if (model) {
    // The debris has to be worked out before the model is stamped, so the
    // capture pass doesn't swallow the model's geometry along with it.
    const debris = sink.captureBoxes(() => spec.build(placer(sink, cx, cz, rot), rng));

    // The quarter turns rotate the front from -Z toward +X, which is a negative
    // rotation about Y in Three's right-handed frame.
    const yaw = -rot * Math.PI / 2;
    // Every model drawn for this prop, so the debris can be painted in their
    // colours rather than the palette the fallback boxes were authored in.
    const stamps = [{ key: spec.model, x: cx, y: 0, z: cz, yaw }];

    sink.beginStatic(spec.hp, spec.substance, spec.volatile);
    // `model()` says whether anything was actually stamped. It wasn't if the
    // GLB failed to fetch, or if there is no loader at all — which is every run
    // of the headless validators in tools/. Only the PICTURE falls back in that
    // case: the boxes that were going to be debris are re-emitted as the prop
    // itself, exactly as the no-model branch below would have drawn them. The
    // footprint and the collider stay the model's, because the model's
    // footprint is what the shipped floor is laid out around, and a validator
    // that reserved the fallback size would be proving the wrong floorplan.
    const drawn = sink.model(spec.model, cx, 0, cz, yaw);
    if (!drawn) for (const b of debris) sink.box(b.key, b.x0, b.y0, b.z0, b.x1, b.y1, b.z1);

    // What the model is carrying, drawn for real in the building's own palette
    // — the stock on a rack's decks. Unlike `build`, this is NOT captured: it
    // is the only picture of those boxes there is, and because it goes through
    // the same static record it joins the debris and the destroyed span for
    // free.
    //
    // It is called either way, drawn or not, and that is deliberate: it draws
    // from `rng`, and a floor has to come out the same whether or not a GLB
    // happened to load. When there is no model the fallback boxes already carry
    // their own stock, so the draws are made and thrown away rather than
    // stacking a second set of cartons on the first.
    if (drawn) spec.dress?.(placer(sink, cx, cz, rot), rng);
    else sink.captureBoxes(() => spec.dress?.(placer(sink, cx, cz, rot), rng));

    // The model's own height, unless the prop stands something on top of itself
    // — a pallet is 19 cm and the stack on it is over a metre, and a collider
    // you can walk through is worse than no pallet at all.
    sink.obstacle(cx - w, cz - d, cx + w, cz + d, spec.obstacleTop ?? model.height);

    // Anything that belongs on top of it — a monitor on a desk, a carton on the
    // third deck of a rack. `y` names the deck it stands on; without one the
    // item sits on top of the whole prop, which is what a desk wants.
    if (spec.desktop) {
      for (const item of spec.desktop) {
        if (rng.chance(item.chance ?? 1)) {
          const [ox, oz] = QUARTER[rot & 3](item.x ?? 0, item.z ?? 0);
          const stamp = {
            key: item.key,
            x: cx + ox, y: item.y ?? model.height, z: cz + oz,
            yaw: yaw + (item.yaw ?? 0),
          };
          sink.model(stamp.key, stamp.x, stamp.y, stamp.z, stamp.yaw);
          stamps.push(stamp);
        }
      }
    }

    sink.paintDebris(debris, stamps);
    // The debris list only ADDS to what the prop drew when the model drew the
    // prop. If the boxes were re-emitted above they are already in the record,
    // and handing them over a second time would break the prop into two of
    // everything.
    sink.endStatic(drawn ? debris : undefined);
  } else {
    // Static boxes: the geometry it is drawn with is already the geometry it
    // falls apart into, so there is nothing to capture separately.
    sink.beginStatic(spec.hp, spec.substance, spec.volatile);
    spec.build(placer(sink, cx, cz, rot), rng);
    sink.endStatic();
  }

  sink.occupy(cx - w, cz - d, cx + w, cz + d);
  return true;
}

// Every model key the furnishing pass can ask for, so the loader only fetches
// what a floor actually needs rather than all 71.
export function modelKeysUsed() {
  const keys = new Set();
  for (const spec of Object.values(PROPS)) {
    if (spec.model) keys.add(spec.model);
    for (const item of spec.desktop ?? []) keys.add(item.key);
  }
  return [...keys];
}
