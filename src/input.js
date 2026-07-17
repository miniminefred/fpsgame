// Keyboard state + pointer-lock overlay wiring.

export function createInput() {
  const keys = { forward: false, back: false, left: false, right: false, jump: false };

  addEventListener('keydown', (e) => setKey(keys, e.code, true));
  addEventListener('keyup', (e) => setKey(keys, e.code, false));

  return keys;
}

function setKey(keys, code, down) {
  switch (code) {
    case 'KeyW': case 'ArrowUp':    keys.forward = down; break;
    case 'KeyS': case 'ArrowDown':  keys.back = down; break;
    case 'KeyA': case 'ArrowLeft':  keys.left = down; break;
    case 'KeyD': case 'ArrowRight': keys.right = down; break;
    case 'Space':                   keys.jump = down; break;
  }
}

// Wires the click-to-lock overlay and crosshair to a PointerLockControls instance.
export function setupPointerLock(controls, domElement) {
  const overlay = document.getElementById('overlay');
  const crosshair = document.getElementById('crosshair');

  domElement.addEventListener('click', () => {
    if (!controls.isLocked) controls.lock();
  });
  overlay.addEventListener('click', () => {
    if (!controls.isLocked) controls.lock();
  });

  controls.addEventListener('lock', () => {
    overlay.classList.add('hidden');
    crosshair.classList.add('visible');
  });
  controls.addEventListener('unlock', () => {
    overlay.classList.remove('hidden');
    crosshair.classList.remove('visible');
  });
}
