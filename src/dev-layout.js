// Drives dev-layout.html: the HUD measured at one device size after another.
//
// Why a harness rather than an eyeball. The HUD anchors four corners and the
// touch controls want two of them, so "does it fit" is a question about
// rectangles at a dozen viewport sizes — and the answer changes with every
// font size in a media query. Checking it by resizing a window is slow, and it
// is exactly the kind of check that stops being done.
//
// The game runs for real inside an iframe. That matters: the media queries key
// off the IFRAME's viewport, not the harness window, so a 390x844 frame is a
// phone as far as the CSS is concerned even on a 4K monitor, and the numbers
// come from the actual laid-out HUD rather than from a mock of it. One load,
// many resizes.
//
// Query parameters:
//   ?only=<substring>   run just the presets whose name matches
//   ?overlap=<px2>      area two rects may share before it is a failure

const params = new URLSearchParams(location.search);

// Ordinary phones, tablets and laptops, each in both orientations where that
// is a thing somebody does. The narrow desktop is not a device — it is a
// browser window dragged thin, which hits the same media queries.
const PRESETS = [
  ['iPhone SE — portrait', 375, 667],
  ['iPhone 14 — portrait', 390, 844],
  ['Pixel 7 — portrait', 412, 915],
  ['Galaxy S8 — portrait', 360, 740],
  ['iPhone SE — landscape', 667, 375],
  ['iPhone 14 — landscape', 844, 390],
  ['Pixel 7 — landscape', 915, 412],
  ['Galaxy S8 — landscape', 740, 360],
  ['iPad mini — portrait', 744, 1133],
  ['iPad — landscape', 1024, 768],
  ['Narrow desktop window', 600, 900],
  ['Desktop', 1440, 900],
];

// Everything that is on screen the whole time and therefore has to coexist
// with everything else here. The transient ones are listed separately: a toast
// and the camera meter appear over the middle of the screen for a second or
// two, and they only have to clear the permanent furniture.
const PERSISTENT = [
  '#mission', '#mapbox', '#health', '#gunbox',
  '#tstick', '[data-btn="fire"]', '[data-btn="jump"]', '[data-btn="reload"]',
  '#tweapons', '.tbtn-full',
  // Pinned to the same top-centre strip as the fullscreen button, which is the
  // only reason it is in this list: the two collided the day it was added.
  '#netrole',
  // The UNSEEN line (T). It is a third line inside #mission, so what it really
  // measures is #mission getting taller — and #netrole's narrow-screen rule
  // drops to a hardcoded offset below #mission's bottom edge, which is exactly
  // the sort of number a new line in that block invalidates.
  '#unseen',
];
const TRANSIENT = ['#toast', '#watch'];

// Two rects sharing a few square pixels of shadow is not a collision; a corner
// of the ammo counter behind the reload button is. The default is about a
// 4x4 px bite.
const MAX_SHARED = Number(params.get('overlap') ?? 16);

const frame = document.getElementById('game');
const report = document.getElementById('report');
const summary = document.getElementById('summary');
const touchBox = document.getElementById('touchmode');

document.getElementById('run').addEventListener('click', runAll);
touchBox.addEventListener('change', runAll);

// A module script is deferred and the iframe is not, so by the time this runs
// the frame has usually loaded already and the load event will never come — so
// both triggers are kept, and `runAll` is what makes that safe (see below).
frame.addEventListener('load', runAll);
runAll();

function frameDoc() {
  return frame.contentDocument;
}

// The longest thing the game ever puts in the banner. Probing with a short
// string is how the first version of this harness passed every size while the
// keycard message ran off both edges of a phone: the toast is centred and
// nowrap-ish, so its width is the whole question and the text is the width.
// If a longer message is ever added, it belongs here.
const LONGEST_TOAST = 'BLACK KEYCARD DROPPED — ONE LEFT, AND YOU KNOW WHERE';

// The widest the co-op chip ever gets: the longest of its three prefixes plus a
// six-character code. Same reasoning as LONGEST_TOAST — it is centred and its
// width is the whole question, so probing with a short string proves nothing.
const LONGEST_ROLE = { role: 'Waiting', code: 'WWWWWW' };

// The toast, the camera meter and the co-op chip only exist once the game has
// something to say, so the harness turns all three on by hand — measuring a
// hidden element measures nothing, and an empty one has no width at all. Two of
// them are transient and the chip is not; what they share is that none of them
// is on screen until an event puts it there, which is the thing that has to be
// worked around here.
function forceEventDriven(doc, on) {
  const toast = doc.getElementById('toast');
  const watch = doc.getElementById('watch');
  const role = doc.getElementById('netrole');
  const unseen = doc.getElementById('unseen');
  unseen?.classList.toggle('visible', on);
  if (toast) {
    toast.classList.toggle('show', on);
    if (on) toast.textContent = LONGEST_TOAST;
  }
  watch?.classList.toggle('show', on);
  if (role) {
    role.classList.toggle('visible', on);
    // Filled through the same two spans the game uses, so the narrow-screen rule
    // that hides the code is measured rather than reasoned about.
    const name = doc.getElementById('netrole-role');
    const code = doc.getElementById('netrole-code');
    if (name) name.textContent = on ? LONGEST_ROLE.role : '';
    if (code) code.textContent = on ? LONGEST_ROLE.code : '';
  }
}

function rectsFor(doc, selectors) {
  const out = [];
  for (const sel of selectors) {
    for (const el of doc.querySelectorAll(sel)) {
      if (el.hidden) continue;
      const style = doc.defaultView.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ sel, r, el });
    }
  }
  return out;
}

/**
 * Whether one of these two elements is inside the other.
 *
 * A parent's rect covers its in-flow children, so a nested pair overlaps by the
 * whole of the smaller one and reads as the worst collision on the page — which
 * is what `#unseen` did the moment it was added inside `#mission`: 12 of 12
 * sizes red, on a HUD with nothing wrong with it. That is the same false alarm
 * the duplicate-sweep bug produced, and it is worth being immune to rather than
 * worth working around by keeping children off the list: what a child in the
 * list really measures is its PARENT getting taller, and the parent should still
 * be measured against everything else at that new size.
 */
function nested(a, b) {
  return a.el !== b.el && (a.el.contains(b.el) || b.el.contains(a.el));
}

function shared(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function check(doc, w, h) {
  const fails = [];

  forceEventDriven(doc, true);
  const persistent = rectsFor(doc, PERSISTENT);
  const transient = rectsFor(doc, TRANSIENT);

  // Everything permanent against everything permanent...
  for (let i = 0; i < persistent.length; i++) {
    for (let j = i + 1; j < persistent.length; j++) {
      if (nested(persistent[i], persistent[j])) continue;
      const area = shared(persistent[i].r, persistent[j].r);
      if (area > MAX_SHARED) {
        fails.push(`overlap ${persistent[i].sel} / ${persistent[j].sel} — ${Math.round(area)} px²`);
      }
    }
  }
  // ...and everything transient against everything permanent. Two transients
  // are not compared: the toast and the camera meter are both centred and
  // never both up, and pinning them apart would be inventing a requirement.
  for (const t of transient) {
    for (const p of persistent) {
      if (nested(t, p)) continue;
      const area = shared(t.r, p.r);
      if (area > MAX_SHARED) {
        fails.push(`overlap ${t.sel} / ${p.sel} — ${Math.round(area)} px²`);
      }
    }
  }

  // Off the edge is the other way a HUD stops working, and it is the one that
  // looks fine in the middle of the screen while a counter is half gone.
  for (const { sel, r } of [...persistent, ...transient]) {
    const out = [];
    if (r.left < -0.5) out.push(`${Math.round(-r.left)} left`);
    if (r.top < -0.5) out.push(`${Math.round(-r.top)} top`);
    if (r.right > w + 0.5) out.push(`${Math.round(r.right - w)} right`);
    if (r.bottom > h + 0.5) out.push(`${Math.round(r.bottom - h)} bottom`);
    if (out.length) fails.push(`offscreen ${sel} — ${out.join(', ')}`);
  }

  forceEventDriven(doc, false);
  return { fails, measured: persistent.length + transient.length };
}

/**
 * One sweep at a time, and the last request always wins.
 *
 * This is not defensive tidiness, it is the fix to a harness that spent its
 * existence reporting nine sizes out of twelve as broken when the HUD was fine.
 * Both start triggers above fire in the ordinary case — an iframe's initial
 * about:blank is `complete` the moment the deferred module runs, and then the
 * real document arrives and raises `load` — so two sweeps ran at once, each
 * resizing the frame out from under the other's `await settle()`. Every rect
 * then got measured against the OTHER sweep's viewport, which reads exactly like
 * a HUD hanging off the bottom of the screen: "offscreen #tstick — 163 bottom".
 *
 * The duplicate rows in the report were the tell, and the reason it survived so
 * long is that the two sweeps disagreed rather than both failing — one of them
 * always came out clean, so the page always had a plausible answer on it.
 */
let sweeping = false;
let again = false;
async function runAll() {
  if (sweeping) { again = true; return; }
  sweeping = true;
  try {
    await sweep();
  } finally {
    sweeping = false;
  }
  if (again) { again = false; runAll(); }
}

/**
 * The game's own document, once it is actually there.
 *
 * Measuring about:blank finds none of the selectors, and `check` is perfectly
 * happy to report zero elements and no failures — an all-clear for a page that
 * never loaded, which is the one result a harness must never be able to print.
 */
async function frameReady() {
  for (let i = 0; i < 50; i++) {
    if (frameDoc()?.getElementById('hud')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function sweep() {
  if (!(await frameReady())) {
    summary.textContent = 'the game frame never loaded — nothing was measured';
    summary.className = 'bad';
    return;
  }
  const doc = frameDoc();

  const only = params.get('only');
  const list = only ? PRESETS.filter(([name]) => name.toLowerCase().includes(only.toLowerCase())) : PRESETS;

  doc.body.classList.toggle('touch', touchBox.checked);
  report.innerHTML = '';
  let failed = 0;

  for (const [name, w, h] of list) {
    setFrame(w, h);
    await settle();

    // The frame is what the media queries and every rect below are measured
    // against, so a sweep that has somehow ended up looking at a different
    // viewport has to say so rather than blame the HUD for the difference. This
    // is the assertion that would have named the double-sweep bug on sight.
    const view = frameView();
    const fails = (view.w === w && view.h === h) ? [] :
      [`frame viewport is ${view.w}x${view.h}, expected ${w}x${h} — measurements below are not this size`];

    const { fails: found, measured } = check(doc, w, h);
    fails.push(...found);
    if (fails.length) failed++;
    report.appendChild(row(name, w, h, fails, measured));
  }

  summary.textContent = failed
    ? `${failed} of ${list.length} sizes have a collision`
    : `all ${list.length} sizes clear`;
  summary.className = failed ? 'bad' : 'good';

  // Leave the frame on something usable rather than whatever ran last.
  setFrame(390, 844);
}

// The frame is sized in real CSS pixels and then drawn smaller, so a tablet
// still fits beside the report. Only the parent is transformed, so the frame's
// own viewport — and therefore every media query and every rect measured
// inside it — is the full size.
// What the frame's own viewport actually measures, which is the thing the CSS
// inside it responds to.
function frameView() {
  const el = frameDoc()?.documentElement;
  return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
}

function setFrame(w, h) {
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  const stage = document.getElementById('stage');
  stage.style.transform = `scale(${Math.min(1, 560 / h, 620 / w).toFixed(3)})`;
}

function row(name, w, h, fails, measured) {
  const el = document.createElement('div');
  el.className = `case ${fails.length ? 'bad' : 'good'}`;
  const items = fails.map((f) => `<li>${f}</li>`).join('');
  el.innerHTML = `
    <div class="case-head"><b>${name}</b> <span>${w}x${h}</span>
      <em>${fails.length ? `${fails.length} problem${fails.length > 1 ? 's' : ''}` : `${measured} elements clear`}</em></div>
    ${items ? `<ul>${items}</ul>` : ''}`;
  return el;
}

// Let the resize land and the reflow it causes finish. A timer rather than
// requestAnimationFrame on purpose: rAF stops being called in a tab that is
// not visible, and a harness that silently produces no report the moment you
// look at another window is worse than one that takes an extra moment.
function settle() {
  return new Promise((r) => setTimeout(r, 90));
}
