import * as THREE from 'three';
import { BODY_RADIUS as RADIUS } from './nav.js';
import { CORRIDOR, FACING, STAFF_ONLY, FIRST_CONTACT_GAP, worldX, worldZ } from './gen/layout.js';
import { buildRig, buildTray, buildCrate, buildCan, buildPapers } from './rigs.js';
import { TYPES, BYSTANDERS, isMachine, pickType, pickTheme } from './enemy-types.js';
import { DEATH_TIME, HIT_FLASH, SWING_TIME, animate, die, stand } from './enemy-anim.js';
import { angleDelta, angleLerp, smoothTo } from './util.js';
import { makeRng } from './gen/rng.js';
import { EYE } from './metrics.js';

// How far off the ground the player's feet have to be to be on another level of the
// building rather than standing on a desk. A level's floor is LEVEL_Y up or down (see
// gen/stairs.js) and the tallest thing anybody can climb onto down here is a 2.1 m
// locker, so past this you are on another level and nothing else puts you there.
const STOREY_GAP = 2.4;

// --- what crosses the wire in a co-op session --------------------------------
//
// The joiner's roster is not a second simulation, it is the SAME roster: same
// seed, same floor, so the same two hundred people in the same rooms, indexed
// the same way. All the host has to send is where each of them now is, which is
// why the message is a flat run of numbers rather than a list of objects — six
// slots a body, in this order, written by `snapshot` and read by
// `applySnapshot` and by nothing else.
const SNAP_STRIDE = 6;
// Positions go over as hundredths of a metre in whole numbers: a centimetre is
// far below what anybody can see on a walking body, and it keeps every value in
// the packet a short integer.
const SNAP_UNIT = 100;
// The state machine, as an index. Order is the wire format and must not be
// rearranged — `animate` reads the name back off it to decide whether a body is
// walking, and getting that wrong is a floor of people sliding about with still
// legs.
const SNAP_STATES = ['idle', 'alert', 'chase', 'fight', 'wander'];
// The flags that ride in the same slot, above the three bits the state takes.
// A break has to cross because the VISOR is on the other side of it: it is the
// game's one universal tell, and a joiner looking at an employee with its own
// colour on that is not going to shoot back is being lied to. The tray goes with
// it rather than being derived from the break, because a body walks the first
// and last beat of a lunch without one.
const SNAP_SEAT = 8;
const SNAP_BREAK = 16;
const SNAP_TRAY = 32;
// How long somebody keeps the drink they just bought, and it is the whole of the
// can's lifetime — there is no `_lunchEnd` for a can and nothing else would ever
// take it off them. Long enough to walk it back to wherever they were going,
// which is the point of having bought it; not so long that a floor left alone
// for five minutes is a floor where everybody is holding one.
const CAN_TIME = [26, 52];

// A parcel-run crate, for the tray's reason exactly: a body carrying a box is
// doing something visible that it is not doing over there. Unlike the break
// there is no visor in it — everybody on a run is neutral already and wearing
// its own colour — so this is the box and nothing else. See jobs.js.
const SNAP_BOX = 64;
// ...and the can somebody bought out of the vending machine, for the crate's
// reason: it is a visible thing in a body's hand that a joiner has no way to
// derive. The chore that hands it out is host-only and crosses nothing (see
// chores.js), so without this bit one browser has a man walking a corridor with
// a drink and the other has him walking it empty-handed.
const SNAP_CAN = 128;
// ...and the sheaf of paper a routine carries from the printer to the filing
// rack, for the can's reason exactly. It is the one thing on a body that says
// the errand is halfway through rather than starting: a man walking a corridor
// with a bundle of paper has been to the printer, and a joiner that cannot see
// it is watching a different office.
const SNAP_PAPERS = 256;

// How far from either player a body has to be before it is worth sending. Well
// beyond SIGHT, because the joiner can watch somebody walk up a corridor long
// before that body could see them back, and a body that pops into motion at 22 m
// reads as the floor being drawn in front of you.
const SYNC_RANGE = 34;
// Bodies per packet. A deep floor has two hundred people on it and a firefight
// can legitimately have forty of them moving, so the cap is not a limit on how
// many can be synced — `snapshot` walks the roster round-robin, so everything in
// range is covered within a few packets. It is a bound on what one packet costs.
const SNAP_CAP = 48;
// How hard a posed body is pulled toward the position the last packet gave it,
// and how far out of date it has to be before it is moved there outright rather
// than walked there. The snap threshold is what stops a body that has been out
// of range for ten seconds sprinting across the building to catch up.
const POSE_RATE = 14;
const POSE_SNAP = 3;

// The people still working here.
//
// Movement is grid-based (see nav.js): everyone walks downhill on one shared
// distance field flooded from the player, so a whole floor of them routes
// through doorways correctly without per-enemy pathfinding. Combat is
// probabilistic but geometric — a shot's spread is sampled as a real angle and
// converted into a miss distance at the player's range, so backing off actually
// makes you harder to hit instead of just changing a magic number.

const SIGHT = 22;          // metres they can notice you at, with line of sight

// How close two bodies get before they shove each other apart. One constant,
// because the test and the push have to agree: this was written as `d2 > 0.64`
// in one line and `(0.8 - d)` in the next — the same number squared and not —
// and moving either on its own sends the shove negative, which pulls bodies
// together instead of apart.
const SEPARATION = 0.8;
// How far apart two heights have to be before they are different levels. Used by
// anyNear, whose callers are on the floor rather than in the nav grid and so have
// a height rather than a layer number.
const SAME_LEVEL = 1.2;
const SEPARATION_SQ = SEPARATION * SEPARATION;

// Packed cell key for the separation grid. The building is centred on the origin
// and never approaches half a cell-grid across, so the bias keeps both axes
// positive and the key inside the safe-integer range.
const CELL_BIAS = 4096;
const packCell = (cx, cz) => (cx + CELL_BIAS) * 8192 + (cz + CELL_BIAS);
const cellKey = (x, z) =>
  packCell(Math.floor(x / SEPARATION), Math.floor(z / SEPARATION));
// How far gunfire carries — measured *through the building*, not through its
// walls. A straight-line radius was the bug: someone one metre away through
// drywall and a thirty metre walk from the nearest door counted as right next to
// you, so firing anywhere turned the whole floor around at once. Walking the
// distance field instead means noise spreads the way it actually would, down
// corridors and out of doorways, and this can afford to be generous because it
// is now an honest number.
const HEARING = 14;
// Being heard is a real contact, so it holds them as long as you keep shooting.
// Without this an enemy who heard you two rooms away walks toward the noise for
// GIVE_UP seconds, gives up short of arriving, and goes back to work — which
// makes hearing you look broken rather than lethal.
const HEARD_MEMORY = 4;
// One of them calls it out and the rest just come. Every enemy shouting the
// instant it notices you is a chorus, and it was the single loudest thing on the
// floor.
const SHOUT_GAP = 1.8;

// The neutral staff. They pick somewhere to be, walk there, pick again — which
// is what "still going about your day" looks like without a plan, and it keeps
// them moving through doorways rather than pacing one room.
const PANIC_HOP = 30;          // metres they will commit to in one direction
const PANIC_PATIENCE = 6;      // ...and how long before they change their mind
const PANIC_SHOUT = [1.6, 3.4];
const CORRIDOR_SAMPLE = 10;    // keep every Nth corridor tile as a waypoint

// Shoot a neutral and they do not draw a weapon they never had — they bolt.
// Fleeing is the same wander loop with the destination filtered to somewhere
// further from you, so it routes through doorways like everything else; when it
// runs out they go back to whatever they were doing.
const FLEE_TIME = 8;
const FLEE_SPEED = 1.45;
const FLEE_AWAY = 4;           // metres a flee destination must gain on you
// The beat between being seen and being shot at.
//
// Sight is line of sight and nothing else, and `fireCooldown` has been ticking
// down since the floor was generated — so before this, a body that heard a shot
// two rooms ago was standing in `chase` with its cooldown long expired, and the
// frame you crossed its door frame it fired. With its back to you, if that is how
// it happened to be standing. Rounding a corner into three of those is not a fight
// you lost, it is one you were never in.
//
// So a shooter has to HOLD you for `tuning.aim` seconds before its first round,
// and only the time it spends actually pointing at you counts (AIM_CONE) — which
// is what makes the one facing the wrong way the one you get to surprise, since
// turning round is already a real cost (the yaw smoothing in _move).
//
// It DRAINS rather than resets (AIM_DRAIN), which is the rule cameras.js already
// uses and for the same reason: one frame behind the door frame is not a pardon,
// and a player bobbing in and out of a doorway must not be permanently
// un-shootable. The second peek costs them less than the first did.
//
// Melee is exempt. A swing already lands part-way through rather than on the
// wind-up (see SWING_TIME), which is the same courtesy paid in the same coin.
const AIM_CONE = 1.05;     // radians of yaw error they will aim inside (~60°)
const AIM_DRAIN = 0.6;     // seconds of aim lost per second out of sight
// ...and how much credit one body may bank, as a multiple of what it needs. A
// body that has been shooting at you for thirty seconds must not be holding
// thirty seconds of aim, or the drain buys you nothing for the rest of the fight
// and stepping back out of a doorway is instantly fatal for ever after.
const AIM_BANK = 1.6;

const PREFERRED = 7;       // range a shooter tries to hold
const TOO_CLOSE = 3.5;
const GIVE_UP = 7;         // seconds of no contact before they settle down

// How close you can get to somebody at work before they stop working.
//
// The one trigger in this file that is not about noticing, and it is here
// because sight is not enough on its own: a body at a machine has its back to
// the room, and `losClear` samples a grid, so a player who has come through the
// doorway behind them or round the end of a rank of racks can be well inside
// arm's reach and not have been seen. Wide enough to cover the room they are
// standing in the middle of, short enough that walking past the far wall of a
// long office does not set them off. See `_choreWork` and chores.js.
const CHORE_STARTLE = 4.5;

// How far back from a machine a body may be moved to find somewhere it fits, and
// in what steps. See `standable`: about one tile, because the failure this
// recovers from is landing on the wrong side of a tile boundary rather than
// standing too close.
const STAND_NUDGE = 0.5;
const NUDGE_STEP = 0.125;
// What an explosion is worth as a throw, at the seat of it. Above anything a gun
// can do, which is the point of standing next to one. See splash.
const BLAST_PUNCH = 3.5;
// What a round is worth by where it lands. A head is worth more than a chest and
// a chest more than a limb, which is the ordering every shooter has and the one
// the player is already aiming as if it were true.
//
// The ordering is the whole of it and the SPREAD is deliberately tiny — a nudge,
// not a rule. A head worth double turns every gun into a one-shot gun against
// anything that is not armoured, and a limb worth half turns a clean hit at
// twenty metres into a punishment for the 14 cm of arm that happened to be in
// front of the chest. Neither of those is aim, they are luck with a multiplier
// on it. At a tenth either way the head is still the shot worth taking and a
// limb still costs you something, and no single round decides a fight on
// geometry the player could not have controlled.
const HIT_ZONES = { head: 1.12, torso: 1, limb: 0.92 };

// How many of the staff, beyond the guaranteed holders, are carrying a spare
// keycard. Low on purpose: at seventy to two hundred people a floor even this
// leaves a dozen or so on the carpet, and a card you trip over every ten seconds
// is not a key, it is confetti.
const CARD_SPARE_CHANCE = 0.06;

// The prologue. Until the player has a white card the only people they can reach
// are the ones in the corridors, so these two numbers decide how long a floor
// takes to start: how far the first one may be, and how many there are at all.
// See _cardOutside.
const FIRST_CONTACT = 34;      // metres from the lifts
const OUTSIDE_MIN = 5;
// ...but never close enough to be there on arrival. Imported rather than
// written down again: gen/layout.js guarantees there is corridor beyond this
// distance that the player can reach with no card, and a second copy of the
// number here is how that guarantee quietly stopped being about the same thing.
const MIN_SPAWN_GAP = FIRST_CONTACT_GAP;

// How big a shift one room may be dealt.
//
// A room is staffed to the desks it HAS rather than to the flat 0-3 a storeroom draws — an open-plan farm with
// two people in it and ten empty pods is not a half-staffed office, it is a room
// somebody forgot to fill. The cap is what keeps the biggest farm on the floor
// from swallowing the roster, and it wants to stay under the 1-3 a team is (see
// spawn) times a couple, or the rest of the building empties out to fill it.
//
// Note what it does NOT decide any more: where any of them stands. A chair is for
// somebody who is not going to shoot you — the two hand-placed set pieces (see
// _manager and _security) and nobody else — so the shift a room is dealt works
// standing up and the desks in it are left empty. Counting a room's stations is
// still the right way to size that shift: a room with twelve pods in it is where
// the work is whether or not anybody is sitting down at it.
const DESK_TEAM = 5;

// The harmless staff in the hallways when you arrive, and the one place in the
// roster where two numbers next to each other are drawn on purpose differently.
//
// The toilet guy is a flat one or two whatever the floor is. He is a joke —
// announcing his problem at volume while a firefight goes on around him — and a
// joke lands once, maybe twice, and is a running gag by the sixth time you have
// heard it. The rest of them are the building's background traffic, so they scale
// with how much building there is (`layout.areaRatio`, the floor's size against
// the usual one at this depth): six people spread over a slab half again the
// normal size is an empty office, and the same six over a small one is a crowd.
// Same reasoning as the cameras and the roster itself, which both ask that
// question — see PER_FLOOR in cameras.js and tuningFor in game.js.
const HALL_PANICKERS = [1, 2];
const HALL_BYSTANDERS = [4, 6];
// Metres between two of them, so a busier floor does not stand a courier inside
// a cleaner. `this.corridors` is every tenth corridor tile, which is a fine
// sample for picking somewhere to walk to and a coarse one for putting a dozen
// bodies down without collisions.
const NEUTRAL_GAP = 1.4;

// The cleaning staff. Doing rounds in the corridors, plus the two on their
// break in the broom closet. See _janitors.
const JANITORS = [1, 3];
const CLOSET_JANITORS = 2;

// The security staff, on the same shape: the ones walking the halls carry the
// blue card, and the ones in the security office are behind the door it opens.
// See _security. The office is the one room on the floor with a crowd in it —
// the wall of screens is what they are all looking at — which is why the number
// is what it is and why they are not all carrying the same thing.
const OFFICE_GUARDS = [2, 5];
const GUARD_BATON = 0.4;       // how much of the shift drew a baton instead
const GUARD_GAP = 0.8;         // metres between two men in one room

// The canteen's own, in the room the floor arrives in — see _diners. A handful
// rather than a crowd, and that is the whole tuning: a canteen with fifteen
// people in it is a room you have to work out before you can move, and the point
// of these is that you do not have to work them out at all. Two to five at the
// tables and a couple on their feet is a late shift on its break; it also leaves
// most of the seating empty, which is the room reading as somewhere the rest of
// the floor is too busy to be.
const DINERS = [2, 5];
const DINERS_STANDING = [0, 2];

// Lunch, and the shape of a break. See the block above `_sendToLunch`.
//
// LUNCH_MAX is employees away from their post at once, and it is deliberately a
// handful: the point of a break is that you catch somebody at one, and a canteen
// with a queue out of the door is a floor that has stopped being an office. What
// bounds the total in the room is the chairs — `_lunchStart` takes one out of
// the same pool the arrival diners came from and cannot start without it.
const LUNCH_MAX = 4;
const LUNCH_FIRST = 25;        // seconds before the first employee downs tools
const LUNCH_GAP = [14, 34];    // ...and between one and the next
const LUNCH_DARTS = 24;        // tries at finding a willing body — see _sendToLunch
const LUNCH_PACE = 0.85;       // somebody walking to lunch has not noticed you
const LUNCH_ARRIVE = 1.1;      // metres: near enough to a counter or a rack
// ...but NOT near enough to a chair, and that is a different number for a
// reason. A flow field walks to tile centres and a chair is not at one, so the
// walk finishes wherever the last tile put them — measured over 46 seatings,
// EVERY body that walked to lunch sat down 0.98 to 1.09 m from its chair, which
// is a metre of daylight between somebody and the thing they are sitting on.
// The field gets them to the chair and `_settleOnto` takes the last metre in a
// straight line, which is open room floor by construction: the furnisher only
// offers a station a whole body fits in front of (see deskPool).
const SEAT_SNAP = 0.06;
// Any walking stage that takes longer than this is abandoned and the body goes
// back to work where it stands. It is a backstop rather than a timeout anybody
// should reach: a break that quietly never ends is a body that is harmless for
// the rest of the floor and still has to be killed to clear it.
//
// Generous on purpose. Measured on a deep floor, a walk from an office at one
// end of the building to the counter took a Security fifty seconds at lunch
// pace — so a cap that merely looked comfortable was cutting real journeys
// short, and a body that gives up half way to the canteen goes back to work in
// the middle of a corridor for no reason the player can see.
const LUNCH_STAGE_CAP = 100;
const SERVE_TIME = [2.5, 5];   // at the counter, being served
const EAT_TIME = [40, 90];     // at the table
const EAT_FIRST = [70, 150];   // ...and the arrival canteen's longer first sitting
const DROP_TIME = [1.5, 3];    // putting the tray back
// The canteen blue, taken off the type that wears it permanently rather than
// written down twice: what "on a break" looks like is one colour in this
// building, and a second copy of it is a second colour within a week.
const BREAK_VISOR = TYPES.diner.visor;

// A seated pose is drawn relative to furniture, and furniture on this floor can
// be shot apart and shoved about. See _seatGone.
//
// SEAT_DRIFT is how far the chair may wander before the body is no longer on it.
// Generous: a loose prop settles against its neighbours for a second after the
// floor is built and jitters when anything lands near it, and a canteen that
// stands itself up because a chair twitched is a worse bug than the one this
// fixes. A body is 0.4 m across, so half a metre is already past the seat.
const SEAT_DRIFT = 0.5;
// How far in front of the seat the table is, and the band a table top can be in.
// The gap is `seatFacing`'s own — a chair is placed a body's width out from the
// prop's CENTRE, so the probe lands inside the table rather than at its edge —
// and the band is what keeps the scan from matching the wall behind it or the
// floor plate under it.
const TABLE_AHEAD = 0.9;
const TABLE_LOW = 0.35;
const TABLE_HIGH = 1.4;
// ...and the same three for a CHORE station's machine — see `machineAhead`. The
// depths are probed outward from the body in order, because a station stands off
// a wall-backed machine by WORK_REACH and stands along a desk by DESK_ASIDE, and
// no one number lands inside both. The ceiling is under WALL_H so the wall the
// machine is backed against can never be mistaken for the machine.
const MACHINE_AHEAD = [0.55, 0.8, 1.05];
const MACHINE_LOW = 0.3;
const MACHINE_HIGH = 2.6;
// Metres of the arrival point kept to yourself. The seats are outside it anyway
// — no table is furnished into the square kept clear where the player
// materialises — so this is only ever about the ones on their feet, who are
// placed on open floor and would otherwise be free to stand on your head.
const DINER_SPAWN_GAP = 2.5;

// The generator room's crew, in the two halves that are the point of it: the
// ones who will come at you, and the ones who will carry on with their shift
// while you shoot at them. See _generatorRoom.
const GEN_TECHS = [2, 3];
const GEN_WORKERS = [3, 5];

// The response to an alarm (see `alarm` below). Four men come up from the floor
// below — unless the security office on THIS floor is still manned, in which
// case the men in it are the response and only two more are sent. Which makes
// clearing the security office early a real decision rather than loot: it costs
// you the two easy kills you would rather not have made, and it doubles what
// turns up the first time a camera gets six seconds of you.
const RESPONSE = 4;
const RESPONSE_HELD = 2;
// How far away they come in, measured on the distance field — a walked distance,
// not a straight line, so "far" never means "one metre away through the wall".
const RESPONSE_MIN = 16;
const RESPONSE_MAX = 60;
// The response was sent, and it has no desk to go back to. GIVE_UP is a clerk
// who heard a bang two rooms away and is entitled to decide he imagined it;
// these men were told over the radio, and a response that turns round after
// seven seconds and stands in a corridor is not one.
const RESPONSE_PATIENCE = 30;
// How far the klaxon carries to everybody else, walked rather than straight-line
// — the same measure as gunfire (see HEARING) and for the same reason, so a man
// sealed in a badged room hears nothing at all. Further than a gunshot, because
// this is the building shouting rather than one weapon going off in a room.
const ALARM_HEARING = 30;

export class Enemies {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.meshes = [];       // what bullets test against
    this.shoutTimer = 0;    // floor-wide, so only one of them calls you out
    this.keyedAlive = 0;    // badge holders still on their feet — see _keyed
    this.onDeath = null;    // set by game.js — see _damage
    this.ragdolls = null;   // likewise; what happens to a body after _damage

    // --- co-op, all four unused in a single-player run --------------------
    // Whether this end of the wire is allowed to decide that somebody is hurt.
    // The host is; the joiner reports its shots instead and waits to be told,
    // because two browsers each deciding when a man dies is two different men.
    this.authority = true;
    // Whether this roster is posed from the host's snapshots rather than thought
    // for. Set on the joiner; see `update` and `_poseAll`.
    this.puppet = false;
    // (enemy, muzzle, aim) — somebody fired, so the other end can draw it.
    this.onFire = null;
    // (enemy, damage, hit) — a shot landed and we are NOT the authority, so it
    // goes on the wire instead of into anybody's health.
    this.onReport = null;
    // (enemy, outcome, hit) — we ARE the authority and have just decided that
    // somebody is hurt or dead, so the other end has to be told. Deliberately
    // fired from `_damage` and not from `_die`: `_die` is also how the joiner
    // applies a death it was TOLD about, and announcing that back would be a
    // death bouncing between two browsers for ever.
    this.onDamaged = null;
    // A body on a parcel run is walked by jobs.js rather than by `_wander`, and
    // has to be told when the run is off. Both are set by jobs.js if it is
    // wired at all — with neither, nothing in this file starts a run and none of
    // this costs a branch that matters.
    this.jobTick = null;    // one frame of somebody's run
    this.jobLost = null;    // ...and the run is over, however it ended
    // The same seam a second time, for the ordinary work: a body with `e.chore`
    // on it is walked by chores.js. Two pairs of hooks rather than one, because
    // a slot has one occupant and a second consumer of a single-slot callback is
    // how one of them quietly stops being called — the note `washers.js` makes
    // about `onBreakProp`. See chores.js.
    this.choreTick = null;
    this.choreLost = null;
    // Where `snapshot` got to last time, so the roster is covered round-robin
    // rather than the first SNAP_CAP bodies being the only ones ever sent.
    this._snapCursor = 0;
    this._v = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    // Cell -> the living bodies in it, rebuilt each frame. See _rebuildNeighbours.
    this._cells = new Map();
    // Room -> the desks in it nobody has been sat at yet. Refilled per floor by
    // `spawn`, emptied as the roster is placed. See deskPool and _takeDesk.
    this.desks = new Map();
    // ...and every other kind of place the furnisher said somebody could work,
    // by station name. Shared rather than dealt out — a printer is somewhere a
    // body stands for twenty seconds. See spawn, and chores.js.
    this.stations = new Map();
  }

  // What the floor objective counts. The neutrals are alive and on the floor and
  // are deliberately not in this number — clearing a floor means clearing the
  // people shooting at you, not hunting down a cleaner.
  get hostileCount() {
    let n = 0;
    for (const e of this.items) if (e.alive && !e.neutral) n++;
    return n;
  }

  /**
   * Hostiles you can get to without opening anything you have not got the card
   * for. Everyone on the floor except the manager, sitting behind his own door.
   *
   * This is what decides when the black card drops: the moment this reaches zero
   * the player has killed everyone they are able to, and the card has to be on
   * the carpet or the floor cannot be finished. See game.js.
   */
  get openHostileCount() {
    let n = 0;
    for (const e of this.items) if (e.alive && !e.neutral && !e.behindLock) n++;
    return n;
  }

  /**
   * The floor's colliders: the building with its fitted furniture, and the loose
   * props that move. Handed over by game.js before `spawn`, and held for one
   * question only — is the thing somebody is sitting on still there.
   *
   * Both are the SAME arrays the player collides against rather than copies, so
   * they stay live: a prop that is shot apart retires its own entry by setting
   * `top = -1` (`_breakProp` in destruction.js, and the same for a static in
   * `_shatter`), and a loose prop that is shoved moves its own bounds. Those are
   * exactly the two things a seated body needs to notice, and neither of them is
   * an event anybody sends.
   */
  setColliders(statics, loose) {
    this.colliders = statics ?? [];
    this.loose = loose ?? [];
  }

  /**
   * Populates a floor. `tuning` scales with depth — see game.js.
   *
   * The shift is handed in rather than drawn here, and that is not tidiness: it
   * decides what is fitted to the BUILDING as well as who is standing in it
   * (see `conveyors` on THEMES), so it has to be known before the floor's
   * colliders go to the solver — which is well before this runs. It is still
   * the first draw off the floor's rng, exactly where it was, so nothing after
   * it moved. Left off, it is drawn here as before.
   */
  spawn(layout, nav, rng, tuning, workstations = [], theme = null) {
    this.clear();
    this.nav = nav;
    this.tuning = tuning;
    // Held for the things that happen to a floor after it has been populated —
    // the alarm response, which needs the roster's own dice and the floor's own
    // locks to decide who turns up carrying what.
    this.layout = layout;
    this.rng = rng;
    this.shoutTimer = 0;
    this.theme = theme ?? pickTheme(layout.floorNumber, rng);
    this.corridors = collectCorridors(layout, nav);
    this.desks = deskPool(workstations, nav, rng, 'desk');
    // The canteen's chairs, pooled apart from the desks because they are not
    // jobs: see `at` on sink.workstation in gen/build.js.
    this.tables = deskPool(workstations, nav, rng, 'table');
    // Where you queue and where the trays go back, both registered by the
    // furnisher because it is the only thing that knows where the counter
    // actually landed (see `cafeteria` in gen/rooms.js). Unlike a chair these
    // are shared and never taken out of the pool: a serving hatch is somewhere
    // you stand for four seconds, not somewhere you sit for a minute.
    this.servery = deskPool(workstations, nav, rng, 'servery').get(layout.cafeteriaRoom) ?? [];
    // Every OTHER kind of station the furnisher published, pooled by what it is
    // a place to work at and flattened the same way — a printer is a printer
    // whosever office it is in, so unlike a chair it does not matter which room
    // it came out of. Built generically rather than one line per kind, so this
    // file does not have to learn the vocabulary of the module that reads them:
    // `chores.js` asks for what it wants by name and gets nothing if the floor
    // has none.
    this.stations = new Map();
    for (const at of new Set(workstations.map((w) => w.at))) {
      this.stations.set(at,
        [...deskPool(workstations, nav, rng, at, STAND_NUDGE).values()].flat());
    }
    // Where a box comes off a rack, for the parcel runs (see jobs.js). Flattened
    // out of the by-room map, because unlike a chair or a serving hatch it does
    // not matter WHOSE storeroom it is — a run wants any rack anybody can walk
    // to. Shared and never taken out of the pool, like the servery: it is
    // somewhere a machine stands for two seconds, and one of the pools above
    // rather than a pool of its own because it is the same question.
    this.shelves = this.stations.get('shelf') ?? [];
    // ...and where they go back. Falling back to the counter itself is not a
    // fudge: a rack that a body cannot stand at is dropped like any other
    // station, and handing your tray back across the counter you took it from is
    // what you would do in a canteen that has no rack. What it buys is that the
    // cycle can always be finished — a break with nowhere to put the tray down
    // is a body stuck holding it for the rest of the floor.
    this.trayRack = (deskPool(workstations, nav, rng, 'trays').get(layout.cafeteriaRoom) ?? [])[0]
      ?? this.servery[0] ?? null;
    this.lunchTimer = LUNCH_FIRST;

    const spots = this._spawnPoints(layout, nav, rng, tuning.count);
    // A room holds a team, not a headcount. Whoever is in a room is in it
    // together — same type, working the same job — because a room of one intern,
    // one manager and one sentry is a spawn list, and a room of three interns is
    // a room. Some rooms get nobody, which is what makes the occupied ones feel
    // deliberate rather than sprinkled.
    let team = null;
    let left = 0;
    for (const spot of spots) {
      if (left <= 0 || spot.room !== team?.room) {
        team = { room: spot.room, type: pickType(layout.floorNumber, rng, this.theme) };
        left = rng.chance(0.45) ? 1 : (rng.chance(0.72) ? 2 : 3);
      }
      left--;
      // On their feet, wherever they were put down. Nobody who is going to fight
      // you is found sitting in a chair — a seated body on this floor means a
      // harmless one, and the only exceptions are the two placed by hand, which
      // are worth it: the Manager at his own desk and one guard on the cameras.
      this._add(spot.x, spot.z, rng, tuning, team.type);
    }

    this._security(layout, nav, rng, tuning);

    // A handful of neutrals on every floor, placed rather than rolled: they are
    // a fixture of the building, not a difficulty ingredient, and leaving them
    // to the weighted draw would mean floors without any. They all start in a
    // corridor because that is where the point of them is — you are supposed to
    // see one cross the end of a hallway and have to decide, quickly, whether it
    // mattered.
    const neutrals = [];
    for (let i = rng.int(HALL_PANICKERS[0], HALL_PANICKERS[1]); i > 0; i--) {
      neutrals.push(TYPES.panicker);
    }
    // Scaled by the size of the slab rather than fixed — see HALL_BYSTANDERS.
    // Rounded, and never to nothing: a floor with no harmless staff on it at all
    // is a floor where every silhouette down a corridor is a target, which is the
    // decision these exist to make you keep having to take.
    const crowd = Math.max(1, Math.round(
      rng.int(HALL_BYSTANDERS[0], HALL_BYSTANDERS[1]) * (layout.areaRatio ?? 1)));
    // Who that crowd IS is the theme's, because the background traffic is a fact
    // about the building rather than about the roster: a floor run by machines
    // has its deliveries done by one, and a night cleaner walking a corridor of
    // Loader Units is somebody who did not get the memo. Named by key and
    // resolved here so a theme stays pure data.
    const kinds = this.theme.bystanders?.map((k) => TYPES[k]).filter(Boolean);
    const bystanders = kinds?.length ? kinds : BYSTANDERS;
    // ONE OF EACH FIRST, and the rest of the crowd rolled.
    //
    // This is the same "set a floor of one" the security office and the broom
    // closet both make, and it is here for the same kind of reason rather than
    // for tidiness. A theme that names its own traffic is saying these are the
    // people in its halls — so a floor that happens to roll none of one of them
    // has quietly lost half of what the theme said, and on an Automated floor it
    // loses a feature outright: a parcel run needs a Maintenance Worker to take
    // the box at the belt, and with `rng.pick` alone a crowd of three or four
    // draws zero workers often enough to matter. Found by trying to watch one —
    // 3 porters, 0 workers, and jobs.js correctly refusing to cast a run it
    // could not finish, which is silent by design and so says nothing.
    //
    // Capped at the crowd, so a small floor still gets a small crowd rather than
    // one of everything on top of it.
    for (let i = 0; i < Math.min(crowd, bystanders.length); i++) neutrals.push(bystanders[i]);
    for (let i = crowd - bystanders.length; i > 0; i--) neutrals.push(rng.pick(bystanders));

    for (let i = 0; i < neutrals.length; i++) {
      // A few tries at somewhere nobody is already standing, and the last pick
      // regardless if the floor is too busy to find one: a body a metre inside
      // another body is bad, and a floor quietly one courier short of what it
      // rolled is worse — nothing downstream would ever say so.
      let spot = null;
      for (let tries = 0; tries < 8; tries++) {
        spot = this.corridors.length ? rng.pick(this.corridors) : spots[i];
        if (!spot) break;
        if (!this.items.some((e) => Math.hypot(e.x - spot.x, e.z - spot.z) < NEUTRAL_GAP)) break;
      }
      if (spot) this._add(spot.x, spot.z, rng, tuning, neutrals[i]);
    }

    // And the rats, which go anywhere rather than starting in a corridor: the
    // point of the staff is that you see them cross a hallway and have to
    // decide, and the point of a rat is that it is already in the room with you.
    const [ratMin, ratMax] = this.theme.rats ?? [1, 1];
    for (const spot of this._loose(layout, nav, rng, rng.int(ratMin, ratMax))) {
      this._add(spot.x, spot.z, rng, tuning, TYPES.rat);
    }

    // And the floor cleaners. One is the joke — an office with a robot vacuum
    // in it, bumping off a skirting board while a firefight goes on over its
    // head. A theme may ask for a fleet instead (`cleaners` on THEMES), which
    // is the same joke told about the building rather than about one machine:
    // on a floor run by machines the cleaning is done by machines too, and
    // several of them crossing a corridor is what says so before you have met
    // anything that shoots. They are neutral and `offMap`, so a fleet costs
    // the floor no difficulty and the minimap no clutter.
    const [cleanMin, cleanMax] = this.theme.cleaners ?? [1, 1];
    for (const spot of this._loose(layout, nav, rng, rng.int(cleanMin, cleanMax))) {
      this._add(spot.x, spot.z, rng, tuning, TYPES.roomba);
    }

    this._cardOutside(layout, nav, rng, tuning);
    this._diners(layout, nav, rng, tuning);
    this._janitors(layout, nav, rng, tuning);
    this._manager(layout, nav, rng, tuning);
    this._generatorRoom(layout, nav, rng, tuning);
    this._dealCards(layout, rng);
  }

  /**
   * Security: the shift walking the halls, and the ones sat in their own office.
   *
   * Same shape as the janitors and the broom closet one tier along, and for the
   * same reason. The blue card comes off security and off nobody else, so where
   * they stand is a correctness question: the ones on rounds are in the
   * corridors, outside every lock, which is what guarantees the card is
   * reachable with nothing in your pocket. The two-to-five in the security
   * office are marked `behindLock` and dealt nothing, because men sitting in the
   * room their own key opens, holding that key, is the failure the whole system
   * exists to prevent.
   *
   * The one place it differs is that a patrol is not just a card holder. Every
   * other hostile is found where they work, which makes a floor a series of
   * rooms you clear; a patrol is the one thing that comes to YOU, down a hallway
   * you have already been down. That is what `patrols` on a theme tunes — except
   * that a theme is allowed to say nobody is doing rounds tonight, and a floor
   * with a security office and nobody outside it is a door with no key. So the
   * theme sets the number and the office sets the floor under it.
   */
  _security(layout, nav, rng, tuning) {
    const office = layout.locks?.find((l) => l.tier === 'blue');

    // Corridors outside every lock, preferring the ones that are not on top of
    // the lifts — being close to where the player arrives is fine, standing on
    // it is not.
    const free = this.corridors.filter((s) => !this._behindALock(layout, s.x, s.z));
    const away = free.filter((s) =>
      Math.hypot(s.x - layout.spawn.x, s.z - layout.spawn.z) > MIN_SPAWN_GAP);
    const halls = away.length ? away : free;

    const [patMin, patMax] = this.theme.patrols ?? [1, 3];
    const wanted = Math.max(rng.int(patMin, patMax), office ? 1 : 0);

    let onRounds = 0;
    for (let i = wanted; i > 0 && halls.length; i--) {
      const spot = rng.pick(halls);
      this._add(spot.x, spot.z, rng, tuning, this._guardType(rng));
      onRounds++;
    }

    // And the office. Only if somebody outside is carrying the key to it: these
    // count toward clearing the floor, so posting them behind a door with no
    // reachable blue card anywhere is a floor that cannot be finished.
    if (!office || !onRounds) return;

    const room = office.room;
    let posted = 0;
    const want = rng.int(OFFICE_GUARDS[0], OFFICE_GUARDS[1]);

    // One of them is on the cameras, which is the only reason this room is here.
    // The camera desk goes in first and unconditionally when the room is
    // furnished (securityOffice in gen/rooms.js), so the chair in front of the
    // wall of screens is the one desk on the floor that is certain to exist —
    // and a bank of monitors with nobody watching it is a worse room than one
    // with five men standing around in it.
    const cams = this._takeDesk(room, (x, z) => nav.clear(x, z, RADIUS));
    if (cams) {
      const watcher = this._add(cams.x, cams.z, rng, tuning, this._guardType(rng));
      watcher.behindLock = true;
      this._seat(watcher, cams);
      posted++;
    }

    for (let tries = 0; tries < 120 && posted < want; tries++) {
      const tx = rng.int(room.x0, room.x1 - 1);
      const ty = rng.int(room.y0, room.y1 - 1);
      if (!nav.walkable(tx, ty)) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;
      // Five men in one small room will otherwise be dealt the same two tiles.
      if (this.items.some((e) => Math.hypot(e.x - x, e.z - z) < GUARD_GAP)) continue;

      const e = this._add(x, z, rng, tuning, this._guardType(rng));
      e.behindLock = true;
      posted++;
    }
  }

  /**
   * A camera got six seconds of you, or you walked through a laser. Security
   * responds.
   *
   * Three things happen, and which of the first two dominates is decided by
   * something the player did ten minutes ago:
   *
   *  - **The office comes out.** Anybody still sitting in the security office
   *    unlocks their own door and leaves through it. This is the one place in
   *    the game where the lock rule is bypassed, and it is bypassed for exactly
   *    these men: they are `keyed` from here on, which means a badge at the
   *    door's sensor (doors.js) and a second distance field at the nav grid
   *    (nav.setBadgeTiles). The keyring is the shift's real one — white and blue
   *    — so the broom closet, the back-of-house rooms and the manager's office
   *    are as shut to them as they were before, and nothing about when the black
   *    card drops moves. Clearing the office early stops all of this happening,
   *    which is what makes clearing it early a trade.
   *  - **The rest are sent up.** Four of them, in the corridors, out of sight,
   *    at a walked distance rather than a straight-line one — nobody appears in
   *    a doorway you were looking at. If the office is still manned it is only
   *    two, because the men in it are already part of the answer. Same badge:
   *    they are the same shift, and a response that stops at the first white
   *    door between it and you is not one.
   *  - **And the floor hears it.** Everybody idle with a route to you starts
   *    walking it. They are NOT keyed — they are staff who heard a klaxon, not
   *    men who were sent — so they come the way the building lets them and a
   *    locked door ends the walk. `pathDistance` is what says so, coming back -1
   *    across a lock, which is the same rule that already governs hearing a gun.
   *
   * The first two arrive angry, which here means `chase` with your last position
   * already in hand: an alarm response that has to find you by walking into your
   * line of sight is not a response, it is more staff.
   *
   * Returns what happened, because the toast that says so belongs to game.js —
   * and the meshes, because bullets have to be told about anybody who was not on
   * the floor when it was generated.
   */
  alarm(px, pz) {
    if (!this.nav || !this.rng) return { spawned: [], meshes: [], roused: 0, heard: 0 };

    // The office. Guards specifically: the janitors on their break are behind a
    // door too and an alarm is not their problem.
    const held = this.items.filter((e) => e.alive && e.behindLock && e.type.guard);
    for (const e of held) {
      this._keyed(e);
      // They are not men behind a lock any more, and that is not bookkeeping:
      // `behindLock` is what keeps somebody out of openHostileCount, and the
      // black card drops when that reaches zero. Leave it set and a floor could
      // hand you the last card while four guards are still walking at you.
      e.behindLock = false;
      this._rouse(e, px, pz);
    }

    const wanted = held.length ? RESPONSE_HELD : RESPONSE;
    const spawned = [];
    const meshes = [];
    for (const spot of this._responseSpots(px, pz, wanted)) {
      const baton = this.rng.chance(GUARD_BATON);
      // A seed of this body's own, drawn from the floor's stream so the host's
      // dice roll on exactly as they did before. It exists so a co-op joiner can
      // build the SAME man: these four are not in the seeded roster — they were
      // sent up after the floor was generated — so the only way both browsers
      // get one person rather than two is to share what he was rolled from.
      const seed = this.rng.int(0, 0x7fffffff);
      const type = baton ? TYPES.guardBaton : TYPES.security;
      const e = this._add(spot.x, spot.z, makeRng(seed), this.tuning, type);
      // Security carries blue and nobody else does, and that stays true for the
      // ones who arrive late — otherwise an alarm on a floor whose only blue
      // holder you already shot would be four men carrying the wrong card.
      e.card = this.layout?.locks?.some((l) => l.tier === 'blue') ? 'blue' : 'white';
      this._keyed(e);
      this._rouse(e, px, pz);
      // What the other end needs to build him. Held on the body rather than
      // returned separately so it cannot get out of step with who was spawned.
      e.netSpawn = { x: spot.x, z: spot.z, baton, seed, card: e.card };
      spawned.push(e);
      meshes.push(...e.hitboxes);
    }

    // And everybody else on the floor with ears. Only the idle ones: anybody
    // already coming for you does not need telling twice, and a klaxon is not a
    // reason for a man in a firefight to go and look somewhere else.
    let heard = 0;
    for (const e of this.items) {
      if (!e.alive || e.neutral || e.state !== 'idle') continue;
      const along = this.nav.pathDistance(e.x, e.z, e.layer);
      if (along < 0 || along > ALARM_HEARING) continue;
      // Same shape as noticing a gunshot, deliberately: told roughly where, and
      // taking the same moment to decide anything about it. Clearing `contact`
      // is what makes it stick — it is seconds since the last contact, and
      // somebody who has been sitting in an office all floor is well past
      // GIVE_UP, so without this they would drop back to idle on arrival.
      e.state = 'alert';
      e.timer = this.tuning.reaction;
      e.contact = 0;
      e.lastSeen = { x: px, z: pz };
      heard++;
    }

    return { spawned, meshes, roused: held.length, heard };
  }

  // Somebody who now knows exactly where you are. Not `alert` — that is the
  // reaction delay of a man looking up from a desk, and this one was told.
  _rouse(e, px, pz) {
    if (!e.alive || e.neutral) return;
    e.state = 'chase';
    e.timer = 0;
    e.contact = 0;
    e.lastSeen = { x: px, z: pz };
  }

  // Somebody a locked door does not stop. One flag, read in the two places that
  // have to agree about it — the door's sensor, and the route into that door —
  // and counted once a frame in _rebuildNeighbours, because the second distance
  // field is only worth flooding while one of them is alive to walk it.
  _keyed(e) { e.keyed = true; }

  /**
   * Where the response comes in. Corridors, because that is what a floor's
   * circulation is and because it is the one part of it no card shuts them out
   * of; far enough away to be a response rather than an ambush; and never
   * anywhere you can see, because a man fading in at the end of a hallway you
   * are looking down is the one thing that would make the whole system read as
   * cheating.
   *
   * Each of those is dropped in turn if the floor cannot satisfy it. A response
   * that arrives closer than it should is a worse alarm; a response that never
   * arrives is a broken one.
   */
  _responseSpots(px, pz, want) {
    const out = [];
    // Three passes over the same pool: the full test, then without the sight
    // test, then with only "is there a route to the player at all".
    for (let pass = 0; pass < 3 && out.length < want; pass++) {
      for (const s of this.rng.shuffle([...this.corridors])) {
        if (out.length >= want) break;
        if (this._behindALock(this.layout, s.x, s.z)) continue;
        if (!this.nav.clear(s.x, s.z, RADIUS)) continue;
        if (out.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < 1.6)) continue;

        // Negative means no route from here to the player at all, which is the
        // one condition no pass may drop.
        const along = this.nav.pathDistance(s.x, s.z);
        if (along < 0) continue;
        if (pass < 2 && (along < RESPONSE_MIN || along > RESPONSE_MAX)) continue;
        if (pass < 1 && this.nav.losClear(s.x, s.z, px, pz)) continue;

        out.push(s);
      }
    }
    return out;
  }

  // Which half of the shift this one is. A room of guards is meant to come at
  // you as a room rather than as a firing line: whoever drew a baton is the one
  // closing the distance while the rest of them shoot over him.
  _guardType(rng) {
    return rng.chance(GUARD_BATON) ? TYPES.guardBaton : TYPES.security;
  }

  /**
   * The cleaning staff: a few doing rounds, and the two in the cupboard.
   *
   * They are the only source of the yellow card, so where they stand is a
   * correctness question rather than a flavour one. The ones on rounds go in the
   * corridors — outside every lock, which is what guarantees the card is
   * reachable with nothing in your pocket — and the two in the broom closet are
   * marked `behindLock` so they are not dealt one. Two men standing in the room
   * their own key opens, holding that key, is the exact failure the whole
   * keycard system is built to avoid.
   *
   * So the closet is the same shape as the manager's office one tier down: you
   * take the card off somebody in a hallway, and it buys you a door with two
   * more of them behind it who did not hear you coming.
   *
   * They used to be found sitting on the floor of it, on their break, and that is
   * gone for one reason: they are hostile, they carry a mop that hits harder than
   * most things on the floor, and they count toward clearing it — so a body
   * sitting down was the one tell in the building that meant "harmless" and also
   * meant nothing. Everything that sits now is something you can walk past.
   */
  _janitors(layout, nav, rng, tuning) {
    // On rounds. Corridors, because a mop is used in corridors and because that
    // is the one place on the floor no card can shut you out of.
    const free = this.corridors.filter((s) => !this._behindALock(layout, s.x, s.z));
    const away = free.filter((s) =>
      Math.hypot(s.x - layout.spawn.x, s.z - layout.spawn.z) > MIN_SPAWN_GAP);
    // Standing on the lift lobby is worse than being close to it, so the
    // distance filter is a preference rather than a requirement.
    const spots = away.length ? away : free;

    let onRounds = 0;
    for (let i = rng.int(JANITORS[0], JANITORS[1]); i > 0 && spots.length; i--) {
      const spot = rng.pick(spots);
      this._add(spot.x, spot.z, rng, tuning, TYPES.janitor);
      onRounds++;
    }

    // And the two on their break, sitting it out behind their own door.
    //
    // They only exist if somebody outside is carrying the key to it. The two of
    // them count toward clearing the floor, so seating them behind a door with
    // no reachable yellow card anywhere would be a floor that cannot be
    // finished — the one bug this whole system is arranged to make impossible.
    const closet = layout.locks?.find((l) => l.tier === 'yellow');
    if (!closet || !onRounds) return;

    const room = closet.room;
    const placed = [];
    for (let tries = 0; tries < 60 && placed.length < CLOSET_JANITORS; tries++) {
      const tx = rng.int(room.x0, room.x1 - 1);
      const ty = rng.int(room.y0, room.y1 - 1);
      if (!nav.walkable(tx, ty)) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;
      // Spaced like the men in the security office, and for the same reason: a
      // broom closet is a small room and two tries can otherwise land on tiles a
      // shoulder apart.
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < GUARD_GAP)) continue;

      const e = this._add(x, z, rng, tuning, TYPES.janitor);
      e.behindLock = true;
      placed.push({ x, z });
    }
  }

  /**
   * The manager, in the manager's office, behind the manager's door.
   *
   * He is the only person on the floor who works behind a real lock, and he is
   * the reason the black card is worth having: every other badged room is loot
   * you can walk past, and this one is the last thing between you and the lift.
   *
   * That inverts the usual rule — the black room IS on the critical path, where
   * grey, blue and yellow never are — and it only works because of when his card
   * arrives. The black card comes off the last hostile OUTSIDE this room (see
   * game.js), so by the time he is the only one left you are already holding the
   * key to his door. There is no order of events in which the floor locks up.
   *
   * He is a Manager whatever floor this is, `unlockFloor` notwithstanding. A
   * manager's office with an intern in it is a joke that only works once, and
   * the room is announced by a black keycard — it has to be worth the walk back.
   */
  _manager(layout, nav, rng, tuning) {
    const lock = layout.locks?.find((l) => l.tier === 'black');
    if (!lock) return;

    const room = lock.room;
    // At his desk, which is the one in this building that faces a wall with a
    // bookcase behind it (see managerOffice in gen/rooms.js). No distance rule
    // on it: his office is wherever the black lock landed, and the man works
    // where he works. Nobody else can have taken it — the room is staff-only, so
    // `_spawnPoints` never staffed it.
    const desk = this._takeDesk(room, (x, z) => nav.clear(x, z, RADIUS));
    if (desk) {
      const boss = this._add(desk.x, desk.z, rng, tuning, TYPES.manager);
      boss.behindLock = true;
      this._seat(boss, desk);
      return;
    }

    for (let tries = 0; tries < 40; tries++) {
      const tx = rng.int(room.x0, room.x1 - 1);
      const ty = rng.int(room.y0, room.y1 - 1);
      if (!nav.walkable(tx, ty)) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;

      const boss = this._add(x, z, rng, tuning, TYPES.manager);
      // What keeps him out of openHostileCount, and out of _dealCards — a card
      // in his pocket is a card behind his own door.
      boss.behindLock = true;
      return;
    }
  }

  /**
   * The generator room's crew (see the `generator` role in gen/rooms.js) —
   * opportunistic, like the room itself: a floor that didn't roll a room big
   * enough for one has nothing to place here. A handful of them, spaced the same
   * way the security office spaces its guards: 2-3 hostile technicians and 3-5
   * workers doing nothing about you — same shape as the neutral bystanders
   * elsewhere, just local to this one room instead of wandering the floor. Both
   * types are `weight: 0` (see enemy-types.js): the mix belongs here and nowhere
   * else, so a weighted roll must never produce it.
   *
   * It is a CREW and not a crowd, and the numbers are small deliberately. A dozen
   * bodies in here made the plant room the biggest fight on the floor, which is a
   * second security office by accident — the room is meant to be about the machine
   * at the end of it, and about whether you are willing to shoot the thing that
   * keeps the lights on. Five to eight people is a shift working late; fifteen is
   * an ambush that happens to have a generator in it.
   */
  _generatorRoom(layout, nav, rng, tuning) {
    const room = layout.rooms.find((r) => r.role === 'generator');
    if (!room) return;

    const techs = rng.int(GEN_TECHS[0], GEN_TECHS[1]);
    const want = techs + rng.int(GEN_WORKERS[0], GEN_WORKERS[1]);
    const spots = [];
    for (let tries = 0; tries < 300 && spots.length < want; tries++) {
      const tx = rng.int(room.x0, room.x1 - 1);
      const ty = rng.int(room.y0, room.y1 - 1);
      if (!nav.walkable(tx, ty)) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;
      // The generator and its clutter already took a chunk of this room; the
      // spacing check is what stops the tries that are left crowding onto the
      // same free tile instead of spreading through the rest of it.
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < GUARD_GAP)) continue;
      spots.push({ x, z });
    }

    // Whatever the spacing check could not find room for comes off the workers
    // rather than off the technicians: the hostile half is what makes the room a
    // fight at all, and a tight room that only fitted four people should still be
    // the plant room rather than four men ignoring you.
    const angry = Math.min(techs, spots.length);
    for (let i = 0; i < spots.length; i++) {
      this._add(spots[i].x, spots[i].z, rng, tuning, i < angry ? TYPES.technician : TYPES.worker);
    }
  }

  /**
   * The staff already on their break when the floor is generated.
   *
   * They are the beat the whole lunch cycle opens on: a canteen with people
   * eating in it rather than an empty room with a counter, so the first person
   * to walk down for lunch is joining something rather than starting it. All of
   * them are harmless, none counts toward clearing the floor, and walking past
   * the lot of them costs nothing.
   *
   * The canteen is no longer the room the floor arrives in — that is the
   * reception outside the lifts now (see pickSpawnRoom in gen/layout.js) — so
   * this is a room the player FINDS rather than one they are put down in, and
   * the diners are no longer the only people in it: `_spawnPoints` skips the
   * arrival room and nothing else, so the canteen is staffed like any other
   * room. That is the right way round. A canteen you walk into is a room with
   * its own staff in it and four people at their lunch among them; the version
   * where it was the arrival needed everybody in it to be harmless because the
   * player was standing in the middle of it holding nothing.
   */
  _diners(layout, nav, rng, tuning) {
    const room = layout.cafeteriaRoom;
    if (!room) return;

    // Seated first, and only into a chair a whole body fits in front of — the
    // pool has already dropped the ones nav cannot stand anybody at (see
    // deskPool). Taking a seat REMOVES it, so two people can never be dealt the
    // same chair, which would be one body inside another eating the same lunch.
    for (let i = rng.int(DINERS[0], DINERS[1]); i > 0; i--) {
      const seat = this._takeDesk(room, (x, z) => nav.clear(x, z, RADIUS), this.tables);
      if (!seat) break;
      const diner = this._add(seat.x, seat.z, rng, tuning, TYPES.diner);
      this._seat(diner, seat, 'table');
      // Half way through the cycle rather than at the start of it: they are
      // already eating when the floor opens, because that is the picture the
      // arrival is for. Everything after this beat is the same cycle any
      // employee who comes down for lunch later will walk. See _lunch.
      this._lunchSeated(diner, seat, rng);
    }

    // And a couple on their feet: at the counter, in a gangway, wherever the room
    // has floor left. A canteen where every single person is seated in a row
    // reads as a waiting room — and somebody standing is also what makes the
    // seated ones read as people who chose to sit rather than as furniture with
    // heads on.
    for (let i = rng.int(DINERS_STANDING[0], DINERS_STANDING[1]); i > 0; i--) {
      let spot = null;
      for (let tries = 0; tries < 60 && !spot; tries++) {
        const tx = rng.int(room.x0, room.x1 - 1);
        const ty = rng.int(room.y0, room.y1 - 1);
        if (!nav.walkable(tx, ty)) continue;
        const x = nav.wx(tx), z = nav.wz(ty);
        if (!nav.clear(x, z, RADIUS)) continue;
        // Off the arrival point, and off each other. The seats need neither —
        // no table is furnished into the square kept clear where the player
        // materialises, and a chair can only be dealt once.
        if (Math.hypot(x - layout.spawn.x, z - layout.spawn.z) < DINER_SPAWN_GAP) continue;
        if (this.items.some((e) => Math.hypot(e.x - x, e.z - z) < NEUTRAL_GAP)) continue;
        spot = { x, z };
      }
      if (!spot) break;
      this._add(spot.x, spot.z, rng, tuning, TYPES.diner);
    }
  }

  /**
   * The people with a badge who are standing where no badge is needed to reach
   * them.
   *
   * This is the load-bearing guarantee of the whole keycard system, and it falls
   * out of one decision: white is on every door. Every employee is carrying a
   * white card and nearly every employee is behind a white door, so until you
   * have taken one off somebody the floor is a corridor network with two hundred
   * shut rooms off it. Nobody comes out to meet you either — a badged door is
   * shut to the staff as well, at the nav grid.
   *
   * So the opening of a floor is a short prologue, and this decides how short.
   * One hostile in a corridor would technically satisfy the invariant and would
   * make every floor start with a five-minute walk looking for one man. A
   * handful, with at least one close enough to walk into, makes it thirty
   * seconds: find somebody, take the badge, and the building comes on.
   *
   * Security patrols usually cover this already — they are in the corridors by
   * construction — but there may be as few as one of them, and on a floor with
   * no security office to guard there may be none at all. So the top-up is
   * whatever is working this floor rather than more security. On an Infestation
   * that is something shambling down a hallway, which is what an Infestation
   * looks like anyway.
   */
  _cardOutside(layout, nav, rng, tuning) {
    // "Outside a lock" is not enough on its own any more: the corridors have
    // readers on them too, so a corridor can be outside every ROOM lock and
    // still be on the far side of a hall door the player has no badge for.
    // `layout.prologue` is what they can actually walk to on arrival holding
    // nothing, and the generator guarantees there is room out there to stand in
    // (see hallLocks).
    const free = (x, z) => !this._behindALock(layout, x, z) && this._reachable(layout, x, z);
    let have = 0;
    let nearest = Infinity;
    for (const e of this.items) {
      if (e.neutral || !free(e.x, e.z)) continue;
      have++;
      nearest = Math.min(nearest, Math.hypot(e.x - layout.spawn.x, e.z - layout.spawn.z));
    }

    // Every corridor tile they can reach, sorted by how far it is — the top-up
    // fills in from the near end, because the point is the first contact rather
    // than the head count.
    //
    // Taken off the tile grid rather than off `this.corridors`, which is every
    // tenth tile: sampling is fine for picking a patrol route and is not fine
    // here, because ten qualifying tiles can sample down to one and then lose
    // that one to a filing cabinet. This is the guarantee, so it looks at all of
    // them.
    const all = this._prologueSpots(layout, nav);
    const far = all.filter((e) => e.d > MIN_SPAWN_GAP);
    // The gap is a preference, not a requirement. gen/layout.js guarantees there
    // is corridor beyond it, but furniture is placed after that promise is made
    // and could in principle fill every last standable tile — and a body on the
    // doormat is a worse floor, while a body nowhere at all is not a floor.
    const spots = far.length ? far : all;
    if (!spots.length) return;

    // Somebody inside FIRST_CONTACT of the lifts, and OUTSIDE_MIN of them in
    // total. Both are floors, not targets: a floor that already has a patrol
    // walking past the lobby gets nothing added.
    if (nearest > FIRST_CONTACT && spots[0].d <= FIRST_CONTACT) {
      this._add(spots[0].s.x, spots[0].s.z, rng, tuning, pickType(layout.floorNumber, rng, this.theme));
      have++;
    }
    for (let i = 1; have < OUTSIDE_MIN && i < spots.length; i++, have++) {
      const spot = rng.pick(spots.slice(0, Math.max(8, (spots.length * 0.4) | 0)));
      this._add(spot.s.x, spot.s.z, rng, tuning, pickType(layout.floorNumber, rng, this.theme));
    }
  }

  /**
   * Every standable corridor tile the player can reach holding nothing, nearest
   * to the lifts first.
   *
   * This is the enemies-side half of the prologue guarantee, and it is written
   * against the tile grid on purpose — see the note where it is called. The
   * layout counts these same tiles before any furniture exists (prologueRoom in
   * gen/layout.js); this counts what is actually left standable once the floor
   * is furnished, which is always the smaller number and is the one that decides
   * whether a floor can be started.
   */
  _prologueSpots(layout, nav) {
    const { W, H, tiles } = layout;
    const out = [];
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const i = ty * W + tx;
        if (tiles[i] !== CORRIDOR) continue;
        if (layout.locked?.[i]) continue;
        if (layout.prologue && layout.prologue[i] < 0) continue;
        const x = nav.wx(tx), z = nav.wz(ty);
        if (!nav.clear(x, z, RADIUS)) continue;
        out.push({ s: { x, z }, d: Math.hypot(x - layout.spawn.x, z - layout.spawn.z) });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // Can the player get here before they have badged anything at all? Only the
  // first white card cares — everything else on the floor is placed for a player
  // who is already holding one.
  _reachable(layout, x, z) {
    if (!layout.prologue) return true;
    const tx = Math.floor((x - layout.ox) / layout.TILE);
    const ty = Math.floor((z - layout.oz) / layout.TILE);
    if (tx < 0 || ty < 0 || tx >= layout.W || ty >= layout.H) return false;
    return layout.prologue[ty * layout.W + tx] >= 0;
  }

  _behindALock(layout, x, z) {
    if (!layout.locked) return false;
    const tx = Math.floor((x - layout.ox) / layout.TILE);
    const ty = Math.floor((z - layout.oz) / layout.TILE);
    if (tx < 0 || ty < 0 || tx >= layout.W || ty >= layout.H) return true;
    return layout.locked[ty * layout.W + tx] !== 0;
  }

  /**
   * Who is carrying a keycard.
   *
   * Everybody is carrying the white one, because everybody who works here has a
   * staff badge — that is what makes white on every door fair rather than
   * cruel. The real cards replace the white they would otherwise have had
   * (there are a hundred and forty others carrying that), and they go to
   * specific people: grey to whoever the shuffle turns up, but yellow and blue
   * to the two trades that own a room on this floor.
   *
   * Dealt after everyone is placed rather than during placement, because the
   * question it has to answer is about the floor as a whole: every lock on it
   * needs a holder who is not behind it. For grey, blue and yellow that is free
   * — nobody is placed inside a staff-only room at all — and for white it is
   * _cardOutside above.
   *
   * Only hostiles carry. The neutrals are the people you are explicitly allowed
   * to walk past, and putting the security card in a cleaner's pocket turns
   * "you never have to shoot these" into a lie told once per floor.
   *
   * Black is not dealt at all. It comes off the last hostile standing, which is
   * both why the manager's office is the last room on the floor and why it can
   * be a skeleton key without unlocking the floor early.
   */
  _dealCards(layout, rng) {
    // `behindLock` is excluded: the manager's pockets are behind the manager's
    // door, so anything dealt to him is a key locked in with its own lock. The
    // same goes for the two janitors sitting in the broom closet.
    const hostiles = rng.shuffle(this.items.filter((e) => !e.neutral && !e.behindLock));
    for (const e of hostiles) e.card = 'white';

    const tiers = [...new Set((layout.locks ?? []).map((l) => l.tier))]
      .filter((t) => t !== 'black' && t !== 'white');

    // Two of them are not dealt with the rest, because they belong to a trade
    // rather than to whoever came up first in the shuffle: yellow is the
    // cleaning staff's and blue is security's, and every one of them on rounds
    // is carrying it. Which makes the broom closet and the security office rooms
    // you open because of who you shot, not because of what happened to fall out
    // of a body.
    const OWNED = { yellow: (e) => e.type === TYPES.janitor, blue: (e) => e.type.guard };
    for (const [tier, owns] of Object.entries(OWNED)) {
      if (!tiers.includes(tier)) continue;
      for (const e of hostiles) if (owns(e)) e.card = tier;
    }

    let i = 0;
    for (const tier of tiers) {
      if (OWNED[tier]) continue;
      // Never take a card off a janitor or a guard to hand out somebody else's.
      while (i < hostiles.length && hostiles[i].card !== 'white') i++;
      if (i >= hostiles.length) break;
      hostiles[i++].card = tier;
    }
    // Spares for the tiers that have more than one door, so a grey card is
    // something the floor hands you on the way past rather than one specific
    // body among a hundred and forty. Only ever over a white card: the shuffle
    // interleaves the owners with everybody else, so a spare pass that wrote
    // over whatever it landed on would quietly take the yellow off a janitor.
    const spares = tiers.filter((t) => t === 'grey');
    if (!spares.length) return;
    for (; i < hostiles.length; i++) {
      if (hostiles[i].card === 'white' && rng.chance(CARD_SPARE_CHANCE)) {
        hostiles[i].card = rng.pick(spares);
      }
    }
  }

  // Walkable spots anywhere on the floor, spawn included — used for things that
  // are scenery rather than opposition.
  _loose(layout, nav, rng, count) {
    const spots = [];
    for (let tries = 0; spots.length < count && tries < count * 40; tries++) {
      const tx = rng.int(0, layout.W - 1);
      const ty = rng.int(0, layout.H - 1);
      if (!nav.walkable(tx, ty)) continue;
      if (layout.locked?.[ty * layout.W + tx] === STAFF_ONLY) continue;
      const x = nav.wx(tx), z = nav.wz(ty);
      if (!nav.clear(x, z, RADIUS)) continue;
      spots.push({ x, z });
    }
    return spots;
  }

  /**
   * Walkable tiles well away from where the player arrives.
   *
   * Room by room rather than scattered, and each spot remembers which room it
   * came from, because who ends up standing together is decided from that (see
   * spawn). Rooms are visited in a shuffled order and a random number of spots
   * are taken from each, so the floor gets crowded rooms, quiet rooms and empty
   * ones instead of an even sprinkle of exactly one person everywhere.
   */
  _spawnPoints(layout, nav, rng, count) {
    const spots = [];
    // Nobody works behind a REAL lock — grey, blue, yellow, black. That is the
    // rule that makes those four survivable: the card is never on the wrong side
    // of the door it opens. It costs half a dozen rooms of headcount out of a
    // hundred and forty, which is nothing next to a floor that cannot be
    // finished.
    //
    // White rooms are the opposite case and are staffed normally. White is on
    // every door in the building and on every employee in it, so a white room is
    // a room with the key to itself standing in it — and the guarantee that
    // makes the FIRST one openable is _cardOutside below, not this.
    // Nor in the room the player is standing in when the floor starts, whatever
    // that room is this time. Keyed off `spawnRoom` rather than off the 'lobby'
    // role, because the floor now arrives in its canteen when it has one (see
    // pickCafeteria in gen/layout.js) — and a role name is a fact about how a
    // room is FURNISHED, while "do not put anybody here" is a fact about where
    // the player materialises. Left as the role test, a cafeteria floor would
    // have opened with a dozen people standing around the arrival point.
    const rooms = rng.shuffle(
      layout.rooms.filter((r) => r !== layout.spawnRoom && !r.staffOnly));
    if (!rooms.length) return spots;

    // The same rooms, workplaces first. The roster is spread over a hundred-odd
    // rooms and runs out long before all of them have had a turn, so which rooms
    // get served BEFORE it runs out is the whole of where a floor's staff are —
    // and left to the shuffle that came out as six people at a desk on a floor
    // of a hundred and six, with two thirds of the building's desks empty and
    // the same headcount standing about in storerooms. A floor is staffed from
    // the rooms with desks in them outward, and the archive gets whoever is
    // left.
    //
    // First pass only. Held for every pass it would fill five rooms and empty
    // the rest of a floor that has few enough rooms to come round again.
    const deskless = (r) => (this.desks.get(r)?.length ? 0 : 1);
    const workFirst = [...rooms].sort((a, b) => deskless(a) - deskless(b));

    const minDist = 14;
    // Where a body may be put down at all. A single walkable tile is not enough:
    // movement tests a whole body radius, so a tile wedged against furniture is
    // one an enemy can stand on but never leave, and spawning there makes it a
    // statue. Every spot on the floor is held to this. `spots` is read live, which
    // is what keeps two bodies from being put down on top of each other.
    //
    // A room's own desks are not candidates at all — see DESK_TEAM.
    const ok = (x, z) => nav.clear(x, z, RADIUS)
      && Math.hypot(x - layout.spawn.x, z - layout.spawn.z) >= minDist
      && !spots.some((s) => Math.hypot(s.x - x, s.z - z) < 1.6);

    // One group per room per pass, so the passes have to outnumber the enemies
    // per room — at seventy-plus on a twenty-room floor, eight passes ran out
    // long before the roster did and every floor quietly shipped half of it.
    const passes = Math.max(8, Math.ceil(count / Math.max(1, rooms.length)) + 4);

    for (let pass = 0; spots.length < count && pass < passes; pass++) {
      for (const room of pass === 0 ? workFirst : rooms) {
        if (spots.length >= count) break;
        // How many this room takes this time round. Most of the floor's empty
        // rooms come from here rather than from being skipped outright: a room
        // that draws nobody on every pass simply never gets anybody.
        //
        // Except a room with desks in it, which is dealt a shift instead: as
        // many as it has stations, capped, and never nobody. That is the other
        // half of staffing the workplaces first — order alone got the desks
        // visited, and then handed a twelve-pod farm the same one or two bodies
        // it handed the stationery cupboard next door.
        const desks = this.desks.get(room)?.length ?? 0;
        const want = desks
          ? rng.int(1, Math.min(desks, DESK_TEAM))
          : (rng.chance(0.28) ? 0 : rng.int(1, 3));

        for (let placed = 0; placed < want && spots.length < count; placed++) {
          // A patch of the room's carpet, and never one of its chairs. The desks
          // stay in the pool for the two bodies that are allowed to sit in one:
          // somebody dealt a station they are not going to sit at is standing
          // inside the chair rather than working at the desk.
          for (let tries = 0; tries < 14; tries++) {
            const tx = rng.int(room.x0, room.x1 - 1);
            const ty = rng.int(room.y0, room.y1 - 1);
            if (!nav.walkable(tx, ty)) continue;

            const x = nav.wx(tx), z = nav.wz(ty);
            if (!ok(x, z)) continue;

            spots.push({ x, z, room });
            break;
          }
        }
      }
    }
    return spots;
  }

  /**
   * The next free desk in a room that the caller is willing to stand somebody
   * at, or null.
   *
   * `ok(x, z)` is the caller's own test, because who may sit where is not one
   * rule: a body found working has to pass everything an ordinary spawn spot
   * passes, while the manager sits at his own desk however close to the lifts
   * his office happens to be.
   *
   * Taking one REMOVES it, so two bodies can never be dealt the same chair —
   * which would be one body inside another, both of them facing the same
   * monitor. A desk the test refuses is left in the pool: the next caller asks a
   * different question of it.
   */
  _takeDesk(room, ok, pool = this.desks) {
    const free = pool.get(room);
    if (!free) return null;
    for (let i = 0; i < free.length; i++) {
      if (ok(free[i].x, free[i].z)) return free.splice(i, 1)[0];
    }
    return null;
  }

  /**
   * Puts a body in a chair, at work, facing what it is working on.
   *
   * Being at a desk is a state of the BODY and not of the AI — the state machine
   * is untouched, `idle` still means idle, and the pose is stood down the frame
   * anything happens (see `animate` in enemy-anim.js). So nothing downstream of
   * here — hearing, sight, pathing, the card in their pocket, the ragdoll —
   * needs to know this was ever a thing.
   */
  _seat(e, station, at = 'desk') {
    e.seat = at;
    // ON the chair, not near it. Every other caller placed the body at the
    // station to begin with so this is a no-op for them; for somebody who WALKED
    // here it is the last few centimetres `_settleOnto` could not close, and it
    // is what makes "is the chair still under me" a question with an exact
    // answer rather than one with a metre of slack in it.
    e.x = station.x;
    e.z = station.z;
    e.group.position.set(e.x, e.y, e.z);
    // What the pose is drawn relative to, looked up ONCE here rather than
    // searched for every frame. A seat is two props: the chair holding them up,
    // and — for lunch — the table their tray is on. Either can be destroyed and
    // the chair can also be shoved, so a seated body has to be able to tell.
    //
    // Null is a perfectly ordinary answer and means "do not check": a lookup
    // that comes back empty must never be read as the chair having gone, or a
    // seat the scan simply could not attribute would stand its body up on the
    // first frame it ever sat down.
    e.chair = this._looseAt(station.x, station.z);
    e.table = at === 'table' ? this._surfaceAhead(station) : null;
    // The chair's quarter turn, converted the one way it can be: a prop's turns
    // rotate the front from -Z toward +X, which is a negative rotation about Y.
    // Same line as tryPlace's, because a body and the chair under it face the
    // same way for the same reason.
    e.yaw = -station.rot * Math.PI / 2;
    e.group.rotation.y = e.yaw;
  }

  /**
   * Whatever a body was sitting on has gone. Stands them up, and this is the one
   * place that decides so.
   *
   * The pose is the problem it solves: a seated body is drawn hips-down into a
   * chair that is a separate prop, and that prop is loose — one round ends it,
   * and walking into it moves it. Neither used to reach the body, so the canteen
   * could be blown apart and leave four people sitting in mid-air, which is what
   * a player reported.
   *
   * The chair is checked for EVERY seat and the table only for a canteen one,
   * because they fail differently. Losing the chair is the body sitting on
   * nothing, which is wrong wherever it happens; losing the table leaves the
   * chair doing its job and only the tray hanging in the air, so it ends the
   * lunch rather than being a general rule about desks — a Manager at a desk
   * that has been shot out from under his monitor is still sitting on his chair.
   */
  _seatGone(e) {
    const chair = e.chair;
    // Null means the scan could not attribute one, which is not the same as the
    // chair having gone — see the note in _seat.
    const lost = chair && (chair.top < 0
      || Math.abs((chair.minX + chair.maxX) / 2 - e.x) > SEAT_DRIFT
      || Math.abs((chair.minZ + chair.maxZ) / 2 - e.z) > SEAT_DRIFT);
    const noTable = e.seat === 'table' && e.table && e.table.top < 0;
    if (!lost && !noTable) return;

    // A break ends the way it ends anywhere else — the chair goes back to the
    // pool, the tray goes, the visor comes back — and `_lunchEnd` stands them up
    // on its way past. Anything else is on its feet and back on the clock.
    if (e.break) this._lunchEnd(e);
    else this._standUp(e);
  }

  /**
   * Out of the chair, joints and all.
   *
   * Clearing `e.seat` and calling `stand` are ONE operation and this is the only
   * place either happens deliberately: `stand` in enemy-anim.js puts the hips and
   * shoulders back where rigs.js left them, and nothing else in that file ever
   * moves a limb's position, so a body that left its chair any other way carried
   * the chair's joints round the floor for the rest of the run. The animator's
   * own stand-up — a seated body whose state is no longer idle or alert — is the
   * same operation reached the other way round, and does the same two things.
   */
  _standUp(e) {
    if (!e.seat) return;
    e.seat = null;
    e.chair = null;
    e.table = null;
    stand(e);
  }

  // The loose prop standing at a point — the chair under a seat. Bounds rather
  // than a radius, because a collider is what the rest of the game collides
  // against and its footprint is the honest answer to "is there one here".
  _looseAt(x, z) {
    for (const b of this.loose ?? []) {
      if (b.top < 0) continue;
      if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return b;
    }
    return null;
  }

  // ...and the fitted one a body's width in front of a seat, which is the desk
  // or the table it is pulled up to. Static, so it never moves and only `top`
  // can change.
  _surfaceAhead(station) {
    const yaw = -station.rot * Math.PI / 2;
    const x = station.x - Math.sin(yaw) * TABLE_AHEAD;
    const z = station.z - Math.cos(yaw) * TABLE_AHEAD;
    for (const b of this.colliders ?? []) {
      if (b.top < TABLE_LOW || b.top > TABLE_HIGH) continue;
      if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return b;
    }
    return null;
  }

  /**
   * The machine a chore station is a place to stand AT, or null.
   *
   * Same probe as `_surfaceAhead` one method up and the same reason for
   * existing: a working pose is drawn relative to a prop, that prop can be shot
   * apart, and nothing used to tell the body. A man goes on typing at a desk
   * that is no longer there, pressing a copier that has been blown into the
   * corridor — which is what a player reported, and it is `_seatGone`'s bug in
   * the room next door.
   *
   * Three differences from the seat version, and each one is the difference
   * between a chair and a machine:
   *
   *   - THE BAND IS TALLER, because the props are. A copier tops out at 1.13,
   *     a bench at 0.9, a vending machine at 1.9 and a server rack at 2.05, so
   *     a table's 1.4 ceiling would silently miss half the catalogue. The top of
   *     it is what keeps the WALL out: a machine is backed against one, and a
   *     wall's collider tops out at WALL_H — far above anything that can be
   *     stood at, so excluding it costs nothing and including it would make
   *     every station in the building indestructible.
   *   - SEVERAL DEPTHS, not one. A seat is placed a known width from its table;
   *     these come from two different offsets — `WORK_REACH` in front of a
   *     wall-backed machine, `DESK_ASIDE` along a desk from its chair — so
   *     there is no single number that lands inside every prop. The first hit
   *     wins, and probing outward from the body means the near face of the
   *     right prop is always met before anything behind it.
   *   - IT LOOKS IN BOTH LISTS. A chair is always loose and a table always
   *     fitted; a machine can be either — the copier and the rack are static,
   *     and a bench somebody shoved is not. Both retire the same way (`top` goes
   *     negative), which is the whole reason one test serves both.
   *
   * Null is an ordinary answer and means DO NOT CHECK, exactly as it does for a
   * seat: a mop station is a patch of corridor and a wall panel has no collider
   * at all by design (see panels.js). A probe that simply failed to attribute a
   * prop must never read as the prop having gone, or every job on the floor ends
   * on the frame it starts.
   */
  machineAhead(station) {
    const [fx, fz] = FACING[station.rot & 3];
    for (const ahead of MACHINE_AHEAD) {
      const x = station.x + fx * ahead;
      const z = station.z + fz * ahead;
      const hit = this._boxAt(x, z, MACHINE_LOW, MACHINE_HIGH);
      if (hit) return hit;
    }
    return null;
  }

  /** Whatever fitted or loose box is over this point inside a height band. */
  _boxAt(x, z, low, high) {
    for (const list of [this.colliders, this.loose]) {
      for (const b of list ?? []) {
        if (b.top < low || b.top > high) continue;
        if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return b;
      }
    }
    return null;
  }

  _add(x, z, rng, tuning, type) {
    // The body is rigs.js's business; everything below is behaviour.
    const rig = buildRig(type, rng);
    const { group, mats, ownGeo, torso, head, armL, armR, legL, legR, gun, blunt } = rig;
    group.position.set(x, 0, z);

    const enemy = {
      group, mats, ownGeo, torso, head, armL, armR, legL, legR, gun,
      // The spare shins the seated pose bends a knee with, on the human rig only
      // (see rigs.js). Undefined everywhere else, and `sitLegs` and `stand` both
      // test for them — a machine keeps its straight-legged sit.
      shinL: rig.shinL ?? null, shinR: rig.shinR ?? null,
      blunt, bluntReach: rig.bluntReach, bluntRest: rig.bluntRest ?? 0.5,
      // Rat parts. Null on everything else, and the animation branches on the
      // rig rather than on the type, so a second four-legged thing costs a rig
      // and nothing else.
      rig: rig.rig, legs: rig.legs ?? null, tail: rig.tail ?? null,
      brush: rig.brush ?? null, motor: null,
      // Machine parts. What it gets about on, where its hand is, and the two
      // things on a chassis that never stop moving — all of it read off the rig
      // rather than assumed, which is what lets a body on wheels go through
      // every line below without one of them knowing. See CHASSIS in rigs.js.
      drive: rig.drive ?? 'legs',
      gunRest: rig.gunRest ?? null, gunAim: rig.gunAim ?? null,
      // Where this rig's shoulders and hips are. The two poses struck on every
      // body in the building — a chore and `stand` — solve their angles against
      // it, so a machine works a copier with its own arms. Copied here like
      // everything else off the rig: the enemy is built field by field rather
      // than spread, so a rig can grow a property and nothing downstream ever
      // sees it, which is exactly what happened the first time this was added.
      joints: rig.joints ?? null,
      rotors: rig.rotors ?? null, beaconMat: rig.beaconMat ?? null,
      // Where this body carries a box and whether its arms come up to hold it.
      // Same argument as the two above: a porter carries one on a deck.
      boxAt: rig.boxAt ?? null, boxArms: rig.boxArms !== false,
      // The crate, if this one is on a parcel run, and whether they are up to
      // the elbows in a machine. See jobs.js.
      carry: null, job: null, jobRole: null, working: false,
      // ...and the errand a body is on when it is doing the building's ordinary
      // work rather than carrying a box across it: standing at a printer, a
      // server rack, a bench. Unlike a parcel run this is walked by a HOSTILE as
      // often as by a neutral, and it is abandoned the moment they notice you.
      // See chores.js.
      chore: null,
      type,
      // Position in `items`, which is this body's name on the wire. It is stable
      // because the roster is generated from the floor's seed and appended to in
      // one order, so index 57 is the same person in both browsers.
      index: this.items.length,
      // Where the last snapshot said this body was, on a joiner. Seeded to the
      // spawn so the first frame does not lerp in from the origin.
      netX: x, netZ: z, netY: 0, netYaw: 0,
      // Whether this body can see its target, left here by `_pick` because
      // working it out is the expensive half of choosing one.
      sees: false,
      // Flat, because the minimap reads it every frame alongside `alive` and has
      // no business knowing what a type is.
      neutral: !!type.neutral,
      // The minimap answers "is there somebody in that room". A rat is not
      // somebody, so it is not on it.
      offMap: !!type.offMap,
      flee: 0,
      x, z,
      yaw: group.rotation.y,
      health: tuning.health * type.hp,
      alive: true,
      state: 'idle',
      timer: rng.range(0, 1),
      fireCooldown: rng.range(0.4, 1.6),
      // Seconds of you held in their sights. Gates the FIRST round only — it goes
      // on accumulating past the threshold, so a fight already in progress fires
      // on its ordinary cadence. See AIM_CONE.
      aim: 0,
      contact: 0,          // seconds since last seen the player
      lastSeen: null,
      walkPhase: rng.range(0, 6),
      hitFlash: 0,
      deathTime: 0,
      swing: 0,
      swingLanded: true,
      dist: Infinity,
      strafe: rng.chance(0.5) ? 1 : -1,
      // Which nav layer this body is on, and how high that puts it. Everybody
      // spawns on the ground floor; a layer is something you walk onto, up a
      // staircase. See the note at the top of nav.js.
      layer: 0,
      y: 0,
      voiceTimer: rng.range(1, 14),   // staggered, or a floor mutters in chorus
      lastStep: 0,
      // The keycard on their belt, if any. Dealt after the whole floor is
      // placed — see _dealCards.
      card: null,
      // Vermin only: bolt, stop, bolt again.
      darting: true, dartTimer: rng.range(0.2, 1), moving: true,
      // Where a neutral is currently headed — the toilet, the next corridor to
      // mop — plus their own distance field to get there. See _repick.
      wanderX: 0, wanderZ: 0, wanderTimer: 0, field: null, stuck: 0,
      // How this body comes apart when it stops working (rigs.js), and whether
      // something took that offer up. `ragdoll` is what stands the toppling
      // animation down — see _die.
      bones: rig.bones ?? null,
      ragdoll: false,
      // Set on the people who work behind a real lock — the manager, and the two
      // janitors on their break. It keeps them out of openHostileCount and out
      // of the card deal.
      behindLock: false,
      // Carrying a badge that opens doors: the security response to an alarm,
      // and nobody else on the floor. See `alarm`.
      keyed: false,
      // 'desk' for the two bodies on the floor allowed to sit in a chair — the
      // Manager at his own, one guard on the cameras — and null for everybody
      // else, which is standing up. See animateWorking in enemy-anim.js.
      seat: null,
      // ...and the two props that pose is drawn relative to, so a body can tell
      // when it is sitting on nothing. See _seatGone.
      chair: null,
      table: null,
      // Somebody's lunch: which beat of the cycle they are on, and the tray in
      // their hands while they are on it. Both null for the whole building most
      // of the time — see the block above _sendToLunch.
      break: null,
      tray: null,
      // The can somebody bought, the arm it is parented to, and how long they
      // keep it. See `giveCan` — it outlives the chore that handed it over, so
      // the clock is on the BODY rather than on the job.
      can: null, canArm: null, canTimer: 0,
      // ...and the paperwork a routine is carrying, which has no clock: the
      // errand that made it is what takes it back. See `givePapers`.
      papers: null, papersArm: null,
      // One break a floor, and this is what says so. Without it a body that has
      // just walked out of the canteen is `idle` again and eligible again, and
      // the same man queues twice while nobody else goes at all.
      lunchDone: false,
      // The materials a hit whitens: whatever this one is actually wearing.
      flash: rig.flash ?? [],
    };

    if (type.neutral) {
      enemy.state = 'wander';
      enemy.voiceTimer = type.panic ? rng.range(0.2, 2.5) : rng.range(3, 14);
    }

    // Where a bullet can land, and what it is worth there.
    //
    // Limbs used to stop nothing at all, on the grounds that the box on an arm
    // is 14 cm across and catching one instead of the chest is luck rather than
    // aim. That is true, and it is an argument for a limb hit being CHEAP, not
    // for it being nothing: a round that goes through somebody's forearm and
    // does not scratch them is the more obvious lie, and it is the one the
    // player sees, because the tracer ends on the wall behind a man who did not
    // react. So all six boxes stop a round now and the arithmetic carries the
    // meaning instead.
    enemy.hitboxes = [];
    for (const [mesh, scale] of [
      [head, HIT_ZONES.head], [torso, HIT_ZONES.torso],
      [armL, HIT_ZONES.limb], [armR, HIT_ZONES.limb],
      [legL, HIT_ZONES.limb], [legR, HIT_ZONES.limb],
    ]) {
      if (!mesh) continue;              // a rat has a body and a head and that is all
      mesh.userData.enemy = enemy;
      mesh.userData.hitScale = scale;
      mesh.userData.isEnemyPart = true;
      enemy.hitboxes.push(mesh);
      this.meshes.push(mesh);
    }

    this.scene.add(group);
    this.items.push(enemy);
    return enemy;
  }

  /**
   * A bullet landed. Returns 'kill' | 'hit' | null (already down).
   *
   * `dir`, `point` and `punch` are the shot itself, and they are carried this
   * far for one reason: if this is the killing hit, the ragdoll needs to be
   * thrown the way the bullet was going, from the part it went into, as hard as
   * the gun that fired it. A body that folds straight down whatever hit it is a
   * body that died of natural causes.
   */
  hit(mesh, damage, dir = null, point = null, punch = 1) {
    const e = mesh.userData?.enemy;
    if (!e || !e.alive) return null;
    const dealt = damage * (mesh.userData.hitScale ?? 1);
    const shot = dir ? { dir, point, mesh, punch } : null;

    // Not our call. The shot is real and the feedback is immediate — the flash,
    // the flesh impact, a hitmarker — but the health is the host's, and the kill
    // comes back as a message. Predicting the death here instead would show the
    // joiner bodies dropping that the host has not agreed are dead, and then
    // standing back up.
    if (!this.authority) {
      this.onReport?.(e, dealt, shot);
      e.hitFlash = HIT_FLASH;
      return 'hit';
    }

    return this._damage(e, dealt, shot);
  }

  // Damage from any source, once it is known who took it and how much.
  _damage(e, damage, hit = null) {
    if (!e.alive) return null;
    e.health -= damage;
    e.hitFlash = HIT_FLASH;
    // Lunch is over. This is what keeps the visor honest: a body on its break is
    // out of the state machine entirely, and the frame that stops being true is
    // the frame its eyes stop saying it. Everything below then treats them as
    // whatever they actually are — a neutral runs, an employee gets up and
    // fights — and neither branch has to know there was ever a tray.
    if (e.break) this._lunchEnd(e);
    // Being shot at is a reliable way to get someone's attention.
    // The parcel run is off, for the reason the break is: whatever this body was
    // doing, it is not doing it now. It goes before the branch below because it
    // applies to a hostile on a run as much as to a neutral on one — and a run
    // must not be left half-finished with a crate parented to somebody who has
    // started running away, which is what the box hanging in the air would look
    // like.
    if (e.job) this.jobLost?.(e);
    // ...and the ordinary job, for exactly the same reason and in the same
    // breath: nobody carries on typing while they are being shot at.
    if (e.chore) this.choreLost?.(e);
    if (e.neutral) {
      // They have nothing to fight you with and never did. Zeroing the timer
      // makes the next tick pick a destination away from you instead of
      // finishing the walk they were already on.
      e.flee = FLEE_TIME;
      e.wanderTimer = 0;
    } else if (e.state === 'idle') {
      e.state = 'alert';
      e.timer = 0.15;
    }

    if (e.health > 0) {
      this.onDamaged?.(e, 'hit', hit);
      return 'hit';
    }
    this._die(e, hit);
    this.onDamaged?.(e, 'kill', hit);
    return 'kill';
  }

  /**
   * Everything that happens once somebody is out of health.
   *
   * Split from `_damage` because in a co-op session the joiner never takes the
   * arithmetic path at all: it is told that index 57 is dead and has to do
   * exactly this to it — the same corpse, the same ragdoll, the same card on the
   * carpet. Two copies of this would be two different deaths.
   */
  _die(e, hit = null) {
    e.alive = false;
    e.deathTime = DEATH_TIME;
    // A chair nobody is ever going to sit in, and a tray that would otherwise
    // ride a ragdoll down: `_lunchEnd` hands both back. The visor it restores is
    // overwritten a few lines below for anything that ragdolls, which is right —
    // dead is a louder thing to say than off duty.
    if (e.break) this._lunchEnd(e);
    // ...and a crate that would otherwise ride a ragdoll down. `jobLost` is what
    // releases the other two bodies on the run as well, which matters more than
    // the box: a porter waiting for a handoff from somebody who is dead waits
    // out the whole stage cap.
    if (e.job) this.jobLost?.(e);
    // The knee, which is the one part of a seated pose the ragdoll cannot inherit:
    // a bone lists `legL` alone, so the shins are left standing on the group
    // exactly where the chair was while the rest of the body falls out of it.
    // Hidden here rather than in `stand` because `stand` is deliberately skipped
    // for a body that is already dead — a ragdoll should start from the pose you
    // were looking at, and these two boxes are the only part of it that lies.
    if (e.shinL) e.shinL.visible = false;
    if (e.shinR) e.shinR.visible = false;
    if (e.legL) e.legL.scale.y = 1;
    if (e.legR) e.legR.scale.y = 1;

    // ...and the drink, for exactly the tray's reason: it is parented to an ARM,
    // and an arm is about to become a ragdoll bone. A can riding a corpse across
    // the carpet is funnier than it is right, and nothing would ever clear it —
    // `canTimer` is only ticked for a body that is still alive. Deliberately not
    // done in `_damage`: somebody who is merely being shot at runs away with
    // their drink, which is the truth about people.
    if (e.can) this.takeCan(e);
    if (e.papers) this.takePapers(e);
    // The pose as much as the station: `choreLost` goes through `setWorking`,
    // which is the only thing that puts a hinged limb back, and a corpse that
    // ragdolls out of a working pose does it with its arms already above its
    // head. See chores.js.
    if (e.chore) this.choreLost?.(e);
    // Nobody is walking anywhere now. Half a megabyte a corpse, on a floor that
    // ends with two hundred of them.
    this.dropField(e);
    // A dead machine stops making machine noise. Nothing else clears this, and
    // the loop would otherwise run on out of a wreck for the rest of the floor.
    if (e.motor) { this.audio?.stopMotor(e.motor); e.motor = null; }
    // Every box this one was stopping rounds with goes quiet at once. They stay
    // in the raycast list — shooting.js walks past anything flagged as a body
    // part with nobody behind it — so the next round goes through the corpse
    // rather than being spent on it.
    for (const m of e.hitboxes) m.userData.enemy = null;
    // Hand the body to the solver. It can refuse — no physics, no skeleton, or
    // simply too many already falling — and refusing costs nothing, because the
    // animation below is still sitting there.
    e.ragdoll = !!this.ragdolls?.spawn(e, hit);
    // The visor going dark is the one bit of the death animation that survives
    // being ragdolled, because it is what says "this one is done" from across a
    // room. Everything else is now the solver's.
    if (e.ragdoll) e.mats.visor.color.setRGB(0.25, 0.05, 0.04);
    // Whatever they were carrying is now on the carpet. What that means — a
    // keycard, the black card off the last one standing — is game.js's, because
    // it is about the floor and this file is about the person.
    this.onDeath?.(e);
  }

  /**
   * The host says index `i` is dead. Joiner side only.
   *
   * `hit` is synthesised from what the wire carried rather than being the real
   * shot, because what it is for is throwing the ragdoll — and a body thrown the
   * wrong way is a worse lie than one thrown approximately the right way.
   */
  netDie(i, hit = null) {
    const e = this.items[i];
    if (!e?.alive) return null;
    e.health = 0;
    this._die(e, hit);
    return e;
  }

  /**
   * The host says index `i` was hit but is still up. Joiner side only.
   *
   * Returns the body, so the caller can give it a voice — this is only ever sent
   * for damage the JOINER did not cause, because a shot fired at this keyboard
   * has already flashed and grunted on its way out through `hit`.
   */
  netHurt(i, health = null) {
    const e = this.items[i];
    if (!e?.alive) return null;
    if (health !== null) e.health = health;
    e.hitFlash = HIT_FLASH;
    return e;
  }

  /**
   * An explosion. Everyone inside `radius` takes damage falling off to nothing
   * at the rim, and the neutrals who live through it take the hint and run.
   *
   * Distance is straight-line and ignores walls, which is wrong and stays wrong:
   * the blast that reaches through a partition is a smaller lie than the one
   * that goes off at somebody's feet and leaves them standing because the tile
   * they are on belongs to the next room.
   */
  splash(x, z, radius, damage, audio) {
    // On a joiner an explosion damages nobody, and it deliberately is not
    // reported either — unlike a bullet, which is.
    //
    // The difference is where an explosion comes from. Every one of them is a
    // volatile prop coming apart (`launch` in extinguishers.js) or the generator
    // going up, and BOTH of those are shatters that already cross the wire — so
    // the host is running its own copy of the same cylinder, on the same
    // trajectory, and its blast is what the staff are hurt by. Reporting this one
    // as well would apply the same explosion twice, once per browser. The blast,
    // the gas, the debris and the noise are all still here; only the arithmetic
    // is the host's.
    if (!this.authority) return 0;

    let kills = 0;
    for (const e of this.items) {
      if (!e.alive) continue;
      const dist = Math.hypot(e.x - x, e.z - z);
      if (dist > radius) continue;

      // Thrown outward from the seat of it, and upward — a body that only slides
      // away from an explosion looks like it was pushed. Straight up for anyone
      // standing exactly on it, since there is no outward to speak of.
      const k = 1 / (dist || 1);
      const blast = {
        dir: dist > 0.05
          ? { x: (e.x - x) * k, y: 0.55, z: (e.z - z) * k }
          : { x: 0, y: 1, z: 0 },
        point: { x: e.x, y: 0.9, z: e.z },
        // An explosion is the heaviest thing that happens to anybody on this
        // floor, and it falls off the same way its damage does — everything
        // near the seat of it leaves the ground, and the ones at the rim are
        // knocked over. See _throw in ragdolls.js.
        punch: BLAST_PUNCH * (1 - dist / radius),
      };

      const outcome = this._damage(e, damage * (1 - dist / radius), blast);
      if (outcome === 'kill') { kills++; audio?.enemyDeath(e); }
      else if (outcome === 'hit') audio?.enemyPain(e);
    }
    return kills;
  }

  /**
   * One frame of the whole roster.
   *
   * `ctx.targets` is who the staff are working against: one object per player,
   * `{ x, y, z, layer, dead, hurt(amount, sx, sz) }`. Single player hands over a
   * list of one and nothing below notices; co-op hands over two, and everything
   * that used to be "the player" becomes "whichever of them this body is dealing
   * with" — see `_pick`.
   *
   * In a co-op session only the HOST runs any of this. The joiner's roster is the
   * same roster, generated from the same seed, and it is posed from the host's
   * snapshots instead — see `puppet` and `applySnapshot`. That is what makes two
   * players fight the same staff rather than two private copies of them.
   */
  update(dt, ctx) {
    const { targets, effects, audio } = ctx;
    // Held so the paths that are not the update loop can reach it — a machine
    // shot dead has to stop running, and the bullet arrives from shooting.js.
    this.audio = audio;

    // Which layer of the nav grid each player is standing on. The grid has two —
    // the ground floor, and every attic and basement — joined at the stairwells,
    // so the field is flooded from wherever they actually are and the route to
    // them goes up or down the stairs like any other route. See the note at the
    // top of nav.js. Off the ground floor it is the level's own layer; a metre up
    // a flight it is still whichever layer the field last had them on, and the
    // height comes from the ramp either way.
    for (const t of targets) t.layer = Math.abs(t.y - EYE) > STOREY_GAP ? 1 : 0;
    // A corpse is not chased. If everybody is down there is nothing to flood
    // from, and the bodies below simply lose contact and stand down.
    //
    // ...and neither is somebody who is not there. `hidden` is the T toggle (see
    // `hidden` in player.js) and it rides in on the same filter as `dead`
    // deliberately: "there is nobody to chase" is a case this file already
    // handles properly and has a whole branch for, so being unseen is not a new
    // state for the roster to know about, it is an existing one reached another
    // way. Every consequence falls out of it at once — the field is not flooded
    // from you, so nobody hears a shot; `_pick` finds nothing, so nobody sights,
    // aims or fires; and anybody mid-chase runs out `contact` and stands down.
    const live = targets.filter((t) => !t.dead && !t.hidden);
    this.playerLayer = live[0]?.layer ?? 0;

    // Bodies move during the loop below, so this is a snapshot taken at the top
    // of the frame rather than an index kept live — which is what the old
    // whole-roster scan effectively was too. It also counts the badge holders,
    // which is why it comes before the flood that depends on there being any.
    if (!this.puppet) this._rebuildNeighbours();

    // Flooded on BOTH ends of a co-op session, above the puppet check, even
    // though a posed roster does no routing with it. `soundPath` in nav.js reads
    // the same field to bend a noise round a doorway instead of through the
    // plaster, and with it never flooded it gives up and every gunshot on the
    // floor arrives through the walls. The badge field is genuinely host-only:
    // nothing but a route wants it.
    if (this.nav && live.length) {
      this.nav.updateField(dt, live, !this.puppet && this.keyedAlive > 0);
    }

    if (this.puppet) { this._poseAll(dt, audio); return; }

    // Whose turn it is at the counter. Host side only, with everything else that
    // decides what the roster does — a joiner is posed from snapshots and a
    // break arrives on the wire like every other state (see `snapshot`).
    this.lunchTimer -= dt;
    if (this.lunchTimer <= 0) {
      this.lunchTimer = LUNCH_GAP[0] + Math.random() * (LUNCH_GAP[1] - LUNCH_GAP[0]);
      this._sendToLunch();
    }
    if (this.shoutTimer > 0) this.shoutTimer -= dt;

    for (const e of this.items) {
      if (!e.alive) { die(e, dt); continue; }
      // Whatever they were sitting on can be shot apart or shoved out from under
      // them, and until this was here neither stood anybody up. See _seatGone.
      if (e.seat) this._seatGone(e);
      // ...and the drink they bought, which is finished with eventually. Here
      // rather than in chores.js because a can outlives the trip to the machine
      // that produced it: they buy it, and then they walk off with it.
      if (e.can) {
        e.canTimer -= dt;
        if (e.canTimer <= 0) this.takeCan(e);
      }

      // Who this one is dealing with. Everything that follows is measured against
      // them, and a body with nobody left to deal with simply loses contact and
      // stands down where it is.
      const target = this._pick(e, live);
      if (!target) {
        e.contact += dt;
        if (e.break) { this._lunch(e, dt, audio); animate(e, dt, audio); continue; }
        // On a parcel run, which is walked by jobs.js instead of by `_wander` —
        // and it is checked BEFORE `neutral` rather than inside it because the
        // run owns the body's whole movement for its duration. `animate` still
        // runs here and nowhere else, so a body gets exactly one pose a frame
        // however it is being driven.
        if (e.job) { this.jobTick?.(e, dt, audio); animate(e, dt, audio); continue; }
        // Working at a machine, with nobody on the floor to interrupt them. The
        // hostile path below still runs its `_think` — there is nothing for it
        // to notice — but `_move` is skipped, because the chore owns where this
        // body is going for as long as it lasts.
        if (e.chore) {
          // Nobody to notice, so no startle test to make: `_choreWork`'s two
          // arguments for it are both false by construction here.
          this.choreTick?.(e, dt, audio);
          animate(e, dt, audio);
          if (!e.neutral) this._mutter(e, dt, audio);
          continue;
        }
        if (e.neutral) { this._wander(e, dt, audio); animate(e, dt, audio); continue; }
        this._think(e, dt, Infinity, false, false, null);
        this._move(e, dt, 0, 0, 1, false);
        animate(e, dt, audio);
        this._mutter(e, dt, audio);
        continue;
      }

      const dx = target.x - e.x;
      const dz = target.z - e.z;
      const dist = Math.hypot(dx, dz) || 0.001;
      const sees = e.sees;
      // Hearing only matters when they cannot see you — if they can, sight has
      // already told them everything, and at a longer range. The distance is the
      // walked one: the field is flooded from the players (or from the foot of
      // their stairs, if they are off the ground floor), so it is already paid
      // for, and a negative value means there is no route at all. With two
      // players it is the walk to the NEARER of them, because the flood has both
      // of them in it at zero.
      const along = this.nav.pathDistance(e.x, e.z, e.layer);
      const hears = !sees && ctx.noise > 0 && along >= 0 && along < HEARING;

      if (sees) {
        e.contact = 0;
        e.lastSeen = { x: target.x, z: target.z };
      } else if (hears) {
        // Not a sighting, so they still do not know exactly where you are — but
        // it counts as contact, which is what keeps them walking your way
        // instead of losing interest halfway down the corridor.
        e.contact = Math.min(e.contact, HEARD_MEMORY);
        e.lastSeen = { x: target.x, z: target.z };
      } else {
        e.contact += dt;
      }

      // Neutrals are not in the state machine at all: no alert, no chase, no
      // weapon. Seeing you and hearing you change nothing — the only thing that
      // does is being shot, and that makes them run rather than fight.
      if (e.neutral || e.break) {
        // Where this one is running away FROM. `_repick` needs it and is called
        // from places with no target to hand, so it is set per body rather than
        // once per frame: with two players on the floor, "away" has to be away
        // from the one who actually shot at them.
        this.playerX = target.x;
        this.playerZ = target.z;
        // Somebody on their break is out of the state machine exactly as far as
        // a neutral is, whatever their type says — no alert, no chase, no
        // weapon. Seeing you and hearing you change nothing; being shot ends the
        // break, and `_damage` is where that happens.
        if (e.break) this._lunch(e, dt, audio);
        else if (e.job) this.jobTick?.(e, dt, audio);
        // A neutral at work is not startled by you standing next to it — that
        // is the whole of what neutral means here, and it is what makes a
        // maintenance man on a wall panel something you can walk up to and
        // watch. Being shot is the one thing that stops them, and `_damage` is
        // where that happens.
        else if (e.chore) this.choreTick?.(e, dt, audio);
        else this._wander(e, dt, audio);
        animate(e, dt, audio);
        continue;
      }

      // Somebody at work, and still at it: chores.js owns where this body goes
      // and none of the state machine runs. `_choreWork` is what decides, and it
      // is checked BEFORE `_think` rather than after because `_think` cannot be
      // what notices you here — it only ever promotes out of `idle`, and a body
      // still walking to its machine is in `wander`, which that switch has no
      // case for at all. When it hands the body back it has already dropped the
      // job and pointed them at you, and the rest of this frame is ordinary.
      if (e.chore && this._choreWork(e, dt, dist, sees, hears, target, audio)) {
        animate(e, dt, audio);
        this._mutter(e, dt, audio);
        continue;
      }

      this._think(e, dt, dist, sees, hears, target);
      this._move(e, dt, dx, dz, dist, sees);
      this._shoot(e, dt, dist, sees, target, effects, audio);
      animate(e, dt, audio);
      this._mutter(e, dt, audio);
    }
  }

  /**
   * Which player this body is dealing with this frame, leaving whether it can
   * see them on `e.sees` — because working that out is the expensive half and
   * the caller needs both answers.
   *
   * Sight beats distance: somebody who can see you at twenty metres is fighting
   * you, not the man eight metres away behind a wall. Between two it can both
   * see, or two it can see neither of, the nearer takes it.
   *
   * Sight is per layer, and across layers there is a floor slab in the way — the
   * one exception being two bodies in the same stairwell, who are looking
   * straight at each other up a flight of stairs. losClear knows; this used to be
   * a flat "nobody sees you off the ground floor", which was right about the slab
   * and wrong about the staircase.
   */
  _pick(e, live) {
    let best = null;
    let bestDist = Infinity;
    let bestSees = false;

    for (const t of live) {
      const d = Math.hypot(t.x - e.x, t.z - e.z) || 0.001;
      const sees = d < SIGHT && this.nav.losClear(e.x, e.z, t.x, t.z, e.layer, t.layer);
      if (best) {
        if (bestSees && !sees) continue;
        if (sees === bestSees && d >= bestDist) continue;
      }
      best = t; bestDist = d; bestSees = sees;
    }

    e.sees = bestSees;
    return best;
  }

  // Walks somewhere, says something about it, walks somewhere else. Deliberately
  // not pathfinding to anything real: he does not know where the bathroom is
  // either, and the cleaner is not working a route.
  //
  // Shoot one and `flee` runs for a few seconds: same loop, quicker, and only
  // picking destinations that put distance between the two of you. When it
  // expires they go back to the day they were having.
  _wander(e, dt, audio) {
    if (e.flee > 0) e.flee -= dt;

    // The toilet guy shouts constantly because that is the whole character.
    // Everyone else is quiet until you shoot them, and then they are not.
    const shouting = e.type.panic || e.flee > 0;
    e.voiceTimer -= dt;
    if (e.voiceTimer <= 0) {
      if (shouting) {
        e.voiceTimer = PANIC_SHOUT[0] + Math.random() * (PANIC_SHOUT[1] - PANIC_SHOUT[0]);
        // The type names what it screams. A cleaner running from a firefight has
        // nothing to say about the toilet, and the rat has nothing to say at all.
        audio.enemyScream(e, e.type.screams ?? 'flee');
      } else {
        e.voiceTimer = 7 + Math.random() * 11;
        audio.enemyIdle(e);
      }
    }

    // Somebody at their lunch is the one body on the floor that is already
    // where it wants to be, so the wander loop does not walk them anywhere.
    //
    // Holding `idle` is what keeps them in the chair: a seated body is stood up
    // by the animator the moment its state is anything else (see `animate` in
    // enemy-anim.js), and every neutral is spawned into `wander`, so without
    // this the whole canteen was on its feet by the first frame — five people
    // placed at five chairs and not one of them still in it.
    //
    // Being shot at is what changes their mind, and `flee` is the one flag that
    // says so. Standing up is the whole of the transition: from the next frame
    // they are an ordinary neutral on the ordinary loop, running for a door.
    if (e.seat) {
      if (e.flee <= 0) { e.state = 'idle'; return; }
      // Out of the chair — but the ANIMATOR is what stands a body up, and this
      // must not do it itself. `stand` in enemy-anim.js puts the hips and
      // shoulders back where rigs.js left them, and nothing else in that file
      // ever moves a limb: the walk cycle writes rotations only. Clearing the
      // seat here instead left a body carrying its seated joints around the
      // floor for the rest of the run, hips and shoulders still dropped into
      // the chair — which is exactly what it looks like, a man walking like an
      // alien. So all this does is stop holding `idle`; the frame ends with
      // `animate` seeing a seated body in `wander`, and it clears the seat and
      // stands them up the one way that works.
      e.state = 'wander';
      this._repick(e);
      return;
    }

    e.wanderTimer -= dt;
    const togo = Math.hypot(e.wanderX - e.x, e.wanderZ - e.z);

    if (e.wanderTimer <= 0 || togo < 0.8) {
      this._repick(e);
      return;
    }

    // Vermin do not walk anywhere. They bolt, stop dead, think about it, and
    // bolt again — and the stopping is what makes the bolting read as fast.
    if (e.type.darts) {
      e.dartTimer -= dt;
      if (e.dartTimer <= 0) {
        e.darting = !e.darting;
        e.dartTimer = e.darting ? 0.35 + Math.random() * 0.8 : 0.25 + Math.random() * 0.9;
      }
      // Frozen mid-scurry, not stuck: the stall counter has to be told, or the
      // pause gets mistaken for wedged furniture and it repicks every time.
      if (!e.darting) {
        e.stuck = 0;
        e.moving = false;
        return;
      }
    }

    const speed = this.tuning.speed * e.type.speed * (e.flee > 0 ? FLEE_SPEED : 1);
    if (this._stroll(e, dt, speed) !== 'moved') this._repick(e);
  }

  /**
   * One frame of walking downhill on this body's OWN field, not straight at
   * whatever it is heading for: the whole point of giving somebody a field is
   * that they go round the wall instead of into it.
   *
   * Returns what happened, because the two callers recover differently — a
   * neutral makes a whole new plan and somebody on their lunch re-floods to the
   * same counter, and neither wants the other's answer.
   *
   *   'moved'   made ground, or is sidestepping something and still might
   *   'stuck'   wedged for long enough that the plan is the problem
   *   'noroute' not on the field at all
   */
  _stroll(e, dt, speed) {
    const dir = this.nav.descendOn(e.field, e.x, e.z, this._v);
    if (!dir) return 'noroute';

    const movedX = this._tryMove(e, dir.x * speed * dt, 0);
    const movedZ = this._tryMove(e, 0, dir.z * speed * dt);
    // Wedged against something the grid thinks is passable. Sidestep first —
    // it is usually a doorway they are half a metre to the side of — and only
    // hand the problem back if that gets nowhere either.
    if (!movedX && !movedZ) {
      e.stuck += dt;
      const step = speed * dt;
      if (!this._tryMove(e, -dir.z * e.strafe * step, dir.x * e.strafe * step)) {
        e.strafe *= -1;
      }
    } else {
      e.stuck = 0;
    }

    e.moving = true;
    e.group.position.x = e.x;
    e.group.position.z = e.z;
    // On a staircase this is the ramp, on a level it is that level's floor, and on
    // the ground floor it is zero — one lookup rather than a special case per state.
    e.y = this.nav.heightAt(e.x, e.z, e.layer);
    e.group.position.y = e.y;
    e.yaw = angleLerp(e.yaw, Math.atan2(-dir.x, -dir.z), smoothTo(9, dt));
    e.group.rotation.y = e.yaw;
    return e.stuck > 0.6 ? 'stuck' : 'moved';
  }

  // Somewhere else, and a route to it. Sampled rather than searched: a handful
  // of tries is enough to find open floor, and failing simply means standing
  // still for a moment, which is entirely in character. Corridors are the
  // preferred destination: that is where they can actually run, and where you
  // get to watch them do it.
  //
  // While fleeing the pick also has to gain ground on the player — but only for
  // the first ten attempts, because a neutral cornered in a dead end with
  // nowhere further to go still needs to end up somewhere rather than freeze.
  _repick(e) {
    e.wanderTimer = PANIC_PATIENCE * (0.6 + Math.random() * 0.8);
    e.stuck = 0;
    e.field ??= this.nav.makeField();

    const spots = this.corridors;
    const fromPlayer = e.flee > 0
      ? Math.hypot(this.playerX - e.x, this.playerZ - e.z)
      : 0;

    for (let attempt = 0; attempt < 12; attempt++) {
      let x, z;
      if (spots?.length && attempt < 8) {
        const s = spots[(Math.random() * spots.length) | 0];
        x = s.x; z = s.z;
      } else {
        const angle = Math.random() * Math.PI * 2;
        const reach = 4 + Math.random() * 12;
        x = e.x + Math.cos(angle) * reach;
        z = e.z + Math.sin(angle) * reach;
      }

      const away = Math.hypot(x - e.x, z - e.z);
      if (away < 4 || away > PANIC_HOP) continue;
      if (!this.nav.clear(x, z, RADIUS)) continue;
      if (e.flee > 0 && attempt < 10 &&
          Math.hypot(this.playerX - x, this.playerZ - z) < fromPlayer + FLEE_AWAY) continue;

      // Flooded from the destination, so descending it walks him there. If he is
      // not on the resulting field there is no route and the pick is wasted.
      if (!this.nav.floodTo(e.field, x, z)) continue;
      if (!this.nav.descendOn(e.field, e.x, e.z, this._v)) continue;

      e.wanderX = x;
      e.wanderZ = z;
      return;
    }

    // Nowhere to go this time; stand and shout, and try again shortly.
    e.wanderX = e.x;
    e.wanderZ = e.z;
    e.wanderTimer = 0.6;
  }

  // --- lunch ------------------------------------------------------------------
  //
  // The canteen is the one room on the floor with a JOB that is not fighting
  // you, and until now the people in it did that job for ever: placed in a chair
  // at floor generation and still in it when the floor ended. A break that never
  // ends is a tableau rather than a shift.
  //
  // So there is a cycle, and both halves of the canteen run the same one: walk
  // in, queue at the counter, take a tray, find a seat, eat, take the tray back,
  // and leave. The staff the floor opens on start half way through it — already
  // seated, already eating — because that is the picture the arrival is for.
  //
  // What makes it more than scenery is who else can join. **An ordinary employee
  // takes a break**: they down tools, their visor goes to the canteen blue, they
  // walk the whole cycle, and their own colour comes back as they walk out. The
  // visor is the game's one universal tell (see the note above TYPES), and this
  // is the first thing in the building that changes it at runtime — so the rule
  // it states has to stay exactly true in both directions:
  //
  //   BLUE EYES ARE NOT FIGHTING YOU. A body on its break is out of the state
  //   machine entirely: no alert, no chase, no weapon in its hands, exactly like
  //   a neutral. Walking past one costs nothing, which is the whole promise the
  //   chair has always made.
  //
  //   ...AND THE TELL IS LIVE. Any damage ends the break on the spot (see
  //   `_damage`), so the frame a body stops being harmless is the frame its eyes
  //   stop saying it is. Shoot into a canteen and you are in a fight with
  //   whoever was in it; leave them alone and you are not.
  //
  // Two things it deliberately does NOT change. A body on break still counts
  // toward clearing the floor, because `hostileCount` reads `e.neutral`, which
  // is a fact about the TYPE and is never touched here — a count that moved
  // would make "floor cleared" fire and un-fire, and the black card is timed off
  // it. And the minimap still shows them as what they are, because the two
  // markers answer different questions: the map says whether you have to shoot
  // this eventually, and the visor says whether it is about to shoot you.
  //
  // Machines do not eat. `type.chassis` is the whole of that test.

  /** How many employees have downed tools right now — the arrival diners are not
   * counted, because they are not away from a post. */
  get _atLunch() {
    let n = 0;
    for (const e of this.items) if (e.alive && e.break && !e.neutral) n++;
    return n;
  }

  /**
   * Somebody decides it is lunchtime BECAUSE there is nothing else to do.
   *
   * chores.js calls this when it could not put anybody to work — every machine
   * of every kind taken, or nobody left standing about who can reach one. That
   * is the only difference from the clock below: the office empties into the
   * canteen when the office is full, rather than only on the timer. Everything
   * that bounds a break still bounds this one, and the chairs are the real
   * bound — `_lunchStart` cannot start without one, so a floor never puts more
   * people in the canteen than the canteen has seats, and anybody it turns away
   * goes on standing where they were.
   */
  sendToBreak() {
    if (this.puppet) return;
    this._sendToLunch();
  }

  /**
   * Every so often, somebody decides it is lunchtime.
   *
   * Sampled rather than filtered: the roster is two hundred people and this runs
   * every twenty seconds or so, so a couple of dozen darts at it is both cheaper
   * and no worse — failing simply means nobody went this time, and somebody goes
   * on the next one.
   *
   * Runtime dice are `Math.random`, never the floor's own seeded stream, for the
   * reason `_repick` and `_damage` already are: that stream is what the floor was
   * built from and what an alarm response still rolls off, and spending it on
   * whose turn it is at the counter would move both.
   */
  _sendToLunch() {
    if (!this.servery?.length || !this.trayRack) return;
    if (this._atLunch >= LUNCH_MAX) return;

    // Can anybody get there, and who? Flooded ONCE from the counter into a
    // field of the module's own and then read for each candidate, rather than
    // per dart: the field from a fixed point is the same field whoever is
    // asking, and two dozen floods of a ten thousand tile floor every twenty
    // seconds to answer one question is the shape of loop this file has been
    // caught writing three times.
    //
    // The answer moves over a floor, and that is the interesting part. Measured
    // on floor 3: with nothing in your pocket **5 of 79** staff can reach the
    // canteen — the ones already in the corridors — because a badged door is out
    // of the nav grid entirely. Take one white card, 170 doorways hand their
    // openings back, and it is **77 of 79**. So the building goes to lunch once
    // the building has been opened, which is not a rule anybody wrote.
    const counter = this.servery[(Math.random() * this.servery.length) | 0];
    this._lunchField ??= this.nav.makeField();
    if (!this.nav.floodTo(this._lunchField, counter.x, counter.z)) return;

    const n = this.items.length;
    for (let tries = 0; tries < LUNCH_DARTS && n; tries++) {
      const e = this.items[(Math.random() * n) | 0];
      if (!this._lunchOk(e)) continue;
      // Asked BEFORE anything is committed. A body that cannot reach the canteen
      // today may well be able to in a minute, so it must not be marked as
      // having had its break — which is what starting one and failing would do,
      // and it would quietly take nine tenths of the floor out of the running
      // before the player had opened a single door.
      if (!this.nav.descendOn(this._lunchField, e.x, e.z, this._v)) continue;
      if (this._lunchStart(e, counter)) return;
    }
  }

  /**
   * Whether this one may go for lunch at all.
   *
   * `layer === 0` is the sharp one and it is a limit rather than an oversight:
   * the walk is `_stroll` on a field flooded to a point, which is the neutrals'
   * own machinery and has always been ground-floor shaped. Somebody in an attic
   * stays in their attic, which is the honest answer rather than a body that
   * sets off downstairs and gets stuck on a landing.
   */
  _lunchOk(e) {
    return e.alive && !e.neutral && !e.behindLock && !e.break && !e.seat
      && !e.lunchDone              // one break a floor
      && !e.chore                  // ...and nor is anybody already at a machine
      && !isMachine(e.type)        // a machine has nowhere to put it
      && !e.type.undead            // ...and this one is off the payroll
      && !e.keyed                  // an alarm response is not going for lunch
      && e.state === 'idle'        // ...and neither is anybody already in a fight
      && e.layer === 0;
  }

  /**
   * Sends one body off on the cycle. Returns false if the canteen cannot take
   * them, which is a perfectly ordinary answer: every chair may be full.
   *
   * The seat is claimed HERE rather than when they arrive at the table, and that
   * is the same argument `_takeDesk` makes for everybody else — two people dealt
   * one chair is two bodies eating the same lunch. It costs a chair being held
   * by somebody still queueing, which is what a tray on a table means anyway.
   */
  _lunchStart(e, counter) {
    const room = this.layout?.cafeteriaRoom;
    if (!room) return false;

    // A chair that has been shot apart or shoved across the room is not a free
    // seat, and this is the one place to say so: the station goes back into the
    // pool when a break ends whatever became of the chair, so it is on the way
    // OUT that it has to be checked rather than on the way in. Without it the
    // next person to come down for lunch sits in the hole the last one's chair
    // left.
    const seat = this._takeDesk(room,
      (x, z) => this.nav.clear(x, z, RADIUS) && !!this._looseAt(x, z), this.tables);
    if (!seat) return false;

    e.break = { stage: 'go', at: null, seat, timer: LUNCH_STAGE_CAP };
    this._lunchLook(e, true);
    this._lunchGo(e, counter, 'go');
    return true;
  }

  /** Already at a table with their lunch in front of them: the arrival canteen. */
  _lunchSeated(e, seat, rng) {
    e.break = {
      stage: 'eat', at: null, seat,
      // A longer first sitting than anybody who arrives later gets. The room the
      // floor opens in is a picture before it is a process, and four people who
      // stand up and file out inside a minute is the picture gone before the
      // player has finished reading it.
      timer: rng.range(EAT_FIRST[0], EAT_FIRST[1]),
    };
    // `idle` is what keeps them in the chair, and it has to be said HERE as well
    // as at the end of the walk: every neutral is spawned into `wander`, and the
    // animator stands up any seated body whose state is anything else. Without
    // it the whole canteen was out of its chairs on the first frame — which is
    // the same bug `_wander` documents, one caller further along.
    e.state = 'idle';
    this._lunchLook(e, true);
    this._giveTray(e);
  }

  /**
   * One frame of somebody's break. Runs instead of the state machine, not
   * beside it — see the note above.
   */
  _lunch(e, dt, audio) {
    const b = e.break;
    b.timer -= dt;

    // Lunch is where the building does its talking. Same cadence as the idle
    // grumble everywhere else, off the same timer.
    e.voiceTimer -= dt;
    if (e.voiceTimer <= 0) {
      e.voiceTimer = 7 + Math.random() * 11;
      audio.enemyIdle(e);
    }

    switch (b.stage) {
      case 'go':
        // Out of the office and into the queue.
        if (b.timer < 0) { this._lunchEnd(e); return; }
        if (this._lunchWalk(e, dt, b.at)) {
          this._lunchStand(e, b.at, 'collect', SERVE_TIME);
        }
        return;

      case 'collect':
        // Being served. The tray arrives at the END of it, because what is being
        // waited for is the food.
        if (b.timer > 0) return;
        this._giveTray(e);
        this._lunchGo(e, b.seat, 'toseat');
        return;

      case 'toseat':
        if (b.timer < 0) { this._lunchEnd(e); return; }
        // Two legs to it: the field to the chair, then the last metre onto it.
        if (this._lunchWalk(e, dt, b.seat) && this._settleOnto(e, dt, b.seat)) {
          this._seat(e, b.seat, 'table');
          // `idle` is what keeps them in the chair: the animator stands up any
          // seated body whose state is anything else (see `animate` in
          // enemy-anim.js), which is the same trap `_wander` documents.
          e.state = 'idle';
          b.stage = 'eat';
          b.timer = EAT_TIME[0] + Math.random() * (EAT_TIME[1] - EAT_TIME[0]);
        }
        return;

      case 'eat':
        if (b.timer > 0) return;
        // Up, and the chair goes back in the pool for the next one. Setting
        // `wander` is the whole of standing up and this must not clear `e.seat`
        // itself: `stand` in enemy-anim.js is the only thing that puts the hips
        // and shoulders back, and a body that left its chair any other way
        // carries the chair's joints around the floor for the rest of the run.
        e.state = 'wander';
        this._freeDesk(b.seat);
        b.seat = null;
        this._lunchGo(e, this.trayRack, 'return');
        return;

      case 'return':
        if (b.timer < 0) { this._lunchEnd(e); return; }
        if (this._lunchWalk(e, dt, this.trayRack)) {
          this._lunchStand(e, this.trayRack, 'drop', DROP_TIME);
        }
        return;

      case 'drop':
        if (b.timer > 0) return;
        this._takeTray(e);
        // Somewhere out of the canteen. `_repick` is the neutrals' own pick and
        // it prefers corridors, which is exactly right here: the canteen is a
        // room, so every corridor tile on the floor is out of it.
        this._repick(e);
        this._lunchGo(e, { x: e.wanderX, z: e.wanderZ }, 'leave');
        return;

      case 'leave':
      default:
        // Back on the clock the moment they are out of the room, which is the
        // one thing about this that had to be true: the eyes change where the
        // player can see it happen, and never in the room they arrived in.
        if (b.timer < 0 || !this._inRoom(this.layout.cafeteriaRoom, e.x, e.z)) {
          this._lunchEnd(e);
          return;
        }
        this._lunchWalk(e, dt, b.at);
    }
  }

  /**
   * ------------------------------------------------------------------------
   * The errand primitives, shared by the lunch cycle and by jobs.js.
   * ------------------------------------------------------------------------
   *
   * A break and a parcel run are the same shape of thing: a body that is out of
   * the state machine entirely, walking a list of places and pausing at each.
   * The WALKING half of that was written for lunch and is not about lunch, so it
   * lives here under names that do not mention it and both callers drive it.
   *
   * An errand is any object carrying `{ at, timer }`. Stages belong to the
   * caller, because that is the only part that differs — and deliberately so:
   * one shared stage machine with two vocabularies in it is how the next thing
   * that walks somewhere ends up with a `stage: 'eat'` in it.
   */

  // Stopped at a station and turned to face it. The station's own quarter turn
  // is converted the one way it can be — the same line `_seat` uses, because a
  // body standing at a counter and a chair pulled up to a desk are facing what
  // they are facing for the same reason.
  standAt(e, at) {
    e.state = 'idle';
    e.moving = false;
    e.yaw = -at.rot * Math.PI / 2;
    e.group.rotation.y = e.yaw;
    // Arrived, so the route is spent. Every errand in the game comes to rest
    // here, which is why the field goes back here and nowhere else — see
    // `dropField`.
    this.dropField(e);
  }

  /**
   * Hands this one's distance field back to nav.
   *
   * A field is 548 KB on a deep floor and a body keeps the one it was given for
   * the rest of its life, which cost nothing while a handful of people were
   * walking anywhere. Now that everybody has somewhere to be it is the difference
   * between a few megabytes and a hundred: it is the WALKERS that need a route,
   * and a man standing at a copier for half a minute is holding directions he
   * has already followed. `??=` at every take site means the next walk simply
   * draws another one out of the free list.
   */
  dropField(e) {
    if (!e.field) return;
    this.nav?.freeField(e.field);
    e.field = null;
  }

  /**
   * Points this one at somewhere and floods the field that walks them there.
   * False (and a spent timer, which every walking stage reads as "give it up")
   * if there is no route.
   *
   * BOTH halves are checked and the second one is the whole of it: a flood that
   * reaches the destination says nothing about whether it reached HERE. Most of
   * the staff are behind a badged door, which is out of the nav grid entirely
   * (see the note about hearing in the header), so before the player has taken a
   * white card the only bodies that can get anywhere are the ones already in the
   * corridors — and once one is taken, ~190 doors hand their openings back and
   * the whole building can. Checked rather than assumed, because a body that
   * sets off for somewhere it cannot reach spends the whole stage cap
   * re-flooding the floor from a tile it is not standing on.
   */
  routeTo(e, errand, to, cap) {
    errand.at = to;
    errand.timer = cap;
    e.state = 'wander';
    e.stuck = 0;
    e.field ??= this.nav.makeField();
    if (!to || !this.nav.floodTo(e.field, to.x, to.z)
      || !this.nav.descendOn(e.field, e.x, e.z, this._v)) {
      errand.timer = -1;
      return false;
    }
    return true;
  }

  /** One step of a walk with a destination. True once they are there. */
  advanceTo(e, errand, dt, to) {
    if (!to) return true;
    if (Math.hypot(to.x - e.x, to.z - e.z) < LUNCH_ARRIVE) return true;

    // Unhurried on purpose. Somebody walking to their lunch — or wheeling a box
    // down a corridor — at chase speed is somebody who has noticed you.
    const speed = this.tuning.speed * e.type.speed * LUNCH_PACE;
    if (this._stroll(e, dt, speed) !== 'moved') {
      // Wedged, or off the field. Re-flooding is the only recovery there is —
      // the floor changes shape as furniture is destroyed — and it is done ONCE
      // and then checked, rather than retried every frame: a body that is not on
      // the field will not be on the re-flooded one either, and left to try
      // again it floods the whole floor thirty times a second for the length of
      // the stage cap. `e.stuck` is reset so a sidestep gets its chance first.
      e.stuck = 0;
      if (!this.nav.floodTo(e.field, to.x, to.z)
        || !this.nav.descendOn(e.field, e.x, e.z, this._v)) errand.timer = -1;
    }
    return false;
  }

  /**
   * The last stretch onto a station, walked in a straight line rather than on
   * the field. True once they are on it.
   *
   * `_tryMove` rather than an assignment, so the same collision the rest of the
   * walk uses still applies — and if it cannot make ground the caller settles
   * anyway, because a body wedged beside the thing it was walking to for the
   * length of the stage cap is the worse outcome.
   */
  closeOnto(e, dt, at) {
    return this._settleOnto(e, dt, at);
  }

  // Standing at the counter for a moment, turned to face it.
  _lunchStand(e, at, stage, span) {
    this.standAt(e, at);
    e.break.stage = stage;
    e.break.timer = span[0] + Math.random() * (span[1] - span[0]);
  }

  // Points this one at their next stop. The stage is the lunch cycle's own; the
  // routing is `routeTo` above.
  _lunchGo(e, to, stage) {
    e.break.stage = stage;
    this.routeTo(e, e.break, to, LUNCH_STAGE_CAP);
  }

  _lunchWalk(e, dt, to) {
    return this.advanceTo(e, e.break, dt, to);
  }

  /**
   * The last metre onto a chair, walked in a straight line rather than on the
   * field. True once they are on it.
   *
   * `_tryMove` rather than an assignment, so the same collision the rest of the
   * walk uses still applies — and if it cannot make ground the body sits anyway,
   * because `_seat` puts it exactly on the station regardless and a body wedged
   * beside its own chair for the length of the stage cap is the worse outcome.
   */
  _settleOnto(e, dt, at) {
    const dx = at.x - e.x, dz = at.z - e.z;
    const gap = Math.hypot(dx, dz);
    if (gap < SEAT_SNAP) return true;

    const step = this.tuning.speed * e.type.speed * LUNCH_PACE * dt;
    const k = Math.min(1, step / gap);
    const moved = this._tryMove(e, dx * k, 0) | this._tryMove(e, 0, dz * k);
    e.group.position.set(e.x, e.y, e.z);
    e.yaw = angleLerp(e.yaw, Math.atan2(-dx, -dz), smoothTo(9, dt));
    e.group.rotation.y = e.yaw;
    return !moved;
  }

  /**
   * The break is over, however it ended: finished, given up on, or shot at.
   *
   * Everything it hands back has to be handed back exactly once — the chair, the
   * tray, the visor and the sidearm — which is why every path out of a break
   * goes through here rather than unwinding itself.
   */
  _lunchEnd(e) {
    if (!e.break) return;
    e.lunchDone = true;
    if (e.break.seat) this._freeDesk(e.break.seat);
    e.break = null;
    this._takeTray(e);
    this._lunchLook(e, false);

    // Out of the chair if they were still in one, joints and all — see
    // `_standUp`. It used to be done by leaving them in a state the animator
    // would stand them up out of, which worked for every way a break could end
    // until one of them was "the chair is not there any more": that path has to
    // stand somebody up who is `idle` and staying `idle`, and idle is exactly
    // the state the animator holds the pose through.
    if (e.seat) { this._standUp(e); e.state = e.neutral ? 'wander' : 'idle'; }
    else if (e.state === 'wander' && !e.neutral) e.state = 'idle';
  }

  // Blue eyes and empty hands, or their own colour and whatever they carry.
  // Both at once, always, because they are one statement: this one is not
  // fighting you at the moment.
  _lunchLook(e, on) {
    e.mats?.visor?.color.setHex(on ? BREAK_VISOR : e.type.visor);
    // Same test the rig builds the sidearm's visibility from (see rigs.js), with
    // the break on top of it — so a type that never had one does not acquire one
    // at the end of its lunch.
    if (e.gun) e.gun.visible = !on && !e.type.melee && !e.type.neutral;
    if (e.blunt) e.blunt.visible = !on;
  }

  /**
   * The crate, on and off. Public because jobs.js is what hands it along the
   * run, and the joiner's snapshot path uses the same two — a box appearing in
   * somebody's hands has to happen exactly one way whoever decided it.
   *
   * Geometry and materials are shared and module-level (see buildCrate), so
   * there is nothing here to dispose either.
   */
  giveCrate(e) {
    if (e.carry) return;
    e.carry = buildCrate();
    e.group.add(e.carry);
  }

  takeCrate(e) {
    if (!e.carry) return;
    e.group.remove(e.carry);
    e.carry = null;
  }

  /**
   * Up to the elbows in something overhead, or not — the pose `animateFixing`
   * draws (see enemy-anim.js).
   *
   * Public because jobs.js is what decides it, and it is ONE call rather than a
   * flag anybody may set because of the rule the chair paid for: nothing but
   * `stand` puts a hinged limb back, so clearing the flag and restoring the pose
   * have to be the same operation or the body walks off the rest of the floor
   * with its arms above its head. `_standUp` makes the identical bargain for
   * `e.seat` a few lines up.
   */
  setWorking(e, on) {
    if (!e || !!e.working === !!on) return;
    e.working = !!on;
    if (!on && e.alive) stand(e);
  }

  /**
   * Which working pose a body at a machine is holding, or null for none.
   *
   * The same bargain `setWorking` makes one method up, and it is the third time
   * this file has had to make it: nothing but `stand` puts a hinged limb back or
   * lifts a stooped body out of the carpet, so clearing the pose and restoring
   * it have to be ONE operation. Left as a field anybody may write, a man who
   * stops working walks off the rest of the floor bent over a bench that is no
   * longer in front of him. `_standUp` is the same promise for a chair.
   */
  setChorePose(e, pose) {
    if (!e?.chore || e.chore.pose === (pose ?? null)) return;
    e.chore.pose = pose ?? null;
    if (!pose && e.alive) stand(e);
  }

  /**
   * The drink out of the machine, into the hand that pressed the button for it.
   *
   * PARENTED TO THE ARM, not to the body, and that is the whole of why there is
   * no pose to go with it. A tray and a crate are carried in both hands and so
   * have to fight the walk cycle for the arms (see `animate`); a can hangs at
   * somebody's side in one hand, which is exactly what an arm already does. So
   * the can is a child of the arm mesh and inherits its swing, its hinge and the
   * body's own scale for free, and nothing in enemy-anim.js has to learn it
   * exists.
   *
   * The hand is HASHED off where the machine is rather than rolled, for the
   * reason the eating hand is: it has to be stable for the run and identical in
   * both browsers of a co-op session, and the tint has to be too — so both come
   * off the same integer, and the wire carries one bit rather than a colour and
   * a side.
   *
   * `armHalf` off the rig's own joints, because a hand is not at the same place
   * on a Porter Unit as on a person and this file has paid for that assumption
   * three times (see `gunRest`, `boxAt`, and `joints` in rigs.js).
   */
  giveCan(e, key = 0) {
    if (e.can) return;
    // HELD, rather than hanging off the bottom of the hand. `drop` is negative,
    // so the can's middle sits 2.6 cm ABOVE the point the hand is at and the
    // fist closes round its lower third — which is how a can is actually
    // carried, and the whole difference between somebody holding a drink and
    // somebody with a drink stuck to their wrist. The 3 cm the default gives a
    // bundle of paper is right for paper: that is tucked under an arm, and this
    // stands up out of it.
    //
    // ...and further FORWARD, because it is now 9.4 cm across against an arm
    // 14 cm deep. At the paper's 3.5 cm the can is more inside the forearm than
    // outside it; at 7.2 the back of it is still buried in the hand, which is
    // what makes it read as gripped rather than as balanced on top of a fist,
    // and the rest of it stands proud where it can be seen.
    const held = this._inHand(e, buildCan(key), key, -0.026, 0.072);
    if (!held) return;
    e.can = held.mesh;
    e.canArm = held.arm;
    e.canTimer = CAN_TIME[0] + Math.random() * (CAN_TIME[1] - CAN_TIME[0]);
  }

  /**
   * Puts something in one of a body's hands, and hands back which one.
   *
   * PARENTED TO THE ARM, not to the body, and that is the whole reason neither
   * of the two things that use this needs a pose. A tray and a crate are carried
   * in both hands and so have to fight the walk cycle for the arms (see
   * `animate`); a can and a bundle of paper hang at somebody's side in one hand,
   * which is exactly what an arm already does. So it is a child of the arm mesh
   * and inherits its swing, its hinge and the body's own scale for free, and
   * nothing in enemy-anim.js has to learn either exists.
   *
   * The hand is HASHED off the key rather than rolled, for the reason the eating
   * hand is: it has to be stable for the run and identical in both browsers of a
   * co-op session, and there is a wire bit for WHETHER the thing is held and
   * nothing for which side it is on.
   *
   * `armHalf` comes off the rig's own joints, because a hand is not in the same
   * place on a Porter Unit as on a person and this file has paid for that
   * assumption three times already (see `gunRest`, `boxAt`, and `joints` in
   * rigs.js).
   */
  _inHand(e, mesh, key = 0, drop = 0.03, forward = 0.035) {
    const hash = Math.abs(Math.round(key)) || 1;
    const arm = (hash & 1) ? e.armR : e.armL;
    if (!arm) return null;
    const half = e.joints?.armHalf ?? 0.27;
    mesh.position.set(0, -half - drop, -forward);
    arm.add(mesh);
    return { mesh, arm };
  }

  /**
   * The paperwork, out of the printer and into a hand.
   *
   * Unlike the can this has no clock of its own: it is carried for exactly as
   * long as the errand that produced it, and `chores.js` takes it back at the
   * filing rack. A bundle left on a body after the job ended would be somebody
   * walking the rest of the floor holding a report they have already filed.
   */
  givePapers(e, key = 0) {
    if (e.papers) return;
    // Held a little higher than a can and flat rather than upright: this is a
    // stack of paper tucked against the hip, not something with a lid on it.
    const held = this._inHand(e, buildPapers(), key, -0.02);
    if (!held) return;
    e.papers = held.mesh;
    e.papersArm = held.arm;
  }

  takePapers(e) {
    if (!e.papers) return;
    (e.papersArm ?? e.group)?.remove(e.papers);
    e.papers = null;
    e.papersArm = null;
  }

  /**
   * Finished with. Geometry and materials are shared and module-level (see
   * `buildCan`), so dropping the mesh is the whole of it.
   *
   * Removed from whatever it was parented to rather than from the group, because
   * it never was on the group — a can that outlived its arm's reference would be
   * a drink floating beside a corpse.
   */
  takeCan(e) {
    if (!e.can) return;
    (e.canArm ?? e.group)?.remove(e.can);
    e.can = null;
    e.canArm = null;
    e.canTimer = 0;
  }

  _giveTray(e) {
    if (e.tray) return;
    e.tray = buildTray();
    e.group.add(e.tray);
  }

  // Geometry and materials are shared and module-level (see buildTray), so
  // there is nothing here to dispose — dropping the meshes is the whole of it.
  _takeTray(e) {
    if (!e.tray) return;
    e.group.remove(e.tray);
    e.tray = null;
  }

  // A chair back into the pool it came out of. The room is the canteen's,
  // because that is the only room this pool ever holds.
  /**
   * Sits a body down at a chair it has walked to, and stands it back up.
   *
   * Thin wrappers, and they exist so `chores.js` never touches `e.seat` itself.
   * That is the bargain `_standUp` already documents: clearing the seat and
   * restoring the pose are ONE operation, and a caller that does the first
   * without the second leaves a body walking the floor with its hips in a chair
   * that is not there. Same rule as `setChorePose`, and the same bug.
   */
  sitAt(e, station) {
    this._seat(e, station, 'desk');
  }

  standUp(e) {
    this._standUp(e);
  }

  _freeDesk(station) {
    const room = this.layout?.cafeteriaRoom;
    const free = room && this.tables?.get(room);
    if (free) free.push(station);
  }

  _inRoom(room, x, z) {
    if (!room) return false;
    const tx = this.nav.tx(x), ty = this.nav.ty(z);
    return tx >= room.x0 && tx < room.x1 && ty >= room.y0 && ty < room.y1;
  }

  // Idle staff grumble to themselves now and then, which is what tells you a
  // room is occupied before you can see into it.
  _mutter(e, dt, audio) {
    e.voiceTimer -= dt;
    if (e.voiceTimer > 0) return;
    e.voiceTimer = 7 + Math.random() * 11;
    if (e.state === 'idle') audio.enemyIdle(e);
  }

  /**
   * One frame of somebody doing the building's ordinary work, and whether they
   * are still doing it.
   *
   * This is the whole of what a hostile at a machine promises, and the promise
   * is deliberately narrow: a chair in this building means harmless (see the
   * note on workstations in CLAUDE.md), and nothing here sits anybody down. A
   * body STANDING at a printer has made no such promise — it is somebody with
   * their back to you who has not looked up yet, and the moment they do the job
   * is off and they are an ordinary body in an ordinary fight.
   *
   * Three ways they look up, and the third is the one that needed writing:
   * sight, hearing, and you being close enough to be at their elbow. Being seen
   * is the ordinary one and costs them the usual reaction delay, because they
   * spotted you across a room. Being FOUND does not — somebody who turns round
   * into you does not take three quarters of a second to think about it — so a
   * startle goes straight into `alert` with a spent timer, which `_think` on the
   * caller's very next line turns into `chase` in the same frame.
   *
   * Returns true while the body is still at work, in which case the caller skips
   * the state machine entirely: chores.js owns where this one is going.
   */
  _choreWork(e, dt, dist, sees, hears, target, audio) {
    const startled = dist < CHORE_STARTLE;
    if (!startled && !sees && !hears) {
      this.choreTick?.(e, dt, audio);
      return true;
    }

    // `choreLost` is what puts the arms back down and hands the station back —
    // clearing the flag without it is the bug the chair documents at length.
    this.choreLost?.(e);
    if (startled) {
      e.state = 'alert';
      e.timer = 0;
      e.lastSeen = { x: target.x, z: target.z };
      // ...and they have just SEEN you, whatever the grid says about line of
      // sight. Without this the chase is over the frame after it starts: a body
      // that has been standing at a machine has been out of contact for as long
      // as it has been standing there, so `_think`'s own GIVE_UP test fires on
      // the very next tick and puts it straight back to idle. Measured: startled
      // at 2.6 m, `chase` for one frame, `idle` two seconds later, still 2.6 m
      // away and no longer interested.
      e.contact = 0;
      // Somebody who has just found you standing over them says so, on the same
      // one-at-a-time budget the rest of the floor shouts on.
      if (this.shoutTimer <= 0) {
        this.shoutTimer = SHOUT_GAP;
        this.audio?.enemyAlert(e);
      }
    }
    return false;
  }

  _think(e, dt, dist, sees, hears, target) {
    e.timer -= dt;

    switch (e.state) {
      case 'idle':
        // Noticed by sight, or by the racket you make shooting.
        if (sees || hears) {
          e.state = 'alert';
          e.timer = this.tuning.reaction;
          e.lastSeen = { x: target.x, z: target.z };
          // Whoever spots you first does the shouting. The rest of the room has
          // heard him and does not need to say it again.
          if (this.shoutTimer <= 0) {
            this.shoutTimer = SHOUT_GAP;
            this.audio.enemyAlert(e);
          }
        }
        break;

      case 'alert':
        if (e.timer <= 0) e.state = 'chase';
        break;

      case 'chase':
        if (sees && dist < e.type.range) e.state = 'fight';
        // The alarm response keeps looking for a good deal longer than a clerk
        // who heard a noise: they came up here for one reason and there is no
        // desk on this floor for them to give up and go back to.
        else if (e.contact > (e.keyed ? RESPONSE_PATIENCE : GIVE_UP)) {
          e.state = 'idle';
          e.lastSeen = null;
        }
        break;

      case 'fight':
        if (!sees || dist > e.type.range + 3) { e.state = 'chase'; }
        break;
    }
  }

  /**
   * Walk. The route comes off the shared distance field; everything here is
   * about the last metre of it, which is where a floor full of people actually
   * comes unstuck — in a doorway, behind each other.
   *
   * A doorway is 1.5 m and a body is 0.72 m across, so two of them fit through
   * it side by side with nothing to spare. That is the geometry that has to be
   * survived, and three things here do it: they stop shoving each other in tight
   * spots, they stop circling in them, and when they do get wedged they sidestep
   * along the wall instead of standing there pushing into it.
   */
  _move(e, dt, dx, dz, dist, sees) {
    const speed = this.tuning.speed * e.type.speed;
    // "Tight" is anywhere a body and a half does not fit: a doorway, the gap
    // between two desks, the corner of a stairwell.
    const tight = !this.nav.clear(e.x, e.z, RADIUS * 1.7, e.layer);
    let vx = 0, vz = 0;

    if (e.state === 'chase' && e.lastSeen) {
      // A badge holder walks the field that has the locked doorways in it. On a
      // floor with nothing locked left the two fields are the same field.
      const dir = e.keyed
        ? this.nav.descendBadge(e.x, e.z, this._v, e.layer)
        : this.nav.descend(e.x, e.z, this._v, e.layer);
      // The field's own downhill step is what takes a body onto a staircase: the
      // other layer is just another neighbour of a stairwell tile. So the layer an
      // enemy is on is not a decision made here, it is read back off the step.
      if (dir) { e.layer = dir.layer ?? e.layer; vx = dir.x * speed; vz = dir.z * speed; }
      else if (dist > 1.2) { vx = (dx / dist) * speed * 0.5; vz = (dz / dist) * speed * 0.5; }
    } else if (e.state === 'fight') {
      // Hold a firing distance and sidestep, so a firefight isn't two statues.
      // Melee types have no standoff to hold — they just keep coming.
      const nx = dx / dist, nz = dz / dist;
      let advance = 0;
      if (e.type.melee) advance = dist > 1.1 ? 1 : 0;
      else if (dist > PREFERRED + 1.5) advance = 1;
      else if (dist < TOO_CLOSE) advance = -1;

      vx = nx * advance * speed;
      vz = nz * advance * speed;
      // Circling is for open floor. In a doorway it is just grinding along the
      // jamb, and with a queue behind you it is what turns a doorway into a plug.
      const circle = tight ? 0 : (e.type.melee ? 0.15 : 0.45);
      vx += -nz * e.strafe * speed * circle;
      vz += nx * e.strafe * speed * circle;
    }

    if (vx || vz) {
      const blockedX = !this._tryMove(e, vx * dt, 0);
      const blockedZ = !this._tryMove(e, 0, vz * dt);

      if (blockedX && blockedZ) {
        // Nose-first into something. Axis-splitting already handles a wall you
        // hit at an angle; what is left is walking straight at one, which is
        // what a doorway you are half a metre to the side of looks like. So
        // sidestep — one way, then the other — and let the field take over
        // again as soon as anything opens up.
        e.stuck += dt;
        const len = Math.hypot(vx, vz) || 1;
        const px = -vz / len, pz = vx / len;
        const step = speed * dt;
        if (!this._tryMove(e, px * e.strafe * step, pz * e.strafe * step)) {
          e.strafe *= -1;
          this._tryMove(e, px * e.strafe * step, pz * e.strafe * step);
        }
      } else {
        e.stuck = 0;
        // Bounced off a wall while circling? Circle the other way instead of
        // grinding along it.
        if ((blockedX || blockedZ) && e.state === 'fight') e.strafe *= -1;
      }
    }

    // Not in a doorway. Two bodies that barely fit through one will push each
    // other into the jamb and both stop, and everyone behind them stops too —
    // so in tight spots they queue instead of jostling.
    if (!tight) this._separate(e, dt);

    e.group.position.x = e.x;
    e.group.position.z = e.z;
    // On a staircase this is the ramp, on a level it is that level's floor, and on
    // the ground floor it is zero — one lookup rather than a special case per state.
    e.y = this.nav.heightAt(e.x, e.z, e.layer);
    e.group.position.y = e.y;

    // Face the player when engaged, otherwise face where you're walking.
    const wantYaw = (e.state === 'fight' || e.state === 'alert' || sees)
      ? Math.atan2(-dx, -dz)
      : (vx || vz) ? Math.atan2(-vx, -vz) : e.yaw;
    e.yaw = angleLerp(e.yaw, wantYaw, smoothTo(9, dt));
    e.group.rotation.y = e.yaw;
  }

  _tryMove(e, dx, dz) {
    const nx = e.x + dx;
    const nz = e.z + dz;
    // Whoever routes through a locked doorway has to be allowed to stand in it
    // as well. Route on one grid and collide against another and a body grinds
    // against a panel that has already opened for it.
    const ok = e.keyed
      ? this.nav.clearBadge(nx, nz, RADIUS)
      : this.nav.clear(nx, nz, RADIUS, e.layer);
    if (!ok) return false;
    e.x = nx;
    e.z = nz;
    return true;
  }

  /**
   * Bucket every living body by cell, once per frame.
   *
   * `_separate` used to walk the whole roster for each enemy — described as
   * "cheap O(n^2), but n is small", which stopped being true: the difficulty
   * curve reaches 200 on a deep floor, and `items` keeps the dead as well, so
   * the loop was up to 40,000 distance tests a frame and growing quadratically
   * with exactly the number the game raises as you descend. Nobody more than
   * SEPARATION away can push anybody, so all but a handful of those tests were
   * arithmetic performed to reject a body in another room.
   *
   * The cell is SEPARATION across, so a query is the 3x3 block around a body and
   * cannot miss a neighbour close enough to matter. Keys are packed integers
   * rather than strings: this runs every frame and string keys would trade the
   * distance tests for allocations.
   */
  _rebuildNeighbours() {
    this._cells.clear();
    this.keyedAlive = 0;
    for (const e of this.items) {
      if (!e.alive) continue;
      if (e.keyed) this.keyedAlive++;
      const key = cellKey(e.x, e.z);
      const bucket = this._cells.get(key);
      if (bucket) bucket.push(e);
      else this._cells.set(key, [e]);
    }
  }

  /**
   * The nearest living body within `r` of a point on the same level, or null.
   *
   * Off the same per-frame bucket grid `_separate` uses, because the alternative
   * is what this file has already been caught doing three times: a loop over the
   * whole roster for every one of a growing number of things. A floor carries up
   * to 200 bodies and a room's worth of cardboard, and the crush test asks this
   * once per carton per frame.
   *
   * `y` is which level the asker is standing on, not a tolerance to be tuned: a
   * body one storey below a box in an attic is not standing on it, however exactly
   * the tiles line up.
   */
  anyNear(x, z, y, r) {
    const cx = Math.floor(x / SEPARATION), cz = Math.floor(z / SEPARATION);
    const reach = Math.ceil(r / SEPARATION);
    const r2 = r * r;
    for (let gz = cz - reach; gz <= cz + reach; gz++) {
      for (let gx = cx - reach; gx <= cx + reach; gx++) {
        const bucket = this._cells.get(packCell(gx, gz));
        if (!bucket) continue;
        for (const e of bucket) {
          if (!e.alive || Math.abs(e.y - y) > SAME_LEVEL) continue;
          const dx = e.x - x, dz = e.z - z;
          if (dx * dx + dz * dz <= r2) return e;
        }
      }
    }
    return null;
  }

  // Keep bodies from occupying the same tile.
  _separate(e, dt) {
    const cx = Math.floor(e.x / SEPARATION);
    const cz = Math.floor(e.z / SEPARATION);
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const bucket = this._cells.get(packCell(gx, gz));
        if (!bucket) continue;
        for (const other of bucket) {
          if (other === e || !other.alive) continue;
          // Two bodies on different levels are not in each other's way, however
          // exactly the tiles line up — one of them is a storey above the other.
          if (other.layer !== e.layer) continue;
          const dx = e.x - other.x;
          const dz = e.z - other.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > SEPARATION_SQ || d2 < 1e-6) continue;

          const d = Math.sqrt(d2);
          const push = (SEPARATION - d) * dt * 4;
          this._tryMove(e, (dx / d) * push, (dz / d) * push);
        }
      }
    }
  }

  _shoot(e, dt, dist, sees, target, effects, audio) {
    const px = target.x, py = target.y, pz = target.z;
    e.fireCooldown -= dt;

    // A swing already in flight connects part-way through, and only if you're
    // still inside the weapon's reach when it comes down.
    if (e.swing > 0 && !e.swingLanded && e.swing <= SWING_TIME * 0.45) {
      e.swingLanded = true;
      if (dist < e.type.range + e.bluntReach) {
        // The target owns what being hurt means. For the player at this keyboard
        // that is health, a red rim and a chevron pointing at whoever did it; for
        // the other player in a co-op session it is a message on the wire, and
        // nothing in this file has to know which of the two it is talking to.
        target.hurt(this.tuning.damage * e.type.damage, e.x, e.z);
        audio.meleeHit();
      }
    }

    // How long they have had you lined up, and how long they need. Ticked before
    // the returns below, because losing sight of you is precisely when it has to
    // start draining.
    const need = this.tuning.aim * (e.type.aimMul ?? 1);
    const onTarget = sees && e.state === 'fight'
      && Math.abs(angleDelta(e.yaw, Math.atan2(-(px - e.x), -(pz - e.z)))) < AIM_CONE;
    e.aim = onTarget
      ? Math.min(e.aim + dt, need * AIM_BANK)
      : Math.max(0, e.aim - dt * AIM_DRAIN);

    if (e.state !== 'fight' || !sees || dist > e.type.range) return;
    if (e.fireCooldown > 0) return;

    const type = e.type;
    // The aim window, and the one thing that can hold a shot back with everything
    // else about it ready. `aimMul` is how fast this type gets on target — a
    // machine built to watch a corridor against somebody who was doing a
    // spreadsheet ninety seconds ago. See enemy-types.js.
    if (!type.melee && e.aim < need) return;
    e.fireCooldown = this.tuning.fireInterval * type.rate * (0.75 + Math.random() * 0.5);

    // Melee types don't shoot: they swing, and the hit lands mid-swing rather
    // than on the wind-up, so you get a moment to back out of reach.
    if (type.melee) {
      e.swing = SWING_TIME;
      e.swingLanded = false;
      audio.enemyMeleeSwing(e);
      return;
    }

    // Muzzle in world space, from the gun the model is actually holding.
    e.gun.getWorldPosition(this._muzzle);

    // Sample the spread as a real angle, then turn it into a miss distance at
    // the player's range: distance genuinely protects you.
    const angle = this.tuning.spread * type.spread * Math.sqrt(Math.random());
    const miss = Math.tan(angle) * dist;
    const hit = miss < 0.5;

    const spin = Math.random() * Math.PI * 2;
    this._aim.set(
      px + Math.cos(spin) * miss,
      py - 0.1 + (Math.random() - 0.5) * 0.2,
      pz + Math.sin(spin) * miss
    );
    if (hit) this._aim.set(px, py - 0.15, pz);

    effects.tracer(this._muzzle, this._aim);
    // Bigger types carry bigger guns, and a flash you can size up across a room
    // is half of knowing what is shooting at you.
    effects.muzzle(this._muzzle, type.scale);
    // Heavier types fire lower, so you can hear what's shooting you.
    audio.enemyShot(e);
    // The other end of a co-op session cannot see this happen — its roster is
    // posed from snapshots and never runs `_shoot` at all — so a shot fired here
    // has to be told, or the staff over there kill the joiner in silence with
    // their arms by their sides.
    this.onFire?.(e, this._muzzle, this._aim);

    if (hit) target.hurt(this.tuning.damage * type.damage, e.x, e.z);
  }

  // --- co-op: the roster over the wire ---------------------------------------

  /**
   * Fills `out` with a snapshot of whoever is worth sending, and returns how
   * many numbers it wrote. Host side only.
   *
   * Two things bound the cost, and both are needed. The RANGE test is what makes
   * this affordable at all — a deep floor holds two hundred people and all but a
   * handful of them are sitting in offices nobody is anywhere near, and a body
   * neither player can see does not need a position. The CAP is what bounds one
   * packet, because a real firefight can legitimately have forty bodies moving
   * inside that range. Together with the round-robin cursor they mean everything
   * in range is covered within a few packets rather than the same first forty
   * being sent for ever.
   *
   * A dead body is never sent. Death is its own message — it has to carry which
   * shot did it, and it has to arrive exactly once.
   */
  snapshot(out, targets) {
    const n = this.items.length;
    if (!n) return 0;

    let written = 0;
    let scanned = 0;
    let i = this._snapCursor % n;

    while (scanned < n && written < SNAP_CAP * SNAP_STRIDE) {
      const e = this.items[i];
      scanned++;
      i = (i + 1) % n;
      if (!e.alive) continue;

      let near = false;
      for (const t of targets) {
        if (Math.hypot(t.x - e.x, t.z - e.z) < SYNC_RANGE) { near = true; break; }
      }
      if (!near) continue;

      out[written++] = e.index;
      out[written++] = Math.round(e.x * SNAP_UNIT);
      out[written++] = Math.round(e.z * SNAP_UNIT);
      out[written++] = Math.round(e.y * SNAP_UNIT);
      out[written++] = Math.round(e.yaw * SNAP_UNIT);
      // One slot for everything that is not a coordinate, three bits of state
      // and three flags. `animate` poses off all of them and none is worth a
      // number of its own.
      out[written++] = SNAP_STATES.indexOf(e.state)
        + (e.seat ? SNAP_SEAT : 0)
        + (e.break ? SNAP_BREAK : 0)
        + (e.tray ? SNAP_TRAY : 0)
        + (e.carry ? SNAP_BOX : 0)
        + (e.can ? SNAP_CAN : 0)
        + (e.papers ? SNAP_PAPERS : 0);
    }

    this._snapCursor = i;
    return written;
  }

  /** Takes one of those. Joiner side only. */
  applySnapshot(a) {
    for (let k = 0; k + SNAP_STRIDE <= a.length; k += SNAP_STRIDE) {
      const e = this.items[a[k]];
      // A packet from a floor we have already left, or from one we have not
      // built yet. Dropping it is right: `netplay.js` stamps every snapshot with
      // its floor and only hands over the ones that match, so anything that gets
      // this far is a body that has since been cleared away.
      if (!e || !e.alive) continue;

      e.netX = a[k + 1] / SNAP_UNIT;
      e.netZ = a[k + 2] / SNAP_UNIT;
      e.netY = a[k + 3] / SNAP_UNIT;
      e.netYaw = a[k + 4] / SNAP_UNIT;
      const packed = a[k + 5];
      // Whether they are still sitting is the host's; WHICH seat it is is a fact
      // about the floor. A chair a body was placed in came from the same seed on
      // both ends — but a chair it WALKED to did not, because whose turn it is
      // at the counter is decided at runtime and only the host decides it. So
      // the break bit answers that: on a break, the seat is a canteen table by
      // construction, since that is the only seat a break ever ends at.
      if (!(packed & SNAP_SEAT)) e.seat = null;
      else e.seat ??= (packed & SNAP_BREAK) || e.type.dines ? 'table' : 'desk';

      // The break itself, which is the visor and the empty hands. Kept as a
      // plain flag rather than the host's own `break` object: the joiner runs no
      // part of the cycle, it only has to draw the body correctly, and giving it
      // a half-populated stage machine is how it would end up trying to.
      const onBreak = !!(packed & SNAP_BREAK);
      if (onBreak !== !!e.break) {
        e.break = onBreak ? { stage: 'net', at: null, seat: null, timer: 0 } : null;
        this._lunchLook(e, onBreak);
      }
      if (!!(packed & SNAP_TRAY) !== !!e.tray) {
        if (packed & SNAP_TRAY) this._giveTray(e); else this._takeTray(e);
      }
      // The crate, kept as the mesh alone and no run behind it. A joiner runs no
      // part of a parcel run for the same reason it runs no part of a lunch: it
      // only has to draw the body correctly, and half a stage machine is how it
      // would end up trying to do more than that.
      if (!!(packed & SNAP_BOX) !== !!e.carry) {
        if (packed & SNAP_BOX) this.giveCrate(e); else this.takeCrate(e);
      }
      // The can, and the one place a derived value beats a sent one: which hand
      // it is in and what flavour it is are both hashed off the body's index
      // here rather than off the machine, because the joiner has no idea which
      // machine it came out of — and it does not need to agree with the host on
      // either. What it must not do is hold the drink in a hand that is not
      // there, so the hash is the index, which both ends have.
      if (!!(packed & SNAP_CAN) !== !!e.can) {
        if (packed & SNAP_CAN) this.giveCan(e, e.index + 1); else this.takeCan(e);
      }
      if (!!(packed & SNAP_PAPERS) !== !!e.papers) {
        if (packed & SNAP_PAPERS) this.givePapers(e, e.index + 1); else this.takePapers(e);
      }
      e.state = SNAP_STATES[packed & 7] ?? 'idle';
    }
  }

  /**
   * A frame of a posed roster: walk everybody toward where the last packet put
   * them, and animate them there. Joiner side only.
   *
   * The lerp is the whole reason this looks like a game rather than like a
   * network trace. Packets arrive a dozen times a second and frames happen sixty
   * times a second, so a body written straight to its last reported position
   * steps five times a second and stands still in between. Pulled toward it
   * instead, it walks — and `animate` is already reading `state` to decide
   * whether the legs should be moving, so a body that is chasing you looks like
   * it is chasing you even between packets.
   */
  _poseAll(dt, audio) {
    const k = smoothTo(POSE_RATE, dt);

    for (const e of this.items) {
      if (!e.alive) { die(e, dt); continue; }

      // Somebody who has been out of range and is now back is not somebody who
      // ran here — put them where they are.
      if (Math.hypot(e.netX - e.x, e.netZ - e.z) > POSE_SNAP) {
        e.x = e.netX; e.z = e.netZ; e.y = e.netY; e.yaw = e.netYaw;
      } else {
        e.x += (e.netX - e.x) * k;
        e.z += (e.netZ - e.z) * k;
        e.y += (e.netY - e.y) * k;
        e.yaw = angleLerp(e.yaw, e.netYaw, k);
      }

      e.group.position.set(e.x, e.y, e.z);
      e.group.rotation.y = e.yaw;
      animate(e, dt, audio);
      if (!e.neutral) this._mutter(e, dt, audio);
    }
  }

  /**
   * The four the host sent up after an alarm, rebuilt here. Joiner side only.
   *
   * They are the one part of the roster the seed cannot produce, because they
   * did not exist when the floor was generated — so the host shares what each of
   * them was rolled from and this builds the same man from it. Returns their
   * hitboxes, which the caller has to hand to `shooting`: an enemy that arrived
   * after the floor did is not in the raycast list, and bullets go straight
   * through him.
   */
  addResponders(list) {
    const meshes = [];
    for (const d of list ?? []) {
      const type = d.baton ? TYPES.guardBaton : TYPES.security;
      const e = this._add(d.x, d.z, makeRng(d.seed), this.tuning, type);
      e.card = d.card ?? null;
      this._keyed(e);
      e.state = 'chase';
      e.contact = 0;
      e.lastSeen = { x: d.x, z: d.z };
      meshes.push(...e.hitboxes);
    }
    return meshes;
  }

  // Called on every new floor. Materials are per-enemy (so a hit flash on one
  // doesn't light up the floor) and weapon geometry is per-enemy, so both have
  // to be released here or a long run bleeds GPU memory one floor at a time.
  clear() {
    for (const e of this.items) {
      // A running motor outlives its floor otherwise: the loop is held by the
      // audio engine, not by the scene graph, so removing the mesh leaves it
      // droning over the next floor from wherever this one used to be.
      if (e.motor) { this.audio?.stopMotor(e.motor); e.motor = null; }
      this.scene.remove(e.group);
      for (const m of Object.values(e.mats)) m.dispose();
      for (const g of e.ownGeo) g.dispose();
    }
    this.items.length = 0;
    this.meshes.length = 0;
    // The desks belong to the floor being torn down, and every one of them holds
    // a reference to one of its rooms. So do the canteen's chairs and its
    // counter, which is the same fact one room along.
    this.desks.clear();
    this.tables?.clear();
    this.stations?.clear();
    this.servery = [];
    this.shelves = [];
    this.trayRack = null;
  }

  dispose() { this.clear(); }
}

/**
 * The floor's desks, bucketed by the room each one is in.
 *
 * Shuffled inside each bucket, because the furnisher lays a cubicle farm out row
 * by row: taken in order, the desk the Manager is found at is the pod nearest
 * one corner of his office every single time.
 *
 * The rest of a room's stations are counted rather than taken — how many there
 * are is what sizes the shift the room is dealt (see DESK_TEAM), and the shift
 * works standing up.
 *
 * Keyed on the room object itself. Both browsers in a co-op session generated
 * the same floor from the same seed, so these are the same desks in the same
 * order on both ends and the two bodies that do sit down sit in the same chairs.
 */
function deskPool(workstations, nav, rng, at, nudge = 0) {
  const by = new Map();
  for (const w of workstations) {
    // Desks and canteen tables come through the same call and are pooled apart,
    // because what they mean is different: a desk is a job and a table is lunch.
    // Mixed, a cafeteria's ten chairs would read to _spawnPoints as a room with
    // ten jobs going in it and it would be dealt a shift to match.
    if (w.at !== at) continue;
    // A desk the furnisher could not attribute to a room — nothing in the
    // catalogue places one outside a room today, and a corridor full of unowned
    // workstations would be dealt to whoever asked first.
    if (!w.room) continue;
    // A chair a whole body does not fit in front of, which is a third of the
    // pods in a cubicle farm: the pitch is tight, and the nav grid holds a body
    // to whole tiles. Dropped here rather than refused at the door, because how
    // many desks a room has is what decides how big a shift it is dealt (see
    // _spawnPoints) — counting stations nobody can sit at deals a farm five
    // people and then stands all five of them up.
    //
    // Asked of `fits` rather than with `nav.clear`, and the difference is the
    // whole bug. `clear` is a point test: can a body of this radius stand at
    // this exact spot. `fits` is that same test taken at the TILE CENTRE, and it
    // is what every flood and every `descendOn` runs on — so a chair tucked into
    // the corner of a tile passes `clear` and fails `fits`, and a body seated
    // there can stand up perfectly well and then never route anywhere for the
    // rest of the run. Measured on a canteen chair that a player shot: 400
    // destination picks, 0 accepted, 101 of them refused at `descendOn` because
    // the body's own tile was not on the field. He stood at the table walking on
    // the spot until the floor ended.
    //
    // It costs seats — a chair that only just fits is now no chair at all — and
    // that is the right trade in both directions: the two set pieces this pool
    // has always fed (the Manager, the guard on the cameras) get up to FIGHT
    // you, and one that cannot leave its desk is worse than one that never sat
    // at it.
    const spot = standable(w, nav, nudge);
    if (!spot) continue;
    const list = by.get(w.room);
    if (list) list.push(spot);
    else by.set(w.room, [spot]);
  }
  for (const list of by.values()) rng.shuffle(list);
  return by;
}

/**
 * Where a body actually stands at this station, or null if it cannot stand there.
 *
 * A CHAIR may not move: the pose is drawn relative to the seat under it, so a
 * station that fails is simply not a seat. A place to STAND may, and that is the
 * whole of what `nudge` is — the caller says which kind it is asking about.
 *
 * It exists because of an off-by-a-tile that made two of the six jobs in
 * chores.js impossible. `fits` is the walk grid eroded by a body's radius, and
 * with a 0.5 m tile against a 0.4 m radius that erosion takes every tile
 * ORTHOGONALLY ADJACENT to a blocked one — so whether a body fits in front of a
 * copier is not really a question about how far in front it is standing, it is a
 * question about which tile that lands in. Measured on one floor: every printer
 * station and every vending station on it failed, and moving the point 0.2 m
 * further out recovered all six vending machines and six of ten copiers. The
 * four that never recover are machines in rooms with genuinely nowhere to stand,
 * and dropping those is correct.
 *
 * Backwards, never sideways, and capped at NUDGE_MAX — about one tile. Backwards
 * keeps the body square to the thing it came to use, which is what the pose is
 * drawn for, and the cap is what stops "somewhere to stand at the copier" from
 * quietly becoming "somewhere in the room".
 *
 * The moved station is a COPY. The raw list is shared between every pool built
 * off it, and a desk whose chair sits somewhere else because a standing job
 * nudged the record is the kind of bug that only shows up two features later.
 */
function standable(w, nav, nudge) {
  if (nav.fitsAt(nav.tx(w.x), nav.ty(w.z))) return w;
  if (nudge <= 0) return null;
  const [fx, fz] = FACING[w.rot & 3];
  for (let back = NUDGE_STEP; back <= nudge + 1e-6; back += NUDGE_STEP) {
    const x = w.x - fx * back;
    const z = w.z - fz * back;
    if (nav.fitsAt(nav.tx(x), nav.ty(z))) return { ...w, x, z };
  }
  return null;
}

// Corridor waypoints for the panicking staffer. Sampled rather than exhaustive:
// he only needs somewhere to be running to, and a floor holds thousands of
// corridor tiles.
function collectCorridors(layout, nav) {
  const spots = [];
  const { W, H, tiles } = layout;
  let n = 0;
  for (let ty = 1; ty < H - 1; ty++) {
    for (let tx = 1; tx < W - 1; tx++) {
      if (tiles[ty * W + tx] !== CORRIDOR) continue;
      if (n++ % CORRIDOR_SAMPLE) continue;
      const x = worldX(layout, tx + 0.5);
      const z = worldZ(layout, ty + 0.5);
      if (nav.clear(x, z, RADIUS)) spots.push({ x, z });
    }
  }
  return spots;
}
