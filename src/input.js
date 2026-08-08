// Keyboard state + pointer-lock overlay wiring.

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
    if (e.button !== 0) return;
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

export function setupPointerLock(controls, domElement) {
  const overlay = document.getElementById('overlay');
  const crosshair = document.getElementById('crosshair');
  const cta = overlay?.querySelector('.cta');
  const ctaText = cta?.textContent ?? '';

  let retry = 0;
  let wanted = false;

  const request = () => {
    if (controls.isLocked) return;
    wanted = true;
    try {
      controls.lock();
    } catch {
      // Swallowed: the pointerlockerror handler below owns recovery.
    }
  };

  domElement.addEventListener('click', request);
  // The model harness has no overlay, so neither element is required to exist.
  overlay?.addEventListener('click', request);

  document.addEventListener('pointerlockerror', () => {
    if (!wanted || controls.isLocked) return;
    if (cta) cta.textContent = 'Mouse capture blocked — retrying…';
    clearTimeout(retry);
    retry = setTimeout(() => {
      if (cta) cta.textContent = ctaText;
      // One automatic retry; after that the next click is the player's move.
      if (wanted && !controls.isLocked && document.hasFocus()) request();
    }, RELOCK_COOLDOWN);
  });

  controls.addEventListener('lock', () => {
    wanted = true;
    clearTimeout(retry);
    if (cta) cta.textContent = ctaText;
    overlay?.classList.add('hidden');
    crosshair?.classList.add('visible');
  });
  controls.addEventListener('unlock', () => {
    wanted = false;
    clearTimeout(retry);
    overlay?.classList.remove('hidden');
    crosshair?.classList.remove('visible');
  });
}
