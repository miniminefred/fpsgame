import { normaliseCode, validCode } from './net.js';

// The co-op panel on the start screen: a code to read out, a box to type one
// into, and one line of prose saying what the wire is currently doing.
//
// This file is only the menu. It owns no game state and speaks no protocol —
// it drives a Net and reads its status back, and netplay.js does everything
// that happens once a channel is up. What it does own is the one hazard in the
// whole feature: THIS IS THE ONLY INTERACTIVE UI IN THE GAME. Every other
// element on screen is `pointer-events: none` so that nothing can ever swallow
// the click that grabs pointer lock, and the start screen is one enormous
// click target built on exactly that rule. A panel of real buttons sitting in
// the middle of it therefore has to hold the opposite line: every press inside
// it is stopped where it lands, or pressing JOIN also starts the run, hides the
// panel under the floor, and fires the pistol on the way past.
//
// `swallow` below is that, and it takes the whole family of events rather than
// just `click`, because three separate listeners elsewhere are waiting on the
// way out: `#overlay`'s click grabs the lock, main.js's mousedown restarts a
// dead run, and input.js's mousedown pulls the trigger.

const EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'];

// What each state says, in the second person, with the next move in it. A status
// line that reports a state without saying what to do about it is a state
// machine talking to itself.
const SAYS = {
  off: 'Not connected. Your code appears here the moment you open this panel.',
  hosting: 'Waiting. Read your code out — they type it in and press JOIN. You can close this and start playing; a run in progress restarts when they arrive.',
  joining: 'Dialling…',
  connected: 'Connected. Close this and click to play — you will both drop into the same building.',
};

export function createCoopMenu({ net }) {
  const open = document.getElementById('mp-open');
  const panel = document.getElementById('mp');
  // The harnesses in dev-*.html load none of this markup, and the game must not
  // fall over because a page legitimately has no menu on it.
  if (!open || !panel) return null;

  const codeEl = document.getElementById('mp-code');
  const input = document.getElementById('mp-input');
  const status = document.getElementById('mp-status');
  const copyBtn = document.getElementById('mp-copy');
  const joinBtn = document.getElementById('mp-join');
  const leaveBtn = document.getElementById('mp-leave');
  const closeBtn = document.getElementById('mp-close');
  const role = document.getElementById('netrole');
  const roleName = document.getElementById('netrole-role');
  const roleCode = document.getElementById('netrole-code');

  // Set while a copy or a bad-code complaint is on screen, so the next status
  // repaint does not wipe a message the player has not read yet.
  let flash = 0;

  const swallow = (el) => {
    for (const type of EVENTS) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  };
  swallow(open);
  swallow(panel);

  const say = (text, tone = '') => {
    status.textContent = text;
    status.className = tone;
  };

  const flashSay = (text, tone) => {
    say(text, tone);
    flash = Date.now() + 2600;
  };

  const paint = () => {
    const state = net.state;
    codeEl.textContent = net.code ?? '······';

    if (state === 'error') {
      // An error is the one status that must never be overwritten by a stale
      // flash — it is the only one that tells the player something is wrong.
      flash = 0;
      say(net.error ?? 'Connection failed', 'bad');
    } else if (Date.now() >= flash) {
      say(SAYS[state] ?? '', state === 'connected' ? 'good' : '');
    }

    // Hosting is the default, so there is never a moment where the panel is
    // open and there is nothing to read out. The two buttons that would fight
    // that are shut off while a dial or a session is live.
    const busy = state === 'joining' || state === 'connected';
    joinBtn.disabled = busy;
    input.disabled = busy;
    copyBtn.disabled = !net.code || state === 'joining';
    leaveBtn.disabled = state === 'off';

    if (roleName && roleCode) {
      const name = state === 'connected' ? (net.isHost ? 'Host' : 'Joined')
        : state === 'hosting' ? 'Waiting'
        : '';
      roleName.textContent = name;
      // Its own span, because a narrow screen drops it — see #netrole-code.
      roleCode.textContent = name && net.code ? net.code : '';
      role.classList.toggle('visible', !!name);
    }
  };

  net.onStatus = paint;

  const show = (on) => {
    panel.classList.toggle('hidden', !on);
    panel.setAttribute('aria-hidden', on ? 'false' : 'true');
    // Opening publishes a code. That is the whole of "you can also be joined if
    // you just wait" — there is no separate HOST button to miss, because the
    // panel being open IS the offer.
    if (on && net.state === 'off') net.host();
    else paint();
    if (on) input.focus();
  };

  open.addEventListener('click', () => show(panel.classList.contains('hidden')));
  closeBtn.addEventListener('click', () => show(false));

  leaveBtn.addEventListener('click', () => {
    net.leave();
    // Straight back to offering a game, because a panel with an empty code in
    // it is a dead end — the only thing you can do from there is close it.
    net.host();
  });

  joinBtn.addEventListener('click', () => dial());
  input.addEventListener('keydown', (e) => {
    // Enter is the key everybody presses after typing a code into a box.
    if (e.key === 'Enter') { e.preventDefault(); dial(); }
  });
  // Normalised as they type, so the box shows exactly the code that will be
  // dialled rather than something we quietly rewrite on submit.
  input.addEventListener('input', () => {
    const at = input.selectionStart;
    input.value = normaliseCode(input.value);
    input.setSelectionRange(at, at);
  });

  function dial() {
    const code = normaliseCode(input.value);
    if (!validCode(code)) {
      flashSay('That is not a six-character code — check it and try again', 'bad');
      return;
    }
    net.join(code);
  }

  copyBtn.addEventListener('click', async () => {
    if (!net.code) return;
    try {
      await navigator.clipboard.writeText(net.code);
      flashSay('Code copied — send it to them', 'good');
    } catch {
      // Clipboard access is refused on an insecure origin and in some phone
      // browsers. Selecting it is the fallback that always works, and it also
      // says "these six characters" more precisely than a toast can.
      selectText(codeEl);
      flashSay('Could not reach the clipboard — the code is selected, copy it by hand', 'bad');
    }
  });

  paint();

  return {
    /** Shut the panel — the game is starting. Hosting, if any, carries on. */
    close() { if (!panel.classList.contains('hidden')) show(false); },
    /** Repaint after something outside the menu changed the session. */
    refresh: paint,
  };
}

function selectText(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
