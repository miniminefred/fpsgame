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
const BLUNT = {
  keyboard: { shaft: null, head: [0.42, 0.03, 0.15], headMat: 'plastic', reach: 0.30 },
  extinguisher: { shaft: [0.07, 0.07, 0.10], head: [0.15, 0.15, 0.40], headMat: 'accent', reach: 0.34 },
  chairLeg: { shaft: [0.05, 0.05, 0.44], head: [0.13, 0.13, 0.13], headMat: 'metal', reach: 0.46 },
  stapler: { shaft: null, head: [0.09, 0.09, 0.26], headMat: 'metal', reach: 0.22 },
  monitor: { shaft: [0.05, 0.05, 0.16], head: [0.44, 0.30, 0.05], headMat: 'screen', reach: 0.30 },
  mug: { shaft: null, head: [0.11, 0.12, 0.11], headMat: 'paper', reach: 0.18 },
};

/**
 * Builds the body for a type. Returns everything the AI animates and everything
 * a level teardown has to release:
 *
 *   group      the object in the scene, at the floor, facing -Z
 *   mats       per-instance materials (a hit flash is one enemy going white)
 *   ownGeo     geometry made just for this one, to be disposed with it
 *   torso/head the two meshes that stop bullets
 *   limbs      whatever this rig has to swing; a rat has none of the human ones
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

  // Only melee staff need the junk-weapon palette, and only they pay for it.
  if (type.melee) {
    Object.assign(mats, {
      plastic: new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.8 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.5 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xb63b2c, roughness: 0.55 }),
      screen: new THREE.MeshStandardMaterial({ color: 0x1d2833, roughness: 0.35 }),
      paper: new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.85 }),
    });
  }

  const ownGeo = [];
  const mesh = part(group);

  const torso = mesh(GEO.torso, mats.suit, 0, 1.16, 0);
  mesh(GEO.hips, mats.suit, 0, 0.96, 0);
  mesh(GEO.shirt, mats.shirt, 0, 1.18, -0.155);   // open collar and shirt front
  const head = mesh(GEO.head, mats.skin, 0, 1.63, 0);
  mesh(GEO.visor, mats.visor, 0, 1.65, -0.13);
  const armL = mesh(GEO.arm, mats.suit, -0.32, 1.15, 0);
  const armR = mesh(GEO.arm, mats.suit, 0.32, 1.15, 0);
  const legL = mesh(GEO.leg, mats.suit, -0.12, 0.43, 0);
  const legR = mesh(GEO.leg, mats.suit, 0.12, 0.43, 0);
  const gun = mesh(GEO.gun, mats.gun, 0.3, 1.1, -0.3);

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
    bluntReach: 0, legs, tail,
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
    bluntReach: 0, brush,
  };
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
