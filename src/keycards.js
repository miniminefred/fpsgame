import * as THREE from 'three';
import { getFx } from './fx-textures.js';
import { hexCss } from './util.js';

// Keycards: what the staff are carrying, and what it opens.
//
// The floor generator decides which rooms are badged and proves that none of
// them is ever on the route (see assignLocks in gen/layout.js). This file is the
// other half: the card catalogue, the wallet, and the cards lying on the carpet
// where somebody dropped them.
//
// Cards are per floor. You arrive on a new floor with nothing, because a
// building where the card you found on the eighth floor opens the ninth has no
// locked doors on it after the first one.
//
// Two of the five are single-purpose keys and three are a ladder. A ladder is
// what makes finding a grey card feel like something rather than like finding
// another white one — it does not replace the white card, it eats it. Black sits
// at the top and opens the building, which it can afford to do because of when
// it arrives: it comes off the last hostile on the floor, so by the time you
// hold it there is nobody left to use it against.
//
// White is the odd one and the reason the ladder matters: it is on every door on
// the floor and in every employee's pocket, so it is less a lock than the
// opening minute of a floor. What that costs and what pays for it is all in
// assignLocks; nothing in here needs to know.

export const CARDS = {
  white: {
    name: 'White', color: 0xf0f2f5, edge: 0x8b9199,
    // Everything below this rank on the ladder opens too.
    rank: 1,
  },
  grey: {
    name: 'Grey', color: 0x9aa3ad, edge: 0x4b5157,
    rank: 2,
  },
  black: {
    name: 'Black', color: 0x24272c, edge: 0xb99b4e,
    rank: 3,
  },
  // Off the ladder entirely: one door each, and no amount of seniority below
  // executive substitutes for them.
  blue: {
    name: 'Blue', color: 0x3fa0ff, edge: 0x1b4f80,
    rank: 0,
  },
  yellow: {
    name: 'Yellow', color: 0xffc93a, edge: 0x8a6a12,
    rank: 0,
  },
};

export const CARD_TIERS = Object.keys(CARDS);

// The lamp on a badge reader. Here rather than in the two files that use it —
// gen/build.js builds the reader, doors.js turns it green — because a reader
// that says "open" in one colour and is built in another is the kind of bug you
// only notice from inside the game.
export const READER_LIT = 0xff3b30;
export const READER_OPEN = 0x3ddc6b;

// The order the HUD lists them in — the ladder first, low to high, then the two
// one-door keys. Not Object.keys order, so the strip reads as a rank.
export const HUD_ORDER = ['white', 'grey', 'black', 'blue', 'yellow'];

/**
 * Does a card open a lock?
 *
 * The ladder is a rank comparison; the two single-purpose cards are an equality
 * test. Black is the exception written out longhand: it is the only card that
 * satisfies a lock it is not, off the ladder included.
 */
export function cardOpens(tier, lock) {
  if (!lock) return true;
  if (tier === lock) return true;
  if (tier === 'black') return true;
  const held = CARDS[tier], want = CARDS[lock];
  if (!held || !want) return false;
  return want.rank > 0 && held.rank >= want.rank;
}

/** Everything the player is carrying on this floor. */
export class Wallet {
  constructor() {
    this.held = new Set();
    this.onChange = null;
  }

  // `onChange(wallet, tier)` — tier is the card just taken, or null when the
  // wallet was emptied for a new floor. The distinction matters: taking a card
  // opens doors, and arriving on a floor must not.
  clear() {
    if (this.held.size) {
      this.held.clear();
      this.onChange?.(this, null);
    }
  }

  has(tier) { return this.held.has(tier); }

  add(tier) {
    if (!CARDS[tier] || this.held.has(tier)) return false;
    this.held.add(tier);
    this.onChange?.(this, tier);
    return true;
  }

  /** The card in hand that opens this lock, or null. */
  keyFor(lock) {
    if (!lock) return null;
    for (const tier of this.held) if (cardOpens(tier, lock)) return tier;
    return null;
  }

  opens(lock) { return !lock || this.keyFor(lock) !== null; }

  /** What the HUD draws: rank order, with the colour already in CSS form. */
  list() {
    return HUD_ORDER.filter((t) => this.held.has(t)).map((tier) => ({
      tier,
      name: CARDS[tier].name,
      css: hexCss(CARDS[tier].color),
    }));
  }
}

// --- cards on the floor -----------------------------------------------------

// A real keycard is 86 x 54 mm, and at that size, on grey carpet, in an office
// with half its lights out, it is not so much hard to see as invisible. So this
// one is twice life size and hanging in the air with a light behind it. Nothing
// about that is realistic and all of it is legibility: the one thing a pickup
// may not be is missable.
const CARD_W = 0.17;
const CARD_H = 0.108;
const CARD_T = 0.008;
const REST_Y = 0.62;           // metres it floats at
const BOB = 0.06;
const SPIN = 1.6;              // radians a second
const HALO = 0.62;             // metres across, and always facing you
const PICKUP_R = 1.15;         // metres — forgiving, you are running past it
const PICKUP_Y = 2.0;          // ...but not through the ceiling of the floor below

export class Keycards {
  constructor({ scene, audio, wallet }) {
    this.scene = scene;
    this.audio = audio;
    this.wallet = wallet;
    this.items = [];

    this.geo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_T);
    this.mats = new Map();     // tier -> { card, glow }
    this._t = 0;
  }

  _materials(tier) {
    let m = this.mats.get(tier);
    if (m) return m;
    const spec = CARDS[tier] ?? CARDS.white;
    m = {
      card: new THREE.MeshStandardMaterial({
        color: spec.color,
        emissive: spec.color,
        // The black card would otherwise be a hole in a dark room. It is lit by
        // its own trim rather than its face, which is also how it reads as the
        // expensive one.
        emissiveIntensity: tier === 'black' ? 0.55 : 0.35,
        roughness: 0.45,
        metalness: 0.1,
      }),
      // The halo behind the card. Additive, so it brightens whatever it is in
      // front of instead of painting a pale square on it — a flat disc on a dark
      // floor reads as a rug, which is the opposite of what a pickup wants. The
      // black card gets a warmer, stronger one: its own colour glows at nothing.
      glow: new THREE.SpriteMaterial({
        map: getFx().glow,
        color: tier === 'black' ? spec.edge : spec.color,
        transparent: true,
        opacity: tier === 'black' ? 0.75 : 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    };
    this.mats.set(tier, m);
    return m;
  }

  /** Is one of these already lying about, waiting to be walked over? */
  pending(tier) {
    for (const item of this.items) if (item.tier === tier) return true;
    return false;
  }

  /** Somebody dropped one. `y` is the floor under them, not their chest. */
  drop(tier, x, y, z) {
    if (!CARDS[tier]) return null;
    const { card, glow } = this._materials(tier);

    const group = new THREE.Group();
    group.position.set(x, y, z);

    // The halo goes in FIRST and the card on top of it, so the card is always
    // read against its own light rather than lost in it.
    const halo = new THREE.Sprite(glow);
    halo.scale.set(HALO, HALO, 1);
    halo.position.y = REST_Y;
    group.add(halo);

    const mesh = new THREE.Mesh(this.geo, card);
    mesh.position.y = REST_Y;
    mesh.rotation.z = 0.35;
    group.add(mesh);

    this.scene.add(group);
    const item = { tier, group, mesh, halo, x, y, z, phase: Math.random() * 6.283 };
    this.items.push(item);
    return item;
  }

  update(dt, player) {
    if (!this.items.length) return;
    this._t += dt;

    const px = player.object.position.x;
    const py = player.object.position.y;
    const pz = player.object.position.z;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.mesh.rotation.y += SPIN * dt;
      const y = REST_Y + Math.sin(this._t * 2.1 + item.phase) * BOB;
      item.mesh.position.y = y;
      item.halo.position.y = y;

      if (Math.abs(py - item.y) > PICKUP_Y) continue;
      if (Math.hypot(px - item.x, pz - item.z) > PICKUP_R) continue;

      this._collect(item);
      this.items.splice(i, 1);
    }
  }

  // What a new card MEANS — which doors just opened — is said by game.js off the
  // wallet's own change, because it is a fact about the floor and not about the
  // pickup. All this owes is the noise and getting the thing off the carpet.
  _collect(item) {
    this.scene.remove(item.group);
    this.audio?.keycardPickup(item.group.position);
    this.wallet.add(item.tier);
  }

  /** Everything on the floor goes with the floor. */
  clear() {
    for (const item of this.items) this.scene.remove(item.group);
    this.items.length = 0;
  }
}
