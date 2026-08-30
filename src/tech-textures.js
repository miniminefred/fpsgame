import * as THREE from 'three';

// The machines' own surfaces, and the plant they run in.
//
// A third texture file, and it earns being one the way the other two do:
// `textures.js` draws the BUILDING — plaster, carpet, ceiling tile, a narrow
// grey palette chosen so the few saturated things read as gameplay — and
// `fx-textures.js` draws sprites that are gone in a tenth of a second. These are
// neither. They are the finish on things that are made rather than fitted, and
// they answer a different question: an office says "grey" and a plant says
// "this was assembled, and it is running".
//
// Everything here is drawn to MULTIPLY against a material's own colour, so one
// canvas serves every machine on the floor. The plating is near-white with the
// detail cut into it, which is what lets the same texture come out as a Clerk
// Unit's pale shell and a Loader's hi-vis yellow without a second copy of it.
// The one exception is `readout`, which is lit rather than lit-upon and is
// drawn in its own colours.
//
// Built once, lazily, and shared by every floor and every body — never disposed,
// like `getAssets` in textures.js and the cap lettering in rigs.js. A body's
// MATERIALS are per-instance so a hit flash whitens one machine; the images
// under them are not, because there is one factory finish.

const PX = 256;

let tech = null;

export function getTech() {
  if (!tech) {
    tech = {
      // Machine plating: shallow panel lines, a course of rivets, and the fine
      // roll of milled metal. Deliberately quiet — this goes on every box of
      // every chassis, and a box the size of a forearm shows the same square of
      // it as a box the size of a loader, so anything with a big feature in it
      // reads as a different SIZE of machine rather than as the same finish.
      plate: repeatTexture(platePanel()),
      // The stripes on anything that means "keep back": the Loader's band, and
      // the guard rails down a parcel line. Drawn as light and dark rather than
      // as yellow and black, so the material's own colour decides which yellow.
      hazard: repeatTexture(hazardStripe()),
      // The belt itself, and the only texture in the game that MOVES: cleats
      // across the run, scrolled by conveyors.js at the speed the stock travels.
      // It is what turns a black slab into a belt that is running.
      tread: repeatTexture(beltTread()),
      // A lit panel with numbers on it. Used through a MeshBasicMaterial, so it
      // ignores the room the way a visor does — a screen that goes dark when the
      // lights do is a screen nobody switched on.
      readout: repeatTexture(dataReadout(), 512, 256),
      // Dashes on a dark strip, for the running light down the front of a
      // parcel line. It exists because of where a belt is: fitted at 2.16 m, the
      // one surface you never see is the one the stock is moving on, and the
      // underside you DO see faces away from every light in the building. The
      // tread on the deck is honest and unlit; this is the same motion put
      // somewhere a player standing in the corridor can read it.
      runway: repeatTexture(runwayLights(), 128, 32),
    };
  }
  return tech;
}

/**
 * A running light: bright dashes on a dark strip, scrolled along its own length.
 *
 * Drawn wide and shallow because it is fitted wide and shallow, and with a gap
 * between the dashes about as long as a dash — closer together and a moving
 * strip reads as a solid bar, further apart and it reads as separate lamps.
 */
function runwayLights() {
  const W = 128, H = 32;
  const [c, g] = canvasOf(W, H);
  g.fillStyle = '#0b1a22';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 4; i++) {
    const x = i * 32;
    g.fillStyle = 'rgba(120,225,255,0.30)';
    g.fillRect(x + 2, 6, 24, H - 12);           // the glow around it
    g.fillStyle = '#a8f0ff';
    g.fillRect(x + 5, 11, 18, H - 22);          // ...and the lamp itself
  }
  return c;
}

function repeatTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function canvasOf(w = PX, h = PX) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

/**
 * Milled plate. Near-white so it multiplies down to whatever the machine is
 * painted, with the detail cut in as shadow rather than added as highlight —
 * add highlights and a dark chassis comes out dusty instead of machined.
 */
function platePanel() {
  const [c, g] = canvasOf();
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, PX, PX);

  // The roll of the metal: a fine horizontal grain, low enough to read as a
  // surface rather than as a pattern.
  for (let y = 0; y < PX; y += 2) {
    g.fillStyle = `rgba(0,0,0,${0.012 + Math.random() * 0.014})`;
    g.fillRect(0, y, PX, 1);
  }

  // Two panel seams across and two down, which is what makes a box read as
  // several plates bolted together rather than as one moulding. Drawn as a dark
  // line with a lighter one under it, the way a real seam catches.
  const seam = (x0, y0, x1, y1) => {
    g.strokeStyle = 'rgba(0,0,0,0.30)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x0 + (y0 === y1 ? 0 : 1.5), y0 + (y0 === y1 ? 1.5 : 0));
    g.lineTo(x1 + (y0 === y1 ? 0 : 1.5), y1 + (y0 === y1 ? 1.5 : 0));
    g.stroke();
  };
  seam(0, PX * 0.5, PX, PX * 0.5);
  seam(PX * 0.5, 0, PX * 0.5, PX);

  // A course of fasteners along one seam. Only one course: the point is that
  // the eye finds a repeat and stops looking, not that the machine is riveted
  // all over.
  for (let x = PX * 0.08; x < PX; x += PX * 0.14) {
    g.fillStyle = 'rgba(0,0,0,0.26)';
    g.beginPath(); g.arc(x, PX * 0.5 - 7, 2.4, 0, 6.2832); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.beginPath(); g.arc(x, PX * 0.5 - 8, 1.2, 0, 6.2832); g.fill();
  }

  // ...and the wear it has picked up doing the job.
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * PX, y = Math.random() * PX;
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.07})`;
    g.fillRect(x, y, 1 + Math.random() * 3, 1);
  }
  return c;
}

/** Keep-back stripes, at 45 degrees. Light and dark, never yellow — see above. */
function hazardStripe() {
  const [c, g] = canvasOf(PX, PX);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, PX, PX);

  // Six pairs across the tile, which is chosen against where it is used: the
  // Loader's band is about 0.65 m wide and takes one whole tile, so six is a
  // stripe every ten centimetres — coarse enough to read from down a corridor.
  const band = PX / 6;
  g.save();
  g.translate(PX / 2, PX / 2);
  g.rotate(-Math.PI / 4);
  g.translate(-PX, -PX);
  g.fillStyle = '#26282c';
  for (let x = 0; x < PX * 2; x += band) g.fillRect(x, 0, band / 2, PX * 2);
  g.restore();

  // Scuffed, because a hazard band is on the part of the machine that hits
  // things.
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * PX, y = Math.random() * PX;
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.18})`;
    g.fillRect(x, y, 2 + Math.random() * 5, 1 + Math.random());
  }
  return c;
}

/**
 * The running surface of a parcel line: rubber with cleats across it.
 *
 * Drawn dark on dark on purpose. What has to read from ten metres away is that
 * something is MOVING, and a high-contrast belt reads as a striped floor
 * instead — the cleats only have to be visible enough that the eye can track
 * one going past.
 */
function beltTread() {
  const [c, g] = canvasOf(PX, PX);
  g.fillStyle = '#8e8e8e';
  g.fillRect(0, 0, PX, PX);

  // Two cleats per tile, so the pitch can be set from the tile count and still
  // land on a whole number of them.
  for (const y of [PX * 0.18, PX * 0.68]) {
    g.fillStyle = '#6a6a6a';
    g.fillRect(0, y, PX, PX * 0.09);
    g.fillStyle = '#c8c8c8';
    g.fillRect(0, y - 2, PX, 2);              // the lip that catches the light
    g.fillStyle = '#4c4c4c';
    g.fillRect(0, y + PX * 0.09, PX, 2);      // ...and the shadow it throws
  }

  // The weave of the belt between them.
  for (let i = 0; i < 700; i++) {
    const x = Math.random() * PX, y = Math.random() * PX;
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.10})`;
    g.fillRect(x, y, 2, 1);
  }
  return c;
}

/**
 * A screen with a plant's own numbers on it: a column of labelled bars, a
 * block of readings, and a grid behind the lot.
 *
 * Nothing on it says anything, and that is the intent — it has to hold up at
 * two metres and never be read, so it is built out of the SHAPES text and data
 * make rather than out of glyphs. Drawn wide, because every surface it goes on
 * is wider than it is tall.
 */
function dataReadout() {
  const W = 512, H = 256;
  const [c, g] = canvasOf(W, H);
  g.fillStyle = '#06131a';
  g.fillRect(0, 0, W, H);

  // The grid it is all sitting on.
  g.strokeStyle = 'rgba(90,220,255,0.10)';
  g.lineWidth = 1;
  for (let x = 0; x <= W; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y <= H; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }

  // A header rule and a run of blocks along it, which is what a title reads as
  // at this size.
  g.fillStyle = '#7fe8ff';
  g.fillRect(12, 16, W - 24, 3);
  for (let x = 14, i = 0; x < W * 0.55; x += 13 + (i % 3) * 6, i++) {
    g.fillStyle = 'rgba(127,232,255,0.75)';
    g.fillRect(x, 26, 8 + (i % 3) * 5, 7);
  }

  // Bars down the left: a plant reporting on itself, most of it nominal.
  for (let i = 0; i < 5; i++) {
    const y = 52 + i * 26;
    g.fillStyle = 'rgba(127,232,255,0.22)';
    g.fillRect(14, y, 210, 12);
    const full = 0.25 + Math.random() * 0.7;
    g.fillStyle = full > 0.88 ? '#ffb020' : '#5ad6a0';
    g.fillRect(14, y, 210 * full, 12);
  }

  // ...and a block of readings on the right, in rows of unequal length so it
  // reads as values rather than as a pattern.
  for (let r = 0; r < 8; r++) {
    let x = 250;
    const y = 46 + r * 24;
    while (x < W - 20) {
      const w = 10 + Math.random() * 26;
      g.fillStyle = `rgba(127,232,255,${0.35 + Math.random() * 0.5})`;
      g.fillRect(x, y, w, 9);
      x += w + 7;
    }
  }

  // One line the eye lands on, and the scan across the whole thing.
  g.fillStyle = 'rgba(255,176,32,0.85)';
  g.fillRect(250, 46 + 3 * 24, 120, 9);
  g.fillStyle = 'rgba(255,255,255,0.06)';
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
  return c;
}
