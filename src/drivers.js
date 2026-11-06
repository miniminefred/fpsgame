// Cars on a car park that are being DRIVEN, by somebody who would like to run
// you over.
//
// A handful a deck, about what a real car park has moving for the number it has
// parked (`MOVING_SHARE`). Each one sits idling in an aisle with its lights on
// until the driver notices you — sees you on the same deck, hears a gunshot, or
// is shot at — and from then on it HUNTS: off the aisles, round the columns, up
// and down the ramps to whichever deck you are on, and into you at the speed of a
// sprint. A hit is `HIT_DAMAGE`; anybody else in its way is simply run over.
//
// THE DRIVER IS A REAL MEMBER OF STAFF, sitting in the car. That is the whole
// design, and three things fall out of it for free:
//
//   - shoot him through the glass and he dies like anybody else (the glass is not
//     a hit box, so a round goes straight through it to him), and the car rolls
//     to a stop with nobody at the wheel;
//   - he shouts like an employee, because he is one;
//   - in co-op he is ON THE ROSTER, dealt with the floor off its seed on both
//     ends, and the car is wherever his body is — so the joiner's car is moved by
//     the snapshot the host already sends, and nothing new crosses the wire but
//     one bit (`SNAP_DRIVING`) for the moment he gets out.
//
// Shoot the CAR instead and it wrecks: the engine dies, the lights go out, and he
// climbs out and comes for you on foot.
//
// It drives on its own nav field over a grid eroded to a car's width
// (`CAR_CLEAR`), flooded from you, so "anywhere it fits" is a property of the
// floor rather than a guess — a car cannot be routed between two columns it
// would not get between.

import * as THREE from 'three';
import { TYPES } from './enemy-types.js';
import { makeRng } from './gen/rng.js';
import { getAssets } from './textures.js';

const MOVING_SHARE = 0.012;   // moving cars per parked one on a deck
const PER_DECK = [1, 4];
const CAR_CLEAR = 2;          // tiles of walkable floor a car needs either side of its middle
const SPAWN_GAP = 24;         // metres a car starts from the lifts, and from each other

const TOP_SPEED = 7.2;        // m/s on the straight: about a sprint
const CORNER_SPEED = 2.6;     // ...through the tightest turn
const ACCEL = 5;
const BRAKE = 9;
const TURN = 1.9;             // rad/s of steering at speed
const LOOKAHEAD = 6;          // tiles down the field it aims at
const RAM_RANGE = 16;         // metres inside which it drives straight at you
const NOTICE = 34;            // metres it can see you at, on the same deck
const HEAR = 42;              // walked metres a gunshot carries to a driver
const REFLOOD = 0.4;          // seconds between floods of the car field
const BACK_OFF = 0.8;         // seconds of reverse after nosing into something

const HIT_DAMAGE = 60;
const HIT_SPEED = 2.5;        // m/s it has to be doing to hurt anybody
const HIT_GAP = 1.5;          // seconds before the same car can hit the same target again
const CAR_HP = 260;           // the parked car's own, so a moving one wrecks the same

const HALF_W = 1.0, HALF_L = 2.3, ROOF = 1.42;
const FIT = 0.82;              // share of the footprint tested against the floor
const PIVOT = 1.2;             // rad/s it may turn on the spot when wedged both ways
const STUCK = 2.5;             // seconds without getting anywhere before it is freed
const SEAT = { x: -0.4, z: 0.05 };     // the driver's seat, in the car's frame

// Who drives. Ordinary staff — the people who park here.
const DRIVER_TYPES = ['analyst', 'analyst', 'intern', 'sysadmin', 'facilities'];
const PAINTS = ['carSilver', 'carWhite', 'carBlack', 'carGrey', 'carRed', 'carBlue'];

export class Drivers {
  constructor({ scene, enemies, audio, effects }) {
    this.scene = scene;
    this.enemies = enemies;
    this.audio = audio;
    this.effects = effects;
    this.cars = [];
    this.meshes = [];        // what bullets test against: the bodywork, never the glass
    this.unit = new THREE.BoxGeometry(1, 1, 1);
    this._v = { x: 0, z: 0, layer: 0, set(x, y, z) { this.x = x; this.z = z; return this; } };
  }

  /**
   * Cars for this floor, if it is a car park. After the roster has been dealt,
   * and off the floor's SEED rather than its rng, so the drivers come last in the
   * roster on both ends of a co-op session and nothing dealt before them moves.
   */
  spawn(level, nav, tuning, movers) {
    this.clear();
    const layout = level.layout;
    if (!layout.garage || !nav) return;
    this.nav = nav;
    this.movers = movers;
    this.carFits = erode(nav, CAR_CLEAR);
    this.field = nav.makeField();
    this.flooded = false;
    this.refloodIn = 0;

    const rng = makeRng((layout.seed ^ 0xca75ca75) >>> 0);
    for (let layer = 0; layer < nav.L; layer++) {
      const parked = countParked(level.colliders, layer, nav);
      if (!parked) continue;
      const want = Math.max(PER_DECK[0], Math.min(PER_DECK[1], Math.round(parked * MOVING_SHARE)));
      const spots = [];
      const WH = nav.W * nav.H;
      for (let i = 0; i < WH; i++) if (this.carFits[layer * WH + i] && nav.rampAt[i] < 0) spots.push(i);
      rng.shuffle(spots);
      let made = 0;
      for (const i of spots) {
        if (made >= want) break;
        const x = nav.wx(i % nav.W), z = nav.wz((i / nav.W) | 0);
        if (layer === 0 && Math.hypot(x - layout.spawn.x, z - layout.spawn.z) < SPAWN_GAP) continue;
        if (this.cars.some((c) => c.layer === layer && Math.hypot(c.x - x, c.z - z) < SPAWN_GAP)) continue;
        // Parked along whichever way the floor runs further: an aisle, not across one.
        const yaw = run(this.carFits, nav, i, 1, 0, layer) >= run(this.carFits, nav, i, 0, 1, layer)
          ? (rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2)
          : (rng.chance(0.5) ? 0 : Math.PI);
        this._make(x, z, yaw, layer, rng, tuning);
        made++;
      }
    }
  }

  _make(x, z, yaw, layer, rng, tuning) {
    const type = TYPES[rng.pick(DRIVER_TYPES)];
    const e = this.enemies._add(x, z, rng, tuning, type);
    const car = {
      x, z, yaw, layer, y: this.nav.heightAt(x, z, layer),
      speed: 0, hp: CAR_HP, hunting: false, wrecked: false, backing: 0,
      screechIn: 0, hornIn: 0, hitAt: new Map(),
      driver: e, group: null, lights: null, engine: null,
      collider: { minX: 0, maxX: 0, minZ: 0, maxZ: 0, base: 0, top: 0 },
    };
    // Sat down and out of everything that would cast him for something else: a
    // seated body is never picked for a chore, a lunch or a parcel run.
    e.driving = car;
    e.seat = 'meeting';
    e.layer = layer;
    this._build(car, rng.pick(PAINTS));
    this.movers.push(car.collider);
    this.cars.push(car);
    this._place(car);
  }

  // The car as meshes of its own, the parked car's boxes (see buildCar in
  // gen/props.js) — a moving car cannot be batched.
  _build(car, paint) {
    const { materials } = getAssets();
    const group = new THREE.Group();
    const lights = new THREE.MeshBasicMaterial({ color: 0xfff2c8 });
    const tail = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
    const box = (mat, x0, y0, z0, x1, y1, z1, hittable = true) => {
      const m = new THREE.Mesh(this.unit, mat);
      m.scale.set(x1 - x0, y1 - y0, z1 - z0);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.castShadow = hittable;
      group.add(m);
      if (hittable) { m.userData.vehicle = car; this.meshes.push(m); }
      return m;
    };
    const L = 2.2, W = 0.88, roof = ROOF, cf = -0.75, cb = 1.05;
    const body = materials[paint];
    box(body, -W, 0.3, -L, W, 0.86, L);
    // The cabin is a frame round the glass rather than a solid block, so a round
    // through the windscreen meets the driver and not the paint behind the glass.
    box(body, -W + 0.08, roof - 0.06, cf, W - 0.08, roof, cb);                 // roof
    for (const sx of [-1, 1]) box(body, sx * (W - 0.08) - 0.04, 0.86, cf, sx * (W - 0.08) + 0.04, roof, cf + 0.08);
    for (const sx of [-1, 1]) box(body, sx * (W - 0.08) - 0.04, 0.86, cb - 0.08, sx * (W - 0.08) + 0.04, roof, cb);
    box(materials.carGlass, -W + 0.12, 0.88, cf - 0.02, W - 0.12, roof - 0.07, cf + 0.01, false);
    box(materials.carGlass, -W + 0.12, 0.88, cb - 0.01, W - 0.12, roof - 0.07, cb + 0.02, false);
    for (const sx of [-1, 1]) {
      box(materials.carGlass, sx * (W - 0.08) - 0.015, 0.9, cf + 0.08, sx * (W - 0.08) + 0.015, roof - 0.08, cb - 0.08, false);
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1.4, 1.4]) box(materials.tyre, sx * W - 0.1, 0, sz - 0.3, sx * W + 0.1, 0.56, sz + 0.3);
    }
    box(materials.plastic, -W - 0.02, 0.28, -L - 0.08, W + 0.02, 0.5, -L);
    box(materials.plastic, -W - 0.02, 0.28, L, W + 0.02, 0.5, L + 0.08);
    for (const sx of [-1, 1]) {
      box(lights, sx * 0.66 - 0.16, 0.64, -L - 0.03, sx * 0.66 + 0.16, 0.76, -L + 0.01, false);
      box(tail, sx * 0.66 - 0.16, 0.66, L - 0.01, sx * 0.66 + 0.16, 0.78, L + 0.03, false);
    }
    // A wash of light on the floor ahead, which is what says "headlights" in a
    // dark car park without a real light (a light added is every material on the
    // floor recompiled).
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff0c0, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 6), beamMat);
    beam.rotation.x = -Math.PI / 2;
    beam.position.set(0, 0.03, -L - 3.1);
    group.add(beam);
    car.group = group;
    car.lights = { head: lights, tail, beamMat, beam };
    this.scene.add(group);
  }

  get count() { return this.cars.length; }

  /**
   * A frame. On the host the car drives and its driver rides in it; on a joiner
   * the driver's body is being posed off the host's snapshot, and the car is put
   * wherever he is.
   */
  update(dt, targets, noise = 0) {
    if (!this.cars.length) return;
    const host = this.enemies.authority !== false;
    const live = targets.filter((t) => !t.dead && !t.hidden);
    this.noise = noise;
    this.layers = new Set(live.map((t) => t.layer ?? 0));

    if (host) {
      if (this.cars.some((c) => c.hunting && !c.wrecked)) {
        this.refloodIn -= dt;
        if (this.refloodIn <= 0 && live.length) {
          this.refloodIn = REFLOOD;
          this._flood(live);
        }
      }
    }

    for (const car of this.cars) {
      const e = car.driver;
      if (host) {
        if (!car.wrecked && e.driving === car && !e.alive) this._abandon(car);
        if (!car.wrecked && e.alive && e.driving === car) this._drive(car, dt, live);
        else this._coast(car, dt);
        this._hits(car, live);
      } else {
        // Posed: follow the body. Its height and layer came over with it.
        if (e.driving === car) {
          car.x = e.x; car.z = e.z; car.yaw = e.yaw; car.layer = e.layer ?? car.layer;
          car.y = this.nav.heightAt(car.x, car.z, car.layer);
        }
      }
      this._place(car);
      this._sound(car, dt);
    }
  }

  // Whether this driver has noticed anybody: sees them on his own deck, hears a
  // gun, or was shot at (`e.state` leaves idle the moment he is hurt).
  _notice(car, live) {
    const e = car.driver;
    if (e.state !== 'idle' && e.state !== 'wander') return true;
    for (const t of live) {
      if ((t.layer ?? 0) !== car.layer) continue;
      const d = Math.hypot(t.x - car.x, t.z - car.z);
      if (d < NOTICE && this.nav.losClear(car.x, car.z, t.x, t.z, car.layer, car.layer)) return true;
    }
    if (this.noise > 0) {
      const along = this.nav.pathDistance(car.x, car.z, car.layer);
      if (along >= 0 && along < HEAR) return true;
    }
    return false;
  }

  _drive(car, dt, live) {
    const e = car.driver;
    if (!car.hunting && this._notice(car, live)) {
      car.hunting = true;
      e.state = 'chase';
      this.audio?.enemyAlert?.(e);
      this.audio?.carHorn?.({ x: car.x, y: car.y + 0.8, z: car.z, layer: car.layer });
      this.refloodIn = 0;
    }
    if (!car.hunting) { car.speed = 0; return; }

    car.screechIn -= dt;
    car.hornIn -= dt;

    // Where to: straight at whoever is close and in sight on this deck, otherwise
    // down the car field toward them.
    let goal = null;
    for (const t of live) {
      if ((t.layer ?? 0) !== car.layer) continue;
      const d = Math.hypot(t.x - car.x, t.z - car.z);
      if (d < RAM_RANGE && this.nav.losClear(car.x, car.z, t.x, t.z, car.layer, car.layer)) {
        if (!goal || d < goal.d) goal = { x: t.x, z: t.z, d };
      }
    }
    if (!goal && this.flooded) goal = this._ahead(car);

    let want = car.yaw;
    if (goal) want = Math.atan2(-(goal.x - car.x), -(goal.z - car.z));
    car.want = want;

    let turn;
    if (car.backing > 0) {
      // Reversing out of whatever it nosed into, steering the other way.
      car.backing -= dt;
      turn = -Math.sign(wrap(want - car.yaw)) * TURN * 0.7 * dt;
      car.speed = Math.max(-3, car.speed - BRAKE * dt);
    } else {
      const diff = wrap(want - car.yaw);
      turn = Math.max(-TURN * dt, Math.min(TURN * dt, diff)) * Math.min(1, 0.3 + Math.abs(car.speed) / TOP_SPEED);
      const k = Math.min(1, Math.abs(diff) / 1.3);
      const target = goal ? TOP_SPEED + (CORNER_SPEED - TOP_SPEED) * k : 0;
      car.speed += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, target - car.speed));
      if (Math.abs(diff) > 0.9 && car.speed > 5 && car.screechIn <= 0) {
        car.screechIn = 1.6;
        this.audio?.carScreech?.({ x: car.x, y: car.y + 0.3, z: car.z, layer: car.layer });
      }
      if (goal?.d && goal.d < 9 && car.hornIn <= 0) {
        car.hornIn = 4 + Math.random() * 3;
        this.audio?.carHorn?.({ x: car.x, y: car.y + 0.8, z: car.z, layer: car.layer });
      }
    }

    this._move(car, dt, turn);
    this._unstick(car, dt, want);
  }

  /**
   * The last resort: a car that has not got anywhere for STUCK seconds while
   * hunting is moved to the nearest spot it fits at, facing where it wants to go.
   * Wedged with no move, reverse or turn that fits — a corner of a column on one
   * side and a parked car on the other — it would otherwise sit there for the
   * rest of the floor revving, which is worse than a car that shuffles a metre.
   */
  _unstick(car, dt, want) {
    const moved = Math.hypot(car.x - (car.lastX ?? car.x), car.z - (car.lastZ ?? car.z));
    car.lastX = car.x; car.lastZ = car.z;
    car.stuck = moved > 0.02 * dt * 60 ? 0 : (car.stuck ?? 0) + dt;
    if (car.stuck < STUCK) return;
    car.stuck = 0;
    const nav = this.nav;
    const tx0 = nav.tx(car.x), ty0 = nav.ty(car.z);
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = tx0 + dx, ty = ty0 + dy;
        if (!nav.inBounds(tx, ty) || !this.carFits[car.layer * nav.WH + ty * nav.W + tx]) continue;
        const x = nav.wx(tx), z = nav.wz(ty);
        for (const yaw of [want, car.yaw, want + Math.PI / 2, want - Math.PI / 2]) {
          if (!this._fits(x, z, yaw, car.layer)) continue;
          car.x = x; car.z = z; car.yaw = yaw; car.speed = 0; car.backing = 0;
          car.y = nav.heightAt(x, z, car.layer);
          return;
        }
      }
    }
  }

  // Nobody at the wheel, or nothing left to drive: roll to a stop.
  _coast(car, dt) {
    if (car.speed === 0) return;
    const s = Math.sign(car.speed);
    car.speed = s * Math.max(0, Math.abs(car.speed) - BRAKE * 0.4 * dt);
    this._move(car, dt, 0);
  }

  /**
   * Steer by `turn` and roll on by the speed — whichever of that, rolling on
   * without the turn, or the turn on the spot first fits. The car's pose is
   * never changed to one that does not fit, which is what used to wedge it: the
   * steering turned the car into the side of a column and every move from there
   * was refused.
   */
  _move(car, dt, turn) {
    const step = car.speed * dt;
    for (const [dy, go] of [[turn, step], [0, step], [turn, 0]]) {
      if (!dy && !go) continue;
      const yaw = car.yaw + dy;
      const nx = car.x - Math.sin(yaw) * go, nz = car.z - Math.cos(yaw) * go;
      if (!this._fits(nx, nz, yaw, car.layer)) continue;
      car.x = nx; car.z = nz; car.yaw = yaw;
      if (go) this._settle(car);
      if (go) return;
      break;
    }
    if (!step) return;
    if (!this._fits(car.x - Math.sin(car.yaw) * step, car.z - Math.cos(car.yaw) * step, car.yaw, car.layer)) {
      // Nosed into something: back out of it. Wedged with nowhere to go either
      // way, it turns where it stands — toward where it wants to go if that
      // fits, otherwise the other way — rather than sitting there for ever.
      if (car.speed > 0 && car.backing <= 0 && car.hunting && !car.wrecked && car.driver.alive) car.backing = BACK_OFF;
      else if (car.speed < 0 && car.hunting && !car.wrecked) {
        const want = car.want ?? car.yaw;
        const spin = Math.sign(wrap(want - car.yaw) || 1) * PIVOT * dt;
        if (this._fits(car.x, car.z, car.yaw + spin, car.layer)) car.yaw += spin;
        else if (this._fits(car.x, car.z, car.yaw - spin, car.layer)) car.yaw -= spin;
        car.backing = 0;
      }
      car.speed = car.backing > 0 ? -0.5 : 0;
    }
  }

  // The deck the car is on: whichever deck's floor here is nearest the height
  // it was at, so it carries on along the surface it is driving on. A ramp is
  // both decks at once along its length, so this changes nothing on it, and at
  // its top the car rolls on onto the deck it climbed to rather than dropping
  // through to the floor underneath — which is what reading the layer off the
  // route did, the ground under the deck being floor too.
  _settle(car) {
    const nav = this.nav;
    const tile = nav.ty(car.z) * nav.W + nav.tx(car.x);
    let best = car.layer;
    let gap = Math.abs(nav.heightAt(car.x, car.z, car.layer) - car.y);
    for (let layer = 0; layer < nav.L; layer++) {
      if (layer === car.layer || !nav.walk[layer * nav.WH + tile]) continue;
      const d = Math.abs(nav.heightAt(car.x, car.z, layer) - car.y);
      if (d < gap - 0.05) { gap = d; best = layer; }
    }
    car.layer = best;
    car.y = nav.heightAt(car.x, car.z, car.layer);
  }

  // Whether the car's corners and nose are all on floor a body could walk on.
  // Tested a little inside the bodywork (`FIT`): the walk grid rounds every parked
  // car and column outward to whole tiles, so the full footprint is refused gaps
  // the car visibly fits through.
  _fits(x, z, yaw, layer) {
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const w = HALF_W * FIT, l = HALF_L * FIT;
    for (const [lx, lz] of [[-w, -l], [w, -l], [-w, l], [w, l], [0, -l], [0, l], [0, 0]]) {
      const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
      const tx = this.nav.tx(wx), ty = this.nav.ty(wz);
      if (!this.nav.inBounds(tx, ty)) return false;
      if (!this.nav.walk[layer * this.nav.WH + ty * this.nav.W + tx]) return false;
    }
    return true;
  }

  // A point LOOKAHEAD tiles down the car field from here, for the car to aim at.
  _ahead(car) {
    const nav = this.nav;
    let tx = nav.tx(car.x), ty = nav.ty(car.z), layer = car.layer;
    const WH = nav.WH;
    let here = this.field[layer * WH + ty * nav.W + tx];
    if (here < 0) {
      // Off the car field (it has been squeezed against something): aim at the
      // nearest tile that is on it.
      for (let r = 1; r < 6 && here < 0; r++) {
        for (let dy = -r; dy <= r && here < 0; dy++) for (let dx = -r; dx <= r; dx++) {
          const v = this.field[layer * WH + (ty + dy) * nav.W + tx + dx];
          if (v >= 0) { tx += dx; ty += dy; here = v; break; }
        }
      }
      if (here < 0) return null;
    }
    for (let step = 0; step < LOOKAHEAD; step++) {
      let best = here, bx = 0, by = 0, bl = layer;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const v = this.field[layer * WH + (ty + dy) * nav.W + tx + dx];
        if (v >= 0 && v < best) { best = v; bx = dx; by = dy; }
      }
      const lo = nav.cross[ty * nav.W + tx];
      if (lo >= 0 && (layer === lo || layer === lo + 1)) {
        const other = layer === lo ? lo + 1 : lo;
        const v = this.field[other * WH + ty * nav.W + tx];
        if (v >= 0 && v < best) { best = v; bx = 0; by = 0; bl = other; }
      }
      if (best === here) break;
      tx += bx; ty += by; layer = bl; here = best;
    }
    return { x: nav.wx(tx), z: nav.wz(ty), d: 0 };
  }

  // The car field, flooded from the nearest tile a car fits at beside each target.
  _flood(live) {
    const nav = this.nav;
    const origins = [];
    for (const t of live) {
      const layer = t.layer ?? 0;
      const tx0 = nav.tx(t.x), ty0 = nav.ty(t.z);
      let found = false;
      for (let r = 0; r < 10 && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r; dx++) {
          const tx = tx0 + dx, ty = ty0 + dy;
          if (!nav.inBounds(tx, ty)) continue;
          if (this.carFits[layer * nav.WH + ty * nav.W + tx]) { origins.push(tx, ty, layer); found = true; break; }
        }
      }
    }
    if (!origins.length) return;
    nav._flood(origins, this.field, this.carFits);
    this.flooded = true;
  }

  // Into anybody it is touching, if it is going fast enough to hurt.
  _hits(car, live) {
    if (Math.abs(car.speed) < HIT_SPEED) return;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const touches = (x, z, y, r) => {
      if (Math.abs(y - car.y) > 1.6) return false;
      const dx = x - car.x, dz = z - car.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      return Math.abs(lx) < HALF_W + r && Math.abs(lz) < HALF_L + r;
    };
    const now = performance.now() / 1000;
    for (const t of live) {
      if (!touches(t.x, t.z, (t.y ?? 1.7) - 1.7, 0.4)) continue;
      if ((car.hitAt.get(t) ?? -1e9) + HIT_GAP > now) continue;
      car.hitAt.set(t, now);
      t.hurt(HIT_DAMAGE, car.x, car.z);
      this.audio?.carHorn?.({ x: car.x, y: car.y + 0.8, z: car.z, layer: car.layer });
    }
    // ...and whoever else is standing in the way, who is run over.
    for (const o of this.enemies.items) {
      if (!o.alive || o.driving || o.gone || (o.layer ?? 0) !== car.layer) continue;
      if (Math.abs(o.x - car.x) > 3 || Math.abs(o.z - car.z) > 3) continue;
      if (!touches(o.x, o.z, o.y ?? 0, 0.36)) continue;
      const dir = { x: -s, y: 0.3, z: -c };
      this.enemies._damage(o, o.maxHealth * 4, { dir, point: { x: o.x, y: (o.y ?? 0) + 1, z: o.z }, mesh: o.torso, punch: 3 });
    }
  }

  /**
   * A round into the bodywork. Returns true on the shot that wrecks it, which is
   * what earns the hitmarker. Host only decides the wreck; on a joiner the round
   * is a flash on the paint.
   */
  hit(car, damage, point, normal) {
    if (!car || car.wrecked) return false;
    if (point && normal) this.effects?.impact(point, normal, 0xffd08a, 1);
    if (point) this.audio?.bulletHitMaterial?.('prop', 'metal', point);
    if (this.enemies.authority === false) return false;
    if (car.driver.alive && car.driver.state === 'idle') car.driver.state = 'alert';
    car.hp -= damage;
    if (car.hp > 0) return false;
    this._wreck(car);
    return true;
  }

  _wreck(car) {
    car.wrecked = true;
    car.lights.head.color.setHex(0x222222);
    car.lights.tail.color.setHex(0x220a08);
    car.lights.beam.visible = false;
    this.audio?.breakThing?.('prop', 'metal', { x: car.x, y: car.y + 0.8, z: car.z });
    if (car.engine) { this.audio?.stopMotor?.(car.engine); car.engine = null; }
    if (car.driver.alive && car.driver.driving === car) this._getOut(car);
  }

  // The driver is dead at the wheel: the car rolls to a stop.
  _abandon(car) {
    car.driver.driving = null;
    car.lights.beam.visible = false;
  }

  /** Out of the car and after you on foot. Also what a joiner does when told. */
  _getOut(car) {
    const e = car.driver;
    e.driving = null;
    this.enemies._standUp?.(e);
    e.seat = null;
    // The door side, or wherever beside the car a body can stand.
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    for (const side of [-1, 1]) {
      const x = car.x + side * (HALF_W + 0.7) * c, z = car.z - side * (HALF_W + 0.7) * s;
      if (this.nav.clear(x, z, 0.36, car.layer)) { e.x = x; e.z = z; break; }
    }
    e.layer = car.layer;
    e.y = this.nav.heightAt(e.x, e.z, e.layer);
    e.group.position.set(e.x, e.y, e.z);
    e.state = 'chase';
    e.timer = 0;
    e.contact = 0;
  }

  /** The co-op joiner's half of a car being wrecked: the host's driver got out. */
  netOut(e) {
    const car = e.driving;
    if (!car) return;
    car.wrecked = true;
    car.lights.head.color.setHex(0x222222);
    car.lights.beam.visible = false;
    if (car.engine) { this.audio?.stopMotor?.(car.engine); car.engine = null; }
    e.driving = null;
    this.enemies._standUp?.(e);
    e.seat = null;
  }

  // The meshes, the collider the player walks into, and the driver in his seat.
  _place(car) {
    const g = car.group;
    g.position.set(car.x, car.y, car.z);
    g.rotation.y = car.yaw;
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const ex = Math.abs(c) * HALF_W + Math.abs(s) * HALF_L;
    const ez = Math.abs(s) * HALF_W + Math.abs(c) * HALF_L;
    const col = car.collider;
    col.minX = car.x - ex; col.maxX = car.x + ex;
    col.minZ = car.z - ez; col.maxZ = car.z + ez;
    col.base = car.y; col.top = car.y + ROOF;
    const e = car.driver;
    if (e.driving === car) {
      e.x = car.x + SEAT.x * c + SEAT.z * s;
      e.z = car.z - SEAT.x * s + SEAT.z * c;
      e.y = car.y + 0.05;
      e.yaw = car.yaw;
      e.layer = car.layer;
      e.group.position.set(e.x, e.y, e.z);
      e.group.rotation.y = e.yaw;
    }
  }

  _sound(car, dt) {
    // A loop is not routed between storeys the way a one-shot is (see `_placed`
    // in audio.js), so an engine on another deck would come straight through the
    // slab: it only runs while somebody is on its deck.
    const running = !car.wrecked && car.driver.driving === car && this.layers?.has(car.layer);
    if (running && !car.engine) car.engine = this.audio?.startEngine?.(car.x, car.y + 0.5, car.z) ?? null;
    if (!running && car.engine) { this.audio?.stopMotor?.(car.engine); car.engine = null; }
    if (car.engine) this.audio?.moveMotor?.(car.engine, car.x, car.y + 0.5, car.z);
  }

  clear() {
    for (const car of this.cars) {
      this.scene.remove(car.group);
      if (car.engine) this.audio?.stopMotor?.(car.engine);
      car.lights.head.dispose();
      car.lights.tail.dispose();
      car.lights.beamMat.dispose();
      car.lights.beam.geometry.dispose();
    }
    this.cars = [];
    this.meshes = [];
    this.field = null;
  }
}

// Walkable floor eroded to a car's width: a tile is good if every tile within
// `r` of it is walkable on the same layer.
function erode(nav, r) {
  const { W, H, L } = nav;
  const WH = W * H;
  const out = new Uint8Array(WH * L);
  for (let layer = 0; layer < L; layer++) {
    const base = layer * WH;
    for (let ty = r; ty < H - r; ty++) {
      for (let tx = r; tx < W - r; tx++) {
        let ok = true;
        for (let dy = -r; dy <= r && ok; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (!nav.walk[base + (ty + dy) * W + tx + dx]) { ok = false; break; }
          }
        }
        if (ok) out[base + ty * W + tx] = 1;
      }
    }
  }
  return out;
}

// How many tiles of car floor run from tile i along (dx, dy), both ways.
function run(fits, nav, i, dx, dy, layer) {
  const W = nav.W, base = layer * nav.WH;
  const tx = i % W, ty = (i / W) | 0;
  let n = 0;
  for (const s of [1, -1]) {
    for (let k = 1; k < 30; k++) {
      if (!fits[base + (ty + dy * k * s) * W + tx + dx * k * s]) break;
      n++;
    }
  }
  return n;
}

// Parked cars on a deck, off their colliders' size and height.
function countParked(colliders, layer, nav) {
  let n = 0;
  for (const c of colliders) {
    const w = Math.min(c.maxX - c.minX, c.maxZ - c.minZ), l = Math.max(c.maxX - c.minX, c.maxZ - c.minZ);
    if (Math.abs(w - 2.0) > 0.05 || Math.abs(l - 4.56) > 0.05) continue;
    const deck = Math.round((c.base ?? 0) / 3.2);
    if (deck === layer && nav) n++;
  }
  return n;
}

function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
