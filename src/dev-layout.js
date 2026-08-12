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
// the frame has usually loaded already and the load event will never come.
frame.addEventListener('load', () => setTimeout(runAll, 500));
if (frame.contentDocument?.readyState === 'complete') setTimeout(runAll, 500);

function frameDoc() {
  return frame.contentDocument;
}

// The toast and the camera meter are driven by game events, so the harness
// shows them by hand — measuring a hidden element measures nothing.
function forceTransient(doc, on) {
  const toast = doc.getElementById('toast');
  const watch = doc.getElementById('watch');
  if (toast) {
    toast.classList.toggle('show', on);
    if (on && !toast.textContent.trim()) toast.textContent = 'FLOOR CLEARED';
  }
  watch?.classList.toggle('show', on);
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
      out.push({ sel, r });
    }
  }
  return out;
}

function shared(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function check(doc, w, h) {
  const fails = [];

  forceTransient(doc, true);
  const persistent = rectsFor(doc, PERSISTENT);
  const transient = rectsFor(doc, TRANSIENT);

  // Everything permanent against everything permanent...
  for (let i = 0; i < persistent.length; i++) {
    for (let j = i + 1; j < persistent.length; j++) {
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

  forceTransient(doc, false);
  return { fails, measured: persistent.length + transient.length };
}

async function runAll() {
  const doc = frameDoc();
  if (!doc || !doc.body) return;

  const only = params.get('only');
  const list = only ? PRESETS.filter(([name]) => name.toLowerCase().includes(only.toLowerCase())) : PRESETS;

  doc.body.classList.toggle('touch', touchBox.checked);
  report.innerHTML = '';
  let failed = 0;

  for (const [name, w, h] of list) {
    setFrame(w, h);
    await settle();

    const { fails, measured } = check(doc, w, h);
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
