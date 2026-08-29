import { PROPS, QUARTER, tryPlace, footprintOf } from './props.js';
import { doorSide, doorsOnRoom } from './layout.js';
import { PLAYER_RADIUS } from '../metrics.js';

// What each kind of room is furnished with. The catalogue in props.js says what
// a desk IS; this says where desks go. Splitting them keeps a room type to a
// dozen readable lines instead of burying it in the furniture.
//
// A room has to be recognisable from its doorway, before anything in it has
// been shot at, so every role commits to a silhouette: aisles in storage, rows
// facing a whiteboard in training, a wall of racks in the server room.

// Fills a room according to its role. Room bounds arrive in world metres,
// already shrunk by the wall clearance the builder wants to keep. `doors` is
// the floor's whole list, not just this room's own — only generatorRoom needs
// it (see doorsOnRoom there), and every other role ignores the extra argument.
export function furnish(sink, room, bounds, rng, doors) {
  const { x0, z0, x1, z1 } = bounds;
  if (x1 - x0 < 1.5 || z1 - z0 < 1.5) return;

  const fill = ROLES[room.role] ?? privateOffice;
  fill(sink, bounds, rng, room, doors);
  cartons(sink, bounds, rng);
}

// How much of the building has cardboard lying about in it, and how much.
//
// Every role gets this on top of its own recipe, which is the point: a delivery
// that never got put away is not a kind of room, it is a thing that has happened
// in three rooms out of five. Rolled per room rather than spread evenly, so some
// rooms are clear and some have a small pile — and the pile is what makes an
// office readable as somewhere people work rather than somewhere props were
// placed. They are the one prop the player can shove out of the way, shoot to
// nothing, or walk through the middle of while the staff flatten them (see
// `crushable` in props.js).
const CARTON_CHANCE = 0.62;
const CARTON_PER_M2 = 11;      // one carton per this much floor, where they land
const CARTON_MAX = 7;

function cartons(sink, bounds, rng) {
  if (!rng.chance(CARTON_CHANCE)) return;
  const { x0, z0, x1, z1 } = bounds;
  const n = Math.min(CARTON_MAX, 1 + Math.floor(area(bounds) / CARTON_PER_M2));
  for (let i = 0; i < n; i++) {
    // Against a wall about half the time. A carton in the middle of the carpet
    // reads as dropped; one against the skirting reads as stacked and left, and a
    // room wants some of each.
    if (rng.chance(0.5)) {
      edgeProp(sink, bounds, 'carton', rng);
    } else {
      tryPlace(sink, 'carton', rng.range(x0 + 0.4, x1 - 0.4), rng.range(z0 + 0.4, z1 - 0.4),
        rng.int(0, 3), rng);
    }
  }
}

// Cubicle farm: pods on a 3.7 x 3.0 m pitch, each a desk backed by an L of
// partitions, with the whole grid facing a consistent direction like real ones.
function openPlan(sink, { x0, z0, x1, z1 }, rng) {
  // The cross aisle is what is left of the pitch after a 1.6 m desk and the side
  // partition, and the player is 0.8 m across. At the old 3.4 m pitch that aisle
  // came to 0.79 m — a centimetre too narrow to walk down, which is how a whole
  // cubicle farm ends up with a quarter of it shut off from the doorway.
  const PITCH_X = 3.7;
  const PITCH_Z = 3.0;
  const cols = Math.floor((x1 - x0) / PITCH_X);
  const rows = Math.floor((z1 - z0) / PITCH_Z);
  if (cols < 1 || rows < 1) return privateOffice(sink, { x0, z0, x1, z1 }, rng);

  const padX = (x1 - x0 - cols * PITCH_X) / 2;
  const padZ = (z1 - z0 - rows * PITCH_Z) / 2;
  const rot = rng.chance(0.5) ? 0 : 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x0 + padX + (c + 0.5) * PITCH_X;
      const cz = z0 + padZ + (r + 0.5) * PITCH_Z;
      const facing = rot === 0 ? 1 : -1;

      tryPlace(sink, 'desk', cx, cz, rot, rng);
      // Through `seatFacing`, which is the same 0.85 m in front of the desk this
      // used to place by hand and one quarter turn different: a chair at the
      // DESK's rotation has its back to the desk, so every pod in the building
      // was a chair somebody would have to sit in backwards. Invisible while
      // they were empty; the moment there was a body in one it was the only
      // thing in the room.
      seatFacing(sink, 'desk', cx, cz, rot, rng, 0.85);
      tryPlace(sink, 'partition', cx, cz + facing * 0.62, 0, rng);
      if (c < cols - 1) tryPlace(sink, 'partition', cx + PITCH_X / 2 - 0.05, cz, 1, rng);
      // No cabinet in the pod. Wherever it went it stood in the cross aisle, and
      // a 0.52 m cabinet in a 0.94 m aisle leaves less than the 0.8 m the player
      // needs — which sealed off part of the farm from its own doorway. They go
      // along the walls instead, which is where they are in a real one anyway.
    }
  }

  // A shared printer and a sad plant, as is traditional — but only against a
  // wall with a lane left in front of it. The pods are a fixed pitch and the
  // room is not, so the leftover between the last desk and the wall is known
  // exactly: a prop deeper than that lane minus a body's width doesn't sit
  // against the wall, it closes the room off from its own doorway.
  //
  // The desk's real width, not the catalogue's: it is drawn as a model, so what
  // eats into the lane is the model's footprint (1.84 m, against the 1.6 m the
  // fallback boxes are authored at). The partitions stand 0.62 m behind the pod
  // centre and are 0.12 deep, so they reach 0.68 — further back than either
  // desk does — and the chairs are loose and collide with nothing, so they
  // don't enter into it.
  const bounds = { x0, z0, x1, z1 };
  const desk = footprintOf(sink, 'desk');
  const laneX = padX + (PITCH_X - desk.w) / 2;
  const laneZ = padZ + (PITCH_Z / 2 - Math.max(0.68, desk.d / 2));
  // And the same for the prop being offered the wall. Asking the catalogue how
  // deep a printer is answered 0.88 m for a machine that ships at 1.13 — so a
  // lane this test had just certified as leaving a body's width came out 0.55 m
  // wide, which is the exact failure it exists to prevent.
  const walls = (kind) => {
    const need = footprintOf(sink, kind).d + 0.8;
    return [...(laneZ >= need ? [0, 2] : []), ...(laneX >= need ? [1, 3] : [])];
  };

  if (rng.chance(0.75)) edgeProp(sink, bounds, 'cabinet', rng, walls('cabinet'));
  edgeProp(sink, bounds, 'printer', rng, walls('printer'));
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'plant', rng, walls('plant'));
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'waterCooler', rng, walls('waterCooler'));
}

function meetingRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const alongX = (x1 - x0) >= (z1 - z0);
  const rot = alongX ? 0 : 1;

  if (tryPlace(sink, 'meetingTable', cx, cz, rot, rng)) {
    // Half the table's real depth — measured across its short axis whichever
    // way round it went in, which is what `footprintOf` answers in the prop's
    // own frame — plus room for a chair to be pushed under it.
    const half = footprintOf(sink, 'meetingTable').d / 2 + 0.42;
    const seats = Math.max(2, Math.floor((alongX ? x1 - x0 : z1 - z0) / 0.85) - 1);
    for (let i = 0; i < seats; i++) {
      const t = (i - (seats - 1) / 2) * 0.85;
      if (alongX) {
        tryPlace(sink, 'chair', cx + t, cz - half, 0, rng);
        tryPlace(sink, 'chair', cx + t, cz + half, 2, rng);
      } else {
        tryPlace(sink, 'chair', cx - half, cz + t, 1, rng);
        tryPlace(sink, 'chair', cx + half, cz + t, 3, rng);
      }
    }
  } else {
    tryPlace(sink, 'coffeeTable', cx, cz, rot, rng);
  }

  if (rng.chance(0.8)) edgeProp(sink, bounds, 'whiteboard', rng);
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'cabinet', rng);
}

function breakRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  edgeProp(sink, bounds, 'counter', rng);
  edgeProp(sink, bounds, 'vending', rng);
  edgeProp(sink, bounds, 'waterCooler', rng);
  // The sofa goes against a wall. Dropped free-standing beside a coffee table
  // it is a 1.8 m wall of its own, and in a 4.5 m room a sofa broadside between
  // the vending machine and the counter shuts the far end of the room away.
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'sofa', rng);

  // Coffee tables with seating scattered through the middle.
  const tables = Math.max(1, Math.floor(((x1 - x0) * (z1 - z0)) / 9));
  for (let i = 0; i < tables; i++) {
    const cx = rng.range(x0 + 1.2, x1 - 1.2);
    const cz = rng.range(z0 + 1.2, z1 - 1.2);
    if (!tryPlace(sink, 'coffeeTable', cx, cz, rng.int(0, 3), rng)) continue;
    if (rng.chance(0.8)) tryPlace(sink, 'chair', cx, cz - 1.0, 0, rng);
    if (rng.chance(0.6)) tryPlace(sink, 'chair', cx, cz + 1.0, 2, rng);
    if (rng.chance(0.5)) tryPlace(sink, 'stool', cx - 1.0, cz, 1, rng);
  }
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'plant', rng);
  wallClutter(sink, bounds, ['trashCan', 'recyclingBin'], 45, rng);
}

// Shelving in aisles, and the boxes that never made it onto a shelf.
function storage(sink, bounds, rng) {
  aisles(sink, bounds, 1.9, 2.0, 'shelving', rng);
  // Pallets and crates are static and a metre across; loose cartons are neither.
  // Only a room with floor to spare gets the heavy goods left out on it.
  scatter(sink, bounds, area(bounds) > 55
    ? ['crateStack', 'crateStack', 'crate', 'pallet']
    : ['crateStack'], 12, rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'extinguisher', rng);
}

// Paper, in every form the building keeps it: binders on shelves, box files on
// the floor, and the cabinets nobody has opened this decade.
function archive(sink, bounds, rng) {
  aisles(sink, bounds, 1.7, 1.15, 'bookshelf', rng);
  for (let i = 0; i < 2; i++) edgeProp(sink, bounds, 'cabinet', rng);
  scatter(sink, bounds, ['crateStack'], 16, rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'trashCan', rng);
}

function copyRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const count = Math.max(1, Math.floor(Math.max(x1 - x0, z1 - z0) / 1.6));
  for (let i = 0; i < count; i++) edgeProp(sink, bounds, 'printer', rng);
  for (let i = 0; i < 2; i++) edgeProp(sink, bounds, 'cabinet', rng);
  scatter(sink, bounds, ['crateStack'], 14, rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'shelving', rng);
  wallClutter(sink, bounds, ['trashCan', 'recyclingBin'], 40, rng);
}

// Racks in ranks, tight enough that the aisles between them are the only floor.
function serverRoom(sink, bounds, rng) {
  aisles(sink, bounds, 2.2, 0.85, 'serverRack', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'workbench', rng);
  edgeProp(sink, bounds, 'extinguisher', rng);
}

// Where the hardware comes to be fixed: benches down the long walls, spares in
// crates, and one rack of the machines that are still someone's problem.
function itBay(sink, bounds, rng) {
  edgeProp(sink, bounds, 'workbench', rng);
  edgeProp(sink, bounds, 'workbench', rng);
  wallClutter(sink, bounds, ['workbench', 'serverRack', 'shelving'], 24, rng);
  scatter(sink, bounds, area(bounds) > 55
    ? ['crateStack', 'crate', 'trashCan']
    : ['crateStack', 'trashCan'], 13, rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'extinguisher', rng);
}

// Goods in, goods out: pallets in the middle of the floor because they were
// dropped where the trolley stopped.
function mailRoom(sink, bounds, rng) {
  edgeProp(sink, bounds, 'counter', rng);
  edgeProp(sink, bounds, 'shelving', rng);
  wallClutter(sink, bounds, ['recyclingBin', 'printer', 'shelving'], 28, rng);
  scatter(sink, bounds, area(bounds) > 55
    ? ['pallet', 'crate', 'crateStack', 'crateStack']
    : ['crateStack', 'crateStack', 'crate'], 10, rng);
}

// The room the building would rather you didn't see: lockers, cleaning kit and
// the spares that have no other home.
function utilityRoom(sink, bounds, rng) {
  edgeProp(sink, bounds, 'lockers', rng);
  edgeProp(sink, bounds, 'extinguisher', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'mopBucket', rng);
  wallClutter(sink, bounds, ['shelving', 'lockers', 'recyclingBin'], 26, rng);
  scatter(sink, bounds, ['crateStack', 'trashCan'], 14, rng);
}

// Rows of seats facing a board at the front, with an aisle up the middle so the
// room reads as a classroom from the doorway rather than a furniture warehouse.
function trainingRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  // Seats look at the front wall: rows run across the room, ranked back from it.
  const [f0, f1, a0, a1] = alongX ? [z0, z1, x0, x1] : [x0, x1, z0, z1];
  const at = (across, along) => (alongX ? [along, across] : [across, along]);

  // The board decides which wall is the front, not the die: a doorway keeps
  // four tiles of floor clear on both sides, so a board centred on the wall the
  // door is in never lands — and rows of chairs facing a blank wall is not a
  // training room, it is a waiting room. Try both walls and a few positions
  // along each, and rank the seats at whichever one took it.
  let front = null, dir = 1, rot = 0;
  for (const flip of rng.chance(0.5) ? [false, true] : [true, false]) {
    front = flip ? f1 : f0;
    dir = flip ? -1 : 1;                                   // deeper into the room
    rot = alongX ? (flip ? 0 : 2) : (flip ? 3 : 1);        // facing the front wall
    let placed = false;
    for (const t of [0.5, 0.3, 0.7, 0.18, 0.82]) {
      const [bx, bz] = at(front + dir * 0.3, a0 + (a1 - a0) * t);
      if (tryPlace(sink, 'whiteboard', bx, bz, (rot + 2) & 3, rng)) { placed = true; break; }
    }
    if (placed) break;
  }

  const seats = Math.floor((a1 - a0) / 0.8);
  const ranks = Math.floor((f1 - f0 - 1.6) / 1.1);
  for (let r = 0; r < ranks; r++) {
    for (let s = 0; s < seats; s++) {
      // The gangway: nothing in the middle column of a wide enough room.
      if (seats >= 5 && s === (seats >> 1)) continue;
      const along = a0 + (a1 - a0) * ((s + 0.5) / seats);
      const [cx, cz] = at(front + dir * (1.6 + r * 1.1), along);
      tryPlace(sink, 'chair', cx, cz, rot, rng);
    }
  }
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'cabinet', rng);
}

// Canteen seating: round tables with stools round them, on a pitch wide enough
// to walk between two occupied chairs.
function canteen(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const PITCH = 3.4;
  const cols = Math.max(1, Math.floor((x1 - x0) / PITCH));
  const rows = Math.max(1, Math.floor((z1 - z0) / PITCH));
  const padX = (x1 - x0 - cols * PITCH) / 2;
  const padZ = (z1 - z0 - rows * PITCH) / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x0 + padX + (c + 0.5) * PITCH;
      const cz = z0 + padZ + (r + 0.5) * PITCH;
      if (!tryPlace(sink, 'roundTable', cx, cz, 0, rng)) {
        tryPlace(sink, 'coffeeTable', cx, cz, rng.int(0, 3), rng);
        continue;
      }
      // Stools on the four sides, most of them pushed back in.
      for (const [dx, dz, rot] of [[0, -1.4, 0], [0, 1.4, 2], [-1.4, 0, 1], [1.4, 0, 3]]) {
        if (rng.chance(0.75)) tryPlace(sink, 'stool', cx + dx, cz + dz, rot, rng);
      }
    }
  }

  edgeProp(sink, bounds, 'counter', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'vending', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'recyclingBin', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'plant', rng);
}

// The front of house on a floor that has one: a counter to be greeted at, and
// seating for the meeting you are not here for.
function reception(sink, bounds, rng) {
  edgeProp(sink, bounds, 'receptionDesk', rng);
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'armchair', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'armchair', rng);
  if (rng.chance(0.7)) {
    const { x0, z0, x1, z1 } = bounds;
    tryPlace(sink, 'coffeeTable', (x0 + x1) / 2, (z0 + z1) / 2, rng.int(0, 3), rng);
  }
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'plant', rng);
}

// A desk in the dead centre of a 4.5 m room leaves only ~0.65 m of standable
// floor either side once the player's radius is taken off both edges, and a
// single cabinet dropped at a random wall then closes one of them and cuts the
// room in half. So the desk goes against a wall like a real one, and only rooms
// with space to spare get a free-standing island.
function privateOffice(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const roomy = Math.min(x1 - x0, z1 - z0) > 6;

  let seated = false;
  if (roomy && rng.chance(0.5)) {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const rot = rng.int(0, 3);
    if (tryPlace(sink, 'desk', cx, cz, rot, rng)) {
      seatFacing(sink, 'desk', cx, cz, rot, rng);
      seated = true;
    }
  }
  if (!seated) seated = deskAgainstWall(sink, bounds, rng);

  if (rng.chance(0.8)) edgeProp(sink, bounds, 'cabinet', rng);
  if (rng.chance(0.45)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.3)) edgeProp(sink, bounds, 'bookshelf', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'trashCan', rng);
}

// Desk backed onto a wall with its chair tucked in front of it.
function deskAgainstWall(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  // The footprint the placer will actually reserve — the desk's model is
  // 1.84 x 0.97 where its fallback boxes are 1.6 x 0.8, so seating it off the
  // catalogue's numbers put its back 8.5 cm through the wall inset and its
  // chair 8.5 cm too close to it.
  const { w: fw, d: fd } = footprintOf(sink, 'desk');
  const standoff = fd / 2;
  const margin = fw / 2;

  for (let tries = 0; tries < 10; tries++) {
    const side = rng.int(0, 3);
    const alongX = side === 0 || side === 2;
    if (alongX && x1 - x0 < margin * 2) continue;
    if (!alongX && z1 - z0 < margin * 2) continue;

    const [cx, cz] = seatAt(side, x0, z0, x1, z1, standoff, margin, rng);
    if (!tryPlace(sink, 'desk', cx, cz, side, rng)) continue;

    seatFacing(sink, 'desk', cx, cz, side, rng);
    return true;
  }
  return false;
}

// Where a prop stands when its back is against `side`. Half its DEPTH off the
// wall and half its WIDTH in from each end of it — that is the whole point of
// backing something against a wall, and swapping the two pushed wide props a
// metre into the room and buried narrow ones in the plaster.
function seatAt(side, x0, z0, x1, z1, standoff, margin, rng) {
  switch (side) {
    case 0: return [rng.range(x0 + margin, x1 - margin), z1 - standoff];
    case 1: return [x0 + standoff, rng.range(z0 + margin, z1 - margin)];
    case 2: return [rng.range(x0 + margin, x1 - margin), z0 + standoff];
    default: return [x1 - standoff, rng.range(z0 + margin, z1 - margin)];
  }
}

// Backs a `spanning` prop against one whole wall, corner to corner, and returns
// where it landed (or null). The prop is built to the length it is given rather
// than to a catalogue width — see `spanning` in gen/props.js.
//
// The retreat is the point of having a helper at all. Reaching both corners
// means reserving every tile across the room, and the furnisher is not the only
// thing with a claim on them: reserveClearances in gen/build.js stamps doorway
// aprons into the shared grid without regard for whose room the tile is in, so
// one unrelated doorway on the other side of that wall can veto the full span.
// Giving up there would leave the room without the one thing it is named for,
// so it steps in half a metre a side and asks again, and only then falls back
// to the catalogue size somewhere else on the wall.
function wallSpanProp(sink, bounds, kind, rng, side) {
  const { x0, z0, x1, z1 } = bounds;
  const { d: fd } = footprintOf(sink, kind);
  const standoff = fd / 2;
  const alongX = side === 0 || side === 2;
  const full = alongX ? x1 - x0 : z1 - z0;
  const mid = alongX ? (x0 + x1) / 2 : (z0 + z1) / 2;
  const out = side === 0 ? z1 - standoff : side === 2 ? z0 + standoff
    : side === 1 ? x0 + standoff : x1 - standoff;

  // Starting a hair inside the bounds rather than exactly on them. `bounds` is
  // already the 0.15 m wall inset every prop in the building is held to, and a
  // prop whose edge lands exactly on it is one rounding error from being
  // reported as through the plaster (9.inset in tools/validate-props.mjs).
  for (let span = full - 0.04; span >= full - 1.5 && span > 2; span -= 0.5) {
    const cx = alongX ? mid : out;
    const cz = alongX ? out : mid;
    if (tryPlace(sink, kind, cx, cz, side, rng, span)) {
      return { cx, cz, rot: side, side, span };
    }
  }
  return null;
}

// The chair that goes with whatever was just backed against a wall: a body's
// width out in front of it, turned round to face it.
//
// And the one place in the furnisher that says where somebody WORKS. A desk with
// a monitor on it and a chair pulled up to it is a job, and the chair is where
// the body doing it sits — so the same call that puts the chair down registers
// the workstation, and a room cannot end up with a seated body facing the wrong
// way or sitting on nothing. `sink.workstation` decides whether it is worth
// keeping (see makeSink in gen/build.js); everything downstream is enemies.js's.
function seatFacing(sink, kind, cx, cz, rot, rng, gap = 0.95) {
  const out = QUARTER[rot & 3](0, -gap);
  const x = cx + out[0];
  const z = cz + out[1];
  const seat = (rot + 2) & 3;

  // Placed inside the desk's own reservation, because a chair pulled up to a
  // desk is inside it whatever the arithmetic says: floor is reserved by whole
  // tiles and a 0.97 m desk reaches half a metre past its own front face. That
  // is what `lend` is for, and without it this failed on all 16 wall-backed
  // desks of the floor it was measured on. Every other claim on the floor still
  // stands while the tiles are lent — the wall behind, the doorway apron, the
  // cabinet beside it.
  const { w, d } = footprintOf(sink, kind, rot);
  const placed = sink.lend(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2,
    () => tryPlace(sink, 'chair', x, z, seat, rng));
  if (!placed) return false;

  sink.workstation(x, z, seat);
  return true;
}

// --- the three rooms you need a card for ------------------------------------
//
// All three are behind a badge reader (see assignLocks in gen/layout.js), so
// each one is a room you had to work to stand in. That buys them the right to
// look like somewhere: the payoff for a keycard is seeing the room, so none of
// them may furnish as "a private office with a different label on the door".

// Corner office. A desk you sit BEHIND with the visitor's chairs in front of it,
// which is the whole silhouette — nobody else on the floor gets seating that
// faces the wrong way.
function managerOffice(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  if (!deskAgainstWall(sink, bounds, rng)) {
    tryPlace(sink, 'desk', (x0 + x1) / 2, (z0 + z1) / 2, rng.int(0, 3), rng);
  }
  edgeProp(sink, bounds, 'bookshelf', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'cabinet', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'armchair', rng);
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) {
    tryPlace(sink, 'coffeeTable', (x0 + x1) / 2, (z0 + z1) / 2, rng.int(0, 3), rng);
  }
}

// The room the cameras come back to: a bank of screens against one wall, racks
// and lockers against the others, and nothing in the middle to walk into.
function securityOffice(sink, bounds, rng) {
  // The camera desk goes in first and unconditionally, before the room has been
  // filled with anything that could take its wall. It is what the room IS — you
  // needed a blue card to stand here, and the payoff for that has to be visible
  // from the doorway rather than rolled for.
  const desk = edgeProp(sink, bounds, 'cameraDesk', rng);
  // And the chair somebody watched them from, facing the screens.
  if (desk) seatFacing(sink, 'cameraDesk', desk.cx, desk.cz, desk.rot, rng, 1.0);

  edgeProp(sink, bounds, 'serverRack', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'workbench', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'lockers', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'cabinet', rng);
  edgeProp(sink, bounds, 'extinguisher', rng);
  wallClutter(sink, bounds, ['shelving', 'trashCan'], 30, rng);
}

// A broom closet is small, and the point of it is that the walls are the room:
// everything against them and one body's width of floor down the middle.
function broomCloset(sink, bounds, rng) {
  edgeProp(sink, bounds, 'mopBucket', rng);
  edgeProp(sink, bounds, 'shelving', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'lockers', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'recyclingBin', rng);
  edgeProp(sink, bounds, 'trashCan', rng);
  scatter(sink, bounds, ['crateStack'], 11, rng);
}

// The generator room: a big double-height plant room (see generatorRoomCut in
// gen/build.js) built around the one prop that matters. It goes in FIRST and
// against a wall like anything else load-bearing in here — same reasoning as
// the camera desk in securityOffice: a room this size open in the middle
// reads as a hangar with a box in it, not a plant room, and every other item
// below is placed against whatever wall it left. The rest reads as the crew
// that works this room: monitoring terminals rather than desks, and the
// crates and spares an industrial space accumulates.
function generatorRoom(sink, bounds, rng, room, doors) {
  // Dead opposite the room's one door (see the `generator` fits predicate in
  // gen/layout.js, which guarantees there's exactly one) — walk in and it's
  // the first thing you see, on the far wall rather than tucked to one side.
  // `doorsOnRoom` rather than `room.doors[0]`: the fits predicate already had
  // to use it instead of `room.doors.length` for the same reason — the room's
  // own list only holds doors IT cut, and its one real doorway may have been
  // cut by the room next door into their shared wall, which would leave
  // `room.doors` empty and `room.doors[0]` undefined.
  const door = doorsOnRoom(doors, room)[0];
  const oppositeWall = (doorSide(door, room) + 2) % 4;
  // Corner to corner, not a five-metre cabinet parked against the middle of a
  // fifteen-metre wall: the machine IS the far end of the room, and the whole
  // composition of the space — walk in, and it is in front of you, floor to
  // roof and wall to wall — depends on it reaching both sides.
  if (!wallSpanProp(sink, bounds, 'generator', rng, oppositeWall)) {
    // The one wall it wants can, rarely, be unavailable even at the catalogue
    // width. A generator on the wrong wall beats a generator room with no
    // generator in it, so this falls back to whichever wall will take it.
    edgeProp(sink, bounds, 'generator', rng);
  }

  edgeProp(sink, bounds, 'workbench', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'workbench', rng);
  edgeProp(sink, bounds, 'serverRack', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'serverRack', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'cabinet', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'lockers', rng);
  edgeProp(sink, bounds, 'extinguisher', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'extinguisher', rng);
  scatter(sink, bounds, ['crateStack', 'crate', 'pallet'], 26, rng);
}

// The staff canteen, and the room the floor puts you down in — see
// pickCafeteria in gen/layout.js, which is what makes it the spawn room.
//
// It is a set piece the way the plant room is, and the composition is the whole
// of it: the servery runs the far wall corner to corner, the strip in front of
// it is left clear because that is where a queue would stand, and the seating
// behind that is laid in ROWS facing the counter. Rows rather than the `canteen`
// role's scatter of round tables, because rows are what make the servery the END
// of the room instead of one wall of four — the same argument the generator's
// wall-to-wall placement rests on.
//
// `canteen` is still what a mid-sized room rolls, and the two are meant to read
// differently: that one is somewhere on the floor to eat, this one is the
// canteen the floor is arranged around.
function cafeteria(sink, bounds, rng, room, doors) {
  const { x0, z0, x1, z1 } = bounds;

  // Dead opposite the door you come in by, so the counter is the first thing in
  // front of you. `doorsOnRoom` rather than `room.doors`, for the reason
  // generatorRoom gives: a room's own list holds only the doors IT cut, and a
  // room this big usually has neighbours who cut theirs into a shared wall. A
  // room with no doorway at all falls back to a long wall, which is where a
  // serving line would go anyway.
  const door = doorsOnRoom(doors, room)[0];
  const alongX = (x1 - x0) >= (z1 - z0);
  const facing = door ? (doorSide(door, room) + 2) % 4 : (alongX ? 0 : 1);

  // Corner to corner if that wall will take it. The wall it wants can be
  // unavailable — a doorway apron across it, or another room's door in it — and
  // a servery on the wrong wall beats a cafeteria with no counter in it, so
  // edgeProp is the fallback. It may land the thing somewhere else entirely,
  // which is why everything below measures off where the counter ACTUALLY went
  // rather than off where it was asked for.
  const line = wallSpanProp(sink, bounds, 'servery', rng, facing)
    ?? edgeProp(sink, bounds, 'servery', rng);
  const side = line ? line.side : facing;

  // The queue. Nothing is furnished into the strip in front of the counter: it
  // is where you stand to be served, and a table in it is a table that has to be
  // squeezed past to reach the one thing the room is for.
  const QUEUE = 2.4;
  const seat = { x0, z0, x1, z1 };
  if (side === 0) seat.z1 -= QUEUE;
  else if (side === 1) seat.x0 += QUEUE;
  else if (side === 2) seat.z0 += QUEUE;
  else seat.x1 -= QUEUE;

  // Rows parallel to the counter, so every table faces it and the gangways run
  // toward it.
  const rot = (side === 0 || side === 2) ? 0 : 1;
  // Across the rows: the table, a chair on each side of it, and a gangway wide
  // enough to get past the backs of two occupied chairs.
  const ROW_PITCH = 3.2;
  // Along a row, and this one is a clearance rather than a taste: a table is
  // 2.3 m and STATIC, so the gap between two of them is a gap in a wall the
  // length of the room. At the 2.9 m that looked right it was 0.6 m, which a
  // 0.8 m body does not fit through — a row would have sealed every gangway
  // behind it off from the next but for the ends. Same lane SCATTER_LANE keeps
  // beside anything dropped in the middle of a room, and for the same reason.
  const TABLE_PITCH = 3.3;

  const [a0, a1, b0, b1] = rot === 0
    ? [seat.x0, seat.x1, seat.z0, seat.z1]
    : [seat.z0, seat.z1, seat.x0, seat.x1];
  // Half the table's real depth plus room for a chair to be pushed under it —
  // measured through footprintOf like every other placement, never off the
  // catalogue numbers.
  const reach = footprintOf(sink, 'canteenTable').d / 2 + 0.42;

  // Rows laid from the queue lane backward, and each row filled by WALKING it
  // rather than by stepping a grid.
  //
  // That is the whole difference between a canteen and an empty hall, and it was
  // measured rather than guessed. On a rigid grid a cell is all or nothing: the
  // table either fits at the one spot the arithmetic named or the room does
  // without it, and the middle of a cafeteria is the one piece of floor with a
  // doorway apron, a through-route lane and the square kept clear where the
  // player materialises all stamped across it. Six cells in an 11 x 10 m room,
  // all six touching one reservation or another, and the room came out with a
  // servery, a vending machine and nothing at all to sit at. Sliding along the
  // row instead puts tables on both sides of whatever is in the way and lands a
  // median of 5, because a row is a rank of tables at a spacing rather than
  // furniture at named coordinates.
  // Both axes are WALKED rather than stepped as a grid, and that is the whole
  // difference between a canteen and an empty hall. It was measured, not
  // guessed. On a grid a cell is all or nothing — the table fits at the one spot
  // the arithmetic named or the room does without it — and the middle of a
  // cafeteria is the one piece of floor carrying a doorway apron, a through-route
  // lane and the square kept clear where the player materialises, all stamped
  // across it. Every cell in an 11 x 10 m room touched one reservation or
  // another and the room came out with nothing at all to sit at.
  //
  // Sliding puts tables on both sides of whatever is in the way: along a row for
  // an apron reaching into it, and across the rows for a band of floor that is
  // spoken for. The ranks stay parallel and evenly spaced because each axis only
  // jumps a full pitch once something has actually landed.
  const STEP = 0.25;
  const half = footprintOf(sink, 'canteenTable').w / 2;

  for (let b = b0 + reach; b <= b1 - reach; b += 0.5) {
    let landed = 0;
    for (let a = a0 + half; a <= a1 - half; a += STEP) {
      const cx = rot === 0 ? a : b;
      const cz = rot === 0 ? b : a;
      if (!tryPlace(sink, 'canteenTable', cx, cz, rot, rng)) continue;
      landed++;

      // Chairs down both long sides, most of them pushed back in.
      //
      // Inside the table's own reservation, which is what `lend` is for and is
      // not optional: floor is claimed by whole tiles, so a 0.86 m table's claim
      // reaches a good way past its own edge and a chair pulled up to it lands
      // inside that claim whatever the arithmetic says. Exactly the failure
      // seatFacing documents, and it showed here the same way — four tables in
      // the room and not one chair at any of them. Every other claim still
      // stands while the tiles are lent: the servery, the doorway aprons, the
      // vending machine on the wall behind.
      //
      // Placed directly rather than through seatFacing, though, and that is
      // deliberate: that call also registers a WORKSTATION, and a canteen chair
      // is somewhere to eat lunch rather than somewhere a body works — see
      // _takeDesk in enemies.js, which would otherwise find twenty jobs in here.
      const { w: tw, d: td } = footprintOf(sink, 'canteenTable', rot);
      sink.lend(cx - tw / 2, cz - td / 2, cx + tw / 2, cz + td / 2, () => {
        for (const t of [-0.62, 0.62]) {
          if (rng.chance(0.72)) {
            if (rot === 0) tryPlace(sink, 'chair', cx + t, cz - reach, 0, rng);
            else tryPlace(sink, 'chair', cx - reach, cz + t, 1, rng);
          }
          if (rng.chance(0.72)) {
            if (rot === 0) tryPlace(sink, 'chair', cx + t, cz + reach, 2, rng);
            else tryPlace(sink, 'chair', cx + reach, cz + t, 3, rng);
          }
        }
      });
      // Only after one lands: the next along starts a full pitch away, so the
      // rank keeps the gap a body walks through between two tables (see
      // TABLE_PITCH) rather than having it eroded by the sliding.
      a += TABLE_PITCH - STEP;
    }
    if (landed) b += ROW_PITCH - 0.5;
  }

  // And what a canteen keeps round its edges. The counter is the set piece;
  // these are what make the room read as one people use.
  edgeProp(sink, bounds, 'vending', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'vending', rng);
  if (rng.chance(0.8)) edgeProp(sink, bounds, 'counter', rng);      // the coffee run
  edgeProp(sink, bounds, 'waterCooler', rng);
  edgeProp(sink, bounds, 'recyclingBin', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'trashCan', rng);
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'plant', rng);
  // A kitchen has one on the wall, and this is the room the player starts in —
  // the secondary is worth having within reach of the first doorway.
  edgeProp(sink, bounds, 'extinguisher', rng);
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'extinguisher', rng);
}

function lobby(sink, bounds, rng) {
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'coffeeTable', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'armchair', rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'extinguisher', rng);
}

const ROLES = {
  openplan: openPlan,
  meeting: meetingRoom,
  breakroom: breakRoom,
  storage,
  archive,
  copyroom: copyRoom,
  server: serverRoom,
  itbay: itBay,
  mailroom: mailRoom,
  utility: utilityRoom,
  training: trainingRoom,
  canteen,
  cafeteria,
  reception,
  office: privateOffice,
  manager: managerOffice,
  security: securityOffice,
  closet: broomCloset,
  generator: generatorRoom,
  lobby,
  exit: lobby,
};

// Every role the generator is allowed to hand out. layout.js picks from this by
// size; anything it picks that isn't here would silently come out as an office.
export const ROOM_ROLES = Object.keys(ROLES);

// --- placement helpers ------------------------------------------------------

// Ranks of a repeated unit with a walking aisle between the ranks. The ranks
// run along the room's LONG axis, so the aisles are short hops across it rather
// than a trek from one end to the other — and there is always an aisle mouth on
// the long wall, which is where the doors mostly are.
// A rank stops short of both end walls by GANGWAY, which is not decoration: an
// aisle is a dead end if the only way out is the way you came, so one dropped
// pallet in the middle of one seals off everything past it. With a gangway
// round the ends every aisle has two mouths and no single blockage can shut a
// room's floor away from its own doorway.
const GANGWAY = 0.9;   // metres — the player is 0.8 m across

function aisles(sink, bounds, aislePitch, unitPitch, kind, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  const [a0, a1, b0, b1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const rot = alongX ? 0 : 1;

  // Too short to hold a rank and its gangways: leave it to the clutter.
  if (a1 - a0 < 2 * GANGWAY + unitPitch) return;

  // How far the last rank may stand from the far wall, which is half of what
  // the rank is actually DEEP — the same footprint tryPlace will reserve, so a
  // model-backed rack is measured at the size it ships at. This was a flat
  // 0.4 m, which happened to suit a 1.06 m server rack and not the 1.31 m one
  // the model turned out to be, and the last rank in every server room stood a
  // couple of centimetres into the wall inset because of it. `b` is the aisle
  // axis, and a rank presents its depth along it whichever way round the room
  // is, which is why this asks in the prop's own frame.
  const half = footprintOf(sink, kind).d / 2;
  for (let b = b0 + aislePitch * 0.3; b < b1 - half; b += aislePitch) {
    for (let a = a0 + GANGWAY + unitPitch / 2; a < a1 - GANGWAY - unitPitch / 2 + 0.05; a += unitPitch) {
      if (alongX) tryPlace(sink, kind, a, b, rot, rng);
      else tryPlace(sink, kind, b, a, rot, rng);
    }
  }
}

const ALL_SIDES = [0, 1, 2, 3];

const area = ({ x0, z0, x1, z1 }) => (x1 - x0) * (z1 - z0);

// Optional props along the walls, as many as the room has floor to carry. A
// 34 m2 break room and a 120 m2 one must not both get one of everything: a prop
// against a wall is cheap on its own and expensive in company, because three of
// them in a line across a narrow room close the room in half. `kinds` is in
// priority order — the first is the one the room most wants.
function wallClutter(sink, bounds, kinds, perM2, rng) {
  const n = Math.min(kinds.length, Math.floor(area(bounds) / perM2));
  for (let i = 0; i < n; i++) edgeProp(sink, bounds, kinds[i], rng);
}

// Clutter dropped where it was put down. `perM2` is one item per that many
// square metres — the room's own size decides how littered it is.
//
// A STATIC prop dropped in the middle of the floor is the one thing the furnisher
// does that can wall a room off, so it has to leave a body's width around it.
//
// This is the copyroom bug in a second room type (see reserveThroughRoutes in
// gen/build.js): `canPlace` rounds a footprint outward to whole tiles, so two
// props in diagonally adjacent tile blocks can pass that test and still leave a
// gap no body can get through — two 0.8 m crates a tile apart on the diagonal
// have about 0.53 m of perpendicular clearance against a 0.8 m body. Measured in
// an itbay on one floor in three hundred: 2266 cells of its own floor cut off
// behind exactly two scattered crates, with a two-cell neck between them.
//
// Asking for the footprint plus a body's radius on every side is the whole fix,
// and it costs a little density in a busy room: a crate that cannot leave a lane
// beside it is a crate that does not land. Loose props are exempt because they are
// not obstacles — you walk into a carton and it moves.
const SCATTER_LANE = PLAYER_RADIUS;

function scatter(sink, bounds, kinds, perM2, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const n = 1 + Math.floor(((x1 - x0) * (z1 - z0)) / perM2);
  for (let i = 0; i < n; i++) {
    const kind = rng.pick(kinds);
    const x = rng.range(x0 + 0.5, x1 - 0.5);
    const z = rng.range(z0 + 0.5, z1 - 0.5);
    const rot = rng.int(0, 3);
    if (!PROPS[kind]?.mass) {
      const foot = footprintOf(sink, kind, rot);
      const w = foot.w / 2 + SCATTER_LANE, d = foot.d / 2 + SCATTER_LANE;
      if (!sink.canPlace(x - w, z - d, x + w, z + d)) continue;
    }
    tryPlace(sink, kind, x, z, rot, rng);
  }
}

// Tries to seat a prop against a random wall, back to the wall, a few times.
//
// Every side uses HALF THE DEPTH as the standoff and HALF THE WIDTH as the
// along-wall margin, with no special case. That is the whole point of backing a
// prop against a wall: its depth always faces the wall, and the quarter-turn
// each side applies is exactly what maps `d` onto the axis perpendicular to it.
// Swapping the two here pushed wide props (counters, meeting tables) up to a
// metre out into the room and shoved narrow ones into the wall.
//
// Sides, throughout: 0 = the +z wall, 1 = -x, 2 = -z, 3 = +x — and the side IS
// the quarter turn, which is not a coincidence and took a wall of dark monitors
// to notice. A prop is authored facing -z (see gen/props.js), so the turn that
// puts its face into the room is exactly the one that maps -z onto the direction
// away from the wall: rot 0 for the +z wall, rot 1 for -x, and so on. The two
// even sides used to be the other way round, which stood every vending machine,
// whiteboard and reception desk on the +z and -z walls with its front to the
// plaster — invisible on a grey box, and instantly obvious on eight lit screens.
// It also aimed `deskAgainstWall`'s chair at the wall, so those desks silently
// came out with nobody sitting at them.
//
// `sides` narrows which walls are on offer. A room that knows something about
// its own layout — a cubicle farm knows exactly how much lane it left between
// the desks and each wall — uses it to keep a prop off the wall where it would
// close that lane, instead of leaving it to a die roll.
//
// Returns WHERE it landed, or null. Almost every caller only wants to know
// whether it did, and an object is as truthy as `true` — but a room that has to
// put a chair in front of the thing it just placed has no other way to find out
// which wall the die picked.
function edgeProp(sink, bounds, kind, rng, sides = ALL_SIDES) {
  const { x0, z0, x1, z1 } = bounds;
  // Asked in the prop's OWN frame, where `d` is always the dimension that faces
  // the wall and `w` the one that runs along it — which is the whole reason the
  // side is the quarter turn. The numbers come from the model when there is
  // one, because that is the footprint tryPlace is about to reserve; taking
  // them from the catalogue instead stood a copier 0.44 m off a wall it is
  // 0.565 m deep from the middle of, and a server rack likewise.
  const { w: fw, d: fd } = footprintOf(sink, kind);
  const standoff = fd / 2;
  const margin = fw / 2;   // so a 3 m table can't hang off the end of the wall

  const alongX = x1 - x0 >= margin * 2;
  const alongZ = z1 - z0 >= margin * 2;
  if (!sides.length) return null;

  for (let tries = 0; tries < 12; tries++) {
    const side = rng.pick(sides);
    // A prop wider than the wall it was offered simply doesn't fit there.
    if ((side === 0 || side === 2) && !alongX) continue;
    if ((side === 1 || side === 3) && !alongZ) continue;

    const [cx, cz] = seatAt(side, x0, z0, x1, z1, standoff, margin, rng);
    if (tryPlace(sink, kind, cx, cz, side, rng)) return { cx, cz, rot: side, side };
  }
  return null;
}
