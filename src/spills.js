import * as THREE from 'three';
import { getFx } from './fx-textures.js';

// Water on the floor, and the only liquid in the game.
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
    // One geometry and one material for every puddle: they differ only in
    // transform and opacity, and a pool that allocates per spill is a pool that
    // stutters when a firefight opens six coolers at once.
    this.quad = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      map: fx.puddle,
      transparent: true,
      depthWrite: false,
      // Water on a grey carpet is darker than the carpet and slightly blue, and
      // it is the DARKENING that reads as wet — an additive sheen reads as light.
      color: 0x23303a,
      opacity: 0.66,
      side: THREE.DoubleSide,
    });
    // ...and a second, brighter layer over it. One layer cannot do this: a wet
    // floor is DARKER than a dry one, which is what says "wet" on the pale vinyl
    // of an office — and on the dark grey tile half this building is floored with,
    // a dark patch is invisible. Looked at both: 0.85 of near-black on grey tile
    // came out as a slightly grubby tile. So the darkening stays and an additive
    // sheen goes on top of it, which is also what a shallow puddle does under a
    // ceiling panel. It is the sheen that carries it on a dark floor and the
    // darkening that carries it on a light one.
    this.sheenMaterial = new THREE.MeshBasicMaterial({
      map: fx.puddle,
      transparent: true,
      depthWrite: false,
      color: 0x6f9fb8,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.streamMaterial = new THREE.MeshBasicMaterial({
      map: fx.glow,
      transparent: true,
      depthWrite: false,
      color: 0xbfe4f2,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < MAX_PUDDLES; i++) {
      const mesh = new THREE.Mesh(this.quad, this.material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 1;
      scene.add(mesh);

      const sheen = new THREE.Mesh(this.quad, this.sheenMaterial);
      sheen.rotation.x = -Math.PI / 2;
      sheen.visible = false;
      sheen.renderOrder = 2;
      scene.add(sheen);

      const stream = new THREE.Mesh(this.quad, this.streamMaterial);
      stream.visible = false;
      scene.add(stream);

      this.puddles.push({
        mesh, sheen, stream, live: false, grown: 0, want: 0, leak: 0, drip: 0,
        x: 0, y: 0, z: 0, from: 0, streamLeft: 0, sx: 0, sz: 0,
      });
    }
  }

  /**
   * Water arriving on the floor at (x, y, z) — `y` being the floor it lands on,
   * so a cooler shot in an attic wets the attic rather than the room below it.
   *
   * `from` is the height it is coming out at, which is the bottle rather than the
   * floor; `burst` is whether the bottle went altogether.
   */
  start(x, y, z, { from = 1.1, burst = false, atX = x, atZ = z } = {}) {
    const p = this._take();
    p.live = true;
    p.x = x; p.y = y; p.z = z;
    p.from = from;
    p.grown = 0;
    p.want = burst ? BURST_RADIUS : HIT_RADIUS;
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
    p.want = Math.max(p.want, burst ? BURST_RADIUS : HIT_RADIUS * 1.5);
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
    this.material.dispose();
    this.sheenMaterial.dispose();
    this.streamMaterial.dispose();
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
