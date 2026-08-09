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
  hud.js          Health, ammo, floor, objective, toasts, death screen
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
part-way through the swing, so you can back out of reach.

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
model is what you see and the boxes are only what it falls apart into. The debris therefore
wears the procedural palette rather than the GLB's, which is a deliberate trade: a desk that
bursts into pale laminate panels reads fine in the half-second it takes to land, and the
alternative is slicing model geometry at runtime.

Models arrive at arbitrary scale facing arbitrary directions (28 of 71 were facing the
wrong way), so `model-table.js` records the yaw and scale that put each at real-world size
facing -Z. Check a new entry in `/dev-models.html` before trusting it, and beware that a
model's name is not its size: the `printer` model is a 24 cm desktop unit, which is why the
floor-standing prop uses `copier`.

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
