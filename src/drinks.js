// The building's drinks: what is in the machine, what each one is called, what
// colour it is painted, and how big a can is.
//
// Its own module because THREE files have to agree about all of that and none of
// them is the obvious home — the same argument metrics.js makes about a body's
// radius. rigs.js builds the can somebody is carrying; textures.js paints the
// stock standing in a machine's window; gen/props.js decides which drink stands
// in which slot and hands the seed on so destruction.js can throw that exact can
// onto the carpet. A list living in any one of those would be copied into the
// other two, and the version of drift available here is one you can see from
// across a room: a can that is orange in the window and purple in the hand of
// the man who just bought it.
//
// Deliberately free of Three.js and of the DOM, for metrics.js's other reason:
// gen/props.js reaches this file, and gen/props.js is imported by the headless
// validators in tools/, where there is neither.

// The drinks machine's stock list.
//
// FOUR of them and they are named, where it used to be six anonymous tints. The
// difference is not decoration: a floor's staff use the same machine all shift,
// so a building where everybody is holding the same thing is a building with one
// can in it — and a colour alone says "not that one" where a name says what it
// is. The wordmark is a list of lines because one of them is two words long, and
// OFFICE SODA squeezed onto one line at this size is a grey smear.
//
// The colour is still doing the heavy lifting, because it is what survives the
// range at which you actually see one: the label goes to mush a few metres out
// and the bare paint above and below it does not. So no two are near each other
// on the wheel.
//
// `mat` is the key its paint is cached under in textures.js, and it is written
// here rather than built from a string at both ends, so a drink names its own
// material once.
export const CAN_FLAVOURS = [
  { lines: ['FIZZ'], color: 0xd68910, mat: 'drinkFizz' },
  // The building's own brand, in the building's own blue. Somebody in
  // procurement is very pleased with it.
  { lines: ['OFFICE', 'SODA'], color: 0x2b6cb0, mat: 'drinkSoda' },
  { lines: ['KOLA'], color: 0xc0392b, mat: 'drinkKola' },
  // Nobody knows what is in this one.
  { lines: ['GOOLI'], color: 0x6c3483, mat: 'drinkGooli' },
];

// One can in twenty comes out of the machine already shot. See `drinkFrom`.
const CAN_BROKEN = 20;

// 9.4 cm across and 19.8 cm tall, which is not a can, it is a can and a half.
//
// A real 330 ml can is 6.6 x 11.5 and that is exactly what this was, on the
// argument that it is never seen from closer than arm's length and never bigger
// than a thumbnail on screen. Both halves of that were true and the conclusion
// was wrong: a prop somebody carries for half a minute across a floor you are
// walking down is a prop the player is LOOKING at, and at real scale it read as
// a coloured peg by somebody's hip. Overscaled the way a game prop is
// overscaled — held up where a hand can be seen holding it, and legible from
// the other side of the room.
export const CAN_R = 0.047;
export const CAN_H = 0.198;

/**
 * Which drink a seed is, and whether it is one of the shot ones.
 *
 * HASHED rather than rolled, because both ends of a can's life have to arrive at
 * the same answer from the same number and neither is holding a die: the machine
 * paints the facing standing in its window when the floor is generated, and the
 * can that comes out of that slot half an hour later is built from the seed the
 * facing was carrying. Same for the one in a hand — it has to be the same drink
 * for as long as somebody is holding it, and a die drawn in a build method would
 * hand them a different flavour every frame the mesh was rebuilt.
 *
 * The hash is MIXED rather than used raw because two things are drawn from it,
 * and `seed % 4` and `seed % 20` are not independent — taken straight, every
 * shot can in the building was a KOLA.
 *
 * ONE IN TWENTY is already shot through and folded over on the hole. It is a
 * joke about the building rather than about the drink: this is a floor where a
 * firefight goes through the corridor the machine is standing in, and the stock
 * is behind a glass front. Five per cent is the whole of the tuning — rare
 * enough that the first one is a surprise, common enough to be seen at all.
 */
export function drinkFrom(seed) {
  const h = (Math.abs(Math.round(seed)) * 2654435761) >>> 0;
  return {
    flavour: h % CAN_FLAVOURS.length,
    shot: ((h >>> 9) % CAN_BROKEN) === 0,
  };
}
