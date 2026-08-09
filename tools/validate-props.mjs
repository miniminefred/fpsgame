// Headless QA harness for FURNITURE PLACEMENT.
//
//   node tools/validate-props.mjs                  # full sweep + summary (300 floors)
//   node tools/validate-props.mjs --seeds 40       # random seeds per floor (default 14)
//   node tools/validate-props.mjs --small 10       # small human-typeable seeds too (default 6)
//   node tools/validate-props.mjs --floors 15      # floors 1..N (default 15)
//   node tools/validate-props.mjs --dump 7003 7    # ASCII plan + per-room reachability table,
//                                                  # then a 0.125 m zoom of the worst room
//   node tools/validate-props.mjs --dump 7003 7 --room 15    # ... zoom a specific room
//   node tools/validate-props.mjs --catalogue      # prop catalogue audit only
//   node tools/validate-props.mjs --trace          # print stack traces for crashes
//
// Companion to tools/validate-layout.mjs, which proves the EMPTY floorplan is
// sound. This one runs the real buildLevel() and interrogates what furnishing
// did to it: colliders, the nav grid, doorway clearances, room reachability.
//
// buildLevel is pure geometry, but it pulls in textures.js which paints canvas
// textures — so a minimal DOM is stubbed in before the module graph loads.
//
// Two severities:
//   FAIL — a hard invariant the game depends on (unreachable room, prop in a
//          wall, prop across a doorway).
//   WARN — the floor still plays but the furnishing quality is off.

// ---------------------------------------------------------------------------
// DOM stub — must be installed before textures.js is imported.
// ---------------------------------------------------------------------------

const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 };
    return (...a) => {
      // Gradients are the one return value textures.js actually uses.
      if (String(prop).startsWith('create')) {
        return { addColorStop() {}, ...(String(prop) === 'createPattern' ? {} : {}) };
      }
      if (String(prop) === 'getImageData') {
        return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
      }
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

const { generateLayout, TILE, WALL_H, CEIL_H, SOLID, ROOM, CORRIDOR, DOOR, isOpen } =
  await import('../src/gen/layout.js');
const { buildLevel } = await import('../src/gen/build.js');
const { PROPS } = await import('../src/gen/props.js');
const { makeRng } = await import('../src/gen/rng.js');

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};

const SEEDS_PER_FLOOR = Number(argVal('--seeds', 14));
const SMALL_SEEDS = Number(argVal('--small', 6));
const FLOORS = Number(argVal('--floors', 15));
const MAX_EXAMPLES = 6;

// Tolerances. TILE is 0.5 m, so anything below a centimetre is float noise or a
// deliberate hairline; anything above it is a modelling mistake you can see.
const EPS = 1e-6;
const HAIRLINE = 0.01;     // 1 cm — the "small epsilon" for overlap tests
const REACH_SHARE = 0.25;  // a room must expose at least this share of itself
const GEOM_SOFT = 0.75;    // ... and losing a quarter of it to furniture is bad
const CLEAR_R = 1.5;       // metres of clearance owed to spawn and exit
const MAX_PROP_SIDE = 4.0;
const MAX_PROP_TOP = 2.4;
const MIN_PROP_TOP = 0.05;

// Geometric reachability. The nav grid is tile-granular; the *colliders* are
// not, so "can a body get there" has to be answered on a finer grid or the tool
// cannot tell an inflated nav stamp from a genuinely blocked gap.
//
// The model is exactly player.js's: every collider is an AABB inflated by the
// player's collision RADIUS, and a position is legal when it is outside all of
// them. That makes this the same question the game asks every frame.
const SUB = 4;                 // cells per tile => 0.125 m cells
const BODY_R = 0.4;            // must match RADIUS in src/player.js
const ENEMY_R = 0.36;          // RADIUS in src/enemies.js, for reference

// ---------------------------------------------------------------------------
// check bookkeeping (same shape as validate-layout.mjs)
// ---------------------------------------------------------------------------

class Check {
  constructor(id, sev, title) {
    this.id = id; this.sev = sev; this.title = title;
    this.runs = 0; this.fails = 0; this.examples = []; this.notes = new Map();
  }
  run() { this.runs++; }
  fail(caseId, note) {
    this.fails++;
    if (this.examples.length < MAX_EXAMPLES) this.examples.push(caseId);
    if (note) this.notes.set(note, (this.notes.get(note) || 0) + 1);
  }
}

const checks = new Map();
const check = (id) => checks.get(id);

const IDS = [
  ['0.crash', 'FAIL', 'CRASH         buildLevel threw'],

  ['1.in-wall', 'FAIL', 'IN WALL       no furniture collider overlaps a SOLID tile (>1 cm)'],
  ['1.in-wall-hair', 'WARN', 'IN WALL       ... not even by a hairline (>0 m)'],

  ['2.overlap', 'FAIL', 'OVERLAP       no two furniture colliders overlap in plan (>1 cm)'],
  ['2.overlap-hair', 'WARN', 'OVERLAP       ... not even by a hairline (>0 m)'],
  ['2.dyn-overlap', 'FAIL', 'OVERLAP       no two dynamic props start intersecting'],
  ['2.dyn-static', 'FAIL', 'OVERLAP       no dynamic prop starts inside a static collider'],

  ['3.door-tile', 'FAIL', 'DOORWAY       no furniture collider on a DOOR tile'],
  ['3.door-swing', 'FAIL', 'DOORWAY       no furniture inside the reserveClearances swing zone'],
  ['3.door-mouth', 'FAIL', 'DOORWAY       tile just inside each doorway is walkable'],

  ['4.room-dead', 'FAIL', 'ROOM REACH    every room has walkable floor reachable from its door'],
  ['4.room-share', 'FAIL', `ROOM REACH    >= ${REACH_SHARE * 100}% of a room interior reachable from its door`],
  ['4.room-pocket', 'WARN', 'ROOM REACH    a room has no walkable-but-unreachable pockets'],
  ['4.geom-dead', 'FAIL', 'ROOM REACH    (geometric) a body can reach floor inside every room'],
  ['4.geom-share', 'FAIL', `ROOM REACH    (geometric) >= ${REACH_SHARE * 100}% of the passable floor of a room reachable`],
  ['4.geom-soft', 'WARN', `ROOM REACH    (geometric) >= ${GEOM_SOFT * 100}% of the passable floor of a room reachable`],
  ['4.nav-inflation', 'WARN', 'ROOM REACH    nav grid does not seal a gap a body can physically pass'],

  ['5.connected', 'FAIL', 'CONNECTIVITY  every unbadged room reachable from spawn AFTER furnishing'],
  ['5.lock-sealed', 'FAIL', 'KEYCARDS      every badged room sealed from the nav grid'],
  ['5.walk-orphan', 'WARN', 'CONNECTIVITY  no walkable tile stranded from spawn by furniture'],
  ['5.spawn-walk', 'FAIL', 'CONNECTIVITY  spawn tile itself is walkable'],
  ['5.geom-connected', 'FAIL', 'CONNECTIVITY  (geometric) every room physically reachable from spawn'],

  ['6.spawn-clear', 'FAIL', `SPAWN/EXIT    no furniture within ${CLEAR_R} m of spawn`],
  ['6.exit-clear', 'FAIL', `SPAWN/EXIT    no furniture within ${CLEAR_R} m of exit`],

  ['7.extent', 'FAIL', 'DIMENSIONS    every furniture collider has positive extent'],
  ['7.nan', 'FAIL', 'DIMENSIONS    no NaN / non-finite collider bound'],
  ['7.side', 'FAIL', `DIMENSIONS    footprint under ${MAX_PROP_SIDE} m per side`],
  ['7.top', 'FAIL', `DIMENSIONS    top between ${MIN_PROP_TOP} and ${MAX_PROP_TOP} m`],

  ['8.dyn-nan', 'FAIL', 'DYNAMICS      finite position and size'],
  ['8.dyn-extent', 'FAIL', 'DYNAMICS      positive size on every axis'],
  ['8.dyn-floor', 'FAIL', 'DYNAMICS      base sits at or above y = 0'],
  ['8.dyn-wall', 'FAIL', 'DYNAMICS      does not start intersecting a SOLID tile'],

  ['9.own-room', 'FAIL', 'ROOM BOUNDS   no furniture collider spans two rooms'],
  ['9.escaped', 'FAIL', 'ROOM BOUNDS   no room prop escaped into a corridor / doorway'],
  ['9.inset', 'WARN', 'ROOM BOUNDS   room props stay inside the 0.15 m wall inset'],

  ['10.nav-lie', 'WARN', 'NAV GRID      no walkable tile is buried inside a static collider'],
  ['10.edge-standoff', 'WARN', 'EDGE PROPS    counter/vending sit within 0.35 m of a wall'],
  ['10.decl-fit', 'WARN', 'CATALOGUE     obstacle box fits inside the declared w x d footprint'],
  ['10.geo-fit', 'WARN', 'CATALOGUE     visual geometry fits inside the declared w x d footprint'],
];
for (const [id, sev, title] of IDS) checks.set(id, new Check(id, sev, title));

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : String(n));
const lo = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
const hi = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const hist = (m, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `${k}:${v}`).join('  ');

// Plan-view intersection of two AABBs. Returns null when they merely touch.
function planOverlap(a, b, eps = EPS) {
  const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const iz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  if (ix <= eps || iz <= eps) return null;
  return { ix, iz, area: ix * iz, depth: Math.min(ix, iz) };
}

// ---------------------------------------------------------------------------
// prop catalogue audit
//
// Re-runs every PROPS[kind].build() against a recording placer, in the prop's
// own local space. This gives three boxes per kind that ought to nest:
//
//   declared  w x d  ->  what tryPlace() fit-tests and what occupy() stamps
//   obstacle  box    ->  what actually becomes a collider / nav blocker
//   geometry  bounds ->  what the player sees
//
// Any kind whose obstacle or geometry pokes outside the declared footprint can
// intersect a wall or a neighbouring prop no matter how correct the placement
// logic is, because the fit test never knew about the overhang.
// ---------------------------------------------------------------------------

const CAT = new Map();

function buildCatalogue() {
  const rng = makeRng(0xC0FFEE);
  for (const [kind, spec] of Object.entries(PROPS)) {
    const e = {
      kind, w: spec.w, d: spec.d, mass: spec.mass || 0,
      obs: { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, top: -Infinity, topMin: Infinity },
      geo: { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity },
      sigs: new Map(),   // "wxd@top" -> hits, for reverse lookup from a collider
    };
    for (let t = 0; t < 600; t++) {
      let obs = null;
      const g = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity };
      const p = {
        box(_k, x0, y0, z0, x1, y1, z1) {
          g.x0 = Math.min(g.x0, x0); g.x1 = Math.max(g.x1, x1);
          g.y0 = Math.min(g.y0, y0); g.y1 = Math.max(g.y1, y1);
          g.z0 = Math.min(g.z0, z0); g.z1 = Math.max(g.z1, z1);
        },
        obstacle(x0, z0, x1, z1, top) { obs = { x0, z0, x1, z1, top }; },
      };
      spec.build(p, rng);
      // Anything a model-backed prop draws on top of its model is real geometry
      // in the world and owes the footprint the same nesting as `build` does.
      spec.dress?.(p, rng);

      e.geo.x0 = Math.min(e.geo.x0, g.x0); e.geo.x1 = Math.max(e.geo.x1, g.x1);
      e.geo.y0 = Math.min(e.geo.y0, g.y0); e.geo.y1 = Math.max(e.geo.y1, g.y1);
      e.geo.z0 = Math.min(e.geo.z0, g.z0); e.geo.z1 = Math.max(e.geo.z1, g.z1);

      if (obs) {
        e.obs.x0 = Math.min(e.obs.x0, obs.x0); e.obs.x1 = Math.max(e.obs.x1, obs.x1);
        e.obs.z0 = Math.min(e.obs.z0, obs.z0); e.obs.z1 = Math.max(e.obs.z1, obs.z1);
        e.obs.top = Math.max(e.obs.top, obs.top);
        e.obs.topMin = Math.min(e.obs.topMin, obs.top);
        const w = obs.x1 - obs.x0, d = obs.z1 - obs.z0;
        bump(e.sigs, sigKey(w, d, obs.top));
      }
    }
    CAT.set(kind, e);
  }
}

const sigKey = (w, d, top) =>
  `${Math.min(w, d).toFixed(3)}x${Math.max(w, d).toFixed(3)}@${top.toFixed(3)}`;

// Reverse map from a live collider back to a prop kind. Signatures that two
// kinds share get a joined label rather than a wrong guess.
const SIG_TO_KIND = new Map();
function buildSigIndex() {
  for (const e of CAT.values()) {
    for (const k of e.sigs.keys()) {
      const prev = SIG_TO_KIND.get(k);
      SIG_TO_KIND.set(k, prev && prev !== e.kind ? `${prev}|${e.kind}` : e.kind);
    }
  }
}

function kindOf(c) {
  const w = c.maxX - c.minX, d = c.maxZ - c.minZ;
  return SIG_TO_KIND.get(sigKey(w, d, c.top))
    ?? `?${Math.min(w, d).toFixed(2)}x${Math.max(w, d).toFixed(2)}@${c.top.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// aggregate stats
// ---------------------------------------------------------------------------

const stats = {
  propsPerFloor: [], staticPerFloor: [], dynPerFloor: [], wallColliders: [],
  perRoomByRole: new Map(),           // role -> counts[]
  roleReachShare: new Map(),          // role -> shares[]
  roomWalkBefore: [], roomWalkAfter: [], roomReach: [],
  footprintHist: new Map(),           // "kind" -> n
  areaHist: new Map(),                // area bucket -> n
  kindCollisions: new Map(),          // "kindA+kindB" -> n
  kindInWall: new Map(),
  worstWallDepth: 0, worstWallCase: '',
  worstOverlapArea: 0, worstOverlapCase: '', worstOverlapDepth: 0,
  worstDoorDepth: 0, worstDoorCase: '',
  worstSpawnDist: Infinity, worstExitDist: Infinity,
  deadRooms: 0, lowRooms: 0, totalRooms: 0, roomsByRole: new Map(),
  navLies: 0, navLieTiles: 0, navLieByKind: new Map(),
  insetByKind: new Map(),
  wallGapByKind: new Map(),           // kind -> gaps[] to nearest wall
  unknownSigs: new Map(),
  strandedTiles: [], biggestStrand: 0, biggestStrandCase: '',
  biggestPocket: 0, biggestPocketCase: '',
  reachOfWalkable: [],                // reached / walkable, per room
  worstRooms: [],                     // {share, id, role, interior, walkable, reached}
  geomShare: [], geomDeadRooms: 0, geomLowRooms: 0, geomSoftRooms: 0, geomWorst: [], navInflated: 0,
  edgeStandoff: new Map(),            // kind -> gaps for edgeProp-only kinds
};

// Kinds placed ONLY by edgeProp(), so their standoff from the wall is a direct
// measurement of edgeProp's offset maths.
const EDGE_ONLY = new Set(['counter', 'vending']);
const EDGE_TOL = 0.35;

// ---------------------------------------------------------------------------
// per-floor validation
// ---------------------------------------------------------------------------

const scene = { add() {}, remove() {} };

function validate(seed, floorNumber) {
  const id = `s${seed}/f${floorNumber}`;
  const layout = generateLayout(seed, floorNumber);
  const level = buildLevel(scene, layout);

  const { W, H, tiles, ox, oz, rooms, doors } = layout;
  const { colliders, dynamics, nav } = level;
  const walk = nav.walk;
  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const T = (x, y) => (inb(x, y) ? tiles[idx(x, y)] : SOLID);
  const wx = (tx) => tx * TILE + ox;
  const wz = (ty) => ty * TILE + oz;
  const tX = (x) => Math.floor((x - ox) / TILE);
  const tZ = (z) => Math.floor((z - oz) / TILE);

  for (const [cid] of IDS) if (cid !== '0.crash') check(cid).run();

  // ---- split walls from furniture ----------------------------------------
  const walls = [];
  const furn = [];
  for (const c of colliders) {
    // Sliding doors are neither. They stand in a doorway by design and retract
    // out of it for anybody who walks up, so counting one as furniture fails
    // every doorway invariant, and counting one as wall would have the
    // reachability walk route around a door that opens.
    if (c.door) continue;
    (c.top === WALL_H ? walls : furn).push(c);
  }

  stats.wallColliders.push(walls.length);
  stats.staticPerFloor.push(furn.length);
  stats.dynPerFloor.push(dynamics.length);
  stats.propsPerFloor.push(furn.length + dynamics.length);

  // Tile range an AABB really covers, shrunk by a hairline so a prop that stops
  // exactly on a tile line is not counted as entering the next tile.
  const tileRange = (b, eps = HAIRLINE) => ({
    tx0: Math.max(0, Math.floor((b.minX + eps - ox) / TILE)),
    tx1: Math.min(W - 1, Math.ceil((b.maxX - eps - ox) / TILE) - 1),
    ty0: Math.max(0, Math.floor((b.minZ + eps - oz) / TILE)),
    ty1: Math.min(H - 1, Math.ceil((b.maxZ - eps - oz) / TILE) - 1),
  });

  // ---- 7. sane dimensions ------------------------------------------------
  let badExtent = 0, badNaN = 0, badSide = 0, badTop = 0;
  for (const c of furn) {
    const w = c.maxX - c.minX, d = c.maxZ - c.minZ;
    if (![c.minX, c.maxX, c.minZ, c.maxZ, c.top].every(Number.isFinite)) { badNaN++; continue; }
    if (w <= EPS || d <= EPS || c.top <= EPS) badExtent++;
    if (w > MAX_PROP_SIDE || d > MAX_PROP_SIDE) badSide++;
    if (c.top < MIN_PROP_TOP || c.top > MAX_PROP_TOP) badTop++;

    const kind = kindOf(c);
    bump(stats.footprintHist, kind);
    if (kind.startsWith('?')) bump(stats.unknownSigs, kind);
    bump(stats.areaHist, `${(Math.round(w * d * 4) / 4).toFixed(2)}`);
  }
  if (badNaN) check('7.nan').fail(id, `${badNaN} colliders with non-finite bounds`);
  if (badExtent) check('7.extent').fail(id, `${badExtent} colliders with zero/negative extent`);
  if (badSide) check('7.side').fail(id, `${badSide} colliders wider than ${MAX_PROP_SIDE} m`);
  if (badTop) check('7.top').fail(id, `${badTop} colliders with top outside [${MIN_PROP_TOP},${MAX_PROP_TOP}]`);

  // ---- 1. furniture inside walls -----------------------------------------
  let inWall = 0, inWallHair = 0, worstDepth = 0, worstKind = '';
  for (const c of furn) {
    const r = tileRange(c, EPS);
    let depth = 0;
    for (let ty = r.ty0; ty <= r.ty1; ty++) {
      for (let tx = r.tx0; tx <= r.tx1; tx++) {
        if (T(tx, ty) !== SOLID) continue;
        const o = planOverlap(c, { minX: wx(tx), maxX: wx(tx + 1), minZ: wz(ty), maxZ: wz(ty + 1) });
        if (o) depth = Math.max(depth, o.depth);
      }
    }
    if (depth > EPS) {
      inWallHair++;
      bump(stats.kindInWall, kindOf(c));
      if (depth > HAIRLINE) {
        inWall++;
        if (depth > worstDepth) { worstDepth = depth; worstKind = kindOf(c); }
      }
    }
  }
  if (inWall) {
    check('1.in-wall').fail(id, `${inWall} colliders in walls, worst ${fmt(worstDepth, 3)} m (${worstKind})`);
    if (worstDepth > stats.worstWallDepth) { stats.worstWallDepth = worstDepth; stats.worstWallCase = `${id} ${worstKind}`; }
  }
  if (inWallHair) check('1.in-wall-hair').fail(id, `${inWallHair} colliders touching wall tiles`);

  // ---- 2. furniture vs furniture ----------------------------------------
  // Uniform grid so this stays linear in prop count.
  const CELL = 1.0;
  const grid = new Map();
  const cellKey = (cx, cz) => cx * 100003 + cz;
  furn.forEach((c, i) => {
    for (let cz = Math.floor(c.minZ / CELL); cz <= Math.floor(c.maxZ / CELL); cz++) {
      for (let cx = Math.floor(c.minX / CELL); cx <= Math.floor(c.maxX / CELL); cx++) {
        const k = cellKey(cx, cz);
        let l = grid.get(k);
        if (!l) grid.set(k, l = []);
        l.push(i);
      }
    }
  });
  const seen = new Set();
  let pairs = 0, pairsHair = 0, worstArea = 0, worstPair = '', worstPairDepth = 0;
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a], j = list[b];
        const pk = i < j ? i * 1e6 + j : j * 1e6 + i;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const o = planOverlap(furn[i], furn[j]);
        if (!o) continue;
        pairsHair++;
        if (o.depth <= HAIRLINE) continue;
        pairs++;
        const label = [kindOf(furn[i]), kindOf(furn[j])].sort().join(' + ');
        bump(stats.kindCollisions, label);
        if (o.area > worstArea) { worstArea = o.area; worstPair = label; worstPairDepth = o.depth; }
      }
    }
  }
  if (pairs) {
    check('2.overlap').fail(id, `${pairs} overlapping pairs, worst ${fmt(worstArea, 3)} m2 (${worstPair})`);
    if (worstArea > stats.worstOverlapArea) {
      stats.worstOverlapArea = worstArea; stats.worstOverlapCase = `${id} ${worstPair}`;
      stats.worstOverlapDepth = worstPairDepth;
    }
  }
  if (pairsHair > pairs) check('2.overlap-hair').fail(id, `${pairsHair - pairs} hairline-overlapping pairs`);

  // ---- 8 + 2b. dynamics --------------------------------------------------
  const dynBoxes = [];
  let dNaN = 0, dExtent = 0, dFloor = 0, dWall = 0;
  for (const dyn of dynamics) {
    const p = dyn.position, s = dyn.size;
    if (![p.x, p.y, p.z, s.x, s.y, s.z].every(Number.isFinite)) { dNaN++; continue; }
    if (s.x <= EPS || s.y <= EPS || s.z <= EPS) dExtent++;
    if (p.y - s.y / 2 < -1e-6) dFloor++;
    const b = {
      minX: p.x - s.x / 2, maxX: p.x + s.x / 2,
      minZ: p.z - s.z / 2, maxZ: p.z + s.z / 2,
      top: p.y + s.y / 2,
    };
    dynBoxes.push(b);
    const r = tileRange(b, EPS);
    let hitWall = false;
    for (let ty = r.ty0; ty <= r.ty1 && !hitWall; ty++) {
      for (let tx = r.tx0; tx <= r.tx1 && !hitWall; tx++) {
        if (T(tx, ty) !== SOLID) continue;
        if (planOverlap(b, { minX: wx(tx), maxX: wx(tx + 1), minZ: wz(ty), maxZ: wz(ty + 1) }, HAIRLINE)) hitWall = true;
      }
    }
    if (hitWall) dWall++;
  }
  if (dNaN) check('8.dyn-nan').fail(id, `${dNaN} dynamics with non-finite position/size`);
  if (dExtent) check('8.dyn-extent').fail(id, `${dExtent} dynamics with a zero-size axis`);
  if (dFloor) check('8.dyn-floor').fail(id, `${dFloor} dynamics with their base below y=0`);
  if (dWall) check('8.dyn-wall').fail(id, `${dWall} dynamics starting inside a wall`);

  let dynPairs = 0, dynStatic = 0;
  for (let i = 0; i < dynBoxes.length; i++) {
    for (let j = i + 1; j < dynBoxes.length; j++) {
      const o = planOverlap(dynBoxes[i], dynBoxes[j], HAIRLINE);
      if (o) dynPairs++;
    }
    for (const c of furn) {
      const o = planOverlap(dynBoxes[i], c, HAIRLINE);
      if (o) dynStatic++;
    }
  }
  if (dynPairs) check('2.dyn-overlap').fail(id, `${dynPairs} dynamic/dynamic pairs interpenetrating at spawn`);
  if (dynStatic) check('2.dyn-static').fail(id, `${dynStatic} dynamic props starting inside a static collider`);

  // ---- 3. doorways -------------------------------------------------------
  // Rebuilt independently of build.js, from the same intent reserveClearances
  // states: SWING tiles of clear floor on both sides of every opening.
  const SWING = 4;
  let doorHits = 0, swingHits = 0, mouthBlocked = 0, worstDoorD = 0;
  for (const d of doors) {
    const doorBox = { minX: wx(d.x0), maxX: wx(d.x1), minZ: wz(d.y0), maxZ: wz(d.y1) };
    const swingBox = d.vertical
      ? { minX: wx(d.x0 - SWING), maxX: wx(d.x1 + SWING), minZ: wz(d.y0), maxZ: wz(d.y1) }
      : { minX: wx(d.x0), maxX: wx(d.x1), minZ: wz(d.y0 - SWING), maxZ: wz(d.y1 + SWING) };

    for (const c of furn) {
      const od = planOverlap(c, doorBox, HAIRLINE);
      if (od) { doorHits++; worstDoorD = Math.max(worstDoorD, od.depth); }
      else if (planOverlap(c, swingBox, HAIRLINE)) swingHits++;
    }

    // Both tiles flanking the opening must be somewhere an enemy can stand,
    // otherwise the door is furnished shut even if nothing sits *in* it.
    for (let y = d.y0; y < d.y1; y++) {
      for (let x = d.x0; x < d.x1; x++) {
        const ns = d.vertical ? [[x - 1, y], [x + 1, y]] : [[x, y - 1], [x, y + 1]];
        for (const [nx, ny] of ns) {
          if (!inb(nx, ny) || !isOpen(T(nx, ny))) continue;
          if (!walk[idx(nx, ny)]) mouthBlocked++;
        }
      }
    }
  }
  if (doorHits) {
    check('3.door-tile').fail(id, `${doorHits} colliders standing in a doorway, worst ${fmt(worstDoorD, 3)} m`);
    if (worstDoorD > stats.worstDoorDepth) { stats.worstDoorDepth = worstDoorD; stats.worstDoorCase = id; }
  }
  if (swingHits) check('3.door-swing').fail(id, `${swingHits} colliders inside a doorway swing zone`);
  if (mouthBlocked) check('3.door-mouth').fail(id, `${mouthBlocked} door-mouth tiles not walkable`);

  // ---- 6. spawn / exit clearance ----------------------------------------
  const clearance = (px, pz) => {
    let worst = Infinity;
    for (const c of furn) {
      const dx = Math.max(c.minX - px, 0, px - c.maxX);
      const dz = Math.max(c.minZ - pz, 0, pz - c.maxZ);
      worst = Math.min(worst, Math.hypot(dx, dz));
    }
    return worst;
  };
  const dSpawn = clearance(layout.spawn.x, layout.spawn.z);
  const dExit = clearance(layout.exit.x, layout.exit.z);
  stats.worstSpawnDist = Math.min(stats.worstSpawnDist, dSpawn);
  stats.worstExitDist = Math.min(stats.worstExitDist, dExit);
  if (dSpawn < CLEAR_R) check('6.spawn-clear').fail(id, `furniture ${fmt(dSpawn, 2)} m from spawn`);
  if (dExit < CLEAR_R) check('6.exit-clear').fail(id, `furniture ${fmt(dExit, 2)} m from exit`);

  // ---- owner map for room attribution ------------------------------------
  const owner = new Int32Array(W * H).fill(-1);
  rooms.forEach((r, ri) => {
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) owner[idx(x, y)] = ri;
  });

  // ---- 9. props inside their room ---------------------------------------
  let spans = 0, escaped = 0, insetBreak = 0;
  for (const c of furn) {
    const r = tileRange(c, HAIRLINE);
    const owners = new Set();
    let sawCorridor = false, sawDoor = false;
    for (let ty = r.ty0; ty <= r.ty1; ty++) {
      for (let tx = r.tx0; tx <= r.tx1; tx++) {
        const t = T(tx, ty);
        if (t === CORRIDOR) sawCorridor = true;
        else if (t === DOOR) sawDoor = true;
        const o = owner[idx(tx, ty)];
        if (o >= 0) owners.add(o);
      }
    }
    if (owners.size > 1) spans++;
    if (owners.size >= 1 && (sawCorridor || sawDoor)) escaped++;
    if (owners.size === 1) {
      const rm = rooms[[...owners][0]];
      const b = { x0: wx(rm.x0) + 0.15, x1: wx(rm.x1) - 0.15, z0: wz(rm.y0) + 0.15, z1: wz(rm.y1) - 0.15 };
      const out = Math.max(b.x0 - c.minX, c.maxX - b.x1, b.z0 - c.minZ, c.maxZ - b.z1);
      if (out > HAIRLINE) {
        insetBreak++;
        bump(stats.insetByKind, `${kindOf(c)}(${fmt(out, 2)}m)`);
      }
    }
  }
  if (spans) check('9.own-room').fail(id, `${spans} colliders spanning two room interiors`);
  if (escaped) check('9.escaped').fail(id, `${escaped} room props also covering corridor/door tiles`);
  if (insetBreak) check('9.inset').fail(id, `${insetBreak} room props outside the 0.15 m wall inset`);

  // ---- 10. nav grid honesty ---------------------------------------------
  // A tile marked walkable whose centre is buried in a static collider is a
  // tile the pathfinder will happily route an enemy into.
  let lies = 0;
  for (const c of furn) {
    const r = tileRange(c, HAIRLINE);
    let n = 0;
    for (let ty = r.ty0; ty <= r.ty1; ty++) {
      for (let tx = r.tx0; tx <= r.tx1; tx++) {
        const i = idx(tx, ty);
        if (!walk[i]) continue;
        const cx = wx(tx + 0.5), cz = wz(ty + 0.5);
        if (cx > c.minX && cx < c.maxX && cz > c.minZ && cz < c.maxZ) { lies++; n++; }
      }
    }
    if (n) bump(stats.navLieByKind, `${kindOf(c)}@top${fmt(c.top, 2)}`, n);
  }
  if (lies) { check('10.nav-lie').fail(id, `${lies} walkable tiles buried in static colliders`); stats.navLies++; stats.navLieTiles += lies; }

  // ---- 5. floor connectivity after furnishing ---------------------------
  const sx = tX(layout.spawn.x), sy = tZ(layout.spawn.z);
  const spawnWalk = inb(sx, sy) && walk[idx(sx, sy)] === 1;
  if (!spawnWalk) check('5.spawn-walk').fail(id, 'spawn tile is not walkable after furnishing');

  const reach = floodWalk(walk, W, H, spawnWalk ? [idx(sx, sy)] : nearestWalk(walk, W, H, sx, sy));

  // Badged rooms are SUPPOSED to be sealed off here: gen/build.js closes their
  // doorways in the nav grid, and doors.js hands the tiles back the moment the
  // player badges in (see the keycard notes in gen/layout.js). So they are
  // excluded from "stranded" and from "unreachable", and then checked the other
  // way round below — a lock that failed to seal is as much a bug as one that
  // sealed something it shouldn't have.
  const locked = layout.locked ?? new Uint8Array(W * H);

  let walkTotal = 0, walkReached = 0;
  for (let i = 0; i < W * H; i++) {
    if (walk[i] && !locked[i]) { walkTotal++; if (reach[i]) walkReached++; }
  }
  if (walkTotal - walkReached > 0) {
    const n = walkTotal - walkReached;
    check('5.walk-orphan').fail(id, `${n} walkable tiles stranded from spawn`);
    stats.strandedTiles.push(n);
    // Biggest single stranded region, so "6 tiles" can be told apart from "half
    // a storage room".
    const seenStrand = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (!walk[i] || reach[i] || seenStrand[i] || locked[i]) continue;
      const region = floodWalk(walk, W, H, [i], (j) => !reach[j]);
      let size = 0;
      for (let j = 0; j < W * H; j++) if (region[j]) { size++; seenStrand[j] = 1; }
      if (size > stats.biggestStrand) { stats.biggestStrand = size; stats.biggestStrandCase = id; }
    }
  }

  const cutOff = [];
  const leaked = [];
  rooms.forEach((r, ri) => {
    let any = false;
    for (let y = r.y0; y < r.y1 && !any; y++) for (let x = r.x0; x < r.x1; x++) if (reach[idx(x, y)]) { any = true; break; }
    if (r.lock) { if (any) leaked.push(`${r.role}#${ri}(${r.lock})`); }
    else if (!any) cutOff.push(`${r.role}#${ri}`);
  });
  if (cutOff.length) {
    check('5.connected').fail(id, `${cutOff.length} rooms unreachable from spawn: ${cutOff.slice(0, 3).join(',')}`);
  }
  // A badged room the enemies can walk into is a lock with a hole in it, and it
  // is invisible from inside the game until a floor's worth of staff comes out
  // of the manager's office.
  if (leaked.length) {
    check('5.lock-sealed').fail(id, `${leaked.length} badged rooms open to the nav grid: ${leaked.slice(0, 3).join(',')}`);
  }

  // ---- 4b/5b. geometric reachability -------------------------------------
  const geom = buildGeomGrid(layout, colliders, BODY_R);
  const { pass, GW } = geom;
  const gIdx = (gx, gy) => gy * GW + gx;
  const gSeedNear = (tx, ty) => {
    const out = [];
    for (let gy = ty * SUB; gy < (ty + 1) * SUB; gy++) {
      for (let gx = tx * SUB; gx < (tx + 1) * SUB; gx++) if (pass[gIdx(gx, gy)]) out.push(gIdx(gx, gy));
    }
    return out;
  };
  const gSpawn = [];
  for (let rr = 0; rr < 12 && !gSpawn.length; rr++) {
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
      const s = gSeedNear(sx + dx, sy + dy);
      if (s.length) { gSpawn.push(...s); break; }
    }
  }
  const gReach = floodWalk(pass, GW, geom.GH, gSpawn);
  const geomCutOff = [];
  rooms.forEach((r, ri) => {
    let any = false;
    for (let ty = r.y0; ty < r.y1 && !any; ty++) {
      for (let tx = r.x0; tx < r.x1 && !any; tx++) {
        for (let gy = ty * SUB; gy < (ty + 1) * SUB && !any; gy++) {
          for (let gx = tx * SUB; gx < (tx + 1) * SUB; gx++) if (gReach[gIdx(gx, gy)]) { any = true; break; }
        }
      }
    }
    if (!any) geomCutOff.push(`${r.role}#${ri}`);
  });
  if (geomCutOff.length) {
    check('5.geom-connected').fail(id, `${geomCutOff.length} rooms physically unreachable: ${geomCutOff.slice(0, 3).join(',')}`);
  }

  // ---- 4. per-room reachability from its own doorways --------------------
  let dead = 0, low = 0, pocket = 0, gDead = 0, gLow = 0, gSoft = 0, inflation = 0;
  rooms.forEach((r, ri) => {
    const interior = (r.x1 - r.x0) * (r.y1 - r.y0);
    if (!interior) return;
    stats.totalRooms++;
    bump(stats.roomsByRole, r.role);

    // Seeds: the tile just inside the room next to each of its door tiles.
    const seeds = [];
    for (const d of r.doors) {
      for (let y = d.y0; y < d.y1; y++) {
        for (let x = d.x0; x < d.x1; x++) {
          const ns = d.vertical ? [[x - 1, y], [x + 1, y]] : [[x, y - 1], [x, y + 1]];
          for (const [nx, ny] of ns) {
            if (!inb(nx, ny) || owner[idx(nx, ny)] !== ri) continue;
            if (walk[idx(nx, ny)]) seeds.push(idx(nx, ny));
          }
        }
      }
    }

    // Flood restricted to this room's interior, so we measure how much of the
    // room a player/enemy stepping through the door can actually get to.
    const inRoom = (i) => owner[i] === ri;
    const got = floodWalk(walk, W, H, seeds, inRoom);

    let walkable = 0, reached = 0;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = idx(x, y);
        if (walk[i]) walkable++;
        if (got[i]) reached++;
      }
    }

    const before = 1;                       // every interior tile is open floor
    const after = walkable / interior;
    const share = reached / interior;
    stats.roomWalkBefore.push(before);
    stats.roomWalkAfter.push(after);
    stats.roomReach.push(share);
    stats.reachOfWalkable.push(walkable ? reached / walkable : 1);
    if (!stats.roleReachShare.has(r.role)) stats.roleReachShare.set(r.role, []);
    stats.roleReachShare.get(r.role).push(share);
    stats.worstRooms.push({ share, id, role: r.role, interior, walkable, reached, doors: r.doors.length });
    if (stats.worstRooms.length > 400) {
      stats.worstRooms.sort((a, b) => a.share - b.share);
      stats.worstRooms.length = 40;
    }

    // Same question again, geometrically: how much of the room can a body that
    // stepped through the doorway actually get to?
    const gSeeds = [];
    for (const d of r.doors) {
      for (let y = d.y0; y < d.y1; y++) {
        for (let x = d.x0; x < d.x1; x++) {
          const ns = d.vertical ? [[x - 1, y], [x + 1, y]] : [[x, y - 1], [x, y + 1]];
          for (const [nx, ny] of ns) {
            if (!inb(nx, ny) || owner[idx(nx, ny)] !== ri) continue;
            gSeeds.push(...gSeedNear(nx, ny));
          }
        }
      }
    }
    // Rooms are rectangles, so confining the flood to the room's cell rect is
    // the same thing as confining it to the room.
    const { passable: gPass, reached: gReached } = floodInRect(
      pass, GW, r.x0 * SUB, r.y0 * SUB, r.x1 * SUB - 1, r.y1 * SUB - 1, gSeeds);
    const gShare = gPass ? gReached / gPass : 1;
    stats.geomShare.push(gShare);
    if (gPass > 0 && gReached === 0) { gDead++; stats.geomDeadRooms++; }
    else if (gShare < REACH_SHARE) { gLow++; stats.geomLowRooms++; }
    if (gShare < GEOM_SOFT) { gSoft++; stats.geomSoftRooms++; }
    stats.geomWorst.push({ id, role: r.role, gPass, gReached, gShare, nav: share, doors: r.doors.length });
    if (stats.geomWorst.length > 400) {
      stats.geomWorst.sort((a, b) => a.gShare - b.gShare);
      stats.geomWorst.length = 40;
    }
    // The nav grid sealed something a body can walk through.
    if (walkable - reached > 2 && gShare > 0.9) { inflation++; stats.navInflated++; }

    if (reached === 0 && walkable > 0) { dead++; stats.deadRooms++; }
    else if (share < REACH_SHARE) { low++; stats.lowRooms++; }
    if (walkable - reached > 2) {
      pocket++;
      if (walkable - reached > stats.biggestPocket) {
        stats.biggestPocket = walkable - reached;
        stats.biggestPocketCase = `${id} ${r.role} (${reached}/${walkable} walkable tiles reachable)`;
      }
    }

    // props per room, by role
    if (!stats.perRoomByRole.has(r.role)) stats.perRoomByRole.set(r.role, []);
  });
  if (dead) check('4.room-dead').fail(id, `${dead} rooms with no floor reachable from their own door`);
  if (low) check('4.room-share').fail(id, `${low} rooms under ${REACH_SHARE * 100}% reachable from their own door`);
  if (pocket) check('4.room-pocket').fail(id, `${pocket} rooms with walkable pockets sealed off inside them`);
  if (gDead) check('4.geom-dead').fail(id, `${gDead} rooms a body cannot enter past its own doorway`);
  if (gLow) check('4.geom-share').fail(id, `${gLow} rooms with under ${REACH_SHARE * 100}% of their passable floor reachable`);
  if (gSoft) check('4.geom-soft').fail(id, `${gSoft} rooms with under ${GEOM_SOFT * 100}% of their passable floor reachable by the player`);
  if (inflation) check('4.nav-inflation').fail(id, `${inflation} rooms the nav grid seals but a body can walk through`);

  // props per room by role — attribute each collider/dynamic to its owner room
  const perRoom = new Map();
  const attribute = (b) => {
    const tx = tX((b.minX + b.maxX) / 2), ty = tZ((b.minZ + b.maxZ) / 2);
    if (!inb(tx, ty)) return;
    const o = owner[idx(tx, ty)];
    if (o >= 0) bump(perRoom, o);
  };
  furn.forEach(attribute);
  dynBoxes.forEach(attribute);
  rooms.forEach((r, ri) => {
    if (!stats.perRoomByRole.has(r.role)) stats.perRoomByRole.set(r.role, []);
    stats.perRoomByRole.get(r.role).push(perRoom.get(ri) || 0);
  });

  // wall standoff per kind — supporting evidence for edgeProp's offset maths
  let floating = 0;
  for (const c of furn) {
    const kind = kindOf(c);
    let gap = Infinity;
    const probe = (px, pz, dx, dz) => {
      for (let s = 0; s < 8; s++) {
        const tx = tX(px + dx * (s * TILE + 0.05)), ty = tZ(pz + dz * (s * TILE + 0.05));
        if (!inb(tx, ty)) return Infinity;
        if (T(tx, ty) === SOLID) {
          return dx < 0 ? c.minX - wx(tx + 1) : dx > 0 ? wx(tx) - c.maxX
            : dz < 0 ? c.minZ - wz(ty + 1) : wz(ty) - c.maxZ;
        }
      }
      return Infinity;
    };
    const mz = (c.minZ + c.maxZ) / 2, mx = (c.minX + c.maxX) / 2;
    gap = Math.min(gap, probe(c.minX, mz, -1, 0), probe(c.maxX, mz, 1, 0),
      probe(mx, c.minZ, 0, -1), probe(mx, c.maxZ, 0, 1));
    if (Number.isFinite(gap)) {
      if (!stats.wallGapByKind.has(kind)) stats.wallGapByKind.set(kind, []);
      stats.wallGapByKind.get(kind).push(gap);
      if (EDGE_ONLY.has(kind)) {
        if (!stats.edgeStandoff.has(kind)) stats.edgeStandoff.set(kind, []);
        stats.edgeStandoff.get(kind).push(gap);
        if (gap > EDGE_TOL) floating++;
      }
    }
  }
  if (floating) {
    check('10.edge-standoff').fail(id,
      `${floating} edgeProp-only props (counter/vending) marooned more than ${EDGE_TOL} m from any wall`);
  }

  return level;
}

// Flood over the nav grid. `seeds` are flat indices; `allow` optionally
// restricts the flood (used to keep a per-room flood inside its room).
function floodWalk(walk, W, H, seeds, allow = null) {
  const seen = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (const s of seeds) {
    if (s < 0 || s >= W * H || seen[s] || !walk[s]) continue;
    if (allow && !allow(s)) continue;
    seen[s] = 1; q[tail++] = s;
  }
  while (head < tail) {
    const i = q[head++], x = i % W, y = (i / W) | 0;
    const push = (j) => { if (!seen[j] && walk[j] && (!allow || allow(j))) { seen[j] = 1; q[tail++] = j; } };
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  return seen;
}

// A sub-tile "can a body stand here" grid built from the real collider AABBs,
// each inflated by `radius`, exactly as player.js resolves collisions. Every
// collider counts — walls and furniture alike — because a prop spans y 0..top
// and there is no step-up, so even a 0.34 m planter has to be walked round.
function buildGeomGrid(layout, colliders, radius) {
  const { W, H, tiles, ox, oz } = layout;
  const GW = W * SUB, GH = H * SUB, CS = TILE / SUB;
  const pass = new Uint8Array(GW * GH);

  for (let ty = 0; ty < H; ty++) {
    if (!rowHasOpen(tiles, W, ty)) continue;
    for (let tx = 0; tx < W; tx++) {
      if (!isOpen(tiles[ty * W + tx])) continue;
      for (let gy = ty * SUB; gy < (ty + 1) * SUB; gy++) {
        for (let gx = tx * SUB; gx < (tx + 1) * SUB; gx++) pass[gy * GW + gx] = 1;
      }
    }
  }

  // Cell centre sits at (gx + 0.5) * CS + ox.
  for (const c of colliders) {
    // A sliding door is open by the time anybody reaches it, so it does not
    // block a body — carving it out here would report every room behind a door
    // as physically cut off from the spawn.
    if (c.door) continue;
    const gx0 = Math.max(0, Math.ceil((c.minX - radius - ox) / CS - 0.5));
    const gx1 = Math.min(GW - 1, Math.floor((c.maxX + radius - ox) / CS - 0.5));
    const gy0 = Math.max(0, Math.ceil((c.minZ - radius - oz) / CS - 0.5));
    const gy1 = Math.min(GH - 1, Math.floor((c.maxZ + radius - oz) / CS - 0.5));
    for (let gy = gy0; gy <= gy1; gy++) {
      const row = gy * GW;
      for (let gx = gx0; gx <= gx1; gx++) pass[row + gx] = 0;
    }
  }
  return { pass, GW, GH };
}

function rowHasOpen(tiles, W, ty) {
  for (let tx = 0; tx < W; tx++) if (isOpen(tiles[ty * W + tx])) return true;
  return false;
}

// Flood confined to an inclusive cell rect, counting passable and reached cells
// without allocating a whole-grid buffer per room.
const scratch = { seen: new Uint8Array(0), q: new Int32Array(0) };
function floodInRect(grid, GW, rx0, ry0, rx1, ry1, seeds) {
  const w = rx1 - rx0 + 1, h = ry1 - ry0 + 1;
  if (w <= 0 || h <= 0) return { passable: 0, reached: 0 };
  const n = w * h;
  if (scratch.seen.length < n) { scratch.seen = new Uint8Array(n); scratch.q = new Int32Array(n); }
  const seen = scratch.seen, q = scratch.q;
  seen.fill(0, 0, n);

  let passable = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (grid[(ry0 + y) * GW + rx0 + x]) passable++;
  }

  let head = 0, tail = 0;
  for (const g of seeds) {
    const gx = g % GW, gy = (g / GW) | 0;
    if (gx < rx0 || gx > rx1 || gy < ry0 || gy > ry1) continue;
    const li = (gy - ry0) * w + (gx - rx0);
    if (seen[li] || !grid[g]) continue;
    seen[li] = 1; q[tail++] = li;
  }
  let reached = tail;
  while (head < tail) {
    const li = q[head++], x = li % w, y = (li / w) | 0;
    const push = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const lj = ny * w + nx;
      if (seen[lj] || !grid[(ry0 + ny) * GW + rx0 + nx]) return;
      seen[lj] = 1; q[tail++] = lj; reached++;
    };
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }
  return { passable, reached };
}

function nearestWalk(walk, W, H, sx, sy) {
  for (let r = 1; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (walk[y * W + x]) return [y * W + x];
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// ASCII dump
// ---------------------------------------------------------------------------

function dump(seed, floorNumber) {
  const layout = generateLayout(seed, floorNumber);
  const level = buildLevel(scene, layout);
  const { W, H, tiles, ox, oz, rooms, doors } = layout;
  const { colliders, dynamics, nav } = level;
  const walk = nav.walk;
  const wx = (tx) => tx * TILE + ox;
  const wz = (ty) => ty * TILE + oz;

  const walls = [], furn = [];
  for (const c of colliders) (c.top === WALL_H ? walls : furn).push(c);

  const mark = new Uint8Array(W * H);   // 1 furniture, 2 dynamic
  const stampBox = (b, v) => {
    const tx0 = Math.max(0, Math.floor((b.minX + HAIRLINE - ox) / TILE));
    const tx1 = Math.min(W - 1, Math.ceil((b.maxX - HAIRLINE - ox) / TILE) - 1);
    const ty0 = Math.max(0, Math.floor((b.minZ + HAIRLINE - oz) / TILE));
    const ty1 = Math.min(H - 1, Math.ceil((b.maxZ - HAIRLINE - oz) / TILE) - 1);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) mark[ty * W + tx] |= v;
  };
  for (const c of furn) stampBox(c, 1);
  for (const d of dynamics) {
    stampBox({
      minX: d.position.x - d.size.x / 2, maxX: d.position.x + d.size.x / 2,
      minZ: d.position.z - d.size.z / 2, maxZ: d.position.z + d.size.z / 2,
    }, 2);
  }

  const sx = Math.floor((layout.spawn.x - ox) / TILE), sy = Math.floor((layout.spawn.z - oz) / TILE);
  const ex = Math.floor((layout.exit.x - ox) / TILE), ey = Math.floor((layout.exit.z - oz) / TILE);
  const reach = floodWalk(walk, W, H, walk[sy * W + sx] ? [sy * W + sx] : nearestWalk(walk, W, H, sx, sy));

  const base = { [SOLID]: '#', [ROOM]: '.', [CORRIDOR]: ':', [DOOR]: '+' };

  console.log(`\n--- seed ${seed} floor ${floorNumber}  ${W}x${H}  rooms=${rooms.length} doors=${doors.length}`
    + `  walls=${walls.length} furniture=${furn.length} dynamics=${dynamics.length}`);
  console.log('    # wall   . room   : corridor   + door');
  console.log('    F static furniture   D dynamic prop   B both');
  console.log('    ! FURNITURE INSIDE A WALL   X FURNITURE IN A DOORWAY');
  console.log('    ? open floor unreachable from spawn after furnishing');
  console.log('    S spawn   E exit');

  for (let y = 0; y < H; y++) {
    let line = '';
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = tiles[i];
      let ch;
      if (t === SOLID) ch = mark[i] ? '!' : '#';
      else if (mark[i] && t === DOOR) ch = 'X';
      else if (mark[i] === 3) ch = 'B';
      else if (mark[i] === 2) ch = 'D';
      else if (mark[i] === 1) ch = 'F';
      else if (!reach[i]) ch = '?';
      else ch = base[t];
      if (x === sx && y === sy) ch = 'S';
      if (x === ex && y === ey) ch = 'E';
      line += ch;
    }
    console.log(line);
  }

  // Per-room reachability table for the same floor: the tile-granular nav
  // answer next to the geometric one a real body gets.
  const owner = new Int32Array(W * H).fill(-1);
  rooms.forEach((r, ri) => {
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) owner[y * W + x] = ri;
  });
  const geom = buildGeomGrid(layout, colliders, BODY_R);
  const { pass, GW } = geom;

  console.log('\nroom  role         interior  walkable  nav-reachable      player-reachable (geometric)');
  const worst = [];
  rooms.forEach((r, ri) => {
    const interior = (r.x1 - r.x0) * (r.y1 - r.y0);
    const seeds = [], gSeeds = [];
    for (const d of r.doors) {
      for (let y = d.y0; y < d.y1; y++) {
        for (let x = d.x0; x < d.x1; x++) {
          const ns = d.vertical ? [[x - 1, y], [x + 1, y]] : [[x, y - 1], [x, y + 1]];
          for (const [nx, ny] of ns) {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (owner[ny * W + nx] !== ri) continue;
            if (walk[ny * W + nx]) seeds.push(ny * W + nx);
            for (let gy = ny * SUB; gy < (ny + 1) * SUB; gy++) {
              for (let gx = nx * SUB; gx < (nx + 1) * SUB; gx++) if (pass[gy * GW + gx]) gSeeds.push(gy * GW + gx);
            }
          }
        }
      }
    }
    const got = floodWalk(walk, W, H, seeds, (i) => owner[i] === ri);
    let wk = 0, rc = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { if (walk[y * W + x]) wk++; if (got[y * W + x]) rc++; }
    const g = floodInRect(pass, GW, r.x0 * SUB, r.y0 * SUB, r.x1 * SUB - 1, r.y1 * SUB - 1, gSeeds);
    const gShare = g.passable ? g.reached / g.passable : 1;
    worst.push({ ri, gShare });
    const flag = g.reached === 0 ? '  <-- PLAYER LOCKED OUT'
      : gShare < GEOM_SOFT ? '  <-- PLAYER SHUT OUT OF THE REST'
        : rc < wk ? '  <-- nav-only pocket' : '';
    console.log(`${String(ri).padStart(4)}  ${r.role.padEnd(12)} ${String(interior).padStart(8)}  ${String(wk).padStart(8)}  `
      + `${String(rc).padStart(6)} (${fmt(100 * rc / interior).padStart(5)}%)     `
      + `${String(g.reached).padStart(6)}/${String(g.passable).padEnd(6)} (${fmt(100 * gShare).padStart(5)}%)${flag}`);
  });

  // Zoom on one room's sub-cell passability, either the one named with --room or
  // the worst one on the floor.
  const ri = args.indexOf('--room') >= 0
    ? Number(args[args.indexOf('--room') + 1])
    : worst.sort((a, b) => a.gShare - b.gShare)[0]?.ri;
  const r = rooms[ri];
  if (!r) return;
  const furnHere = colliders.filter((c) => c.top !== WALL_H
    && c.minX > wx(r.x0) - 0.3 && c.maxX < wx(r.x1) + 0.3
    && c.minZ > wz(r.y0) - 0.3 && c.maxZ < wz(r.y1) + 0.3)
    .sort((a, b) => a.minZ - b.minZ);
  console.log(`\n--- room ${ri} (${r.role}) zoom: 0.125 m cells, colliders inflated by the player radius ${BODY_R} m`);
  console.log(`    world x ${fmt(wx(r.x0), 2)}..${fmt(wx(r.x1), 2)}   z ${fmt(wz(r.y0), 2)}..${fmt(wz(r.y1), 2)}   doors ${r.doors.length}`);
  for (const c of furnHere) {
    console.log(`    ${kindOf(c).padEnd(14)} ${fmt(c.maxX - c.minX, 2)} x ${fmt(c.maxZ - c.minZ, 2)} top ${fmt(c.top, 2)}  `
      + `x ${fmt(c.minX, 2)}..${fmt(c.maxX, 2)}  z ${fmt(c.minZ, 2)}..${fmt(c.maxZ, 2)}`);
  }
  console.log('    o = the player can stand here,  (blank) = inside a collider or too close to one');
  for (let gy = r.y0 * SUB; gy < r.y1 * SUB; gy++) {
    let s = '    ';
    for (let gx = r.x0 * SUB; gx < r.x1 * SUB; gx++) s += pass[gy * GW + gx] ? 'o' : ' ';
    console.log(s.replace(/\s+$/, '') || '    ');
  }
}

// ---------------------------------------------------------------------------
// catalogue report
// ---------------------------------------------------------------------------

function catalogueReport() {
  const line = '-'.repeat(96);
  console.log(line);
  console.log('PROP CATALOGUE AUDIT   (local space, over 600 rng draws per kind)');
  console.log(line);
  console.log('kind          decl w x d   obstacle box (x0,z0)-(x1,z1)      dx    dz   geometry overhang  top');
  let declFail = 0, geoFail = 0;
  const declNotes = [], geoNotes = [];
  for (const e of CAT.values()) {
    const hw = e.w / 2, hd = e.d / 2;
    const ox0 = hw + e.obs.x0, ox1 = hw - e.obs.x1;   // negative => obstacle pokes out
    const oz0 = hd + e.obs.z0, oz1 = hd - e.obs.z1;
    const dx = Math.min(ox0, ox1), dz = Math.min(oz0, oz1);
    const gx = Math.min(hw + e.geo.x0, hw - e.geo.x1);
    const gz = Math.min(hd + e.geo.z0, hd - e.geo.z1);
    const bad = dx < -1e-9 || dz < -1e-9;
    const gbad = gx < -1e-9 || gz < -1e-9;
    if (bad) { declFail++; declNotes.push(`${e.kind} by ${fmt(-Math.min(dx, dz), 3)} m`); }
    if (gbad) { geoFail++; geoNotes.push(`${e.kind} by ${fmt(-Math.min(gx, gz), 3)} m`); }
    console.log(`${e.kind.padEnd(13)} ${fmt(e.w, 2)} x ${fmt(e.d, 2)}   `
      + `(${fmt(e.obs.x0, 2)},${fmt(e.obs.z0, 2)})-(${fmt(e.obs.x1, 2)},${fmt(e.obs.z1, 2)})   `
      + `${fmt(dx, 3).padStart(6)} ${fmt(dz, 3).padStart(6)}   `
      + `${fmt(Math.min(gx, gz), 3).padStart(6)}${gbad ? ' OUT' : '    '}          `
      + `${fmt(e.obs.topMin, 2)}..${fmt(e.obs.top, 2)}${bad ? '   <-- OBSTACLE OUTSIDE FOOTPRINT' : ''}`);
  }
  check('10.decl-fit').run();
  check('10.geo-fit').run();
  if (declFail) check('10.decl-fit').fail('catalogue', `${declFail} kinds: ${declNotes.join(', ')}`);
  if (geoFail) check('10.geo-fit').fail('catalogue', `${geoFail} kinds: ${geoNotes.join(', ')}`);

  // edgeProp's standoff maths, evaluated symbolically per kind.
  console.log(line);
  console.log('edgeProp() WALL STANDOFF ERROR  — sides 1 and 3 rotate the prop (rot 1/3),');
  console.log('so the extent perpendicular to the wall is spec.d, but edgeProp offsets by spec.w/2.');
  console.log('kind          side0/2 err   side1/3 err   effect');
  for (const e of CAT.values()) {
    const err13 = (e.w - e.d) / 2;   // halfD used (w/2) minus true half extent (d/2)
    if (Math.abs(err13) < 1e-9) continue;
    const effect = err13 > 0 ? `floats ${fmt(err13, 2)} m off the wall` : `pushed ${fmt(-err13, 2)} m into the wall`;
    console.log(`${e.kind.padEnd(13)} ${fmt(0, 2).padStart(11)}   ${fmt(err13, 2).padStart(11)}   ${effect}`);
  }
  console.log(line);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

buildCatalogue();
buildSigIndex();

if (args.includes('--dump')) {
  const i = args.indexOf('--dump');
  dump(Number(args[i + 1] ?? 1) >>> 0, Number(args[i + 2] ?? 1));
  process.exit(0);
}

if (args.includes('--catalogue')) {
  catalogueReport();
  process.exit(0);
}

const t0 = Date.now();
let cases = 0;
const runOne = (seed, floor) => {
  try { validate(seed >>> 0, floor); } catch (e) {
    check('0.crash').run();
    check('0.crash').fail(`s${seed >>> 0}/f${floor}`, `${e.name}: ${e.message}`);
    if (args.includes('--trace')) console.error(e);
  }
  cases++;
};

for (let floor = 1; floor <= FLOORS; floor++) {
  // Same seed schedule as validate-layout.mjs so a floor can be cross-examined
  // with both tools.
  for (let s = 1; s <= SEEDS_PER_FLOOR; s++) runOne(((s * 2654435761) >>> 0) ^ (floor * 40503), floor);
  for (let s = 1; s <= SMALL_SEEDS; s++) runOne(s + floor * 1000, floor);
}

const line = '='.repeat(96);
console.log(line);
console.log(`FURNITURE VALIDATOR — ${cases} furnished floors, floors 1..${FLOORS}, ${Date.now() - t0} ms`);
console.log(line);

catalogueReport();

let hardFails = 0, warns = 0;
for (const [, c] of checks) {
  if (c.runs === 0 && c.fails === 0) continue;
  const ok = c.fails === 0;
  if (!ok) { if (c.sev === 'FAIL') hardFails++; else warns++; }
  const p = c.runs ? fmt((c.fails / c.runs) * 100) : '0.0';
  console.log(`${ok ? 'PASS' : c.sev}  ${c.title.padEnd(66)} ${String(c.fails).padStart(4)}/${String(c.runs).padEnd(4)} (${p}%)`);
  if (!ok) {
    console.log(`      repro: ${c.examples.map((e) => `--dump ${e.replace(/^s/, '').replace('/f', ' ')}`).join('   ')}`);
    for (const [note, n] of [...c.notes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      console.log(`      x${String(n).padStart(4)}  ${note}`);
    }
  }
}

console.log(line);
console.log('STATS');
console.log(line);
const pf = stats.propsPerFloor;
console.log(`props / floor        min ${lo(pf)}  median ${median(pf)}  mean ${fmt(mean(pf))}  max ${hi(pf)}`);
console.log(`  static colliders   min ${lo(stats.staticPerFloor)}  median ${median(stats.staticPerFloor)}  max ${hi(stats.staticPerFloor)}`);
console.log(`  dynamic props      min ${lo(stats.dynPerFloor)}  median ${median(stats.dynPerFloor)}  max ${hi(stats.dynPerFloor)}`);
console.log(`  wall colliders     min ${lo(stats.wallColliders)}  median ${median(stats.wallColliders)}  max ${hi(stats.wallColliders)}`);
console.log('');
console.log('props per room, by role      n rooms   median  p90   max     reachable share  median   p10   min');
for (const [role, counts] of [...stats.perRoomByRole.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const rs = stats.roleReachShare.get(role) || [];
  console.log(`  ${role.padEnd(12)} ${String(counts.length).padStart(9)} ${String(median(counts)).padStart(8)} `
    + `${String(pct(counts, 0.9)).padStart(4)} ${String(hi(counts)).padStart(5)}` + '        '
    + `${fmt(100 * median(rs)).padStart(12)}% ${fmt(100 * pct(rs, 0.1)).padStart(6)}% ${fmt(100 * lo(rs)).padStart(6)}%`);
}
console.log('');
console.log(`room walkable share  before furnishing 100.0%   after ${fmt(100 * median(stats.roomWalkAfter))}% median, `
  + `${fmt(100 * pct(stats.roomWalkAfter, 0.1))}% p10, ${fmt(100 * lo(stats.roomWalkAfter))}% min`);
console.log(`room reachable share (from its own doorway) ${fmt(100 * median(stats.roomReach))}% median, `
  + `${fmt(100 * pct(stats.roomReach, 0.1))}% p10, ${fmt(100 * lo(stats.roomReach))}% min`);
console.log(`  of the WALKABLE floor only   ${fmt(100 * median(stats.reachOfWalkable))}% median, `
  + `${fmt(100 * pct(stats.reachOfWalkable, 0.1))}% p10, ${fmt(100 * lo(stats.reachOfWalkable))}% min`);
console.log(`rooms                ${stats.totalRooms} total, ${stats.deadRooms} DEAD (0% reachable), `
  + `${stats.lowRooms} under ${REACH_SHARE * 100}% reachable`);
console.log(`room roles           ${hist(stats.roomsByRole, 12)}`);
stats.worstRooms.sort((a, b) => a.share - b.share);
console.log('worst 8 rooms by NAV reachable share (interior tiles / walkable / reached):');
for (const r of stats.worstRooms.slice(0, 8)) {
  console.log(`  ${r.id.padEnd(16)} ${r.role.padEnd(11)} doors=${r.doors}  ${String(r.interior).padStart(4)} / `
    + `${String(r.walkable).padStart(4)} / ${String(r.reached).padStart(4)}  = ${fmt(100 * r.share)}% of interior`);
}
console.log('');
console.log(`GEOMETRIC reachability (${fmt(TILE / SUB, 3)} m cells, colliders inflated by the player's `
  + `RADIUS ${BODY_R} m; enemies are ${ENEMY_R} m)`);
console.log(`  share of passable floor reachable from a room's own door: median ${fmt(100 * median(stats.geomShare))}%, `
  + `p10 ${fmt(100 * pct(stats.geomShare, 0.1))}%, min ${fmt(100 * lo(stats.geomShare))}%`);
console.log(`  ${stats.geomDeadRooms} rooms a body cannot enter, ${stats.geomLowRooms} rooms under ${REACH_SHARE * 100}%, `
  + `${stats.geomSoftRooms} rooms (${fmt(100 * stats.geomSoftRooms / stats.totalRooms)}% of all rooms) under ${GEOM_SOFT * 100}% passable-floor reachable`);
console.log(`  ${stats.navInflated} rooms where the NAV grid seals a gap a body can physically walk through`);
stats.geomWorst.sort((a, b) => a.gShare - b.gShare);
if (stats.geomWorst.length) {
  console.log('  worst 12 rooms — the player is physically shut out of the rest (passable cells / reached / geom share / nav share):');
  for (const r of stats.geomWorst.slice(0, 12)) {
    console.log(`    ${r.id.padEnd(16)} ${r.role.padEnd(11)} doors=${r.doors}  ${String(r.gPass).padStart(5)} / `
      + `${String(r.gReached).padStart(5)} / ${fmt(100 * r.gShare).padStart(6)}%  (nav ${fmt(100 * r.nav)}%)`);
  }
}
console.log('');
console.log(`prop kinds placed    ${hist(stats.footprintHist, 16)}`);
console.log(`footprint area m2    ${hist(stats.areaHist, 14)}`);
if (stats.unknownSigs.size) console.log(`unrecognised sigs    ${hist(stats.unknownSigs, 6)}`);
console.log('');
console.log(`worst wall penetration   ${fmt(stats.worstWallDepth, 3)} m   ${stats.worstWallCase}`);
console.log(`  kinds found in walls   ${hist(stats.kindInWall, 10)}`);
console.log(`worst prop/prop overlap  ${fmt(stats.worstOverlapArea, 3)} m2 (depth ${fmt(stats.worstOverlapDepth, 3)} m)  ${stats.worstOverlapCase}`);
console.log(`  colliding kind pairs   ${hist(stats.kindCollisions, 8)}`);
console.log(`worst doorway intrusion  ${fmt(stats.worstDoorDepth, 3)} m   ${stats.worstDoorCase}`);
console.log(`closest prop to spawn    ${fmt(stats.worstSpawnDist, 2)} m   (need ${CLEAR_R} m)`);
console.log(`closest prop to exit     ${fmt(stats.worstExitDist, 2)} m   (need ${CLEAR_R} m)`);
console.log(`nav grid lies            ${stats.navLies} floors, ${stats.navLieTiles} walkable tiles buried in colliders`);
console.log(`  by kind                ${hist(stats.navLieByKind, 8)}`);
console.log(`props past the 0.15 m wall inset   ${hist(stats.insetByKind, 8)}`);
console.log(`walkable tiles stranded from spawn ${stats.strandedTiles.length} floors, `
  + `median ${median(stats.strandedTiles)}, max ${hi(stats.strandedTiles)} tiles; `
  + `biggest single stranded region ${stats.biggestStrand} tiles (${fmt(stats.biggestStrand * TILE * TILE)} m2) ${stats.biggestStrandCase}`);
console.log(`biggest sealed-off pocket inside one room  ${stats.biggestPocket} tiles `
  + `(${fmt(stats.biggestPocket * TILE * TILE)} m2)  ${stats.biggestPocketCase}`);
for (const [kind, gaps] of stats.edgeStandoff) {
  const over = gaps.filter((g) => g > EDGE_TOL).length;
  console.log(`edgeProp-only kind "${kind}"  n=${gaps.length}  median gap ${fmt(median(gaps), 2)} m  `
    + `${over} (${fmt(100 * over / gaps.length)}%) further than ${EDGE_TOL} m from any wall, worst ${fmt(hi(gaps), 2)} m`);
}
console.log('');
console.log('median gap to nearest wall, by prop kind (props meant to sit against a wall should read ~0.15 m)');
for (const [kind, gaps] of [...stats.wallGapByKind.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 16)) {
  console.log(`  ${kind.padEnd(22)} n=${String(gaps.length).padStart(6)}   median ${fmt(median(gaps), 2).padStart(6)} m   p90 ${fmt(pct(gaps, 0.9), 2).padStart(6)} m`);
}

console.log(line);
console.log(hardFails === 0
  ? `RESULT: all hard invariants PASS — ${warns} quality warning(s)`
  : `RESULT: ${hardFails} HARD FAILURE(S), ${warns} warning(s)`);
process.exit(hardFails === 0 ? 0 : 1);
