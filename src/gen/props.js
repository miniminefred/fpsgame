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

import { CAN_FLAVOURS, CAN_R, CAN_H, CAN_LABEL, drinkFrom } from '../drinks.js';

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
    obstacle(lx0, lz0, lx1, lz1, top, building) {
      const [ax, az] = turn(lx0, lz0);
      const [bx, bz] = turn(lx1, lz1);
      sink.obstacle(
        cx + Math.min(ax, bx), cz + Math.min(az, bz),
        cx + Math.max(ax, bx), cz + Math.max(az, bz), top, building);
    },
    // Welded structure, marked for the wreck it leaves — see `weld` in the
    // generator and `hulk` on the sink. Nothing about a coordinate changes, but
    // a prop only ever sees this placer, so anything the sink offers has to be
    // offered through here or it silently reaches nothing. Which is exactly
    // what happened: the marker was added to the sink and to the machine, both
    // correct, and every box came out unmarked because the two are not
    // introduced anywhere but here.
    hulk(on) { sink.hulk(on); },
    // What the prop is HOLDING rather than what it is made of, carrying the
    // seed that says which drink it is — see `stock` on the sink, and note the
    // trap `hulk` documents one line up applies here in full: a marker that is
    // not forwarded through this object reaches nothing, silently.
    stock(seed) { sink.stock(seed); },
  };
}

// A monitor standing on a desk at (x, z) in the desk's local space, screen
// facing the near side where the chair goes. Not a catalogue entry of its own —
// it's only ever part of a workstation.
/**
 * The lift lobby's counter: an L in the wall's own paint.
 *
 * `wall` is the material the shell draws every interior wall with, so it is the
 * same colour by construction rather than by a hex matched by hand, and it
 * follows the floor's own tint for free. Both entries in the catalogue call this
 * with their own half-sizes; the shape is the same and only the size differs.
 *
 * THE COUNTER IS OUT TOWARDS THE ROOM AND THE BODY IS BEHIND IT, which is the
 * only arrangement of an L that means anything. The long leg runs OUT FROM THE
 * WALL through the whole depth of the footprint — a peninsula you walk up to the
 * SIDE of — and one short return leg closes its nose, leaving the pocket between
 * it and the plaster for whoever works there.
 *
 * WHICH LEG IS THE UNCUT ONE IS THE WHOLE OF HOW IT READS. It was the other way
 * round for a revision — the along-the-wall leg spanning the full width at the
 * room end with the out leg starting behind it — and that is the same L region
 * cut the other way, so nothing measured wrong and nothing swept red. What it
 * cost was the shape: the two legs came out 1.9 m and 1.88 m, a matched L, which
 * is the slab across a corner this prop exists not to be. The catalogue has
 * promised "the out leg the longer of the two" since it was written and the code
 * had never done it; cut this way it is 2.2 m against 1.58 m.
 *
 * The FOOTPRINT and the POCKET are untouched by that, and deliberately so: the
 * union of the two legs is the same L either way, so `standableCorner` finds the
 * same square, the pocket arithmetic below still closes, and not a line of the
 * placement in `liftLobby` had to move.
 *
 * It was the other way round for its first revision, with the long leg bedded
 * into the plaster and the void opening into the lobby, and that is a counter
 * with nothing on the room side of it: the void is open to the room, so a
 * visitor walks straight into it and stands beside the receptionist rather than
 * across a desk from them. Measured over 60 floors before this was rewritten:
 * 59 lobbies had somebody at a counter and NOT ONE of them had any counter
 * between that body and the room — all 59 had it only off to one side. A
 * reception desk is the one prop in the building somebody stands behind, and
 * behind is on the wall side.
 *
 * TWO OBSTACLES RATHER THAN ONE, and that is the whole of why the pocket inside
 * it is somewhere anybody can be. A prop's collider is what nav blocks, so one
 * rectangle over the footprint would fill in its own void and the receptionist
 * would be standing inside a wall. A leg each leaves the inside as ordinary
 * floor.
 *
 * WHAT SIZE THE POCKET HAS TO BE: `fits` in nav.js is a circle test, so a body
 * needs its whole 3x3 of tiles clear, diagonals included — 1.5 m of it. The
 * pocket is bounded on THREE sides now (the out leg, the return leg and the
 * plaster) where the old void was bounded on two, so its DEPTH can no longer be
 * made up out of open lobby floor and is the number both sizes are chosen
 * against. It is measured from the plaster rather than from the prop, because
 * `bounds` insets every prop by SKIRT and the wall tile is what blocks: a
 * 2.2 m counter leaves 0.15 + 2.2 - T = 2.03 m, which is four clear tile rows,
 * and the 1.7 m one leaves 1.53 m, which is exactly three. Under three there is
 * no standable tile in there at all, and the stub below is what covers it.
 *
 * Three boxes a leg and both of the shadow lines that stop it reading as one
 * lump: the top stands proud all round and the plinth is set back, so the mass
 * of it appears to float a hand's width off the floor. The deeper setback goes
 * on whichever faces are SEEN — the counter face and the nose — since that is
 * where the shadow line reads. A transaction counter is 1.06 m — see the
 * heights in CHORE_POSE, which is what a body at one is posed against.
 */
function lCounter(p, RX, RZ, T = 0.32) {
  const H = 1.06, TOP = 1.12;
  const AX = RX - T, AZ = RZ - T;      // where each leg's inner face falls
  // OUT INTO THE ROOM, THE WHOLE DEPTH OF THE FOOTPRINT. Authored facing -Z
  // like everything else, so +z beds into the plaster and -z is the nose of the
  // peninsula. This is the leg a visitor walks up to the SIDE of, so it is the
  // one that runs uncut from the wall to the nose and the longer of the two.
  p.box('wall', -RX + 0.02, 0.09, -RZ + 0.02, -AX - 0.02, H, RZ);
  p.box('wall', -RX + 0.08, 0, -RZ + 0.08, -AX - 0.02, 0.09, RZ);
  p.box('wall', -RX, H, -RZ, -AX, TOP, RZ);
  // ...and one return leg across the NOSE of it, closing the far end of the
  // pocket. It runs along the wall's own direction and stops at the out leg's
  // inner face, so what butts into what is the way round the eye reads it: one
  // long counter with a short return on the end, not two legs of a matched L.
  p.box('wall', -AX, 0.09, -RZ + 0.02, RX - 0.02, H, -AZ - 0.02);
  p.box('wall', -AX, 0, -RZ + 0.08, RX - 0.08, 0.09, -AZ - 0.02);
  p.box('wall', -AX, H, -RZ, RX, TOP, -AZ);
  // One collider per leg, which is what leaves the pocket standable.
  p.obstacle(-RX, -RZ, -AX, RZ, TOP);
  p.obstacle(-AX, -RZ, RX, -AZ, TOP);
}

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

// The window of a drinks machine, and the stock standing in it.
//
// EVERY NUMBER HERE IS MEASURED OFF THE GLB, not eyeballed off a screenshot: the
// glass pane is its own mesh in store_vending_machine.glb, and in the model's
// normalized frame (which is the prop's own frame, since tryPlace stamps the
// model at the placer's origin and yaw) it stands at these bounds. Note the
// window is NOT centred on the machine — the keypad takes the left third — so a
// rack centred on the prop would have half of it inside the bodywork.
const WIN = { x0: -0.242, x1: 0.442, y0: 0.744, y1: 1.735 };
// The pane's own front face, and the machine's front skin 46 mm ahead of it.
// That recess is the whole reason this works: the stock is drawn as a FACING in
// front of the glass rather than behind it, because the pane is opaque and
// shares one material with the entire bodywork, so there is no glass to see
// through and nothing that can be made transparent without dissolving the
// machine. Painted on, exactly the way panels.js paints a hole in a wall and
// buildCan paints the hole in a shot can — and the bezel around the window is
// what hides the trick, since a facing 38 mm deep sits wholly inside the recess
// with 7 mm to spare and reads as product pressed against the glass.
const WIN_GLASS = -0.271;
const FACE_D = 0.038;
const WIN_INSET = 0.014;   // the bezel's inner lip, kept clear on all four sides
const SHELF_T = 0.012;     // the plate a row of cans stands on
const CAN_GAP = 0.012;     // between two cans across a row
const ROW_GAP = 0.012;     // headroom over a row, under the shelf above it
// How many slots have anything in them. Under one, because a machine with every
// slot full is a machine nobody has used — and because it is the honest way to
// bring the count down: every can in that window is a can that comes out of it
// when the machine goes (see `_spillStock`), so twenty-four full slots would be
// twenty-four rigid bodies out of one round. Six of the twenty-four come out
// empty on average, which is a used machine AND a payload the solver can carry.
const STOCKED = 0.62;

function canRack(p, rng) {
  const pitchX = CAN_R * 2 + CAN_GAP;
  const pitchY = SHELF_T + CAN_H + ROW_GAP;
  const cols = Math.floor((WIN.x1 - WIN.x0 - WIN_INSET * 2) / pitchX);
  const rows = Math.floor((WIN.y1 - WIN.y0 - WIN_INSET * 2) / pitchY);
  if (cols < 1 || rows < 1) return;

  // Centred on what the columns actually came to rather than on the window, so
  // the spare fraction of a slot is split between the two ends.
  const left = (WIN.x0 + WIN.x1) / 2 - (cols * pitchX - CAN_GAP) / 2;
  const z1 = WIN_GLASS - 0.001;
  const z0 = z1 - FACE_D;

  for (let row = 0; row < rows; row++) {
    const shelf = WIN.y0 + WIN_INSET + row * pitchY;
    p.box('metalDark',
      WIN.x0 + WIN_INSET, shelf, z0, WIN.x1 - WIN_INSET, shelf + SHELF_T, z1);

    for (let col = 0; col < cols; col++) {
      if (!rng.chance(STOCKED)) continue;
      // The seed is the drink, and it is drawn ONCE here and carried on the box:
      // the facing's paint and the can that is thrown out of this slot are both
      // `drinkFrom(seed)`, so they cannot disagree. See drinks.js.
      const seed = rng.int(0, 0xffffff);
      const x = left + col * pitchX;
      const foot = shelf + SHELF_T;
      p.stock(seed);
      p.box(CAN_FLAVOURS[drinkFrom(seed).flavour].mat,
        x, foot, z0, x + CAN_R * 2, foot + CAN_H, z1);
      // The label round its middle, and it is what turns the facing from a
      // rectangle of paint into a can — the flavour's own colour showing above
      // and below a dark sleeve is the whole silhouette of these drinks (see
      // canShapes in rigs.js), and without it a stocked machine reads as a rack
      // of coloured blocks. A hair proud of the paint, the way the real sleeve
      // stands off the barrel.
      //
      // Marked 'trim' rather than with the seed: it is part of THIS can and not
      // a can of its own, so it must be neither thrown as a drink (two cans out
      // of one slot) nor thrown as a fragment (a label sailing across the room
      // out of the budget the cabinet panels are meant to have). Same
      // distinction `hulk` draws between a machine's own mass and a fitting
      // bolted to it, and for the same reason.
      p.stock('trim');
      p.box('plastic',
        x, foot + CAN_LABEL.y0, z0 - 0.001, x + CAN_R * 2, foot + CAN_LABEL.y1, z1);
    }
    p.stock(null);
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

  // A single carton, and the lightest thing on the floor.
  //
  // It exists to be in the way rather than to be furniture: light enough that
  // walking into one sends it sliding, weak enough that one round of anything
  // ends it, and `crushable` so that anybody who walks over it flattens it (see
  // `crush` in destruction.js). Deliberately NOT model-backed — a loose prop
  // needs its own mesh for the solver to move, and the boxes it is drawn from are
  // the pieces it comes apart into.
  carton: {
    w: 0.44, d: 0.38, mass: 2.2, hp: 8, substance: 'cardboard', crushable: true,
    build(p, rng) {
      const h = rng.range(0.26, 0.34);
      const hw = 0.21, hd = 0.18;
      p.box('cardboard', -hw, 0, -hd, hw, h, hd);
      // The taped seam across the top, and a shipping label on one face. Two
      // little boxes, and they are what stop it reading as a brown cube.
      p.box('paper', -0.05, h, -hd, 0.05, h + 0.006, hd);
      if (rng.chance(0.7)) {
        p.box('paper', -0.09, h * 0.45, -hd - 0.004, 0.09, h * 0.72, -hd + 0.004);
      }
      p.obstacle(-hw, -hd, hw, hd, h);
    },
  },

  crateStack: {
    // Lighter and weaker than it was, and `crushable` like the single carton: the
    // point of a cardboard box is that it loses every argument it is in.
    w: 0.72, d: 0.72, mass: 4, hp: 12, substance: 'cardboard', crushable: true,
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
    // `spills` is what makes it leak when it is shot rather than merely break —
    // see damageProp in destruction.js and spills.js for what comes out.
    w: 0.4, d: 0.4, mass: 11, hp: 35, substance: 'plastic', spills: 'water',
    // Authored in courses rather than as two big boxes, and that is about how it
    // DIES. A prop comes apart into exactly the boxes it was drawn from, so a
    // 1.0 m plinth with a 0.42 m bottle on it threw two fragments the size of the
    // machine — which landed where the machine had been standing and left a
    // destroyed cooler looking like an intact one that had stopped being solid.
    // Six pieces read as a wrecked cooler; two read as the same cooler.
    build(p) {
      // The plinth, in three courses with a recessed back.
      for (const [y0, y1] of [[0, 0.34], [0.34, 0.68], [0.68, 1.0]]) {
        p.box('metal', -0.18, y0, -0.18, 0.18, y1 - 0.01, 0.18);
      }
      // The bottle, in two: they are the pieces that go furthest when it bursts.
      p.box('screenOn', -0.14, 1.0, -0.14, 0.14, 1.21, 0.14);
      p.box('screenOn', -0.13, 1.21, -0.13, 0.13, 1.42, 0.13);
      // Tap and drip tray.
      p.box('metalDark', -0.1, 0.62, -0.2, 0.1, 0.72, -0.17);
      p.box('metalDark', -0.13, 0.5, -0.19, 0.13, 0.54, -0.14);
      p.obstacle(-0.18, -0.18, 0.18, 0.18, 1.42);
    },
  },

  washingMachine: {
    // Nobody knows why there is one in the corridor and it is not answering
    // questions. It is on an unbalanced spin cycle and losing the argument with
    // its own drum — see washers.js for the thrashing, the racket and what
    // happens when you shoot it.
    //
    // The only prop in the catalogue that is LOOSE and model-backed at once,
    // which the split in gen/models.js says should not happen: a loose prop
    // needs its own mesh so the solver can move it, and a model is one merged
    // mesh per material. It gets both because it has to. A static one cannot
    // hop — batched geometry does not move — and it is the hopping that this
    // prop IS. So `endDynamic` in gen/sink.js draws the model as the group's
    // own meshes and keeps the boxes below as the pieces it breaks into, which
    // is the same division of labour every model-backed prop already has,
    // moved from the batch onto one free-standing group.
    //
    // 68 kg is a commercial machine with water in it and it matters twice over:
    // it is what stops a burst of SMG fire shoving it down the corridor, and it
    // is what the hop impulses in washers.js are sized against.
    w: 0.83, d: 0.86, mass: 68, hp: 55, substance: 'metal', spills: 'water',
    model: 'washing_machine',
    // Read in gen/sink.js and handed to the runtime on the dynamic record.
    // washers.js finds its machines with it rather than by matching on the prop
    // name, which is the same reason `crushable` and `spills` are flags.
    washer: true,
    // Authored in courses for the reason the water cooler is (see above): a prop
    // comes apart into exactly the boxes it was drawn from, and this one is
    // going to come apart in front of you at close range rather than quietly
    // across a room, so two fragments the size of the machine would not do.
    build(p) {
      // The casing, in three courses, so the thing that is left on the carpet
      // reads as a machine that burst rather than as a cupboard that fell over.
      p.box('metal', -0.41, 0.06, -0.43, 0.41, 0.40, 0.43);
      p.box('metal', -0.41, 0.40, -0.43, 0.41, 0.74, 0.43);
      p.box('metalDark', -0.41, 0.74, -0.43, 0.41, 0.95, 0.43);
      // The door. `screenOn` because it is the one lit-looking thing on it and
      // the drum behind glass is what says which way the machine is facing.
      p.box('screenOn', -0.30, 0.30, -0.45, 0.30, 0.66, -0.42);
      // Dials and a little display, on the control deck.
      p.box('plastic', 0.12, 0.79, -0.45, 0.34, 0.90, -0.42);
      // Four feet, which are the parts this whole prop is about: they are what
      // it is hammering the floor with.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          p.box('metalDark', sx * 0.33 - 0.05, 0, sz * 0.35 - 0.05,
            sx * 0.33 + 0.05, 0.06, sz * 0.35 + 0.05);
        }
      }
      p.obstacle(-0.41, -0.43, 0.41, 0.43, 0.95);
    },
  },

  vending: {
    // `spills` is the same flag the water cooler carries, and this is the one
    // place the STATIC path reads it: a vending machine is model-backed, so it
    // has no rigid body and cannot leak when it is merely shot. Destroying it
    // bursts everything inside it at once, which is what twenty cans coming
    // apart in a steel cabinet does — and a machine full of drinks that is blown
    // across a corridor and leaves the carpet dry is the identical lie the
    // cooler used to tell. See `_shatter` in destruction.js and LIQUIDS in
    // spills.js for how much comes out and what colour it is.
    w: 1.29, d: 0.64, model: 'vending_machine', hp: 120, substance: 'electronic',
    spills: 'drink',
    // The stock, standing in the window where you can see what you are about to
    // spill — and, when the machine goes, the cans that come out of it. See
    // `canRack` above for why it is drawn in front of the glass rather than
    // behind it, and `_spillStock` in destruction.js for what happens to it.
    //
    // Only here and NOT in `build` below, which is the opposite of what a
    // storage rack does with its own stock, and deliberately: `parts` is the
    // captured build boxes PLUS what dress drew, so a machine authoring its
    // stock in both would be holding two of every can — one thrown as a
    // coloured box out of the fragment budget and one as the drink itself. The
    // cost is that a machine whose GLB failed to fetch has an empty window and
    // nothing to spill, which is the same graceful nothing every other
    // model-backed prop degrades to.
    dress: canRack,
    // The fallback picture, and the pieces it breaks into. Two things about it
    // were wrong and both only showed in the wreckage, which is where nobody
    // looks until the wreckage is the point of the prop.
    //
    // It is on the MODEL's own measured bounds now (1.286 x 0.64 x 1.90, with the
    // window and the keypad where the GLB really has them). It had been authored
    // 1.0 m wide with both MIRRORED onto the wrong sides, which is invisible
    // while the machine is standing — the model is what you see — and is not
    // invisible once it comes apart, because the display panel then flies out of
    // the wrong side of a cabinet a quarter of a metre too narrow.
    //
    // And it is a CABINET rather than a solid, which is the water cooler's
    // lesson (see its own entry): a prop comes apart into exactly the boxes it
    // was drawn from, so one box the size of the machine throws one fragment the
    // size of the machine, and it lands where the machine was standing. A
    // destroyed cooler looked like an intact cooler that had stopped being
    // solid; a destroyed drinks machine looked like a yellow slab leaning over
    // its own stock, which is worse, because the stock is the whole point of
    // shooting it. Sides, back, top, plinth and a front frame around the window
    // is what a sheet-steel cabinet is actually made of, and panels are what a
    // panel-goods filter (see MIN_FRAGMENT) is built to keep.
    build(p) {
      const T = 0.05;          // sheet steel, and the depth of the front frame
      const X = 0.643, D = 0.32, H = 1.90;
      const inner = X - T;     // where the side panels stop
      const front = -D + T;    // ...and the back of the front frame
      // Both sides and the back come off in HALVES, and that is about the size
      // of a fragment rather than about the cabinet: full height they are
      // 1.90 m sheets, and five of those land leaning against each other and
      // read as flat-pack furniture stacked where the machine was standing
      // rather than as a machine that has been blown apart. Cut at the bottom of
      // the window, which is where the carcass has a seam anyway.
      for (const sx of [-1, 1]) {
        p.box('metalDark', sx * X, 0, -D, sx * inner, WIN.y0, D);      // sides
        p.box('metalDark', sx * X, WIN.y0, -D, sx * inner, H, D);
      }
      p.box('metalDark', -X, 0, D - T, X, WIN.y0, D);                 // back
      p.box('metalDark', -X, WIN.y0, D - T, X, H, D);
      p.box('metalDark', -inner, H - T, -D, inner, H, D - T);         // top
      p.box('metalDark', -inner, 0, -D, inner, 0.12, D - T);          // plinth
      // The front frame: under the window, over it, and a jamb either side.
      p.box('metalDark', -inner, 0.12, -D, inner, WIN.y0, front);
      p.box('metalDark', -inner, WIN.y1, -D, inner, H - T, front);
      p.box('metalDark', -inner, WIN.y0, -D, WIN.x0, WIN.y1, front);
      p.box('metalDark', WIN.x1, WIN.y0, -D, inner, WIN.y1, front);
      p.box('screenOn', WIN.x0, WIN.y0, WIN_GLASS, WIN.x1, WIN.y1, -0.195);
      p.box('plastic', -0.515, 0.928, -D, -0.366, 1.283, -0.269);     // keypad
      p.box('metal', -0.427, 0.39, -D, 0.432, 0.63, -0.28);           // collection tray
      p.obstacle(-X, -D, X, D, H);
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

  // The same table for a room that cannot take the big one.
  //
  // It is a REAL meeting table and not a coffee table, which is what used to
  // stand in here — and a coffee table is 0.42 m high, so a meeting room that
  // rolled small came out as four office chairs drawn up round something you
  // would put a magazine on. Same top at the same 0.75 m, same dark laminate,
  // same speakerphone in the middle of it: it is the big one shortened to seat
  // four, which is what a small meeting room actually contains.
  //
  // No model, deliberately. `meeting_table` measures 1.88 x 0.98 (gen/model-table
  // .js) — that IS the big one as the game ships it, whatever the catalogue's
  // hand-authored 3.1 says — so there is nothing smaller to point at, and a prop
  // this size is four boxes and a phone.
  smallMeetingTable: {
    w: 1.35, d: 0.85, hp: 90, substance: 'wood',
    build(p, rng) {
      const H = 0.75;
      p.box('laminateDark', -0.66, H - 0.06, -0.42, 0.66, H, 0.42);
      // One pedestal rather than a leg at each corner, which is what a table this
      // size has and is also what keeps its legs out from under the chairs: four
      // legs on a 1.35 m table land exactly where somebody's knees go.
      p.box('metal', -0.08, 0, -0.08, 0.08, H - 0.06, 0.08);
      p.box('metalDark', -0.34, 0, -0.26, 0.34, 0.05, 0.26);
      p.box('plastic', -0.14, H, -0.14, 0.14, H + 0.06, 0.14);
      if (rng.chance(0.5)) p.box('paper', 0.24, H, -0.24, 0.5, H + 0.02, 0.02);
      p.obstacle(-0.66, -0.42, 0.66, 0.42, H);
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

  // --- what a canteen is made of ---------------------------------------------

  canteenTable: {
    // No model, and that is the point of it: the candidates are all dining
    // tables, and what tells a refectory table from a meeting table is not the
    // slab, it is the trays nobody cleared off it. A GLB would have to bring
    // its own, and would bring a dining room with them.
    w: 2.3, d: 0.86, hp: 80, substance: 'wood',
    build(p, rng) {
      const H = 0.74;
      p.box('laminate', -1.15, H - 0.05, -0.43, 1.15, H, 0.43);
      // Trestles rather than four legs, so a chair pushed in at either end has
      // somewhere to go.
      for (const sx of [-0.8, 0.8]) {
        p.box('metal', sx - 0.05, 0, -0.3, sx + 0.05, H - 0.05, 0.3);
        p.box('metalDark', sx - 0.3, 0, -0.34, sx + 0.3, 0.05, 0.34);
      }
      p.box('metal', -0.8, 0.12, -0.04, 0.8, 0.18, 0.04);         // stretcher
      // Lunch, abandoned mid-shift. Every place is rolled on its own, so no two
      // tables in a room come out laid the same way.
      for (const sx of [-0.75, -0.25, 0.25, 0.75]) {
        for (const sz of [-0.2, 0.2]) {
          if (!rng.chance(0.32)) continue;
          p.box('plastic', sx - 0.16, H, sz - 0.11, sx + 0.16, H + 0.03, sz + 0.11);
          if (rng.chance(0.7)) {
            p.box('paper', sx - 0.09, H + 0.03, sz - 0.07, sx + 0.09, H + 0.05, sz + 0.07);
          }
          if (rng.chance(0.5)) {
            p.box('paper', sx + 0.04, H + 0.03, sz - 0.05, sx + 0.11, H + 0.12, sz + 0.02);
          }
        }
      }
      p.obstacle(-1.15, -0.43, 1.15, 0.43, H);
    },
  },

  servery: {
    // The counter you queue at, and the whole reason a cafeteria reads as one
    // from its doorway rather than as a meeting room with too many tables in
    // it.
    //
    // `spanning` for exactly the reason the generator is (see its entry below):
    // it is built to the width it is ASKED for and runs its wall corner to
    // corner. A three-metre counter parked against the middle of a
    // twelve-metre wall is a kitchenette somebody installed; a serving line
    // reaching both corners IS the end of the room, which is what the seating
    // faces and what you walk in at.
    spanning: true,
    // `w` is the fallback for the rare wall that will not take a full span, and
    // the size anything that does not ask measures. `d` covers the carcass AND
    // the tray rail standing proud of its front — a prop whose declared
    // footprint stops short of its own geometry is a prop you can put your
    // shoulder through (10.geo-fit in tools/validate-props.mjs).
    w: 3.4, d: 1.0, hp: 240, substance: 'metal',
    build(p, rng, w = 3.4) {
      const hw = w / 2;
      // Every detail below is placed by measuring IN from an end, never at a
      // hard-coded x — that is what lets one servery be 4 m on one floor and
      // 12 m on the next without stretching its fittings into a different
      // counter. Same rule as the generator, and for the same reason.
      const inset = (m) => Math.max(0, hw - m);
      const H = 0.92;

      p.box('metalDark', -hw, 0, 0.0, hw, 0.12, 0.46);          // recessed kickboard
      p.box('metal', -hw, 0.12, -0.2, hw, H, 0.5);              // carcass
      p.box('metal', -hw, H, -0.28, hw, H + 0.04, 0.5);         // stainless top, overhanging
      p.box('metalDark', -hw, H + 0.04, 0.44, hw, H + 0.14, 0.5); // splashback lip

      // The hot line: pans of whatever today is, sunk into the top. Counted off
      // the length rather than fixed at four, so a long counter gets more of
      // them instead of four stretched ones.
      const run = Math.max(0.9, w - 1.6);
      const wells = Math.max(2, Math.round(run / 0.85));
      const pan = run / wells;
      for (let i = 0; i < wells; i++) {
        const cx = -run / 2 + (i + 0.5) * pan;
        const half = pan / 2 - 0.05;
        p.box('metalDark', cx - half, H + 0.04, 0.02, cx + half, H + 0.1, 0.38);
        // Not every pan is still in service at this hour.
        if (rng.chance(0.7)) {
          p.box(rng.chance(0.5) ? 'hazard' : 'cardboard',
            cx - half + 0.04, H + 0.1, 0.06, cx + half - 0.04, H + 0.14, 0.34);
        }
      }

      // Sneeze guard: posts up off the top with a glass screen between them, at
      // about the height reaching over one stops being possible.
      for (const sx of [-inset(0.25), inset(0.25)]) {
        p.box('metal', sx - 0.03, H + 0.04, -0.12, sx + 0.03, H + 0.62, -0.06);
      }
      p.box('glass', -inset(0.25), H + 0.32, -0.105, inset(0.25), H + 0.62, -0.075);

      // Tray rail, on brackets: the part of the counter that reaches the queue.
      p.box('metal', -inset(0.08), 0.86, -0.45, inset(0.08), 0.9, -0.33);
      for (const sx of [-inset(0.3), 0, inset(0.3)]) {
        p.box('metal', sx - 0.03, 0.86, -0.33, sx + 0.03, 0.9, -0.2);
      }

      // The till, at one end, where a queue ends.
      const till = inset(0.5);
      p.box('metalDark', till - 0.2, H + 0.04, 0.04, till + 0.2, H + 0.26, 0.36);
      p.box('screenOn', till - 0.15, H + 0.26, 0.08, till + 0.15, H + 0.28, 0.3);

      // Menu boards on a gantry over the back of the counter. Lit, because they
      // are the one thing in the room worth reading, and because a lit panel is
      // how everything else in this building says "look here".
      const board = inset(0.55);
      for (const sx of [-board, board]) {
        p.box('metal', sx - 0.04, H + 0.14, 0.42, sx + 0.04, 1.96, 0.5);
      }
      p.box('metalDark', -board, 1.96, 0.4, board, 2.36, 0.5);
      const panels = Math.max(2, Math.round(board * 2 / 1.1));
      for (let i = 0; i < panels; i++) {
        const x0 = -board + (i + 0.06) * (board * 2 / panels);
        const x1 = -board + (i + 0.94) * (board * 2 / panels);
        p.box(rng.chance(0.85) ? 'screenOn' : 'screen', x0, 2.02, 0.38, x1, 2.3, 0.4);
      }

      // Shell rather than furniture, the same as the generator and for the same
      // reason: a counter that runs a whole wall is well past the furniture caps
      // in tools/validate-props.mjs, which are there to catch a prop that has
      // accidentally become a building.
      p.obstacle(-hw, -0.5, hw, 0.5, H + 0.62, true);
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

  // The lift lobby's counter, and it is a PROJECTION OF THE WALL rather than a
  // piece of furniture: same paint, same speckle, jutting straight out into the
  // room with somebody standing in the crook of it.
  //
  // `wall` is the material the shell draws every interior wall with, so this is
  // the same colour by construction rather than by a number matched by hand —
  // and it follows the floor's own tint for free, which a hex here could not.
  //
  // The long axis is the DEPTH, which is what makes it a peninsula: `edgeProp`
  // stands a prop off its wall by half its depth, so 2.4 m of depth is 2.4 m of
  // counter running out into the lobby with its +z end bedded in the plaster.
  // Nothing else in the catalogue is authored that way round.
  //
  // Three boxes and both of the shadow lines that stop it reading as one lump:
  // the top stands proud all round, and the plinth is set back so the mass of it
  // appears to float a hand's width off the floor. A transaction counter is
  // 1.06 m and the till side of it a hair over — see the heights in CHORE_POSE,
  // which is what a body standing at one is posed against.
  receptionCounter: {
    // AN L, with the receptionist standing in the little square inside it: one
    // leg along the wall it grows out of, one running OUT into the room, and the
    // out leg the longer of the two — a counter you walk up to the side of
    // rather than a slab across a corner.
    // NOT DESTRUCTIBLE, and that is `beginStatic`'s own opt-out rather than a new
    // one: with no `hp` it files no destructible record, so `resolve` in
    // destruction.js names no prop for a round that lands here and the counter is
    // plain scenery — the same answer a wall gives. `box` and `obstacle` both
    // write through `record?.`, so it still draws and still collides.
    //
    // It earns that by being the fabric of the building rather than furniture: it
    // is drawn in `wall`, the material the shell paints every interior wall with,
    // it is a projection OUT of the plaster it matches, and it is the one thing in
    // the lobby a body is posted behind for the whole floor. A filing cabinet
    // coming apart is the floor being fought over; a reception counter coming
    // apart takes the room's only station with it and leaves the receptionist
    // standing in the open.
    //
    // `substance` goes with the hp rather than being left behind. It is read in
    // exactly one place — the record `beginStatic` no longer files — so keeping it
    // would be a field no code reads, which is the thing the Sentry Unit's dead
    // `standing` flag is the warning about.
    w: 1.9, d: 2.2,
    build(p) { lCounter(p, 0.95, 1.1); },
  },

  // ...and the same L one size down, for a lobby that cannot hold the other.
  //
  // By the time the furnisher reaches the lobby most of its floor is reserved —
  // the doorway apron and the clear square at each car — and the big L wants
  // nearly 4 x 5 tiles of it. Measured over 60 floors: the big one lands in 30
  // of them and this picks up most of the rest, and the SHAPE is what matters
  // rather than the size. It is the retreat `wallSpanProp` makes for the
  // generator, one prop along: ask for the thing that reads best, take the thing
  // that fits — and here both are the same thing.
  //
  // Its pocket is exactly THREE tile rows deep against the big one's four, and
  // that falls out of `standableCorner` rather than being decided here: three
  // rows leave exactly one row a body's 3x3 fits in, the middle one, so this is
  // the size at which the arithmetic in `lCounter` closes and nothing under it
  // has a pocket anybody can stand in at all.
  receptionCounterSmall: {
    // NOT DESTRUCTIBLE, and that is `beginStatic`'s own opt-out rather than a new
    // one: with no `hp` it files no destructible record, so `resolve` in
    // destruction.js names no prop for a round that lands here and the counter is
    // plain scenery — the same answer a wall gives. `box` and `obstacle` both
    // write through `record?.`, so it still draws and still collides.
    //
    // It earns that by being the fabric of the building rather than furniture: it
    // is drawn in `wall`, the material the shell paints every interior wall with,
    // it is a projection OUT of the plaster it matches, and it is the one thing in
    // the lobby a body is posted behind for the whole floor. A filing cabinet
    // coming apart is the floor being fought over; a reception counter coming
    // apart takes the room's only station with it and leaves the receptionist
    // standing in the open.
    //
    // `substance` goes with the hp rather than being left behind. It is read in
    // exactly one place — the record `beginStatic` no longer files — so keeping it
    // would be a field no code reads, which is the thing the Sentry Unit's dead
    // `standing` flag is the warning about.
    w: 1.5, d: 1.7,
    build(p) { lCounter(p, 0.75, 0.85); },
  },

  // ...and one leg on its own, for the lobbies that have no square patch at all.
  //
  // Third and last: 16 in 60 have nowhere three tiles wide against any wall,
  // and what they do have is a two-tile strip. So this is the L with its along-
  // the-wall leg taken off — the same paint, the same projection out of the
  // plaster, and the body standing BESIDE it (`aside`) rather than in a square
  // it has not got. A lobby with nobody in it is worse than a lobby whose
  // counter is a plain one.
  receptionCounterStub: {
    // NOT DESTRUCTIBLE, and that is `beginStatic`'s own opt-out rather than a new
    // one: with no `hp` it files no destructible record, so `resolve` in
    // destruction.js names no prop for a round that lands here and the counter is
    // plain scenery — the same answer a wall gives. `box` and `obstacle` both
    // write through `record?.`, so it still draws and still collides.
    //
    // It earns that by being the fabric of the building rather than furniture: it
    // is drawn in `wall`, the material the shell paints every interior wall with,
    // it is a projection OUT of the plaster it matches, and it is the one thing in
    // the lobby a body is posted behind for the whole floor. A filing cabinet
    // coming apart is the floor being fought over; a reception counter coming
    // apart takes the room's only station with it and leaves the receptionist
    // standing in the open.
    //
    // `substance` goes with the hp rather than being left behind. It is read in
    // exactly one place — the record `beginStatic` no longer files — so keeping it
    // would be a field no code reads, which is the thing the Sentry Unit's dead
    // `standing` flag is the warning about.
    w: 0.7, d: 1.8,
    build(p) {
      const H = 1.06, TOP = 1.12;
      p.box('wall', -0.31, 0.09, -0.88, 0.31, H, 0.90);
      p.box('wall', -0.24, 0, -0.82, 0.24, 0.09, 0.90);
      p.box('wall', -0.35, H, -0.90, 0.35, TOP, 0.90);
      p.obstacle(-0.35, -0.90, 0.35, 0.90, TOP);
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

      // ...and whether anything is ON it. Half of them are bare, which is what a
      // row of benches in a repair bay looks like: some have a machine open on
      // them and some are waiting for the next one. A row where every bench is
      // mid-job reads as a production line rather than as the place things are
      // brought to be fixed, and the empty tops are also what makes the busy ones
      // legible from the doorway.
      if (rng.chance(0.5)) {
        p.obstacle(-0.99, -0.39, 0.99, 0.39, H);
        return;
      }

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

  // The presentation room's screen: a wall of it, showing something.
  //
  // Not the `tv_screen` model, which measures 1.22 m and is a monitor on a
  // bracket. What this room is arranged around is a screen you can read from the
  // back row, so it is 2.4 m of it — authored, because there is no model that
  // size and because a lit rectangle in a dark bezel is four boxes.
  //
  // The face is `screenOn`, which is unlit (`MeshBasicMaterial`), and that is
  // the whole trick: being immune to the room's lighting is exactly what makes
  // it read as a screen that is ON rather than a dark panel with a light on it.
  // It is the same argument the ceiling panels and the lit menu boards make.
  presentationScreen: {
    w: 2.4, d: 0.22, hp: 45, substance: 'electronic',
    build(p, rng) {
      const Y0 = 0.86, Y1 = 2.24;
      const d = PROPS.presentationScreen.d;
      // Bezel, then the picture inside it, a couple of centimetres proud so the
      // two faces are never coplanar — see the note on windows in gen/shell.js.
      p.box('metalDark', -1.2, Y0, 0.02, 1.2, Y1, 0.11);
      p.box('screenOn', -1.13, Y0 + 0.07, -0.01, 1.13, Y1 - 0.07, 0.03);
      // A dark band across it, which is what stops a 2.4 m rectangle of flat
      // colour reading as a painted wall: something is on the screen.
      const band = Y0 + 0.3 + rng.range(0, 0.5);
      p.box('screen', -1.13, band, -0.02, 1.13, band + 0.16, 0.02);
      // The bracket, and the cable down to the socket.
      p.box('metal', -0.3, Y0 - 0.06, 0.08, 0.3, Y0, 0.16);
      p.box('plastic', 0.2, 0.02, 0.09, 0.26, Y0 - 0.04, 0.13);
      // Only as deep as the bracket: the screen itself is on the wall, and a
      // 0.22 m obstruction along a wall people are sitting in rows in front of
      // is a row of chairs pushed 0.22 m further back for nothing.
      //
      // Its back face is the DECLARED footprint's, not the bracket's. The
      // bracket is bedded 0.05 m into the plaster, which is right for a screen
      // hung on a wall and invisible — but a collider is not allowed to leave
      // the footprint the placer reserved for it, and the catalogue audit says
      // so on every floor (`OBSTACLE OUTSIDE FOOTPRINT` in validate-props.mjs,
      // and 1,860 of these past the 0.15 m wall inset). Nothing about collision
      // moves: the five centimetres given up are inside a wall, so there is
      // nowhere on that side for a body to be. A permanent warning is one
      // nobody reads.
      p.obstacle(-1.2, 0.02, 1.2, d / 2, Y1);
    },
  },

  // The archive's own bench: where paper is dealt with rather than stored.
  //
  // Authored as boxes rather than model-backed, and the small printer on it is
  // authored too, because `desktop` only stamps models onto a prop that IS a
  // model (see tryPlace) — a bench of boxes carrying a GLB is a case the placer
  // does not have. It costs nothing here: a desktop printer is a 24 cm block and
  // a calculator is smaller than a keyboard, and authoring them means the bench
  // comes apart into a bench, a printer and a calculator rather than into three
  // pieces of bench.
  sortingBench: {
    w: 1.6, d: 0.7, hp: 80, substance: 'wood',
    build(p, rng) {
      const H = 0.78;
      p.box('laminate', -0.8, H - 0.05, -0.35, 0.8, H, 0.35);
      for (const sx of [-0.74, 0.74]) {
        p.box('metal', sx - 0.04, 0, -0.32, sx + 0.04, H - 0.05, 0.32);
      }
      p.box('metal', -0.72, 0.22, -0.3, 0.72, 0.27, 0.3);            // lower shelf

      // The small printer. Its own body, its paper tray and the sheet standing
      // out of the back of it, which is the half of a printer anybody notices.
      const px = rng.chance(0.5) ? -0.44 : 0.44;
      p.box('plastic', px - 0.16, H, -0.13, px + 0.16, H + 0.19, 0.13);
      p.box('metalDark', px - 0.14, H + 0.19, -0.11, px + 0.14, H + 0.21, 0.06);
      p.box('paper', px - 0.1, H + 0.21, 0.0, px + 0.1, H + 0.22, 0.16);

      // The calculator, on the other half of the top: a wedge with a keypad and
      // a lit display. `screenOn` is the only unlit material in the catalogue
      // that reads as a number showing at this size.
      const cx = -px * 0.62;
      p.box('plastic', cx - 0.07, H, -0.11, cx + 0.07, H + 0.02, 0.11);
      p.box('plastic', cx - 0.07, H + 0.02, 0.0, cx + 0.07, H + 0.05, 0.11);
      p.box('screenOn', cx - 0.05, H + 0.05, 0.02, cx + 0.05, H + 0.055, 0.09);

      // Paperwork: a tray of it, and a couple of loose stacks.
      p.box('metalDark', -0.18, H, -0.32, 0.18, H + 0.03, -0.06);
      p.box('paper', -0.16, H + 0.03, -0.3, 0.16, H + 0.09, -0.08);
      if (rng.chance(0.7)) p.box('paper', 0.2, H, 0.14, 0.44, H + 0.06, 0.32);
      if (rng.chance(0.5)) p.box('paper', -0.62, 0.27, -0.24, -0.3, 0.34, 0.24);
      p.obstacle(-0.8, -0.35, 0.8, 0.35, H);
    },
  },

  // Where a machine goes on its break.
  //
  // The breakroom is the one room in the building that is about NOT working, and
  // half the roster does not eat (see `_lunchOk` in enemies.js, which has always
  // kept a chassis out of the canteen). A dock is what the same room offers them
  // instead: somewhere to stand still with something visibly happening, which is
  // the whole of what a break looks like from the outside.
  //
  // It is deliberately not a seat. A machine parked at a wall with its lamps
  // cycling reads as charging; a machine sitting on a sofa reads as a bug.
  charger: {
    w: 0.9, d: 0.42, hp: 60, substance: 'metal',
    build(p, rng) {
      // The back panel, up the wall, with the status readout on it at the height
      // a standing body's chest is — so a docked machine's own readout and the
      // dock's line up, which is most of what makes the pair read as connected.
      p.box('metalDark', -0.45, 0, 0.1, 0.45, 1.55, 0.21);
      p.box('metal', -0.4, 0.05, 0.04, 0.4, 1.5, 0.1);
      p.box('screen', -0.3, 1.02, 0.02, 0.3, 1.28, 0.045);
      for (let i = 0; i < 5; i++) {
        if (!rng.chance(0.75)) continue;
        const y = 1.06 + i * 0.045;
        p.box('screenOn', -0.26, y, 0.0, -0.26 + rng.range(0.1, 0.5), y + 0.022, 0.03);
      }
      // The plate it stands on, and the two contacts. Low enough to walk over —
      // it carries no obstacle of its own above the plate, so a machine standing
      // on it is standing on the floor as far as everything else is concerned.
      p.box('hazard', -0.42, 0, -0.2, 0.42, 0.045, 0.11);
      p.box('metalDark', -0.28, 0.045, -0.12, -0.16, 0.13, 0.02);
      p.box('metalDark', 0.16, 0.045, -0.12, 0.28, 0.13, 0.02);
      // Cable up the back.
      p.box('plastic', 0.3, 0.13, 0.06, 0.36, 1.02, 0.11);
      p.obstacle(-0.45, 0.02, 0.45, 0.21, 1.55);
    },
  },

  // The generator room's own centrepiece (see the `generator` role in
  // gen/rooms.js) — one per floor at most, and the only prop on the floor
  // that does anything when it dies: `powerCore` is read by destruction.js,
  // which fans the kill out into a floor-wide blackout (see game.js's
  // `_onPowerCut`). Its footprint is close to MAX_PROP_SIDE and its HP is
  // far above anything else on the floor, on purpose — it is the room's
  // reason to exist, not furniture to clear on the way past.
  //
  // The collidable housing is kept under 2.2 m so its one `obstacle()` box
  // clears MAX_PROP_TOP; the exhaust stack above that is real geometry with
  // no collider of its own, reaching up into the generator room's own
  // double-height shaft (nobody can climb the housing to reach it anyway).
  generator: {
    // Backed against a wall like everything else load-bearing in a room (see
    // edgeProp in gen/placement.js) rather than standing free in the middle, so
    // its control face is authored on -Z — this file's own "front" convention
    // — with the wall-facing +Z side left plain. Genuinely massive on purpose
    // — it's meant to dominate the wall it's on, which is now two ordinary
    // storeys tall (see generatorWallMask in gen/shell.js) — so its collider
    // is well past MAX_PROP_SIDE/MAX_PROP_TOP and carries `building: true` to
    // be judged as shell rather than furniture, the same as a wall or a
    // staircase (see `obstacle`'s `building` param).
    //
    // `spanning`: it is built to the width it is ASKED for and runs wall to
    // wall (see wallSpanProp in gen/placement.js). A plant room's generator that
    // stops two metres short of the corner reads as a big cabinet somebody put
    // there; one that reaches both side walls reads as the reason the room
    // exists. `w` stays as the fallback for the rare floor where the full span
    // will not place, and as the size everything that does not ask measures.
    spanning: true,
    // 3.0 deep, not the 2.4 the housing alone measures: the pipework and the
    // service gantry stand a third of a metre proud of its front, and a prop
    // whose declared footprint stops short of its own geometry is a prop you
    // can put your shoulder through (10.geo-fit in tools/validate-props.mjs).
    w: 5.2, d: 3.0, hp: 500, substance: 'electronic', powerCore: true,
    build(p, rng, w = 5.2) {
      const H = 4.2;
      const hw = w / 2;
      // Everything below is authored in the machine's own frame, where 0 is the
      // middle of the housing — then shifted back by BACK so the whole thing,
      // pipework included, sits centred in the 3.0 m footprint above with its
      // plinth against the wall. Authoring the offset into 30 z coordinates by
      // hand is how one of them ends up 0.2 m out from the rest.
      const BACK = 0.2;
      const box = (key, x0, y0, z0, x1, y1, z1) =>
        p.box(key, x0, y0, z0 + BACK, x1, y1, z1 + BACK);
      // ALL of it stays standing when the machine is destroyed — the pipework,
      // the tanks, the gantry, the stacks and the dead control face along with
      // the plating they are bolted to — because a room whose whole reason to
      // exist vanishes when you shoot it reads as a prop despawning rather than
      // as a machine that blew up, and a machine that keeps its casing while
      // every fitting on it disappears reads as a plainer machine swapped in
      // for the one that was there. What should be missing is what the blast
      // took, and nothing else. See `hulkSpans` in gen/sink.js and `_wreck` in
      // destruction.js.
      //
      // Two grades, and the difference is NOT whether a box survives — both do.
      // `weld` is the machine's own MASS: plinth, housing, ribs, hazard band,
      // tank bodies. That is the extent `_wreck` sites its damage against, so
      // it has to be the machine rather than the machine plus its aerials: an
      // exhaust stack standing 1.7 m clear of the housing would otherwise drag
      // the corner blast up into the air above it, and "an upper corner blown
      // clean off" would come out as a missing stack tip. Everything drawn
      // through plain `box` is trim — carved by the same blasts and burnt with
      // the rest, but silent about where the machine's corners are.
      //
      // `?.` because a sink is allowed to be minimal: the catalogue audit in
      // tools/validate-props.mjs builds a placer of `box` and `obstacle` alone,
      // and a machine that cannot record a wreck should still draw itself.
      p.hulk?.('trim');
      const weld = (key, x0, y0, z0, x1, y1, z1) => {
        p.hulk?.(true);
        box(key, x0, y0, z0, x1, y1, z1);
        p.hulk?.('trim');
      };
      // Everything below is authored as a fraction of the half-width or as a
      // fixed metre offset from an end, never as a hard-coded x — that is what
      // lets one machine be 7 m on one floor and 15 m on the next without
      // stretching its details into a different machine.
      const inset = (m) => Math.max(0, hw - m);

      weld('metal', -hw, 0, -1.2, hw, 0.15, 1.2);                     // base plinth
      weld('metalDark', -inset(0.1), 0.15, -1.0, inset(0.1), H, 1.0); // main housing
      box('metal', -inset(0.2), H, -0.9, inset(0.2), H + 0.2, 0.9);   // top cap

      // Vertical ribs down the front and back faces, one every ~0.75 m so the
      // rhythm is the same on any width.
      const ribs = Math.max(4, Math.round(w / 0.75));
      for (let i = 0; i <= ribs; i++) {
        const sx = -inset(0.3) + (i / ribs) * 2 * inset(0.3);
        weld('metal', sx - 0.08, 0.15, -1.02, sx + 0.08, H, -0.9);
        weld('metal', sx - 0.08, 0.15, 0.9, sx + 0.08, H, 1.02);
      }

      // Hazard band round the base, and a tall control face with rows of live
      // LEDs — both on the front (-Z), so they read from wherever the wall
      // put it. The control face stays 1.8 m wide whatever the machine does:
      // it is a thing a person stands at, and a person is one size.
      weld('hazard', -inset(0.09), 0.7, -1.01, inset(0.09), 0.92, 1.01);
      box('metalDark', -0.9, 0.9, -1.06, 0.9, 3.4, -1.0);
      for (let row = 0; row < 8; row++) {
        const y = 1.1 + row * 0.28;
        box(rng.chance(0.7) ? 'led' : 'screen', -0.8, y, -1.08, 0.8, y + 0.1, -1.06);
      }

      // --- the things bolted to it -------------------------------------------
      // A machine this size is never just the box: it is the box plus the
      // pipework, the tanks it is fed from and the gantry somebody services it
      // off. Drawn as part of the prop rather than as neighbouring furniture so
      // that shooting the generator takes the lot with it.

      // Coolant tanks standing at each end, capped and strapped.
      for (const sx of [-inset(0.85), inset(0.85)]) {
        weld('metal', sx - 0.62, 0.15, -1.05, sx + 0.62, 2.5, 0.2);
        box('metalDark', sx - 0.66, 2.5, -1.09, sx + 0.66, 2.66, 0.24);
        box('hazard', sx - 0.64, 1.5, -1.07, sx + 0.64, 1.68, 0.22);
      }

      // The main pipe run: a header along the full width at head height, with
      // droppers into the housing every couple of metres.
      box('metal', -inset(0.05), 2.85, -1.34, inset(0.05), 3.15, -1.04);
      const drops = Math.max(2, Math.round(w / 2.2));
      for (let i = 0; i < drops; i++) {
        const sx = -inset(1.2) + (i + 0.5) * (2 * inset(1.2)) / drops;
        box('metal', sx - 0.11, 1.05, -1.3, sx + 0.11, 2.85, -1.08);
        // A valve wheel on every other dropper, and a gauge on the rest.
        if (i % 2 === 0) {
          box('metalDark', sx - 0.26, 2.0, -1.38, sx + 0.26, 2.06, -1.24);
          box('metalDark', sx - 0.04, 1.86, -1.38, sx + 0.04, 2.2, -1.24);
        } else {
          box('metal', sx - 0.14, 1.95, -1.4, sx + 0.14, 2.23, -1.28);
          box(rng.chance(0.5) ? 'led' : 'screen', sx - 0.1, 1.99, -1.42, sx + 0.1, 2.19, -1.4);
        }
      }

      // The service gantry: a grated walk along the front at half height with
      // its own handrail, reached from nowhere — plant rooms are full of them.
      box('metalDark', -inset(0.3), 2.62, -1.5, inset(0.3), 2.7, -1.16);
      for (let i = 0; i <= Math.max(2, Math.round(w / 1.6)); i++) {
        const sx = -inset(0.3) + (i / Math.max(2, Math.round(w / 1.6))) * 2 * inset(0.3);
        box('metal', sx - 0.03, 2.7, -1.48, sx + 0.03, 3.6, -1.42);
      }
      box('metal', -inset(0.3), 3.54, -1.5, inset(0.3), 3.6, -1.42);

      // Cable tray leaving the top and running back into the wall.
      box('metalDark', -inset(1.6), H + 0.2, 0.55, inset(1.6), H + 0.34, 0.95);

      // Twin exhaust stacks: decorative only, reaching well up into the
      // room's own double-height shaft — see generatorRoomCut in gen/shell.js.
      // Spaced off the ends rather than at a fixed ±1.3, so a wide machine
      // gets them out over its own shoulders instead of huddled in the middle.
      for (const sx of [-inset(w * 0.28), inset(w * 0.28)]) {
        box('metalDark', sx - 0.4, H + 0.2, -0.4, sx + 0.4, H + 1.5, 0.4);
        box('metal', sx - 0.5, H + 1.5, -0.5, sx + 0.5, H + 1.7, 0.5);
      }

      p.hulk?.(false);
      p.obstacle(-hw, -1.5, hw, 1.5, H + 0.2, true);
    },
  },

  // How a cow got into an office block is not this file's problem. Purely
  // decorative, and shot-proof rather than destructible — it's a fixture of
  // the floor it turns up on, not furniture (see enemies.js for how rarely,
  // and how randomly, that is).
  cow: {
    w: 0.6, d: 2.3, model: 'cow', hp: 0,
    build(p) {
      p.box('plastic', -0.27, 0, -1.1, 0.27, 1.15, 1.1);
      p.obstacle(-0.27, -1.1, 0.27, 1.1, 1.15);
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
export function footprintOf(sink, kind, rot = 0, span = 0) {
  const spec = PROPS[kind];
  const model = spec.model ? sink.modelInfo?.(spec.model) : null;
  // A `spanning` prop is built to whatever width it is asked for rather than to
  // a catalogue number, because what it is for is filling a wall — and a wall's
  // length is a property of the room, which this file has never known. Only the
  // width moves: the depth is still how far the thing sticks out, and that is
  // the prop's own business.
  const w = span && spec.spanning ? span : model ? model.foot[0] : spec.w;
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
export function tryPlace(sink, kind, cx, cz, rot, rng, span = 0) {
  const spec = PROPS[kind];

  // A prop with a downloaded model uses THAT model's measured footprint, not
  // the hand-authored one, so collision always matches what you can see. If the
  // model is missing the prop falls back to its boxes and its own footprint.
  // `footprintOf` is that rule, shared with the furnisher so both ends of a
  // placement agree on how much floor is about to disappear.
  const model = spec.model ? sink.modelInfo(spec.model) : null;
  const foot = footprintOf(sink, kind, rot, span);
  const w = foot.w / 2;
  const d = foot.d / 2;
  // Handed to every `build` as its third argument. Only a `spanning` prop reads
  // it; for the other thirty it is one ignored parameter, which is cheaper than
  // a second placement path that would then have to be kept in step with this
  // one — the debris capture, the desktop stamps and the occupancy all have to
  // happen the same way whatever the prop's width came from.
  const drawW = span && spec.spanning ? span : spec.w;

  if (!sink.canPlace(cx - w, cz - d, cx + w, cz + d)) return false;

  if (spec.mass) {
    // Loose: its own rigid body, and its own mesh so physics can move it.
    // `model` and `washer` join the two traits that were already here. This is
    // the trap `hulk` documents further down: a prop only ever sees the placer,
    // and a trait that is not forwarded is silently absent rather than an error.
    sink.beginDynamic(spec.mass, spec.hp, spec.substance,
      { crushable: spec.crushable, spills: spec.spills,
        model: spec.model, washer: spec.washer, rot });
    spec.build(placer(sink, cx, cz, rot), rng, drawW);
    sink.endDynamic();
  } else if (model) {
    // The debris has to be worked out before the model is stamped, so the
    // capture pass doesn't swallow the model's geometry along with it.
    const debris = sink.captureBoxes(() => spec.build(placer(sink, cx, cz, rot), rng, drawW));

    // The quarter turns rotate the front from -Z toward +X, which is a negative
    // rotation about Y in Three's right-handed frame.
    const yaw = -rot * Math.PI / 2;
    // Every model drawn for this prop, so the debris can be painted in their
    // colours rather than the palette the fallback boxes were authored in.
    const stamps = [{ key: spec.model, x: cx, y: 0, z: cz, yaw }];

    sink.beginStatic(spec.hp, spec.substance, spec.volatile, spec.powerCore, spec.spills);
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
    sink.beginStatic(spec.hp, spec.substance, spec.volatile, spec.powerCore, spec.spills);
    spec.build(placer(sink, cx, cz, rot), rng, drawW);
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
