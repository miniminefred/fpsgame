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
  game.js         The run: floor progression, difficulty curves, destructible props
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
  audio.js        Procedural WebAudio gunfire, clicks, hit pings
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
dev-models.html   Contact sheet for eyeballing the furniture models
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
is flooded from the player and every enemy walks downhill on it. Six types share one rig
with different numbers and colours; the visor colour tells you what is about to happen.
Melee types swing office junk (fire extinguishers, keyboards, monitors) and land the hit
part-way through the swing, so you can back out of reach.

Gunfire spread is sampled as a real angle and converted into a miss distance at your range,
so backing off genuinely makes you harder to hit.

### Furniture models (`gen/models.js` + `gen/props.js`)
Static props are drawn with downloaded CC0/CC-BY GLBs; loose props are not. That split is
forced, not stylistic: breaking a prop apart re-emits the boxes it was authored from as
separate bodies, and a model is one mesh with no pieces to fall into. So chairs, crates,
coffee tables and water coolers stay procedural and destructible, and desks, cabinets,
shelving, copiers, sofas, vending machines, racks, plants and meeting tables are models.

A prop with a model uses THAT model's measured footprint rather than the hand-authored one,
so collision always matches what you can see. Every model is missing-safe — if a GLB fails
to load, the prop silently falls back to its boxes.

Models arrive at arbitrary scale facing arbitrary directions (28 of 71 were facing the
wrong way), so `model-table.js` records the yaw and scale that put each at real-world size
facing -Z. Check a new entry in `/dev-models.html` before trusting it, and beware that a
model's name is not its size: the `printer` model is a 24 cm desktop unit, which is why the
floor-standing prop uses `copier`.

### Destructible props (`game.js` + `physics.js`)
Loose furniture is authored as a handful of boxes, so breaking it apart is just "re-emit
each of those boxes as its own rigid body" — the pieces it falls into are the pieces it was
built from. Fragments are capped and time out, so a long run cannot grow the body count.
