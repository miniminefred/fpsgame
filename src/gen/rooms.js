import { PROPS, QUARTER, tryPlace } from './props.js';

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

  // A shared printer and a sad plant, as is traditional.
  if (rng.chance(0.75)) edgeProp(sink, { x0, z0, x1, z1 }, 'cabinet', rng);
  edgeProp(sink, { x0, z0, x1, z1 }, 'printer', rng);
  if (rng.chance(0.7)) edgeProp(sink, { x0, z0, x1, z1 }, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, { x0, z0, x1, z1 }, 'waterCooler', rng);
}

function meetingRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const alongX = (x1 - x0) >= (z1 - z0);
  const rot = alongX ? 0 : 1;

  if (tryPlace(sink, 'meetingTable', cx, cz, rot, rng)) {
    const table = PROPS.meetingTable;
    const half = (sink.modelInfo?.(table.model)?.foot[1] ?? table.d) / 2 + 0.42;
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

  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'cabinet', rng);
}

function breakRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  edgeProp(sink, bounds, 'counter', rng);
  edgeProp(sink, bounds, 'vending', rng);
  edgeProp(sink, bounds, 'waterCooler', rng);

  // Coffee tables with seating scattered through the middle.
  const tables = Math.max(1, Math.floor(((x1 - x0) * (z1 - z0)) / 9));
  for (let i = 0; i < tables; i++) {
    const cx = rng.range(x0 + 1.2, x1 - 1.2);
    const cz = rng.range(z0 + 1.2, z1 - 1.2);
    if (!tryPlace(sink, 'coffeeTable', cx, cz, rng.int(0, 3), rng)) continue;
    if (rng.chance(0.8)) tryPlace(sink, 'chair', cx, cz - 1.0, 0, rng);
    if (rng.chance(0.6)) tryPlace(sink, 'chair', cx, cz + 1.0, 2, rng);
    if (rng.chance(0.4)) tryPlace(sink, 'sofa', cx + 1.9, cz, 1, rng);
  }
  if (rng.chance(0.6)) edgeProp(sink, bounds, 'plant', rng);
}

function storage(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  const AISLE = 1.9;

  // Rows of shelving with walking aisles between them.
  if (alongX) {
    for (let z = z0 + 0.5; z < z1 - 0.4; z += AISLE) {
      for (let x = x0 + 1.0; x < x1 - 0.9; x += 2.0) {
        tryPlace(sink, 'shelving', x, z, 0, rng);
      }
    }
  } else {
    for (let x = x0 + 0.5; x < x1 - 0.4; x += AISLE) {
      for (let z = z0 + 1.0; z < z1 - 0.9; z += 2.0) {
        tryPlace(sink, 'shelving', x, z, 1, rng);
      }
    }
  }

  // Boxes that never made it onto a shelf.
  const stacks = 2 + Math.floor(((x1 - x0) * (z1 - z0)) / 12);
  for (let i = 0; i < stacks; i++) {
    tryPlace(sink, 'crateStack', rng.range(x0 + 0.5, x1 - 0.5), rng.range(z0 + 0.5, z1 - 0.5), rng.int(0, 3), rng);
  }
}

function copyRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const count = Math.max(1, Math.floor(Math.max(x1 - x0, z1 - z0) / 1.6));
  for (let i = 0; i < count; i++) edgeProp(sink, bounds, 'printer', rng);
  for (let i = 0; i < 2; i++) edgeProp(sink, bounds, 'cabinet', rng);
  const stacks = 1 + Math.floor(((x1 - x0) * (z1 - z0)) / 14);
  for (let i = 0; i < stacks; i++) {
    tryPlace(sink, 'crateStack', rng.range(x0 + 0.5, x1 - 0.5), rng.range(z0 + 0.5, z1 - 0.5), rng.int(0, 3), rng);
  }
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'shelving', rng);
}

function serverRoom(sink, bounds, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const alongX = (x1 - x0) >= (z1 - z0);
  if (alongX) {
    for (let z = z0 + 0.6; z < z1 - 0.5; z += 2.2) {
      for (let x = x0 + 0.5; x < x1 - 0.4; x += 0.85) tryPlace(sink, 'serverRack', x, z, 0, rng);
    }
  } else {
    for (let x = x0 + 0.6; x < x1 - 0.5; x += 2.2) {
      for (let z = z0 + 0.5; z < z1 - 0.4; z += 0.85) tryPlace(sink, 'serverRack', x, z, 1, rng);
    }
  }
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
      const back = QUARTER[rot & 3](0, -0.95);
      tryPlace(sink, 'chair', cx + back[0], cz + back[1], (rot + 2) & 3, rng);
      seated = true;
    }
  }
  if (!seated) seated = deskAgainstWall(sink, bounds, rng);

  if (rng.chance(0.8)) edgeProp(sink, bounds, 'cabinet', rng);
  if (rng.chance(0.45)) edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.3)) edgeProp(sink, bounds, 'shelving', rng);
}

// Desk backed onto a wall with its chair tucked in front of it.
function deskAgainstWall(sink, { x0, z0, x1, z1 }, rng) {
  const spec = PROPS.desk;
  const standoff = spec.d / 2;
  const margin = spec.w / 2;

  for (let tries = 0; tries < 10; tries++) {
    const side = rng.int(0, 3);
    const alongX = side === 0 || side === 2;
    if (alongX && x1 - x0 < margin * 2) continue;
    if (!alongX && z1 - z0 < margin * 2) continue;

    let cx, cz, rot;
    switch (side) {
      case 0: cx = rng.range(x0 + margin, x1 - margin); cz = z1 - standoff; rot = 2; break;
      case 1: cx = x0 + standoff; cz = rng.range(z0 + margin, z1 - margin); rot = 1; break;
      case 2: cx = rng.range(x0 + margin, x1 - margin); cz = z0 + standoff; rot = 0; break;
      default: cx = x1 - standoff; cz = rng.range(z0 + margin, z1 - margin); rot = 3; break;
    }
    if (!tryPlace(sink, 'desk', cx, cz, rot, rng)) continue;

    const out = QUARTER[rot & 3](0, -0.95);
    tryPlace(sink, 'chair', cx + out[0], cz + out[1], (rot + 2) & 3, rng);
    return true;
  }
  return false;
}

function lobby(sink, bounds, rng) {
  edgeProp(sink, bounds, 'plant', rng);
  if (rng.chance(0.7)) edgeProp(sink, bounds, 'sofa', rng);
  if (rng.chance(0.5)) edgeProp(sink, bounds, 'coffeeTable', rng);
  if (rng.chance(0.4)) edgeProp(sink, bounds, 'plant', rng);
}

const ROLES = {
  openplan: openPlan,
  meeting: meetingRoom,
  breakroom: breakRoom,
  storage,
  copyroom: copyRoom,
  server: serverRoom,
  office: privateOffice,
  lobby,
  exit: lobby,
};

// Tries to seat a prop against a random wall, back to the wall, a few times.
//
// Every side uses HALF THE DEPTH as the standoff and HALF THE WIDTH as the
// along-wall margin, with no special case. That is the whole point of backing a
// prop against a wall: its depth always faces the wall, and the quarter-turn
// each side applies is exactly what maps `d` onto the axis perpendicular to it.
// Swapping the two here pushed wide props (counters, meeting tables) up to a
// metre out into the room and shoved narrow ones into the wall.
function edgeProp(sink, bounds, kind, rng) {
  const { x0, z0, x1, z1 } = bounds;
  const spec = PROPS[kind];
  const standoff = spec.d / 2;
  const margin = spec.w / 2;   // so a 3 m table can't hang off the end of the wall

  const alongX = x1 - x0 >= margin * 2;
  const alongZ = z1 - z0 >= margin * 2;

  for (let tries = 0; tries < 12; tries++) {
    const side = rng.int(0, 3);
    // A prop wider than the wall it was offered simply doesn't fit there.
    if ((side === 0 || side === 2) && !alongX) continue;
    if ((side === 1 || side === 3) && !alongZ) continue;

    let cx, cz, rot;
    switch (side) {
      case 0: cx = rng.range(x0 + margin, x1 - margin); cz = z1 - standoff; rot = 2; break;
      case 1: cx = x0 + standoff; cz = rng.range(z0 + margin, z1 - margin); rot = 1; break;
      case 2: cx = rng.range(x0 + margin, x1 - margin); cz = z0 + standoff; rot = 0; break;
      default: cx = x1 - standoff; cz = rng.range(z0 + margin, z1 - margin); rot = 3; break;
    }
    if (tryPlace(sink, kind, cx, cz, rot, rng)) return true;
  }
  return false;
}
