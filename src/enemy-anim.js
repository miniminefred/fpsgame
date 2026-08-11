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

// How far a seated body drops, and how far its legs come up to meet the floor.
const SIT_DROP = 0.42;
const SIT_LEGS = -1.5;         // radians — straight out in front

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

  // Sitting is a state of the body, not of the AI: the moment they stop being
  // idle they are standing up, and from then on they animate like anybody
  // else. Which means nothing downstream — pathing, swinging, ragdolling —
  // ever has to know this was a thing.
  if (e.seated && e.state !== 'idle') {
    e.seated = false;
    // Everything else the seated pose touched is written every frame by the
    // walk cycle below and recovers on its own; the torso lean is not, so it
    // is the one thing that has to be put back by hand.
    e.torso.rotation.x = 0;
  }
  if (e.seated) return animateSeated(e, dt);

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
 * On the floor with their legs out in front of them, mop across the knees.
 *
 * Done by dropping the whole rig and folding the legs forward rather than by
 * authoring a second skeleton: the hip joint is already at the top of the leg
 * (see rigs.js), so rotating there is genuinely what sitting down does, and the
 * bones ragdolls.js reads are the ones it was always going to read.
 *
 * The lean is a slow breath rather than a pose held rigid — two men waiting out
 * a shift should not read as two mannequins somebody left in a cupboard.
 */
export function animateSeated(e, dt) {
  e.walkPhase += dt * 0.9;
  const breath = Math.sin(e.walkPhase) * 0.03;

  e.group.position.y = e.y - SIT_DROP;
  e.legL.rotation.x = SIT_LEGS;
  e.legR.rotation.x = SIT_LEGS - 0.12;
  e.armL.rotation.x = -0.35 + breath;
  e.armR.rotation.x = -0.5 + breath;
  e.torso.rotation.x = 0.12 + breath;
  if (e.blunt) {
    // Mop across the lap, handle out, which is where you put it when you are
    // not using it and is also why it is the first thing back in his hands.
    e.blunt.rotation.x = -1.35;
    e.blunt.position.y = 0.82;
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
