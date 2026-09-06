// The furnishing sink: the one object every prop in the building is placed
// through.
//
// gen/rooms.js decides WHICH props a room gets and where they stand; gen/props.js
// draws them. This is the seam between the two — it collects boxes into the
// batcher, reserves floor, blocks nav tiles, records colliders and destructibles,
// and hands loose props to the physics world. A prop only ever sees this
// interface, which is what lets a storeroom, an attic and a mezzanine be
// furnished by the same catalogue without one line of it knowing there is a
// difference.

import * as THREE from 'three';
import { boxBetween } from './geom.js';
import { modelInfo, paintDebris, stampModel } from './models.js';
import { isOpen, TILE } from './layout.js';

/**
 * Everything a prop needs to put itself into the world.
 *
 * `masks.level` is the floor this sink furnishes, and it is 0 for the building. A
 * sink at a level draws every box, model and collider that much higher, gives its
 * colliders an underside, and stays out of the nav grid — which is the whole of
 * what "furnish the storey upstairs" means. Doing it here rather than in a wrapper
 * is deliberate: `tryPlace` and all 30 props in the catalogue then furnish a second
 * storey without one line of them knowing there is one.
 */
export function makeSink(layout, batcher, materials, masks) {
  const { W, H, tiles } = layout;
  const { blocked, occupied, reserved, colliders, dynamics, destructibles } = masks;
  const level = masks.level ?? 0;

  // While a dynamic prop is being authored, its boxes are collected here
  // instead of going into the static batch — they need to stay a separate
  // mesh so physics can move them.
  let pending = null;
  // A static prop being authored: everything it draws, blocks and collides
  // with, gathered so all of it can be taken away in one go when it's shot.
  let record = null;
  // A dry run of a prop's `build`, collecting the boxes without drawing them.
  let capture = null;
  // What grade of hulk the boxes being drawn right now are, if any: `true` for
  // welded structure, `'trim'` for a fitting bolted to it. Both stay standing
  // when the prop is destroyed; only the first says how big the machine is.
  // See `hulk` below.
  let hulkOn = false;
  // What the boxes being drawn right now are STOCK for, or null: the drink seed
  // for the can itself, or 'trim' for something drawn ON that can. A stock box is
  // not one of the prop's fragments — it is a thing the prop is holding, and it
  // leaves as itself rather than as a piece of the cabinet it was standing in.
  // See `stock` below and `_spillStock` in destruction.js.
  let stockOn = null;

  // Tile range covering a world-space AABB.
  const range = (x0, z0, x1, z1) => ({
    tx0: Math.max(0, Math.floor((x0 - layout.ox) / TILE)),
    tx1: Math.min(W - 1, Math.ceil((x1 - layout.ox) / TILE) - 1),
    ty0: Math.max(0, Math.floor((z0 - layout.oz) / TILE)),
    ty1: Math.min(H - 1, Math.ceil((z1 - layout.oz) / TILE) - 1),
  });

  // Reserving floor rounds OUTWARD — being generous is what stops two props
  // overlapping.
  const stamp = (mask, x0, z0, x1, z1) => {
    const r = range(x0, z0, x1, z1);
    for (let ty = r.ty0; ty <= r.ty1; ty++) {
      for (let tx = r.tx0; tx <= r.tx1; tx++) mask[ty * W + tx] = 1;
    }
  };

  // Blocking navigation rounds to tile CENTRES instead. Rounding outward here
  // inflates every prop to whole half-metre tiles — a 0.66 m cabinet would
  // block a full metre — which walls off gaps a body can plainly walk through
  // and leaves the enemies with a floorplan the player doesn't share.
  const stampCentres = (mask, x0, z0, x1, z1, into) => {
    const tx0 = Math.max(0, Math.ceil((x0 - layout.ox) / TILE - 0.5));
    const tx1 = Math.min(W - 1, Math.floor((x1 - layout.ox) / TILE - 0.5));
    const ty0 = Math.max(0, Math.ceil((z0 - layout.oz) / TILE - 0.5));
    const ty1 = Math.min(H - 1, Math.floor((z1 - layout.oz) / TILE - 0.5));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        mask[ty * W + tx] = 1;
        into?.push(ty * W + tx);
      }
    }
  };

  return {
    canPlace(x0, z0, x1, z1) {
      const r = range(x0, z0, x1, z1);
      if (r.tx1 < r.tx0 || r.ty1 < r.ty0) return false;
      for (let ty = r.ty0; ty <= r.ty1; ty++) {
        for (let tx = r.tx0; tx <= r.tx1; tx++) {
          const i = ty * W + tx;
          if (!isOpen(tiles[i]) || occupied[i] || reserved[i]) return false;
        }
      }
      return true;
    },

    occupy(x0, z0, x1, z1) { stamp(occupied, x0, z0, x1, z1); },

    /**
     * Runs `fn` with one prop's reserved floor lent back to it, and takes it
     * again afterwards. For a chair pulled up to a desk, which is the only kind
     * of prop that is SUPPOSED to stand inside another one's reservation.
     *
     * Reserving floor rounds outward to whole tiles (see `stamp`), which is what
     * stops two props overlapping and is not worth loosening. But a desk is
     * 0.97 m deep, so its reservation reaches up to half a metre past its own
     * front face — and a chair pulled up to that face therefore lands inside it
     * however carefully it is placed in metres. Measured on one floor: 16 desks
     * backed against walls, 16 chairs refused, every private office on the floor
     * furnished with a desk nobody could be sitting at.
     *
     * Everything else still applies while the tiles are lent: a wall is still a
     * wall, a doorway apron is still reserved, and the cabinet beside the desk
     * still has its own floor. It is one prop's claim that is waived, for the one
     * prop that belongs to it.
     */
    lend(x0, z0, x1, z1, fn) {
      const r = range(x0, z0, x1, z1);
      const held = [];
      for (let ty = r.ty0; ty <= r.ty1; ty++) {
        for (let tx = r.tx0; tx <= r.tx1; tx++) {
          const i = ty * W + tx;
          if (occupied[i]) { held.push(i); occupied[i] = 0; }
        }
      }
      try { return fn(); } finally { for (const i of held) occupied[i] = 1; }
    },

    /**
     * A place somebody works: where the chair is, and which way round they are
     * sitting in it. `rot` is the chair's own quarter turn, so the body faces
     * the desk for exactly the reason the chair does.
     *
     * The furnisher is the only thing on the floor that knows a desk has a
     * monitor on it and a chair pulled up to it, so it is the only thing that
     * can say where a working body goes — enemies.js would otherwise be
     * guessing at furniture from the nav grid. Nothing here reserves anything:
     * a workstation is an offer, taken up by whoever is staffing the room (see
     * `_takeDesk` in enemies.js) and ignored if nobody is.
     *
     * A sink furnishing a storey does not collect them. The nav grid on a level
     * is not the ground floor's, the desks on the generator's mezzanine are off
     * it entirely, and a body seated somewhere nothing can walk to is a body
     * that stands up into a wall.
     */
    workstation(x, z, rot, at = 'desk') {
      if (level) return;
      // `at` is what the chair is pulled up to, and the two are not
      // interchangeable: a desk is a JOB — it decides how big a shift a room is
      // dealt and it seats a body typing (see _spawnPoints and deskPool in
      // enemies.js) — while a canteen table is somewhere to eat lunch. Pooled
      // apart at the other end, so a cafeteria full of seats can never be read
      // as a room with twenty jobs going in it.
      masks.workstations.push({ x, z, rot, at, room: null });
    },

    box(key, x0, y0, z0, x1, y1, z1) {
      const b = { key, x0, y0: y0 + level, z0, x1, y1: y1 + level, z1 };
      if (hulkOn) b.hulk = hulkOn;
      // Tested against null rather than for truth, because seed 0 is a drink
      // like any other and `if (stockOn)` would quietly hand every twenty-
      // thousandth can back to the fragment pile.
      if (stockOn != null) b.stock = stockOn;
      if (capture) { capture.push(b); return; }
      if (pending) { pending.boxes.push(b); return; }
      batcher.add(key, materials[key], boxBetween(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1));
      // One add() and one box, on the same call and in the same order — which
      // is what lets endStatic hand destruction.js a mask over `spans`.
      record?.boxes.push(b);
    },

    /**
     * Marks what follows as part of the HULK: the geometry that is still
     * standing, burnt, after the prop is destroyed. Only the generator uses it
     * (see `weld` in gen/props.js); leave it off and a prop is destroyed
     * exactly as it always was, geometry and all.
     *
     * `true` is welded structure — the machine's own mass, whose extent is what
     * `_wreck` sites its blasts against. `'trim'` is a fitting bolted to that:
     * it survives and is carved identically, but it must not be allowed to
     * stretch the machine's measured corners out to the tip of an exhaust
     * stack. Anything falsy ends the run.
     */
    hulk(grade) { hulkOn = grade || false; },

    /**
     * Marks what follows as STOCK: something the prop is holding rather than
     * something it is made of. Pass null to end the run.
     *
     * The prop still draws it, and it is still erased with the rest of the
     * prop's spans when the prop goes — what changes is what happens next.
     * `_shatter` takes stock off the fragment list and throws the real thing
     * from where the facing was standing, so the drink that was in the window
     * is the drink now rolling across the carpet. Left unmarked, a machine's
     * stock would be thrown twice: once as a coloured box out of the debris
     * budget, and once as the can it actually is.
     *
     * A NUMBER is the drink itself, and it is the seed that says which drink
     * (see drinks.js). 'trim' is something drawn on that can — its label
     * band — which is neither a drink of its own nor a fragment of the machine,
     * so it is thrown by neither pass and goes with the prop. Exactly the
     * distinction `hulk` draws one method up between a machine's own mass and a
     * fitting bolted to it.
     *
     * Same trap as `hulk` too: the placer in gen/props.js has to forward this or
     * a prop marking its stock reaches nothing at all, silently.
     */
    stock(grade) { stockOn = grade == null ? null : grade; },

    obstacle(x0, z0, x1, z1, top, building) {
      // A dynamic prop's footprint moves, so it can't become a static collider
      // or a permanent hole in the nav grid. A dry run isn't there at all.
      if (pending || capture) return;
      const collider = { minX: x0, maxX: x1, minZ: z0, maxZ: z1, top: top + level };
      // Its underside, on a sink that is furnishing a storey rather than the
      // ground. Without it the collider is a pillar from the floor and a crate
      // upstairs is a pillar through the room below — see gen/stairs.js.
      if (level) collider.base = level;
      // Shell, not furniture — exempts a genuinely oversized prop (the
      // generator) from validate-props.mjs's MAX_PROP_SIDE/MAX_PROP_TOP
      // furniture caps, the same way a wall or a staircase already is.
      if (building) collider.building = true;
      colliders.push(collider);
      record?.colliders.push(collider);
      // Anything the player can't step over blocks the enemies too. The
      // threshold has to match the player's step tolerance (STEP_EPS in
      // player.js): a sofa at 0.44 m and a plant pot at 0.34 m are both solid
      // to walk into, so leaving them out of the nav grid gave the enemies
      // routes straight through the furniture.
      //
      // None of which applies to a prop that is not on the floor. The nav grid is
      // one grid per floor and it describes the ground: stamping this one would
      // have a crate upstairs make the office below impassable, and handing its
      // tiles back when it is shot would open a tile a desk down there is
      // standing on. So a storey's props are simply not in it — which is the same
      // decision as the stairwell's, for the same reason.
      if (!level && top > 0.3) stampCentres(blocked, x0, z0, x1, z1, record?.navTiles);
    },

    // --- downloaded models -------------------------------------------------
    modelInfo,

    // Batched by source material, so a floor of desks is a couple of draw calls.
    model(key, x, y, z, yaw) {
      return stampModel(key, x, y + level, z, yaw, (geometry, material) => {
        batcher.add(`mdl:${material.name || 'm'}:${material.id}`, material, geometry);
      });
    },

    // Runs `fn` with everything it draws diverted into a list instead of into
    // the world. Model-backed props use this to work out what they should break
    // into without drawing the boxes they'd break into.
    captureBoxes(fn) {
      const previous = capture;
      const boxes = [];
      capture = boxes;
      try { fn(); } finally { capture = previous; }
      return boxes;
    },

    // Gives captured boxes the colours of the models stamped in their place, so
    // the wreckage is recognisably the thing that was standing there.
    paintDebris,

    // --- static props ------------------------------------------------------

    beginStatic(hp, substance, volatile = false, powerCore = false, spills = null) {
      hulkOn = false;
      stockOn = null;
      record = hp > 0
        ? {
          hp, substance, volatile, powerCore, spills,
          boxes: [], colliders: [], navTiles: [], spans: batcher.beginSpans(),
        }
        : null;
    },

    // Files the prop away as one destructible unit: the vertex runs to erase,
    // the colliders to retire, the nav tiles to give back, and the boxes to
    // scatter. `debris` stands in for the geometry a model-backed prop drew as
    // a model and therefore cannot break into — and it ADDS to whatever that
    // prop did draw as boxes, because a rack's stock is real geometry that has
    // to come off the shelf with the shelf.
    endStatic(debris) {
      const r = record;
      record = null;
      hulkOn = false;
      stockOn = null;
      if (!r) return;
      batcher.endSpans();
      if (!r.spans.length) return;

      destructibles.push({
        kind: 'prop',
        // What it is made of, so a bullet into a filing cabinet and a bullet
        // into a pot plant do not make the same noise.
        substance: r.substance,
        hp: r.hp,
        // A pressure vessel. Destroying it launches it instead of breaking it.
        volatile: r.volatile,
        // The one destructible that fans its own kill out floor-wide — see
        // destruction.js's _shatter and game.js's _onPowerCut.
        powerCore: r.powerCore,
        // What is inside it, if anything pours out when it goes. The same trait
        // a loose prop carries on `traits.spills` — a cooler is loose and a
        // vending machine is not, and both have to answer the same question.
        spills: r.spills,
        spans: r.spans,
        // Which of those spans belong to the hulk, aligned one-for-one because
        // box() records a span and a box on the same call. Only its PRESENCE is
        // read, and that is the point of it: it is how `_shatter` tells "leaves
        // a wreck" from "goes, like everything else on the floor". The grades
        // themselves travel on `parts`, which is what `_wreck` reads.
        hulkSpans: r.boxes.some((b) => b.hulk) ? r.boxes.map((b) => !!b.hulk) : null,
        // Whether this prop is holding anything, asked once here rather than
        // per destruction: `_shatter` runs for every desk and pane of glass on
        // the floor, and it must not sift a parts list looking for stock that
        // thirty of the thirty-one props in the catalogue never have. The stock
        // itself travels on `parts`, one seed per facing.
        stock: r.boxes.some((b) => typeof b.stock === 'number'),
        colliders: r.colliders,
        navTiles: r.navTiles,
        fixtures: [],
        // A captured box may already carry the colour of the model that was
        // drawn over it (see `paintDebris`); anything else wears the palette it
        // was authored in.
        parts: (debris ? [...debris, ...r.boxes] : r.boxes)
          .map((b) => ({ ...b, material: b.material ?? materials[b.key] })),
        broken: false,
      });
    },

    // `traits` is whatever about a loose prop the runtime has to know that is not
    // its shape: whether a body walking over it flattens it, and whether shooting
    // it puts water on the floor. Both are read in game.js and destruction.js,
    // which never see the catalogue.
    beginDynamic(mass, hp, substance, traits) {
      pending = { mass, hp, substance, traits, boxes: [] };
    },

    // Turns the collected boxes into one free-standing group whose origin sits
    // at the centre of their combined bounds — which is exactly where the
    // physics body's origin is, so syncing the two is a straight copy.
    endDynamic() {
      const p = pending;
      pending = null;
      if (!p || !p.boxes.length) return;

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of p.boxes) {
        minX = Math.min(minX, b.x0); maxX = Math.max(maxX, b.x1);
        minY = Math.min(minY, b.y0); maxY = Math.max(maxY, b.y1);
        minZ = Math.min(minZ, b.z0); maxZ = Math.max(maxZ, b.z1);
      }

      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      const group = new THREE.Group();
      group.position.set(cx, cy, cz);
      const boxMeshes = [];

      // The parts list is kept in the group's local space so that breaking the
      // prop apart is just "re-emit each of these as its own body" — the boxes
      // it was authored from are already the pieces it should fall into.
      const parts = [];
      for (const b of p.boxes) {
        const local = {
          key: b.key,
          material: materials[b.key],
          x0: b.x0 - cx, y0: b.y0 - cy, z0: b.z0 - cz,
          x1: b.x1 - cx, y1: b.y1 - cy, z1: b.z1 - cz,
        };
        parts.push(local);

        const mesh = new THREE.Mesh(
          boxBetween(local.x0, local.y0, local.z0, local.x1, local.y1, local.z1),
          materials[b.key]
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        boxMeshes.push(mesh);
      }

      // A loose prop drawn with its MODEL instead of its boxes, which is the one
      // combination gen/models.js says does not happen — see `washingMachine` in
      // gen/props.js for why this one has to have both. The boxes stay exactly
      // as they are, in `parts`, because they are what the prop breaks into and
      // what the collider is measured from; they are only taken out of the
      // picture.
      //
      // Two transforms, and both are the documented model contract read
      // backwards. A baked model sits centred in X/Z with its min Y at zero,
      // while the group's origin is the CENTRE of the box bounds — so the model
      // drops by exactly the distance from that centre down to the floor. And
      // the prop's quarter turn is baked into the box coordinates by `placer`,
      // so the model has to be turned by hand to match; it goes on a child group
      // rather than on the group itself, because the group's rotation belongs to
      // the physics body.
      const template = p.traits?.model ? modelInfo(p.traits.model) : null;
      if (template?.parts?.length) {
        const skin = new THREE.Group();
        skin.position.y = minY - cy;
        skin.rotation.y = -(p.traits.rot ?? 0) * Math.PI / 2;
        for (const part of template.parts) {
          const mesh = new THREE.Mesh(part.geometry, part.material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          skin.add(mesh);
        }
        group.add(skin);
        // Hidden rather than removed, so the fallback is one flag away if a GLB
        // ever fails to load mid-session. `visible` is enough: these meshes are
        // not in the raycast list (bullets test the group's children via
        // `userData.dynamic`, which is set on all of them in game.js) — and a
        // hidden mesh with a live collider is exactly what the parcels
        // documented as worse than nothing, which is why the collider is
        // measured from the BOXES either way and does not care.
        for (const mesh of boxMeshes) mesh.visible = false;
      }

      dynamics.push({
        group,
        parts,
        mass: p.mass,
        hp: p.hp ?? 0,
        substance: p.substance,
        crushable: !!p.traits?.crushable,
        spills: p.traits?.spills ?? null,
        // Whose runtime this prop belongs to, if anybody's. See washers.js.
        washer: !!p.traits?.washer,
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
        position: { x: cx, y: cy, z: cz },
      });
    },
  };
}
