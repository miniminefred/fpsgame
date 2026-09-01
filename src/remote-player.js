import { buildRig } from './rigs.js';
import { animate, die, DEATH_TIME, HIT_FLASH } from './enemy-anim.js';
import { angleLerp, smoothTo } from './util.js';
import { EYE } from './metrics.js';

// The other player, as seen from this browser.
//
// It is a body built out of the same parts as everybody else on the floor, and
// that is deliberate rather than lazy: `rigs.js` already knows how tall a person
// is and `enemy-anim.js` already knows what one looks like walking, aiming and
// falling over. Writing a second skeleton for the one body that is a player
// would be a second answer to a question that has one — and the animation is the
// half that would rot, because the staff's walk cycle gets retuned and the
// player's would not.
//
// So this file is the difference between a teammate and a member of staff, and
// there are only four things in it:
//
//   * WHAT THEY LOOK LIKE. High-visibility orange, and a CYAN visor. The visor
//     is the game's whole threat language — one grey ramp for the hostile staff,
//     green for the Reanimated, an actual colour for the harmless ones — so a
//     teammate needs a hue that is not in it anywhere. Cyan is the HUD accent
//     and appears on no body in the building, which makes "that is a player"
//     answerable down a dark corridor, which is where it matters.
//   * HOW THEY MOVE. Packets arrive a dozen times a second, frames sixty times,
//     so the body is pulled toward the last reported position rather than written
//     to it. See `apply`.
//   * WHAT THEY ARE DOING. Three of the staff's own states, chosen off the two
//     flags the wire carries: firing brings the gun up, moving swings the legs.
//   * THAT THEY ARE NOT SHOOTABLE. Nothing here ever goes into
//     `shooting.hittables`, so a round passes through your friend. No friendly
//     fire, and no rounds spent on the man standing in the doorway with you.

const TEAMMATE = {
  // Everything `buildHuman` in rigs.js reads. `pants` is what switches the rig
  // from "a suit with a shirt front" to a uniform, which is the read we want: a
  // player is not staff.
  scale: 1,
  suit: 0xd8631f,     // the collar and the shirt front over the trousers
  shirt: 0xf07d22,    // high-visibility orange — the torso
  pants: 0x2b3138,    // dark work trousers
  visor: 0x7fd8e8,    // the accent, and on nobody else in the building
  melee: false,
  rig: 'human',
  // No `voice`, so their footsteps fall back to the ordinary step clip and none
  // of the vocal sets ever apply — a teammate does not gobble at you.
};

// How hard the body is pulled toward the last position the wire gave it, and how
// far behind it has to be before it is put there outright instead. The snap
// covers a descent, a restart, and a spell where packets stopped arriving.
const POSE_RATE = 16;
const POSE_SNAP = 4;

// Above this speed the legs are swinging. Measured from the interpolated
// position rather than sent, because it is a fact about the body on screen: a
// flag that said "moving" while the position it was moving toward had not
// arrived yet is a body running on the spot.
const WALK_SPEED = 0.35;

// How long the gun stays up after their last shot. Long enough that a burst does
// not flicker between poses, short enough that they lower it when the fight is
// over.
const AIM_HOLD = 1.1;

export class RemotePlayer {
  constructor(scene) {
    this.scene = scene;
    // Its own deterministic-enough stream: the only thing `buildRig` draws from
    // it for a non-melee human is the initial facing, which is overwritten on
    // the first packet.
    const rig = buildRig(TEAMMATE, stubRng());

    // Everything below the line is the shape `animate` and `die` expect of a
    // body. It is not an enemy — nothing routes, thinks or shoots — but it is
    // posed by the same two functions, so it has to answer the same questions.
    this.body = {
      ...rig,
      type: TEAMMATE,
      x: 0, y: 0, z: 0, yaw: 0,
      state: 'idle',
      alive: true,
      seat: null,          // never: the other player is not one of the staff
      walkPhase: 0,
      lastStep: 0,
      hitFlash: 0,
      deathTime: 0,
      swing: 0,
      swingLanded: true,
      ragdoll: false,
      motor: null,
      bluntReach: 0,
      bluntRest: 0.5,
    };

    // Where the last packet put them. Separate from the body's own position,
    // which is what is drawn and always chasing this.
    this.netX = 0; this.netZ = 0; this.netY = 0; this.netYaw = 0;
    this.health = 100;
    this.maxHealth = 100;
    this.aim = 0;
    this.fresh = false;     // has a packet ever arrived
    this.visible = false;

    this.body.group.visible = false;
    scene.add(this.body.group);
  }

  /** Their eye height, for anything measuring line of sight to them. */
  get eyeY() { return this.body.y + EYE; }

  /**
   * A position packet. `moving` and `dead` are theirs to declare; whether the
   * legs actually swing is decided here, off what the body on screen is doing.
   */
  apply({ x, y, z, yaw, health, dead, firing, hidden = false }) {
    // Their T toggle, which only their own browser knows about. It has to cross
    // or the host's roster goes on chasing a joiner who has been told they are
    // invisible — the one end that decides what the staff do is not the end the
    // key was pressed on. See `hidden` in player.js.
    this.body.hidden = hidden;
    this.netX = x;
    this.netY = y;
    this.netZ = z;
    this.netYaw = yaw;
    this.health = health;
    if (firing) this.aim = AIM_HOLD;

    if (!this.fresh) {
      // First packet of a session or of a floor: appear where they are rather
      // than walking in from the origin.
      this.fresh = true;
      this.body.x = x; this.body.y = y; this.body.z = z; this.body.yaw = yaw;
    }

    if (dead && this.body.alive) this._kill();
    else if (!dead && !this.body.alive) this.revive();
  }

  /** They took a hit. Whitens the same materials a shot staff member whitens. */
  flash() { this.body.hitFlash = HIT_FLASH; }

  /** Off the floor, or out of the session. */
  hide() {
    this.visible = false;
    this.fresh = false;
    this.body.group.visible = false;
  }

  /** Back on a floor: upright, unhidden, and wherever the next packet says. */
  revive() {
    const b = this.body;
    b.alive = true;
    b.deathTime = 0;
    b.ragdoll = false;
    b.group.rotation.x = 0;
    b.mats.visor.color.set(TEAMMATE.visor);
    this.fresh = false;
  }

  _kill() {
    const b = this.body;
    b.alive = false;
    // The staff's own toppling fallback rather than a ragdoll. A ragdoll would
    // need the solver to agree with the other browser about where a body landed,
    // and it would not: this is a corpse you walk past, not one you are fighting
    // over. Same reason `enemies.js` keeps the animation as its fallback.
    b.deathTime = DEATH_TIME;
  }

  update(dt, audio) {
    const b = this.body;
    if (!this.fresh) return;

    if (!this.visible) {
      this.visible = true;
      b.group.visible = true;
    }

    const before = { x: b.x, z: b.z };
    if (Math.hypot(this.netX - b.x, this.netZ - b.z) > POSE_SNAP) {
      b.x = this.netX; b.z = this.netZ; b.y = this.netY; b.yaw = this.netYaw;
    } else {
      const k = smoothTo(POSE_RATE, dt);
      b.x += (this.netX - b.x) * k;
      b.z += (this.netZ - b.z) * k;
      b.y += (this.netY - b.y) * k;
      b.yaw = angleLerp(b.yaw, this.netYaw, k);
    }

    if (this.aim > 0) this.aim -= dt;

    if (b.alive) {
      // Three of the staff's states, and the mapping is the whole animation:
      // `fight` is the pose with the gun up, `chase` is the walk cycle with the
      // footsteps on it, `idle` is standing about. Speed is measured rather than
      // declared — see WALK_SPEED.
      const speed = Math.hypot(b.x - before.x, b.z - before.z) / Math.max(dt, 1e-4);
      b.state = this.aim > 0 ? 'fight' : speed > WALK_SPEED ? 'chase' : 'idle';
      b.group.position.set(b.x, b.y, b.z);
      b.group.rotation.y = b.yaw;
      animate(b, dt, audio);
    } else {
      // Falling over, then sinking through the floor, exactly as anybody else on
      // the floor does. `die` writes the group's position itself.
      b.group.position.set(b.x, b.y, b.z);
      b.group.rotation.y = b.yaw;
      die(b, dt);
    }
  }

  dispose() {
    this.scene.remove(this.body.group);
    for (const m of Object.values(this.body.mats)) m.dispose();
    for (const g of this.body.ownGeo) g.dispose();
  }
}

// `buildRig` wants an rng and, for a plain human, spends it on one thing: the
// facing the body starts at, which the first packet overwrites. Rather than
// borrow the floor's stream — which is seeded, shared, and must not be advanced
// by anything that is not the floor — it gets a fixed one.
function stubRng() {
  const rng = () => 0.5;
  rng.int = (min) => min;
  rng.range = (min) => min;
  rng.pick = (arr) => arr[0];
  rng.chance = () => false;
  rng.shuffle = (arr) => arr;
  return rng;
}
