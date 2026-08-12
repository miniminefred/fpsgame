import { Euler } from 'three';
import { clamp } from './util.js';

// Keyboard state + pointer-lock overlay wiring.

// Whether the on-screen controls have taken over (set by touch.js). The mouse
// paths below stay wired but go quiet, because a tap on a phone still emits a
// synthetic mousedown/mousemove pair at the finger: leave them live and every
// tap on the HUD fires the gun, while every second tap snaps the view round to
// wherever the finger landed. Nothing here decides the mode — touch.js owns
// that, and this module only has to obey it.
let touchMode = false;
export function setTouchMode(on) { touchMode = on; }

export function createInput() {
  const keys = {
    forward: false, back: false, left: false, right: false, jump: false,
    sprint: false,
    reload: false,
    fire: false,        // trigger held — automatic weapons read this
    firePressed: false, // trigger edge — semi-auto weapons consume this
  };

  addEventListener('keydown', (e) => setKey(keys, e.code, true));
  addEventListener('keyup', (e) => setKey(keys, e.code, false));

  addEventListener('mousedown', (e) => {
    if (touchMode || e.button !== 0) return;
    keys.fire = true;
    keys.firePressed = true;
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) keys.fire = false;
  });

  // Losing focus (alt-tab mid-burst) must not leave the trigger stuck down.
  addEventListener('blur', () => {
    keys.forward = keys.back = keys.left = keys.right = false;
    keys.jump = keys.sprint = keys.reload = keys.fire = keys.firePressed = false;
  });

  return keys;
}

// Fires cb(n) for number keys 1..9 (n is zero-based: '1' -> 0). For weapon slots.
export function onDigitKeys(cb) {
  addEventListener('keydown', (e) => {
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (m) cb(Number(m[1]) - 1);
  });
}

function setKey(keys, code, down) {
  switch (code) {
    case 'KeyW': case 'ArrowUp':    keys.forward = down; break;
    case 'KeyS': case 'ArrowDown':  keys.back = down; break;
    case 'KeyA': case 'ArrowLeft':  keys.left = down; break;
    case 'KeyD': case 'ArrowRight': keys.right = down; break;
    case 'Space':                   keys.jump = down; break;
    case 'ShiftLeft': case 'ShiftRight': keys.sprint = down; break;
    case 'KeyR':                    keys.reload = down; break;
  }
}

// Wires the click-to-lock overlay and crosshair to a PointerLockControls instance.
//
// Requesting pointer lock fails more often than you'd think, and the browser
// gives no visible feedback when it does — the player clicks, nothing happens,
// and the mouse still doesn't turn the view. Two causes dominate:
//
//   * Chrome refuses a re-lock for about 1.25 s after Esc released the previous
//     one. Clicking straight back in therefore does nothing at all.
//   * A window that isn't focused can't take the lock ("WrongDocumentError").
//
// So we listen for pointerlockerror, tell the player what happened, and retry
// once the cooldown has passed rather than leaving them stuck at a dead overlay.
const RELOCK_COOLDOWN = 1400;
const LOOK_SENSITIVITY = 0.002;   // radians per pixel, matching PointerLockControls
// How far up or down the view can ever be pointed, matching what
// PointerLockControls enforces on the locked path. Exported because recoil in
// shooting.js clamps the same camera and used to do it with its own, tighter
// number: fire while looking near-vertical and the "clamp" pulled the view back
// DOWN by the difference, so the gun's kick moved the barrel toward the floor.
// One camera, one ceiling.
export const PITCH_LIMIT = Math.PI / 2 - 0.02;

// Turn the view by an angular delta, in radians. Both the no-capture mouse
// fallback below and the look pad in touch.js need exactly this, and they have
// to agree: the pitch clamp already existed twice once, and the second copy is
// what made the gun's kick point at the floor (see PITCH_LIMIT above). One
// scratch Euler is safe here where a shared Vector3 would not be, because
// setFromQuaternion overwrites all three components before anything reads them.
const lookEuler = new Euler(0, 0, 0, 'YXZ');
export function applyLook(camera, dYaw, dPitch) {
  lookEuler.setFromQuaternion(camera.quaternion);
  lookEuler.y -= dYaw;
  lookEuler.x -= dPitch;
  lookEuler.x = clamp(lookEuler.x, -PITCH_LIMIT, PITCH_LIMIT);
  camera.quaternion.setFromEuler(lookEuler);
}

export function setupPointerLock(controls, domElement) {
  const overlay = document.getElementById('overlay');
  const crosshair = document.getElementById('crosshair');
  const hint = document.getElementById('lock-hint');
  const camera = controls.object;

  let retry = 0;
  let lastX = null;
  let lastY = null;

  // `engaged` means the player has asked to play, whether or not the browser
  // actually granted mouse capture. Everything downstream keys off this rather
  // than off isLocked, so a refused lock can never leave the game unplayable.
  controls.engaged = false;

  const setEngaged = (on, fallback) => {
    controls.engaged = on;
    overlay?.classList.toggle('hidden', on);
    crosshair?.classList.toggle('visible', on);
    if (hint) hint.classList.toggle('visible', on && fallback);
    lastX = lastY = null;
  };

  const request = () => {
    if (controls.isLocked) return;
    // Engage immediately. If the lock lands, the 'lock' event confirms it; if
    // it doesn't, we are already playing in fallback look mode.
    setEngaged(true, true);
    try {
      controls.lock();
    } catch {
      // Swallowed: pointerlockerror below owns recovery.
    }
  };

  domElement.addEventListener('click', request);
  // The model harness has no overlay, so none of these elements need exist.
  overlay?.addEventListener('click', request);

  document.addEventListener('pointerlockerror', () => {
    if (controls.isLocked) return;
    clearTimeout(retry);
    // Chrome refuses a re-lock for ~1.25 s after Esc, and refuses outright when
    // the window isn't focused. Try once more, but keep playing either way.
    retry = setTimeout(() => {
      if (controls.engaged && !controls.isLocked && document.hasFocus()) {
        try { controls.lock(); } catch { /* stay in fallback */ }
      }
    }, RELOCK_COOLDOWN);
  });

  // Fallback look: with no capture there is no movementX, so turn on the delta
  // between successive cursor positions instead. Same maths as
  // PointerLockControls, so the two modes feel identical.
  addEventListener('mousemove', (event) => {
    if (touchMode || controls.isLocked || !controls.engaged) return;

    if (lastX !== null) {
      applyLook(camera,
        (event.clientX - lastX) * LOOK_SENSITIVITY,
        (event.clientY - lastY) * LOOK_SENSITIVITY);
    }
    lastX = event.clientX;
    lastY = event.clientY;
  });

  // Without a real lock there is nothing for Esc to exit, so it has to release
  // fallback mode by hand or the player has no way back to the menu.
  addEventListener('keydown', (event) => {
    if (event.code === 'Escape' && controls.engaged && !controls.isLocked) {
      clearTimeout(retry);
      setEngaged(false, false);
    }
  });

  controls.addEventListener('lock', () => {
    clearTimeout(retry);
    setEngaged(true, false);
  });
  controls.addEventListener('unlock', () => {
    clearTimeout(retry);
    setEngaged(false, false);
  });
}
