// What is actually in the drinks machines, and what comes out of them.
//
// A machine's window was stocked when the floor was generated (`canRack` in
// gen/props.js) and it stayed stocked for ever: a man bought a can, walked off
// with it, and the facing he bought was still standing behind the glass. The
// window is now the stock. Every can somebody buys — the staff on their
// `vending` chore, or the player with a coin (see coins.js) — comes out of a
// slot, and that slot is empty in the window until a restock puts it back.
//
// A slot is one facing and its label band (`slots` on the destructible, built in
// gen/sink.js). Buying one hides its spans (`hideSpan` in gen/geom.js) — the
// batched window cannot lose a mesh, so the can's vertices are collapsed and
// kept, and a restock copies them back. The slot's part is flagged `taken` as
// well, which is what keeps a machine shot apart with half its stock sold from
// throwing the half that is already in somebody's hand (`_spillStock`).
//
// Host-only in a co-op session, like every chore: which slot somebody bought is
// a runtime decision and nothing crosses the wire for it, so a joiner's windows
// are the stock the floor was generated with.

import { hideSpan, showSpan } from './gen/geom.js';

// A machine is LOW, and worth somebody's while to restock, once it is down to
// this share of the slots it was generated with. Not empty: a restock is a
// worker walking a crate across a floor, and waiting for the last can to go
// means the machine sits bare in the corridor for the whole of that walk.
const LOW_SHARE = 0.5;

// How close the player has to be to a machine to buy from it: this far from the
// cabinet's own footprint, on the floor plan.
const REACH = 1.3;

export class Vending {
  constructor() {
    this.machines = [];
    this.byCollider = new Map();
  }

  setLevel(level) {
    this.machines = [];
    this.byCollider.clear();
    for (const entry of level.destructibles ?? []) {
      if (!entry.slots?.length) continue;
      const m = { entry, slots: entry.slots, colliders: entry.colliders ?? [] };
      this.machines.push(m);
      for (const c of m.colliders) this.byCollider.set(c, m);
    }
  }

  /** The machine a station's prop is, or null for a station at anything else. */
  machineFor(collider) {
    return collider ? this.byCollider.get(collider) ?? null : null;
  }

  /** Cans still behind the glass. A machine that has been shot apart has none. */
  left(m) {
    if (!m || m.entry.broken) return 0;
    let n = 0;
    for (const s of m.slots) if (!s.taken) n++;
    return n;
  }

  low(m) {
    if (!m || m.entry.broken) return false;
    return this.left(m) <= Math.floor(m.slots.length * LOW_SHARE);
  }

  /**
   * One can out of the window, or null if there is nothing left to sell.
   *
   * A random slot rather than the next one along, because nobody empties a
   * machine left to right; the gaps come out scattered, which is what a machine
   * that has been used all shift looks like. Returns the drink's SEED, which is
   * what `buildCan` needs to hand over the can that was actually standing there.
   */
  take(m) {
    if (!m || m.entry.broken) return null;
    const full = m.slots.filter((s) => !s.taken);
    if (!full.length) return null;
    const slot = full[(Math.random() * full.length) | 0];
    slot.taken = true;
    slot.part.taken = true;
    for (const span of slot.spans) hideSpan(span);
    return slot.seed;
  }

  /** Every empty slot back. The same drink goes back where it was. */
  restock(m) {
    if (!m || m.entry.broken) return 0;
    let n = 0;
    for (const slot of m.slots) {
      if (!slot.taken) continue;
      slot.taken = false;
      slot.part.taken = false;
      for (const span of slot.spans) showSpan(span);
      n++;
    }
    return n;
  }

  /** Whether any machine on the floor wants restocking — asked before a restock is cast. */
  anyLow() {
    return this.machines.some((m) => this.low(m));
  }

  /**
   * The machine the player is standing at, if any: within REACH of its
   * footprint and roughly in front of the eye. Unbroken machines only.
   */
  near(x, z, fx, fz) {
    let best = null;
    let bestD = REACH;
    for (const m of this.machines) {
      if (m.entry.broken) continue;
      for (const c of m.colliders) {
        const dx = Math.max(c.minX - x, 0, x - c.maxX);
        const dz = Math.max(c.minZ - z, 0, z - c.maxZ);
        const d = Math.hypot(dx, dz);
        if (d >= bestD) continue;
        // Facing it, near enough: a machine behind you is not the one you are
        // pressing the button on.
        const cx = (c.minX + c.maxX) / 2 - x, cz = (c.minZ + c.maxZ) / 2 - z;
        const len = Math.hypot(cx, cz) || 1;
        if ((cx * fx + cz * fz) / len < 0.35) continue;
        best = m;
        bestD = d;
      }
    }
    return best;
  }
}
