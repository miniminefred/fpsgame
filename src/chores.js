import * as THREE from 'three';
import { FACING } from './gen/tiles.js';
import { isMachine } from './enemy-types.js';

/**
 * The ordinary work: one body, one machine, a few seconds of doing something.
 *
 * The building already had two pieces of visible work in it and both were
 * exceptional. A parcel run (jobs.js) is three machines and a box, and it only
 * happens on the one floor in seven that runs parcel lines. Lunch is one break
 * per body per floor, in the one room the floor arrives in. Everywhere else, an
 * office of a hundred and seventy people was a hundred and seventy people
 * standing in rooms waiting to be shot — which is what this is for. Somebody is
 * at the copier. Somebody is round the back of a rack with his arms in it.
 * Somebody is getting a can out of the machine in the corridor.
 *
 * ...AND SOME ERRANDS ARE MORE THAN ONE MACHINE. See ROUTINES below: a body
 * writes something at its desk, prints it, squares it up and puts a band round
 * it, carries it across the floor and files it on a rack. Same walking, same
 * poses, same endings — a routine is a LIST of legs and each leg is an ordinary
 * job that happens to have somewhere to go afterwards.
 *
 * THE JOBS, and they are the whole design rather than a list that grew:
 *
 *   deskWork  sitting at a desk, typing
 *   computer  standing at somebody else's monitor, typing
 *   printer   pressing the copier, then taking the paper out of it
 *   vending   pressing the keypad, then bending to the flap
 *   server    hands up among the units at the front of a rack
 *   bench     building something, in the odd shower of sparks
 *   panel     arms into a hole in the wall with the wiring hanging out of it
 *   file      putting something away on a storage rack (a routine's last leg)
 *
 * The last one is the machine floor's, because a hole in the wall with the
 * building's wiring in it is a thing an Automated floor has and an ordinary
 * office does not (see panels.js). The other five are everywhere, because a
 * copier is everywhere.
 *
 * THEY ARE DOING IT, NOT PRETENDING TO. Everything here is the errand machinery
 * lunch and the parcel runs already share: `routeTo` floods a field to the
 * station, `advanceTo` walks it, `standAt` turns them to face the thing.
 * Nothing about the walk is new and none of the hard-won parts of it had to be
 * written twice — both halves of the reachability check, the once-only re-flood
 * on a wedge, and the unhurried pace that keeps somebody walking to a job from
 * reading as somebody who has noticed you.
 *
 * WHAT IS NEW IS WHO. Lunch and the parcel runs are both walked by bodies that
 * are out of the state machine — a neutral, or an employee whose visor has gone
 * blue. These are walked by ANYBODY, hostile included, and the hostile is the
 * point: you round a corner and there is a man at the printer with his back to
 * you, and he turns round and shoots. Three things make that safe to promise:
 *
 *   - THEY DO SIT DOWN, and A CHAIR NO LONGER MEANS HARMLESS. It used to: that
 *     was the one tell the game stated before anything was at stake, and every
 *     pose here was standing to keep it true. It was retired deliberately, and
 *     what a chair means now is "this one has not noticed you yet" — which is a
 *     weaker promise but still a real one, because the frame a body clocks you
 *     the job is off and it is on its feet. An office of a hundred and seventy
 *     people all standing up was the price of the stronger rule, and it was too
 *     high. `deskWork` is the seated job; `computer` is what a machine does at a
 *     desk instead, because a chassis has wheels where a pair of hips would be.
 *   - THE VISOR IS UNTOUCHED. A break recolours the eyes because a break really
 *     does stop somebody fighting you; this does not, so it must not. That is
 *     now the ONLY thing on a body that promises it will not shoot back, which
 *     makes it more load-bearing than it was rather than less.
 *   - AND THEY LOOK UP. Sight, hearing, or you simply getting close ends the job
 *     on the spot — see `_choreWork` in enemies.js, which is the half of this
 *     feature that lives over there because it has to run before `_think`. This
 *     is what the chair's weaker promise rests on entirely, so it matters more
 *     than it did too.
 *
 * HOST ONLY, like both of the others and for their reason: whose turn it is to
 * use the copier is a runtime decision, so two browsers deciding it would be two
 * different offices. Nothing about it crosses the wire, and nothing needs to —
 * the bodies cross as the positions they already crossed as, and unlike a tray
 * or a crate a working pose is not a claim about what somebody is going to do.
 * A joiner sees them standing where they are standing, which is true.
 */

// The six, and everything that differs between them.
//
//   at     the station name the furnisher publishes them under (see WORK_AT in
//          gen/rooms.js), or 'panel', which panels.js supplies instead
//   pose   the key into CHORE_POSE in enemy-anim.js
//   time   how long the job takes
//   then   an optional second beat, with its own pose and its own clock. Two of
//          them have one, and it is what turns a machine you press into a
//          machine that gives you something: the paper comes out of the copier,
//          the can comes out of the vending machine. Without it both were a man
//          standing at a box prodding it for twenty seconds.
//   spark  what comes off the work, if anything does, and how high
//   weight how often this job is the one that gets picked
//   stay   how many goes somebody has before they leave the machine. See below:
//          it is the difference between an office and a corridor full of people
//          on their way to one, and `vending` has it at 1 because you get your
//          can and you go.
//
// Weighted rather than drawn from the pooled stations, and that is a fix rather
// than a preference: a desk publishes TWO computer spots and a floor has forty
// desks, so a uniform draw over every station on the floor is eighty chances at
// a keyboard against four at a bench. Weighting by JOB asks the question that
// was meant — what is somebody doing — and then finds a machine for it.
const CHORES = {
  // SITTING DOWN AT A DESK AND WORKING, which is what most of an office is
  // doing most of the time and is now the commonest thing on the floor.
  //
  // `sit` is the whole of what makes it different, and it costs no animation:
  // `animate` already dispatches a body with `e.seat` set to `animateWorking`,
  // which is the typing pose the Manager and the guard on the cameras have always
  // used. What it needed was a knee (see `sitLegs` in enemy-anim.js) and a chair
  // to sit on — and the chair has to be the `desk` station itself rather than the
  // `computer` one beside it, because a seated pose is drawn relative to the seat.
  //
  // `human` because a chassis has no business in a chair: a Clerk Unit's legs are
  // drive wheels. It keeps `computer` below instead, which is the honest picture.
  deskWork: {
    at: 'chair', pose: null, sit: true, human: true,
    time: [16, 34], weight: 5, stay: [2, 4],
  },
  // Standing at the END of somebody's desk, which is what it was for everybody
  // before `deskWork` existed. Kept, and kept at a low weight, because it is a
  // real thing that happens in an office — somebody has come over to look at
  // your screen — and because it is what a machine does at a desk.
  computer: { at: 'computer', pose: 'computer', time: [14, 30], weight: 1, stay: [3, 7] },
  printer: {
    at: 'printer', pose: 'printer', time: [8, 17], weight: 3, stay: [2, 4],
    then: { pose: 'printerTake', time: [2.2, 3.6] },
  },
  vending: {
    at: 'vending', pose: 'vending', time: [3.5, 7], weight: 2, stay: [1, 1],
    // ...and they walk away WITH IT. `gives` is the only thing on this table
    // that outlives the job: everything else here is a pose and a clock, and a
    // can is a thing in somebody's hand for the next half minute (see `giveCan`
    // in enemies.js, which owns the clock for exactly that reason).
    //
    // It arrives at the END of the second beat rather than at its start, because
    // the second beat IS bending to the flap — the can appearing before the hand
    // has got there is the machine dispensing into thin air. Which was the
    // whole bug: a man queued at the machine, pressed it, bent down, and stood
    // up with nothing, so the one job on the floor that is supposed to give you
    // something was the one job that visibly did not.
    then: { pose: 'vendingTake', time: [1.8, 3.2], gives: 'can' },
  },
  server: { at: 'server', pose: 'server', time: [12, 26], weight: 3, stay: [2, 5] },
  // Putting something away on a storage rack. `weight: 0` — it is never the
  // whole of what somebody is doing, only the last leg of a routine, because
  // walking to a rack to file nothing is not a job. Same pose as working on a
  // rack: it is the same motion at the same shelf heights.
  file: { at: 'shelf', pose: 'server', time: [4, 9], weight: 0, stay: [1, 1] },
  bench: {
    at: 'bench', pose: 'bench', time: [16, 34], weight: 3, stay: [2, 5],
    spark: { y: 1.05, out: 0.55, tick: [0.9, 2.4] },
  },
  panel: {
    at: 'panel', pose: 'panel', time: [16, 34], weight: 4, stay: [2, 5],
    spark: { y: 1.55, out: 0.6, tick: [0.45, 1.1] },
  },
  // TAKING A BOX OFF A RACK, AND PUTTING ONE BACK ON ANOTHER.
  //
  // Both `weight: 0` and both only ever the legs of `stocktake` below, for
  // `file`'s reason: walking to a rack to take nothing off it is not a job, and
  // walking to one carrying nothing to put away is not either. What makes them a
  // pair is the box — `gives` puts one in the body's arms at the end of the first
  // and `takes` is checked against what it is actually holding at the end of the
  // second, so a leg that was skipped cannot leave somebody filing a crate they
  // never picked up.
  //
  // `at: 'racks'` is the one station kind that is two: a storeroom's shelving and
  // an archive's bookshelves, which are pooled apart everywhere else because a
  // parcel run may start at one and not the other (see `storage` and `archive` in
  // gen/rooms.js). Taking something off a shelf and putting it back somewhere
  // else is the same errand in either room, so this is the one place they are the
  // same thing.
  fetchBox: {
    at: 'racks', pose: 'server', time: [5, 11], weight: 0, stay: [1, 1],
    then: { pose: 'shelfTake', time: [2.4, 4.0], gives: 'box' },
  },
  // ...and putting it back, which is one beat rather than two: the box leaves the
  // arms when the leg ends (`takes` is checked in `_finishGo`), so a second beat
  // after it would be somebody pushing a box onto a shelf while still holding it.
  stowBox: {
    at: 'racks', pose: 'shelfTake', time: [4, 8], weight: 0, stay: [1, 1],
    takes: 'box',
  },
  // THE MEETING, which is the one thing on this table that is not one body doing
  // one thing. Both kinds are `weight: 0` — neither is ever rolled on its own,
  // because a lone body standing at a whiteboard talking to an empty room is
  // not a meeting and a lone body sitting at a meeting table is somebody who
  // has wandered in. They are only ever cast together, by `_tryMeeting`.
  //
  // `human` on both: a meeting is staff. A machine's break is the dock in the
  // break room (see `charger` in gen/props.js), which is the same argument
  // `_lunchOk` has always made about the canteen.
  present: {
    at: 'board', pose: 'present', time: [15, 30], weight: 0, stay: [2, 4],
    human: true,
  },
  attend: {
    at: 'meeting', pose: null, sit: true, seatAs: 'meeting', human: true,
    time: [17, 34], weight: 0, stay: [2, 4],
  },
  // THE POST GOING OUT: a box off a mailroom rack, and out of the building by
  // the lift. Two legs of `postrun` below, so both are `weight: 0` for
  // `fetchBox`'s reason.
  //
  // `neutral: true` is the third of these flags after `human` and `machine`, and
  // it is the only one that is about DISPOSITION rather than shape. Whoever does
  // this walks the length of a floor with their arms full and their back to
  // everything, so it is a courier's errand and not an armed employee's — and it
  // is the only thing on the table where meeting the person doing it is supposed
  // to cost you nothing.
  fetchPost: {
    at: 'mail', pose: 'server', time: [4, 9], weight: 0, stay: [1, 1], neutral: true,
    then: { pose: 'shelfTake', time: [2.4, 4.0], gives: 'box' },
  },
  sendPost: {
    at: 'lift', pose: 'shelfTake', time: [3, 6], weight: 0, stay: [1, 1], neutral: true,
    takes: 'box', shared: true,
  },
  // A COLLECTION: somebody who does not work here takes a crate off a rack and
  // carries it out of the building. Two legs of `collection` below, and they are
  // very nearly `fetchBox` and `sendPost` — which is the point. The errand was
  // already spelled out on this table; what is new is who walks it and that he
  // is gone at the end of it.
  //
  // `trade: true` on both, so neither is on the general list and no employee is
  // ever dealt one. The Contractor's own `works` is exactly these two, so the
  // pairing is closed from both ends: only he does this, and he does only this.
  takeCrate: {
    at: 'racks', pose: 'server', time: [3, 6], weight: 0, stay: [1, 1],
    neutral: true, trade: true,
    then: { pose: 'shelfTake', time: [2.4, 4.0], gives: 'box' },
  },
  // ...and out. `exit` is the one thing on this whole table that outlives the
  // errand: every other job ends with a body going back to what it was doing,
  // and this one ends with a body that is not on the floor any more. See
  // `showOut` in enemies.js for what that means and what it deliberately does
  // not do — he keeps his slot in the roster, because a body's index in
  // `items` is its name on the wire.
  leaveFloor: {
    at: 'lift', pose: 'shelfTake', time: [2.5, 4.5], weight: 0, stay: [1, 1],
    neutral: true, trade: true, takes: 'box', exit: true, shared: true,
  },
  // A MACHINE'S BREAK, and the only entry on this table that is not work.
  //
  // Half the roster does not eat: `_lunchOk` in enemies.js has kept a chassis
  // out of the canteen since the day the lunch cycle existed, on the grounds
  // that a machine has nowhere to put it. The dock in the break room is what the
  // same room offers them instead (see `charger` in gen/props.js) — somewhere to
  // stand still with something visibly happening, which is the whole of what a
  // break looks like from the outside.
  //
  // It is a CHORE rather than a break, and that is a decision rather than an
  // economy. A break in this game means a specific thing — the body stops being
  // able to fight you and its visor turns blue to say so (see `_lunchLook`) —
  // and a machine on charge has made no such promise: it is plugged into a wall,
  // it can see you, and it will come off the dock when it does. Everything that
  // follows from being a chore is the right answer for it, `_choreWork`'s
  // startle first among them.
  //
  // `machine` is `human`'s opposite and the only place either flag is inverted:
  // a person standing at a charging point is not on a break, they are somebody
  // waiting for the kettle at the wrong appliance.
  charge: { at: 'charge', pose: 'dock', time: [24, 48], weight: 2, stay: [1, 2], machine: true },
  // The two that belong to a trade rather than to a machine. Both stand on a
  // patch of corridor (`hall`) rather than at a prop, and both are weighted low
  // because only a handful of bodies on the floor may take them — a weight here
  // is how often the KIND comes up, and a kind nobody can do is a wasted turn.
  mop: { at: 'hall', pose: 'mop', time: [12, 24], weight: 2, stay: [2, 5] },
  patrol: { at: 'hall', pose: 'patrol', time: [5, 11], weight: 3, stay: [2, 4] },
};
const KINDS = Object.keys(CHORES);

/**
 * ...and the errands that are more than one machine.
 *
 * A chore is a body, a machine and a few seconds. That is most of an office and
 * it is not all of it: the thing an office actually does is take a piece of work
 * from one end of the building to the other, and the machines are the stops
 * along the way. So a ROUTINE is a list of legs, walked in order by one body,
 * with what they are carrying handed over between them.
 *
 * There is one, and it is the one everybody has watched happen: you write it,
 * you print it, you square it up and put a band round it, and you file it. Which
 * is also why it reads at all — every beat of it is a thing the player has done
 * themselves, so a man standing at a rack holding a bundle of paper is legible
 * without a word of explanation.
 *
 *   kind    the CHORES entry the leg is done as, so a leg is a normal job that
 *           happens to have somewhere to go afterwards
 *   stay    overrides the kind's own. Routine legs are mostly ONE go: you print
 *           the thing once. The desk leg keeps a couple, because writing it is
 *           the part that takes a while.
 *   then    overrides the kind's second beat, and may be a LIST of them — which
 *           is what "package it" needed, since the printer already had one beat
 *           for taking the paper out and packaging is a third thing.
 *   gives   what the body is holding after this beat, and `takes` what it puts
 *           down. Both are checked against what it is actually holding, so a leg
 *           that was skipped cannot leave a body filing a bundle it never
 *           collected.
 *
 * WEIGHTED AGAINST THE SINGLE JOBS, not above them. A routine costs three
 * floods to cast where a job costs one (every stop is proved before anything is
 * committed — see `_castRoutine`, and see jobs.js for what it costs not to), so
 * it is deliberately a minority of what the floor is doing.
 */
const ROUTINES = {
  paperwork: {
    weight: 4,
    legs: [
      { kind: 'deskWork', stay: [2, 3] },
      {
        kind: 'printer',
        stay: [1, 1],
        then: [
          { pose: 'printerTake', time: [2.2, 3.6] },
          { pose: 'package', time: [2.6, 4.6], gives: 'papers' },
        ],
      },
      { kind: 'file', stay: [1, 1], takes: 'papers' },
    ],
  },
  // ...and the other thing an office does with its own stuff: move a box from
  // one rack to another. Two legs rather than three, and no machine in it — it
  // is the shortest errand on the table and the only one whose whole content is
  // the thing being carried, which is exactly why it reads: a body walking
  // across a floor with a crate in its arms is legible from anywhere.
  //
  // It is what "the boxes can be taken in and out" comes to. The box is real
  // (`giveCrate` in enemies.js — the same crate a parcel run carries, and the
  // same bit on the wire), so the joiner in a co-op session sees it too.
  stocktake: {
    weight: 3,
    legs: [
      { kind: 'fetchBox' },
      { kind: 'stowBox', takes: 'box' },
    ],
  },
  // ...and the post, which is the same two legs going somewhere else: off a
  // mailroom rack and out of the building. Weighted low and cast from the
  // neutrals only, so it is a thing you come across rather than a thing the
  // floor is doing — a courier crossing a corridor with a parcel, which is the
  // whole of it.
  postrun: {
    weight: 1,
    legs: [
      { kind: 'fetchPost' },
      { kind: 'sendPost', takes: 'box' },
    ],
  },
  // ...and the one errand on the table that is not the building's own work: a
  // man in a coloured suit who came up in the other lift, takes a crate off a
  // rack, and goes back down with it.
  //
  // It is the post run's two legs with a different rack at one end and a
  // different body walking them, which is as it should be — the routine table
  // was built so that "walk here, do this, carry that there" is a list rather
  // than a system. What the Contractor adds is at the ends of it and not in the
  // middle: he is standing in the departure car when the floor is generated
  // (`_visitor` in enemies.js) and he is off the floor when the last leg ends.
  collection: {
    weight: 2,
    legs: [
      { kind: 'takeCrate' },
      { kind: 'leaveFloor', takes: 'box' },
    ],
  },
};
const ROUTINE_KINDS = Object.keys(ROUTINES);

// How many routines may be running at once. The cap is about the CASTING rather
// than the walking: three floods a cast against a job's one, and a routine holds
// a field for three walks instead of one. Six of them on a floor of a hundred and
// seventy is one visible errand per few rooms, which is what it is for.
const MAX_ROUTINES = 6;

// How far out of a lift car the post is handed in — searched between these two
// rather than fixed, because what has to be true is that a body FITS there. Near
// enough to be unmistakably at the lift, far enough to be in the room rather
// than in the doorway.
const LIFT_NEAR = 1.4;
const LIFT_FAR = 3.2;
const LIFT_STEP = 0.25;

// A meeting: how many people are in it, and how many may be running at once.
//
// Four to seven INCLUDING whoever is at the board, so a meeting is never one
// person presenting to one person. The cap is low because a meeting takes a
// room's whole seating and six or seven bodies off the floor for half a minute,
// and because the point of it is that you walk into one — three at a time on a
// floor of a hundred and seventy is often enough to meet one and rare enough
// that it is still a thing you found.
const MEETING = [4, 7];
const MAX_MEETINGS = 3;
// How often the die comes up meeting at all, against the single jobs and the
// routines. Weighted rather than tried first, for the reason a routine is: the
// mix is then one number instead of a priority.
const MEETING_WEIGHT = 5;

// What a body with no trade does: the ordinary work of an office, and it is
// everything on the table that is not somebody's job in particular.
//
// A type may name its own list instead (`works` in enemy-types.js) — a janitor
// washes the floor and a guard walks the corridors, and neither of them does it
// as well as the filing. Note what this is NOT: a split between people and
// machines. A Clerk Unit uses the copier and a Sysadmin works the rack, because
// the building does not have two sets of machines in it and a job is a job.
// A TRADE's job is never anybody else's. A janitor mops and security holds a
// post, and now a contractor collects a crate — three jobs that belong to whoever
// declares them in `works` and to nobody else.
//
// Read off the table rather than listed here, which is a fix rather than a tidy:
// this was `k !== 'mop' && k !== 'patrol'`, so the next trade job added would
// have fallen silently onto the general list and been handed to the whole
// office. `trade: true` on the kind is what says so, once, beside the job.
const GENERAL = KINDS.filter((k) => !CHORES[k].trade);
const worksFor = (e) => e.type.works ?? GENERAL;

// How long before the first job of a floor, and how often somebody else is put
// to work after that.
//
// The first is short because this is the floor's ordinary state rather than an
// event — an office where nobody starts working for a minute is an office that
// was empty when you arrived.
const FIRST = 6;
const TICK = 0.35;

// EVERYBODY WORKS, and this is the valve rather than the cap.
//
// It was eight at once, which was a light sprinkle over a floor of a hundred and
// seventy and was defended as one: what makes an office read as worked is
// finding somebody at a machine in the room you walked into, not finding
// everybody at one. That is a fine argument about the other hundred and sixty
// two people if they have something else to be doing, and they did not — they
// stood in their rooms waiting to be shot. So the floor now fills up: anybody
// who can reach a free machine is sent to one, and whoever is left over takes
// their break instead (see `update`). Nobody is idle who has a choice.
//
// The supply is there. Measured over floors 1, 4 and 8: 125, 109 and 246
// stations against 30, 40 and 193 bodies eligible to stand at one, so the office
// runs out of people before it runs out of machines.
//
// What is capped is the WALKING, because that is the only stage that costs
// anything. A body en route holds a distance field — 548 KB on a deep floor —
// and spends a flood to get it, while a body standing at a machine holds nothing
// (`standAt` gives the field back, see `dropField` in enemies.js). So this is
// how fast the floor fills, not how full it gets: at 24 walkers and a 15-second
// walk it puts somebody new to work about every two thirds of a second, and the
// floor is at work inside a couple of minutes without ever holding more than
// ~13 MB of routes.
// A STAY is several goes at one machine, and it is what makes the floor
// affordable rather than what makes it look busy.
//
// Keeping N people at machines needs them to arrive at N / (time per visit), and
// every one of those arrivals is a walk — so the number of people COMMUTING at
// any moment is that rate times how long a walk takes. With a visit of twenty
// seconds, keeping a floor of 194 at work means 62 of them are permanently in
// transit: measured, and it is both 45 MB of live routes and an office where a
// third of the staff is walking somewhere. Lengthening a single job would have
// fixed the arithmetic and broken the jobs — a man printing one document for a
// minute and a half. Several goes at the same machine is the same arithmetic and
// the truth about offices: you do not go to the copier once.
//
// It costs nothing at all. A repeat is a new pose and a new clock at a station
// the body is already standing at — no cast, no flood, no field, no walk.
const MAX_WALKING = 28;
const PER_TICK = 3;

// The backstop on a walking stage. Generous for the reason lunch's is: a walk
// from one end of a deep floor to the other took a body fifty seconds at errand
// pace, and a job that quietly never ends is a body standing at a copier for the
// rest of the floor.
const WALK_CAP = 100;

export class Chores {
  constructor({ enemies, effects, audio }) {
    this.enemies = enemies;
    this.effects = effects;
    this.audio = audio;
    this.nav = null;

    this.pools = new Map();   // kind -> the stations it can be done at
    this.busy = new Set();    // ...and the ones somebody is standing at
    // ...and the prop each one is a place to stand AT, probed once and kept.
    // `null` is a real entry and means there is nothing to watch, so this is
    // read through `has` rather than through a falsy test — see `_propFor`.
    this.props = new Map();
    this.live = [];           // bodies currently on one
    this.timer = FIRST;
    this.enabled = false;

    // The seam into enemies.js, and the whole of it. Two hooks rather than
    // sharing the parcel runs' pair, because a callback slot has one occupant
    // and a second consumer of one is how the first quietly stops being called.
    enemies.choreTick = (e, dt, audio) => this._tick(e, dt, audio);
    enemies.choreLost = (e) => this.lost(e);

    // `descendOn` RETURNS `out.set(...)`, so the probe below needs a real
    // Vector3 to write into even though nothing here reads what it wrote — a
    // stub whose `set` returns nothing reads back as "no route" and casts
    // nobody, silently. Same trap jobs.js documents.
    this._v = new THREE.Vector3();
    this._field = null;
  }

  /**
   * Collects this floor's machines.
   *
   * Called after `enemies.spawn`, which is what builds the station pools — every
   * one of them already filtered through `nav.fitsAt`, so a printer jammed into
   * a corner nobody can stand at was dropped before it got here (see `deskPool`
   * in enemies.js, which paid for that rule the hard way). `panels` is the one
   * source that does not come down that pipe: its openings are fitted into a
   * finished floor like the parcel lines, so it hands its own spots over.
   */
  spawn(nav, enemies, panels) {
    this.clear();
    this.nav = nav;
    this._field = null;

    // Somewhere to mop, and somewhere to stand a post. Neither is furniture, so
    // neither comes down the workstation pipe — it is a patch of floor, and the
    // only list of those the game keeps is the corridor sample enemies.js
    // already walks to place the hall traffic. ONE array shared by both kinds,
    // deliberately: `busy` holds the station itself, so a guard and a janitor
    // can never be dealt the same tile.
    const hall = (enemies.corridors ?? []).map((c, i) => ({ x: c.x, z: c.z, rot: i & 3 }));

    // Somewhere to SIT, which is the one pool that is not `enemies.stations`.
    //
    // They are the same workstations and they are not interchangeable: the
    // `stations` map is built with STAND_NUDGE, which may move a record up to a
    // tile back from the furniture so that a body FITS in front of it — and a
    // chair may never be moved, because the seated pose is drawn relative to the
    // seat. `standable`'s own comment says exactly this, and this is the first
    // caller for which it matters. `enemies.desks` is the un-nudged pool.
    //
    // A flat snapshot is safe because the pool is stable after `enemies.spawn`:
    // the Manager, the guard on the cameras and the arrival diners all take their
    // chairs during spawn, so they are already gone from it by the time this
    // runs, and nothing takes a DESK chair at runtime (the lunch cycle draws from
    // `tables`). Occupancy from there on is `busy`, like every other kind.
    const chairs = [...(enemies.desks?.values() ?? [])].flat();

    // Every rack in the building somebody can stand at, of either kind. They are
    // pooled apart by the furnisher because a parcel run may only start at a
    // storeroom's, and the box errand is the one thing that does not care which
    // room it is in. See `fetchBox`.
    const racks = [
      ...(enemies.stations?.get('shelf') ?? []),
      ...(enemies.stations?.get('files') ?? []),
    ];

    // Where the post leaves by, and where a visitor comes and goes: the floor a
    // body stands on with the lift doors in front of it. Derived once, in
    // enemies.js beside the other station pools, because two things want it —
    // this table's `lift` kinds, and `_visitor`, which stands a man there at the
    // start of the floor. See `liftSpots` there for what the number has to be.
    const lifts = enemies.lifts ?? [];

    for (const kind of KINDS) {
      const at = CHORES[kind].at;
      // A meeting's chairs come out of `meetingSeats` for the same reason a
      // desk's come out of `desks`: they are seats, and a seat may never be
      // nudged back off its furniture the way `stations` nudges a machine.
      const from = at === 'panel' ? (panels?.spots ?? [])
        : at === 'hall' ? hall
          : at === 'chair' ? chairs
            : at === 'meeting' ? [...(enemies.meetingSeats?.values() ?? [])].flat()
              : at === 'racks' ? racks
                : at === 'lift' ? lifts
                  : (enemies.stations?.get(at) ?? []);
      if (from.length) this.pools.set(kind, from);
    }
    // Nothing to do on a floor with no machines anybody can stand at, which is
    // not a case that should happen and is cheap to be right about.
    this.enabled = this.pools.size > 0;
    this.timer = FIRST;
  }

  // ---------------------------------------------------------------- casting

  update(dt) {
    if (!this.enabled || this.enemies.puppet) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = TICK;

    // Only the ones still on their way count against the valve — see MAX_WALKING.
    let walking = 0;
    for (const e of this.live) if (e.chore?.stage === 'to') walking++;

    let room = Math.min(PER_TICK, MAX_WALKING - walking);
    while (room-- > 0) {
      if (this._start()) continue;
      // Nothing could be cast, which means one of two things and the same answer
      // serves both: every machine of its kind is taken, or nobody left standing
      // about can reach one. Either way the person who would have worked has
      // nothing to work at, and the honest thing for somebody with nothing to do
      // in an office is to go and have their lunch. It is the canteen that bounds
      // how many manage it — there are only so many chairs — and anybody it turns
      // away goes on standing where they are, which is the old behaviour and now
      // the last resort rather than the default.
      this.enemies.sendToBreak?.();
      break;
    }
  }

  /**
   * Sends one body to one machine, or does not. Every failure is silent and
   * costs nothing but this turn — and it is REPORTED, because `update` reads a
   * failure as "there is no work here" and sends somebody for their break
   * instead.
   *
   * The station is chosen before the body, exactly as a parcel run's stops are,
   * because the question "who can reach this" needs a this — and because it is
   * one flood of the floor rather than one per candidate. The field from a fixed
   * point is the same field whoever is asking, which is a lesson this game has
   * had to learn in three separate files.
   *
   * Worth knowing what this looks like over a floor, because it MOVES: almost
   * every machine in the building is inside a room with a badged door, and a
   * badged door is out of the nav grid entirely — so with nothing in your pocket
   * the only people who can get to a copier are the ones already in the
   * corridors, and one white card opens a hundred and ninety doorways and puts
   * the whole building back to work. The office starts working once the office
   * has been opened, which is the same property the lunch cycle turned out to
   * have and which nobody wrote either time.
   */
  _start() {
    // A few goes at it rather than one, because a kind can now come up that
    // nobody available is allowed to do: `mop` belongs to one to three janitors
    // and `patrol` to a handful of guards, so a single pick that lands on one of
    // those and finds nobody would give up the whole turn — and `update` reads a
    // failed turn as "there is no work here" and sends somebody to lunch. Three
    // floods at 0.06 ms each is not worth being cleverer about.
    for (let tries = 0; tries < 3; tries++) {
      if (this._try()) return true;
    }
    return false;
  }

  _try() {
    // A routine or a single job, rolled against each other rather than routines
    // being tried first: the mix is then one number instead of a priority. Held
    // under a cap of its own because a routine costs three floods to cast and
    // reserves three machines for as long as it runs.
    const routineWeight = this._routinesLive() < MAX_ROUTINES
      ? ROUTINE_KINDS.reduce((t, k) => t + ROUTINES[k].weight, 0)
      : 0;
    // ...and the meeting, on the same die. It fails far more often than either —
    // it wants a room with a board and four free chairs in it and four people who
    // can all walk there — and a failure falls through to the rest of the roll
    // rather than costing the turn, exactly as a routine's does.
    const meetWeight = this._meetingsLive() < MAX_MEETINGS && this._free('present')
      ? MEETING_WEIGHT
      : 0;
    let total = routineWeight + meetWeight;
    for (const kind of KINDS) if (this._free(kind)) total += CHORES[kind].weight;

    if (total <= 0) return false;
    const roll = Math.random() * total;
    if (roll < meetWeight && this._tryMeeting()) return true;
    if (roll < meetWeight + routineWeight && this._tryRoutine()) return true;
    // A failed routine falls through to a single job rather than giving up the
    // turn. It fails often and legitimately — it wants three free machines and a
    // body that can walk between all of them — and `update` reads a failed turn
    // as "there is no work on this floor" and sends somebody to lunch instead.

    const kind = this._pickKind();
    if (!kind) return false;
    const station = this._pickStation(kind);
    if (!station) return false;

    const worker = this._cast(station, kind);
    if (!worker) return false;

    this._commit(worker, [{ kind, station }], null);
    return true;
  }

  /**
   * How many meetings are going on, counted by the people AT THE BOARD.
   *
   * One presenter per meeting by construction, so counting them is counting
   * meetings — where counting attendees would count one meeting four to seven
   * times and counting rooms would need a set.
   */
  _meetingsLive() {
    let n = 0;
    for (const e of this.live) if (e.chore?.kind === 'present') n++;
    return n;
  }

  /**
   * Four to seven people, one room, and somebody at the whiteboard.
   *
   * The only thing on this table that casts more than one body, and it is
   * deliberately still a CHORE rather than a system of its own: an attendee is a
   * body that walked to a chair and sat in it, and a presenter is a body that
   * walked to a board and held a pose at it, which is what every other line in
   * this file already does. Everything that came free by doing it this way is a
   * thing that was a bug somewhere else first — the walk and its backstop, the
   * chair being shot out from under them (`_seatGone`), the machine going
   * (`c.prop`), standing up with the joints put back, and above all the STARTLE:
   * `_choreWork` in enemies.js ends any chore the moment its body sees or hears
   * you or you simply get close, so opening the door on a meeting turns seven
   * people round without a line of code here.
   *
   * ONE FLOOD FOR THE WHOLE GROUP, which is the lesson the lunch cycle paid for.
   * Everybody is going to the same room, so the field to the board answers "can
   * this body get there" for all of them; casting each attendee against its own
   * chair would be seven floods of a ten-thousand-tile floor to answer one
   * question seven times.
   */
  _tryMeeting() {
    const boards = this.pools.get('present');
    const seats = this.pools.get('attend');
    if (!boards?.length || !seats?.length) return false;

    // Walked from a random start rather than scanned from the front, for
    // `_pickStation`'s reason: taken in order, the same room would hold every
    // meeting on the floor.
    const start = (Math.random() * boards.length) | 0;
    for (let i = 0; i < boards.length; i++) {
      const board = boards[(start + i) % boards.length];
      if (!this._usable(board)) continue;
      const free = seats.filter((s) => s.room === board.room && this._usable(s));
      if (free.length < MEETING[0] - 1) continue;

      // How many are in it, capped by what the room can seat. `MEETING` counts
      // the presenter, so the chairs wanted is one fewer.
      const want = MEETING[0] + ((Math.random() * (MEETING[1] - MEETING[0] + 1)) | 0);
      // A contiguous run of the room's chairs from a random start, rather than a
      // shuffle: chairs come out of the furnisher in the order they were placed
      // round the table, so a run of them seats a meeting down one end together
      // where a shuffle scatters four people over twelve seats.
      const chairs = [];
      const from = (Math.random() * free.length) | 0;
      for (let n = 0; n < free.length && chairs.length < want - 1; n++) {
        chairs.push(free[(from + n) % free.length]);
      }

      const cast = this._castGroup(board, 1 + chairs.length, 'present');
      // A meeting nobody could get to is not a meeting, and a meeting of two is
      // not one either — so the whole attempt is dropped rather than a smaller
      // one being held. Nothing has been committed at this point.
      if (cast.length < MEETING[0]) continue;

      this._commit(cast[0], [{ kind: 'present', station: board }], null);
      for (let n = 1; n < cast.length; n++) {
        this._commit(cast[n], [{ kind: 'attend', station: chairs[n - 1] }], null);
      }
      return true;
    }
    return false;
  }

  /**
   * The `n` nearest bodies that can reach one station, off ONE field.
   *
   * `_cast`'s two-part question asked once and answered for everybody: flood to
   * the destination, then take the bodies that are standing on the field, in
   * order of how far along it they are. The nearest goes first, so the person
   * who ends up at the board is the one who was closest to the room — which is
   * both cheaper and the right answer, since somebody has to have got there
   * first to be writing on it.
   */
  _castGroup(station, n, kind) {
    if (!this.nav) return [];
    this._field ??= this.nav.makeField();
    if (!this.nav.floodTo(this._field, station.x, station.z)) return [];

    const humanOnly = !!CHORES[kind].human;
    const found = [];
    for (const e of this.enemies.items) {
      if (!this._eligible(e) || !worksFor(e).includes(kind)) continue;
      if (humanOnly && (e.rig !== 'human' || isMachine(e.type))) continue;
      if (!this.nav.descendOn(this._field, e.x, e.z, this._v)) continue;
      const d = this.nav.distanceOn(this._field, e.x, e.z, e.layer);
      if (d < 0) continue;
      found.push({ e, d });
    }
    found.sort((a, b) => a.d - b.d);
    return found.slice(0, n).map((f) => f.e);
  }

  /** How many of the live jobs are multi-leg errands. */
  _routinesLive() {
    let n = 0;
    for (const e of this.live) if (e.chore?.legs?.length > 1) n++;
    return n;
  }

  /**
   * One body, three machines, and a piece of work that moves between them.
   *
   * EVERY STOP IS PROVED BEFORE ANYTHING IS COMMITTED, and that is a lesson
   * jobs.js paid for rather than a precaution. Casting against the first leg
   * alone picks whoever can reach a desk — which on this floor is very nearly
   * anybody — and then discovers at the printer that the body it chose is shut
   * in an office with no route out of it. The parcel run did exactly that and
   * died 4.7 simulated seconds in, every time, silently, because a run that
   * cannot be finished looks identical to a run that was never cast.
   *
   * So: reserve a machine for every leg, cast the nearest body that can reach
   * the first, and then prove each HOP before a single field is handed out.
   */
  _tryRoutine() {
    const name = ROUTINE_KINDS[(Math.random() * ROUTINE_KINDS.length) | 0];
    const routine = ROUTINES[name];

    // A machine per leg, held aside as we go so two legs can never be dealt the
    // same station. Nothing is in `busy` yet, so a failure below costs nothing.
    const legs = [];
    const taken = [];
    for (const leg of routine.legs) {
      const station = this._pickStation(leg.kind, taken);
      if (!station) return false;
      taken.push(station);
      legs.push({ ...leg, station });
    }

    const worker = this._cast(legs[0].station, legs[0].kind);
    if (!worker) return false;

    for (let i = 1; i < legs.length; i++) {
      if (!this._hop(legs[i - 1].station, legs[i].station)) return false;
    }

    this._commit(worker, legs, name);
    return true;
  }

  /**
   * Whether a body standing at one station could get to the next.
   *
   * The same two-part question `_cast` asks, in the same order: flood to the
   * destination, then check the ORIGIN is on the field. A distance can be read
   * off a tile nothing can set off from, and most of this building is behind a
   * badged door that is not on the nav grid at all — which is why a routine,
   * like the lunch cycle and the parcel runs before it, only really starts
   * happening once the player has opened the floor with a white card.
   */
  _hop(from, to) {
    if (!this.nav) return false;
    this._field ??= this.nav.makeField();
    if (!this.nav.floodTo(this._field, to.x, to.z)) return false;
    return !!this.nav.descendOn(this._field, from.x, from.z, this._v);
  }

  /** Puts a cast body on its first leg. One place, so both paths agree. */
  _commit(worker, legs, routine) {
    // A SHARED station is not reserved, because it is a PLACE rather than a
    // machine. Two people can stand at a lift; one of them cannot be at the
    // copier. It is the same distinction `servery` and `shelves` are kept out of
    // the pools for — somewhere you stand for four seconds, not somewhere you
    // sit for a minute — and it had to be made the moment a second errand wanted
    // a lift: a floor has exactly two lift spots, the post runs held both of them
    // for the length of an errand each, and a collection could never find one
    // free. Measured before the flag: both spots `busy` on every sample, and the
    // contractor stood at the lift wandering for four minutes.
    for (const leg of legs) if (!CHORES[leg.kind].shared) this.busy.add(leg.station);
    this.live.push(worker);
    const first = legs[0];
    worker.chore = {
      routine, legs, leg: 0,
      // WHICH MACHINES THIS ERRAND STILL HOLDS, which is not the same list as
      // its legs and that difference was a real bug. A routine reserves all of
      // its stations when it is cast and hands each one back as it leaves it —
      // so by the time it reaches the filing rack, the desk it started at may
      // well have been given to somebody else. Releasing `legs` on the way out
      // then freed a machine another body was standing at, and the next cast
      // sent a second person to it.
      held: legs.map((leg) => leg.station),
      kind: first.kind, station: first.station,
      // Held on the job rather than looked up per frame, because a lookup that
      // misses reads as the machine having gone — see `_propFor`.
      prop: this._propFor(first.station),
      stage: 'to', pose: null, beat: 0,
      timer: WALK_CAP, work: 0, tick: 0,
      stay: this._rollStay(this._specOf(first.kind, first)),
    };
    this.enemies.routeTo(worker, worker.chore, first.station, WALK_CAP);
  }

  /** The kind's own numbers, with this leg's overrides on top. */
  _specOf(kind, leg) {
    const base = CHORES[kind];
    return leg ? { ...base, ...leg } : base;
  }

  /** ...and the one for the leg a body is on right now. */
  _spec(c) {
    return this._specOf(c.kind, c.legs?.[c.leg]);
  }

  _rollStay(spec) {
    const [lo, hi] = spec.stay;
    return lo + ((Math.random() * (hi - lo + 1)) | 0);
  }

  /** A job's second beats, always as a list: one, several, or none. */
  _beats(spec) {
    if (!spec.then) return null;
    return Array.isArray(spec.then) ? spec.then : [spec.then];
  }

  /** One of the six, by weight, out of whichever ones this floor can offer. */
  _pickKind() {
    let total = 0;
    for (const kind of KINDS) {
      if (this._free(kind)) total += CHORES[kind].weight;
    }
    if (!total) return null;
    let roll = Math.random() * total;
    for (const kind of KINDS) {
      if (!this._free(kind)) continue;
      roll -= CHORES[kind].weight;
      if (roll <= 0) return kind;
    }
    return null;
  }

  /** Whether this floor has a machine of this kind nobody is already at. */
  _free(kind) {
    const pool = this.pools.get(kind);
    if (!pool) return false;
    for (const station of pool) if (this._usable(station)) return true;
    return false;
  }

  /**
   * A machine of this kind nobody is standing at.
   *
   * Walked from a random start rather than scanned from the front, so the same
   * copier is not the one everybody uses — the pool comes out of the furnisher
   * in the order the rooms were filled, and taken in order the nearest corner of
   * the building would do all the work on the floor. Same argument `deskPool`
   * makes for shuffling a room's desks.
   */
  _pickStation(kind, skip = null) {
    const pool = this.pools.get(kind);
    if (!pool) return null;
    const start = (Math.random() * pool.length) | 0;
    for (let i = 0; i < pool.length; i++) {
      const station = pool[(start + i) % pool.length];
      // `skip` is the machines a routine has already claimed for its own other
      // legs. They are not in `busy` yet — nothing is committed until every leg
      // has one — so this is the only thing keeping two legs off one station.
      if (skip?.includes(station)) continue;
      if (this._usable(station)) return station;
    }
    return null;
  }

  /**
   * The nearest body that could actually get there.
   *
   * One flood, then one pass over the roster reading it — never a flood per
   * candidate. BOTH halves are checked, which is the whole of it: a field that
   * reached the machine says nothing about whether it reached the body, and
   * before the first white card most of the roster is behind a door that is not
   * on the grid at all.
   *
   * NEAREST, and that turned out to matter far more than it sounds. This used to
   * reservoir-sample one body uniformly out of everybody who could reach the
   * machine, which is a fine way to pick one of eight and a terrible way to pick
   * a hundred and ninety: a floor is 70 m across, so a uniform draw sends people
   * on 30-to-77 m walks at errand pace and the office fills up at about one
   * person every two and a half seconds. Measured on floor 8, 194 eligible
   * bodies: the walkers pinned the valve at 24 and THREE of them had arrived
   * anywhere after forty seconds. It also read wrong at any speed — somebody
   * marching the length of the building past four free copiers to use the fifth.
   *
   * The distance is free: it is the value already sitting in the field under the
   * body, which is why `distanceOn` exists in nav.js. Ties go to whoever is found
   * first, and the shuffled station pick above is what keeps that from always
   * being the same corner of the building.
   */
  _cast(station, kind) {
    if (!this.nav) return null;
    this._field ??= this.nav.makeField();
    if (!this.nav.floodTo(this._field, station.x, station.z)) return null;

    // A job that puts somebody in a chair is a job for somebody with knees. A
    // chassis has drive wheels where a pair of hips would be (see `sitLegs` in
    // enemy-anim.js), and the honest picture of a Clerk Unit at a desk is the one
    // it already has: standing at the end of it.
    const humanOnly = !!CHORES[kind].human;
    const machineOnly = !!CHORES[kind].machine;
    const calmOnly = !!CHORES[kind].neutral;

    let best = null;
    let bestD = Infinity;
    for (const e of this.enemies.items) {
      if (!this._eligible(e) || !worksFor(e).includes(kind)) continue;
      if (humanOnly && (e.rig !== 'human' || isMachine(e.type))) continue;
      if (machineOnly && !isMachine(e.type)) continue;
      if (calmOnly && !e.type.neutral) continue;
      // `descendOn` is the reachability half and it is asked FIRST: a distance
      // can be read off a tile a body cannot actually set off from.
      if (!this.nav.descendOn(this._field, e.x, e.z, this._v)) continue;
      const d = this.nav.distanceOn(this._field, e.x, e.z, e.layer);
      if (d < 0 || d >= bestD) continue;
      bestD = d;
      best = e;
    }
    return best;
  }

  /**
   * Whether this body is free to go and do something.
   *
   * ANYBODY WHO WORKS HERE, and that now means the machines too. There is no
   * such thing as a human job or a robot job: a Clerk Unit uses the copier and a
   * Sysadmin works the rack, because the building does not have two sets of
   * machines in it. What used to stand in the way was `rig === 'human'`, and it
   * was a real obstacle rather than a policy — every joint in CHORE_POSE is a
   * height, and the angle that reaches it was solved against a PERSON's shoulder,
   * so a chassis sent to a copier arrived with its arms hanging off it and
   * `stand` put its drive wheels where a pair of hips would be. Every rig
   * declares its own `joints` now (rigs.js) and the pose is struck against those,
   * which is the `gunRest` lesson for the third time. The heights themselves stay
   * absolute, because they are facts about the prop.
   *
   * Two exclusions are left and both are `_lunchOk`'s. The Reanimated are off the
   * payroll, and an Infestation floor is four fifths of them — a floor that has
   * been overrun is not a floor doing its filing. And the toilet guy is a running
   * gag with somewhere to be.
   *
   * The state test is what keeps this out of a fight. `idle` is a hostile
   * standing in its room and `wander` is a neutral walking the corridors; every
   * other state means they are already dealing with you.
   */
  _eligible(e) {
    return e.alive
      && !e.type.panic             // the toilet guy has a bit, and this is not it
      && !e.type.undead            // ...and this one is off the payroll
      && !e.chore && !e.job && !e.break && !e.seat
      && !e.behindLock && !e.offMap && !e.keyed
      && e.flee <= 0
      && (e.state === 'idle' || e.state === 'wander')
      && e.layer === 0;
  }

  // ----------------------------------------------------------------- a frame

  /**
   * One frame of one body's job. Called from `update` in enemies.js in place of
   * `_move` or `_wander`, so this owns where the body goes for as long as it
   * lasts.
   */
  _tick(e, dt, audio) {
    const c = e.chore;
    if (!c) return;

    // THE MACHINE WENT, and that ends the job wherever it happened — walking to
    // it or standing at it. This is `_seatGone`'s rule about a chair applied to
    // the thing a working pose is drawn against, and it was a real bug rather
    // than an omission: a copier can be shot apart, blown across a room by an
    // extinguisher or caught in the generator's blackout while somebody is
    // pressing it, and none of that used to reach the body. What you got was a
    // man typing at empty carpet, arms held at a keyboard that is now debris —
    // and, worse, a station the pool went on handing out, so the next body
    // walked across the floor to work at nothing too.
    //
    // Checked before the backstop and before the stage switch so no stage can
    // skip it, exactly as the timer is.
    if (c.prop && c.prop.top < 0) { this.lost(e); return; }

    // The backstop, in one place so no stage can forget it — and also how a
    // failed flood reports itself, since `routeTo` and `advanceTo` both spend
    // the timer when there is no route (see enemies.js).
    c.timer -= dt;
    if (c.timer < 0) { this.lost(e); return; }
    if (c.work > 0) c.work -= dt;

    const job = this._spec(c);

    // THE CHAIR WENT OUT FROM UNDER THEM. `_seatGone` in enemies.js stands up a
    // body whose chair has been shot apart or shoved away, and it knows nothing
    // about jobs — so without this the chore carries on running with a body that
    // is no longer sitting in it, typing at a desk from a standing position.
    // `c.prop` cannot catch it: that is the DESK in front of them, and the desk
    // is still there.
    if (job.sit && !e.seat && c.stage !== 'to') { this.lost(e); return; }

    switch (c.stage) {
      case 'to':
        if (!this.enemies.advanceTo(e, c, dt, c.station)) return;
        // The last stretch onto the spot is walked straight rather than on the
        // field, for the reason a chair needed it: a flow field walks to tile
        // centres and a machine is not at one, so arriving "close enough" left
        // every body a metre from the thing it had come to use.
        if (!this.enemies.closeOnto(e, dt, c.station)) return;
        this._begin(e, job, job.pose, job.time);
        return;

      case 'work': {
        if (job.spark) this._spark(e, dt, job.spark, audio);
        if (c.work > 0) return;
        // The beats that say the machine did something, for the jobs that have
        // any. Everything else is finished the moment its clock runs out.
        const beats = this._beats(job);
        if (beats) {
          c.beat = 0;
          c.stage = 'then';
          this._begin(e, job, beats[0].pose, beats[0].time);
          return;
        }
        this._finishGo(e, job);
        return;
      }

      case 'then': {
        if (c.work > 0) return;
        const beats = this._beats(job);
        const beat = beats?.[c.beat];
        // Whatever that beat handed over, applied as the beat ENDS: the can
        // appearing before the hand has got down to the flap is the machine
        // dispensing into thin air.
        this._hand(e, beat);
        if (beats && c.beat + 1 < beats.length) {
          c.beat++;
          this._begin(e, job, beats[c.beat].pose, beats[c.beat].time);
          return;
        }
        this._finishGo(e, job);
        return;
      }

      default:
        this.lost(e);
    }
  }

  /**
   * What a beat puts into somebody's hands, or takes back out of them.
   *
   * Both are checked against what the body is ACTUALLY holding rather than
   * against where it is in the errand, which is the same reason `_seatGone`
   * treats a failed lookup as "do not check": a leg that ended early must not
   * leave somebody filing a bundle of paper they never collected, and a body
   * that lost its papers when it was shot at must not be given a second set.
   */
  _hand(e, beat) {
    if (!beat) return;
    if (beat.gives === 'can') {
      // Keyed off the machine rather than rolled, so which hand it is in and
      // what flavour it is are stable for the run and identical in both
      // browsers of a co-op session — the same argument the eating hand makes.
      // A station's coordinates are the floor's, and the floor came from a
      // shared seed.
      this.enemies.giveCan?.(e, this._key(e));
    }
    if (beat.gives === 'papers') this.enemies.givePapers?.(e, this._key(e));
    // The crate, which is the same one a parcel run carries. Flagged on the JOB
    // rather than read off the body, because jobs.js hands out the same crate
    // and `lost` must only take back the one this errand gave: a chore that
    // stripped a porter of the parcel it is delivering would be the single-slot
    // callback bug in another key.
    if (beat.gives === 'box') { this.enemies.giveCrate?.(e); e.chore.crate = true; }
  }

  /** A stable integer for this body at this machine. See `_hand`. */
  _key(e) {
    const c = e.chore;
    return Math.round((c.station.x + c.station.z) * 7) + 1;
  }

  /**
   * One go finished. Another one, or leave the machine.
   *
   * The repeat is free — the body is already standing there, so there is no
   * cast, no flood and no walk — which is the whole reason it is here. See the
   * note on `stay`.
   */
  _finishGo(e, job) {
    const c = e.chore;
    if (--c.stay > 0) {
      c.stage = 'work';
      this._begin(e, job, job.pose, job.time);
      return;
    }
    // The leg itself is over. Whatever it consumes is put down here rather than
    // on a beat, because filing the paperwork IS the leg — there is no separate
    // moment for it — and this is also the one place a routine's last leg
    // reaches, so nothing can walk away still holding it.
    if (job.takes === 'papers') this.enemies.takePapers?.(e);
    if (job.takes === 'box' && c.crate) { this.enemies.takeCrate?.(e); c.crate = false; }
    if (c.legs && c.leg + 1 < c.legs.length) { this._nextLeg(e); return; }
    // The errand is over, and for one of them so is being here. `lost` still
    // runs afterwards, and has to: it is what puts the hinged limbs back, hands
    // the station to the pool and clears `chore`, none of which stops mattering
    // because nobody can see him any more.
    if (job.exit) this.enemies.showOut?.(e);
    this.lost(e);
  }

  /**
   * On to the next machine.
   *
   * The station just left goes back into the pool immediately — somebody else
   * may have the desk now — while the ones ahead stay reserved, because they
   * were claimed for this errand when it was cast and proved reachable then.
   *
   * Standing up is the part that must not be skipped: `standUp` in enemies.js is
   * what puts the hips, the knees and the leg boxes back, and a body that walked
   * off a chair without it carries the chair's pose around the floor for the rest
   * of the run.
   */
  _nextLeg(e) {
    const c = e.chore;
    this._release(c, c.station);
    if (e.seat) this.enemies.standUp?.(e);
    this.enemies.setChorePose(e, null);

    c.leg++;
    const leg = c.legs[c.leg];
    c.kind = leg.kind;
    c.station = leg.station;
    c.prop = this._propFor(leg.station);
    c.stage = 'to';
    c.beat = 0;
    c.timer = WALK_CAP;
    c.work = 0;
    c.tick = 0;
    c.stay = this._rollStay(this._specOf(leg.kind, leg));
    this.enemies.routeTo(e, c, leg.station, WALK_CAP);
  }

  /**
   * Hands one machine back to the pool and stops counting it as ours.
   *
   * Both halves together, always: a station dropped from `held` but left in
   * `busy` is a machine nothing will ever use again, and one removed from `busy`
   * while still in `held` gets released a second time when the errand ends —
   * and by then it may belong to somebody else.
   */
  _release(c, station) {
    this.busy.delete(station);
    const i = c.held?.indexOf(station) ?? -1;
    if (i >= 0) c.held.splice(i, 1);
  }

  /** Stop, face the machine, hold a pose, and take a while over it. */
  _begin(e, job, pose, span) {
    const c = e.chore;
    this.enemies.standAt(e, c.station);
    c.stage = c.stage === 'to' ? 'work' : c.stage;
    c.timer = WALK_CAP;
    c.work = span[0] + Math.random() * (span[1] - span[0]);
    c.tick = 0;
    // SITTING DOWN, for the one job that does. There is no chore pose for it and
    // that is the point: `animate` dispatches any body with `e.seat` set to
    // `animateWorking`, which is the typing pose the Manager and the guard on the
    // cameras have always used, so the whole of what this needed was a chair to
    // sit on and a knee to bend. Going through `sitAt` rather than touching
    // `e.seat` keeps sitting down and being posed one operation, exactly as
    // `setChorePose` does for a standing job.
    if (job.sit) {
      if (!e.seat) {
        this.enemies.sitAt?.(e, c.station, job.seatAs ?? 'desk');
        // A SEATED BODY HAS TO BE `idle`, and this is the one line that says so.
        // `animate` stands up any seated body whose state is not idle or alert —
        // which is right, and is how a body that has noticed you gets out of its
        // chair — but a NEUTRAL's resting state is `wander`, so a courier sent to
        // a desk would be stood up by the animator on the very next frame, ended
        // by the guard at the top of `_tick`, and cast again. It churns rather
        // than breaking, which is the worst way for it to be wrong.
        //
        // Exactly what `_wander` already does for every other seated neutral
        // (see the note on `_lunchSeated` in enemies.js), and it costs nothing
        // here because a body with `e.chore` has its movement owned by this file
        // rather than by its state. `lost` puts `wander` back.
        if (e.state === 'wander') e.state = 'idle';
      }
      this.enemies.setChorePose(e, null);
      return;
    }
    // Through `setChorePose` rather than by assignment, because clearing it has
    // to put the limbs and the stoop back and the two must be one operation.
    this.enemies.setChorePose(e, pose);
  }

  /**
   * What comes off a bench or a wall panel while it is being worked on.
   *
   * `effects.impact` is the pooled flash every bullet already uses, so this
   * allocates nothing, and `audio.generatorArc` is the one clip in the set built
   * to be asked for two or three times a second at close range and to sit UNDER
   * a fight rather than on top of it. Both are jobs.js's choice for the belt
   * repair and both are right here for its reasons.
   *
   * The flash goes at the MACHINE rather than at the body: the station is a
   * standoff back from the thing, and sparks coming off somebody's chest is a
   * man on fire.
   */
  _spark(e, dt, spark, audio) {
    const c = e.chore;
    c.tick -= dt;
    if (c.tick > 0) return;
    c.tick = spark.tick[0] + Math.random() * (spark.tick[1] - spark.tick[0]);

    // The direction the body is facing, off the station's own quarter turn —
    // the same conversion `standAt` makes, read back out. A station's rot names
    // which way it faces in the four-way table props are authored on, and 0
    // faces -Z.
    const [fx, fz] = FACING[c.station.rot & 3];
    AT.x = c.station.x + fx * spark.out;
    AT.y = spark.y;
    AT.z = c.station.z + fz * spark.out;
    this.effects?.impact(AT, DOWN, 0xfff0c0, 0.6);
    (audio ?? this.audio)?.generatorArc?.(AT);
  }

  // ---------------------------------------------------------------- endings

  /**
   * This body is off the job, however it happened: finished, shot, killed,
   * startled, or wedged. Called from `_damage`, `_die` and `_choreWork` in
   * enemies.js as well as from here.
   */
  lost(e) {
    const c = e?.chore;
    if (!c) return;
    // Before anything else, because it is what puts the arms down and lifts the
    // body out of its stoop — a release that skipped it would leave somebody
    // walking the rest of the floor bent over a bench that is not there.
    this.enemies.setChorePose(e, null);
    // ...and out of the chair, which is the same bargain one joint lower: the
    // hips, the knees and the squashed leg boxes all go back in `standUp` and
    // nowhere else.
    if (e.seat) this.enemies.standUp?.(e);
    // EVERY station the errand is STILL holding, which is why `held` exists and
    // is not simply `legs`. Two failures are being avoided at once: releasing
    // only the current one leaks the machines further down the errand, so a man
    // shot at his desk leaves a printer and a filing rack busy for the rest of
    // the floor; and releasing all of `legs` frees the desk he has already
    // walked away from, which by then belongs to somebody else — measured, that
    // one put two bodies at one machine.
    for (const station of c.held ?? [c.station]) this.busy.delete(station);
    // Whatever they were carrying for it. The papers belong to the errand rather
    // than to the body — see `givePapers` — so an errand that ends anywhere but
    // the filing rack has to put them down, or somebody walks the rest of the
    // floor holding a report they will never file. The CAN is deliberately not
    // touched: that is a drink somebody bought, and it is theirs.
    if (e.papers) this.enemies.takePapers?.(e);
    // ...and the crate, only if this errand is what put it there — see `gives`.
    if (c.crate) { this.enemies.takeCrate?.(e); c.crate = false; }
    e.chore = null;

    const i = this.live.indexOf(e);
    if (i >= 0) this.live.splice(i, 1);
    if (!e.alive) return;

    // Back to the day they were having. A neutral goes to `wander` with a spent
    // timer so the next tick picks somewhere new — the same thing `_repick` does
    // for one that has been shot at — and a hostile goes back to standing in its
    // room, which is what `idle` is. Whoever startled them is about to have
    // `_think` run on this body anyway, and that is what turns idle into a
    // fight.
    e.state = e.neutral ? 'wander' : 'idle';
    e.wanderTimer = 0;
    e.stuck = 0;
  }

  clear() {
    for (const e of [...this.live]) this.lost(e);
    this.live.length = 0;
    this.pools.clear();
    this.busy.clear();
    this.props.clear();
    this.enabled = false;
  }

  // ------------------------------------------------------- a machine that went

  /**
   * The prop a station is a place to stand at, probed once and remembered.
   *
   * Lazy rather than swept at spawn, because a deep floor publishes 246
   * stations and the probe walks the collider list — one pass over all of them
   * is work spent on the machines nobody will ever be sent to. Memoised on the
   * first ask, which is the cast, so each station costs it at most once a floor.
   *
   * `null` is stored and meant: a mop station is a patch of corridor and a wall
   * panel has no collider by design, so there is nothing to watch and that is
   * the answer rather than a failure. Read through `has`.
   */
  _propFor(station) {
    if (!this.props.has(station)) {
      this.props.set(station, this.enemies.machineAhead?.(station) ?? null);
    }
    return this.props.get(station);
  }

  /**
   * Whether the machine at this station has been destroyed.
   *
   * A prop retires by setting `top` negative — the one signal every destructible
   * in the building sends, static and loose alike — so this is the same test
   * `_seatGone` makes about a chair, and it is live for the same reason: the
   * collider handed over here is the one the player collides against, not a copy
   * of it, so a prop shot apart anywhere reaches this without an event.
   */
  _gone(station) {
    const prop = this._propFor(station);
    return !!prop && prop.top < 0;
  }

  /** Free to be sent to: nobody standing at it, and still actually there. */
  _usable(station) {
    return !this.busy.has(station) && !this._gone(station);
  }
}

// Scratch for the spark, module-level and reused. Safe because both consumers
// read it synchronously and copy out of it, and deliberately not a shared
// THREE.Vector3: destruction.js documents a real bug caused by two call sites
// sharing one of those, and this one has exactly one caller.
const AT = { x: 0, y: 0, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };
