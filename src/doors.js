import * as THREE from 'three';

// Sliding doors.
//
// The floorplan has always had doorways; these are the ones that got a door
// fitted. Each is a single panel that lives in the opening and retracts into the
// wall beside it, driven by nothing but proximity — walk up and it opens, walk
// away and it shuts. That is deliberately the whole interface: there is no use
// key in this game and adding one for a door would be the only thing in it you
// have to press a button at.
//
// NPCs open them by the same rule, because the rule is the door's, not the
// player's — anybody who gets close enough is somebody the sensor sees. Which
// also means the nav grid never has to know a door exists: a door that always
// opens for whoever walks up to it is, as far as routing is concerned, an
// opening. The alternative — closed doors blocking nav — would put the
// generator's connectivity invariant behind a runtime state machine, and that
// invariant is proved once at generation and never re-proved.
//
// The only thing that ever really blocks is the player's own collider, and only
// while the panel is more than half shut.

const SENSE = 2.8;             // metres from the opening that trips the sensor
const SPEED = 3.4;             // fraction of the panel's width travelled per second
const HOLD = 0.9;              // seconds it stays open after the last body leaves
// The panel stops blocking well before it is fully back, and starts blocking
// again well after it has begun to close. Anything tighter and the door catches
// you on the way through, which is the single most irritating thing a door can
// do — and worse for the crowd behind you, who all stop dead against it.
const CLEAR_AT = 0.28;

export class Doors {
  constructor({ scene, audio }) {
    this.scene = scene;
    this.audio = audio;
    this.items = [];
  }

  /**
   * Adopts this floor's doors. Each entry is what gen/build.js worked out: the
   * panel mesh, the collider it owns, and the vector along which it retracts.
   */
  setDoors(list) {
    this.items = list ?? [];
    for (const door of this.items) {
      door.open = 0;
      door.hold = 0;
      door.moving = false;
      this._place(door);
    }
  }

  clear() {
    this.items = [];
  }

  /**
   * `bodies` is everything that can trip a sensor: the player, and everyone
   * still on their feet. Nothing here cares which is which.
   */
  update(dt, player, enemies) {
    if (!this.items.length) return;

    const px = player.object.position.x;
    const pz = player.object.position.z;

    for (const door of this.items) {
      let near = Math.hypot(px - door.x, pz - door.z) < SENSE;
      if (!near) {
        for (const e of enemies) {
          if (!e.alive) continue;
          if (Math.hypot(e.x - door.x, e.z - door.z) < SENSE) { near = true; break; }
        }
      }

      if (near) door.hold = HOLD;
      else if (door.hold > 0) door.hold -= dt;

      const want = near || door.hold > 0 ? 1 : 0;
      if (door.open === want) continue;

      // The sound is fired on the frame the panel starts moving, not on the
      // frame the sensor trips: a body that clips the sensor and walks straight
      // out again should not leave a door noise behind it.
      if (!door.moving) {
        door.moving = true;
        if (want) this.audio?.doorOpen(door.at);
        else this.audio?.doorClose(door.at);
      }

      const step = SPEED * dt;
      door.open = want > door.open
        ? Math.min(1, door.open + step)
        : Math.max(0, door.open - step);
      if (door.open === want) door.moving = false;

      this._place(door);
    }
  }

  // Panel position, and the collider that follows it. The collider is retired
  // the moment the door is more than half open, which is the point at which you
  // can walk through the gap — a door that only stops blocking at fully open
  // catches you on the way through every time.
  _place(door) {
    const slide = door.travel * door.open;
    door.mesh.position.set(
      door.baseX + door.dirX * slide,
      door.mesh.position.y,
      door.baseZ + door.dirZ * slide);

    door.collider.top = door.open < CLEAR_AT ? door.height : -1;
  }
}
