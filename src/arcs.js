import * as THREE from 'three';

// Electricity coming off a wrecked machine.
//
// One instance per wreck (see `_wreck` in destruction.js), struck from the torn
// edges the blast left — an arc jumping out of unbroken plating reads as a
// decal stuck on the surface, one crawling out of a hole reads as the thing
// that is broken. So the anchors ARE the holes, handed over by whoever tore
// them.
//
// The whole effect is a fixed set of thin cylinders, aimed and stretched
// exactly the way effects.js aims a tracer, plus a light. Nothing is created or
// destroyed while it runs: an arc strikes by moving segments that already
// exist, and goes out by hiding them. That matters more here than for a tracer,
// because this runs for as long as the player is on the floor.

const ARCS = 3;                 // how many can be lit at the same time
const SEGMENTS = 5;             // kinks in one arc
const WIDTH = 0.016;

// An arc is struck for a flicker and then that slot is dark for a while. The
// dark range is wide on purpose: three slots on tight timers read as a machine
// running rather than as one that is broken, and the gaps are what make it look
// like it is dying rather than working.
const LIT = [0.035, 0.13];
const DARK = [0.15, 1.7];

const REACH = [0.4, 1.2];       // how far an arc crawls from its anchor
const KINK = 0.17;              // how far off the straight line each joint wanders

const COLOR = 0xa8dcff;

// What the arc throws on the room. It borrows lighting.js's `spark` rather than
// making a light of its own — see the comment there on why a light that appears
// mid-run is the one thing this effect must not do.
const LIGHT_PEAK = 11;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const between = ([lo, hi]) => lo + Math.random() * (hi - lo);

export class Arcs {
  /**
   * `anchors` are world points to strike from — the centres of the bays the
   * blast took out. `light` is lighting.js's spark, or null on a rig that has
   * none (the arcs then simply do not light anything), and `audio` is the game's
   * voice, likewise optional: an arc is a thing you can watch in silence.
   */
  constructor(scene, anchors, light = null, audio = null) {
    this.scene = scene;
    this.anchors = anchors.map((a) => new THREE.Vector3(a.x, a.y, a.z));
    this.light = light;
    this.audio = audio;

    // One geometry and one material for every segment of every arc: this is a
    // dozen meshes that differ only by transform.
    this.geometry = new THREE.CylinderGeometry(WIDTH, WIDTH, 1, 5, 1, true);
    this.geometry.rotateX(Math.PI / 2);
    this.material = new THREE.MeshBasicMaterial({
      color: COLOR, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });

    this.arcs = [];
    for (let i = 0; i < ARCS; i++) {
      const segments = [];
      for (let s = 0; s < SEGMENTS; s++) {
        const mesh = new THREE.Mesh(this.geometry, this.material);
        mesh.visible = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        scene.add(mesh);
        segments.push(mesh);
      }
      // Staggered, or all three strike together on the first frame and the
      // wreck flashes in step for as long as it stands there.
      this.arcs.push({ segments, lit: 0, wait: Math.random() * DARK[1], root: new THREE.Vector3() });
    }
  }

  /** Aims one arc out of a random hole and shows it. */
  _strike(arc) {
    if (!this.anchors.length) return;

    const from = this.anchors[(Math.random() * this.anchors.length) | 0];
    arc.root.copy(from);

    // Out of the hole and generally upward — electricity that crawls DOWN the
    // front of a machine reads as water running off it.
    _dir.set(Math.random() * 2 - 1, Math.random() * 1.4 - 0.25, Math.random() * 2 - 1);
    if (_dir.lengthSq() < 1e-6) _dir.copy(_up);
    _dir.normalize();

    const step = between(REACH) / SEGMENTS;
    _a.copy(from);

    for (const mesh of arc.segments) {
      // Each joint wanders off the run, so an arc is a jagged thing rather than
      // a straight rod — and the wander is perpendicular to the run itself, or
      // it just shortens and lengthens the arc instead of bending it.
      _side.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
        .cross(_dir);
      if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
      _side.normalize().multiplyScalar((Math.random() * 2 - 1) * KINK);

      _b.copy(_a).addScaledVector(_dir, step).add(_side);

      const length = _a.distanceTo(_b);
      mesh.position.copy(_a).add(_b).multiplyScalar(0.5);
      mesh.lookAt(_b);
      mesh.scale.set(1, 1, Math.max(1e-3, length));
      mesh.visible = true;

      _a.copy(_b);
    }

    arc.lit = between(LIT);

    // Heard from where it struck, which is the point of doing it here rather
    // than once a frame off the brightest slot: three arcs crawling out of three
    // different holes in a fifteen-metre machine are three cracks in three
    // places, and the machine is long enough for that to be a direction. The
    // range rejection is audio.js's — see generatorArc — because this is the one
    // sound in the game that is never finished being asked for.
    this.audio?.generatorArc(arc.root);
  }

  _hide(arc) {
    for (const mesh of arc.segments) mesh.visible = false;
  }

  update(dt) {
    let brightest = null;

    for (const arc of this.arcs) {
      if (arc.lit > 0) {
        arc.lit -= dt;
        if (arc.lit <= 0) {
          this._hide(arc);
          arc.wait = between(DARK);
        } else if (!brightest) {
          brightest = arc;
        }
        continue;
      }
      arc.wait -= dt;
      if (arc.wait <= 0) {
        this._strike(arc);
        if (!brightest) brightest = arc;
      }
    }

    if (!this.light) return;
    if (brightest) {
      this.light.position.copy(brightest.root);
      // Jittered per frame: a steady light behind a flickering arc looks like
      // two unrelated effects that happen to be in the same place.
      this.light.intensity = LIGHT_PEAK * (0.55 + Math.random() * 0.45);
    } else {
      this.light.intensity = 0;
    }
  }

  dispose() {
    for (const arc of this.arcs) {
      for (const mesh of arc.segments) this.scene.remove(mesh);
    }
    this.arcs.length = 0;
    this.geometry.dispose();
    this.material.dispose();
    if (this.light) this.light.intensity = 0;
  }
}
