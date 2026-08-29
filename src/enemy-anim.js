import { lerp, smoothTo } from './util.js';

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
function hinge(limb, x, y, half, angle) {
  limb.rotation.x = angle;
  limb.position.set(x, y + half * (1 - Math.cos(angle)), -half * Math.sin(angle));
}

// Back to how rigs.js left them. The walk cycle writes every limb ROTATION
// every frame and so recovers on its own, but nothing else in here ever moves a
// limb, so a body that stood up out of a chair would carry the chair's hips and
// shoulders around the floor with it for the rest of the run.
function stand(e) {
  e.torso.rotation.x = 0;
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

  const moving = e.state === 'chase' || e.state === 'fight' || e.state === 'wander';
  e.walkPhase += dt * (moving ? 9 : 1.4);

  // One footfall per half stride cycle, taken off the leg animation itself so
  // the sound lands with the foot rather than on a timer of its own.
  const stride = Math.floor(e.walkPhase / Math.PI);
  if (stride !== e.lastStep) {
    e.lastStep = stride;
    if (moving) audio.enemyStep(e);
  }

  const swing = moving ? Math.sin(e.walkPhase) * 0.6 : Math.sin(e.walkPhase) * 0.05;
  e.legL.rotation.x = swing;
  e.legR.rotation.x = -swing;
  e.group.position.y = e.y + (moving ? Math.abs(Math.sin(e.walkPhase)) * 0.045 : 0);

  // Weapon comes up as soon as they mean it. Melee types instead throw both
  // arms forward on the swing and drop them again.
  const aiming = e.state === 'fight';
  if (e.swing > 0) e.swing -= dt;

  if (e.type.melee) {
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
    e.gun.position.set(0.3, aiming ? 1.32 : 1.1, aiming ? -0.55 : -0.3);
    e.gun.rotation.x = aiming ? 0 : 0.5;
  }

  tickFlash(e, dt);
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
