import { GameAudio } from './audio.js';

// Contact sheet for the sound set — the audio counterpart to dev-models.js.
//
// It exists because a bad clip is invisible from inside the game. Generated
// audio arrives at inconsistent levels, and a take that came back near-silent
// plays as a gun that randomly fails to fire: you hear the impact and the
// mechanical layer, but not the shot, and no amount of staring at the mixer
// explains it. Measuring the whole set at once turns that into a number.
//
// Two defects are worth catching here, and both were real:
//   * a variant far quieter than its siblings — regenerate it, do not amplify a
//     recording of nothing
//   * a long onset — the sound sitting half a second into its own clip, which
//     makes every rapid-fire burst ragged

const DUD_RATIO = 0.25;     // vs. the median sibling
const LATE_ONSET = 0.08;    // seconds of dead air worth complaining about
const QUIET_MIXED = 0.008;  // post-normalisation level too low to hear in a mix

const audio = new GameAudio();
const sfx = audio.sfx;

const rows = document.getElementById('rows');
const summary = document.getElementById('summary');

// The harness has no gameplay click to piggyback on, so ask for the context on
// the first interaction with the page — any interaction will do.
const wake = () => audio.start();
addEventListener('pointerdown', wake, { once: true });
addEventListener('keydown', wake, { once: true });
sfx.resume();

function verdictFor(row, medianRms) {
  if (!row.loaded) return { cls: 'bad', text: 'MISSING' };
  // A bed is meant to sit under everything and is neither trimmed nor levelled,
  // so the loudness and onset tests say nothing useful about one.
  if (row.name.startsWith('amb-')) return { cls: 'ok', text: 'bed' };
  if (medianRms > 0 && row.rms < medianRms * DUD_RATIO) return { cls: 'bad', text: 'dud — regenerate' };
  if (row.mixed < QUIET_MIXED) return { cls: 'bad', text: 'too quiet — regenerate' };
  // Dead air is skipped at playback, so this is a note on the clip, not a fault
  // you will hear.
  if (row.onsetMs > LATE_ONSET * 1000) return { cls: 'warn', text: `${row.onsetMs}ms lead (trimmed)` };
  return { cls: 'ok', text: 'ok' };
}

function render() {
  const report = sfx.report();
  const byName = new Map();
  for (const row of report) {
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(row);
  }

  rows.textContent = '';
  let loaded = 0;
  let problems = 0;

  for (const [name, takes] of byName) {
    // The median sibling is the yardstick — a mean would be dragged down by the
    // very dud we are trying to find.
    const levels = takes.filter((t) => t.loaded).map((t) => t.rms).sort((a, b) => a - b);
    const median = levels.length ? levels[levels.length >> 1] : 0;

    takes.forEach((row, i) => {
      if (row.loaded) loaded++;
      const v = verdictFor(row, takes.length > 1 ? median : 0);
      if (v.cls !== 'ok') problems++;

      const tr = document.createElement('tr');
      if (i === 0) tr.className = 'group';
      tr.innerHTML = `
        <td class="name">${name}${row.take ? `-${row.take}` : ''}</td>
        <td class="muted">${row.take || '—'}</td>
        <td>${row.seconds || '—'}</td>
        <td>${row.peak || '—'}</td>
        <td>${row.rms || '—'}</td>
        <td>${row.onsetMs ? `${row.onsetMs}ms` : '0'}</td>
        <td class="muted">${row.norm ? `×${row.norm}` : '—'}</td>
        <td>${row.mixed || '—'}</td>
        <td class="${v.cls}">${v.text}</td>`;
      tr.querySelector('.name').onclick = () => { audio.start(); sfx.play(name); };
      rows.appendChild(tr);
    });
  }

  summary.textContent =
    `${loaded}/${report.length} clips decoded · ${problems} flagged · ` +
    `context ${sfx.ctx?.state ?? 'not started'} — click anywhere to start audio`;

  // Also dump it where a headless check can read it.
  window.soundReport = report;
}

setInterval(render, 500);
render();

document.getElementById('play-all').onclick = async () => {
  audio.start();
  for (const name of sfx.library.keys()) {
    if (name.startsWith('amb-')) continue;
    summary.textContent = `auditioning ${name}…`;
    sfx.play(name);
    await new Promise((r) => setTimeout(r, 900));
  }
  render();
};
