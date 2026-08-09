# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Alfred — 3D FPS

Browser-based 3D first-person shooter built with **Three.js**, bundled by **Vite**.
The code is split into small ES modules under `src/` — **never let a single file grow
without bound**; when a module gets large or mixes concerns, split it.

## The one hard rule: AI-only development

This project is developed entirely by Claude writing code — **no visual/scene editor**
(no Unity, no Godot editor, no Blender-in-the-loop). Build tooling, bundlers, package
managers, and CLIs are all fair game; a GUI world-builder is not. Everything is expressed
in code so an AI can author and reason about all of it.

## Why Three.js + Vite

Three.js was chosen (June 2026) as the best fit for pure AI development: code-first with no
editor required, and backed by by far the largest ecosystem / documentation corpus of any
web 3D engine — the most reliable target for an AI writing everything by hand. Vite gives us
real modules, npm dependencies, HMR, and a production build with zero config friction.

## Launching a session

Desktop shortcut **Create FPS** runs `..\launch-fpsgame.ps1`, a thin wrapper over
`C:\Users\alfred\projects\launch-claude.ps1 -Game fpsgame`. That script opens a
**Windows Terminal** tab hosting **PowerShell 7**, forces UTF-8 in and out so Claude's TUI
(box drawing, spinners) renders correctly, `cd`s here, runs `npm install` if `node_modules`
is missing, then starts `claude`. `-NoExit` keeps the shell in this directory after Claude
exits, ready for `npm` / `git`.

No `.bat`/cmd launchers exist any more — the whole chain is PowerShell. The launcher lives
in the parent directory, so it is outside this repo and not version-controlled here.

## Rules for every session

### 1. Commit every change immediately
After **every** file edit — no exceptions — stage and commit before moving on:
```bash
git add -A
git commit -m "<short description of what changed>"
```
One logical change = one commit. Never batch multiple changes into one commit, and never
leave changes uncommitted at the end of a session. This is the rollback safety net.

### 2. Start the dev server on session start
Check if already running; start if not:
```powershell
npm run dev
```
Vite serves the game at **http://localhost:8090** (port 8090 so it coexists with the
blobgame on 8080) and opens the browser automatically. HMR reloads on every save — no
manual refresh needed.

First time on a fresh clone: `npm install`.

### 3. Test after every change
Verify in the browser before considering the task done. `npm run build` must also stay
green (it type-checks the bundle and catches import mistakes HMR can hide).

`npm test` runs the two headless generator validators in `tools/`. They exist because
generation bugs are invisible one floor at a time and obvious over hundreds — every defect
they check for was a real bug that shipped and got caught by widening the sweep. Run them
after touching anything in `src/gen/`. They fail the build only on hard invariants
(connectivity, sealing, prop interpenetration); everything else is a warning with repro
seeds. Note they run in Node, so GLB models cannot load and the props fall back to boxes —
model-path placement has to be checked in the browser.

In the dev build `window.dev` exposes `{ game, player, enemies, shooting, physics, scene,
camera, weapons, renderer }`, which is the fastest way to jump floors, teleport, or measure
something from the console. `/dev-models.html` is a contact-sheet harness for inspecting the
furniture models at true relative scale (see the header of `src/dev-models.js` for its
query parameters).

## The game

**Office Descent** — an endless procedurally-generated office shooter. You arrive on a
floor of a grey corporate building, clear the staff still working there, find the service
hatch, and descend. The next floor is generated on the fly, a little bigger and a little
nastier. There is no ground floor.

## Project layout

```
index.html        Entry shell: overlay, HUD markup, minimap canvas
vite.config.js    Dev/preview server pinned to port 8090
tools/
  validate-layout.mjs  Headless floorplan invariants (connectivity, doors, sealing)
  validate-props.mjs   Headless furniture-placement invariants
src/
  main.js         Bootstrap: wires modules, runs the render loop
  game.js         The run: floor progression and difficulty curves
  destruction.js  Everything coming apart: damage routing, debris, its lifecycle
  ragdolls.js     Jointed bodies for everything that dies, and their lifecycle
  rigs.js         What the staff, the vermin and the cleaner are made of
  level.js        One floor's lifecycle — generate, animate the exit, dispose
  scene.js        Renderer, camera, fog
  lighting.js     Fill light + a pooled set of ceiling lights that follow the player
  nav.js          Tile navigation: flow field, line of sight, walkability
  enemies.js      Enemy types, AI state machine, gunfire and melee
  player.js       PointerLockControls + movement + AABB collision + health
  shooting.js     Hitscan: fire rate, ammo, spread, recoil, damage, prop impulses
  weapons.js      Five GLB viewmodels, recoil/reload animation, per-gun combat stats
  effects.js      Pooled tracers, impact flashes, bullet decals
  physics.js      cannon-es rigid bodies for loose furniture
  audio.js        Sound library + every game event that makes a noise
  sfx.js          WebAudio sample engine: decode, pitch-vary, place, overlap
  casings.js      Spent brass: ejects, bounces, times out
  keycards.js     Card catalogue, the wallet, and the cards on the carpet
  doors.js        Sliding panels, proximity sensors, and the badged ones
  hud.js          Health, ammo, floor, objective, keycards, toasts, death screen
  minimap.js      Per-floor floorplan raster + live player/enemy markers
  textures.js     Procedural canvas textures and the shared material cache
  style.css       All UI styling
  gen/
    layout.js     Floorplan: corridor spine + BSP room blocks + doors
    build.js      Floorplan -> meshes, colliders, nav grid, lights, windows
    props.js      Office furniture catalogue and per-room-role furnishing
    models.js     Loads + bakes the downloaded furniture GLBs for batching
    model-table.js  Per-model scale/yaw/footprint normalization data
    geom.js       World-space UVs and the material/chunk geometry batcher
    rects.js      Greedy tile-mask -> rectangle decomposition
    rng.js        Seeded PRNG (every floor is reproducible from its seed)
public/sounds/    Generated MP3 sound set + sounds.json (the prompts that made it)
dev-models.html   Contact sheet for eyeballing the furniture models
dev-sounds.html   Measures the whole sound set and flags clips to regenerate
```

## Tech stack

- **Engine:** Three.js (npm `three`)
- **Bundler / dev server:** Vite (`npm run dev` / `npm run build` / `npm run preview`)
- **Rendering:** WebGL (`THREE.WebGLRenderer`, antialias, PCF shadow map)
- **Camera:** `PerspectiveCamera` driven by `PointerLockControls`
- **Physics:** `cannon-es` for loose props only. The player and enemies stay hand-rolled
  and kinematic — putting a first-person player on a rigid body feels bad and is not worth
  the fight.
- **Assets:** weapon viewmodels and office props are CC0/CC-BY GLBs under `public/models`
  (see the CREDITS files). Everything else — walls, floors, furniture, enemies, textures —
  is generated procedurally in code.

## Controls

| Key | Action |
|-----|--------|
| Mouse | Look around (when pointer is locked) |
| W A S D | Move (relative to look direction) |
| Shift | Sprint |
| Space | Jump |
| Left click | Shoot |
| R | Reload |
| 1 - 5 | Switch weapon (light to heavy) |
| Esc | Release the mouse |
| Click | Grab the mouse / restart after dying |

## Key systems

### Backing a prop against a wall (`edgeProp` in `gen/rooms.js`)
Props are authored facing **-z** (`gen/props.js`), and `edgeProp`'s side number
**is** the quarter turn that puts that face into the room: 0 = the +z wall, 1 =
-x, 2 = -z, 3 = +x. The two even sides used to be swapped, which stood every
vending machine, whiteboard and reception desk on the ±z walls with its front to
the plaster, and aimed `deskAgainstWall`'s chair into the wall so those desks came
out with nobody sitting at them. Invisible on a grey box; instantly obvious the
moment something with eight lit screens went in. `edgeProp` returns *where* it
landed (`{cx, cz, rot, side}`) so a room can put a chair in front of what it just
placed — `seatFacing` does that.

### Floor generation (`gen/layout.js`)
Real office floors are not mazes, so the generator does not build one. It carves a corridor
spine first (2-4 vertical, 1-3 horizontal bands, guaranteed to intersect, so the corridor
network is connected by construction), then BSP-subdivides each leftover block into rooms
and cuts a doorway from each room onto whatever it touches. Corridor count scales with the
slab: too few and BSP buries rooms three or four deep behind other rooms.

Everything is a tile grid of `TILE` = 0.5 m cells. Walls are exactly one tile thick, which
is why rooms are carved inset by one tile on their **min sides only** — two neighbouring
rooms then share a single wall tile instead of stacking two.

Two invariants are load-bearing and covered by `tools/validate-layout.mjs`: the floor is
always fully connected from the spawn, and two doorways never merge into one wide hole
(each room cuts its own door, so without a minimum wall stub the second lands flush
against the first).

### Hall doors (`cutHallDoors` in `gen/layout.js` + `buildHallDoors` in `gen/build.js`)
The corridors get doors of their own — otherwise the hallway network is one continuous
open loop, the one part of the building that reads as a level rather than as an office.
They are the exception to almost everything the room doorways do, and all of it falls out
of there being no wall across a corridor to cut a hole in:

- They span the corridor **wall to wall** (3 m, against a room doorway's 1.5 m), so the
  width invariant is different for them — `hall: true` is what says so, and
  `validate-layout.mjs` checks `6.hall-*` instead of `6.door-width`.
- They **swing**. A retracted panel goes inside the wall beside its opening
  (`slidePocketSide`), and beside a corridor there is one tile of wall with somebody's
  office behind it. So a hall door is two hinged leaves that fold back flat against the
  corridor walls, which is what the doors they are modelled on do anyway. `doors.js` drives
  both kinds off one `open` number — sliding is a translation, swinging is a rotation.
- Placement is entirely the swing: a leaf needs the wall it folds onto to be *there* for
  its own length, and proving that also refuses junctions (at a crossing the flanking wall
  is the other corridor) and keeps a leaf from swinging across a room's doorway and sealing
  it. Cut after `connectAll`, against the finished floor.
- **They carry readers like everything else** — but they are the only lock in the game that
  can stand between the player and the rest of the floor, so both tiers are *proved*:
  - **Grey**, only where the corridor network goes round. `goesRound` seals the door and
    re-floods; if anything that was reachable stops being reachable, it does not get the
    lock. The test is cumulative, so two doors that each have a way round can never shut
    the last one between them.
  - **White** on the rest, which is the same badge already on every room door.

  A grey hall door costs a detour; a white one costs the first thirty seconds. Neither can
  cost the run. The reader mounts differently from a room's — a hall door's only wall is the
  corridor's side, running the other way — so it turns 90°, stands proud of that wall, and
  steps back *against* the swing so an open leaf never folds over it.

### The prologue (`freeThePrologue` in `gen/layout.js`)
White is the one lock you meet holding nothing, so it is the one the floor has to prove it
can hand you a key to. With every reader still red, the lifts must reach `PROLOGUE_MIN`
tiles of corridor at least `PROLOGUE_REACH` from spawn — somewhere to stand the first body.
If not, the reader comes off the doorway on the edge of the region and it asks again: hall
doors first (freeing one costs only its reader), then room doorways fronting a corridor
(freeing one costs that room its lock entirely, so the white pass skips any room with a
`free` door). It terminates by construction — freeing doorways only grows the region, and
freeing all of them is a floor with no readers on it.

`layout.prologue` is that region, handed to `_cardOutside` so the guaranteed first contact
is somebody the player can actually walk to.

This caught a **pre-existing** bug the day it was written, and not a subtle one: on about
one floor in seven the lobby's only doorway was shared with a neighbouring room, that room's
white pass badged it, and the floor began with the player sealed in the lift lobby holding
nothing. It had nothing to do with hall doors — it needed a check that asked the question,
and hall doors are what made anybody ask it. `8.hall-prologue` in `validate-layout.mjs`.

### Geometry batching (`gen/geom.js`)
A floor is tens of thousands of tiles. Runs of tiles are merged into maximal rectangles
first (`gen/rects.js`), then batched **per material and per 12 m chunk**. Material-only
batching would give few draw calls but one giant bounding box each, so every bullet
raycast would test every triangle on the floor. Chunking keeps draw calls low while
letting three's bounding-box test reject almost everything.

All world surfaces use world-space UVs (one texture repeat = 2 m), so a texture never
stretches differently on a long wall than on a short one.

### Lighting (`lighting.js`)
Ceiling fixtures are emissive panels in the batched geometry — visible floor-wide and free.
A **fixed** pool of 12 point lights is then re-homed every few frames onto the nearest
fixtures; the pool never grows or shrinks, so materials compile once. Candidates are
filtered by line of sight, because shadowless point lights otherwise shine straight through
walls and light the ceiling of the room next door.

Fixtures are placed per room and then along corridors, never on one global grid — rooms are
only ~4.5 m across at the smallest, so a global grid leaves some rooms pitch black.

### Enemies (`enemies.js` + `nav.js`)
Everyone chases the same target, so instead of pathfinding per enemy one BFS distance field
is flooded from the player and every enemy walks downhill on it. Anyone going somewhere
*else* — the staffer looking for a toilet — gets a field of their own flooded from their
destination (`nav.floodTo`), because walking straight at a target means walking into the
wall in front of it.

Hearing is measured on that field, not as a straight line. A radius through walls made
someone one metre away behind drywall — and a thirty metre walk from the nearest door —
count as next to you, so firing anywhere turned the whole floor around at once.

Each floor rolls a **theme** that tilts the type weights (Infestation, Automated,
Lockdown…), so floors have their own character without any of them becoming one enemy
repeated; the name is shown on the way in. Types share one rig with different numbers and
colours; the visor colour tells you what is about to happen.

A handful of **neutrals** — the Panicking Staffer looking for a toilet, plus a Night Cleaner
and Couriers — are placed by hand on every floor rather than rolled (`weight: 0`). They are
not in the state machine at all: no alert, no chase, no weapon, and seeing or hearing you
changes nothing. They do **not** count toward clearing the floor (`hostileCount`, not
`aliveCount`), so you can walk past every one and take the exit. Shoot one and it flees for
a few seconds — the same wander loop, quicker, with destinations filtered to somewhere
further from you — then goes back to its day. They show yellow on the minimap, because "do
I have to shoot this" needs answering from the far end of a corridor.

Visors answer that same question first and identity second. Every hostile human wears a
**grey** — one ramp from near-white (Intern) to near-black (Sentry Unit), brightest for
what dies to a look and darkest for what does not — and the Reanimated wear green. The
harmless staff are the only ones in an actual colour: white for the Panicking Staffer,
brown for the Night Cleaner, yellow for the Courier. So hue says threat, shade says which
one, and no two types share a visor.

Melee types swing office junk (fire extinguishers, keyboards, monitors) and land the hit
part-way through the swing, so you can back out of reach. A weapon declares how it is
carried when idle (`rest` in `BLUNT`), because a mop is not held out in front like a
stapler — it is dragged, head on the floor.

Two trades are in **uniform** rather than in a suit, and both are the only source of
one keycard — see Keycards below. The **Janitor** is yellow shirt, blue trousers, blue
cap and nearly a metre of mop. **Security** is black trousers, a blue shirt and a black
cap with the job written across the front of it, which is the same fact at three ranges:
the dark silhouette down a corridor, the blue in the middle distance, the word once he is
close enough for it to be too late. Half the shift is `security` with a sidearm and the
rest `guardBaton` with a baton — one uniform, one roster name, `guard: true` for the code
that has to find them, and the mix is hand-placed (the rolled ones came off their desks
with a gun on).

Types may declare `pants` and `cap`, which switches the rig from "one suit with a shirt
front" to a uniform, plus `capText`, which letters the cap from a canvas texture shared
by everyone wearing that word. The hit flash follows whatever they are actually wearing
(`flash` from `rigs.js`) rather than the one material that used to be everything.

Gunfire spread is sampled as a real angle and converted into a miss distance at your range,
so backing off genuinely makes you harder to hit.

### Furniture models (`gen/models.js` + `gen/props.js`)
Static props are drawn with downloaded CC0/CC-BY GLBs; loose props are not. The split is
about physics, not destructibility: a loose prop needs its own mesh so the solver can move
it, and a model is one merged mesh per material. So chairs, crates, coffee tables and water
coolers stay procedural and shovable, and desks, cabinets, shelving, copiers, sofas, vending
machines, racks, plants and meeting tables are models.

A prop with a model uses THAT model's measured footprint rather than the hand-authored one,
so collision always matches what you can see. Every model is missing-safe — if a GLB fails
to load, the prop silently falls back to its boxes.

Every model-backed prop still authors a `build()` of boxes, and it now earns its keep twice:
as that fallback, and as the pieces the prop breaks into. `tryPlace` runs it through
`sink.captureBoxes()` — a dry run that collects the boxes without drawing them — so the
model is what you see and the boxes are only what it falls apart into.

Those boxes are then painted from the model, so the ruins look like the thing that was
standing there rather than somebody else's furniture. At load, each material group in a GLB
is reduced to one flat colour plus a scatter of surface points, and every fragment takes the
colour of whichever group it contains most of (`paintDebris`) — a red extinguisher throws
red pieces, a plant throws green ones, and nothing has to slice model geometry at runtime.
Two details are load-bearing. Every sample carries the surface AREA it stands for, because
counting points lets a keypad modelled from forty little quads outvote the whole panel it
sits on, and a fragment the size of the machine comes out keypad-grey. And a fragment that
touches none of the models — a rack's stock, the cartons on a pallet, the monitor above a
desk — keeps the palette it was authored in, because for those boxes the palette is what you
were looking at.

Models arrive at arbitrary scale facing arbitrary directions (28 of 71 were facing the
wrong way), so `model-table.js` records the yaw and scale that put each at real-world size
facing -Z. Check a new entry in `/dev-models.html` before trusting it, and beware that a
model's name is not its size: the `printer` model is a 24 cm desktop unit, which is why the
floor-standing prop uses `copier`.

### Ragdolls (`ragdolls.js` + `bones` in `rigs.js`)
Everything that dies falls over properly: staff, Reanimated, Sentry Units, rats
and the floor cleaner. The **skeleton is declared in `rigs.js`** next to the
geometry it describes — a `bones` array of `{parts, size, at, mass, joint}` in
unscaled rig space — because that file is the one that knows an arm is 0.54 long.
`ragdolls.js` only knows how to hand that to the solver and take it back.

A person is six bones and five `ConeTwistConstraint`s (hips fused into the
trunk); a rat and the cleaner are one `whole: true` bone each, since jointing a
27 cm rat is nine bodies spent on a blur.

The lifecycle mirrors `destruction.js`, because it is the same problem — something
cheap becomes expensive and that has to be bounded:

- **ACTIVE** — jointed bodies, solver-driven. Capped at `MAX_ACTIVE` (10).
  Going over does **not** refuse the new one; it settles the *oldest* early,
  because whatever you just shot is what you are looking at.
- **SETTLED** — bodies removed, meshes frozen where they landed. Free.
- **SINKING** — through the floor and gone. `MAX_CORPSES` (26) total.

Ragdolling is always allowed to fail — no physics, no skeleton, cap reached mid-
teardown — and `_die` in `enemies.js` still holds the old toppling animation as
the fallback.

Two things earned their comments the hard way. Jointed bodies are their own
collision group **that does not collide with itself** (`GROUP_JOINTED` in
`physics.js`): constraints pulling a limb into the torso while contacts shove it
out is how a ragdoll vibrates itself across a room. And the shot impulse is
multiplied by bone mass before it reaches the solver, which makes `HIT_IMPULSE` a
change in *speed* — one number tunes a rat and a manager alike, and 4 m/s is about
where a body stops falling and starts being launched.

**How hard is the gun's, and how hard depends on where you were standing.** A
killing shot carries a `punch` — `throwPunch` in `shooting.js` — which is the
weapon's own `punch` multiplied up as the range closes, over a range the weapon
declares itself (`throwMul`/`throwTo` in `weapons.js`). That last part is the
whole design: one shared falloff makes every heavy gun the same gun. A shotgun
gets 2.1× and loses it all by 7 m, so it throws bodies in a doorway and nowhere
else; a sniper gets 2× spread over 34 m, because a rifle round arrives across the
floor with what it left with; a pistol gets 1.15× and never really does this.

`ragdolls.js` spends that on three things at once, all lerped from the same
number, and it is the three together that turn a fall into a launch: **speed**
(`HIT_IMPULSE × punch`, 3 m/s to ~11), **lift** (how much is redirected upward —
a body that stays on the floor cannot look thrown), and **share** (how much goes
into the whole skeleton rather than the one bone that was hit — the difference
between a person being thrown and an arm being yanked while the body stays put).
The remainder always goes into the hit bone *at the contact point*, which is
where the tumble comes from. An explosion is `BLAST_PUNCH`, above anything a gun
can do, falling off the way its damage does.

One consequence worth knowing: bodies are now regularly airborne, so the
`MAX_ACTIVE` eviction settles the oldest ragdoll that has **stopped moving**
rather than the oldest outright — settling freezes a body exactly where it is,
and a corpse hanging in mid-air is worse than one extra body simulating.

`enemies.hit()` carries the bullet's direction, contact point and punch purely so
the killing shot can throw the bone it landed on; `splash()` synthesises an
outward one. Explosions need nothing else — ragdoll bones are ordinary dynamic bodies, so
`physics.blast()` already sweeps them.

### Keycards (`keycards.js` + `assignLocks` in `gen/layout.js`)
Every door in the building has a badge reader beside it. Cards do not travel
between floors. The five fall into **two groups governed by completely different
rules**, and conflating them is the mistake to avoid:

**White is the staff badge.** It goes on *every* room with a door — the exit room
included, the spawn lobby excluded (a reader on the room you start inside is a
floor you cannot leave) — and on most of the doors across the corridors too. Every
employee carries one. So white is not really a lock, it is the first thirty
seconds of a floor before you have taken a badge off somebody, and picking one up
opens ~190 doors at once. What guarantees you can take that first badge is the
prologue pass above.

**Grey, blue, yellow and black are real locks.** Grey goes on 2–4 back-of-house
rooms, a few hall doors that have a way round them, and also opens white doors;
blue opens the one security office, yellow the one broom closet, and neither
substitutes for anything else; black opens the manager's office and, being the
last card you get, everything else too.

Card holders: every hostile carries white; a guaranteed single holder carries grey
instead, plus `CARD_SPARE_CHANCE` extra grey. Yellow and blue are not dealt that
way — they belong to a trade (below). A card only becomes a pickup if the player
doesn't already hold that tier and none is already lying about, or a floor would
bury itself in two hundred white cards.

**Blue belongs to security and to nobody else** (`_security` in `enemies.js`).
Every guard on the floor is carrying one, and the ones the theme's `patrols` puts
in the corridors are outside every lock, which is what guarantees the card is
reachable with nothing in your pocket. Two to five more are posted in the security
office itself, marked `behindLock` and dealt no card — and, exactly like the broom
closet, only posted **if at least one guard made it into the halls**. A theme is
allowed to say nobody is doing rounds tonight; a floor with a security office and
nobody outside it is a door with no key, so the office sets a floor of one under
whatever the theme asked for.

**Yellow belongs to the janitors and to nobody else.** One to three do rounds in
the corridors — outside every lock, which is what guarantees the card is reachable
with nothing in your pocket — and every one of them carries it. Two more sit in
the broom closet, marked `behindLock` and dealt no card at all, because two men
sitting in the room their own key opens holding that key is the exact failure this
system exists to prevent. They are only seated **if at least one janitor made it
onto rounds**; without a reachable holder the closet pair would be a floor that
cannot be cleared. Same shape as the manager one tier down: take the card off
somebody in a hallway, and it buys you a door with two more behind it.

**Black is different, and it is the last beat of a floor.** The Manager sits in
the manager's office, behind the black door (`_manager` in `enemies.js`) — he is
the only person on the floor who works behind a real lock, which means the black
room *is* on the critical path where grey, blue and yellow never are. It works
because of when his card arrives: black is not dealt to anybody, it comes off
**the last hostile you can reach** — the second-last on the floor, since he is
unreachable. So the order cannot come out wrong: clear the floor, find you are one
short, find the card on the last body, go and open the one door you have been
walking past. `enemies.openHostileCount` (hostiles not `behindLock`) is what times
it. He is a Manager on every floor regardless of `unlockFloor` — a manager's
office with an intern in it is a joke that only works once.

The invariants, all proved rather than hoped for (`tools/validate-layout.mjs`,
checks `8.*`, plus `5.lock-sealed` in `validate-props.mjs`):

- **Grey, blue and yellow are loot, never the route.** Filling every staff-only
  room in solid still leaves every white room and the exit reachable from spawn.
  Black is the deliberate exception — see the Manager above — and it is safe
  because his card is always on a body you can already reach.
- **No card is behind the door it opens, or behind another card's door.** Each
  staff-only room must be reachable with the other three shut, and `enemies.js`
  never spawns anyone inside one — so those rooms are worth nothing to
  `hostileCount` either.
- **White is safe because it is everywhere.** Staff *do* work in white rooms, so
  the card is behind the door and in front of it a hundred times over. What makes
  the *first* one reachable is `_cardOutside` in `enemies.js`: a floor is
  guaranteed `OUTSIDE_MIN` hostiles standing in corridors, one within
  `FIRST_CONTACT` metres of the lifts — and, since the corridors got readers too,
  standing inside `layout.prologue`, which is the part of the floor you can walk
  to before you have badged anything. Without both halves of that guarantee a
  floor is a lift lobby and two hundred shut doors.
- **Every** opening into a locked room is locked, not just the ones that room cut,
  and a door is never *downgraded* — the white pass uses `??=`. Two staff-only
  rooms are never allowed to share a doorway at all, because whichever tier that
  door took, the other room would be openable with the wrong card.
- A doorway must be able to hold a panel, which is why `slidePocketSide` lives in
  `layout.js` and not in the builder that fits doors. ~2 rooms a floor miss out on
  a lock for this reason (a WARN, not a FAIL).

A badged door is shut to the enemies too, at the nav grid rather than in `doors.js`
— the flow field must not route a chase through a door the chasers cannot open.
What clears a lock is **picking up the card, not walking up to the door**: every
door that badge fits goes live at once and hands its opening back to nav
(`nav.openTiles`). Unlocking per-approach would leave the building sealed to its
own occupants until the player had personally visited all two hundred doorways.

Readers are two `InstancedMesh`es per floor (plate + lamp) rather than a mesh each,
which is what makes two hundred of them affordable and makes turning one green a
colour write. Minimap tints staff-only rooms only — tinting white would tint the
whole map.

### Sound (`sfx.js` + `audio.js` + `public/sounds/`)
Everything audible is a generated MP3 (see the `sound-generation` skill; `sounds.json`
holds the prompt that produced every clip, so the set can be rebuilt). `sfx.js` is the
engine — decode, pool, place, overlap — and knows nothing about the game; `audio.js` is
the library plus one method per thing that can happen.

Three rules earned their place the hard way:

- **There is no voice cap and no throttle, anywhere.** Whatever the game says happened
  gets played, however many are already ringing. A dropped shot is silence, silence
  mid-burst reads as the gun jamming, and nothing errors — so the fault is invisible from
  inside the game. An SMG at 900 rpm firing a 0.7 s clip is ~10 shots overlapping before
  anything else joins in, and a firefight stacks a room of return fire, impacts, boots
  and screaming on top. The brickwall limiter on the master bus is the only thing holding
  the sum inside full scale, which is where that job belongs. Deciding a sound *should
  not have been asked for* is the caller's job: continuous contact with a desk is one
  shove, and `game.js` — which understands the collision — is what says so.
- **Clips are measured and conditioned at decode.** Generated audio arrives at wildly
  inconsistent levels: the first pass drew three pistol takes at 1/50th the loudness of
  the shotgun's, which played as silence and read as the gun randomly misfiring. Takes
  are pulled toward a common RMS (bounded, never into clipping) and started at their
  onset, because a take whose blast sits 480 ms into the file makes every burst ragged
  no matter how many voices are free.
- **Never the same take twice in a row**, and every play draws a random playback rate.
  That, not clip count, is what stops repetition sounding cheap.

`/dev-sounds.html` measures the whole set and flags duds — a variant far quieter than
its siblings is a clip to regenerate, not to amplify. Check it after generating anything;
roughly a third of first-pass draws came back unusable and none of it is audible as a
fault from inside the game.

Enemy types name a vocal set with `voice` (`enemy` staff who shout at you, `zombie`,
`robot`), so a new type gets its own throat by adding four files.

Every prop carries a `substance` (`gen/props.js`), which picks its impact, break and
settle clips from one table in `audio.js` — a filing cabinet and a pot plant have no
business sounding alike when shot, destroyed, or landing. Window glazing and ceiling
tubes are building, not furniture, so their `kind` names their substance instead.

### Destruction (`destruction.js` + `gen/geom.js` + `physics.js`)
Everything on a floor can be destroyed: all furniture, the window glazing, and the ceiling
tubes. Only the shell — walls, floor, ceiling slab — is permanent, because the generator's
connectivity and sealing invariants are proved once at generation and nothing re-proves them
at runtime.

Loose furniture is the easy half: it is already its own mesh and its own body, so breaking
it is "re-emit each of its boxes as a body".

The hard half is everything else, which was merged into a batched chunk and has no mesh left
to delete. Two mechanisms make it work, and both live at the seam between batching and
destruction:

- **Spans.** Anything drawn between `batcher.beginSpans()` and `endSpans()` remembers which
  mesh it landed in and which run of vertices it owns. Destroying it collapses that run onto
  a single point, leaving degenerate triangles: nothing rasterizes, nothing shadows, and no
  ray can intersect it. The vertex count never changes, so no other span's offsets move.
- **Hit routing by `faceIndex`.** A raycast against a chunk hits a mesh shared by a hundred
  props, so mesh identity says nothing — but a prop's vertices are a contiguous run, so a
  binary search over the runs on that mesh names it exactly. No spatial guessing and no
  tolerance to tune, which is what keeps a pane of glass three centimetres in front of a
  wall from being confused with the wall.

Destroying a static prop has to give back *four* things it was holding, and missing any one
of them is a bug that only shows up later: its geometry (the span), the player's collider
(`top = -1`), the solver's own static body (`physics.removeStatic` — miss this and debris
rests in mid-air on furniture that no longer exists), and its nav tiles
(`nav.openTiles`, which also re-erodes `fits` and invalidates the distance field).

Fragments are judged on their LONGEST side, not their shortest: office furniture is panel
goods, so a filter wanting every dimension to clear a threshold throws away almost
everything worth watching fall. They are capped per prop and globally, and they time out, so
a long run cannot grow the body count.

Windows are two layers on purpose. The sky is a permanent backdrop and only the glazing in
front of it is destructible — the shell is never cut, so if the sky went away with the glass
you would be looking at grey drywall.
