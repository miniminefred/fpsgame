import { READER_OPEN } from './keycards.js';

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
//
// Badged doors are the one exception to all of the above, and they break the
// rule in the narrowest way they can. The sensor still decides everything — it
// just refuses to see you until you are carrying the card, and never sees the
// staff at all. That last part matters more than it looks: a locked door the
// staff can open is a locked door somebody eventually holds open for you, and
// the enemies walk into these constantly. Their side of it is handled at the nav
// grid, which has the opening closed until you badge in (see gen/build.js).
//
// And badging in is permanent. A door you have opened once stays open for the
// rest of the floor — partly because re-reading a card you already own is
// theatre, and mostly because that is the moment the opening goes back into the
// nav grid, and taking it away again would strand whoever walked through it.

const SENSE = 2.8;             // metres from the opening that trips the sensor
const SPEED = 3.4;             // fraction of the panel's width travelled per second
const HOLD = 0.9;              // seconds it stays open after the last body leaves
// The panel stops blocking well before it is fully back, and starts blocking
// again well after it has begun to close. Anything tighter and the door catches
// you on the way through, which is the single most irritating thing a door can
// do — and worse for the crowd behind you, who all stop dead against it.
const CLEAR_AT = 0.28;

// How often one locked door will tell you it is locked. Per door, because
// standing between two of them should name both cards, not alternate.
const REFUSE_GAP = 2.2;

export class Doors {
  constructor({ scene, audio }) {
    this.scene = scene;
    this.audio = audio;
    this.items = [];

    // Set by game.js. `wallet` is what the player is carrying; the two callbacks
    // are the door reporting what its sensor decided, since what a floor does
    // about an opened door — hand the tiles back to nav, say so on the HUD — is
    // not the door's business.
    this.wallet = null;
    this.onUnlock = null;
    this.onRefused = null;
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
      door.refuseTimer = 0;
      this._place(door);
    }
  }

  /** Every door on this floor still asking for a card. */
  get lockedCount() {
    let n = 0;
    for (const door of this.items) if (door.lock) n++;
    return n;
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
      if (door.refuseTimer > 0) door.refuseTimer -= dt;

      const playerNear = Math.hypot(px - door.x, pz - door.z) < SENSE;
      let near = playerNear;

      if (door.lock) {
        // Badged. Nobody but the player trips this sensor, and the player only
        // trips it holding the card — at which point the lock is gone for good.
        if (!playerNear) {
          near = false;
        } else if (this.wallet?.opens(door.lock)) {
          this._unlock(door);
        } else {
          near = false;
          if (door.refuseTimer <= 0) {
            door.refuseTimer = REFUSE_GAP;
            this.audio?.doorRefused(door.at);
            this.onRefused?.(door);
          }
        }
      } else if (!near) {
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

  // Badged in. The lock is dropped, the reader goes green, and the opening is
  // handed back to the nav grid — which is what lets the floor follow you in,
  // and is why this can only ever happen once.
  _unlock(door) {
    const tier = door.lock;
    door.lock = null;
    if (door.reader) door.reader.lamp.material.color.setHex(READER_OPEN);
    this.audio?.doorUnlock(door.at);
    this.onUnlock?.(door, tier);
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
