import * as THREE from 'three';
import { getFx } from './fx-textures.js';

// Liquid on the floor.
//
// It exists for one prop. A water cooler is a bottle of water on a plastic
// plinth, and until now shooting one broke it into plastic and left the carpet
// dry — which is the same class of lie as a round through somebody's forearm that
// does not scratch them: the player did a thing, the thing had no consequence,
// and the tell is that they can see where the water should be.
//
// Two events, one system. A round into the bottle OPENS it: a glug, a trickle,
// and a patch that spreads while it empties. Killing it BURSTS it: the whole
// bottle at once, a gush, and a patch four times the size. Both then drip for a
// while, because a floor that has been wet for a minute is still wet.
//
// Lifecycle mirrors casings and debris — a fixed pool, oldest reused first, and
// nothing allocated per event. A floor can hold ~26 coolers and a long fight can
// open every one of them, so this has to be bounded by construction rather than
// by hoping. What it deliberately does NOT do is time out: a puddle is a mark on
// the floor like a scorch, and water that dried up while you watched would read
// as worse than no water at all.
//
// Not synced in co-op, for the same reason brass and decals are not: it changes
// nothing either player can do.
//
// IT USED TO BE WATER AND NOTHING ELSE, and the second liquid is what made the
// difference between a system and one prop's effect. A vending machine full of
// cans that is blown apart and leaves the carpet dry is the identical lie the
// cooler used to tell — the player did a thing, the thing had no consequence —
// and the fix is the same patch with a different colour in it. So the shape of a
// spill (two layers, a stream, a spreading edge, a drip) is shared, and a LIQUID
// is the small table of what it looks like and how much of it there is.

// The liquids, and everything that differs between them.
//
//   wet     the darkening layer, which is what says "wet" on a pale floor
//   sheen   the additive layer over it, which is what carries it on a dark one
//   stream  the column leaving the prop
//   scale   how much came out, against a water cooler's 19 litres
//
// A drink is DARKER and WARMER than water and there is much less of it. Both
// halves matter: cola on grey carpet is a brown stain rather than a blue-grey
// one, and a vending machine holds maybe twenty cans against a cooler's whole
// bottle — so a burst that matched the cooler's would read as the machine having
// been full of water. The sheen is where the colour actually reads, because the
// darkening layer is nearly black whatever it is tinted.
const LIQUIDS = {
  water: {
    wet: 0x23303a, wetOpacity: 0.66,
    sheen: 0x6f9fb8, sheenOpacity: 0.24,
    stream: 0xbfe4f2, scale: 1,
  },
  drink: {
    wet: 0x2b1c10, wetOpacity: 0.72,
    sheen: 0xb46a24, sheenOpacity: 0.30,
    // 1.61 m across against a cooler's 2.24, which is still a machineful of cans
    // against a whole 19-litre bottle. It was 0.55 — 1.23 m, against a machine
    // 1.04 m wide — and that is a patch the size of the thing it came out of,
    // which is not a spill, it is a damp footprint. See AWAY_SHARE: the two
    // numbers were wrong together and are only right together.
    stream: 0xd99a4a, scale: 0.72,
  },
};
const DEFAULT_LIQUID = 'water';

const MAX_PUDDLES = 20;
// How long a patch takes to reach its full size. Slow on purpose — the spread is
// the whole tell that something is still emptying itself, and a puddle that
// arrives at full size is a decal rather than a leak.
const GROW_TIME = 3.2;
// Both are radii, and both are bigger than they look like they should be: the
// cooler's own plinth is 0.36 m across and the texture keeps its solid part
// inside the middle three quarters of the quad, so a patch that only just clears
// the machine is a patch you cannot see from standing height. Measured by looking
// at one: 0.42 m of radius read as a slightly dark tile.
const HIT_RADIUS = 0.66;       // metres of radius, from one round into the bottle
// A whole bottle is 19 litres, which over an office floor is a patch about this
// big. Anything more stops reading as water and starts reading as the floor being
// a different colour — looked at 1.5 m of radius and that is exactly what it did.
const BURST_RADIUS = 1.12;     // ...and from the bottle going altogether
// A patch never quite reaches the radius it was given: the last of it is the
// slowest, which is what a spreading edge looks like.
const GROW_EASE = 2.4;
// How far out of the thing it came out of a patch is pushed, as a share of its
// own radius, when the caller says which way is out (`away`).
//
// A LOOSE prop does not need this: a water cooler is 0.4 m across under a patch
// 2.24 m across, so wherever it lands most of it is on floor you can see. A
// FITTED one is the opposite case and the vending machine is the whole reason
// this exists — it is 1.04 m wide, as wide as its own patch, and it is backed
// against a wall, so a patch centred on it is a patch UNDER it. Measured over 38
// machines on three floors: 67% of the drink was inside the machine's own
// footprint, where its debris then lands on top of it, leaving **0.32 m²** of it
// on floor the player can see — a patch smaller than a sheet of A3 at the foot
// of something that had just been blown apart, which is why a burst read as
// nothing having happened at all.
//
// Nine tenths of a radius, so the patch still LAPS the foot of the machine
// rather than standing in front of it as a separate puddle. Measured over 78
// machines: 27% of the drink on open floor becomes 73%, and 0.32 m² becomes
// 1.49 — with the widening below, which is the other half of the same fix.
const AWAY_SHARE = 0.9;

// How long it keeps making noise after it is opened, and how often.
const LEAK_TIME = 9;
const DRIP_GAP = [0.55, 1.5];
// The stream out of the bottle while it is still emptying. A thin quad rather
// than particles: it is a foot of water leaving a hole, seen for a second or two.
const STREAM_TIME = 2.2;
const STREAM_W = 0.055;

export class Spills {
  constructor({ scene, audio }) {
    this.scene = scene;
    this.audio = audio;
    this.puddles = [];
    this.cursor = 0;

    const fx = getFx();
    this.fx = fx;
    // One geometry for every puddle: they differ only in transform, tint and
    // opacity, and a pool that allocates per spill is a pool that stutters when
    // a firefight opens six coolers at once.
    this.quad = new THREE.PlaneGeometry(1, 1);
    // ...and one material TRIO per liquid rather than per puddle, built on
    // first use and kept for the life of the pool. Three materials times two
    // liquids is the whole cost of the second liquid; making them per puddle
    // would be sixty, and putting the tint on the mesh is not an option because
    // a material is what carries a colour in three.
    this.sets = new Map();

    for (let i = 0; i < MAX_PUDDLES; i++) {
      // Started on the default liquid's materials and re-pointed by `start`.
      // A mesh must have SOME material to be added to a scene, and every puddle
      // is invisible until it is taken anyway.
      const set = this._set(DEFAULT_LIQUID);

      const mesh = new THREE.Mesh(this.quad, set.wet);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 1;
      scene.add(mesh);

      const sheen = new THREE.Mesh(this.quad, set.sheen);
      sheen.rotation.x = -Math.PI / 2;
      sheen.visible = false;
      sheen.renderOrder = 2;
      scene.add(sheen);

      const stream = new THREE.Mesh(this.quad, set.stream);
      stream.visible = false;
      scene.add(stream);

      this.puddles.push({
        mesh, sheen, stream, live: false, grown: 0, want: 0, leak: 0, drip: 0,
        x: 0, y: 0, z: 0, from: 0, streamLeft: 0, sx: 0, sz: 0,
        liquid: DEFAULT_LIQUID, scale: 1,
      });
    }
  }

  /**
   * The three materials one liquid is drawn with, built once.
   *
   * TWO LAYERS, and one cannot do this. A wet floor is DARKER than a dry one,
   * which is what says "wet" on the pale vinyl of an office — and on the dark
   * grey tile half this building is floored with, a dark patch is invisible.
   * Looked at both: 0.85 of near-black on grey tile came out as a slightly
   * grubby tile. So the darkening stays and an additive sheen goes on top of it,
   * which is also what a shallow puddle does under a ceiling panel. The sheen
   * carries it on a dark floor and the darkening carries it on a light one —
   * and the sheen is where a liquid's own colour actually reads, since the
   * bottom layer is nearly black whatever it is tinted.
   */
  _set(name) {
    let set = this.sets.get(name);
    if (set) return set;
    const spec = LIQUIDS[name] ?? LIQUIDS[DEFAULT_LIQUID];
    const fx = this.fx;
    set = {
      spec,
      wet: new THREE.MeshBasicMaterial({
        map: fx.puddle,
        transparent: true,
        depthWrite: false,
        color: spec.wet,
        opacity: spec.wetOpacity,
        side: THREE.DoubleSide,
      }),
      sheen: new THREE.MeshBasicMaterial({
        map: fx.puddle,
        transparent: true,
        depthWrite: false,
        color: spec.sheen,
        opacity: spec.sheenOpacity,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      stream: new THREE.MeshBasicMaterial({
        map: fx.glow,
        transparent: true,
        depthWrite: false,
        color: spec.stream,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    };
    this.sets.set(name, set);
    return set;
  }

  /**
   * Water arriving on the floor at (x, y, z) — `y` being the floor it lands on,
   * so a cooler shot in an attic wets the attic rather than the room below it.
   *
   * `from` is the height it is coming out at, which is the bottle rather than the
   * floor; `burst` is whether the bottle went altogether.
   *
   * `away` is a unit direction saying which way is OUT of whatever let go of it,
   * and it is a direction rather than a distance because the two halves of that
   * question belong in different files: the caller is the only thing that knows
   * which side of a machine the room is on, and this file is the only thing that
   * knows how big the patch is going to be. See AWAY_SHARE.
   */
  start(x, y, z, { from = 1.1, burst = false, atX = x, atZ = z, liquid = DEFAULT_LIQUID,
    away = null } = {}) {
    const p = this._take();
    const set = this._set(liquid);
    p.live = true;
    p.liquid = liquid;
    // Kept on the puddle so `feed` widens it by the same measure it was made
    // with. A second round into the same machine must not quietly promote a
    // drink to a cooler's worth of it.
    p.scale = set.spec.scale;
    p.mesh.material = set.wet;
    p.sheen.material = set.sheen;
    p.stream.material = set.stream;
    p.grown = 0;
    p.want = (burst ? BURST_RADIUS : HIT_RADIUS) * p.scale;
    // Pushed clear of what it came out of, now that the size of it is known —
    // and BEFORE the patch's own position is recorded, so the drip that plays
    // off it every second or so comes from where the drink actually is. The
    // stream below is NOT moved with it: that still runs down the machine where
    // the round went in, and the patch spreading away from the foot of it is
    // what the two together are meant to look like.
    if (away) {
      x += away.x * p.want * AWAY_SHARE;
      z += away.z * p.want * AWAY_SHARE;
    }
    p.x = x; p.y = y; p.z = z;
    p.from = from;
    p.leak = LEAK_TIME;
    p.drip = DRIP_GAP[0];
    p.stream.visible = true;
    p.streamLeft = STREAM_TIME;
    // The water leaves the machine where the round went in, not out of the middle
    // of it: the first version ran the stream down the centre line of the cooler,
    // which is inside its own plinth and so behind it from every angle.
    p.sx = atX; p.sz = atZ;

    p.mesh.position.set(x, y + 0.014, z);
    p.mesh.rotation.z = Math.random() * Math.PI * 2;
    p.mesh.scale.setScalar(0.001);
    p.mesh.visible = true;
    p.sheen.position.set(x, y + 0.016, z);
    p.sheen.rotation.z = p.mesh.rotation.z;
    p.sheen.scale.setScalar(0.001);
    p.sheen.visible = true;

    const at = { x, y: from, z };
    if (burst) this.audio?.waterGush(at);
    else this.audio?.waterGlug(at);
    return p;
  }

  /** Widens a patch that is already there — a second round into the same bottle. */
  feed(p, { burst = false } = {}) {
    if (!p?.live) return;
    p.want = Math.max(p.want, (burst ? BURST_RADIUS : HIT_RADIUS * 1.5) * (p.scale || 1));
    p.leak = Math.max(p.leak, LEAK_TIME * 0.6);
    p.streamLeft = Math.max(p.streamLeft, STREAM_TIME * 0.6);
    p.stream.visible = true;
    const at = { x: p.x, y: p.from, z: p.z };
    if (burst) this.audio?.waterGush(at);
    else this.audio?.waterGlug(at);
  }

  update(dt) {
    for (const p of this.puddles) {
      if (!p.live) continue;

      // Toward its full size, slowest at the end.
      if (p.grown < 1) {
        p.grown = Math.min(1, p.grown + dt / GROW_TIME);
        const eased = 1 - Math.pow(1 - p.grown, GROW_EASE);
        const across = Math.max(0.001, p.want * 2 * eased);
        p.mesh.scale.setScalar(across);
        // The sheen sits inside the wet edge rather than on it — the rim of a
        // puddle is thin and does not catch the light the middle does.
        p.sheen.scale.setScalar(across * 0.82);
      }

      if (p.streamLeft > 0) {
        p.streamLeft -= dt;
        const h = Math.max(0.01, p.from - p.y);
        p.stream.position.set(p.sx, p.y + h / 2, p.sz);
        p.stream.scale.set(STREAM_W, h, 1);
        // Billboarded the cheap way: it is a column of water, so only its yaw
        // matters and nothing about it changes if the player circles it.
        // NOTE the opacity is written on a SHARED material, so two streams of the
        // same liquid running at once fight over it and the last one updated
        // wins. Pre-existing and left alone: a stream lasts 2.2 s, the fade is
        // the only thing at stake, and the alternative is a material per puddle.
        p.stream.material.opacity = 0.5 * Math.min(1, p.streamLeft / STREAM_TIME);
        if (p.streamLeft <= 0) p.stream.visible = false;
      }

      if (p.leak > 0) {
        p.leak -= dt;
        p.drip -= dt;
        if (p.drip <= 0) {
          p.drip = DRIP_GAP[0] + Math.random() * (DRIP_GAP[1] - DRIP_GAP[0]);
          this.audio?.waterDrip({ x: p.x, y: p.y + 0.1, z: p.z });
        }
      }
    }
  }

  /** The floor is being torn down. Puddles are the level's, the pool is not. */
  clear() {
    for (const p of this.puddles) {
      p.live = false;
      p.mesh.visible = false;
      p.sheen.visible = false;
      p.stream.visible = false;
      p.leak = 0;
      p.streamLeft = 0;
    }
  }

  dispose() {
    this.clear();
    for (const p of this.puddles) {
      this.scene.remove(p.mesh);
      this.scene.remove(p.sheen);
      this.scene.remove(p.stream);
    }
    this.quad.dispose();
    for (const set of this.sets.values()) {
      set.wet.dispose();
      set.sheen.dispose();
      set.stream.dispose();
    }
    this.sets.clear();
    this.puddles.length = 0;
  }

  // Oldest first, so a long fight reuses the patch nobody is looking at rather
  // than refusing the one they just made.
  _take() {
    const p = this.puddles[this.cursor % this.puddles.length];
    this.cursor++;
    p.stream.visible = false;
    p.streamLeft = 0;
    return p;
  }
}
