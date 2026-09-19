import * as THREE from 'three';
import { hexCss } from './util.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getTech } from './tech-textures.js';
import { CAN_FLAVOURS, CAN_R, CAN_H, CAN_LABEL, drinkFrom } from './drinks.js';

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
  // The lower half of one, for the two poses that bend a knee. Its own geometry
  // rather than a scaled leg because a scaled MESH would scale anything parented
  // to it, and the whole point of the shin is that it hangs off nothing — see
  // the note on it below.
  shin: new THREE.BoxGeometry(0.17, 0.43, 0.19),
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

  // The two the machines swing. Neither was picked up off a desk — they are
  // fitted, which is the whole difference between a robot and a man with a
  // stapler: an arm that ends in a tool was built to end in one, so both are
  // short. Whatever reach a machine has, it has because it is big.
  //
  // The clamp is a pallet grab: a stubby ram with a wide jaw on the end of it,
  // and the widest business end on the roster. It reads at a distance the way
  // the mop does, which is what a two-metre loader needs — you have to be able
  // to see the arc coming.
  clamp: { shaft: [0.09, 0.09, 0.22], head: [0.30, 0.10, 0.20], headMat: 'metal', reach: 0.44 },
  // ...and the welder's torch, which is the opposite: almost no reach at all,
  // and the only melee weapon in the building with a lit end. `accent` is the
  // red the fire extinguisher is painted, and here it is the arc — the one part
  // of any of this the player is meant to notice before it is against them.
  //
  // NOTHING CARRIES IT at the moment: the Welder Unit went neutral, and a
  // harmless thing holding a cutting torch answers the question its visor is
  // there to answer. Kept rather than deleted because it is authored geometry
  // for a machine that still exists and still has a torch's job — but do not go
  // looking for the caller, there is not one.
  torch: { shaft: [0.05, 0.05, 0.26], head: [0.06, 0.06, 0.09], headMat: 'accent', reach: 0.34 },
};

// The sack truck, in the four numbers its own geometry is built from. Where the
// LOAD sits is not among them: it is read off `buildCrate`'s own dimensions down
// the file (`CRATE_H`, `CRATE_D`), because a box that sinks into the plate it is
// standing on, or through the frame it is leaning against, is the kind of thing
// nobody notices for months. Half a crate's height was typed here as its own
// number until the truck's crate got bigger, which is exactly the drift that
// costs — see `metrics.js` for the same argument at the scale of a whole body.
const TRUCK_W = 0.42;         // between the uprights
const TRUCK_PLATE = 0.30;     // how far the toe plate projects
const TRUCK_WHEEL_R = 0.095;
const TRUCK_BAR = 0.05;       // how thick the frame is

/**
 * A sack truck, and the numbers in it are a person's arm rather than a taste.
 *
 * AN ARM HERE IS ONE BOX WITH NO ELBOW (see `armAt` in enemy-anim.js, which
 * documents what that costs everywhere else), so a hand cannot be brought to a
 * handle at chest height with the truck upright beside the body — the way
 * anybody actually wheels one. What a straight arm swung forward CAN reach is a
 * grip about 0.93 m up and half a metre out, so that is where the handles are
 * and the frame leans forward from them onto its wheels. It comes out as
 * somebody wheeling it ahead of themselves at arm's length, which is the same
 * compromise the mop makes and reads for the same reason: the posture is wrong
 * by a bent elbow and right about everything else.
 *
 * `TRUCK_LEAN` is then the one free number, and it is fixed by the wheels having
 * to be ON THE FLOOR: the grip is 0.93 m up and the frame is `TRUCK_LEN` long,
 * so the lean is the angle that puts the axle at ground level. Written as that
 * arithmetic rather than as the 0.26 it comes to, because moving the grip or the
 * frame otherwise leaves a truck hovering or ploughing.
 *
 * It is authored UPRIGHT — grips at the origin, frame running down -Y, toe plate
 * and wheels at the bottom — and the lean is one rotation on the group. Four
 * cases written out by hand is the mistake `wall` and `edgeProp` both have
 * monuments to, and this is the same shape of thing one object smaller.
 *
 * The LOAD POINT is a node in the geometry rather than a number in the animator,
 * which is the `joints` lesson again: where a box sits is a fact about the truck,
 * and the one place that knows it is the file that built the toe plate. A crate
 * is parented to it (see `giveCrate` in enemies.js) and never positioned, so the
 * plate and the box cannot drift apart.
 */
// Where a straight arm swung forward and down ends, which is where the handles
// have to be. Exported because the animator bobs the truck with the stride and
// so has to know the height it is bobbing about — the `gunRest` lesson, one
// object along: a rig is the file that knows where a hand is.
export const TRUCK_GRIP = [0, 0.93, -0.50];
const TRUCK_LEN = 0.86;                // grips to axle
const TRUCK_LEAN = Math.acos(
  Math.min(1, (TRUCK_GRIP[1] - TRUCK_WHEEL_R) / TRUCK_LEN));

function truckOf(mats, ownGeo) {
  const truck = new THREE.Group();
  const add = (geo, mat, x, y, z, rot = null) => {
    ownGeo.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    mesh.castShadow = true;
    truck.add(mesh);
    return mesh;
  };

  const half = TRUCK_W / 2;
  // The two uprights, and a brace across them half way down. The brace is what
  // stops the frame reading as two loose bars at any distance.
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(TRUCK_BAR, TRUCK_LEN, TRUCK_BAR), mats.truck,
      side * half, -TRUCK_LEN / 2, 0);
  }
  // TWO braces rather than one, and the frame is a hand's width thick. Both are
  // about how it reads at three metres, which is the only range anybody sees it
  // from: at 3.5 cm bars and one brace it came out as a thin red trolley — the
  // silhouette of a sack truck is a LADDER, and one rung does not make one.
  for (const t of [0.38, 0.72]) {
    add(new THREE.BoxGeometry(TRUCK_W, 0.035, 0.035), mats.truck, 0, -TRUCK_LEN * t, 0);
  }
  // The handles: a crossbar with a dark grip either end, which is the whole of
  // what says "hold this" on something otherwise made of one colour.
  add(new THREE.BoxGeometry(TRUCK_W + 0.14, TRUCK_BAR, TRUCK_BAR), mats.truck, 0, -0.025, 0);
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.13, 0.055, 0.055), mats.truckDark,
      side * (half + 0.075), -0.025, 0);
  }
  // The toe plate, projecting forward at the foot of the frame. A crate sits on
  // this, and `load` below is where.
  const plateY = -TRUCK_LEN + 0.04;
  add(new THREE.BoxGeometry(TRUCK_W + 0.08, 0.026, TRUCK_PLATE), mats.truckDark,
    0, plateY, -TRUCK_PLATE / 2);
  // ...and the wheels, on an axle at the very bottom. Turned onto X, which is the
  // one rotation in here that is not the lean: a cylinder is built about +Y.
  for (const side of [-1, 1]) {
    add(new THREE.CylinderGeometry(TRUCK_WHEEL_R, TRUCK_WHEEL_R, 0.06, 10),
      mats.truckDark, side * (half + 0.04), -TRUCK_LEN, 0.01, [0, 0, Math.PI / 2]);
  }

  // Where a box rides: on the plate, half a crate up from it, with its back
  // against the front face of the uprights. `+ 0.013` clears the plate's own
  // half thickness so the box sits ON it rather than in it — it said 0.011 and
  // the plate is 0.026 thick, so the crate has always been two millimetres into
  // it, which is a comment that had stopped being true rather than a gap
  // anybody could see.
  //
  // The z is measured back from the FRAME rather than off the plate's length,
  // because what a load on a sack truck rests against is the frame — a crate
  // deeper than the toe plate overhangs its front and is still resting on the
  // truck, where one centred on the plate is a crate with the frame driven
  // through the back of it.
  const load = new THREE.Object3D();
  load.position.set(0, plateY + 0.013 + CRATE_H / 2, -TRUCK_BAR / 2 - CRATE_D / 2);
  truck.add(load);

  truck.position.set(TRUCK_GRIP[0], TRUCK_GRIP[1], TRUCK_GRIP[2]);
  truck.rotation.x = TRUCK_LEAN;
  return { truck, load };
}

// The palette a swung weapon is made of, and the reason it is a function: only
// the melee half of the roster ever pays for these six materials, and both rigs
// that swing anything need the same six. A machine's clamp and a man's mop are
// the same three colours of metal, plastic and paint.
function bluntMats() {
  return {
    plastic: new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.5 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xb63b2c, roughness: 0.55 }),
    screen: new THREE.MeshStandardMaterial({ color: 0x1d2833, roughness: 0.35 }),
    paper: new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.85 }),
    mophead: new THREE.MeshStandardMaterial({ color: 0xe8c33a, roughness: 1 }),
  };
}

// ...and the sack truck's two, a function for `bluntMats`' reason: one type on
// the whole roster carries one, so nothing else should pay for the materials.
//
// The red is the one bright thing in the pair now that the man pushing it is in
// a delivery uniform — blue trousers and a dark grey shirt — and that is the
// better way round than it was: it used to have to stay clear of six suit
// colours he might turn up in, one of them crimson, because a truck painted the
// same red as the man is one silhouette rather than two. The grips, the plate
// and the wheels are dark for
// the same reason the mop's head is yellow — a thing made of one colour reads as
// a shape, and one made of two reads as a machine.
function truckMats() {
  return {
    truck: new THREE.MeshStandardMaterial({ color: 0xa8241c, roughness: 0.5, metalness: 0.2 }),
    truckDark: new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.75 }),
  };
}

/**
 * A weapon from the BLUNT table, as a frame pointing along -Z with its grip at
 * the origin — so whoever is holding it only has to say where the hand is.
 *
 * Geometry is per instance and goes on `ownGeo`, which is not laziness: the
 * shaft and the head are both sized from the spec, and a floor holds one or two
 * of any given weapon rather than the two hundred a chassis has to answer for.
 */
function bluntOf(spec, mats, ownGeo, at) {
  const blunt = new THREE.Group();

  if (spec.shaft) {
    const [sw, sh, sl] = spec.shaft;
    const geo = new THREE.BoxGeometry(sw, sh, sl);
    ownGeo.push(geo);
    const shaft = new THREE.Mesh(geo, mats.plastic);
    shaft.position.z = -sl / 2;
    shaft.castShadow = true;
    blunt.add(shaft);
  }

  const [hw, hh, hl] = spec.head;
  const headGeo = new THREE.BoxGeometry(hw, hh, hl);
  ownGeo.push(headGeo);
  const business = new THREE.Mesh(headGeo, mats[spec.headMat]);
  business.position.z = -(spec.shaft ? spec.shaft[2] : 0) - hl / 2;
  business.castShadow = true;
  blunt.add(business);

  blunt.position.set(at[0], at[1], at[2]);
  return blunt;
}

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
  g.fillStyle = hexCss(cloth);
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = hexCss(ink);
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
  // A type names its chassis rather than its rig, because there is one machine
  // builder and six machines — see CHASSIS.
  if (type.chassis) return buildRobot(type, rng);
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

  // Only whoever is carrying something needs the junk-weapon palette, and only
  // they pay for it. `blunt` rather than `melee`, because those are two facts:
  // see the note where the weapon itself is built, below.
  if (type.blunt) Object.assign(mats, bluntMats());
  if (type.truck) Object.assign(mats, truckMats());

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
  // ON THE HEAD, not beside it. The head turns — `patrol` sweeps it, the seated
  // poses wander it, the walk bobs it — and the face was a sibling of it, so a
  // guard on his post looked one way and left his eyes hanging in the air where
  // his head had been. Positioned relative to the head now: it stood at 1.65
  // against a head at 1.63, so 0.02 above and the same 0.13 forward.
  //
  // Nothing else has to change for it. The six hit boxes are raycast
  // NON-recursively (`intersectObjects(this.hittables, false)` in shooting.js),
  // so a child of a hit box is not a new way to be shot; and the ragdoll's head
  // bone lists the head alone, because everything on the head rides with it.
  const onHead = part(head);
  const visor = onHead(GEO.visor, mats.visor, 0, 0.02, -0.13);
  const armL = mesh(GEO.arm, upper, -0.32, 1.15, 0);
  const armR = mesh(GEO.arm, upper, 0.32, 1.15, 0);
  const legL = mesh(GEO.leg, lower, -0.12, 0.43, 0);
  const legR = mesh(GEO.leg, lower, 0.12, 0.43, 0);
  // A KNEE, and it is deliberately not a joint in the skeleton.
  //
  // A leg here is one box from the hip to the floor, which is what makes the
  // walk cycle, the six hit zones and the ragdoll's five constraints as cheap as
  // they are — and it is also why a body sitting down used to stick both legs
  // out in front of it at seventy degrees like a deckchair. Splitting the leg
  // properly means a seventh hit box, a sixth bone, a new constraint and a walk
  // cycle that has to drive two segments, on every one of the seven rigs.
  //
  // So the knee is a PAIR OF SPARE SHINS instead. They hang off the GROUP rather
  // than off the leg, they are hidden for the whole life of a body that never
  // sits down, and the seated pose is the only thing that ever shows them: it
  // squashes the leg box to its top half and puts a shin below the knee. Nothing
  // else in the engine learns they exist — a raycast still meets the same thigh
  // box it always did, `bones` still lists `legL` alone, and a ragdoll takes the
  // leg and leaves these behind (which is why `_die` hides them).
  //
  // Being children of the group and not of the leg is the load-bearing part: a
  // child of a mesh inherits its scale, so a shin parented to a leg squashed to
  // half height would be squashed with it, which is exactly the deckchair again
  // with an extra box in it.
  const shinL = mesh(GEO.shin, lower, -0.12, 0.215, 0);
  const shinR = mesh(GEO.shin, lower, 0.12, 0.215, 0);
  shinL.visible = false;
  shinR.visible = false;
  const gun = mesh(GEO.gun, mats.gun, 0.3, 1.1, -0.3);

  // The cap, if this one wears one. Peak over the eyes, which is on the -z face
  // like everything else that faces forward.
  const cap = [];
  if (mats.cap) {
    // On the head with the face, and for the same reason: a cap that stays put
    // while the head turns under it is worse than no cap.
    cap.push(onHead(GEO.cap, mats.cap, 0, 0.16, 0));
    cap.push(onHead(GEO.capPeak, mats.cap, 0, 0.13, -0.18));
    // Above the peak, not level with it: the peak stands 4 cm further forward
    // than the crown, so a badge any lower is inside it.
    if (mats.capBadge) cap.push(onHead(GEO.capBadge, mats.capBadge, 0, 0.17, -0.146));
  }

  // Melee staff drop the gun and swing whatever was on their desk instead — and
  // the harmless are not armed at all.
  //
  // That second half was missing, and it had been quietly costing the neutrals
  // the one job they have. Measured on a floor: the Panicking Staffer 2 of 2,
  // the Night Cleaner 3 of 3 and the Maintenance Worker 4 of 4, every one of
  // them running about with a sidearm in their hand. The whole point of these
  // people is that you can decide not to shoot them from the far end of a
  // corridor — hue says threat and shade says which one — and a silhouette
  // holding a pistol has already answered that question the other way, whatever
  // colour its visor is.
  gun.visible = !type.melee && !type.neutral;
  let blunt = null;
  let bluntSpec = null;
  // WHAT SOMEBODY CARRIES AND WHAT THEY DO WITH IT ARE TWO FACTS, and this was
  // `type.melee` because until there was work to do they were the same one: the
  // only reason to be holding a mop was to swing it at somebody. A Night Cleaner
  // carries one to wash the floor with (see `works` in enemy-types.js) and does
  // not swing it at anything — and built off `melee` it came out empty-handed,
  // miming the mop pose over a bare patch of carpet. `blunt` is the declaration
  // and `melee` is what the state machine does about it; every melee type on the
  // roster declares one, so nothing lost its weapon in the swap.
  if (type.blunt) {
    bluntSpec = BLUNT[rng.pick(type.blunt)];
    // Held in the right hand, which is what the swing animation drives.
    blunt = bluntOf(bluntSpec, mats, ownGeo, [0.32, 1.12, -0.16]);
    group.add(blunt);
  }

  // ...and the sack truck, which is `blunt`'s shape exactly — a thing carried in
  // the hands, declared by the type rather than derived from what the type DOES
  // — and is deliberately not on that table. A blunt is a shaft and a business
  // end swung at somebody; this is a frame with wheels and a load on it, and
  // giving `BLUNT` a third field for the one entry that has geometry of its own
  // would make every other weapon on the roster carry a null.
  const wheeled = type.truck ? truckOf(mats, ownGeo) : null;
  if (wheeled) group.add(wheeled.truck);

  return {
    rig: 'human', group, mats, ownGeo, torso, head,
    armL, armR, legL, legR, gun, blunt,
    // The truck, and the node on it a box rides. See `truckOf`: where the load
    // sits is a fact about the toe plate, so it is a place in the geometry rather
    // than a number the animator keeps.
    truck: wheeled?.truck ?? null, load: wheeled?.load ?? null,
    // Only the human rig has them. Everything that reads them tests for them
    // first, so a machine sent to a desk simply keeps standing at it — which is
    // the honest picture of a Clerk Unit on wheels anyway.
    shinL, shinR,
    bluntReach: bluntSpec ? bluntSpec.reach : 0,
    bluntRest: bluntSpec?.rest ?? 0.5,
    // Two legs, and where the sidearm is carried and comes up to. Both used to
    // be written into the animator as constants, which was true of every body
    // in the building right up until one of them was a metre off the floor on a
    // pair of fans. A rig is the file that knows where a hand is.
    drive: 'legs',
    gunRest: [0.3, 1.1, -0.3], gunAim: [0.3, 1.32, -0.55],
    // Where the shoulders and hips ARE, which is the same lesson a third time.
    // `hinge` turns a limb about a real joint and `armAt` solves the angle that
    // puts a hand at a height, and both used to read module constants in
    // enemy-anim.js — true of every body in the building until one of them was a
    // trolley with stub arms half a metre up. A pose written against the wrong
    // shoulder does not merely look off: `stand` puts a wheel back at a person's
    // hip. See `joints` in the chassis builder for the machines' own numbers.
    joints: { armX: 0.32, armY: 1.15, armHalf: 0.27, hipX: 0.12, legY: 0.43, legHalf: 0.43 },
    // ...and where a carried BOX rides, which is the same lesson one object
    // further along. A parcel run puts a crate in somebody's hands, and "in
    // somebody's hands" is chest height on a person and a flat deck two thirds
    // of a metre off the floor on a porter. `boxArms` is whether the arms come
    // up to hold it at all.
    // ...and where a carried BOX rides, which is the same lesson one object
    // further along. Null on anybody with a truck, because then the box is not
    // carried at a height at all — it is parented to the plate it is standing on
    // (`load` above), which is what makes the two impossible to drift apart.
    boxAt: wheeled ? null : [0, 1.02, -0.34], boxArms: !wheeled,
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
      { parts: [head], size: [0.26, 0.28, 0.26], at: [0, 1.63, 0], mass: 5,
        joint: { to: 0, at: [0, 1.48, 0], angle: 0.65, twist: 0.5 } },
      { parts: [armL], size: [0.14, 0.54, 0.14], at: [-0.32, 1.15, 0], mass: 4,
        joint: { to: 0, at: [-0.27, 1.41, 0], angle: 1.4, twist: 0.8 } },
      { parts: [armR, gun, blunt, wheeled?.truck], size: [0.14, 0.54, 0.14], at: [0.32, 1.15, 0], mass: 4,
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
  // The face goes ON the head, which `animateRat` nods — snout, ears and eyes
  // together, because all four used to be siblings of the head and stayed
  // exactly where they were while it moved. Offsets are what they were, less
  // the head's own (0, H + 0.02, -0.16).
  const onHead = part(head);
  onHead(GEO.ratSnout, mats.skin, 0, -0.015, -0.07);
  onHead(GEO.ratEar, mats.skin, -0.05, 0.055, 0.015);
  onHead(GEO.ratEar, mats.skin, 0.05, 0.055, 0.015);
  // Eyes carry the type colour, the way a visor does on everything else — a rat
  // is the one thing on the floor with no visor to put it on.
  onHead(GEO.ratEye, mats.visor, -0.032, 0.015, -0.048);
  onHead(GEO.ratEye, mats.visor, 0.032, 0.015, -0.048);

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

// --- the machines -----------------------------------------------------------
//
// An Automated floor is not staffed, it is WORKED — and "a machine" is not one
// silhouette. The thing hauling pallets, the thing welding a rack and the thing
// that used to sit at the desk are three different shapes doing three different
// jobs, and a floor of one robot repeated is the floor of one enemy repeated
// that `share` was written to avoid (see enemy-types.js). So this is one
// builder and a table of chassis, exactly the way the staff are one rig and a
// table of numbers.
//
// Every chassis hands back the SAME field names as a person — torso, head,
// armL/armR, legL/legR, gun, blunt — and that is the whole trick: the state
// machine, the six hit zones, the ragdoll and the walk cycle never learn that
// this one is on wheels. Two things had to be told, and only two:
//
//   drive     what it gets about on, which is the one thing a leg swing cannot
//             guess. See animate in enemy-anim.js.
//   gunRest   where the weapon is carried, and where it comes up to. Those two
//   gunAim    used to be written into the animator, which is fine while every
//             body is the same height and wrong the moment one of them is a
//             metre and a quarter off the floor on a pair of fans.
//
// Geometry is memoised PER CHASSIS rather than per body, unlike the rat and the
// floor cleaner. Those are one to five a floor and can afford their own boxes;
// a machine floor is a hundred and fifty Clerk Units, and fifteen fresh
// BufferGeometries each is two thousand of them for six distinct shapes.
const FRAME = 0x2a2e34;      // the dark frame under every machine's paint

// How a chassis is put together. Sizes and heights are in unscaled rig space,
// the way the human rig's are — `type.scale` is applied to the group by whoever
// builds the body, so a spec here is the machine at 1.0.
//
// `mass` is the whole machine in kilograms and is split across the bones the
// way a person's is, because a ragdoll does not need the real distribution and
// one number per chassis is a number somebody will keep honest.
const CHASSIS = {
  // The office automaton: whatever used to sit at the desk. Human proportions
  // on purpose — it works a building built for people, at their desks and
  // through their doorways — so what says MACHINE is the head and the finish: a
  // sensor pod with one lit band across it and no face behind it.
  //
  // The plainest of the six, and deliberately: it is the one there are a
  // hundred of, so it is the silhouette the floor is made of, and the ones with
  // forks and tanks and rotors have to read as exceptions to it.
  clerk: {
    drive: 'legs', mass: 95,
    torso: { size: [0.42, 0.58, 0.32], y: 1.18 },
    pod: { size: [0.24, 0.22, 0.26], y: 1.58 },
    arm: { size: [0.11, 0.52, 0.11], x: 0.30, y: 1.16 },
    leg: { size: [0.15, 0.80, 0.17], x: 0.12, y: 0.40 },
    gun: { rest: [0.30, 1.12, -0.30], aim: [0.30, 1.30, -0.55] },
  },

  // Facilities' idea of a cost saving, and the only machine on this roster that
  // was bought to fight rather than to work. Wide, low and on tracks — the one
  // thing in the building with neither legs nor wheels, because a gun platform
  // does not need to be quick, it needs to still be pointing at you.
  sentry: {
    drive: 'tracks', mass: 210,
    torso: { size: [0.56, 0.60, 0.44], y: 1.02 },
    pod: { size: [0.30, 0.20, 0.30], y: 1.44 },
    arm: { size: [0.14, 0.48, 0.14], x: 0.35, y: 1.02 },
    leg: { size: [0.19, 0.42, 0.62], x: 0.20, y: 0.21 },
    gun: { rest: [0.34, 0.98, -0.34], aim: [0.34, 1.16, -0.62] },
    collar: true,
  },

  welder: {
    drive: 'legs', mass: 78,
    torso: { size: [0.32, 0.46, 0.28], y: 1.12 },
    pod: { size: [0.19, 0.16, 0.21], y: 1.44 },
    arm: { size: [0.09, 0.56, 0.09], x: 0.25, y: 1.10 },
    leg: { size: [0.10, 0.86, 0.12], x: 0.13, y: 0.43 },
    gun: { rest: [0.25, 1.06, -0.28], aim: [0.25, 1.24, -0.52] },
    tank: true,
  },

  // The surveyor: a small ducted-fan thing that never touches the floor. It is
  // AUTHORED a metre and a quarter up rather than made to hover — a rig is
  // placed at its body's feet, so a machine that flies is a machine whose parts
  // are simply higher up, and nothing in the engine has to learn what flight
  // is. The bob on top of that is the animator's.
  //
  // Its skids stand in for legs, so a limb hit lands on them. That is right: on
  // something this size the underside is most of what you can see of it.
  drone: {
    drive: 'hover', mass: 26, whole: true,
    torso: { size: [0.34, 0.24, 0.34], y: 1.30 },
    pod: { size: [0.20, 0.15, 0.20], y: 1.51 },
    arm: { size: [0.08, 0.32, 0.08], x: 0.23, y: 1.26 },
    leg: { size: [0.05, 0.16, 0.30], x: 0.14, y: 1.10 },
    gun: { rest: [0.23, 1.22, -0.26], aim: [0.23, 1.30, -0.42] },
    rotors: true,
  },
};

// How a machine's mass is divided between its bones — the human rig's own
// split, normalised. A ragdoll does not need the real distribution of a loader;
// what it needs is for the trunk to outweigh an arm by about eight to one, and
// that is a fact about bodies rather than about people.
const BONE_SHARE = [34, 5, 4, 4, 11, 11].map((m) => m / 69);

// Built once per chassis and never disposed, exactly like GEO above: six shapes
// serve every machine the game will ever build, and a floor holds a hundred and
// fifty of them.
const chassisGeo = new Map();

function geoFor(key) {
  const cached = chassisGeo.get(key);
  if (cached) return cached;

  const s = CHASSIS[key];
  const box = (a) => new THREE.BoxGeometry(a[0], a[1], a[2]);
  const [pw, ph, pd] = s.pod.size;
  const [lw, lh] = s.leg.size;

  const g = {
    torso: box(s.torso.size),
    pod: box(s.pod.size),
    // The gap between the two, filled in. A pod floating over a chassis is the
    // one thing that makes a robot read as a stack of boxes rather than a body.
    neck: new THREE.BoxGeometry(pw * 0.45,
      Math.max(0.04, (s.pod.y - ph / 2) - (s.torso.y + s.torso.size[1] / 2)), pd * 0.45),
    // One lit band across the front of the pod. This is the rig's visor and it
    // does the visor's whole job: hue says whether to shoot it, shade says which
    // one it is, from the far end of a corridor.
    visor: new THREE.BoxGeometry(pw * 0.78, ph * 0.26, 0.02),
    arm: box(s.arm.size),
    gun: new THREE.BoxGeometry(0.1, 0.13, 0.40),
  };

  // What it gets about on. A wheel is a cylinder with its axle baked along X —
  // the quarter turn goes into the GEOMETRY rather than onto the mesh, because
  // the mesh has to stay free to spin about that same axis, and it is a hit box
  // and a ragdoll bone besides.
  if (s.drive === 'wheels') {
    const r = lh / 2;
    g.leg = new THREE.CylinderGeometry(r, r, lw, 14).rotateZ(Math.PI / 2);
    // A wheel is a solid of revolution, so nothing about it turning is visible
    // without a mark on it. The spoke plate is the mark.
    g.spoke = new THREE.BoxGeometry(lw + 0.012, r * 1.5, r * 0.34);
  } else {
    g.leg = box(s.leg.size);
  }

  if (s.collar) g.collar = new THREE.BoxGeometry(0.17, 0.11, s.torso.size[2] * 0.8);
  if (s.band) {
    // The hazard band round the housing. It exists because the loader is the
    // one machine painted a colour rather than a shade, and a two-thirds-of-a-
    // metre slab of flat hi-vis reads as a yellow crate rather than as plant.
    // Two geometries and three boxes: the front, and one down each flank.
    g.bandF = new THREE.BoxGeometry(s.torso.size[0] + 0.02, 0.11, 0.02);
    g.bandS = new THREE.BoxGeometry(0.02, 0.11, s.torso.size[2] + 0.02);
  }
  if (s.forks) g.fork = new THREE.BoxGeometry(0.075, 0.055, 0.66);
  if (s.tank) g.tank = new THREE.CylinderGeometry(0.085, 0.085, 0.32, 12);
  if (s.rotors) {
    g.boom = new THREE.BoxGeometry(0.06, 0.045, 0.06);
    // Open-ended, which makes it a shroud rather than a drum: you have to be
    // able to see the blade turning inside it or the whole thing is a hoop.
    g.duct = new THREE.CylinderGeometry(0.15, 0.15, 0.05, 16, 1, true);
    g.blade = new THREE.BoxGeometry(0.26, 0.008, 0.05);
  }
  if (s.tray) {
    g.tray = new THREE.BoxGeometry(s.torso.size[0] + 0.08, 0.035, s.torso.size[2] + 0.06);
    g.rail = new THREE.BoxGeometry(0.03, 0.10, s.torso.size[2] + 0.06);
    g.parcel = new THREE.BoxGeometry(0.22, 0.18, 0.24);
  }
  if (s.beacon) {
    g.mast = new THREE.BoxGeometry(0.035, 0.10, 0.035);
    g.beacon = new THREE.CylinderGeometry(0.045, 0.045, 0.055, 10);
  }
  // The lit panel on the front of the chassis. Every machine gets one — it is
  // the cheapest thing on the roster that says the difference between a painted
  // box and a box that is switched on, and it is the one part of a machine that
  // is still doing something while it stands still.
  g.screen = new THREE.PlaneGeometry(s.torso.size[0] * 0.42, s.torso.size[1] * 0.26);

  chassisGeo.set(key, g);
  return g;
}

/**
 * A machine. Same contract as a person, and the same six bones — see the note
 * above CHASSIS for why that matters more than anything else in here.
 */
function buildRobot(type, rng) {
  const s = CHASSIS[type.chassis];
  const geo = geoFor(type.chassis);
  const tech = getTech();

  const group = new THREE.Group();
  group.rotation.y = rng.range(0, Math.PI * 2);
  group.scale.setScalar(type.scale);

  const mats = {
    // `suit` is the painted shell and `shirt` the panels and trim — the same
    // two-colour reading a person's suit and shirt give, under the same two
    // names, so a type's palette means the same thing whichever rig wears it
    // and the hit flash needs no special case.
    suit: new THREE.MeshStandardMaterial({ color: type.suit, roughness: 0.42, metalness: 0.45 }),
    shirt: new THREE.MeshStandardMaterial({ color: type.shirt, roughness: 0.55, metalness: 0.25 }),
    // The frame everything is bolted to, standing in for `skin`. It is the one
    // colour every machine on the floor shares: a chassis is a chassis whoever
    // painted the panels over it.
    skin: new THREE.MeshStandardMaterial({ color: FRAME, roughness: 0.5, metalness: 0.6 }),
    visor: new THREE.MeshBasicMaterial({ color: type.visor }),
    gun: new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.5, metalness: 0.4 }),
    // Lit rather than lit-upon, like the visor and for the same reason: a screen
    // that goes dark when the room does is a screen nobody switched on. Tinted
    // rather than white so the readout carries a little of the machine's own
    // paint, which is what keeps six of them in a corridor from looking like six
    // copies of one panel.
    screen: new THREE.MeshBasicMaterial({ map: tech.readout, color: 0xbfe6ff }),
  };
  // Plating on the paint and on the frame under it. One image over both, because
  // it IS one factory finish — what differs is the colour it is multiplying
  // against, which is the whole reason the canvas is drawn near-white.
  mats.suit.map = tech.plate;
  mats.skin.map = tech.plate;
  if (type.blunt) Object.assign(mats, bluntMats());
  if (s.tray) {
    mats.parcel = new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.95 });
  }
  if (s.band) {
    // The hazard band gets its own material rather than sharing the trim's,
    // because it is the one part of a machine that is painted to be looked at:
    // the stripes multiply against a hi-vis yellow instead of against the dark
    // grey everything else on the loader is.
    mats.band = new THREE.MeshStandardMaterial({
      map: tech.hazard, color: 0xe0aa2e, roughness: 0.72,
    });
  }
  if (s.beacon) {
    // Unlit, like the visor, and for the same reason: a lamp that goes dark
    // with the room is not a lamp. The animator pulses it — see animate.
    mats.beacon = new THREE.MeshBasicMaterial({ color: 0xffa42c });
  }

  const ownGeo = [];
  const mesh = part(group);
  const rotors = [];
  let beacon = null;
  // Filled in by the tray block below if this chassis has a deck. Declared out
  // here because `boxAt` at the bottom has to know whether it was.
  let deckY = null;

  const torso = mesh(geo.torso, mats.suit, 0, s.torso.y, 0);
  mesh(geo.neck, mats.skin, 0,
    (s.torso.y + s.torso.size[1] / 2 + s.pod.y - s.pod.size[1] / 2) / 2, 0);
  const head = mesh(geo.pod, mats.shirt, 0, s.pod.y, 0);
  // On the pod rather than beside it — the same fix the human rig needed, and
  // the same reason: the pod IS this rig's head and `patrol` turns it.
  const visor = part(head)(geo.visor, mats.visor, 0, 0, -(s.pod.size[2] / 2 + 0.011));

  const armL = mesh(geo.arm, mats.skin, -s.arm.x, s.arm.y, 0);
  const armR = mesh(geo.arm, mats.skin, s.arm.x, s.arm.y, 0);
  const legL = mesh(geo.leg, mats.skin, -s.leg.x, s.leg.y, 0);
  const legR = mesh(geo.leg, mats.skin, s.leg.x, s.leg.y, 0);
  const gun = mesh(geo.gun, mats.gun, s.gun.rest[0], s.gun.rest[1], s.gun.rest[2]);
  gun.visible = !type.melee && !type.neutral;

  // The spoke plates ride INSIDE the wheels, so the ragdoll takes them with the
  // bone it re-parents and nothing has to list them twice.
  if (geo.spoke) {
    for (const wheel of [legL, legR]) {
      const spoke = new THREE.Mesh(geo.spoke, mats.shirt);
      spoke.castShadow = true;
      wheel.add(spoke);
    }
  }

  // --- and then whatever makes this one this one -----------------------------
  // All of it is bolted to the chassis, so the trunk bone carries the lot.
  const extra = [];

  if (geo.collar) {
    const y = s.torso.y + s.torso.size[1] / 2 - 0.04;
    const x = s.torso.size[0] / 2 + 0.06;
    extra.push(mesh(geo.collar, mats.shirt, -x, y, 0), mesh(geo.collar, mats.shirt, x, y, 0));
  }
  if (geo.bandF) {
    const y = s.torso.y + s.torso.size[1] * 0.16;
    extra.push(mesh(geo.bandF, mats.band, 0, y, -(s.torso.size[2] / 2 + 0.011)));
    for (const side of [-1, 1]) {
      extra.push(mesh(geo.bandS, mats.band, side * (s.torso.size[0] / 2 + 0.011), y, 0));
    }
  }
  if (geo.fork) {
    // Out front at ankle height, where a pallet is. Deliberately long: it is
    // the half of a loader you see when it is walking away from you.
    const y = s.leg.y - s.leg.size[1] * 0.18;
    extra.push(mesh(geo.fork, mats.shirt, -0.19, y, -0.42),
      mesh(geo.fork, mats.shirt, 0.19, y, -0.42));
  }
  if (geo.tank) {
    const tank = mesh(geo.tank, mats.shirt, 0, s.torso.y + 0.02, s.torso.size[2] / 2 + 0.10);
    tank.rotation.x = 0.12;
    extra.push(tank);
  }
  if (geo.duct) {
    for (const side of [-1, 1]) {
      const x = side * (s.torso.size[0] / 2 + 0.17);
      extra.push(mesh(geo.boom, mats.skin,
        side * (s.torso.size[0] / 2 + 0.05), s.torso.y + 0.09, 0));
      extra.push(mesh(geo.duct, mats.suit, x, s.torso.y + 0.10, 0));
      const blade = mesh(geo.blade, mats.shirt, x, s.torso.y + 0.10, 0);
      extra.push(blade);
      rotors.push(blade);
    }
  }
  if (geo.tray) {
    deckY = s.torso.y + s.torso.size[1] / 2 + 0.018;
    const deck = deckY;
    extra.push(mesh(geo.tray, mats.shirt, 0, deck, 0));
    extra.push(mesh(geo.rail, mats.skin, -(s.torso.size[0] / 2 + 0.03), deck + 0.06, 0));
    extra.push(mesh(geo.rail, mats.skin, s.torso.size[0] / 2 + 0.03, deck + 0.06, 0));
    // One to three parcels, which is the whole reason this thing is on the
    // floor. Rolled rather than fixed: a porter with nothing on it has finished
    // its round, and a porter stacked three high is on its way out with one.
    for (let i = rng.int(1, 3); i > 0; i--) {
      const p = mesh(geo.parcel, mats.parcel, rng.range(-0.06, 0.06),
        deck + 0.108, -0.17 + (i - 1) * 0.19);
      p.rotation.y = rng.range(-0.25, 0.25);
      extra.push(p);
    }
  }
  if (geo.beacon) {
    const y = s.pod.y + s.pod.size[1] / 2;
    extra.push(mesh(geo.mast, mats.skin, 0, y + 0.05, 0));
    beacon = mesh(geo.beacon, mats.beacon, 0, y + 0.128, 0);
    extra.push(beacon);
  }

  // The readout, a couple of millimetres off the plating so it never z-fights
  // with it. A plane rather than a box: it is a screen, it is only ever seen
  // from the front, and two triangles on a hundred and fifty bodies is worth
  // being careful about.
  const screen = mesh(geo.screen, mats.screen,
    0, s.torso.y + s.torso.size[1] * 0.12, -(s.torso.size[2] / 2 + 0.006));
  // A PlaneGeometry faces +Z and a machine faces -Z, so without this the one
  // lit thing on the front of the chassis is a back face and is not drawn at
  // all. It is also the only part of a rig that must not cast: a flat quad
  // pressed against plating shadows itself along its own edge.
  screen.rotation.y = Math.PI;
  screen.castShadow = false;
  extra.push(screen);

  let blunt = null;
  let bluntSpec = null;
  // `blunt` rather than `melee` — see the note in the human builder above.
  if (type.blunt) {
    bluntSpec = BLUNT[rng.pick(type.blunt)];
    // On the end of the right arm, the way the human rig holds one: the swing
    // animation drives the arm and the tool rides it.
    blunt = bluntOf(bluntSpec, mats, ownGeo,
      [s.arm.x, s.arm.y - s.arm.size[1] * 0.08, -s.arm.size[2] * 0.6]);
    group.add(blunt);
  }

  // A wheel is as deep as it is tall, which its spec cannot say — the spec
  // gives a cylinder's width and diameter, and a bone wants a box.
  const legBox = s.drive === 'wheels'
    ? [s.leg.size[0], s.leg.size[1], s.leg.size[1]]
    : s.leg.size;

  // Where a parcel-run crate rides on this chassis. A machine with a DECK
  // carries it on the deck and does not raise its arms — that is what a deck is,
  // and lifting a box to the chest of a flat trolley is the one way to make a
  // delivery robot look like it is struggling with the parcel. Everything else
  // holds it out in front at its own arm height. Declared here for the reason
  // `gunRest` is: the animator held these as constants, which was true of every
  // body in the building until one of them was a trolley.
  const boxAt = deckY !== null
    ? [0, deckY + 0.145, 0.04]
    : [0, s.arm.y + 0.16, -(s.torso.size[2] / 2 + 0.20)];

  return {
    rig: 'robot', group, mats, ownGeo, torso, head,
    armL, armR, legL, legR, gun, blunt,
    bluntReach: bluntSpec ? bluntSpec.reach : 0,
    bluntRest: bluntSpec?.rest ?? 0.5,
    drive: s.drive,
    gunRest: s.gun.rest, gunAim: s.gun.aim,
    // Read straight off the chassis table, so a machine works a copier with its
    // own shoulders rather than a person's. See `joints` on the human rig.
    joints: {
      armX: s.arm.x, armY: s.arm.y, armHalf: s.arm.size[1] / 2,
      hipX: s.leg.x, legY: s.leg.y, legHalf: s.leg.size[1] / 2,
    },
    boxAt, boxArms: deckY === null,
    rotors: rotors.length ? rotors : null,
    beaconMat: beacon ? mats.beacon : null,
    flash: flashSet(mats),
    bones: s.whole
      // One solid piece as far as falling over goes. Six bones is six bones
      // spent on something that weighs as much as a chair and was in the air
      // when it stopped working; a porter is a deck on wheels, which is a box
      // that rolls over. Both tumble, which is all either has ever needed to
      // do — see the rat, which makes the same trade for the same reason.
      ? [{
        whole: true, mass: s.mass,
        size: [Math.max(s.torso.size[0], s.leg.x * 2 + s.leg.size[0]),
          s.pod.y + s.pod.size[1] / 2, s.torso.size[2] + (s.tray ? 0.1 : 0)],
        at: [0, (s.pod.y + s.pod.size[1] / 2) / 2, 0],
      }]
      : [
        {
          parts: [torso, ...extra], size: s.torso.size, at: [0, s.torso.y, 0],
          mass: s.mass * BONE_SHARE[0],
        },
        {
          parts: [head], size: s.pod.size, at: [0, s.pod.y, 0],
          mass: s.mass * BONE_SHARE[1],
          joint: { to: 0, at: [0, s.pod.y - s.pod.size[1] / 2, 0], angle: 0.5, twist: 0.4 },
        },
        {
          parts: [armL], size: s.arm.size, at: [-s.arm.x, s.arm.y, 0],
          mass: s.mass * BONE_SHARE[2],
          joint: { to: 0, at: [-s.arm.x, s.arm.y + s.arm.size[1] / 2, 0], angle: 1.2, twist: 0.6 },
        },
        {
          parts: [armR, gun, blunt], size: s.arm.size, at: [s.arm.x, s.arm.y, 0],
          mass: s.mass * BONE_SHARE[3],
          joint: { to: 0, at: [s.arm.x, s.arm.y + s.arm.size[1] / 2, 0], angle: 1.2, twist: 0.6 },
        },
        {
          parts: [legL], size: legBox, at: [-s.leg.x, s.leg.y, 0],
          mass: s.mass * BONE_SHARE[4],
          joint: { to: 0, at: [-s.leg.x, s.leg.y + s.leg.size[1] / 2, 0], angle: 0.6, twist: 0.2 },
        },
        {
          parts: [legR], size: legBox, at: [s.leg.x, s.leg.y, 0],
          mass: s.mass * BONE_SHARE[5],
          joint: { to: 0, at: [s.leg.x, s.leg.y + s.leg.size[1] / 2, 0], angle: 0.6, twist: 0.2 },
        },
      ],
  };
}

/**
 * A tray of lunch, for whoever is on their break — see _lunch in enemies.js.
 *
 * Built on demand rather than hidden on every rig the way the sidearm is, and
 * that is the difference between a handful of these on a floor and a hundred
 * and fifty: a gun is carried by most of the building and a tray by four people
 * at a time, so this is the one thing a body is handed rather than born with.
 *
 * Geometry AND materials are module-level and never disposed, like `capLabels`
 * above. A tray is not part of anybody's hit flash — it is not what they are
 * wearing, it is what they are holding — so it has no business in `mats`, which
 * is also what keeps it out of the per-body disposal a rig's materials get.
 *
 * Authored around the point it is held at, facing -Z like everything else, so
 * the caller only has to say where the hands are.
 */
let trayParts = null;

export function buildTray() {
  trayParts ??= {
    geo: {
      slab: new THREE.BoxGeometry(0.34, 0.02, 0.24),
      lip: new THREE.BoxGeometry(0.34, 0.025, 0.015),
      bowl: new THREE.BoxGeometry(0.14, 0.05, 0.14),
      cup: new THREE.CylinderGeometry(0.032, 0.028, 0.09, 8),
      // Whatever is on the plate. One box, and its whole job is to be a colour
      // that is not the tray: at the range you ever see one this is a bright
      // spot on a grey slab, and that is all it needs to be.
      food: new THREE.BoxGeometry(0.10, 0.03, 0.10),
    },
    mat: {
      tray: new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.7 }),
      bowl: new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.85 }),
      food: new THREE.MeshStandardMaterial({ color: 0xc4622e, roughness: 0.9 }),
      cup: new THREE.MeshStandardMaterial({ color: 0xd8dde1, roughness: 0.6 }),
    },
  };

  const { geo, mat } = trayParts;
  const group = new THREE.Group();
  const put = (g, m, x, y, z) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  };

  put(geo.slab, mat.tray, 0, 0, 0);
  put(geo.lip, mat.tray, 0, 0.012, -0.12);
  put(geo.lip, mat.tray, 0, 0.012, 0.12);
  put(geo.bowl, mat.bowl, -0.05, 0.035, -0.01);
  put(geo.food, mat.food, -0.05, 0.06, -0.01);
  put(geo.cup, mat.cup, 0.11, 0.055, 0.03);
  return group;
}

let canParts = null;
const canLabels = new Map();


/**
 * The label, wrapped round the middle of the can.
 *
 * Per FLAVOUR rather than shared, which is what makes each drink its own brand
 * rather than one label in four colours: the wordmark, the wedge and the two
 * rules all come off the flavour, and only the slate ground is common. Four
 * canvases is the whole cost, and they are built on first use, so a floor pays
 * for the drinks somebody actually bought.
 *
 * The word is on there TWICE, half a turn apart, because a cylinder shows you
 * rather less than half of itself and a label you have to walk round the body
 * to read is a label nobody reads.
 *
 * 340 x 100 is not an arbitrary canvas, it is the sleeve's own aspect: the band
 * is 0.088 m tall round a circumference of 0.299, which is 3.4:1. A squarer
 * canvas is stretched horizontally onto it, and the tell is lettering that comes
 * out fat — the wordmark is the one thing on the can with a shape the eye
 * already knows.
 *
 * A cylinder's u runs round the circumference and its v up the side, and both
 * run the way you would draw them: for somebody standing outside the can, u
 * increases to their right and the canvas's top edge is the top of the label.
 * So the artwork goes on the canvas the right way round and comes out the right
 * way round — the same assumption `capLabel` makes about the badge on a cap.
 */
function canLabel(flavour) {
  let tex = canLabels.get(flavour);
  if (tex) return tex;

  const spec = CAN_FLAVOURS[flavour % CAN_FLAVOURS.length];
  const canvas = document.createElement('canvas');
  canvas.width = 340;
  canvas.height = 100;
  const g = canvas.getContext('2d');
  const ink = hexCss(spec.color);

  // Slate, which is what the rest of this building is painted. A pale can in a
  // grey office is a drink somebody brought in from outside; a dark one with the
  // flavour striped across it is a drink the building sells you.
  g.fillStyle = '#23272b';
  g.fillRect(0, 0, 340, 100);
  g.fillStyle = ink;
  g.fillRect(0, 0, 340, 5);
  g.fillRect(0, 95, 340, 5);

  for (const ox of [0, 170]) {
    g.save();
    g.translate(ox, 0);
    // A wedge rather than a swirl. This building is drawn in straight lines and
    // right angles, and the machine in the corridor was stocked by whoever
    // fitted the carpet.
    g.fillStyle = ink;
    g.beginPath();
    g.moveTo(6, 80);
    g.lineTo(164, 64);
    g.lineTo(164, 78);
    g.lineTo(6, 94);
    g.closePath();
    g.fill();

    g.fillStyle = '#f4f2ec';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (spec.lines.length > 1) {
      g.font = 'bold 27px system-ui, sans-serif';
      spec.lines.forEach((line, i) => g.fillText(line, 85, 26 + i * 28, 150));
    } else {
      g.font = 'bold 42px system-ui, sans-serif';
      g.fillText(spec.lines[0], 85, 38, 150);
    }
    g.restore();
  }

  tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  canLabels.set(flavour, tex);
  return tex;
}

/**
 * The two shapes a can comes in, built once and shared by everybody drinking
 * that way.
 *
 * ONE mesh apiece, not one per piece, and that is what pays for the shape. A can
 * is six parts — a base that tucks in, a barrel, a shoulder, a rim, a lid and
 * the tab — plus the label sleeve round its middle, and seven meshes apiece with
 * forty cans on a floor is not a thing to do to the renderer. Each shape is
 * merged into ONE geometry with a material group per bucket, so a can is one
 * Mesh with three or four materials against the two meshes it cost as a coloured
 * tube. The parts earn it in silhouette: a cylinder with a flat top is a tin,
 * and the tuck at both ends with the rim standing proud of the shoulder is the
 * whole of what says "drinks can" before the label is close enough to read.
 */
function canShapes() {
  const seg = 14;
  // Authored from the base up and shifted onto its own middle as it goes, so the
  // numbers read as the can's own elevation while the finished thing still hangs
  // off its centre the way everything else in this file does.
  const at = (geo, y) => geo.translate(0, y - CAN_H / 2, 0);

  const whole = (() => {
    const shell = mergeGeometries([
      at(new THREE.CylinderGeometry(CAN_R, CAN_R * 0.86, 0.020, seg), 0.010),
      at(new THREE.CylinderGeometry(CAN_R, CAN_R, 0.130, seg), 0.085),
      at(new THREE.CylinderGeometry(CAN_R * 0.76, CAN_R, 0.026, seg), 0.163),
    ], false);
    // Open-ended and a hair proud of the barrel: a sleeve round the middle with
    // the flavour's own paint showing above and below it. Those two bands of
    // bare colour are what still read from the end of a corridor once the
    // artwork has gone to mush.
    const label = at(
      new THREE.CylinderGeometry(CAN_R * 1.012, CAN_R * 1.012,
        CAN_LABEL.y1 - CAN_LABEL.y0, seg, 1, true), (CAN_LABEL.y0 + CAN_LABEL.y1) / 2);
    const tab = new THREE.BoxGeometry(0.026, 0.004, 0.013);
    tab.translate(0.008, 0.196 - CAN_H / 2, 0);
    const metal = mergeGeometries([
      at(new THREE.CylinderGeometry(CAN_R * 0.78, CAN_R * 0.76, 0.010, seg), 0.181),
      at(new THREE.CylinderGeometry(CAN_R * 0.72, CAN_R * 0.78, 0.008, seg), 0.190),
      tab,
    ], false);
    // Group 0 the paint, 1 the label, 2 the bright metal — the order the
    // material array is built in. `mergeGeometries(…, true)` is what makes one
    // group per input rather than one run of triangles.
    return mergeGeometries([shell, label, metal], true);
  })();

  const shot = (() => {
    // Everything above the crush is authored about ITS OWN base and then turned,
    // because `rotateZ` turns a geometry about the origin — which is exactly the
    // hinge a folded-over can bends on. Turned first, translated up after: the
    // other order swings the whole top out sideways instead of leaning it.
    const CRUSH_Y = 0.112;
    const CRUSH_R = CAN_R * 0.66;
    const LEAN = 0.34;
    const fold = (geo) => geo.rotateZ(LEAN).translate(0, CRUSH_Y - CAN_H / 2, 0);

    const shell = mergeGeometries([
      at(new THREE.CylinderGeometry(CAN_R, CAN_R * 0.86, 0.020, seg), 0.010),
      at(new THREE.CylinderGeometry(CAN_R * 0.95, CAN_R, 0.062, seg), 0.051),
      // The crush itself: the round went through here and the can folded on it.
      at(new THREE.CylinderGeometry(CRUSH_R, CAN_R * 0.95, 0.030, seg), 0.097),
      fold(mergeGeometries([
        new THREE.CylinderGeometry(CAN_R * 0.88, CRUSH_R, 0.036, seg).translate(0, 0.018, 0),
        new THREE.CylinderGeometry(CAN_R * 0.70, CAN_R * 0.88, 0.024, seg).translate(0, 0.048, 0),
      ], false)),
    ], false);

    // Tapered to follow the barrel it is stuck to rather than a straight sleeve:
    // the lower barrel is a cone here, and a cylinder over it sinks into the
    // paint at one end and floats off it at the other. Shorter than the whole
    // can's, and squashed by being the same artwork over a shorter band — which
    // is what a label on a crushed can looks like.
    const label = at(
      new THREE.CylinderGeometry(CAN_R * 0.962, CAN_R * 1.012, 0.050, seg, 1, true), 0.050);

    const metal = fold(mergeGeometries([
      new THREE.CylinderGeometry(CAN_R * 0.72, CAN_R * 0.70, 0.010, seg).translate(0, 0.065, 0),
      new THREE.CylinderGeometry(CAN_R * 0.66, CAN_R * 0.72, 0.008, seg).translate(0, 0.074, 0),
    ], false));

    // The hole, and the tear it came out of — painted on rather than cut, the
    // way the service openings in a corridor wall are (see panels.js), because
    // nothing here is going to be looked at from the inside. In on one side and
    // out the other, and the exit is the bigger of the two.
    const hole = (r, z) => new THREE.CylinderGeometry(r, r, 0.005, 10)
      .rotateX(Math.PI / 2)
      .translate(0, 0.100 - CAN_H / 2, z);
    const torn = mergeGeometries([
      hole(0.011, -(CRUSH_R + 0.001)),
      hole(0.019, CRUSH_R + 0.001),
    ], false);

    return mergeGeometries([shell, label, metal, torn], true);
  })();

  return { whole, shot };
}

/**
 * A drink, in a hand or coming out of the machine it was standing in.
 *
 * Built the way `buildTray` and `buildCrate` are and for their two reasons:
 * geometry and materials are module-level and shared, so the fortieth can of a
 * floor costs one Mesh rather than a mesh build; and it lives here rather than
 * in enemies.js because this file is the one that knows what a body is made of.
 *
 * WHICH DRINK IT IS is `drinkFrom`'s answer and not this file's — see drinks.js
 * for why it is hashed off the seed rather than rolled, and why the same seed
 * has to come back with the same can in a hand, in a machine's window, and on
 * the carpet in front of a machine that has just been blown apart.
 */
export function buildCan(seed = 0, intact = false) {
  canParts ??= {
    geo: canShapes(),
    paint: CAN_FLAVOURS.map((f) => new THREE.MeshStandardMaterial({
      color: f.color, roughness: 0.34, metalness: 0.5,
    })),
    label: new Map(),
    // The rim and the lid, brighter and much shinier than the paint — the one
    // highlight on the can, and what catches the ceiling panels as the arm
    // swings.
    metal: new THREE.MeshStandardMaterial({
      color: 0xd8dde1, roughness: 0.3, metalness: 0.75,
    }),
    // What you can see through the hole, which is the inside of a can somebody
    // has already drunk. Unlit would be wrong here — a hole is dark because no
    // light gets into it, and a MeshBasic one would go on being exactly as dark
    // in a blacked-out corridor as under the ceiling panels.
    hole: new THREE.MeshStandardMaterial({ color: 0x14100c, roughness: 1 }),
  };

  const parts = canParts;
  const drink = drinkFrom(seed);
  const flavour = drink.flavour;
  // Whether THIS can has the hole in it, which is not the same question as
  // whether the drink's seed says one in twenty does.
  //
  // `drinkFrom` describes a can of STOCK, and a shot one is a joke about the
  // building: rounds go down the corridor the machine is standing in and the
  // stock is behind a glass front, so one facing in twenty is folded over on a
  // hole and the cans thrown out of a machine that has been blown apart are
  // those same facings (see `_spillStock` in destruction.js). None of that is
  // true of a can somebody just BOUGHT. A player reported being handed one, and
  // they were right: the flap is not where the rounds go, and a machine that
  // charges you for a punctured can is a machine with a different joke in it.
  //
  // So the caller says. `intact` is asked for in exactly one place — `HELD.can`
  // in held.js, the only path a can takes into a hand — and the flavour is
  // untouched either way, so the can you are handed is still the one the window
  // said it would be.
  const shot = drink.shot && !intact;

  let label = parts.label.get(flavour);
  if (!label) {
    label = new THREE.MeshStandardMaterial({
      map: canLabel(flavour), roughness: 0.5, metalness: 0.1,
    });
    parts.label.set(flavour, label);
  }

  const mats = [parts.paint[flavour], label, parts.metal];
  if (shot) mats.push(parts.hole);
  const can = new THREE.Mesh(shot ? parts.geo.shot : parts.geo.whole, mats);
  can.castShadow = true;
  return can;
}

let paperParts = null;

/**
 * The sheaf of paper a routine carries from the printer to the filing rack.
 *
 * Built the way `buildTray`, `buildCrate` and `buildCan` are and for their two
 * reasons: shared module-level geometry, so the fiftieth bundle of a floor costs
 * a Group and three Meshes; and it lives here because this is the file that knows
 * what a body is made of.
 *
 * Four sheets rather than one slab, splayed a couple of degrees apart. That is
 * the whole of what makes it read as PAPER at the range you ever see one — a
 * single white box in somebody's hand is a box, and the edges catching the light
 * at slightly different angles are what say the thing is made of sheets. The
 * wrap is what "packaged" means: a band across the middle, which is also the
 * only part of it that is not white and so the only part that reads against a
 * white shirt.
 */
export function buildPapers() {
  paperParts ??= {
    geo: {
      // A4 is 0.21 x 0.297. Held in one hand, so it is carried on its long edge.
      sheet: new THREE.BoxGeometry(0.21, 0.004, 0.297),
      band: new THREE.BoxGeometry(0.045, 0.019, 0.30),
    },
    mat: {
      paper: new THREE.MeshStandardMaterial({ color: 0xf2f3f0, roughness: 0.92 }),
      band: new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 }),
    },
  };

  const { geo, mat } = paperParts;
  const group = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const sheet = new THREE.Mesh(geo.sheet, mat.paper);
    sheet.position.y = i * 0.0045;
    sheet.rotation.y = (i - 1.5) * 0.03;
    sheet.castShadow = true;
    group.add(sheet);
  }
  const band = new THREE.Mesh(geo.band, mat.band);
  band.position.y = 0.008;
  band.castShadow = true;
  group.add(band);
  return group;
}

let crateParts = null;
let boxParts = null;

// TWO things end up in somebody's hands under one name, and which one it is is
// DERIVED rather than sent (see `HELD.crate` in held.js): a body wheeling a sack
// truck gets the big timber crate, and a body carrying it in its arms gets an
// ordinary cardboard box. That is the same fact the table already used to decide
// what the thing is PARENTED to, asked once more — so it costs no second wire
// bit and cannot disagree between two browsers, because whether a type brought a
// truck comes off the shared seed.
//
// It is also the honest reading of the errands. What the contractor does is take
// a crate OFF A RACK and wheel it out of the building, and the crates on those
// racks are timber (`crate` in gen/props.js); what everybody else does is carry
// a parcel across a floor in both arms, and the boxes lying about that floor are
// cardboard (`carton`, same file). A man walking a corridor cradling a timber
// packing case reads as a man struggling with the wrong object.

// The timber crate: the one that rides the truck. Three times the volume of the
// box below, and the size IS the point of the split — what says "this is being
// shipped out of the building" rather than "this is being carried to a desk" is
// how big it is against the man pushing it.
//
// The depth is picked against the truck rather than freely: the toe plate
// projects `TRUCK_PLATE` (0.30) and this is 0.34, so the crate stands a few
// centimetres proud of the toe and reads as loaded rather than as parked. The
// width is a shade over the plate's own for the same reason. The height is the
// one free number, and 0.44 is what covers the frame's lower brace while leaving
// the upper one and the handles showing — a truck whose frame has disappeared
// behind its load is not a truck, it is a box floating down the corridor.
const CRATE_W = 0.54;
const CRATE_H = 0.44;
const CRATE_D = 0.34;
const BATTEN = 0.03;           // a board's thickness, on the frame and the posts
const CRATE_LID = 0.5;         // ...how many carry a small carton on top

// ...and the cardboard box, carried in both arms. These three numbers are what
// every carry pose in the game is tuned against — `boxAt` per rig, and the
// animator's own fallback — so they are exactly what a carried box has measured
// since there was one, and moving them moves every pair of arms on the floor.
const BOX_W = 0.34;
const BOX_H = 0.26;
const BOX_D = 0.30;

/**
 * A stable 0..1 off an integer key, and it is a function for the reason
 * `drinkFrom` in drinks.js has a long note about: two answers taken off ONE hash
 * are not independent, and taking them with `%` off an unmixed product is how
 * 80% of every can in the building came out the same flavour. `salt` is mixed IN
 * rather than the caller slicing its own bits out of a shared product, and
 * `Math.imul` is what stops the low bits — the entire output of a multiplicative
 * hash — being rounded away past a double's 53.
 */
function hash01(key, salt) {
  const h = Math.imul((key >>> 0) ^ Math.imul(salt >>> 0, 0x85ebca6b), 2654435761);
  return ((h >>> 8) & 0xffff) / 0x10000;
}

/**
 * The timber crate a contractor wheels out of the building.
 *
 * Built exactly the way `buildTray` is and for the same two reasons. Geometry
 * and materials are module-level and shared, so the twentieth crate of a run
 * costs one Mesh rather than a mesh build, and there is nothing to dispose when
 * one is put down — dropping the mesh is the whole of it. And it is authored
 * around its own origin, so the truck can parent it straight to its toe plate
 * and never position it (see `truckOf`).
 *
 * WHAT MAKES IT READ AS PLANKS is the framing and not the paint, which is the
 * argument the sack truck's own note makes about its rungs: at three metres a
 * crate is a silhouette, and the silhouette of bare timber is a brown block. So
 * it is boarded the way a packing case is — four corner posts, a rail top,
 * middle and bottom down every face, and a brace across the two wide ones. The
 * diagonal is the single most recognisable thing on a crate and costs two boxes.
 */
export function buildCrate(key = 0) {
  crateParts ??= {
    geo: {
      body: new THREE.BoxGeometry(CRATE_W, CRATE_H, CRATE_D),
      post: new THREE.BoxGeometry(BATTEN, CRATE_H + 0.004, BATTEN),
      railX: new THREE.BoxGeometry(CRATE_W + 0.006, BATTEN, BATTEN),
      railZ: new THREE.BoxGeometry(BATTEN, BATTEN, CRATE_D + 0.006),
      diag: new THREE.BoxGeometry(Math.hypot(CRATE_W, CRATE_H) * 0.94, BATTEN, BATTEN),
      // ...and the small carton that rides on top of some of them.
      lid: new THREE.BoxGeometry(0.19, 0.13, 0.16),
      tape: new THREE.BoxGeometry(0.045, 0.005, 0.162),
    },
    mat: {
      // Pine boards, and the frame a shade darker so the two read apart in a
      // corridor rather than merging into one brown lump.
      wood: new THREE.MeshStandardMaterial({ color: 0xb08a54, roughness: 0.95 }),
      frame: new THREE.MeshStandardMaterial({ color: 0x8a6636, roughness: 0.95 }),
      card: new THREE.MeshStandardMaterial({ color: 0xa98b62, roughness: 0.92 }),
      tape: new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.8 }),
    },
  };

  const { geo, mat } = crateParts;
  const group = new THREE.Group();
  const put = (g, m, x, y, z, rotZ = 0) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    if (rotZ) mesh.rotation.z = rotZ;
    mesh.castShadow = true;
    group.add(mesh);
  };

  put(geo.body, mat.wood, 0, 0, 0);
  const hw = CRATE_W / 2, hd = CRATE_D / 2, hh = CRATE_H / 2;
  const bands = [hh - BATTEN / 2, 0, -hh + BATTEN / 2];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) put(geo.post, mat.frame, sx * hw, 0, sz * hd);
    for (const y of bands) put(geo.railZ, mat.frame, sx * hw, y, 0);
  }
  for (const sz of [-1, 1]) {
    for (const y of bands) put(geo.railX, mat.frame, 0, y, sz * hd);
    // The brace, corner to corner across the wide face. Mirrored on the far side
    // so the two never read as one board seen through the crate.
    put(geo.diag, mat.frame, 0, 0, sz * hd, sz * Math.atan2(CRATE_H, CRATE_W));
  }

  // A small box on top of it, about half the time. HASHED off the key rather
  // than rolled, for the drink's reason: the errand that hands a crate over is
  // host-only and the joiner builds its own from one bit on the wire, so a die
  // here would put a carton on one screen and not the other. Both ends hash the
  // body's own index and agree without a byte crossing.
  if (hash01(key, 1) < CRATE_LID) {
    put(geo.lid, mat.card, 0.02, hh + 0.065, -0.01);
    put(geo.tape, mat.tape, 0.02, hh + 0.131, -0.01);
  }
  return group;
}

/**
 * ...and the ordinary cardboard box, carried in both arms — a parcel run's
 * parcel, a stocktake's box, the post going out of the building.
 *
 * It is the `carton` prop in gen/props.js at carrying size and drawn the same
 * way, down to the taped seam across the top and the shipping label on one face,
 * because a box being carried across a floor and a box lying on that floor's
 * carpet are the same object as far as the player is concerned. What would give
 * this one away is being a colour or a shape the building does not otherwise
 * contain — so the brown is `cardboard`'s own out of textures.js rather than one
 * matched by eye.
 *
 * The seam and the label earn their triangles for the crate's reason one size
 * down: an unbroken brown box at three metres reads as a brown block, and one
 * pale line across the lid reads as a box.
 */
export function buildBox(key = 0) {
  boxParts ??= {
    geo: {
      body: new THREE.BoxGeometry(BOX_W, BOX_H, BOX_D),
      seam: new THREE.BoxGeometry(0.052, 0.006, BOX_D + 0.004),
      label: new THREE.BoxGeometry(0.135, 0.09, 0.005),
    },
    mat: {
      card: new THREE.MeshStandardMaterial({ color: 0xa98b62, roughness: 0.94 }),
      paper: new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.88 }),
    },
  };

  const { geo, mat } = boxParts;
  const group = new THREE.Group();
  const put = (g, m, x, y, z) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  };

  put(geo.body, mat.card, 0, 0, 0);
  put(geo.seam, mat.paper, 0, BOX_H / 2 + 0.002, 0);
  // Seven in ten, which is the chance the prop this is drawn from already uses.
  if (hash01(key, 2) < 0.7) put(geo.label, mat.paper, 0.01, 0.01, -BOX_D / 2 - 0.001);
  return group;
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
