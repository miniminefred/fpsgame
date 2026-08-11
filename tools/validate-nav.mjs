// Headless QA harness for MULTI-LEVEL NAVIGATION.
//
//   node tools/validate-nav.mjs                    # full sweep + summary
//   node tools/validate-nav.mjs --seeds 40         # random seeds per floor (default 10)
//   node tools/validate-nav.mjs --floors 15        # floors 1..N (default 15)
//   node tools/validate-nav.mjs --trace            # stack traces for crashes
//
// The other two validators prove the floorplan and the furniture. This one proves
// the thing that was added last and is the easiest to get quietly wrong: the nav
// grid has two layers now, the ground floor and every attic and basement, joined at
// the stairwells (see the note at the top of src/nav.js). Every invariant here is
// about that join.
//
// It does not test pathing on one level, which has worked since the beginning and
// is exercised by every other sweep. It tests that a route between levels EXISTS,
// that a body walking downhill on the field actually arrives, and that its height
// while doing so is a staircase rather than a lift.
//
// The walker below is deliberately the same loop enemies.js runs — descend, step,
// read the layer back off the step — because a field that says a route exists and a
// mover that cannot walk it is the failure mode this whole file is for.
//
// Two severities:
//   FAIL — a hard invariant (a level nobody can reach, a body that teleports).
//   WARN — it works but the quality is off.

const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 };
    return () => {
      if (String(prop).startsWith('create')) return { addColorStop() {} };
      if (String(prop) === 'getImageData') return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
      return undefined;
    };
  },
  set: () => true,
});
globalThis.document = {
  createElement: () => {
    const c = { width: 0, height: 0, style: {}, nodeType: 1 };
    c.getContext = () => noopCtx();
    c.toDataURL = () => 'data:,';
    c.addEventListener = () => {};
    return c;
  },
  createElementNS: () => ({}),
};
globalThis.self = globalThis.self ?? globalThis;

const { generateLayout } = await import('../src/gen/layout.js');
const { buildLevel } = await import('../src/gen/build.js');
const { NavGrid, BODY_RADIUS } = await import('../src/nav.js');
const { RISER, TREADS, MAX_TILE_RISE, levelY, stripTiles, approachRect } =
  await import('../src/gen/stairs.js');

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const SEEDS_PER_FLOOR = Number(argVal('--seeds', 10));
const FLOORS = Number(argVal('--floors', 15));
const MAX_EXAMPLES = 6;

// How many steps a walker gets before we call it stuck. A floor is at most 300
// tiles across and a step is a fraction of a tile, so this is generous by design:
// the check is "does it arrive", not "does it arrive briskly".
const MAX_STEPS = 4000;
const STEP = BODY_RADIUS * 0.5;      // metres per simulated step
const ARRIVE = 1.2;                  // close enough to have got there
// The most the ground under a body may move in one step. Nav's own rule is
// MAX_TILE_RISE between two tile CENTRES, but a body samples the flight where it
// actually stands, so a step across the boundary between a flight and a floor can be
// half a tile of ramp worse than the rule that allowed it. Half a tile is the whole
// of the slack, hence 1.5x — anything beyond that is not a stumble, it is a lift.
const MAX_STEP_RISE = MAX_TILE_RISE * 1.5;

class Check {
  constructor(sev, title) {
    this.sev = sev; this.title = title;
    this.runs = 0; this.fails = 0; this.examples = []; this.notes = new Map();
  }
  run() { this.runs++; }
  fail(id, note) {
    this.fails++;
    if (this.examples.length < MAX_EXAMPLES) this.examples.push(id);
    if (note) this.notes.set(note, (this.notes.get(note) || 0) + 1);
  }
}

const checks = new Map();
const check = (id) => checks.get(id);
const IDS = [
  ['0.crash', 'FAIL', 'CRASH         building a floor or its nav grid threw'],
  ['1.layer', 'FAIL', 'LEVELS        every level has walkable floor of its own'],
  ['1.cross', 'FAIL', 'LEVELS        a stairwell is walkable on BOTH layers'],
  ['1.only-well', 'FAIL', 'LEVELS        the layers are joined inside a stairwell and nowhere else'],
  ['2.reach-up', 'FAIL', 'ROUTE         a body on the ground floor has a route onto every level'],
  ['2.reach-down', 'FAIL', 'ROUTE         a body on a level has a route back to the ground floor'],
  ['2.walk-up', 'FAIL', 'WALKER        walking downhill on the field actually arrives on the level'],
  ['2.walk-down', 'FAIL', 'WALKER        ...and back down again'],
  ['3.climb', 'FAIL', 'HEIGHT        a walker never changes height faster than a flight does'],
  ['3.ramp', 'FAIL', 'HEIGHT        the flight runs from the floor to the level, all the way'],
  ['4.sight-slab', 'FAIL', 'SIGHT         nobody sees through a floor slab'],
  ['4.sight-well', 'FAIL', 'SIGHT         ...but two bodies in one stairwell see each other'],
  ['5.detour', 'WARN', 'ROUTE         the climb is at most 3x the straight-line distance'],
  ['5.share', 'WARN', 'LEVELS        at least half a level is reachable from its landing'],
  ['5.door', 'WARN', 'ROUTE         the foot of a flight is reachable from a doorway'],
];
for (const [id, sev, title] of IDS) checks.set(id, new Check(sev, title));

const scene = { add() {}, remove() {} };
const stats = { levels: 0, walkers: 0, climbSteps: [], detours: [] };

/**
 * Walks a body downhill on the field, exactly the way enemies.js does.
 *
 * Returns where it got to, how many steps it took, and the worst single change in
 * height along the way — which is the number that tells a staircase from a lift.
 */
function walk(nav, from, target) {
  const out = { x: 0, y: 0, z: 0, layer: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
  let x = from.x, z = from.z, layer = from.layer;
  let y = nav.heightAt(x, z, layer);
  let worstRise = 0;
  let steps = 0;

  for (; steps < MAX_STEPS; steps++) {
    if (Math.hypot(x - target.x, z - target.z) < ARRIVE && layer === target.layer) break;
    const dir = nav.descend(x, z, out, layer);
    if (!dir) break;
    layer = dir.layer ?? layer;
    const len = Math.hypot(dir.x, dir.z);
    if (len > 1e-6) {
      const nx = x + (dir.x / len) * STEP;
      const nz = z + (dir.z / len) * STEP;
      if (nav.clear(nx, nz, BODY_RADIUS, layer)) { x = nx; z = nz; }
    }
    const ny = nav.heightAt(x, z, layer);
    worstRise = Math.max(worstRise, Math.abs(ny - y));
    y = ny;
  }
  return { x, z, y, layer, steps, worstRise, arrived: Math.hypot(x - target.x, z - target.z) < ARRIVE && layer === target.layer };
}

// A tile on `layer` where a whole body fits, nearest a world point.
function nearestFit(nav, x, z, layer, accept = () => true) {
  const cx = nav.tx(x), cy = nav.ty(z);
  for (let r = 0; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!nav.fitsAt(cx + dx, cy + dy, nav.fits, layer)) continue;
        if (!accept(cx + dx, cy + dy)) continue;
        return { x: nav.wx(cx + dx), z: nav.wz(cy + dy), layer };
      }
    }
  }
  return null;
}

// A standable tile just inside one of a room's doorways. Read off the floorplan
// rather than off `room.doors`, which only lists the doors that room cut itself.
function mouthOf(nav, layout, room) {
  const inside = (tx, ty) => tx >= room.x0 && tx < room.x1 && ty >= room.y0 && ty < room.y1;
  for (const d of layout.doors) {
    const cx = Math.floor((d.x0 + d.x1) / 2), cy = Math.floor((d.y0 + d.y1) / 2);
    const probes = d.vertical ? [[d.x0 - 1, cy], [d.x1, cy]] : [[cx, d.y0 - 1], [cx, d.y1]];
    for (const [px, py] of probes) {
      if (!inside(px, py)) continue;
      const spot = nearestFit(nav, nav.wx(px), nav.wz(py), 0);
      if (spot) return spot;
    }
  }
  return null;
}

// A tile on `layer` where a whole body fits, nearest the middle of a rect.
function spotIn(nav, rect, layer) {
  const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
  let best = null, bestD = Infinity;
  for (let ty = rect.y0; ty < rect.y1; ty++) {
    for (let tx = rect.x0; tx < rect.x1; tx++) {
      if (!nav.fitsAt(tx, ty, nav.fits, layer)) continue;
      const d = (tx - cx) ** 2 + (ty - cy) ** 2;
      if (d < bestD) { bestD = d; best = { x: nav.wx(tx), z: nav.wz(ty), layer, tx, ty }; }
    }
  }
  return best;
}

function validate(seed, floorNumber) {
  const id = `s${seed >>> 0}/f${floorNumber}`;
  const layout = generateLayout(seed, floorNumber);
  const built = buildLevel(scene, layout);
  const nav = new NavGrid(built.nav);
  const { W, WH } = nav;

  for (const [cid] of IDS) if (cid !== '0.crash') check(cid).run();

  // ---- 1. the layers themselves -----------------------------------------
  const well = new Uint8Array(WH);
  for (const plan of layout.stairs) for (const i of stripTiles(plan, W)) well[i] = 1;

  // Wherever the layers are joined, both of them have to be standable there — a
  // join one side of which is thin air is a route that does not exist.
  for (let i = 0; i < WH; i++) {
    if (!nav.cross[i]) continue;
    if (!nav.walk[i] || !nav.walk[WH + i]) {
      check('1.cross').fail(id, 'a join is missing from one of the two layers');
      break;
    }
  }
  // ...and a join is only ever inside a stairwell, which is the whole point: it is
  // the one place in the building where a body changes level.
  for (let i = 0; i < WH; i++) {
    if (nav.cross[i] === well[i]) continue;
    check('1.only-well').fail(id, 'the layers are joined somewhere that is not a stairwell');
    break;
  }

  for (const plan of layout.stairs) {
    stats.levels++;
    // Where the flight arrives. A body climbing gets here, so this is what "can you
    // get onto the level" means; how much of the level it can then walk to is a
    // separate, softer question (5.share below) because a crate up there blocking a
    // corner is furniture, not a broken route.
    const shaft = stripTiles(plan, W);
    let head = null, headY = -Infinity;
    for (const i of shaft) {
      const h = Math.abs(nav.heightAt(nav.wx(i % W), nav.wz((i / W) | 0), 1));
      if (h > headY) { headY = h; head = i; }
    }
    // A tile of the level's own FLOOR, not of the shaft: a body in the shaft is on the
    // stairs, and two bodies in one stairwell are allowed to see each other, so
    // testing from there would let the sight checks pass for the wrong reason.
    const onShaft = new Set(shaft);
    const floor = nearestFit(nav, nav.wx(head % W), nav.wz((head / W) | 0), 1,
      (tx, ty) => !onShaft.has(ty * W + tx));
    if (!floor) { check('1.layer').fail(id, `a ${plan.room.role} level has no standable floor`); continue; }

    // ...and on the ground floor, the reserved floor at the foot of the flight. That
    // is what multi-level nav promises: from the bottom of the stairs you can get to
    // the top and back. Whether the ROOM is reachable from the rest of the building is
    // a different question, it is the props validator's, and it is measured below as a
    // warning rather than confused with this one — a room whose doorway no body can
    // pass has a stranded staircase, but the staircase is not what is wrong with it.
    const ar = approachRect(plan);
    const ground = spotIn(nav, { x0: ar.x0, y0: ar.y0, x1: ar.x1, y1: ar.y1 }, 0);
    if (!ground) {
      check('2.reach-up').fail(id, `no standable floor at the foot of a ${plan.room.role} flight`);
      continue;
    }

    // ---- 3. the flight itself -------------------------------------------
    // Every tile of the stairwell has a height, and between them they run from the
    // floor to the level — a flight that stops short is a level with a lip.
    let lo = Infinity, hi = -Infinity;
    for (const i of stripTiles(plan, W)) {
      // Asked the way a body asks: the height of the walking surface at that point.
      const h = nav.heightAt(nav.wx(i % W), nav.wz((i / W) | 0), 0);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const y = levelY(plan);
    const top = plan.dir > 0 ? hi : lo;
    if (Math.abs(top - y) > RISER + 1e-6 || Math.abs(plan.dir > 0 ? lo : hi) > RISER + 1e-6) {
      check('3.ramp').fail(id, `flight spans ${lo.toFixed(2)}..${hi.toFixed(2)} m, level at ${y.toFixed(2)}`);
    }

    // ---- 2. a route in both directions ----------------------------------
    // Flooded from the level: can anybody standing in the room below get up?
    nav.fieldAge = Infinity;
    nav.updateField(1, floor.x, floor.z, 1, false);
    const upDist = nav.pathDistance(ground.x, ground.z, 0);
    if (upDist < 0) {
      check('2.reach-up').fail(id, `no route from the ${plan.room.role} floor up to its level`);
    } else {
      const w = walk(nav, ground, floor);
      stats.walkers++;
      if (!w.arrived) check('2.walk-up').fail(id, `stuck ${Math.hypot(w.x - floor.x, w.z - floor.z).toFixed(1)} m short after ${w.steps} steps`);
      else {
        stats.climbSteps.push(w.steps);
        const straight = Math.hypot(ground.x - floor.x, ground.z - floor.z) + Math.abs(y);
        const walked = w.steps * STEP;
        stats.detours.push(walked / Math.max(1, straight));
        if (walked > straight * 3 + TREADS * 0.3) {
          check('5.detour').fail(id, `${walked.toFixed(0)} m walked for a ${straight.toFixed(0)} m climb`);
        }
      }
      if (w.worstRise > MAX_STEP_RISE + 1e-3) {
        check('3.climb').fail(id, `height jumped ${w.worstRise.toFixed(2)} m in one step`);
      }
    }

    // ...and the other way, which is not the same question: the field is a
    // different flood and the crossing is taken in the other direction.
    nav.fieldAge = Infinity;
    nav.updateField(1, ground.x, ground.z, 0, false);
    if (nav.pathDistance(floor.x, floor.z, 1) < 0) {
      check('2.reach-down').fail(id, `no route from a ${plan.room.role} level back down`);
    } else {
      // Can anybody get to the stairs from the room's own doorway? A warning, because
      // when it fails it is furniture in a room the props sweep already grumbles
      // about, not the staircase.
      const mouth = mouthOf(nav, layout, plan.room);
      if (mouth && nav.pathDistance(mouth.x, mouth.z, 0) < 0) {
        check('5.door').fail(id, `a ${plan.room.role} flight is cut off from its own doorway`);
      }

      // How much of the level a body that got up there can actually walk to.
      let fit = 0, reached = 0;
      for (let ty = plan.room.y0; ty < plan.room.y1; ty++) {
        for (let tx = plan.room.x0; tx < plan.room.x1; tx++) {
          if (!nav.fitsAt(tx, ty, nav.fits, 1)) continue;
          fit++;
          if (nav.pathDistance(nav.wx(tx), nav.wz(ty), 1) >= 0) reached++;
        }
      }
      if (fit && reached / fit < 0.5) {
        check('5.share').fail(id, `${Math.round((100 * reached) / fit)}% of a ${plan.room.role} level reachable`);
      }
      const w = walk(nav, floor, ground);
      stats.walkers++;
      if (!w.arrived) check('2.walk-down').fail(id, `stuck ${Math.hypot(w.x - ground.x, w.z - ground.z).toFixed(1)} m short after ${w.steps} steps`);
      if (w.worstRise > MAX_STEP_RISE + 1e-3) {
        check('3.climb').fail(id, `height jumped ${w.worstRise.toFixed(2)} m in one step coming down`);
      }
    }

    // ---- 4. sight ------------------------------------------------------
    // Across the slab, no. Two bodies in the same stairwell, yes — that is somebody
    // at the foot of a flight looking at somebody at the head of it.
    if (nav.losClear(ground.x, ground.z, floor.x, floor.z, 0, 1)) {
      check('4.sight-slab').fail(id, 'saw through a floor slab');
    }
    const wellTiles = stripTiles(plan, W);
    const a = wellTiles[0], b = wellTiles[wellTiles.length - 1];
    const ax = nav.wx(a % W), az = nav.wz((a / W) | 0);
    const bx = nav.wx(b % W), bz = nav.wz((b / W) | 0);
    if (!nav.losClear(ax, az, bx, bz, 0, 1)) {
      check('4.sight-well').fail(id, 'two bodies in one stairwell could not see each other');
    }
  }
}

let cases = 0;
const t0 = Date.now();
for (let floor = 1; floor <= FLOORS; floor++) {
  for (let s = 1; s <= SEEDS_PER_FLOOR; s++) {
    const seed = ((s * 2654435761) >>> 0) ^ (floor * 40503);
    try {
      validate(seed, floor);
    } catch (e) {
      check('0.crash').fail(`s${seed >>> 0}/f${floor}`, `${e.name}: ${e.message}`);
      if (args.includes('--trace')) console.error(e);
    }
    cases++;
  }
}

const line = '='.repeat(96);
const median = (a) => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 0);
console.log(line);
console.log(`NAV VALIDATOR — ${cases} floors, ${stats.levels} levels, ${stats.walkers} walkers, floors 1..${FLOORS}, ${Date.now() - t0} ms`);
console.log(line);
console.log(`  climb length   median ${median(stats.climbSteps)} steps`);
console.log(`  walked / straight-line   median ${median(stats.detours).toFixed(2)}x`);

let hard = 0, warns = 0;
for (const [, c] of checks) {
  if (!c.runs && !c.fails) continue;
  const ok = c.fails === 0;
  if (!ok) { if (c.sev === 'FAIL') hard++; else warns++; }
  const tag = ok ? 'PASS' : c.sev;
  const pct = c.runs ? ((100 * c.fails) / c.runs).toFixed(1) : '0.0';
  console.log(`${tag}  ${c.title.padEnd(62)} ${String(c.fails).padStart(4)}/${String(c.runs).padEnd(5)} (${pct}%)`);
  for (const [note, n] of c.notes) console.log(`      x ${String(n).padStart(3)}  ${note}`);
  if (c.examples.length) console.log(`      repro: ${c.examples.join('   ')}`);
}
console.log(line);
console.log(hard ? `RESULT: ${hard} HARD FAILURE(S), ${warns} warning(s)` : `RESULT: all hard invariants PASS — ${warns} warning(s)`);
console.log(line);
process.exit(hard ? 1 : 0);
