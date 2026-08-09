import * as THREE from 'three';

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

export const CARDS = {
  white: {
    name: 'White', color: 0xf0f2f5, edge: 0x8b9199,
    // Everything below this rank on the ladder opens too.
    rank: 1, blurb: 'Staff',
  },
  grey: {
    name: 'Grey', color: 0x9aa3ad, edge: 0x4b5157,
    rank: 2, blurb: 'Restricted',
  },
  black: {
    name: 'Black', color: 0x24272c, edge: 0xb99b4e,
    rank: 3, blurb: 'Executive',
  },
  // Off the ladder entirely: one door each, and no amount of seniority below
  // executive substitutes for them.
  blue: {
    name: 'Blue', color: 0x3fa0ff, edge: 0x1b4f80,
    rank: 0, blurb: 'Security',
  },
  yellow: {
    name: 'Yellow', color: 0xffc93a, edge: 0x8a6a12,
    rank: 0, blurb: 'Facilities',
  },
};

export const CARD_TIERS = Object.keys(CARDS);

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

  clear() {
    if (this.held.size) {
      this.held.clear();
      this.onChange?.(this);
    }
  }

  has(tier) { return this.held.has(tier); }

  add(tier) {
    if (!CARDS[tier] || this.held.has(tier)) return false;
    this.held.add(tier);
    this.onChange?.(this);
    return true;
  }

  /** The card in hand that opens this lock, or null. */
  keyFor(lock) {
    if (!lock) return null;
    for (const tier of this.held) if (cardOpens(tier, lock)) return tier;
    return null;
  }

  opens(lock) { return !lock || this.keyFor(lock) !== null; }

  list() { return HUD_ORDER.filter((t) => this.held.has(t)); }
}

// --- cards on the floor -----------------------------------------------------

const CARD_W = 0.11;           // a card is 86 x 54 mm; this is generous, on
const CARD_H = 0.07;           // purpose — a real one is invisible on carpet
const CARD_T = 0.006;
const REST_Y = 0.55;           // metres it floats at
const BOB = 0.055;
const SPIN = 1.6;              // radians a second
const PICKUP_R = 1.15;         // metres — forgiving, you are running past it
const PICKUP_Y = 2.0;          // ...but not through the ceiling of the floor below

// Cards read as a pickup rather than as litter because they float and turn, and
// because of the glow under them: a card lying flat on grey carpet in a dark
// office is genuinely impossible to see, and the one thing a pickup may not be
// is missable.
export class Keycards {
  constructor({ scene, audio, hud, wallet }) {
    this.scene = scene;
    this.audio = audio;
    this.hud = hud;
    this.wallet = wallet;
    this.items = [];

    this.geo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_T);
    this.glowGeo = new THREE.PlaneGeometry(0.46, 0.46);
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
      glow: new THREE.MeshBasicMaterial({
        color: spec.color,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    };
    this.mats.set(tier, m);
    return m;
  }

  /** Somebody dropped one. `y` is the floor under them, not their chest. */
  drop(tier, x, y, z) {
    if (!CARDS[tier]) return null;
    const { card, glow } = this._materials(tier);

    const group = new THREE.Group();
    group.position.set(x, y, z);

    const mesh = new THREE.Mesh(this.geo, card);
    mesh.position.y = REST_Y;
    mesh.rotation.z = 0.35;
    group.add(mesh);

    // A pool of light on the carpet, flat and unlit, so the card announces
    // itself from across a room without needing a light near it.
    const pool = new THREE.Mesh(this.glowGeo, glow);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.02;
    group.add(pool);

    this.scene.add(group);
    const item = { tier, group, mesh, x, y, z, phase: Math.random() * 6.283 };
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
      item.mesh.position.y = REST_Y + Math.sin(this._t * 2.1 + item.phase) * BOB;

      if (Math.abs(py - item.y) > PICKUP_Y) continue;
      if (Math.hypot(px - item.x, pz - item.z) > PICKUP_R) continue;

      this._collect(item);
      this.items.splice(i, 1);
    }
  }

  _collect(item) {
    const spec = CARDS[item.tier];
    const isNew = this.wallet.add(item.tier);
    this.scene.remove(item.group);

    this.audio?.keycardPickup(item.group.position);
    this.hud?.message(isNew
      ? `${spec.name.toUpperCase()} KEYCARD — ${spec.blurb.toUpperCase()}`
      : `${spec.name.toUpperCase()} KEYCARD (SPARE)`, 1500);
  }

  /** Everything on the floor goes with the floor. */
  clear() {
    for (const item of this.items) this.scene.remove(item.group);
    this.items.length = 0;
  }
}
