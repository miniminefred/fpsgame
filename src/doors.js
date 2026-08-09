// Doors.
//
// The floorplan has always had doorways; these are the ones that got a door
// fitted. A doorway in a wall gets a single panel that lives in the opening and
// retracts into the wall beside it. A doorway across a corridor gets two leaves
// on hinges, because there is no wall beside a corridor to retract into — see
// cutHallDoors in gen/layout.js. Either way they are driven by nothing but
// proximity — walk up and it opens, walk away and it shuts. That is deliberately
// the whole interface: there is no use key in this game and adding one for a
// door would be the only thing in it you have to press a button at.
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
// rule in the narrowest way they can: while a door is locked its sensor sees
// nobody at all — not you, and not the staff. Their side of it is handled at the
// nav grid, which has the opening closed (see gen/build.js), so a chase never
// piles up against a door the chasers cannot open.
//
// What clears a lock is picking up the card, not walking up to the door. That is
// a deliberate choice and it is about the white card: white is on every door on
// the floor, and unlocking those one doorway at a time means the whole building
// stays sealed to the enemies until the player has personally stood in front of
// each of two hundred openings. Taking a badge off somebody turns the building
// on — every door that badge fits goes live at once, its reader goes green, and
// its opening goes back into the nav grid. Which is also exactly what a badge
// does in a real building.
//
// It is permanent for the same reason it is instant: that moment is when the
// opening rejoins the nav grid, and taking it away again would strand whoever
// walked through it.

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

    // Set by game.js: the door reporting what its reader decided, since what a
    // floor does about it — hand the tiles back to nav, say so on the HUD — is
    // not the door's business.
    this.onRefused = null;
  }

  /**
   * Adopts this floor's doors. Each entry is what gen/build.js worked out: the
   * panel or the pair of leaves, the collider it owns, and how it gets out of
   * the way.
   */
  setDoors(list, nav = null) {
    this.items = list ?? [];
    // The nav grid, purely so a shut panel can stop a line of sight through its
    // doorway — see _place. A doorway with no door fitted in it never gets one
    // of these calls, so it stays the hole it is.
    this.nav = nav;
    for (const door of this.items) {
      door.open = 0;
      door.hold = 0;
      door.moving = false;
      door.refuseTimer = 0;
      door.opaque = false;   // ...until the first _place says otherwise
      this._place(door);
    }
  }

  /** Every door on this floor still asking for a card. */
  get lockedCount() {
    let n = 0;
    for (const door of this.items) if (door.lock) n++;
    return n;
  }

  /**
   * A card just went into the player's pocket: every door it fits is now open.
   *
   * Returns the doors that changed, because each one owes the nav grid its
   * opening back and only the caller knows where the nav grid is. Cheap enough
   * to run on every pickup — it is five times a floor at most, over a couple of
   * hundred doors.
   */
  applyWallet(wallet) {
    const opened = [];
    for (const door of this.items) {
      if (!door.lock || !wallet?.opens(door.lock)) continue;
      door.lock = null;
      if (door.reader) door.reader.setOpen();
      opened.push(door);
    }
    if (opened.length) this.audio?.doorUnlock(opened[0].at);
    return opened;
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

      let near = Math.hypot(px - door.x, pz - door.z) < SENSE;

      if (door.lock) {
        // Still badged, so its sensor is off — for everybody. All it does is say
        // so, once every couple of seconds, to whoever walks into it.
        if (near && door.refuseTimer <= 0) {
          door.refuseTimer = REFUSE_GAP;
          this.audio?.doorRefused(door.at);
          this.onRefused?.(door);
        }
        near = false;
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

  // Where the door is, and the collider that follows it. The collider is retired
  // the moment the door is more than half open, which is the point at which you
  // can walk through the gap — a door that only stops blocking at fully open
  // catches you on the way through every time.
  //
  // Two kinds of door and one number driving both: `open` is 0 shut, 1 open, and
  // what that means is the panel's business. A doorway in a wall slides its
  // panel into the wall; a doorway across a corridor has no wall to slide into
  // and swings a pair of leaves back instead (see gen/build.js).
  _place(door) {
    if (door.leaves) {
      for (const leaf of door.leaves) leaf.pivot.rotation.y = leaf.angleTo * door.open;
    } else {
      const slide = door.travel * door.open;
      door.mesh.position.set(
        door.baseX + door.dirX * slide,
        door.mesh.position.y,
        door.baseZ + door.dirZ * slide);
    }

    // One threshold for both of the things a panel does when it is in the way:
    // it stops you walking through, and it stops anyone looking through. They
    // are the same fact and it would be strange for them to disagree by a frame.
    //
    // Sight matters more than it sounds like it should. An enemy's fire is not a
    // raycast against the building — they shoot when they can see you (see
    // _shoot in enemies.js) — so a doorway that stays transparent while a panel
    // stands in it is a doorway they shoot you through. And a BADGED door never
    // opens at all, so this is also what puts a locked room genuinely out of
    // sight rather than merely out of reach.
    const shut = door.open < CLEAR_AT;
    door.collider.top = shut ? door.height : -1;

    if (shut !== door.opaque) {
      door.opaque = shut;
      this.nav?.setSight(door.navTiles, !shut);
    }
  }
}
