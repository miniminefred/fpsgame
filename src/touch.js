import { applyLook, setTouchMode } from './input.js';

// On-screen controls for phones and tablets.
//
// Two decisions shape the whole module.
//
// **Every widget in #touch is `pointer-events: none`, and this file hit-tests
// the rectangles itself.** The three things a player does at once — walk, look
// and shoot — are three fingers down at the same time, and per-element
// listeners see three unrelated gesture streams with no way to tell which
// finger is which. One document-level listener holding the touch identifiers
// sees them as one pair of hands on a controller. It also means a widget can
// never swallow the tap that grabs pointer lock, which is the rule the HUD
// already lives under.
//
// **Nothing here is active until a finger actually lands** (or the device looks
// like a phone at boot). A desktop never dispatches a touch event, so the
// controls cost a hidden <div> and nothing else; a laptop with a touchscreen
// gets them the moment it is touched and loses them again the moment somebody
// reaches for WASD.

const LOOK = 0.0034;      // radians per pixel dragged
const AXIS = 0.38;        // stick deflection along an axis that counts as pressed
const DEAD = 0.16;        // below this the stick is centred, not nudged
const SPRINT_AT = 0.85;   // push it this far and you are running
const SLOP = 7;           // px a button's hit rect grows by, in every direction

// The lower-left of the screen drives the stick; everything else that is not a
// button looks around. Not the whole left half: on a landscape phone the top
// left is a long way from the thumb, and being able to swipe there to look is
// worth more than being able to walk with it.
const STICK_ZONE_X = 0.5;
const STICK_ZONE_Y = 0.3;

// True when the device looks like it has no mouse. `any-pointer: fine` is the
// half that matters: a tablet with a trackpad reports a coarse PRIMARY pointer
// while still having a real cursor, and it should boot to the desktop controls
// exactly like a laptop does. Either way this is only the opening guess — the
// first real touch enables the controls regardless.
export function touchByDefault() {
  return matchMedia('(pointer: coarse)').matches
    && !matchMedia('(any-pointer: fine)').matches;
}

export function createTouchControls({ keys, camera, controls, weapons, selectWeapon }) {
  const root = document.getElementById('touch');
  if (!root) return null;   // the dev harnesses have no touch layer

  const stick = document.getElementById('tstick');
  const nub = document.getElementById('tstick-nub');
  const chips = [...root.querySelectorAll('.twep')];

  // id -> element, for hit-testing and for the pressed state.
  const buttons = new Map();
  for (const el of root.querySelectorAll('[data-btn]')) buttons.set(el.dataset.btn, el);

  // Weapon chips are authored for the largest roster the game has ever had, so
  // a gun added or removed does not silently leave a dead button on the screen.
  chips.forEach((chip, i) => { chip.hidden = i >= weapons.count; });

  const fullBtn = buttons.get('full');
  if (fullBtn && !fullscreenSupported()) fullBtn.hidden = true;

  let on = false;
  // Which finger is doing what. A touch identifier is unique for the life of
  // the touch, which is the only thing that survives a second finger landing.
  const held = new Map();   // identifier -> { kind, btn }
  let stickId = null, lookId = null;
  let originX = 0, originY = 0, radius = 60;
  let lookX = 0, lookY = 0;

  function enable() {
    if (on) return;
    on = true;
    document.body.classList.add('touch');
    setTouchMode(true);
  }

  // A physical keyboard is the one unambiguous sign that the touchscreen was a
  // passing thing — a laptop the player prodded once. Movement keys only: a
  // Bluetooth keyboard sending Escape is not a change of mind.
  function disable() {
    if (!on) return;
    on = false;
    releaseAll();
    document.body.classList.remove('touch');
    setTouchMode(false);
  }

  const playing = () => controls.engaged && !document.body.classList.contains('dead');

  // ------------------------------------------------------------------ buttons

  function buttonAt(t) {
    for (const [id, el] of buttons) {
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (t.clientX >= r.left - SLOP && t.clientX <= r.right + SLOP
        && t.clientY >= r.top - SLOP && t.clientY <= r.bottom + SLOP) return id;
    }
    return null;
  }

  // `press` is the finger being down, `on` is the weapon being selected. Two
  // classes because a weapon chip carries both, and one release must not clear
  // the other — the chip you just tapped is the chip that stays lit.
  function pressButton(id) {
    buttons.get(id)?.classList.add('press');
    switch (id) {
      case 'fire':   keys.fire = true; keys.firePressed = true; break;
      case 'jump':   keys.jump = true; break;
      case 'reload': keys.reload = true; break;
      case 'full':   toggleFullscreen(); break;
      default: {
        const slot = Number(id);
        if (Number.isInteger(slot)) selectWeapon(slot);
      }
    }
  }

  function releaseButton(id) {
    buttons.get(id)?.classList.remove('press');
    switch (id) {
      case 'fire':   keys.fire = false; break;
      case 'jump':   keys.jump = false; break;
      case 'reload': keys.reload = false; break;
    }
  }

  // -------------------------------------------------------------------- stick

  function grabStick(t) {
    stickId = t.identifier;
    // The base jumps to wherever the thumb landed rather than making the thumb
    // find the base, then goes home on release. Its drawn position is the
    // suggestion, not the requirement.
    const r = stick.getBoundingClientRect();
    radius = r.width / 2;
    originX = t.clientX;
    originY = t.clientY;
    stick.style.left = `${originX}px`;
    stick.style.top = `${originY}px`;
    stick.classList.add('active');
    moveStick(t);
  }

  function moveStick(t) {
    let dx = t.clientX - originX;
    let dy = t.clientY - originY;
    const mag = Math.hypot(dx, dy);
    if (mag > radius) { dx *= radius / mag; dy *= radius / mag; }
    nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    const nx = dx / radius, ny = dy / radius;
    const push = Math.min(mag / radius, 1);
    const live = push > DEAD;
    keys.forward = live && ny < -AXIS;
    keys.back    = live && ny > AXIS;
    keys.left    = live && nx < -AXIS;
    keys.right   = live && nx > AXIS;
    keys.sprint  = push > SPRINT_AT;
  }

  function dropStick() {
    stickId = null;
    stick.classList.remove('active');
    stick.style.left = stick.style.top = '';
    nub.style.transform = '';
    keys.forward = keys.back = keys.left = keys.right = keys.sprint = false;
  }

  // ------------------------------------------------------------------- events

  function onStart(e) {
    enable();

    // Before the run starts, and while the death screen is up, a tap belongs to
    // whoever is listening for the click that begins or restarts it. Consuming
    // it here — which is what preventDefault on a touchstart does, since it
    // suppresses the synthetic mouse events the click is built from — makes the
    // game unstartable, and it does it on mobile only.
    if (!playing()) {
      for (const t of e.changedTouches) {
        if (buttonAt(t) === 'full') { toggleFullscreen(); e.preventDefault(); }
      }
      return;
    }

    for (const t of e.changedTouches) {
      const btn = buttonAt(t);
      if (btn) {
        held.set(t.identifier, { kind: 'btn', btn });
        pressButton(btn);
      } else if (stickId === null
        && t.clientX < innerWidth * STICK_ZONE_X && t.clientY > innerHeight * STICK_ZONE_Y) {
        held.set(t.identifier, { kind: 'stick' });
        grabStick(t);
      } else if (lookId === null) {
        held.set(t.identifier, { kind: 'look' });
        lookId = t.identifier;
        lookX = t.clientX;
        lookY = t.clientY;
      }
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (!playing()) return;
    for (const t of e.changedTouches) {
      const use = held.get(t.identifier);
      if (!use) continue;
      if (use.kind === 'stick') {
        moveStick(t);
      } else if (use.kind === 'look') {
        applyLook(camera, (t.clientX - lookX) * LOOK, (t.clientY - lookY) * LOOK);
        lookX = t.clientX;
        lookY = t.clientY;
      }
    }
    e.preventDefault();
  }

  function onEnd(e) {
    for (const t of e.changedTouches) {
      const use = held.get(t.identifier);
      if (!use) continue;
      held.delete(t.identifier);
      if (use.kind === 'stick') dropStick();
      else if (use.kind === 'look') lookId = null;
      else releaseButton(use.btn);
    }
    if (playing()) e.preventDefault();
  }

  // A phone call, the app switcher, or the browser stealing the gesture: none
  // of them send a touchend, and all of them must not leave the trigger down.
  function releaseAll() {
    for (const use of held.values()) {
      if (use.kind === 'stick') dropStick();
      else if (use.kind === 'btn') releaseButton(use.btn);
    }
    held.clear();
    lookId = null;
  }

  addEventListener('touchstart', onStart, { passive: false });
  addEventListener('touchmove', onMove, { passive: false });
  addEventListener('touchend', onEnd, { passive: false });
  addEventListener('touchcancel', onEnd, { passive: false });
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  addEventListener('keydown', (e) => {
    if (/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(e.code)) disable();
  });

  if (touchByDefault()) enable();

  return {
    setWeapon(i) {
      chips.forEach((chip, n) => chip.classList.toggle('on', n === i));
    },
    get active() { return on; },
  };
}

// ---------------------------------------------------------------- fullscreen

// iPhone Safari has no element fullscreen at all, so the button has to be able
// to not exist rather than sit there doing nothing.
function fullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

function toggleFullscreen() {
  const doc = document;
  const el = doc.documentElement;
  const open = doc.fullscreenElement || doc.webkitFullscreenElement;
  try {
    const go = open
      ? (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc)
      : (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    // Refused by the browser is a normal outcome, not an error to report: it
    // happens whenever the gesture is judged stale.
    go?.catch?.(() => {});
  } catch { /* unsupported — the button is hidden, but be safe anyway */ }
}
