import * as THREE from 'three';
import { CORRIDOR, SOLID, worldX, worldZ } from './gen/layout.js';
import { BODY_H } from './metrics.js';
import { clamp01 } from './util.js';
import { getTech } from './tech-textures.js';

// Parcel lines: the building moving its own stock about, on the walls.
//
// A floor run by machines should say so before anything on it has shot at you,
// and the staff are only half of that — the other half is that the WORK is
// visible. A belt running the length of a corridor with a box on it every
// couple of metres is a building doing something, and it is the only piece of
// scenery in the game that is still moving when nothing else is.
//
// It is a theme's third lever on the building, alongside the tint and the floor
// units (`conveyors` on THEMES). Absent, a floor has none — which is what makes
// the Automated one read as a plant rather than as an office with blue lights
// in it.
//
// Two decisions shape everything below.
//
// IT IS FITTED ABOVE EVERYTHING. `CLEAR_Y` is not a height that looked right,
// it is the larger of two clearances that both have to hold: a body's own
// height, and the tallest thing in the furniture catalogue — because a belt is
// fitted to a building that already has two-metre shelving standing in it. So
// nothing on a floor is ever in a line's way, and that is the whole reason this
// module may put geometry into a finished floor without re-proving a single
// invariant. It touches no nav tile, reserves no floor, and cannot make a room
// unreachable however it lands.
//
// ...AND IT IS STILL SOLID. Clearing a standing body is not the same as not
// being there: a player who jumps against the wall under one has their head at
// 3.2 m, and a conveyor you can put your eye inside is worse than no conveyor
// at all. So a run contributes one collider with a `base`, exactly the way the
// plant room's tall door header does — walk under it at floor level and it is
// not there, come at it with your feet off the ground and it stops you.
// `barrier` is what keeps it from also becoming a kerb or a floor.

const TALL_PROP = 2.05;        // the tallest thing in gen/model-table.js
// Both clearances, larger wins. Written as the max rather than as the number
// that came out of it, because the day the player gets taller or somebody buys
// a taller shelving unit, this should move on its own.
const CLEAR_Y = Math.max(BODY_H + 0.18, TALL_PROP + 0.06);

const DECK_T = 0.05;           // the belt deck itself
const DECK_Y = CLEAR_Y + DECK_T;             // ...and where its top surface is
const DEPTH = 0.40;            // how far the line stands off the wall
const WALL_GAP = 0.02;         // and the daylight between it and the plaster
const RAIL_H = 0.10;           // side rails, which stop it reading as a shelf
const RAIL_T = 0.025;
const SPINE_W = 0.08;          // the channel it is all hung off the wall by
const SPINE_H = 0.18;
const BRACKET = 2.2;           // metres between the brackets under the deck
const HEAD_L = 0.36;           // the drive head at each end
const HEAD_H = 0.21;

// How long a run has to be to be worth fitting, and how long one may get. The
// minimum is about three parcels' worth: two boxes on a stub of belt is a prop,
// and a line whose whole length you can see from one end is the thing.
const MIN_RUN = 6;
const MAX_RUN = 24;
const MIN_GAP = 7;             // metres between the middles of two runs

const SPEED = 0.6;             // metres a second, and slow on purpose
const PITCH = 2.0;             // metres between parcels
// Parcels scale up out of one drive head and back down into the other, so
// nothing is ever seen arriving from nowhere. It is the cheapest honest answer
// to a loop: a belt IS a loop, and the return leg is inside the housing.
const EDGE = 0.42;
// A shot parcel falls off, bursts on the floor, and the line sends another
// after a while. That is not the belt being destroyed — it is stock being
// replaced, which is what a running line does.
const RESTOCK = [6, 14];
const GRAVITY = 12;
// Bounds a floor of these the way everything else here is bounded: a parcel is
// a box and six lines of update, but a deep floor can roll a lot of corridor.
const MAX_PARCELS = 110;

// One motor every so many metres of belt. A twenty metre line heard from one
// point is a machine in a corner rather than a line down a corridor.
const MOTOR_PITCH = 9;

// Metres between the cleats on the belt. The tread canvas carries two of them
// per tile, so a run is tiled `len / (CLEAT * 2)` times and the pitch lands on a
// whole cleat however long the line came out — a half-cleat at the join is the
// one thing on a scrolling texture the eye reliably finds.
const CLEAT = 0.4;
// ...and the stripes on the guard rails, which are not scrolled: a rail is
// bolted down and only the belt inside it moves. Coarse enough to read from the
// far end of a corridor.
const STRIPE = 0.55;
// The lit panel on each drive head. Wide and shallow, because that is the shape
// of the housing it is let into and the shape of a readout anyway.
const SCREEN_W = 0.26;
const SCREEN_H = 0.11;
// The running light down the front of the deck, and how far apart its lamps
// are. It is fitted on the OUTER face because that is the only lit surface of a
// belt a player ever sees: the deck top is above eye height and its underside
// faces away from every light in the building, so without this a line that is
// running and a line that has stopped look identical from the corridor.
const RUNWAY_H = 0.035;
const RUNWAY_PITCH = 0.5;

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Conveyors {
  constructor({ scene, audio }) {
    this.scene = scene;
    this.audio = audio;
    this.runs = [];
    this.meshes = [];          // what bullets test against
    this.parcels = [];
    this._world = new THREE.Vector3();

    // Shared by every belt the game will ever build, released on dispose. The
    // structure is one unit cube scaled per piece: a run is a different length
    // every time and there is nothing else to say about its geometry.
    this.geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      parcel: [
        new THREE.BoxGeometry(0.30, 0.24, 0.30),
        new THREE.BoxGeometry(0.24, 0.20, 0.34),
        new THREE.BoxGeometry(0.36, 0.16, 0.26),
      ],
      screen: new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
    };
    const tech = getTech();
    this.tech = tech;
    this.mats = {
      frame: new THREE.MeshStandardMaterial({
        map: tech.plate, color: 0x3b4149, roughness: 0.5, metalness: 0.5,
      }),
      parcel: [
        new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: 0x9c7a4d, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: 0xc2a077, roughness: 0.95 }),
      ],
      // Shared across every line on the floor, unlike the belt and the rails:
      // nothing about a readout depends on how long the run under it is.
      screen: new THREE.MeshBasicMaterial({ map: tech.readout, color: 0xd6f2ff }),
    };
  }

  /**
   * Fits this floor's parcel lines, if its theme runs any.
   *
   * `colliders` is the level's own list and is pushed into rather than handed
   * back, which is what gets a belt in front of both the player and the solver
   * with no second channel: this runs before that list goes to either of them.
   */
  spawn(layout, rng, theme, colliders) {
    this.clear();
    const want = theme?.conveyors;
    if (!want) return;

    // Scaled by how the slab came out, like the cameras and the corridor crowd:
    // a fixed count over a floor half again the usual size is a quieter floor
    // for no reason the player could read.
    const n = Math.max(1, Math.round(rng.int(want[0], want[1]) * (layout.areaRatio ?? 1)));

    const sites = this._sites(layout, rng);
    let next = 0;
    for (let i = 0; i < n; i++) {
      let run = null;
      while (next < sites.length && !run) run = this._measure(layout, sites[next++]);
      if (!run) break;
      this._build(run, rng, colliders);
    }
  }

  // Every corridor tile with a wall beside it, shuffled — the same walk the
  // cameras do and for the same reason: a tile that survives every test below
  // is a few percent of a floor, so throwing darts at the grid delivers three
  // lines on one floor and nine on the next.
  //
  // Corridors only. A belt is the building's artery and belongs where the
  // traffic is; one running the length of somebody's private office is a
  // different building.
  _sites(layout, rng) {
    const { W, H, tiles } = layout;
    const out = [];
    for (let ty = 1; ty < H - 1; ty++) {
      for (let tx = 1; tx < W - 1; tx++) {
        const i = ty * W + tx;
        if (tiles[i] !== CORRIDOR) continue;
        if (tiles[i - 1] === SOLID || tiles[i + 1] === SOLID
          || tiles[i - W] === SOLID || tiles[i + W] === SOLID) out.push(i);
      }
    }
    return rng.shuffle(out);
  }

  /**
   * How much straight belt this site can take, and which wall it hangs off.
   *
   * A run is extended along the wall in both directions for as long as the
   * corridor continues AND the wall beside it is still solid — so a doorway on
   * the belt's own side is what ends it, which is right twice over: a line
   * across an opening has nothing to hang off, and it would be a line across an
   * opening.
   */
  _measure(layout, i) {
    const { W, tiles, TILE } = layout;
    const tx = i % W, ty = (i / W) | 0;

    // Both walls this tile could hang a line off; the longest run wins.
    let best = null;
    for (const [wx, wz] of DIRS) {
      if (tiles[(ty + wz) * W + tx + wx] !== SOLID) continue;
      // The belt runs ALONG the wall, which is the axis the wall is not on.
      const [dx, dz] = wx ? [0, 1] : [1, 0];
      const ok = (px, pz) => tiles[pz * W + px] === CORRIDOR
        && tiles[(pz + wz) * W + px + wx] === SOLID;

      let lo = 0, hi = 0;
      while (ok(tx - dx * (lo + 1), ty - dz * (lo + 1))) lo++;
      while (ok(tx + dx * (hi + 1), ty + dz * (hi + 1))) hi++;
      if (!best || lo + hi > best.lo + best.hi) best = { wx, wz, dx, dz, lo, hi };
    }
    if (!best) return null;

    // Trimmed to MAX_RUN off whichever end is longer, so a corridor that runs
    // the width of the building still gets a line rather than nothing.
    let { lo, hi } = best;
    const most = Math.floor(MAX_RUN / TILE);
    while (lo + hi + 1 > most) (lo >= hi ? lo-- : hi--);
    const len = (lo + hi + 1) * TILE;
    if (len < MIN_RUN) return null;

    // The belt's centre line: from the tile centre, out to the wall face and
    // back in by the standoff plus half its own depth.
    const off = TILE / 2 - WALL_GAP - DEPTH / 2;
    const cx = worldX(layout, tx + 0.5) + best.wx * off;
    const cz = worldZ(layout, ty + 0.5) + best.wz * off;

    const run = {
      // Where it starts, and the unit vector it runs in.
      x0: cx - best.dx * (lo * TILE + TILE / 2),
      z0: cz - best.dz * (lo * TILE + TILE / 2),
      dx: best.dx, dz: best.dz, len,
      // Which way is the wall, in the run frame's own local X. The frame is
      // turned so its -Z runs down the belt, which puts local +X at world
      // (-dz, dx) — and since the wall is perpendicular to the run, that dot is
      // exactly ±1. Everything that has to know which side the plaster is on
      // asks this rather than doing the trigonometry again.
      wallSign: -best.dz * best.wx + best.dx * best.wz,
    };
    run.midX = run.x0 + run.dx * len / 2;
    run.midZ = run.z0 + run.dz * len / 2;

    // Not on top of another one. Measured middle to middle, which is coarse and
    // is meant to be: two lines on facing walls of one corridor are one
    // corridor's worth of belt however you count them.
    if (this.runs.some((r) => Math.hypot(r.midX - run.midX, r.midZ - run.midZ) < MIN_GAP)) {
      return null;
    }
    return run;
  }

  _build(run, rng, colliders) {
    // The frame stands at the head of the run, turned so its local -Z points
    // down the belt — the same convention as everything else in this game that
    // faces somewhere. Local +X is then across the belt, and everything below
    // is measured in metres along the run with no trigonometry in it at all.
    const group = new THREE.Group();
    group.position.set(run.x0, 0, run.z0);
    group.rotation.y = Math.atan2(-run.dx, -run.dz);
    this.scene.add(group);
    run.group = group;
    run.motors = [];

    const slab = (mat, w, h, d, x, y, z, hittable = true) => {
      const m = new THREE.Mesh(this.geo.box, mat);
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      m.castShadow = true;
      group.add(m);
      if (hittable) this.meshes.push(m);
      return m;
    };

    const L = run.len;
    const mid = -L / 2;

    // The belt and its rails are the two surfaces whose pattern has to run the
    // LENGTH of this particular line, and a texture carries its own repeat — so
    // both are per run rather than shared. `clone` shares the canvas underneath,
    // which is the whole cost: what is per run is two numbers.
    //
    // The belt is also the one texture in the game that moves. Scrolling it at
    // the speed the stock travels is what turns a black slab into something that
    // is running, and it costs one number a frame (see `update`).
    run.beltMap = this.tech.tread.clone();
    run.beltMap.needsUpdate = true;
    run.beltMap.repeat.set(1, Math.max(1, Math.round(L / (CLEAT * 2))));
    run.beltMat = new THREE.MeshStandardMaterial({
      map: run.beltMap, color: 0x24272b, roughness: 0.95,
    });

    const stripes = this.tech.hazard.clone();
    stripes.needsUpdate = true;
    stripes.repeat.set(Math.max(1, Math.round(L / STRIPE)), 1);
    run.railMat = new THREE.MeshStandardMaterial({
      map: stripes, color: 0xd8a12a, roughness: 0.7,
    });

    // The running light, per run for the same reason and scrolled off the same
    // number. Its map tiles along the plane's OWN x — a plane's u runs along its
    // width, and turning it to face out of the wall puts that width along the
    // run — so this one is an `offset.x` where the deck's is an `offset.y`.
    run.lightMap = this.tech.runway.clone();
    run.lightMap.needsUpdate = true;
    run.lightMap.repeat.set(Math.max(1, Math.round(L / RUNWAY_PITCH)), 1);
    run.lightMat = new THREE.MeshBasicMaterial({ map: run.lightMap });

    // The channel bolted to the wall, the deck, and the two rails. The rails
    // are yellow because everything else up there is the colour of the ceiling,
    // and a line whose edges you cannot see is a shelf.
    slab(this.mats.frame, SPINE_W, SPINE_H, L,
      run.wallSign * (DEPTH / 2 + 0.02), DECK_Y + SPINE_H / 2 - 0.02, mid);
    slab(run.beltMat, DEPTH, DECK_T, L, 0, DECK_Y - DECK_T / 2, mid);
    for (const side of [-1, 1]) {
      slab(run.railMat, RAIL_T, RAIL_H, L,
        side * (DEPTH / 2 - RAIL_T / 2), DECK_Y + RAIL_H / 2, mid);
    }

    // Brackets under the deck, and the drive head at each end. The heads are
    // what a parcel comes out of and goes into — see EDGE.
    for (let d = BRACKET / 2; d < L; d += BRACKET) {
      slab(this.mats.frame, DEPTH, 0.05, 0.05, 0, CLEAR_Y + 0.025, -d, false);
    }
    for (const end of [-HEAD_L / 2, -L + HEAD_L / 2]) {
      slab(this.mats.frame, DEPTH + 0.04, HEAD_H, HEAD_L, 0, CLEAR_Y + HEAD_H / 2, end);
      // A panel on the side of the housing, reporting whatever a parcel line
      // reports. It faces ACROSS the corridor rather than down it, because the
      // drive head is at the end of the run and the end of a run is the one part
      // of it you are never standing in front of. Lit, like everything else in
      // this building with numbers on it.
      for (const side of [-1, 1]) {
        const panel = new THREE.Mesh(this.geo.screen, this.mats.screen);
        panel.position.set(side * (DEPTH / 2 + 0.021), CLEAR_Y + HEAD_H * 0.55, end);
        panel.rotation.y = side * Math.PI / 2;
        group.add(panel);
      }
    }

    // ...and the running light along the front of it. A plane rather than a box:
    // it is a lamp behind a lens, it is only ever seen from the corridor, and a
    // box would put the same map on five faces it does not belong on.
    const light = new THREE.Mesh(
      new THREE.PlaneGeometry(L, RUNWAY_H), run.lightMat);
    light.position.set(-run.wallSign * (DEPTH / 2 + 0.004), DECK_Y - DECK_T / 2, mid);
    light.rotation.y = -run.wallSign * Math.PI / 2;
    group.add(light);
    run.lightGeo = light.geometry;

    // One collider for the lot of it, with an underside. See the header.
    const hw = (run.dx ? L : DEPTH + 0.04) / 2;
    const hd = (run.dx ? DEPTH + 0.04 : L) / 2;
    colliders?.push({
      minX: run.midX - hw, maxX: run.midX + hw,
      minZ: run.midZ - hd, maxZ: run.midZ + hd,
      base: CLEAR_Y, top: DECK_Y + RAIL_H,
      building: true, barrier: true,
    });

    // The stock on it, evenly spaced and started at a random offset so no two
    // lines on a floor are in step.
    const count = Math.min(MAX_PARCELS - this.parcels.length, Math.floor(L / PITCH));
    const phase = rng.range(0, PITCH);
    for (let k = 0; k < count; k++) {
      const which = rng.int(0, 2);
      const geo = this.geo.parcel[which];
      const mesh = new THREE.Mesh(geo, this.mats.parcel[rng.int(0, 2)]);
      mesh.castShadow = true;
      group.add(mesh);
      const parcel = {
        run, mesh,
        s: (phase + k * PITCH) % L,
        // A little of the deck's width to play with, so a line does not read as
        // a ruler with boxes on it.
        lat: rng.range(-DEPTH * 0.16, DEPTH * 0.16),
        spin: rng.range(-0.3, 0.3),
        rest: geo.parameters.height / 2,
        vy: 0, vlat: 0, wait: 0, down: false,
      };
      mesh.userData.parcel = parcel;
      this.meshes.push(mesh);
      this.parcels.push(parcel);
    }

    // Its motors, spread down the line.
    for (let d = MOTOR_PITCH / 2; d < L + MOTOR_PITCH / 2; d += MOTOR_PITCH) {
      run.motors.push({
        x: run.x0 + run.dx * Math.min(d, L), y: DECK_Y,
        z: run.z0 + run.dz * Math.min(d, L), handle: null,
      });
    }

    this.runs.push(run);
    return run;
  }

  /**
   * A bullet landed on a parcel. Returns true if it took it off the belt, which
   * is what earns the hitmarker — a second round through the same gap should
   * read as shooting the wall behind it.
   *
   * The belt itself is never damaged, and that is a decision rather than an
   * omission: it is building services hung off the structure, like the
   * suspended ceiling and the slab. What comes off a running line is stock.
   */
  hit(parcel, point) {
    if (!parcel || parcel.down) return false;
    parcel.down = true;
    parcel.vy = 0.4;
    // Shoved off the deck rather than dropped down it, so it lands out in the
    // corridor instead of against the plaster.
    parcel.vlat = -parcel.run.wallSign * (0.55 + Math.random() * 0.35);
    parcel.mesh.scale.setScalar(1);
    this.audio?.bulletHitMaterial('prop', 'cardboard',
      point ?? parcel.mesh.getWorldPosition(this._world));
    return true;
  }

  update(dt) {
    if (!this.runs.length) return;

    // The belt surface, moving at the speed of the stock on it. One number per
    // run: the cleats are `CLEAT * 2` metres apart in a tile, so the offset is
    // in tiles per second rather than metres, and it is wrapped rather than
    // allowed to grow — a float that climbs for the whole of a long floor loses
    // the precision the pattern is made of.
    const roll = (SPEED * dt) / (CLEAT * 2);
    const flow = (SPEED * dt) / RUNWAY_PITCH;
    for (const run of this.runs) {
      run.beltMap.offset.y = (run.beltMap.offset.y + roll) % 1;
      // Backwards, because a plane turned to face out of the wall has its u
      // running against the way the stock travels — and a running light that
      // crawls the wrong way down a belt is the one detail on it anybody checks.
      run.lightMap.offset.x = (run.lightMap.offset.x - flow) % 1;
    }

    for (const p of this.parcels) {
      const mesh = p.mesh;

      if (p.wait > 0) {
        p.wait -= dt;
        if (p.wait > 0) continue;
        // Back on at the head of the line, inside the drive housing, where it
        // scales up out of nothing like every other parcel on the belt.
        p.down = false;
        p.s = 0;
        mesh.rotation.set(0, 0, 0);
      }

      if (p.down) {
        p.vy -= GRAVITY * dt;
        p.lat += p.vlat * dt;
        p.s += SPEED * dt;              // it left with what the belt was giving it
        mesh.position.set(p.lat, mesh.position.y + p.vy * dt, -p.s);
        mesh.rotation.x += dt * 3.2;
        mesh.rotation.z += dt * 1.7;
        if (mesh.position.y <= p.rest) {
          // On the carpet from two metres up, full of whatever the building was
          // moving. It does not survive that.
          this.audio?.breakThing('prop', 'cardboard', mesh.getWorldPosition(this._world));
          // Both, and neither is redundant: `visible` is what stops it being
          // drawn, and a zero scale is what stops a bullet finding a box that
          // is not there. A Raycaster does not test `visible`.
          mesh.visible = false;
          mesh.scale.setScalar(0);
          p.wait = RESTOCK[0] + Math.random() * (RESTOCK[1] - RESTOCK[0]);
        }
        continue;
      }

      p.s += SPEED * dt;
      if (p.s >= p.run.len) p.s -= p.run.len;

      // Out of one housing and into the other.
      const k = clamp01(Math.min(p.s, p.run.len - p.s) / EDGE);
      mesh.visible = k > 0.03;
      mesh.scale.setScalar(k);
      mesh.position.set(p.lat, DECK_Y + p.rest * k, -p.s);
      mesh.rotation.y = p.spin;
    }

    // Started here rather than at spawn, and retried until it takes: the sound
    // set decodes asynchronously and a floor can be generated before it is
    // ready. Same shape as the floor cleaner's motor in enemy-anim.js.
    for (const run of this.runs) {
      for (const m of run.motors) {
        if (!m.handle) m.handle = this.audio?.startBelt(m.x, m.y, m.z) ?? null;
      }
    }
  }

  /** Everything on this floor goes with the floor. */
  clear() {
    for (const run of this.runs) {
      // Before the group goes, or the loop outlives the building it was in —
      // the same trap the floor cleaner's motor documents in enemies.js.
      for (const m of run.motors) if (m.handle) this.audio?.stopMotor(m.handle);
      this.scene.remove(run.group);
      // Per-run, so they go with the run. The canvas under a cloned texture is
      // shared with the one in tech-textures.js and is not ours to release —
      // disposing a clone drops the GPU copy and leaves the image alone, which
      // is exactly what is wanted.
      run.beltMap.dispose();
      run.railMat.map.dispose();
      run.lightMap.dispose();
      run.beltMat.dispose();
      run.railMat.dispose();
      run.lightMat.dispose();
      run.lightGeo.dispose();
    }
    this.runs.length = 0;
    this.meshes.length = 0;
    this.parcels.length = 0;
  }

  dispose() {
    this.clear();
    this.geo.box.dispose();
    this.geo.screen.dispose();
    for (const g of this.geo.parcel) g.dispose();
    for (const m of Object.values(this.mats)) {
      if (Array.isArray(m)) for (const one of m) one.dispose();
      else m.dispose();
    }
  }
}
