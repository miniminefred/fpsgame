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
green — it resolves every import in the graph, which is the class of mistake HMR hides.
It does **not** type-check: there is no TypeScript here and Vite checks no types, so a
green build says the modules fit together and nothing about whether they are right.

`npm test` runs the two headless generator validators in `tools/`. They exist because
generation bugs are invisible one floor at a time and obvious over hundreds — every defect
they check for was a real bug that shipped and got caught by widening the sweep. Run them
after touching anything in `src/gen/`. They fail the build only on hard invariants
(connectivity, sealing, prop interpenetration); everything else is a warning with repro
seeds. They run in Node, so no GLB can load and nothing is drawn — but a prop is still
*measured* at its real size, because `modelInfo` falls back to the footprint recorded in
`gen/model-table.js`. That matters more than it sounds: for a long time it did not, and the
sweep was proving its invariants against declared sizes up to a quarter of a metre out from
what the game ships, which hid three hard failures. What still cannot be checked headlessly
is anything about how a model *looks* — orientation, scale, where its origin sits — so that
goes in the browser and in `/dev-models.html`.

In the dev build `window.dev` exposes `{ game, player, enemies, shooting, keys, physics,
destruction, extinguishers, doors, scene, camera, weapons, renderer, audio, casings,
keycards, wallet, ragdolls, cameras }`, which is the fastest way to jump floors, teleport,
or measure something from the console. Note the render loop is `requestAnimationFrame`, so
a backgrounded tab does not tick — measure with the tab visible, or step `update()` by hand.

`/dev-models.html` is a contact-sheet harness for inspecting the furniture models at true
relative scale (see the header of `src/dev-models.js` for its query parameters);
`/dev-guns.html` does the same for the five weapon viewmodels and their measured muzzle
points, building each gun through `weapons.js`'s own `buildWeaponRig` so it cannot drift
from the gun the player holds.

## The game

**Office Descent** — an endless procedurally-generated office shooter. You arrive on a
floor of a grey corporate building, clear the staff still working there, find the service
hatch, and descend. The next floor is generated on the fly, usually a little bigger and
always a little nastier. There is no ground floor.

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
  util.js         Scalar helpers everyone shares: clamp, lerp, angles, hex-to-CSS
  metrics.js      How big a body is and what it can do — the numbers that must agree
  body-pool.js    The lifecycle of a loose body that times out (brass, debris)
  destruction.js  Everything coming apart: damage routing, debris, its lifecycle
  ragdolls.js     Jointed bodies for everything that dies, and their lifecycle
  rigs.js         What the staff, the vermin and the cleaner are made of
  level.js        One floor's lifecycle — generate, animate the exit, dispose
  scene.js        Renderer, camera, fog
  lighting.js     Fill light + a pooled set of ceiling lights that follow the player
  nav.js          Tile navigation: flow field, line of sight, walkability, and a
                  second field for whoever can open a locked door
  enemies.js      Spawning, placement guarantees, the AI state machine, gunfire and melee
  enemy-types.js  The roster: types, bystanders, floor themes, and the pickers
  enemy-anim.js   Per-frame rig animation, and the toppling death fallback
  input.js        Key state, pointer lock, and the fallback look mode when it is refused
  player.js       Movement, AABB collision against an indexed floor, health
  shooting.js     Hitscan: fire rate, ammo, spread, recoil, damage, prop impulses
  weapons.js      Five GLB viewmodels, recoil/reload animation, per-gun combat stats
  extinguishers.js  The secondary: a thrown cylinder, its gas, and what it sets off
  effects.js      Pooled tracers, impact flashes, bullet decals
  physics.js      cannon-es rigid bodies for loose furniture
  audio.js        Sound library + every game event that makes a noise
  sfx.js          WebAudio sample engine: decode, pitch-vary, place, overlap
  casings.js      Spent brass: ejects, bounces, times out
  keycards.js     Card catalogue, the wallet, and the cards on the carpet
  doors.js        Sliding panels, proximity sensors, and the badged ones
  cameras.js      Wall cameras and laser tripwires, and the alarm they raise
  hud.js          Health, ammo, floor, objective, keycards, hit direction, toasts, death
  minimap.js      Per-floor floorplan raster + live player/enemy markers
  textures.js     Procedural canvas textures and the shared material cache
  fx-textures.js  The generated sprites: muzzle flash, tracer, decal, glow, gas
  dev-models.js   Drives dev-models.html
  dev-guns.js     Drives dev-guns.html
  dev-sounds.js   Drives dev-sounds.html
  style.css       All UI styling
  gen/
    tiles.js      The tile vocabulary: sizes, the tile enum, tile<->world, bfs
    layout.js     Floorplan: corridor spine + BSP room blocks + doors. Re-exports
                  tiles.js and locks.js, so the rest of the tree has one address
    locks.js      Badge readers: which door gets which card, and the proofs
    build.js      Floorplan -> meshes, colliders, nav grid, lights, windows
    props.js      Office furniture catalogue and the placement primitive
    rooms.js      Which props a room gets, and where they go against its walls
    models.js     Loads + bakes the downloaded furniture GLBs for batching
    model-table.js  Per-model scale/yaw/footprint normalization data
    geom.js       World-space UVs and the material/chunk geometry batcher
    rects.js      Greedy tile-mask -> rectangle decomposition
    rng.js        Seeded PRNG (every floor is reproducible from its seed)
public/sounds/    Generated MP3 sound set + sounds.json (the prompts that made it)
dev-models.html   Contact sheet for eyeballing the furniture models
dev-guns.html     Contact sheet for the weapon viewmodels and their muzzle points
dev-sounds.html   Measures the whole sound set and flags clips to regenerate
```

The three `dev-*.html` pages are **build inputs** (`vite.config.js`), which is about the
build gate rather than the output: Vite's default input is `index.html` alone, so
`src/dev-*.js` was outside the module graph entirely and `npm run build` did not check a
line of it. `dev-guns.js` imports named exports from `weapons.js`; renaming either used to
leave the build green and the harness silently broken.

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
| Arrow keys | Same as W A S D |
| Shift | Sprint |
| Space | Jump |
| Left click | Shoot |
| R | Reload |
| 1 - 5 | Switch weapon (light to heavy) |
| Esc | Release the mouse |
| Click | Grab the mouse / restart after dying |

## Key systems

### The shared vocabulary (`util.js`, `metrics.js`, `body-pool.js`)
Three small modules exist for one reason: **a number that two files must agree on has to
live in one of them.** This project already has a monument to what happens otherwise —
`FIRST_CONTACT_GAP` below, where the generator and its consumer held the same name at two
different values in two different units, and about one floor in forty could not be started.
That was not an unlucky bug, it was the predictable outcome of a copy, and the repo had
several more of the same shape waiting:

- `cameras.js` hard-coded `1.7` twice to reconstruct the player's head from their feet,
  while `EYE` sat unexported in `player.js`. Retune the player's height and every laser
  tripwire in the building silently mis-tests, with nothing to catch it.
- `tools/validate-props.mjs` declared `BODY_R = 0.4 // must match RADIUS in src/player.js`.
  A comment asking a human to be a compiler, in the tool whose entire job is catching drift.
- `tools/validate-layout.mjs` restated `assignRoles`' branch ladder and had already got it
  wrong — testing area before aspect, at a different threshold — so it reported **zero**
  long-thin rooms on every sweep while the generator was producing thousands of them. The
  sweep had stopped testing the generator and started asserting its own arithmetic back.

So: `metrics.js` holds the body (radius, eye height, step tolerance, gravity, jump) and is
deliberately free of Three.js so the headless validators can import it too. `JUMP_APEX` is
*derived* there rather than written down, because `BEAM_Y` in `cameras.js` is designed
against it — a tripwire you cannot clear is a tax, one you clear by accident is not a
hazard, and deriving it means retuning the jump moves the tripwire instead of quietly
invalidating it. `util.js` holds the scalar helpers (`clamp`, `lerp`, `angleLerp`,
`smoothTo`, `dist2`, `hexCss`) that had two to five copies each across twelve files.
`body-pool.js` holds the lifecycle of a loose body that times out — brass and debris were
the same five operations written twice, down to the identical comment above both `clear()`s.

`util.js` is scalar-only on purpose. The shared **vectors** are not collected, because
`destruction.js` documents a real bug caused by two call sites sharing one scratch
`Vector3`, and a module-level `UP` that anything might `.set()` is that bug waiting to be
reintroduced.

### Three things that used to scan the whole floor (`doors.js`, `enemies.js`, `player.js`)
Everything on a floor grows with the floor number, and the game has no last floor. Three
per-frame loops were written against an early floor and quietly became quadratic or linear
in something unbounded. All three are now the same fix — bucket by position, query the cells
that can matter — and all three were proved identical to the old scan before landing, which
is the only way to change collision or sensing code here:

- **Doors** tested every door against every enemy. The trap was that it was *invisible*: a
  locked door short-circuits, so while the floor is still all-white the scan never runs.
  Pick up the first white card, ~190 locks clear at once, and the cost appears — a
  guaranteed frame-time cliff thirty seconds into every floor, which is exactly when the
  first firefight starts. 8013 → 181 distance tests a frame.
- **Enemy separation** carried the comment "cheap O(n²), but n is small". `n` reaches 200 on
  a deep floor and `items` keeps the dead as well. 7832 → 32 tests a frame.
- **Player collision** tested all ~2700 static boxes three times a frame (once per axis,
  once for the ground), 1.8% of the frame budget at floor 12 and climbing for ever. Only the
  **statics** are indexed: a wall, a fitted desk and a door panel never move — they retire by
  setting `top`, which the scans already test and the index does not care about. Loose
  furniture is re-derived from its physics body every frame and genuinely cannot be indexed,
  so it stays a linear scan. That split is the whole reason indexing is safe here.

The equivalence testing is worth copying. For the player, sampling positions uniformly over
the slab produced thousands of "mismatches" that were all an artefact: half the slab is
inside a wall, and resolving from inside a big box teleports you to its edge. The real
domain is *positions the player can legally occupy*, and on that domain 40,000 samples and
1,217 m of simulated walking agree to the last decimal.

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

### What furniture is never allowed to close (`reserveClearances` in `gen/build.js`)
A tile mask the furnisher may not place into, stamped before a single prop is put down —
because a floor should not be furnished into a state it then has to be rescued from. Doorways
get a 4-tile apron on both sides, and the spawn and exit a clear square.

The third one is `reserveThroughRoutes`, and it is subtler than it looks. Almost every room
opens onto a corridor, and a corridor cannot be furnished shut (its props are 7 tiles apart
in a 6-tile hallway), so furniture cutting a room in half normally costs nothing — both
halves are still reachable from the hall. The exception is a room whose doorway leads into
another **room**: then crossing this one is the far room's only way in, and two props standing
corner to corner across the middle of it do not merely make it awkward, they **end the run**.
A hostile still spawns in the sealed room, because the nav grid is coarser than a body and
believes the gap is walkable, so `hostileCount` can never reach zero. Such a room therefore
keeps a 2-tile (1 m) lane between its doorways — 2 rather than 1 because `canPlace` rounds a
prop's footprint outward to whole tiles, and a metre is comfortably over the 0.8 m of square
body that has to fit.

`5.geom-connected` in `tools/validate-props.mjs` is what caught it, and only once the sweep
was widened: a copyroom shut off by a crate and a shelving unit **0.85 m apart on the
diagonal**, which a 0.8 m square body cannot pass. It had been reachable at roughly one floor
in five hundred for the generator's whole existence.

### Floor generation (`gen/layout.js`, on the vocabulary in `gen/tiles.js`)
Real office floors are not mazes, so the generator does not build one. It carves a corridor
spine first (2-4 vertical, 1-3 horizontal bands, guaranteed to intersect, so the corridor
network is connected by construction), then BSP-subdivides each leftover block into rooms
and cuts a doorway from each room onto whatever it touches. Corridor count scales with the
slab: too few and BSP buries rooms three or four deep behind other rooms.

Everything is a tile grid of `TILE` = 0.5 m cells. Walls are exactly one tile thick, which
is why rooms are carved inset by one tile on their **min sides only** — two neighbouring
rooms then share a single wall tile instead of stacking two.

**The slab is rolled, not derived** (`floorSpans`). The growth curve over the floor number
is the *typical* floor for a depth; each floor then rolls its own size around it — one die
for how much building there is (0.78–1.18 on each axis, so roughly two thirds to half again
the area) and one for what shape it is, applied to one axis and its reciprocal to the other
so changing a floor's shape does not also change how much of it there is. Floors used to be
a pure function of depth, which made a run one long ramp where eight was seven with more
walking; a small floor is a tight quick clear and a big one is a hike, and not knowing which
you stepped out of the lift into is worth more than either. Two bounds keep it honest: no
axis under 120 tiles, because a slab much under 60 m has room for the corridor spine and
little else and the prologue pass then starts stripping readers off doorways to find
somewhere to stand the first body; and the **area** never exceeds the largest slab the curve
ever asked for, because past floor ~12 the difficulty is meant to come from the enemies
rather than from more walking.

It rolls on its own stream, mixed with the floor number, for the two reasons `assignLocks`
does: drawing from the floor's own `rng` would shift every later number and re-roll the whole
building off a die that has nothing to do with its contents, and a stream of the seed alone
would hand every floor of one seed the same shape — which is exactly the variety the
validators sweep for.

`layout.areaRatio` is how the roll came out against that depth's usual, and **anything that
spreads a fixed number of things over a floor has to ask it**: `tuningFor` in `game.js` and
`PER_FLOOR` in `cameras.js` are both authored per typical floor, and 200 staff is a crowd on
that floor and a crush on one two thirds the size. Measured from the spans that survived the
clamps rather than from the die, so a floor that hit a bound reports the area it really has.

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

### The prologue (`freeThePrologue` in `gen/locks.js`)
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

**`FIRST_CONTACT_GAP` is exported from `layout.js` and imported by `enemies.js`, and that
is not tidiness.** The guarantee and its consumer must measure the same thing, and the
first version did not: the generator promised corridor at 14 *tiles walked* while
`_cardOutside` required corridor at 11 *metres straight-line* (22 tiles), so the promise
was in the wrong unit **and weaker than the thing it was protecting**. About one floor in
forty had nobody reachable and could not be started — which is what a player found, not
the sweep, because the sweep was asserting the generator's own wrong number back at it.
Both ends now measure metres from `layout.spawn`, tile-centre to spawn point; even the
half-tile between `round()` and `floor()` on the spawn tile moved the count by nine.

Two defences, because a guarantee that can be wrong should not be the only thing standing
between the player and a dead run: `_prologueSpots` reads every corridor tile rather than
the 1-in-10 sample in `this.corridors` (ten qualifying tiles can sample down to one, and
then a filing cabinet takes it), and the gap is a *preference* — if nothing is beyond it,
`_cardOutside` places the first contact nearer rather than placing nobody. A body on the
doormat is a worse floor; a body nowhere is not a floor.

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

### Enemies (`enemies.js` + `enemy-types.js` + `enemy-anim.js` + `nav.js`)
Everyone chases the same target, so instead of pathfinding per enemy one BFS distance field
is flooded from the player and every enemy walks downhill on it. Anyone going somewhere
*else* — the staffer looking for a toilet — gets a field of their own flooded from their
destination (`nav.floodTo`), because walking straight at a target means walking into the
wall in front of it.

**Nobody sees or hears through the building.** The two senses are answered by two
different structures, and both of them are the floorplan rather than a radius:

- **Hearing** is measured on the distance field, not as a straight line. A radius through
  walls made someone one metre away behind drywall — and a thirty metre walk from the
  nearest door — count as next to you, so firing anywhere turned the whole floor around at
  once. A badged door is out of the nav grid entirely, so it does not merely lengthen the
  walk, it ends it: the path distance across a locked door comes back `-1`.
- **Sight** is `nav.losClear`, and it samples `nav.sight` — a third grid alongside `walk`
  and `fits`. It starts as the shell, because furniture is chest high and a doorway with no
  door in it is a hole, and then **`doors.js` closes it while a panel is shut**, off the
  same `CLEAR_AT` threshold that governs the collider. The two are the same fact and it
  would be odd for them to disagree by a frame.

That second one matters more than it sounds like it should, because **enemy fire is not a
raycast against the building** — `_shoot` fires when `sees` is true. So before this, a
doorway stayed transparent while a panel stood in it, and that was a doorway they shot you
through. It is also what puts a locked room genuinely out of sight rather than only out of
reach, since a badged door never opens at all.

The gameplay consequence is deliberate and worth knowing: a floor is quiet until the first
shot. Enemies in rooms cannot see the corridor through their own shut door, and a door only
opens for whoever walks within `SENSE` of it — so contact happens at doorways rather than
across thirty metres of open floorplan. Gunfire still wakes the floor through hearing, and
they open the doors themselves on the way to you. `losClear` is shared with `lighting.js`
(a fixture you cannot see cannot light you) and `soundPath`, and all three want the same
answer, which is why a shut door now occludes light and sound as well.

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

**A round is worth what it is worth where it lands** (`HIT_ZONES`). All six boxes of the
human rig stop bullets — head ×1.12, torso ×1, each arm and leg ×0.92 — and every one
carries its own `hitScale` on `userData`, so `enemies.hit` is the only code that has to
know. The ordering is the point and the spread is deliberately tiny: a head worth double
turns every gun into a one-shot gun, and a limb worth half punishes you for the 14 cm of
arm that happened to be in front of the chest. Neither is aim. A tenth either way keeps
the head the shot worth taking without letting one round decide a fight on geometry the
player could not have controlled. Limbs used to stop nothing at all, on the grounds that a
14 cm arm box makes hit detection arbitrary. That is true, and it is an argument for a limb
hit being *slightly* cheap, not for it being nothing: a round through somebody's forearm
that does not scratch them is the more obvious lie, and it is the one the player sees,
because the tracer ends on the wall behind a man who did not react. A rat and the floor
cleaner have two boxes, not six, and
the loop skips whatever a rig does not have. On death every box's `enemy` back-reference
is cleared while its `isEnemyPart` flag stays, which is what makes the next round walk
through the corpse instead of being spent on it.

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

**Everything that reasons about how big a prop is must ask `footprintOf` (`gen/props.js`),
not `PROPS[kind].w/.d`**, and this is the sharpest edge in the generator. `tryPlace` always
reserved the model's footprint, but `gen/rooms.js` was doing its arithmetic on the
hand-authored one — and the two differ by up to a quarter of a metre on 9 of the 18
model-backed props, because a model's real size is not what somebody typed in the catalogue.
The `printer` prop ships as a 1.13 m deep `copier` while declaring 0.88, so `edgeProp` seated
it 0.44 m off the wall and it ate 0.125 m of the 0.15 m inset that is the only thing keeping
furniture off the plaster. `openPlan`'s lane test certified a 0.55 m gangway while its own
comment promised 0.8 m of body width. Every one of those sites now goes through one lookup,
and every wall-backed kind measures at exactly 0.15 m across the sweep.

**And `npm test` could not see any of it.** The validators run in Node, so `loadModels()`
never runs and `modelInfo()` returned null — every model-backed prop was fit-tested at its
declared size, which means the placement invariants were being proved against a floorplan
the game does not ship. `modelInfo` now falls back to `MODEL_TABLE`'s recorded `foot` and
`height` when no GLB is in hand (`parts: []`, so nothing draws in Node), which costs nothing
because that data was already there. Turning it on immediately exposed **three pre-existing
hard failures** — a room sealed off from its own floor among them — that the tool had been
reporting as passes for its whole existence. Fixing the footprint source cleared all three.
The lesson generalises: a headless validator that silently stubs out an asset is not
checking a cheaper version of the game, it is checking a different game.

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

### Keycards (`keycards.js` + `assignLocks` in `gen/locks.js`)
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

**The alarm is the one exception, and it is one flag wide** (`keyed` in
`enemies.js`). The security response — the men in the office, and the ones sent up
— are carrying a badge, so for them a locked door is a door: the sensor sees them
and the panel opens (`doors.js`), and they have a **second distance field** to
walk, flooded over `walk` plus those openings (`nav.setBadgeTiles`). Three things
keep that from being a hole in everything above:

- **The keyring is the shift's real one, white and blue** (`badgeOpens` in
  `keycards.js`). Grey, yellow and black are somebody else's, so the broom
  closet, the back-of-house rooms and the manager's office are exactly as shut to
  a responder as they were before the klaxon — and the black card stays the last
  beat of a floor.
- **The sensor and the route are the same decision.** `doors.badgeTiles()` is
  what nav is given, and it is built from the same predicate the sensor asks. A
  body routed into a door that then refuses to open is the failure mode here, and
  it cannot be reached from one place saying yes and the other no.
- **Nobody else is keyed.** Everybody who merely *hears* the alarm walks the
  ordinary grid, so a locked door still ends the walk — which is `pathDistance`
  coming back -1, the same rule that already governs hearing a gun.

A door held open by somebody coming out of it is open, and you can follow them
back through it while it is. The reader stays red, because nothing about your
pocket changed.

Readers are two `InstancedMesh`es per floor (plate + lamp) rather than a mesh each,
which is what makes two hundred of them affordable and makes turning one green a
colour write. Minimap tints staff-only rooms only — tinting white would tint the
whole map.

### Building security (`cameras.js` + `alarm` in `enemies.js`)
Five to ten units on every floor, in two trades that ask different questions:

- **Watchers** hang off a wall at 2.5 m and sweep a slow arc. Walk into the cone and
  the lamp goes amber and the thing tracks you; six seconds of that and it calls it in.
  Breaking the look **drains** the count rather than resetting it, so ducking behind a
  doorframe for one frame is not a pardon — the second time it sees you it has less
  patience.
- **Tripwires** are a laser across a corridor at hip height with no timer at all: the
  beam is either unbroken or the alarm is already going. Mounted low and drawn bright
  on purpose, because a tripwire you cannot see before you cross it is a tax rather
  than a hazard. `BEAM_Y` is under a jump's apex (1.36 m), so vaulting one is a real
  option and not a happy accident — the number is chosen against `JUMP_SPEED`.

Both are one round from any gun, like the glazing and the ceiling tubes. That is the
reward for noticing one first, and it is why the lamp is on the FRONT of the unit
beside the lens: the tell has to be legible from exactly where the camera is looking.

Three things are load-bearing:

- **A camera does not have to look off the wall it hangs on.** All three facings that
  are not into the wall are measured and the longest clear run wins, which is what
  turns a camera in a 3 m corridor down the hallway instead of at the plaster
  opposite. The bracket is a separate frame from the pivot for the same reason — a
  camera whose mount swings round with its lens has come off its mount.
- **Placement walks a shuffled list of wall-adjacent tiles, it does not throw darts.**
  Dart-throwing was the first version and it quietly shipped four cameras on one floor
  and ten on the next: a tile that survives every test is a few percent of a floor, so
  400 darts is not a sample, it is a lottery.
- **One alarm at a time** (`REARM`). Three cameras that all reach six seconds in the
  same corridor would each call in their own response, and the floor would answer one
  sighting with twelve men.

What an alarm *costs* is `enemies.alarm`, and it is one decision made ten minutes
earlier: **four** security come up from below, at a walked distance, out of your line
of sight, already in `chase` with your position in hand — **unless the security office
on this floor is still manned**, in which case the men in it come out of it and only
**two** more are sent. So clearing the security office early is a genuine trade rather
than loot: it costs you two kills you would rather have banked, and it doubles what
turns up the first time a camera gets six seconds of you.

**They open their own door**, which is the one place in the game where the lock rule is
bypassed and the reason `keyed` exists — see the alarm exception under Keycards above.
Two things follow that are easy to miss. They stop being `behindLock` the moment they
are ordered through it, because that flag is what times the black card, and a floor that
hands you the last card while four guards are still walking at you has counted wrong.
And they keep looking for far longer than anybody else does (`RESPONSE_PATIENCE` against
`GIVE_UP`): they were sent up here for one reason and have no desk on this floor to give
up and go back to.

**And the floor hears it.** Every idle hostile with a route to you inside
`ALARM_HEARING` starts walking it. They are *not* keyed — a klaxon is not a badge — so
they come the way the building lets them and a locked door ends the walk, which
`pathDistance` says by coming back -1. On a floor where you are still holding nothing
that is a handful of people in the corridors; once white is in your pocket it is
however much of the building is within thirty walked metres.

Anyone who arrives this way was not on the floor when it was generated, which has two
consequences that are easy to miss: `shooting.addHittables` has to be told about them
or bullets pass straight through, and they carry blue if the floor has a blue lock,
because "security carries blue and nobody else does" has to stay true for the late
arrivals too.

### Hit direction (`hud.js` + `#hitdirs`)
Taking damage puts a red chevron on a ring around the crosshair pointing at whoever landed
it. The wedge stores the attacker's **world** bearing, fixed at the moment of the hit, and
is re-aimed every frame against the player's facing — so turning toward the shot swings its
wedge up to the top of the screen, which is the entire job. A screen-space angle frozen at
hit time would rotate with you and point at nothing.

`hud.damage(intensity, sx, sz)` — leave the source off and only the red rim fires, which is
what damage with no direction (standing inside a blast) does. The pool is six wedges in the
markup and the HUD never creates DOM; two hits within `HITDIR_MERGE` of each other refresh
one wedge instead of stacking, because an SMG burst is one attacker and should look like
one. `game.js` feeds position and yaw in every frame via `setFacing`.

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
