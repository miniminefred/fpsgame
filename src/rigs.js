import * as THREE from 'three';

// What the things walking around a floor are made of.
//
// Split out of enemies.js, which is about behaviour: this file knows nothing
// about state machines, hearing or damage, and enemies.js no longer has to know
// which end of a rat the tail goes on. Two rigs live here — the office staff and
// the vermin — and both hand back the same shape of object, so the AI drives
// either one without asking what it is looking at.
//
// Everything is built facing -Z, the way the camera looks, so yaw maths is
// shared with the player.

const SKIN = 0xbe9a78;

// Shared across every enemy — only the materials are per-instance, so a hit
// flash on one doesn't light up the whole floor.
const GEO = {
  torso: new THREE.BoxGeometry(0.5, 0.62, 0.3),
  hips: new THREE.BoxGeometry(0.42, 0.22, 0.28),
  head: new THREE.BoxGeometry(0.26, 0.28, 0.26),
  shirt: new THREE.BoxGeometry(0.17, 0.5, 0.02),
  visor: new THREE.BoxGeometry(0.22, 0.07, 0.02),
  arm: new THREE.BoxGeometry(0.14, 0.54, 0.14),
  leg: new THREE.BoxGeometry(0.17, 0.86, 0.19),
  gun: new THREE.BoxGeometry(0.1, 0.14, 0.42),
  // A soft cap: a crown and a peak over the eyes. The janitor and the guards
  // wear one, and it is doing the same job as a visor colour — it is what you
  // recognise from the far end of a corridor, before the mop is close enough to
  // matter.
  cap: new THREE.BoxGeometry(0.28, 0.09, 0.28),
  capPeak: new THREE.BoxGeometry(0.24, 0.03, 0.11),
  // The word across the front of it, on its own slab a couple of millimetres
  // proud of the crown. A word is the last thing you read of somebody — the
  // uniform has already told you what they are from down the corridor — so it
  // only has to hold up at the range where you can see their face.
  capBadge: new THREE.BoxGeometry(0.235, 0.05, 0.012),

  // Vermin. A rat is about as long as a keyboard, which is small enough that
  // every part of it has to earn its polygons: a body, a head, a snout to say
  // which way it is pointing, ears to say what it is, and a tail — which is the
  // only part you reliably see, because it is the part that moves.
  ratBody: new THREE.BoxGeometry(0.13, 0.11, 0.27),
  ratHead: new THREE.BoxGeometry(0.095, 0.09, 0.1),
  ratSnout: new THREE.BoxGeometry(0.045, 0.04, 0.06),
  ratEar: new THREE.BoxGeometry(0.05, 0.055, 0.014),
  ratEye: new THREE.BoxGeometry(0.02, 0.02, 0.012),
  ratLeg: new THREE.BoxGeometry(0.028, 0.05, 0.032),
  ratTail: new THREE.BoxGeometry(0.022, 0.022, 0.1),
};

// What the melee staff have picked up off their desks. Each is a shaft plus a
// business end, built along -Z so it points the way the arm swings.
//
// `rest` is how it is carried when nobody is swinging it, in radians about X —
// positive lifts the business end. Everything picked up off a desk is held out
// in front, which is the default; a mop is not carried, it is dragged, and its
// head belongs on the floor.
const BLUNT = {
  // The longest thing anybody on the floor swings, and the only one with a soft
  // end. The head is deliberately fat and yellow: at a metre of reach you need
  // to read the arc coming from further away than a stapler, and the yellow is
  // what ties the man to the card in his pocket.
  mop: {
    shaft: [0.045, 0.045, 0.86], head: [0.2, 0.14, 0.22], headMat: 'mophead',
    reach: 0.88, rest: -1.15,
  },
  // The one melee weapon on the floor that is actually a weapon rather than
  // something snatched off a desk, and it looks like it: a black shaft with a
  // steel tip and no bulk at the end. Half the mop's reach, so a guard who has
  // drawn one has to come all the way in to use it.
  baton: { shaft: [0.032, 0.032, 0.46], head: [0.04, 0.04, 0.07], headMat: 'metal', reach: 0.5 },
  keyboard: { shaft: null, head: [0.42, 0.03, 0.15], headMat: 'plastic', reach: 0.30 },
  extinguisher: { shaft: [0.07, 0.07, 0.10], head: [0.15, 0.15, 0.40], headMat: 'accent', reach: 0.34 },
  chairLeg: { shaft: [0.05, 0.05, 0.44], head: [0.13, 0.13, 0.13], headMat: 'metal', reach: 0.46 },
  stapler: { shaft: null, head: [0.09, 0.09, 0.26], headMat: 'metal', reach: 0.22 },
  monitor: { shaft: [0.05, 0.05, 0.16], head: [0.44, 0.30, 0.05], headMat: 'screen', reach: 0.30 },
  mug: { shaft: null, head: [0.11, 0.12, 0.11], headMat: 'paper', reach: 0.18 },
};

/**
 * The lettering on a cap, drawn once per word and shared by everybody wearing
 * it — there is one guard uniform on the floor, not forty copies of one.
 *
 * Shared like GEO above, and like GEO it is never disposed: a per-instance
 * material is released with the body that wore it, and three does not take a
 * material's map down with it, so the canvas survives the floor it was made on.
 */
const capLabels = new Map();

function capLabel(text, ink, cloth) {
  const key = `${text}|${ink}|${cloth}`;
  let tex = capLabels.get(key);
  if (tex) return tex;

  // 4:1, which is the badge's own aspect — anything else letterspaces the word
  // differently on a cap than it looks in the canvas.
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = `#${cloth.toString(16).padStart(6, '0')}`;
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = `#${ink.toString(16).padStart(6, '0')}`;
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Stretched to fill the slab rather than centred in it: the word is the whole
  // point of the badge, so it gets the whole badge.
  g.fillText(text, 128, 34, 236);

  tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  capLabels.set(key, tex);
  return tex;
}

/**
 * Builds the body for a type. Returns everything the AI animates and everything
 * a level teardown has to release:
 *
 *   group      the object in the scene, at the floor, facing -Z
 *   mats       per-instance materials (a hit flash is one enemy going white)
 *   ownGeo     geometry made just for this one, to be disposed with it
 *   torso/head the two meshes that stop bullets
 *   limbs      whatever this rig has to swing; a rat has none of the human ones
 *   bones      how it comes apart when it dies — see BONES below
 */

/**
 * The skeleton, declared here rather than in ragdolls.js on purpose: this file
 * is the one that knows an arm is 0.54 long and hangs at x = 0.32, and a second
 * copy of those numbers somewhere else would be wrong within a week.
 *
 * Each bone is
 *
 *   parts   the meshes it carries, which get re-parented onto its rigid body
 *   size    [w, h, d] of the box that stands in for it, in rig-local metres
 *   at      [x, y, z] centre of that box, likewise
 *   mass    kilograms, and they are meant to add up to a person
 *   joint   { to, at, angle, twist } — which bone it hangs off, where the pivot
 *           is, and how far it may swing and rotate before the joint stops it
 *
 * Everything is in UNSCALED rig space; `type.scale` is applied by whoever builds
 * the bodies, because the same skeleton has to serve a 0.9 intern and a 1.14
 * manager.
 */
export function buildRig(type, rng) {
  if (type.rig === 'rat') return buildRat(type, rng);
  if (type.rig === 'roomba') return buildRoomba(type, rng);
  return buildHuman(type, rng);
}

function buildHuman(type, rng) {
  const group = new THREE.Group();
  group.rotation.y = rng.range(0, Math.PI * 2);
  group.scale.setScalar(type.scale);

  const mats = {
    suit: new THREE.MeshStandardMaterial({ color: type.suit, roughness: 0.85 }),
    shirt: new THREE.MeshStandardMaterial({ color: type.shirt, roughness: 0.9 }),
    skin: new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.8 }),
    visor: new THREE.MeshBasicMaterial({ color: type.visor }),
    gun: new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.5, metalness: 0.4 }),
  };

  // Almost everybody on this floor is dressed in one colour with a shirt front
  // showing, so `suit` does the torso, the arms and the legs alike. A type that
  // declares `pants` is dressed instead — separate legs, and a torso that is the
  // shirt rather than a jacket over one. It is the difference between staff and
  // somebody in a uniform, and it is worth two materials.
  if (type.pants) {
    mats.pants = new THREE.MeshStandardMaterial({ color: type.pants, roughness: 0.9 });
  }
  if (type.cap) {
    mats.cap = new THREE.MeshStandardMaterial({ color: type.cap, roughness: 0.9 });
  }
  // A cap that says what the man under it does. Standard rather than emissive,
  // so the word goes dark with the rest of him when the lights are off and
  // whitens with the rest of him when he is shot.
  if (type.capText) {
    mats.capBadge = new THREE.MeshStandardMaterial({
      map: capLabel(type.capText, type.capInk ?? 0xf2f4f7, type.cap),
      roughness: 0.85,
    });
  }

  // Only melee staff need the junk-weapon palette, and only they pay for it.
  if (type.melee) {
    Object.assign(mats, {
      plastic: new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.8 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.5 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xb63b2c, roughness: 0.55 }),
      screen: new THREE.MeshStandardMaterial({ color: 0x1d2833, roughness: 0.35 }),
      paper: new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.85 }),
      mophead: new THREE.MeshStandardMaterial({ color: 0xe8c33a, roughness: 1 }),
    });
  }

  const ownGeo = [];
  const mesh = part(group);

  // In a uniform the shirt IS the torso and the trousers are their own colour;
  // otherwise it is one suit with a shirt front showing at the collar.
  const upper = mats.pants ? mats.shirt : mats.suit;
  const lower = mats.pants ?? mats.suit;

  const torso = mesh(GEO.torso, upper, 0, 1.16, 0);
  const hips = mesh(GEO.hips, lower, 0, 0.96, 0);
  const shirt = mesh(GEO.shirt, mats.pants ? mats.suit : mats.shirt, 0, 1.18, -0.155);
  const head = mesh(GEO.head, mats.skin, 0, 1.63, 0);
  const visor = mesh(GEO.visor, mats.visor, 0, 1.65, -0.13);
  const armL = mesh(GEO.arm, upper, -0.32, 1.15, 0);
  const armR = mesh(GEO.arm, upper, 0.32, 1.15, 0);
  const legL = mesh(GEO.leg, lower, -0.12, 0.43, 0);
  const legR = mesh(GEO.leg, lower, 0.12, 0.43, 0);
  const gun = mesh(GEO.gun, mats.gun, 0.3, 1.1, -0.3);

  // The cap, if this one wears one. Peak over the eyes, which is on the -z face
  // like everything else that faces forward.
  const cap = [];
  if (mats.cap) {
    cap.push(mesh(GEO.cap, mats.cap, 0, 1.79, 0));
    cap.push(mesh(GEO.capPeak, mats.cap, 0, 1.76, -0.18));
    // Above the peak, not level with it: the peak stands 4 cm further forward
    // than the crown, so a badge any lower is inside it.
    if (mats.capBadge) cap.push(mesh(GEO.capBadge, mats.capBadge, 0, 1.80, -0.146));
  }

  // Melee staff drop the gun and swing whatever was on their desk instead.
  gun.visible = !type.melee;
  let blunt = null;
  let bluntSpec = null;
  if (type.melee) {
    bluntSpec = BLUNT[rng.pick(type.blunt)];
    blunt = new THREE.Group();

    if (bluntSpec.shaft) {
      const [sw, sh, sl] = bluntSpec.shaft;
      const geo = new THREE.BoxGeometry(sw, sh, sl);
      ownGeo.push(geo);
      const shaft = new THREE.Mesh(geo, mats.plastic);
      shaft.position.z = -sl / 2;
      shaft.castShadow = true;
      blunt.add(shaft);
    }

    const [hw, hh, hl] = bluntSpec.head;
    const headGeo = new THREE.BoxGeometry(hw, hh, hl);
    ownGeo.push(headGeo);
    const business = new THREE.Mesh(headGeo, mats[bluntSpec.headMat]);
    business.position.z = -(bluntSpec.shaft ? bluntSpec.shaft[2] : 0) - hl / 2;
    business.castShadow = true;
    blunt.add(business);

    // Held in the right hand, which is what the swing animation drives.
    blunt.position.set(0.32, 1.12, -0.16);
    group.add(blunt);
  }

  return {
    rig: 'human', group, mats, ownGeo, torso, head,
    armL, armR, legL, legR, gun, blunt,
    bluntReach: bluntSpec ? bluntSpec.reach : 0,
    bluntRest: bluntSpec?.rest ?? 0.5,
    // What goes white when this one is shot. It has to be whatever they are
    // actually WEARING, not the one material that used to be everything: a
    // janitor's suit colour is a strip of collar, and flashing only that reads
    // as the shot missing.
    flash: flashSet(mats),
    // Six bones for a person: a trunk, a head and four limbs. The hips are part
    // of the trunk rather than a bone of their own — a jointed waist is the
    // single most expensive way to make a corpse look drunk, and at this
    // silhouette nobody can tell.
    //
    // Legs get the tightest cone and almost no twist, because a knee that swings
    // sideways is the one thing that reads instantly as broken. Arms get a wide
    // cone: they are supposed to fly.
    bones: [
      { parts: [torso, hips, shirt], size: [0.5, 0.62, 0.3], at: [0, 1.16, 0], mass: 34 },
      { parts: [head, visor, ...cap], size: [0.26, 0.28, 0.26], at: [0, 1.63, 0], mass: 5,
        joint: { to: 0, at: [0, 1.48, 0], angle: 0.65, twist: 0.5 } },
      { parts: [armL], size: [0.14, 0.54, 0.14], at: [-0.32, 1.15, 0], mass: 4,
        joint: { to: 0, at: [-0.27, 1.41, 0], angle: 1.4, twist: 0.8 } },
      { parts: [armR, gun, blunt], size: [0.14, 0.54, 0.14], at: [0.32, 1.15, 0], mass: 4,
        joint: { to: 0, at: [0.27, 1.41, 0], angle: 1.4, twist: 0.8 } },
      { parts: [legL], size: [0.17, 0.86, 0.19], at: [-0.12, 0.43, 0], mass: 11,
        joint: { to: 0, at: [-0.12, 0.85, 0], angle: 0.8, twist: 0.25 } },
      { parts: [legR], size: [0.17, 0.86, 0.19], at: [0.12, 0.43, 0], mass: 11,
        joint: { to: 0, at: [0.12, 0.85, 0], angle: 0.8, twist: 0.25 } },
    ],
  };
}

/**
 * A rat. Same contract as a person and about a tenth the size, which is the
 * whole point of it: it is genuinely hard to hit, it is under the desks, and the
 * first three times you see one you will shoot at it.
 *
 * `legs` and `tail` stand in for the human rig's limbs, and the animation branch
 * in enemies.js drives those instead of arms.
 */
function buildRat(type, rng) {
  const group = new THREE.Group();
  group.rotation.y = rng.range(0, Math.PI * 2);
  group.scale.setScalar(type.scale);

  const mats = {
    // `suit` and `skin` are the two the hit flash whitens, so the fur has to be
    // one of them or a shot rat gives nothing back.
    suit: new THREE.MeshStandardMaterial({ color: type.suit, roughness: 0.95 }),
    shirt: new THREE.MeshStandardMaterial({ color: type.shirt, roughness: 0.95 }),
    skin: new THREE.MeshStandardMaterial({ color: type.shirt, roughness: 0.9 }),
    visor: new THREE.MeshBasicMaterial({ color: type.visor }),
    gun: new THREE.MeshBasicMaterial({ color: 0x000000 }),
  };

  const mesh = part(group);
  const H = 0.075;   // belly height: it stands on stubby legs

  const torso = mesh(GEO.ratBody, mats.suit, 0, H, 0);
  const head = mesh(GEO.ratHead, mats.suit, 0, H + 0.02, -0.16);
  mesh(GEO.ratSnout, mats.skin, 0, H + 0.005, -0.23);
  mesh(GEO.ratEar, mats.skin, -0.05, H + 0.075, -0.145);
  mesh(GEO.ratEar, mats.skin, 0.05, H + 0.075, -0.145);
  // Eyes carry the type colour, the way a visor does on everything else — a rat
  // is the one thing on the floor with no visor to put it on.
  mesh(GEO.ratEye, mats.visor, -0.032, H + 0.035, -0.208);
  mesh(GEO.ratEye, mats.visor, 0.032, H + 0.035, -0.208);

  const legs = [
    mesh(GEO.ratLeg, mats.suit, -0.055, 0.025, -0.09),
    mesh(GEO.ratLeg, mats.suit, 0.055, 0.025, -0.09),
    mesh(GEO.ratLeg, mats.suit, -0.055, 0.025, 0.09),
    mesh(GEO.ratLeg, mats.suit, 0.055, 0.025, 0.09),
  ];

  // The tail is three segments hung off each other, so one sine wave at the root
  // travels down it. It is also the only part of a rat you can see from behind,
  // which is the angle you will spend the most time at.
  const tail = new THREE.Group();
  tail.position.set(0, H, 0.13);
  let link = tail;
  for (let i = 0; i < 3; i++) {
    const seg = new THREE.Group();
    seg.position.z = i === 0 ? 0 : 0.1;
    const box = new THREE.Mesh(GEO.ratTail, mats.skin);
    box.position.z = 0.05;
    box.scale.setScalar(1 - i * 0.18);
    box.castShadow = true;
    seg.add(box);
    link.add(seg);
    link = seg;
  }
  group.add(tail);

  return {
    rig: 'rat', group, mats, ownGeo: [], torso, head,
    armL: null, armR: null, legL: null, legR: null, gun: null, blunt: null,
    bluntReach: 0, legs, tail, flash: flashSet(mats),
    // One bone, and `whole` says so: the entire rig rides a single body rather
    // than being taken apart. A rat is 27 cm long with 3 cm legs, and jointing
    // those would be five constraints and four extra bodies spent on something
    // that is a blur at the range you ever see it. It tumbles, which is all a
    // shot rat has ever needed to do.
    bones: [{ whole: true, size: [0.14, 0.12, 0.40], at: [0, 0.075, -0.04], mass: 0.4 }],
  };
}

/**
 * The floor cleaner. The one round thing in a building made of boxes, which is
 * exactly why it is round: it is a bought-in appliance, not part of the fit-out,
 * and it reads as one from across a room.
 *
 * It has no idea there is a firefight on and never will. What it has is a
 * bumper, a lit ring that says it is working, and a brush that turns.
 */
function buildRoomba(type, rng) {
  const group = new THREE.Group();
  group.rotation.y = rng.range(0, Math.PI * 2);
  group.scale.setScalar(type.scale);

  const mats = {
    suit: new THREE.MeshStandardMaterial({ color: type.suit, roughness: 0.45, metalness: 0.3 }),
    shirt: new THREE.MeshStandardMaterial({ color: type.shirt, roughness: 0.6 }),
    skin: new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.8 }),
    visor: new THREE.MeshBasicMaterial({ color: type.visor }),
    gun: new THREE.MeshBasicMaterial({ color: 0x000000 }),
  };

  const ownGeo = [];
  const R = 0.17;
  const add = (geo, mat, x, y, z) => {
    ownGeo.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
    return m;
  };

  // Body, then the rubber bumper standing a couple of millimetres proud of it.
  const torso = add(new THREE.CylinderGeometry(R, R, 0.075, 20), mats.suit, 0, 0.045, 0);
  add(new THREE.CylinderGeometry(R + 0.008, R + 0.008, 0.028, 20), mats.skin, 0, 0.026, 0);
  // The lid, slightly inset, and the status ring on top of it. The ring is the
  // head as far as the rest of the game is concerned: it is the part that
  // stops a bullet, and it is the part that changes colour when it stops.
  add(new THREE.CylinderGeometry(R * 0.88, R * 0.88, 0.012, 20), mats.shirt, 0, 0.088, 0);
  const head = add(new THREE.CylinderGeometry(0.045, 0.045, 0.014, 12), mats.visor, 0, 0.095, -0.04);

  // Underside: the side brush that sweeps the skirting, and two drive wheels.
  const brush = new THREE.Group();
  brush.position.set(R * 0.62, 0.014, -R * 0.5);
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.BoxGeometry(0.075, 0.004, 0.008);
    ownGeo.push(geo);
    const arm = new THREE.Mesh(geo, mats.shirt);
    arm.position.x = 0.037;
    const pivot = new THREE.Group();
    pivot.rotation.y = (i / 3) * Math.PI * 2;
    pivot.add(arm);
    brush.add(pivot);
  }
  group.add(brush);

  return {
    rig: 'roomba', group, mats, ownGeo, torso, head,
    armL: null, armR: null, legL: null, legR: null, gun: null, blunt: null,
    bluntReach: 0, brush, flash: flashSet(mats),
    // A disc, simulated as the box it fits inside. The corners are a lie the
    // solver tells and the eye does not catch, because what a shot floor cleaner
    // does is flip onto its back and skid — and a box flips and skids. A real
    // cylinder shape in cannon is a convex hull with twenty faces, which is
    // twenty times the narrowphase for a silhouette nobody is studying while it
    // is sliding under a desk.
    bones: [{ whole: true, size: [0.34, 0.1, 0.34], at: [0, 0.055, 0], mass: 3.5 }],
  };
}

// The materials a hit flash whitens: the body and what it has on, never the
// visor (it is the one colour that has to keep meaning what it means) and never
// the gun. MeshBasicMaterial has no `emissive`, which is what filters those two
// out without naming them.
function flashSet(mats) {
  return Object.values(mats).filter((m) => m.emissive);
}

// Adds a shadow-casting box at a position, and hands it back.
function part(group) {
  return (geo, mat, px, py, pz) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    group.add(m);
    return m;
  };
}
