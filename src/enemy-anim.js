import { clamp, lerp, smoothTo } from './util.js';

// How a body moves while it is working, and how it falls over when it is not.
//
// Split out of enemies.js because none of it is about the floor: every function
// here takes the one enemy it is posing plus the frame's `dt`, touches nothing
// on the Enemies instance, and reads nothing but the rig it was handed. That is
// what makes them free functions rather than methods — the state machine decides
// what somebody is doing, and this decides what that looks like.
//
// The three durations below are written by enemies.js (`_damage` sets the flash
// and the death clock, `_shoot` starts a swing) and read here, so they live with
// the animations they time and are imported back the other way.

// Somebody in a chair at a desk. The drop puts the hip joint a few
// centimetres over the chair's seat, which is at 0.5 (see `chair` in
// gen/props.js), and the limbs then swing about a real joint — see `hinge`.
//
// A leg is one box with no knee in it, so it goes down and forward in one
// straight line to the carpet, and what makes that read as sitting rather than
// as lying down is where it ENDS: knees under the desk, which is where legs go.
// The arms are the angle that lands the hands at 0.74 — the height of the desk
// they are supposed to be resting on — and dropped into the lap on the beats
// they are not.
const DESK_DROP = 0.29;
const DESK_LEGS = 1.22;
const DESK_ARMS = 0.87;
const DESK_IDLE_ARMS = 0.4;
// Taps per radian of the body's own phase. Fast enough to be typing and small
// enough (TAP_THROW) to be wrists rather than arms.
const TAP_RATE = 13;
const TAP_THROW = 0.05;
// How much of the time a body at a desk is actually typing, as the fraction of a
// slow cycle spent above the threshold — the rest is spent looking at whatever
// it did. Off the same phase as everything else, so no body needs a clock of its
// own and no two of them are on the same beat.
const WORK_BEAT = 0.41;
const WORK_DUTY = -0.35;

// Working on something OVERHEAD: the parcel line, at 2.16 m (see jobs.js).
//
// The reach is the whole pose and it is bounded by the rig rather than chosen. An
// arm is one box with no elbow, pivoting at ARM_Y + ARM_HALF = 1.42, and its
// hand is 2 * ARM_HALF = 0.54 from that pivot — so a hand can be got to 1.96 m
// and no higher, which is a hair under the belt's own underside. That is lucky
// and it is also why this reads: the arms are at very nearly full extension, so
// the body looks like it is stretching for the thing rather than gesturing at it.
//
// `hinge`'s angle is positive toward -Z, so PI is straight up and this is a
// little past three quarters of the way there: hands at 1.87 m and 0.30 m
// forward, which is up and INTO the machine rather than up in the air.
const FIX_ARMS = 2.55;
// The two hands never work together, for the reason the typing pose gives: both
// at once is applause. One is holding whatever is being fitted while the other
// works at it, so the offset is bigger here than a typist's wrist flick.
const FIX_STAGGER = 0.30;
// The work stroke. Slower than typing — this is a spanner rather than a keyboard
// — and `FIX_DUTY` is how much of the cycle is spent actually working, the rest
// being spent looking at what it did. Off `walkPhase` like every other beat in
// this file, so no body needs a clock of its own and no two are in step.
const FIX_BEAT = 0.9;
const FIX_DUTY = -0.2;
const FIX_THROW = 0.22;
// Leaning back and looking up at it. Small on the torso for the reason the desk
// pose is small: the torso is one box with a separate collar strip in front of
// it, so a real lean opens a gap at the neck. The head can go further because it
// is a box on its own.
const FIX_LEAN = -0.13;
const FIX_LOOK = -0.42;
// Where the box goes while both hands are busy: on the floor, at his feet, off
// to one side. Half its own height, so it rests ON the floor rather than in it.
// This is most of what makes the pose legible — a body holding a box in both
// hands is a body that is plainly NOT working, whatever its arms are doing.
const FIX_BOX = [0.34, 0.13, -0.26];

// Lunch, in the canteen the floor arrives in (see _diners in enemies.js). The
// same SIT as a desk — a chair is a chair, and the hips and knees do not know
// what is on the table — so only the arms and the torso differ, and the torso is
// what does the work.
//
// An arm is one box with no elbow in it, so a hand cannot be brought to a mouth:
// swinging the shoulder further forward reaches ACROSS the table rather than up
// to the face. What reads as eating instead is the body coming DOWN to meet the
// food — a small dip on each mouthful — with one hand out at the tray and the
// other resting where it was. One hand, not both: two arms rising together is
// not eating, it is applause.
const MEAL_BEAT = 0.23;    // slower than typing. A mouthful is not a keystroke.
const MEAL_DUTY = 0.35;
const MEAL_ARMS = 0.92;    // forearms on the table, either side of the tray
const MEAL_REACH = 0.17;   // how far the eating hand goes out over it
const MEAL_DIP = 0.13;     // and how far the body comes down to meet it

// Where a crate sits if its rig never said. Nothing should reach this — every
// rig in rigs.js declares `boxAt` — and it is a person's chest height so that if
// anything ever does, it comes out carrying the box rather than wearing it.
const BOX_FALLBACK = [0, 1.02, -0.34];

// Lunch, carried. Both arms out in front and level, with the tray across them —
// a tray is the one thing in the building held in two hands, which is most of
// what makes somebody carrying one read as carrying one from across a room.
const TRAY_ARMS = -1.25;
const TRAY_CARRY = [0, 1.14, -0.44];
// ...and put down in front of them once they are sitting at it. The group is
// dropped by DESK_DROP while seated, so this is the table's own height plus it.
const TRAY_TABLE = [0, 1.03, -0.46];

// Where a limb hangs from and how long it is, in rig space. Same numbers
// rigs.js builds the body from — this file already restates the gun's and the
// mop's rest positions the same way, and unlike those two these have a check on
// them: a joint that has drifted shows up as a leg detached from its own hip.
const HIP_X = 0.12, LEG_Y = 0.43, LEG_HALF = 0.43;
const ARM_X = 0.32, ARM_Y = 1.15, ARM_HALF = 0.27;

/**
 * Swings a limb about its JOINT rather than about its own middle.
 *
 * Every part of a rig is a bare mesh (`part` in rigs.js), so `rotation.x` alone
 * turns a leg about the point half way down it. The walk cycle gets away with
 * that because the swing is a few degrees either side of standing; a sitting
 * pose does not — at 57 degrees a leg leaves a hand's width of daylight at the
 * hip and puts its foot through the floor, which is what the first version of
 * this did. Two lines of trigonometry buy a hip and a shoulder that stay where
 * the body's are: the limb is placed so its top end lands on the joint it hangs
 * off, which is its standing centre plus half its length.
 *
 * `angle` is positive toward -Z, the way the body faces, because everything in
 * a seated pose is out in front of them.
 */
function hinge(limb, x, y, half, angle, forward = 0) {
  limb.rotation.x = angle;
  limb.position.set(x, y + half * (1 - Math.cos(angle)),
    -half * Math.sin(angle) - forward);
}

/**
 * The angle that puts a standing body's hand at a height.
 *
 * An arm here is ONE box with no elbow in it, hanging from a shoulder at
 * ARM_Y + ARM_HALF and ARM_LEN long, so where the hand ends up is a single
 * cosine and there is exactly one angle that reaches any given height. Two
 * consequences worth knowing before writing a number into the table below:
 *
 *   - A standing body cannot get its hands below 0.88 m. That is shoulder minus
 *     arm, and it is well above a 0.75 m desk — which is why every pose that
 *     works at waist height carries a `stoop`, exactly as the seated pose
 *     carries `DESK_DROP`. Stooping lowers the shoulder and the hand with it.
 *   - Reaching FORWARD and reaching DOWN are the same motion. The hand is
 *     furthest out at shoulder height and directly underneath at the bottom of
 *     its arc, so a low pose has the hands tucked under the body whatever else
 *     it does. `forward` on `hinge` is what buys the rest: the shoulders come
 *     out over the work, which is what leaning over a bench actually is.
 *
 * Clamped rather than trusted, because a table entry a few centimetres outside
 * the arc would otherwise come back NaN and put the arms somewhere unrenderable.
 */
function armAt(height, stoop) {
  return Math.acos(clamp((ARM_Y + ARM_HALF - stoop - height) / (ARM_HALF * 2), -1, 1));
}

/**
 * Back to how rigs.js left them. The walk cycle writes every limb ROTATION
 * every frame and so recovers on its own, but nothing else in here ever moves a
 * limb, so a body that stood up out of a chair would carry the chair's hips and
 * shoulders around the floor with it for the rest of the run.
 *
 * Exported because `animate` is no longer the only thing that can decide a body
 * is out of its chair — the chair itself can be shot apart or shoved away (see
 * `_seatGone` in enemies.js), and that has to stand up a body which is `idle`
 * and staying `idle`, which is exactly the state the pose is held through here.
 * The rule that came with this function is unchanged: clearing `e.seat` without
 * calling it is what makes a body walk like an alien, so the two are one
 * operation and enemies.js wraps them together rather than calling this alone.
 */
export function stand(e) {
  e.torso.rotation.x = 0;
  // The stoop as well as the joints, and for the same reason: every pose that
  // works below shoulder height drops the whole group (see `armAt`), and the
  // only things that ever put it back are the two walks — so a body that stops
  // working and then stands where it is spends the rest of the floor sunk into
  // the carpet. It was already true of the seated pose's DESK_DROP and was only
  // ever hidden by the fact that the two bodies who sit down get up and walk.
  e.group.position.y = e.y;
  // The head too, since `animateFixing` tilts it to look at what it is doing and
  // nothing else in this file ever touches it. Same rule as the limbs: the walk
  // cycle rewrites rotations it owns every frame and recovers on its own, and a
  // rotation nothing owns stays exactly where it was left.
  if (e.head) e.head.rotation.x = 0;
  hinge(e.legL, -HIP_X, LEG_Y, LEG_HALF, 0);
  hinge(e.legR, HIP_X, LEG_Y, LEG_HALF, 0);
  hinge(e.armL, -ARM_X, ARM_Y, ARM_HALF, 0);
  hinge(e.armR, ARM_X, ARM_Y, ARM_HALF, 0);
}

export const DEATH_TIME = 2.2;
export const HIT_FLASH = 0.1;
export const SWING_TIME = 0.5;    // wind-up plus follow-through on a melee swing

// The white going out of a body that was just hit. Every rig ticks it the same
// way and each one used to carry its own copy of these four lines.
function tickFlash(e, dt) {
  if (e.hitFlash > 0) {
    e.hitFlash -= dt;
    const k = Math.max(0, e.hitFlash / HIT_FLASH);
    for (const m of e.flash) m.emissive.setScalar(k * 0.9);
  }
}

export function animate(e, dt, audio) {
  if (e.rig === 'rat') return animateRat(e, dt, audio);
  if (e.rig === 'roomba') return animateRoomba(e, dt, audio);

  // Sitting is a state of the body, not of the AI: once they are up they animate
  // like anybody else, which means nothing downstream — pathing, swinging,
  // ragdolling — ever has to know this was a thing.
  //
  // They hold the pose through `alert` as well as `idle`, and that is the whole
  // reason a floor at work is visible in play at all. A shut door is what stops
  // them seeing you (`nav.losClear` in nav.js), so the frame the panel opens is
  // the frame the room notices — get up on the sight of you and the pose exists
  // for one frame of a floor you will never see it on again. `alert` is already
  // the reaction delay before the chase and a body in it can neither move nor
  // shoot (see _move and _shoot in enemies.js), so spending it in the chair
  // costs the fight nothing and buys the beat: three people working, three
  // people turning round, then the fight.
  if (e.seat && e.state !== 'idle' && e.state !== 'alert') {
    e.seat = null;
    stand(e);
  }
  // Two seats now: a desk somebody is working at, and a canteen table somebody
  // is having their lunch at. Which one a body is in is `e.seat` — see _seat in
  // enemies.js — and it is the same pose from the hips down either way.
  if (e.seat) return e.seat === 'table' ? animateEating(e, dt) : animateWorking(e, dt);

  // Working on the parcel line overhead (see jobs.js). Checked after the seats
  // and before the walk cycle, because it is the same kind of thing as a seated
  // pose — a body that is standing still doing something — and like those it
  // returns rather than falling through, so the walk cycle never writes over the
  // arms. Guarded on the rig because only the human roster has limbs to hinge:
  // if a chassis is ever cast as the fixer it simply stands there as before,
  // which is wrong-looking rather than broken.
  if (e.working && e.armL && e.legL) return animateFixing(e, dt);

  // ...and the ordinary work, at a printer or a bench or a rack (see chores.js).
  // Same place in the order and the same guard, for the same two reasons: it is
  // a body standing still doing something, and only the human roster has limbs
  // whose joints these constants describe — a chassis's shoulder is not at
  // 1.42 m, so a machine cast for one of these would come out with its arms
  // hanging off it. `pose` is null while they are still walking there, which is
  // what leaves the walk cycle in charge of the walk.
  if (e.chore?.pose && e.rig === 'human') return animateChore(e, dt);

  const moving = e.state === 'chase' || e.state === 'fight' || e.state === 'wander';
  e.walkPhase += dt * (moving ? 9 : 1.4);

  // One footfall per half stride cycle, taken off the leg animation itself so
  // the sound lands with the foot rather than on a timer of its own. A wheel and
  // a set of fans have no footfall to land: they are the two drives with nothing
  // in the sound set, and silence is the honest answer rather than a step clip
  // played at something that never lifts a foot.
  const stride = Math.floor(e.walkPhase / Math.PI);
  if (stride !== e.lastStep) {
    e.lastStep = stride;
    if (moving && (e.drive === 'legs' || e.drive === 'tracks')) audio.enemyStep(e);
  }

  const swing = moving ? Math.sin(e.walkPhase) * 0.6 : Math.sin(e.walkPhase) * 0.05;
  drive(e, dt, moving, swing);

  // Weapon comes up as soon as they mean it. Melee types instead throw both
  // arms forward on the swing and drop them again.
  const aiming = e.state === 'fight';
  if (e.swing > 0) e.swing -= dt;

  if (e.tray || e.carry) {
    // Carrying something in both hands, and it wins over both branches below
    // rather than sitting beside them: a body on its break has put the sidearm
    // away and stopped swinging whatever was on its desk (see _lunch in
    // enemies.js), and a body on a parcel run never had either out. So there is
    // nothing for the melee pose to be about.
    //
    // A crate rides the tray's pose because a crate is the other thing in this
    // building held in two hands — except on a rig that carries it on a deck,
    // which is what `boxArms` says.
    const k = smoothTo(10, dt);
    if (e.tray || e.boxArms !== false) {
      e.armL.rotation.x = lerp(e.armL.rotation.x, TRAY_ARMS, k);
      e.armR.rotation.x = lerp(e.armR.rotation.x, TRAY_ARMS, k);
    }
    if (e.carry) {
      const at = e.boxAt ?? BOX_FALLBACK;
      e.carry.rotation.x = 0;
      // Bobs with the stride a shade harder than a tray does. A tray is carried
      // by somebody who does not want to spill it; a box is just heavy.
      e.carry.position.set(at[0], at[1] + Math.sin(e.walkPhase) * 0.015, at[2]);
    }
    if (e.tray) {
      e.tray.rotation.x = 0;
      // Bobs with the stride, the way anything held does. Small: a tray carried
      // by somebody who does not want to drop it does not swing.
      e.tray.position.set(TRAY_CARRY[0], TRAY_CARRY[1] + Math.sin(e.walkPhase) * 0.012,
        TRAY_CARRY[2]);
    }
  } else if (e.type.melee) {
    // Wind up behind the head, then bring it down hard. The weapon rides the
    // right arm so the two read as one motion.
    const winding = e.swing > SWING_TIME * 0.55;
    const arm = e.swing > 0 ? (winding ? 1.5 : -2.4) : (aiming ? -0.9 : -swing * 0.5);
    const k = smoothTo(e.swing > 0 ? 24 : 9, dt);
    e.armL.rotation.x = lerp(e.armL.rotation.x, arm * 0.6, k);
    e.armR.rotation.x = lerp(e.armR.rotation.x, arm, k);
    if (e.blunt) {
      // Held out in front while it is being used, and carried the way its own
      // kind is carried the rest of the time — which for a mop is dragging,
      // head on the floor. See BLUNT in rigs.js.
      const want = e.swing > 0 || aiming ? arm + 0.5 : e.bluntRest;
      e.blunt.rotation.x = lerp(e.blunt.rotation.x, want, k);
      e.blunt.position.y = 1.12 + Math.sin(e.walkPhase) * 0.02;
    }
  } else {
    const armX = aiming ? -1.45 : swing * -0.5;
    e.armL.rotation.x = lerp(e.armL.rotation.x, aiming ? -1.2 : -swing * 0.5, smoothTo(10, dt));
    e.armR.rotation.x = lerp(e.armR.rotation.x, armX, smoothTo(10, dt));
    // Where the hand is, asked of the rig rather than written down here. These
    // were the human's own two numbers, which held for every body in the
    // building until one of them was a drone.
    const at = aiming ? e.gunAim : e.gunRest;
    e.gun.position.set(at[0], at[1], at[2]);
    e.gun.rotation.x = aiming ? 0 : 0.5;
  }

  tickFlash(e, dt);
}

// How fast a warning beacon goes round, and how far down it dips between
// passes. Never to nothing: a lamp that goes fully dark reads as a broken lamp
// rather than as a rotating one.
const BEACON = 0xffa42c;
const BEACON_RATE = 1.6;
const BEACON_FLOOR = 0.34;

/**
 * The bottom half of a body: whatever it gets about on, plus the parts of a
 * machine that are always moving.
 *
 * Four drives, and the split is what a chassis is FOR rather than a graphics
 * setting — see CHASSIS in rigs.js. A leg swing on a wheel is a wheel waving,
 * and a gun platform on tracks that bobs as it comes down a corridor is a gun
 * platform with a limp.
 */
function drive(e, dt, moving, swing) {
  switch (e.drive) {
    case 'wheels':
      // Rolled rather than swung, and off its own accumulator rather than off
      // `walkPhase`: the phase carries an idle sway that everything with legs
      // wants, and a wheel turning while the thing it is under is standing
      // still is the one thing a wheel must never do.
      e.legL.rotation.x += dt * (moving ? 7.5 : 0);
      e.legR.rotation.x = e.legL.rotation.x;
      e.group.position.y = e.y;
      break;

    case 'tracks':
      // Nothing moves, and that is the point of it. It is the one thing on the
      // floor that arrives at the same height it left at.
      e.group.position.y = e.y;
      break;

    case 'hover':
      // It is authored a metre and a quarter up (see the drone in CHASSIS), so
      // flying is one sine on top of that and the rotors doing the arguing.
      e.group.position.y = e.y + Math.sin(e.walkPhase * 0.55) * 0.05;
      if (e.rotors) for (const r of e.rotors) r.rotation.y += dt * (moving ? 46 : 30);
      break;

    default:
      e.legL.rotation.x = swing;
      e.legR.rotation.x = -swing;
      e.group.position.y = e.y + (moving ? Math.abs(Math.sin(e.walkPhase)) * 0.045 : 0);
  }

  if (e.beaconMat) {
    const k = BEACON_FLOOR + (1 - BEACON_FLOOR) * Math.max(0, Math.sin(e.walkPhase * BEACON_RATE));
    e.beaconMat.color.setHex(BEACON).multiplyScalar(k);
  }
}

/**
 * At a desk, doing the job. The one pose in the game that is meant to be seen
 * from behind: a floor of offices with somebody at a monitor in three of them is
 * a building at work, and the same floor with everybody standing in the middle of
 * their own carpet facing nothing is a shooting gallery waiting to start.
 *
 * What sells it is not the pose, it is that the pose MOVES — and that no two
 * bodies move together. Both beats run off `walkPhase`, which every body is
 * seeded with a different value of (see _add in enemies.js), so a farm of forty
 * cubicles is forty people at forty different moments of typing, pausing and
 * breathing without a single extra number being stored.
 *
 * The gun goes to the hip rather than being hidden. `animate` rewrites its
 * position every frame for anybody on their feet and never gets the chance here,
 * so left alone it hangs in the air where a standing body's hand would be; put
 * at the hip it reads as the holster it should have been in all along, and there
 * is nothing to restore when they stand up.
 */
export function animateWorking(e, dt) {
  e.walkPhase += dt;
  const typing = Math.sin(e.walkPhase * WORK_BEAT) > WORK_DUTY;
  const tap = typing ? Math.sin(e.walkPhase * TAP_RATE) * TAP_THROW : 0;
  const breath = Math.sin(e.walkPhase) * 0.025;
  const arms = typing ? DESK_ARMS : DESK_IDLE_ARMS;

  e.group.position.y = e.y - DESK_DROP;
  hinge(e.legL, -HIP_X, LEG_Y, LEG_HALF, DESK_LEGS);
  hinge(e.legR, HIP_X, LEG_Y, LEG_HALF, DESK_LEGS - 0.08);
  // The two hands never land together: one wrist up while the other is down is
  // typing, and both at once is applause.
  hinge(e.armL, -ARM_X, ARM_Y, ARM_HALF, arms + tap);
  hinge(e.armR, ARM_X, ARM_Y, ARM_HALF, arms - tap);
  // Forward over the keyboard while they are working, back in the chair while
  // they are not. Small either way: the torso is one box and the collar strip in
  // front of it is a separate one, so a real lean opens a gap at the neck.
  e.torso.rotation.x = (typing ? 0.16 : 0.02) + breath;

  if (e.blunt) {
    // Whatever they will swing at you is on the desk in front of them, which for
    // an intern holding a keyboard is exactly where it lives anyway.
    e.blunt.rotation.x = -0.1;
    e.blunt.position.y = 1.04;
  } else {
    e.gun.position.set(0.3, 1.0, -0.08);
    e.gun.rotation.x = 1.25;
  }

  tickFlash(e, dt);
}

/**
 * Both hands up in a machine, fitting something into it.
 *
 * The pose is the answer to "he is just standing there holding a box", which is
 * what the repair looked like before this existed: the crate stayed in his arms
 * for the whole fifteen seconds, and a body carrying something in two hands is
 * the clearest possible statement that it is NOT working. So the box goes down
 * at his feet and the hands go up.
 *
 * Everything here is one of the two things this file already knows how to do —
 * `hinge` for a real joint rotation (an arm swung on `rotation.x` alone turns
 * about its own middle, which at this angle leaves a hand's width of daylight at
 * the shoulder), and a beat read off `walkPhase` so no body needs a clock and no
 * two of them are in step. `stand` puts the limbs back, and clearing `working`
 * without calling it is the same bug the chair documents at length — which is
 * why `setWorking` in enemies.js is the only thing that clears the flag.
 */
export function animateFixing(e, dt) {
  e.walkPhase += dt;
  const working = Math.sin(e.walkPhase * FIX_BEAT) > FIX_DUTY;
  // Eased rather than switched, so the arms come down between strokes instead of
  // snapping. The stroke itself is fast; the settle back is not.
  const throwK = working ? Math.sin(e.walkPhase * 7) * FIX_THROW : -0.35;
  const breath = Math.sin(e.walkPhase * 1.6) * 0.02;

  hinge(e.legL, -HIP_X, LEG_Y, LEG_HALF, 0);
  hinge(e.legR, HIP_X, LEG_Y, LEG_HALF, 0);
  hinge(e.armL, -ARM_X, ARM_Y, ARM_HALF, FIX_ARMS + throwK + FIX_STAGGER);
  hinge(e.armR, ARM_X, ARM_Y, ARM_HALF, FIX_ARMS - throwK);
  e.torso.rotation.x = FIX_LEAN + breath;
  // Looking at what his hands are doing, which is above and in front of him.
  if (e.head) e.head.rotation.x = FIX_LOOK;

  // The box, on the floor beside him. It was carried here; it is being fitted.
  if (e.carry) {
    e.carry.position.set(FIX_BOX[0], FIX_BOX[1], FIX_BOX[2]);
    e.carry.rotation.x = 0;
    // Set down at an angle, because nothing anybody puts down lands square.
    e.carry.rotation.y = 0.22;
  }

  // Nothing in his hands but the job. A sidearm is already hidden on a neutral
  // (see gun.visible in rigs.js) but a hostile could in principle be doing this,
  // and a pistol floating where a standing hand used to be is the artefact the
  // lunch pose had to fix too.
  if (e.gun) e.gun.position.set(0.26, 0.92, 0.05);
  if (e.blunt) e.blunt.position.set(0.26, 0.92, 0.05);

  tickFlash(e, dt);
}

/**
 * ---------------------------------------------------------------------------
 * The ordinary work: one body, standing at one machine. See chores.js.
 * ---------------------------------------------------------------------------
 *
 * Six jobs and one function, the way `TYPES` is one rig and a table of numbers —
 * because six hand-written poses is six places for the arms to end up somewhere
 * nobody meant, and because what actually distinguishes a man at a printer from
 * a man at a server rack is four numbers: how high his hands are, how far he is
 * leaning into it, how fast he is working and whether he is looking up or down.
 *
 * THE POSES ARE ALL STANDING, and that is a rule rather than a coincidence. A
 * chair in this building means harmless (see the note on workstations in
 * CLAUDE.md) and these bodies are not: a hostile at a machine is somebody with
 * their back to you who has not looked up yet, and the frame they do, the job is
 * off (see `_choreWork` in enemies.js). Sitting one of them down would be making
 * the one promise the game keeps and then breaking it.
 *
 * Every height below is a real measurement off the prop in gen/props.js — a
 * copier's control panel at 1.0, a vending machine's keypad at 0.9 to 1.5, a
 * rack's units from 0.18 to 2.05, a bench top at 0.9, a desk at 0.75 — and the
 * angle that reaches it is SOLVED (`armAt`) rather than typed, so a prop that
 * changes height moves the hands that work on it.
 *
 *   hands    where the hands go, in metres off the floor
 *   stoop    how far the whole body drops to get them there. Anything under
 *            0.88 m needs one: see `armAt`.
 *   reach    how far the shoulders come forward over the work
 *   lean     the torso, and `look` the head — positive is down
 *   beat     the slow cycle: how much of the time they are working rather than
 *            looking at what they did, off `duty`
 *   rate     the fast one, which is the stroke itself, and `throw` its size
 *   stagger  how far apart the two hands work. Both together is applause, which
 *            is the note the typing pose and the belt pose both make.
 *   rest     how far the arms fall between strokes
 */
const CHORE_POSE = {
  // Standing at somebody's monitor. The fastest, smallest motion of the six —
  // it is a keyboard — and the one that needs the deepest stoop, because a desk
  // is the lowest thing in the building anybody works at.
  computer: {
    hands: 0.82, stoop: 0.12, reach: 0.16, lean: 0.20, look: 0.22,
    beat: 0.42, duty: -0.35, rate: 12, throw: 0.055, stagger: 0.05, rest: 0.30,
  },
  // At the copier's control panel, which is a machine you press and then wait
  // for: the slowest duty cycle here, and mostly one hand.
  printer: {
    hands: 1.06, stoop: 0, reach: 0.12, lean: 0.10, look: 0.20,
    beat: 0.55, duty: 0.15, rate: 4.5, throw: 0.10, stagger: 0.34, rest: 0.55,
  },
  // ...and taking the paper out of the tray, which is the beat that says the
  // machine did something. Down at 0.66 m, so the body goes down to meet it.
  printerTake: {
    hands: 0.80, stoop: 0.17, reach: 0.14, lean: 0.34, look: 0.42,
    beat: 1.1, duty: -0.6, rate: 3, throw: 0.09, stagger: 0.30, rest: 0.12,
  },
  // A keypad at chest height, worked with one hand while the other stays down.
  vending: {
    hands: 1.30, stoop: 0, reach: 0.16, lean: 0.04, look: 0.10,
    beat: 0.7, duty: 0, rate: 3.5, throw: 0.13, stagger: 0.62, rest: 0.45,
  },
  // ...and bending to the collection slot at 0.16 to 0.36, which is the whole
  // joke of this one: whatever else the building is doing, somebody is getting a
  // can of something out of a machine in the corridor.
  vendingTake: {
    hands: 0.56, stoop: 0.33, reach: 0.20, lean: 0.52, look: 0.50,
    beat: 1.3, duty: -0.7, rate: 2.6, throw: 0.07, stagger: 0.24, rest: 0.10,
  },
  // At the front of a rack, hands up among the units. Head back a little,
  // because everything worth looking at on a 2 m rack is above eye level.
  server: {
    hands: 1.45, stoop: 0, reach: 0.14, lean: -0.06, look: -0.16,
    beat: 0.62, duty: -0.1, rate: 5, throw: 0.14, stagger: 0.26, rest: 0.50,
  },
  // Building something on the bench: the firmest stroke of the six, both hands
  // in it, leaning over the work and looking straight down at it.
  bench: {
    hands: 0.98, stoop: 0.10, reach: 0.20, lean: 0.30, look: 0.40,
    beat: 0.8, duty: -0.25, rate: 6.5, throw: 0.20, stagger: 0.22, rest: 0.34,
  },
  // Arms into a hole in the wall (see panels.js). The highest of the six and the
  // nearest to the belt repair it is a sibling of — arms close to full
  // extension, head up, watching what his hands are doing.
  panel: {
    hands: 1.62, stoop: 0, reach: 0.12, lean: -0.12, look: -0.34,
    beat: 0.85, duty: -0.2, rate: 6, throw: 0.20, stagger: 0.30, rest: 0.42,
  },
};

/**
 * One frame of somebody at a machine.
 *
 * Structurally the same animation as `animateFixing` — a stroke off `walkPhase`
 * so no body needs a clock of its own and no two of them are in step, `hinge` so
 * a limb turns about a real joint, `stand` to put it all back — with the numbers
 * that differ read off the table instead of written into the function.
 *
 * The pose key lives on `e.chore.pose` and is null while they are still walking
 * to the machine, which is what leaves the walk cycle in charge of the walk.
 */
export function animateChore(e, dt) {
  const p = CHORE_POSE[e.chore.pose] ?? CHORE_POSE.printer;
  e.walkPhase += dt;

  const working = Math.sin(e.walkPhase * p.beat) > p.duty;
  // Eased rather than switched: the stroke is fast and the settle back between
  // strokes is not, which is the difference between working and twitching.
  const swing = working ? Math.sin(e.walkPhase * p.rate) * p.throw : -p.rest;
  const breath = Math.sin(e.walkPhase * 1.6) * 0.02;
  const arm = armAt(p.hands, p.stoop);

  // Stooping is the body going down to the work, so it moves the whole group —
  // the same thing DESK_DROP does for a chair, and `stand` is what puts it back.
  e.group.position.y = e.y - p.stoop;
  hinge(e.legL, -HIP_X, LEG_Y, LEG_HALF, 0);
  hinge(e.legR, HIP_X, LEG_Y, LEG_HALF, 0);
  hinge(e.armL, -ARM_X, ARM_Y, ARM_HALF, arm + swing + p.stagger, p.reach);
  hinge(e.armR, ARM_X, ARM_Y, ARM_HALF, arm - swing, p.reach);
  e.torso.rotation.x = p.lean + breath;
  if (e.head) e.head.rotation.x = p.look;

  // Nothing in his hands but the job. A neutral's sidearm is already hidden (see
  // gun.visible in rigs.js) and a hostile's is not, and a pistol left floating
  // where a standing hand used to be is the artefact both the lunch pose and the
  // belt repair had to fix as well.
  if (e.gun) e.gun.position.set(0.26, 0.92, 0.05);
  if (e.blunt) e.blunt.position.set(0.26, 0.92, 0.05);

  tickFlash(e, dt);
}

/**
 * At a table, having lunch. Everything the desk pose says about beats applies
 * here — both run off `walkPhase`, which every body is seeded a different value
 * of, so a canteen of five is five people at five different moments of a meal
 * without one extra number being stored.
 *
 * Which hand eats is decided by where the body is STANDING, not rolled: it has
 * to be stable for the life of the run or a diner swaps hands every frame, and
 * it has to come out the same in both browsers of a co-op session — and the
 * floor, and so the chair, and so the body's position, is generated from the
 * same seed on both ends. A cheap hash of the coordinates is all of that for
 * free, where a random number would need storing and sending.
 */
export function animateEating(e, dt) {
  e.walkPhase += dt;
  const bite = Math.sin(e.walkPhase * MEAL_BEAT) > MEAL_DUTY;
  // Eased rather than switched, or the body snaps up and down like a nodding toy.
  const dip = bite ? (0.5 - Math.cos(e.walkPhase * 2.6) * 0.5) : 0;
  const breath = Math.sin(e.walkPhase) * 0.025;
  const lefty = ((Math.abs(e.x) * 71 + Math.abs(e.z) * 131) | 0) % 2 === 0;

  e.group.position.y = e.y - DESK_DROP;
  hinge(e.legL, -HIP_X, LEG_Y, LEG_HALF, DESK_LEGS);
  hinge(e.legR, HIP_X, LEG_Y, LEG_HALF, DESK_LEGS - 0.08);
  hinge(e.armL, -ARM_X, ARM_Y, ARM_HALF, MEAL_ARMS + (lefty ? dip * MEAL_REACH : 0));
  hinge(e.armR, ARM_X, ARM_Y, ARM_HALF, MEAL_ARMS + (lefty ? 0 : dip * MEAL_REACH));
  // Down to the food and back up to chew. Kept small for the reason the desk
  // pose keeps its lean small: the torso is one box and the collar strip in
  // front of it is another, so a real fold opens a gap at the neck.
  e.torso.rotation.x = 0.06 + dip * MEAL_DIP + breath;

  // The tray goes ON the table rather than staying in their hands, which is the
  // whole difference between eating and holding lunch. It is put where the
  // reach above is aimed, so the hand that dips is the hand that dips at it.
  if (e.tray) {
    e.tray.position.set(TRAY_TABLE[0], TRAY_TABLE[1], TRAY_TABLE[2]);
    // Level with the table, not with the body: the torso leans in to eat and
    // the tray does not lean with it.
    e.tray.rotation.x = -e.torso.rotation.x;
  }

  // Nothing in a hand — a diner is neutral, so the rig never showed them a gun
  // (see rigs.js) — but a blunt is still possible if anything melee is ever sat
  // down at a table, and left alone it hangs in the air where a standing hand
  // would be.
  if (e.blunt) {
    e.blunt.rotation.x = -0.1;
    e.blunt.position.y = 1.04;
  }

  tickFlash(e, dt);
}

/**
 * Four legs, a nose and a tail. The legs run at four times a person's cadence
 * because the stride is a tenth as long, and the tail is driven one segment
 * behind the next so a single sine wave at the root travels down it.
 *
 * When it stops it does not stand still: the nose keeps working. That twitch
 * is the difference between a rat that has paused and a prop that has frozen.
 */
export function animateRat(e, dt, audio) {
  const moving = e.moving !== false && e.darting !== false;
  e.walkPhase += dt * (moving ? 34 : 3);

  const stride = Math.floor(e.walkPhase / Math.PI);
  if (stride !== e.lastStep) {
    e.lastStep = stride;
    // Every fourth footfall: at this cadence one clip per step is a machine
    // gun of tiny claws.
    if (moving && (stride & 3) === 0) audio.enemyStep(e);
  }

  const gait = Math.sin(e.walkPhase);
  if (e.legs) {
    const swing = moving ? gait * 0.9 : 0;
    e.legs[0].rotation.x = swing;
    e.legs[1].rotation.x = -swing;
    e.legs[2].rotation.x = -swing;
    e.legs[3].rotation.x = swing;
  }

  // Body bobs with the gait; nose dips and lifts when it has stopped to think.
  e.group.position.y = e.y + (moving ? Math.abs(gait) * 0.018 : 0);
  e.head.rotation.x = moving ? gait * 0.08 : Math.sin(e.walkPhase * 2.2) * 0.16;

  if (e.tail) {
    let link = e.tail;
    for (let i = 0; i < 3 && link; i++) {
      link.rotation.y = Math.sin(e.walkPhase * 0.7 - i * 0.9) * (moving ? 0.34 : 0.12);
      if (i === 0) link.rotation.x = -0.5;   // carried clear of the floor
      link = link.children.find((c) => c.isGroup);
    }
  }

  tickFlash(e, dt);
}

/**
 * The floor cleaner: a brush that turns, a status light, and a motor you can
 * hear from the next room. There is no gait to animate — it slides, because
 * that is what it does.
 *
 * The motor is a positional loop rather than a repeated clip: this thing runs
 * continuously for as long as the floor lasts, and a one-shot retriggered
 * forever would chop on every seam.
 */
export function animateRoomba(e, dt, audio) {
  if (e.brush) e.brush.rotation.y += dt * 9;

  if (!e.motor) e.motor = audio.startMotor(e);
  else audio.moveMotor(e.motor, e.x, 0.1, e.z);

  tickFlash(e, dt);
}

// Topple forward, then sink through the floor and disappear.
//
// This is now the fallback rather than the usual case — a body that got a
// ragdoll is ragdolls.js's from the moment it stopped breathing, and touching
// its group here would fight the solver for it. It stays because a ragdoll is
// allowed to be refused, and a floor with no physics has to keep working.
export function die(e, dt) {
  if (e.ragdoll) return;
  if (e.deathTime <= 0) return;
  e.deathTime -= dt;

  const k = 1 - e.deathTime / DEATH_TIME;
  e.group.rotation.x = Math.min(Math.PI / 2, k * 4);
  e.mats.visor.color.setRGB(0.25 * (1 - k), 0.05, 0.04);

  if (k > 0.75) {
    const sink = (k - 0.75) / 0.25;
    e.group.position.y = e.y - sink * 1.2;
  }
  if (e.deathTime <= 0) e.group.visible = false;
}
