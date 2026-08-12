import { QUARTER, tryPlace, footprintOf } from './props.js';

// What each kind of room is furnished with. The catalogue in props.js says what
// a desk IS; this says where desks go. Splitting them keeps a room type to a
// dozen readable lines instead of burying it in the furniture.
//
// A room has to be recognisable from its doorway, before anything in it has
// been shot at, so every role commits to a silhouette: aisles in storage, rows
// facing a whiteboard in training, a wall of racks in the server room.

// Fills a room according to its role. Room bounds arrive in world metres,
// already shrunk by the wall clearance the builder wants to keep.
export function furnish(sink, room, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  if (x1 - x0 < 1.5 || z1 - z0 < 1.5) return;

  const fill = ROLES[room.role] ?? privateOffice;
  fill(sink, bounds, rng);
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
      tryPlace(sink, 'chair', cx, cz - facing * 0.85, rot, rng);
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
      seatFacing(sink, cx, cz, rot, rng);
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

    seatFacing(sink, cx, cz, side, rng);
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

// The chair that goes with whatever was just backed against a wall: a body's
// width out in front of it, turned round to face it.
function seatFacing(sink, cx, cz, rot, rng, gap = 0.95) {
  const out = QUARTER[rot & 3](0, -gap);
  return tryPlace(sink, 'chair', cx + out[0], cz + out[1], (rot + 2) & 3, rng);
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
  if (desk) seatFacing(sink, desk.cx, desk.cz, desk.rot, rng, 1.0);

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
// gen/build.js) built around the one prop that matters. `tryPlace` goes first
// and dead centre, so every other item in here is placed against whatever
// floor it left — same ordering as `furnishRooms` relying on the generator
// having already claimed the middle of the room before anything else asks for
// space. The rest reads as the crew that works this room: monitoring
// terminals rather than desks, and the crates and spares an industrial space
// accumulates.
function generatorRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  tryPlace(sink, 'generator', (x0 + x1) / 2, (z0 + z1) / 2, rng.int(0, 3), rng);

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
function scatter(sink, bounds, kinds, perM2, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const n = 1 + Math.floor(((x1 - x0) * (z1 - z0)) / perM2);
  for (let i = 0; i < n; i++) {
    tryPlace(sink, rng.pick(kinds),
      rng.range(x0 + 0.5, x1 - 0.5), rng.range(z0 + 0.5, z1 - 0.5), rng.int(0, 3), rng);
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
