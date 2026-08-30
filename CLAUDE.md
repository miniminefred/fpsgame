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

**Every commit is authored and committed as `miniminefred`** —
`miniminefred <315911906+miniminefred@users.noreply.github.com>`, which is set globally
in `~/.gitconfig` and again as this repo's local config. That identity and nothing else:
no other name or address, no `Co-Authored-By: Claude ...` trailer, no "Generated with
Claude Code" line. This repo is **public**, so every commit publishes whatever identity
it carries into permanent history, permanently — and the `users.noreply.github.com` form
is what links a commit to the GitHub account without exposing a real address. Getting
this right is cheap; correcting it is not, as the rewrite and force-push of all 152
commits on 2026-08-11 established. If a clone ever picks up a *local* `user.name` /
`user.email` saying otherwise, fix the config rather than committing under it.
See `~/.claude/CLAUDE.md`.

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

`dev.shift('night shift')` pins every floor to one theme while you are working on that
theme, and `?shift=night-shift` on the URL does the same across the reloads HMR cannot do
in place; `dev.shift(null)` hands the floors back to the die. It is off unless asked for,
and that is deliberate rather than shy — a dev aid that is simply *on* is how a spawn
override put the player inside the generator room on every floor of every dev build for
weeks, which is the game quietly no longer being played the way it ships. It warns when
the shift you pinned cannot be itself at this depth (an Automated floor above the Sentry
Unit is a machine floor with no machine on it) and names the floor where it can be.

`/dev-models.html` is a contact-sheet harness for inspecting the furniture models at true
relative scale (see the header of `src/dev-models.js` for its query parameters);
`/dev-guns.html` does the same for the five weapon viewmodels and their measured muzzle
points, building each gun through `weapons.js`'s own `buildWeaponRig` so it cannot drift
from the gun the player holds.

`/dev-layout.html` is the one to run after touching **anything in `style.css` or the HUD
markup**. It loads the real game in an iframe, resizes it to a dozen real device sizes in
both orientations, and measures every HUD element and every touch control against every
other one — overlaps and anything hanging off an edge. The iframe is the whole trick: the
media queries key off ITS viewport, so a 390x844 frame is a phone as far as the CSS is
concerned even on a desktop monitor, and one page load covers every size. It found four
collisions the day it was written. It does not run under `npm test`, because it needs a
browser to lay anything out.

**One sweep at a time, and that is a fix rather than a nicety.** Both of its start triggers
fire in the ordinary case — an iframe's initial `about:blank` is `complete` the moment the
deferred module runs, so the readyState check starts a sweep, and then the real document
arrives and raises `load` — so two sweeps ran concurrently, each resizing the frame out from
under the other's `await settle()`. Every rect was then measured against the OTHER sweep's
viewport, which reads *exactly* like a broken HUD: `offscreen #tstick — 163 bottom`, nine of
twelve sizes red, on a HUD with nothing wrong with it. It lasted because the two sweeps
disagreed rather than both failing, so one of them always came out clean and the page always
had a plausible answer on it; the duplicated rows were the only tell. `runAll` now queues
instead of overlapping, a sweep refuses to measure until the game's own `#hud` exists (an
all-clear for a page that never loaded is the one result a harness must not be able to
print), and each size asserts the frame's real `clientWidth`/`clientHeight` against the
preset — the assertion that would have named this on sight.

## Publishing — GitHub Pages

Public at **github.com/miniminefred/fpsgame**, live at
**https://miniminefred.github.io/fpsgame/**. `.github/workflows/deploy.yml` builds and
publishes on every push to `master`, plus manual dispatch. Four things in it are
load-bearing:

- **The Pages base path is passed on the command line, not set in `vite.config.js`** —
  `npm run build -- --base=/fpsgame/`. Pages serves from a subpath and Vite writes asset
  URLs at build time, so without it every script, GLB and MP3 resolves to `/assets/...` and
  404s. Keeping it in the workflow is what lets `npm run dev` and `npm run preview` go on
  serving from `/` exactly as before — local development is untouched by any of this.
- **The four dev harnesses ship with the game**, because `vite.config.js` lists them as
  build inputs. `dev-guns.html`, `dev-models.html`, `dev-sounds.html` and
  `dev-layout.html` are all live on the Pages site, which is how you inspect a model, a
  viewmodel or the phone HUD without a checkout. It
  costs nothing: they are separate entries the shipped `index.html` never references.
  `window.dev` is **not** exposed there — the `import.meta.env.DEV` block is compiled out
  of a production build, so `stairsEverywhere()` and the rest are dev-server only.
- **`pages: write` and `id-token: write`** are both required: `deploy-pages` authenticates
  to Pages with an OIDC token, so a job holding only `contents: read` builds fine and then
  fails on the last step.
- **The `github-pages` environment carries a deployment branch allowlist**, built from
  whatever the default branch was *when Pages was first enabled*. This repo is on `master`
  but Pages was enabled while the fresh empty repo still defaulted to `main`, so the very
  first deploy was rejected — a green build and a failed deploy, which is a confusing way to
  find out. `master` was added to the allowlist to fix it; rename the branch and it will
  need doing again.

**Any asset URL built from a string at runtime must ask for the base itself**, and this
is the trap that actually shipped. Vite rewrites the asset references it can *see* — a
static import, an `href`, a `url()` — and a prefix that a path is concatenated onto is
none of those. `sfx.js` held `const BASE = '/sounds/'` and `gen/model-table.js` held
`MODEL_DIR = '/models/office/'`; both are root-absolute, both were perfect on the dev
server, and both asked `miniminefred.github.io` for a file that lives under `/fpsgame/`.
Every clip and all 71 GLBs 404ed on the deployed build. They now read
`(import.meta.env?.BASE_URL ?? '/') + '…'` — the `?? '/'` because the two validators
import their way into `model-table.js` from Node, where `import.meta.env` does not exist.

Both failures are quiet, which is why they lasted: a missing clip is silence, and a prop
whose model fails to load falls back to its authored boxes by design, so the floor
generates and plays and is simply no longer furnished with furniture. Note the weapon
viewmodels were *fine* throughout — `weapons.js` uses relative paths
(`models/1_pistol.glb`), which resolve against the document and so pick the subpath up for
free. That is the whole difference, and it is worth copying: prefer relative, and if a path
must be absolute, derive it from `BASE_URL`.

`npm test` is deliberately **not** a gate on the deploy. The two generator sweeps are the
right thing to run after touching `src/gen/`, but wiring them into publishing would mean a
seed-dependent validator failure could block a deploy that has nothing to do with it.

One trap when running the build by hand in **Git Bash**: MSYS path conversion rewrites
`--base=/fpsgame/` into `--base=/Program Files/Git/fpsgame/`. It builds green and emits a
bundle whose asset paths cannot resolve. `MSYS_NO_PATHCONV=1` prevents it; PowerShell and
the Ubuntu runner do not have the problem.

## The game

**Office Descent** — an endless procedurally-generated office shooter. You arrive on a
floor of a grey corporate building, clear the staff still working there, find the service
hatch, and descend. The next floor is generated on the fly, usually a little bigger and
always a little nastier. There is no ground floor.

Two people can do it together, over the internet, off a six-character code read out loud.
See **Co-op** below.

## Project layout

```
index.html        Entry shell: overlay, HUD markup, minimap canvas
vite.config.js    Dev/preview server pinned to port 8090
tools/
  validate-layout.mjs  Headless floorplan invariants (connectivity, doors, sealing)
  validate-props.mjs   Headless furniture-placement invariants
  validate-nav.mjs     Headless multi-level routing invariants
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
  nav.js          Tile navigation on TWO LEVELS: flow field, line of sight,
                  walkability, and a second field for whoever can open a locked door
  enemies.js      Spawning, placement guarantees, the AI state machine, gunfire and melee
  enemy-types.js  The roster: types, bystanders, floor themes, and the pickers
  enemy-anim.js   Per-frame rig animation, and the toppling death fallback
  input.js        Key state, pointer lock, and the fallback look mode when it is refused
  touch.js        The on-screen controls, and deciding whether a finger is driving
  player.js       Movement, AABB collision against an indexed floor, health
  shooting.js     Hitscan: fire rate, ammo, spread, recoil, damage, prop impulses
  weapons.js      Five GLB viewmodels, recoil/reload animation, per-gun combat stats
  extinguishers.js  The secondary: a thrown cylinder, its gas, and what it sets off
  spills.js       Water on the floor: what comes out of a shot cooler, and its noise
  effects.js      Pooled tracers, impact flashes, bullet decals
  arcs.js         Electricity coming off a wrecked machine
  physics.js      cannon-es rigid bodies for loose furniture
  audio.js        Sound library + every game event that makes a noise
  sfx.js          WebAudio sample engine: decode, pitch-vary, place, overlap
  casings.js      Spent brass: ejects, bounces, times out
  keycards.js     Card catalogue, the wallet, and the cards on the carpet
  doors.js        Sliding panels, proximity sensors, and the badged ones
  cameras.js      Wall cameras and laser tripwires, and the alarm they raise
  conveyors.js    Parcel lines on the corridor walls, and the stock on them
  tech-textures.js  The finish on things that are made rather than fitted
  net.js          Co-op's wire: a code, a peer-to-peer channel, a message pump
  netplay.js      ...and its protocol: who decides what, and what crosses
  remote-player.js  The other player as a body, posed from their packets
  mp-menu.js      The co-op panel on the start screen — the only UI with buttons
  hud.js          Health, ammo, floor, objective, keycards, hit direction, toasts, death
  minimap.js      Per-floor floorplan raster + live player/enemy markers
  textures.js     Procedural canvas textures and the shared material cache
  fx-textures.js  The generated sprites: muzzle flash, tracer, decal, glow, gas
  dev-models.js   Drives dev-models.html
  dev-guns.js     Drives dev-guns.html
  dev-sounds.js   Drives dev-sounds.html
  dev-layout.js   Drives dev-layout.html
  style.css       All UI styling
  gen/
    tiles.js      The tile vocabulary: sizes, the tile enum, tile<->world, bfs
    layout.js     Floorplan: corridor spine + BSP room blocks + doors. Re-exports
                  tiles.js and locks.js, so the rest of the tree has one address
    locks.js      Badge readers: which door gets which card, and the proofs
    stairs.js     A staircase up a room's wall, and the sealed storey above it
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
dev-layout.html   Measures the HUD at a dozen device sizes and flags overlaps
```

The four `dev-*.html` pages are **build inputs** (`vite.config.js`), which is about the
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
- **Networking:** WebRTC data channels via npm `peerjs`, introduced by PeerJS's free
  public broker. No server of ours, which is what lets co-op work off the static Pages
  build — and the one third party in the whole project. See Co-op below.
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

On a touch device the same actions are on screen instead — see below.

| Touch | Action |
|-------|--------|
| Left thumb, lower half | Virtual stick: walk, and sprint at full deflection |
| Right thumb, anywhere free | Drag to look |
| FIRE / JUMP / RELOAD | Bottom right, under the right thumb |
| 1 - 5 | Weapon chips above the buttons |
| Top-centre button | Fullscreen |

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

So: `metrics.js` holds the body (radius, eye height, **height**, step tolerance, gravity, jump)
and is deliberately free of Three.js so the headless validators can import it too. `BODY_H` is
the newest of them and it earns its place the same way: once a collider could have an underside
(see the stairs below), "is this box in my way" became a question about a body's height, and
`player.js`, `physics.js` and `validate-props.mjs` all have to answer it identically. `JUMP_APEX` is
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

### You cannot get out of the building (`player.js`, `barrier` + `bounds`)
A player reported climbing on the furniture and ending up outside in the void, and it
turned out to be three separate holes rather than one. All three are closed at the point
they happen, and there is a fourth thing behind them that does not care how you got there.

- **A wall is a wall at every height** (`barrier`). `_moveHorizontal`'s step tolerance
  treats any box whose top is within `STEP_EPS` of your feet as a kerb, which is right for
  a tread and a desk and turns every 3.2 m wall in the building into a knee-high ledge the
  moment your feet are over 2.95 m. A staircase, an attic deck and the generator room's
  mezzanine all put them there legitimately — so you stepped off the top of a flight onto
  the top of a wall, and the walls are a connected network reaching the perimeter. `barrier`
  is set on the shell's walls (both heights) and on a storey's own `wall` parts, and it
  means never a kerb and never a floor. A `tread` and a `deck` must not have it, for
  opposite reasons.
- **A roof is never a floor** either, and this is the other half of the same fix. `ROOF_T`
  is already derived as `STEP_EPS + 0.15` so a roof cannot be stepped onto *from below* —
  but nothing said it could not be stood on by a body that had got above it another way,
  and the top of the building is the one surface with no walls on it and nothing overhead.
  Dropped onto now, a body falls straight through it back inside.
- **A body ejects along the axis of least penetration, to the nearer face** (`_eject`).
  Both used to be read off the direction of travel, which is right for the only way a body
  is supposed to meet a box and catastrophic otherwise: these are merged tile runs, so a
  wall is routinely thirty metres long and half a metre thick, and the far face of the
  wrong axis is the far end of the building. A body gets *inside* a box in the first place
  because the head clamp lowers the feet with no regard for what is horizontally in the
  way — step off a deck into a room with an ordinary ceiling and it drops from 3.2 m to
  1.38 m, which can be inside the wall the deck was against. Measured against the old rule
  over 1,097 m of walking, 17,125 resolutions: of the 16,128 that were fresh contact 25
  differ (a body pushed by one box into a second in the same pass), and of the 997 where
  the body was already inside a box **732** differ, the old rule moving it by up to 40.9 m.
  That last number is the bug, not a regression. Ejecting on one axis or the other *always*
  is what makes it safe to call from both passes: leaving an overlap for "the other pass"
  is a hole when the body is moving along one axis only, because the other pass never runs.
- **And then the backstop, which is the part that makes it impossible rather than fixed**
  (`_contain`). Everything above is a resolution — a negotiation with a list of boxes that
  can be got wrong, and has been three times. The slab's own rectangle is a fact about the
  floor rather than about a box, so no ordering, no tolerance and no resolution order can
  argue with it: four comparisons a frame against `bounds` (`gen/build.js`), which is the
  slab inset by the one tile of perimeter wall plus a body's radius — exactly where a body
  standing against the inside of that wall has its centre, so it is the tightest bound that
  can never move a legal position. `player.contained` counts how often it has fired and is
  meant to stay at zero for a whole run; anything else is a collision bug not yet found.

Proved rather than hoped for, in the browser against the real `Player`: 22,800 frames and
1,301 m of sprinting-and-jumping across eight floors, started from the spawn and from every
reachable deck — zero escapes and the backstop never fired once. Then 270 deliberately
illegal starts per three floors — teleported inside walls, up to 10 m beyond the slab, and
up to 12 m above the roof — all of which recovered: none escaped, none ended outside, none
stayed above the roof. Ordinary collision is untouched: walking into a wall stops exactly at
`minZ - RADIUS` and sliding 16.44 m along it has zero jitter.

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

### Stairs, and the storey at the top of them (`gen/stairs.js` + `buildStairs`)
Zero to two rooms a floor get a staircase up one of their walls to a **second storey**: the
room below with its ceiling for a floor. Same footprint, its own walls standing over the walls
downstairs, its own roof and its own lights, and no door, no corridor and no second way out —
the stairwell its stairs come up through is the only way in. The room underneath loses nothing
but the stairwell, because the storey is built on the roof rather than on a block in somebody's
office. That is what makes it worth stocking, and what it gets is the crates, pallets and
cabinets nobody would carry back down.

**A collider has an underside, and that is what makes a storey possible at all.** Every box in
this engine was a pillar from the floor up to a `top`: that is why the ceiling never had to be
collided with, and why the first version of this feature was a plinth in the corner of a room
with a room on top of it. A slab at head height with no underside blocks the room beneath it.
So colliders carry **`base`**, and the two tests that ask "is this in my way" now ask about a
body's *height* rather than its feet — low enough to step onto is `top <= feet + STEP_EPS`,
high enough to walk under is `base >= feet + BODY_H` (`_moveHorizontal` in `player.js`,
`addStatics` in `physics.js`, and `buildGeomGrid` in the props validator, which otherwise
reports a whole room as solid rock). Nothing on the floorplan sets `base`; with it absent the
test reads `0 >= feet + 1.82`, false for any body above ground, so every wall, desk and door
panel behaves exactly as it did.

What is still 2.5D, and shapes the rest:

- **Nav is two levels deep and bodies follow you up.** The grid has layer 0 (the ground
  floor) and layer 1 (every attic and basement at once — they never overlap, because a room
  gets at most one staircase), joined at the stairwells and nowhere else. The flood steps
  between layers there, `descendOn` takes that step when it is downhill, and an enemy's layer
  is read back off the step rather than decided anywhere. Its height comes from the flight it
  is standing on, sampled continuously, so switching layer half way up is invisible.
- **A step is a step, not a cliff.** Nav now refuses a neighbour more than a flight's own
  rise-per-tile away in height (`MAX_TILE_RISE`), which is what stops a body stepping
  sideways off a landing into mid-shaft. The nav sweep caught that as a walker changing
  height by three metres in one step.
- **Sight needed telling too**, and this is the sharp edge: `losClear` is that same 2D grid,
  the whole roster is on the ground, and enemy fire is *not* a raycast — `_shoot` fires
  because `sees` is true. So a player upstairs was being shot through the deck from the room
  below. Off the ground floor nobody sees you (`STOREY_GAP` in `enemies.js`, set above the
  tallest thing you can climb onto downstairs). They still **hear** you, and `_flood` seeds
  from the nearest tile a body fits in, so a shot fired upstairs puts them at the bottom of
  your stairs — which is where they should be waiting.
- The suspended ceiling *and* the storey's floor slab are both cut over the stairwell
  (`ceilingCut`), or the stairs come up into a sheet of ceiling tiles and through the head of
  whoever is climbing them.
- A storey is furnished through a **sink of its own** (`furnishUpstairs`). The collider list,
  the loose props and the destruction records are the floor's — a crate upstairs is shot apart
  like any other. But occupancy and walkability are questions about a *level*: sharing the real
  masks would have a filing cabinet on the second floor make the office beneath it impassable,
  and handing its tiles back when it is shot would open a tile a desk downstairs is standing
  on. `masks.level` is what says so, and it is the sink itself rather than a wrapper so that
  `tryPlace` and all 30 props in the catalogue furnish a storey without one line of them
  knowing there is one.

Structural colliders carry `building: true` — shell, not furniture, and `validate-props.mjs`
audits them with the walls. Props keep `base`, which is also what the plan-space checks read:
`7.top` measures `top - base` (a 1.3 m cabinet upstairs has a top of 4.5), and `2.overlap`,
`2.dyn-*` and the doorway checks compare only things on the same level, because two props on
different floors are not in each other's way however exactly their footprints line up.

**Three ways a storey can come out unreachable, all proved rather than hoped for**
(`11.stair-*`): a riser taller than the player's step (`RISER` is *derived* from `STEP_EPS`, so
retuning the body cannot silently make a wall of a staircase), a flight that stops short of the
storey floor, and — the one that was real for better than one flight in three — a bottom step
with a filing cabinet in front of it, or the room's own wall. The planner proves there is room
floor at the foot of the flight and `approachTiles` has the builder reserve it from the
furnisher while leaving it in the nav grid, because that is where you stand to start climbing
and where anybody chasing you ends up.

Two smaller things worth knowing. The stairwell stands off every opening by `DOOR_CLEAR`,
which lives in `gen/tiles.js` because the furnisher's door aprons use the same number; they
were briefly 4 and 3 and the sweep found it at once as a crate standing in a doorway. And a
storey is filled by walking a shuffled grid of half-metre spots with a **cap** on how many
land: darts gave a room of two things or of nine, and without the cap the big props took the
first few spots and every leftover gap took the one prop still small enough to fit it — which
came out as two pallets and eight fire extinguishers.

### The generator room (`generatorRoom` in `gen/rooms.js` + `buildGeneratorMezzanine`)
One big room a floor, when the slab throws up somewhere that fits (area over 110 m², a
short side of 15 tiles, and exactly one door), becomes the plant room: walls a full
storey taller than everything else, no suspended ceiling, a roof of its own at `WALL_H *
2` instead of the ordinary one, and a machine at the far end you can shoot to cut the
power to the whole floor.

**It is worked by a crew rather than held by a crowd** (`_generatorRoom` in `enemies.js`,
`GEN_TECHS` and `GEN_WORKERS`): 2-3 hostile Technicians and 3-5 Maintenance Workers who
carry on with their shift while you shoot at them, both `weight: 0` so a weighted roll can
never produce the mix anywhere else. It was 10-15 with 2-4 of them hostile, and at that size
the plant room was the biggest fight on the floor — a second security office by accident,
when the room is supposed to be about the machine at the end of it and about whether you are
willing to shoot the thing keeping the lights on. Whatever the spacing check cannot fit comes
off the workers rather than the technicians, so a tight room is still the plant room instead
of four men ignoring you. Worth knowing before tuning any of it: only about **3%** of floors
roll a room that qualifies at all (144 layouts swept), so this is a set piece you meet every
thirty floors or so, not a fixture.

**That roof is the fix to a hole, and it is worth knowing why it was missing.** The walls
were built at double height so the room would read "walled up two storeys rather than
roofless" — the wall pass says exactly that — but `generatorRoomCut` took the room out of
the *roof* pass as well as the ceiling one, and nothing was ever put back on top of them.
So the one room in the building designed to be looked up in was the one room open to
nothing: look up and you got the fog clear colour going on for ever, which reads as a
hole in the building rather than as a tall room. `buildShell` now runs the roof pass
twice, the same way it already ran the wall pass twice and for the same reason, with
`only()` as the complement of `masked()` handing the second pass the room's own tiles.

**The header over its doorway is the same bug one wall further along, and it lasted
longer.** `buildDoorFrames` fills the wall above every opening, and it filled it to
`WALL_H` — a constant, on the assumption every wall in the building is that tall. The
generator room's four are not, so the one doorway whose wall goes to 6.4 had a 3.2 m hole
over it, looking straight out of the room across the corridor's roof slab. It now asks the
opening how tall its wall is. Two things about that:

- **The wall tile is shared and tall on both faces**, so the header over it is tall too —
  it is the *opening* that decides, not which side you are standing on.
- **A tall header needs a collider and an ordinary one does not.** An ordinary header
  starts at 2.13 m and nothing in the building can get its feet up there, so it has never
  had one. This one is reachable: the mezzanine deck is at `WALL_H` and reaches the door
  wall directly over the opening, and a prop on the deck stands higher still. Left as
  geometry alone it would be an opaque wall you can walk through, which is worse than the
  hole it replaced. It carries `base` rather than being a pillar, so the doorway stays
  open at floor level — a body only meets it if its feet are within `BODY_H`. Proved both
  ways: a body walks in through the door at floor level as before, and a body standing on
  the deck walking straight at the header travels 0.14 m and stops.

**It is lit from two heights, and the lower one is the mezzanine's own underside.** The high
bays are above the deck and the deck covers most of the room, so everything under it was in
the shade of the thing they are lighting. The overhang now lights what it shades, on the same
`LIGHT_PITCH` grid as any other ceiling and at an ordinary ceiling's `distance` — it is at an
ordinary ceiling's height above the floor, which is the whole difference between these and
the high bays. Measured standing under the deck, mean frame luminance 91 → 119. They are
built by `buildGeneratorMezzanine` rather than `buildGeneratorLights` because that pass runs
long before the deck exists and cannot know where it ended up, or whether the room got one at
all — every early return in the mezzanine planner is a room with no overhang to light. Panels
over the stairwell are skipped: there is nothing overhead to hang them from. Both mounts go
through one `generatorPanel`, so a panel cannot stop being destructible in one place and not
another.

There was a **third** mount until the soffit arrived: four panels bracketed off the walls at
2.6 m, from when this room had no ceiling at all to hang anything from. A roof and a lit
soffit made them lights in an already-lit room, on a mount nothing else in the building uses
— a plant room reads as a plant room because its lights are overhead industrial fittings, not
because it has picture lights round the walls. Losing them costs real brightness and that is
the intent: the room measures 84–105 mean against an ordinary office's ~161, and the one
place to watch is the rare room whose mezzanine planner bailed, which then has only high
bays. Simulated by pulling the soffit fixtures — a strict lower bound, since without a deck
nothing shades the floor — that floors at 72–78, dim but nowhere near the near-black the roof
pass was added to fix.

Capping it and lighting it are **one** change, not two. The room's original lights are
on its walls at 2.6 m, from when there was no ceiling to hang anything from; a roof 3.8 m
above the nearest of them comes out nearly black, which looks exactly like the hole it
replaced. So `buildGeneratorLights` now also hangs high bays under the new roof, on the
same `LIGHT_PITCH` grid an ordinary room's panels use, with a longer `distance` because
they are twice as far from the floor they have to reach. Measured from the open slot over
the machine, looking up: before, no roof collider overhead, no fixtures, zero bright
pixels and a peak luminance of 83; after, a roof at 6.4–6.8 m, six high bays, and a peak
of 227. Note most of the floor is *under* the mezzanine deck and correctly sees the deck
rather than the roof — the slot over the machine and the deck itself are the only places
the roof is visible at all, which is where to look when checking this.

Three things about it are structural rather than decorative:

- **The generator spans its wall corner to corner.** It is the one `spanning` prop in the
  catalogue (`gen/props.js`): it is built to the width it is ASKED for rather than to a
  number typed into the catalogue, because what it is for is being the far end of the
  room, and a five-metre cabinet against the middle of a fifteen-metre wall is a cabinet.
  `wallSpanProp` in `gen/rooms.js` is the placement, and its retreat is the point of it —
  reaching both corners means reserving every tile across the room, and `reserveClearances`
  stamps doorway aprons into the shared grid without regard for whose room the tile is in,
  so one unrelated doorway on the far side of that wall can veto the full span. It steps in
  half a metre a side and asks again before falling back to the catalogue size.
- **Its pipework is inside its own footprint.** The machine carries coolant tanks, a header
  and droppers, gauges, valve wheels and a service gantry, and all of that stands a third of
  a metre proud of the housing — so the prop declares 3.0 m deep, not the 2.4 m the housing
  measures, and the whole thing is authored in its own frame and shifted back by one `BACK`
  constant. `10.geo-fit` in `validate-props.mjs` is what says so: a prop whose declared
  footprint stops short of its own geometry is a prop you can put your shoulder through.
- **Shooting it leaves a wreck, and it is the only prop on the floor that does.** Everything
  else vanishes when it breaks, which is right for a filing cabinet and wrong for the reason
  a room exists — the plant room used to end the fight as an empty wall. **All of the machine
  stays**: the pipework, the coolant tanks, the service gantry, the exhaust stacks and the
  dead control face along with the plating they are bolted to. Only the fittings survived at
  first, which is the same mistake one step smaller — a machine that keeps its casing while
  every fitting on it disappears reads as a plainer machine having been swapped in for the one
  that was standing there. What should be missing is what the blast took, and nothing else.
  Six things about how:
  - **`weld` is still a distinction, and it is no longer about surviving.** Everything the
    machine draws is on the hulk; `weld` (`gen/props.js`) names the 31 boxes that are its own
    *mass* — plinth, housing, ribs, hazard band, tank bodies — as against the 40 of trim
    bolted to them, and the difference is only that `_wreck` measures the machine off the
    first set. Every number it takes there is an answer about the machine: where its corners
    are, how big a corner is worth blowing off one this long, which of its faces the room is
    on. A fitting standing clear of the plating answers all three wrongly — exhaust stacks
    reaching 1.7 m over the housing put the corner blast in the air above it, so "an upper
    corner blown clean off" comes out as a missing stack tip, and a gantry 0.3 m proud of the
    front calls the front of the machine a third of a metre out from the plating a round
    actually lands on. Trim is cut and carved with the rest; it just does not get a vote.
  - **Carving is clamped at both ends, because trim stands in FRONT of the near face.** A
    handrail is a 6 cm bar 0.3 m off the plating, so a shallow cut can land in front of a bay
    entirely — and unclamped, the new face then moves the bay's *back* wall backward and
    stretches the bar into a slab. Nothing in front of a blast is ever added to by it. The old
    code could not hit this: every box it knew about lay inside the depth the near face was
    measured from.
  - **The survivors are re-drawn, not spared.** A batched chunk is one mesh sharing one
    material with a hundred other props, so there is nothing to scorch that would not scorch
    every desk on the floor with it. The whole prop is erased from the batch as usual and the
    structure comes back as a mesh of its own in charred variants of its own materials
    (`_wreck` in `destruction.js`). `parts` are world-space, so nothing is transformed.
  - **Charring an UNLIT material has to make it lit** (`charOf`). A lens and a screen are
    `MeshBasicMaterial` — being immune to the room's lighting is exactly what makes them read
    as lit — so darkening the colour is not enough: they go on ignoring the blackout they
    just caused. Keeping the control face on the hulk without this left eight rows of green
    indicators as the brightest thing in a pitch-dark room, on the machine that had just
    switched the lights off. A burnt-out lens is dark plastic, so it becomes an ordinary lit
    material like the rest of the hulk.

    **And it loses its COLOUR, which is the other half of that and was missing.** Making the
    lens lit fixed how it responds to the room; scaling its colour by `CHAR` like every other
    surface left it *green*, just a third as bright — so the rows still read as indicators
    that are on, dimly, on a machine that had blacked out the floor. Scaling is the right
    model for scorching, because dark grey plating and a dark yellow hazard band are both
    still recognisably what they were painted. A lamp's colour is not what it is painted, it
    is the fact that it is on. So an unlit material's saturation is cut almost out
    (`DEAD_LENS_SAT`) and its lightness is **capped, not scaled** (`DEAD_LENS_MAX_L`) —
    because two different things wear that material type: a bright lens has to come down to
    dead plastic, while a screen that was already dark slate must stay exactly as dark and
    merely stop being blue. A cap does both; a scale would brighten nothing and a fixed
    value would lift the screen. The bright green `7dff9a` now chars to `374139`, a neutral
    dark grey with a hint of its old hue, against `295c34` before.
  - **Those charred materials are shared and must outlive the level**, like everything in
    `textures.js` — which is exactly why a wreck mesh must *not* carry `ownMaterial`, or
    teardown disposes a material the next floor is about to use. Its geometry is the level's
    and goes in `objects`.
  - **A wreck keeps its collider and its nav tiles**, the one place `_shatter` gives back
    neither. Nothing had to be re-measured for that: the hulk keeps the full-height housing,
    so the collider that was over the machine is still the right shape (welded top 4.2 against
    a collider top of 4.4) and debris lands on the thing you can see.

  Keeping the trim costs 2.3x the boxes to cut up, and it is affordable for the same reason
  the fine grid is: `_wreck` measures 15 ms against 9 warm, both inside the 18–26 ms band the
  stamper bought, and on the cold first kill of a session the two are indistinguishable
  (24.8 ms weld-only, 22.6 ms with trim) because the JIT dominates. What comes off the machine
  is now *only* the bays the blasts took, ~230 rather than 40 fittings plus ~65 bays, and
  `_scatter`'s per-prop and global caps bound that as they always did.
  - **It is damaged by five causes with five signatures, and that is the design.** Damage
    scattered evenly over a wreck is texture — it reads as corrosion, or as a mesh with holes
    in it. Damage you can point at is an event: *this went up at one end, and that little
    hole is where the round that finished it went in.* So: **the corner**, one upper end
    blown clean off; **the dish**, the same blast deforming the plating for a way around it;
    **the shrapnel**, what came off the machine hitting the rest of it, clustered toward the
    corner because that is where it came from; **the round**, a crater about an arm
    across wherever the killing shot landed, the one piece of it the player aims; and
    **the extras**, two more that are always there — one the size of the round's crater
    and one small — because something inside a generator goes up with it. They are what
    stops a wreck being the corner plus a single hole, and they are the only damage on the
    machine that does not depend on how it died: a generator caught in somebody else's
    explosion leaves no round at all, and without them it comes out with a bite taken out
    of one end and mint everywhere else. They stand at least a quarter of the machine's
    length from the corner (`EXTRA_FROM_CORNER`) — any nearer and they read as two
    unusually large pieces of shrapnel, which is ground the shrapnel already covers.

    The shrapnel is deliberately *sparse* — one to three pocks, piled hard against the corner
    (`SHRAPNEL_BIAS` 0.92). It was five to ten spread more evenly and that reads as spots
    rather than damage: what makes a pock look thrown is being near the other pocks and near
    where they came from, so the far end of the machine stays clean because nothing hit it.

    Big tears also hang **severed wiring** (`WIRE_*`), and it is the only colour on the whole
    wreck — everything else is a shade of burnt, so a few centimetres of red and blue
    insulation say the thing was wired and that something came apart, and give the eye
    somewhere to land on an otherwise black mass. They are pointedly not charred: a burnt wire
    is a black wire on a black machine. Each leaves the rim pointing outward and then droops a
    joint at a time, which is the whole difference between a cable and another spike, and only
    blasts over `WIRE_MIN_R` get any — a fist-sized pock has not opened a loom.

    Every one is the same sphere, and they differ in one flag, `through`. The corner takes
    everything inside it, depth included — that end is not there any more and you can see the
    wall through it. **Nothing else does**, and that is the rule that keeps it reading as a
    machine rather than a colander: a generator you can see daylight through in six places
    has been deleted in six places; one you can see through once and that is battered
    everywhere else has been blown up. The rest carve — the sphere eats into the near face
    and the metre and a half of machine behind it stays
    (`carve`). A hole punched clean through a generator by one pistol round reads as a tunnel
    rather than as damage. Three consequences:
    - **Which face is near comes from NAV, not from the shot.** The obvious source is the hit
      point — the player was standing in the room when they fired, so that is the open side —
      and it is wrong whenever the machine goes up in somebody else's explosion instead: the
      point is then *inside* it, every carve starts from the middle of the depth, and the
      shallow dish that should dent the front deletes the whole front half of everything it
      reaches. The machine is backed against a wall, so the open side is the one a body can
      stand on, and two `nav.clear` lookups cannot be wrong that way.
    - **The dish is capped in depth** (`DISH_DEPTH`). Left as a plain sphere, one wide enough
      to deform the plating around the corner is also deeper than the machine everywhere it
      reaches, so it just makes the hole bigger — the opposite of the point. The cap must also
      stay **under the ribs' 0.12 m depth**, and that is a threshold rather than a taste: a
      rib stands 12 cm proud of the housing, so a deeper dish does not dent it, it deletes it.
      At 0.22 every rib within the dish vanished, stripping the machine's vertical rhythm over
      a four-metre span — most of what made a wreck read as a chewed mess rather than as a
      machine with a hole in it.
    - **The arcs need `craterFloor`**, because carving a bay does not remove it, so the
      craters contribute no missing bays for them to strike from.

    **The plating near damage is buckled too** — bays nudged along the depth and tilted, which
    is free because the stamper takes a quaternion per box already. Its whole job is to stop
    the edge of a hole being suspiciously flat; the rim spikes are what make it violent, and
    every time this has been turned up it has eaten the clean round crater underneath. Two
    things keep it from becoming a cloud of shards, and the first version had neither: it
    falls off over `BUCKLE_REACH` from the edge of the damage, so a panel is wrenched where it
    was torn and flat where it was not; and the amplitude scales with the size of the piece,
    since the same 8° on a 9 cm bay opens a gap as wide as the bay itself and reads as
    detached rather than bent.

    That second term was **silently doing nothing** for its first two revisions, and it is
    worth knowing why: it sized off `max(sx, sy, sz)`, and a bay's largest dimension is always
    the machine's full 2 m depth, because bays are never cut across it. Every bay scored a
    full 1 — a 9 cm chip thrown exactly as hard as a panel, which is precisely the cloud the
    term exists to prevent. It measures the bay's **face** now, the two axes it was actually
    cut on. Anything sizing a bay must ask what it is asking about: a bay is small in plan and
    always long through. The **soot** is read off the same
    distance, so the metal that is burnt is the metal that is bent is the metal that was hit —
    two material buckets rather than a gradient, because the colour lives on the material.

    The holes are **round, with torn metal round the rim**, and those are two separate
    tricks. The circle is voxel resolution, and getting it needed three things:
    - **Cut the FACE, never the depth** (`baysOf`'s `depthAxis`). This used to cut "the two
      longest axes", which is right for a machine's own boxes — a housing is long, tall and
      shallow — and wrong the moment it is used a second time on a coarse bay of that
      housing, which is 0.85 x 0.85 x 2: the two longest are then the depth and *one*
      lateral axis, and the other lateral axis is never cut at all. The hole came out with
      the grid's resolution across it and a flat 0.85 m band up and down. Naming the depth
      axis instead made it both round and **cheaper** — 1175 boxes to 528, 42 ms to 26 —
      because the depth was being subdivided into interior boxes nobody can see.
    - **Grid per HOLE, not per machine** (`bayFor`): what a circle costs is cells across its
      *radius*. At one size for everything the 2.3 m corner was smooth while the 0.55 m
      bullet hole was a five-cell PLUS — a rasterised circle you can count the pixels of —
      and sizing for the hole then wasted that resolution over the much longer corner
      boundary. Each blast now takes `r / BAY_PER_RADIUS`.
    - **Measure to a bay's MIDDLE on the cut axes** (`distToBay`), not to its nearest face.
      A cube is nearest along its flat side, so face distance takes every bay the sphere
      grazes, fattening the hole by a bay all round and squaring it off. The depth axis is
      the exception and measures to the box, or a round that hits the plating is never
      within a hole-radius of the middle of the two-metre box it hit, and the small hole
      could only be punched by an explosion standing *inside* the machine.

    The outline is checked by tracing it: for each column across the hole, how far it reaches
    up and down. A circle domes and a square runs flat, and that test is what caught the
    `depthAxis` bug — the profile was 0.57 in every single column while every other measure
    (cell count, aspect ratio, span) looked healthy. It now tracks `sqrt(R² - x²)` to within
    a tenth of R. The torn look is
    `rimSpikes`: shards sampled ON the blast sphere, so they follow the same curve the bays
    were cut against, admitted only where kept material is within `SPIKE_REACH` (a spike
    hanging in air where the machine never reached is what would give the trick away) — and
    then **pulled onto that metal and bitten into it**, which is the other half of the same
    sentence and was missing for a long time. Passing the reach test is not the same as
    touching: a sample is a point on the blast sphere and the metal under it is boxes, so
    `SPIKE_REACH` admits a root up to 0.42 m clear of the nearest bay. Measured over ten
    machines, the median shard or wire began 8 cm off any metal, a third of them over 15 cm
    and one in eleven over 30 cm — torn plating with a hand's width of daylight behind it.
    Clamping the sample to the nearest point on the bay fixes it and does not move the rim,
    because the nearest kept metal to a point on the rim IS the rim; all 391 roots then
    measure exactly zero. The `ROOT_BITE` on top of that goes along the surface NORMAL and
    not back down the bar, which looks like the long way round and is the only one that
    works: back down the bar is into the metal for the 30% of shards that bend inward
    through the hole and into the HOLE for the 70% that peel outward. It is capped at the
    bay it is biting (`biteInto`), because the rim is where the buckling is worst and the
    nearest metal is regularly a 4 mm sliver of trim — 5 roots in 358 had a bite that went
    clean out of the far side of the very piece anchoring them. They
    are the only rotated geometry in the wreck — a rim of axis-aligned spikes is a row of
    little pillars, not metal that was ripped — and `mergeGeometries` does not mind a baked
    matrix, so they cost nothing but their own triangles. `RAG` came DOWN from 0.3 to 0.1
    when the grid got fine: a wandering radius was the only thing making a coarse edge look
    violent, and once the circle could actually be described, that same noise was the only
    thing stopping it from being one. The rim is jagged; the hole is round.

    **The fine grid is spent only where it is looked at**, and that is a performance fix, not
    a tidiness one. At a uniform fine grid the machine came to two thousand boxes and the
    frame that built it took **181 ms** — a quarter-second freeze on the one frame the game
    already works hardest to keep cheap, since the generator's death is also a ceiling coming
    down, four hundred fragments and a floor-wide relight. Two things fixed it. The structure
    is cut coarse (`BAY_COARSE`) first and a coarse box is only cut fine if a blast boundary
    actually crosses it — `distToBay` is never smaller than the box's nearest distance nor
    larger than its farthest, so anything wholly inside or wholly outside is settled whole in
    either direction. And the boxes that survive that are **stamped from one unit cube into
    preallocated arrays** (`stampBoxes`) rather than built as a `BoxGeometry` each and handed
    to `mergeGeometries`, which was 27 ms of allocation and most of the rest in the merge.
    Stamping reuses three's own winding and normals, which is the half of it that would
    otherwise be a source of inside-out faces. 181 ms became 18–26.

    All of it needs a granularity the machine does not have — it is authored as a few
    enormous boxes, one housing up to 15 m long, and a hole has to be smaller than the thing
    it is a hole in. Bays are cut on a box's two longest axes (the shallow one stays whole; a
    hole you cannot see into is triangles). Four things then decide how it comes out:
    - **The corner radius is capped against the machine's HEIGHT as well as its length**
      (`CORNER_RISE`). Off the length alone, a twelve-metre machine gets 3.6 m — which on
      something 4.2 m tall reaches the plinth, and it reads as having lost that whole *end*
      rather than its corner.
    - **Bays within `KEEP_BASE` of the floor are never taken**, by either cause. A hulk with
      its feet blown out reads as floating rather than as damaged.
    - **Both edges are ragged** (`RAG`), or the corner is a bite taken with a compass and the
      bullet hole is a drilled one.
    - **Distance is measured to the nearest part of a bay, not to its centre** (`distToBay`),
      and that is the whole of whether a bullet ever leaves a hole. Bays are not cut across
      the depth, so a bay centre sits a metre and a bit behind the front face — a round that
      hits the plating is nowhere near the middle of the box it hit. Measuring to centres
      meant the small hole could only ever be punched by an explosion standing *inside* the
      machine, never by a shot.

    The bays that went are handed back to `_shatter` to be thrown, so the plating that left
    the machine is the plating now lying on the carpet.

  **And it arcs** (`arcs.js`), struck from the holes — electricity crawling out of unbroken
  plating looks painted on, so the anchors ARE the bays the blast took. Three slots, each a
  jagged run of thin cylinders aimed exactly the way `effects.js` aims a tracer, struck for a
  flicker and then dark for up to 1.7 s; nothing is created or destroyed while it runs, which
  matters here and not for a tracer because this runs for as long as the player is on the
  floor. The light it throws is **`lighting.spark`, allocated with the pool and dark**, not a
  light of its own: three recompiles every material when the light count changes, and the
  frame the generator blows is already a ceiling coming down, four hundred fragments and a
  floor-wide relight. It is the last frame in the game that can afford to rebuild every
  shader.

  **And each strike buzzes** (`audio.generatorArc`), at the hole it came out of rather than
  at the machine: the housing runs up to fifteen metres, so three arcs out of three holes in
  it are three cracks in three places, and that is a direction. Four takes at the widest pitch
  jitter in the set, because this is the one clip in the game that plays two or three times a
  second for as long as the player is on the floor — what would give it away is not level, it
  is hearing the same crack twice. Two things follow from its never being finished being
  asked for, and both are the `blackoutPanels` lesson one step earlier: it is mixed well down
  (0.45), and it has the shortest audible range of anything placed (`ARC_AUDIBLE`, 18 m
  against the usual 26) — every other sound in the building is an *event*, so hearing one from
  the far end of the floor tells you something, while a crackle that carries would sit under
  the whole rest of the fight. Measured at 2.5 voices a second with the audio clock 6 ms off
  the wall clock, so nothing is piling up: full rate at 12 and 17 m, tapering at 19 (the near
  END of a long machine is what the range is measured to), silent at 30.

  The takes are a **low transformer buzz, not a bright spark**, and that is a mix decision as
  much as a taste one: something that snaps two or three times a second sits on top of the
  gunfire and reads as a fault in the sound engine, where something heavy and mains-frequency
  sits under it and reads as a room that has lost its power. Measured against the first pass —
  a filter-and-RMS pair in `/dev-sounds.html`'s own context, since the harness measures level
  and onset and says nothing about brightness — nine times the energy below 400 Hz relative to
  above 2 kHz (mean band ratio 0.41 to 3.63) and a quarter of the zero-crossing rate (8.7 kHz
  to 2.1 kHz). The four takes deliberately still span 2.0 to 5.2 on that ratio: the brightest
  of them is what keeps the set from being one hum played over and over.

  The marker reaches the sink through `placer` in `gen/props.js`, and that is the trap: a prop
  only ever sees the placer, which forwards `box` and `obstacle` and nothing else. `hulk` was
  added to the sink and to the machine, both correct, and every box came out unmarked. It is
  called as `p.hulk?.()` because a sink is allowed to be minimal — the catalogue audit in
  `validate-props.mjs` builds a placer of two methods — and that `?.` is what made the gap
  silent rather than loud.
- **The mezzanine is built BEFORE the room is furnished, and that ordering is a trap.**
  `buildGeneratorMezzanine` ends by stamping the deck's footprint into `occupied` so
  nothing is placed under the stairs, and `stampOccupied` rounds outward to whole tiles.
  Its standoff from the generator's wall (`GEN_CLEAR`) is therefore *derived* — wall inset
  plus the machine's own depth plus one whole `TILE` — and not a number chosen to look
  right. Trimmed by a quarter of a metre to win a little more deck, the reserve creeps
  into the band the generator is about to be placed in, `canPlace` fails across the whole
  wall, and `wallSpanProp` falls back to the catalogue size. Nothing errors: the room just
  quietly gets a cabinet instead of the machine it exists for. Caught by measuring the
  generator's collider against its wall over a sweep of floors, not by looking at it.
- **The mezzanine covers the room.** A deck one storey up reaching three of the four
  walls — both sides and the door wall — with the fourth side open over the machine
  behind a glass railing, and a row of workstations along that railing. It is
  colliders-only: pushed straight into `masks.colliders` rather than through
  `sink.obstacle()`, so the nav grid never learns about it. Nobody up there gets shot at
  or shoots down, which is a real compromise accepted for a one-room flourish rather than
  a second attic-and-basement system.

The mezzanine is worked in the room's own two axes — `u` from the door wall inward, `v`
along the door wall — and four things in it were learned by walking rather than by
looking:

- **The flight is built into a wall, and which wall is the only choice in it.** A flight
  standing off in the middle of the room reads as furniture somebody left there rather
  than as part of the building, so it goes flush — and being flush makes the *run* the
  constraint, because the opening plus a whole 4.16 m run then has to fit along one wall.
  Two arrangements, both flush, tried in order:
  - **The door wall**, bottom step `DOOR_GAP` past the edge of the opening, climbing
    away. First choice, because the walk is one turn: in, turn left (or right), straight
    up, with the first tread exactly where the turn leaves you. `DOOR_GAP` is half a
    metre because that is what clears the door furniture — a room's badge reader beds
    into the jamb 0.16 m past the opening and is 0.15 m wide along the wall, so it ends
    at 0.235 — with enough left to stand on to make the step up.
  - **A side wall**, the one nearer the door, climbing away from the door wall. It costs
    a 2.5–3 m walk along the door wall to reach the foot, which is why it is second. Its
    bottom step stands `FOOT_ROOM` off the door wall rather than in the corner: it climbs
    *into* the room, so the floor you step onto the tread from is the floor between it
    and the door wall, and jammed into the corner there is none.

  Measured over 198 generator rooms, the door wall takes it 86% of the time and the side
  wall the other 14% — and every one of those 14% is the same shape, a nine-metre door
  wall with the door near the middle, which has not four metres either way. Every room
  still gets a flight and every flight touches a wall. Either way it climbs *away* from
  where you come in; one that climbed back toward the door is a flight you have to walk
  past and turn round in.
- **The hole in the deck is wider than the flight in it** (`NOTCH_PAD`). Cut to exactly
  the stair's width, a body climbing has no room to be off-centre — the player is 0.8 m
  across on a 1.3 m tread, and the moment a shoulder crosses the deck's edge their head
  meets its 3.0 m soffit, which happens around the sixth step. It reads as the stairs
  simply stopping half way up. Caught by a test that walks a body up deliberately
  off-centre; before the pad it climbed to 2.8 m and stopped. Only the side *away* from
  the wall needs it now the flight is flush: on the near side there is no deck edge to
  meet, because the wall is what the notch stops against, and the wall stops the body a
  whole step before its head could reach the soffit. The notch is therefore derived from
  the flight's rectangle — padded across its width on any side that is not a wall, and
  not padded along the run at all, since the foot end is at floor level and the head end
  has to meet the deck exactly or there is a gap to step over. The deck is then drawn as
  whatever of the room that notch is *not*, rather than as named pieces, because the
  notch sits somewhere different in each arrangement.
- **The floor at the foot of the flight is reserved, not just the flight.** The ground
  under the deck is left furnishable on purpose — there is 3 m of headroom and crates
  belong there — but the tile you stand on to start climbing is not the stair's own
  footprint, and a crate on it is a staircase you cannot get onto. Same reservation
  `approachTiles` makes for the layout-level stairwells, for the same reason, and nothing
  downstream would have caught it because the deck is off the nav grid.
- **The desks are real props, not scenery.** They go in through a level sink of their own
  at deck height — the same machinery `furnishLevels` uses for an attic — so they are
  ordinary destructible `desk` props with a model, a monitor and a keyboard on them, and
  they come apart when shot like every other desk in the building. Two differences from a
  storey's sink: `reserved` is inverted so the only tiles it will place into are the
  deck's, and `blocked` is a throwaway, because a desk up here must not make the floor
  underneath it impassable.

`GOING` is 0.26 rather than a domestic 0.3 for the same reason the run is what decides
which wall the flight gets: the riser is fixed by `RISER` and the rise by `DECK_Y`, so
the tread is the only free number in the flight, and shortening it is the only way to
shorten the run. An industrial access stair is steep anyway. It is also why the 14% is
not closed by shaving margins — the door wall is 0.4 m short in those rooms, and buying
that back means a 41° stair in every generator room on every floor.

Measured over 198 rolled generator rooms: every one built a deck, every flight came out
flush against a wall with its run intact and never across the doorway. Then walked in
the browser, in both arrangements, at every offset across the tread a 0.4 m-radius body
can legally occupy plus one deliberately overhanging the open edge: all of them reach
the deck at 3.2 m, and on the door wall they do it starting from inside the doorway, so
the one-turn walk is the tested claim and not just the intended one. Each deck comes out
with three to five desks on it.

### The cafeteria, and arriving in it (`cafeteria` in `gen/rooms.js` + `pickCafeteria`)
The floor's canteen, and the room you are standing in when the floor starts. It is the
plant room's sibling — a big room composed around one thing — and it is deliberately the
**common** one where the generator is the rare one: **577 of 600** swept floors get a
cafeteria against 20 that get a plant room.

**The set piece is the servery, and it is `spanning` for exactly the reason the generator
is.** It runs the wall opposite the door you come in by, corner to corner: a three-metre
counter parked against the middle of a twelve-metre wall is a kitchenette somebody
installed, and a serving line reaching both corners is the END of the room, which is what
the seating faces and what you see from the doorway. Hot pans sunk into the top, a sneeze
guard, a tray rail, a till at one end and lit menu boards on a gantry over the back —
the boards because they are the one thing in the room worth reading, and because a lit
panel is how everything else in this building says *look here*. It carries `building:
true` on its collider like the generator, and for the same reason: a counter that runs a
whole wall is well past the furniture caps in `validate-props.mjs`, which exist to catch a
prop that has accidentally become a building.

**Which room it picks is decided before anything else about the floor**, because it becomes
the **spawn room** — and the exit's distance ranking, every lock, the prologue and where a
staircase may go are all measured from the spawn. Three requirements, and the third is the
load-bearing one:

- 85 m² and a short side of 12 tiles, or the rows behind the queue lane have nowhere to go.
- Not a room the plant room could have had. `fitsGenerator` is named rather than written
  inline for this — the generator wants the biggest most rectangular room on the floor and
  only ~3% of floors roll one at all, so a canteen claiming rooms by size alone would
  quietly cost the game its rarest set piece. Measured on the same seeds: **20/300 floors
  have a plant room before and after.**
- **A doorway onto a CORRIDOR.** This is the room the player is standing in holding
  nothing, so its way out has to be the part of the floor the prologue is measured over.
  A big room whose only door opens into somebody's office starts the floor by walking
  through a stranger's office to reach the building.

The pick is deterministic — the biggest room that qualifies — rather than a draw, and that
is the argument `assignLocks` already makes: it runs before the floor's own rng has been
spent on anything, so a die here would re-roll the contents of every room in the building
off a number that has nothing to do with them. The 23 floors in 600 with nowhere suitable
fall back to the lift lobby exactly as before, and `spawnRoom.role` is the only thing that
says which happened.

**Three things about furnishing it were bugs first, and all three are the same shape: a
room furnished AROUND the player is a case nothing in the furnisher had ever had to
handle.**

- **The seating is walked, not stepped.** On a grid a cell is all or nothing — the table
  fits at the one spot the arithmetic named or the room does without it — and the middle of
  a cafeteria is the one piece of floor carrying a doorway apron, a through-route lane and
  the square kept clear at the arrival point, all stamped across it. Every one of the six
  cells in an 11 x 10 m room touched one reservation or another, and the room came out with
  a servery, a vending machine and **nothing whatever to sit at**. Sliding along both axes
  puts tables on either side of whatever is in the way; each axis only jumps a full pitch
  once something has landed, so the ranks stay parallel and evenly spaced.
- **The square kept clear where you arrive came down from 5.5 m to 4 m** (`ARRIVAL_CLEAR`
  in `gen/build.js`). It was sized when arriving always meant a lift lobby — a small room
  furnished against its walls anyway, where the difference is invisible. A cafeteria is 8
  to 12 m across, and 5.5 m of clear square through the middle plus the lane in front of
  the servery is the room's whole depth: **11 of 37 came out with nothing to sit at**. It
  is still 2 m to the nearest edge against the 1.5 m the props sweep holds both points to.
- **A chair pulled up to a table needs `sink.lend`**, the same trap `seatFacing` documents
  one room type over: floor is claimed by whole tiles, so a table's claim reaches well past
  its own edge and every chair landed inside it — four tables in the room and not one chair
  at any of them. It does NOT go through `seatFacing`, though, because that call also
  registers a workstation, and a canteen chair is somewhere to eat lunch rather than
  somewhere a body works.

After all three: **median 4 tables and 8 chairs** per cafeteria, and none without seating.


**And it is the one room on the floor with people in it who are not a fight** (`_diners`).
Two to five staff at the tables with their lunch, plus a couple on their feet, all of them
`neutral` — none counts toward clearing the floor, and walking past the lot of them is the
intended way to leave. Nobody hostile is ever *placed* here (`_spawnPoints` skips the room
the player arrives in), so this is the whole population it starts with — but it is no longer
the whole population it ever has, because employees come down for lunch and go back up. See
Lunch below; everything in this section is the beat that cycle opens on.

Which makes them a **tell** rather than a fight, and the tell is the chair: a body sitting
down means a harmless one everywhere in this building, and the two exceptions are both
behind a locked door. A floor now opens on four people at their lunch — the rule stated
before anything is at stake, so the next chair the player sees already means something.
Three things about them were learned by running it:

- **A seated neutral has to be told to stay seated.** Every neutral is spawned into
  `wander`, and the animator stands up any seated body whose state is not `idle`/`alert` —
  so the whole canteen was on its feet by the first frame, five people placed at five chairs
  and not one still in it. `_wander` now holds `idle` for a body with a seat and walks it
  nowhere, and `_lunchSeated` says the same thing one caller further along: the same bug
  came back the day the arrival diners were handed to the lunch cycle, because that path
  seats them without going through `_wander` at all. Being shot at is the one thing that changes their mind: `flee` clears the seat,
  and from the next frame they are an ordinary neutral running for a door. Measured: shoot
  one and it is out of the chair on the next tick while the other three carry on eating.
- **A seat records what it is a seat AT** (`at` on `sink.workstation`). A desk is a JOB — it
  decides how big a shift a room is dealt and it seats a body typing — and a canteen chair
  is lunch. Pooled together, a cafeteria's ten chairs would read to `_spawnPoints` as ten
  jobs going in the room and it would be dealt a shift to match.
- **An arm has no elbow in it**, so a hand cannot be brought to a mouth: swinging the
  shoulder further forward reaches across the table rather than up to the face. What reads
  as eating is the body coming DOWN to meet the food, a small dip per mouthful, with one
  hand out at the tray and the other where it was. Which hand is hashed from where the body
  is sitting rather than rolled — it has to be stable for the run and identical in both
  browsers of a co-op session, and the chair came from the same seed on both ends.

**And two more came from a player shooting one**, which is the case none of the above
exercises: a seated body that has to become a walking one.

- **A seat has to be somewhere a route can START from, not merely somewhere a body fits.**
  `nav.clear` is a point test against `walk` — can a body of this radius stand exactly
  here — while `fits` is that same test taken at the TILE CENTRE, and `fits` is what every
  flood and every `descendOn` runs on. A chair tucked into the corner of a tile passes one
  and fails the other, and the body seated there stands up perfectly well and then cannot
  path anywhere for the rest of the run. Measured on the chair the player actually shot:
  **400 destination picks, 0 accepted, 101 of them refused at `descendOn`** because the
  body's own tile was not on the field. He stood at the table walking on the spot until the
  floor ended. `deskPool` asks `fitsAt` now. It costs seats — a chair that only just fits is
  no chair at all — and that is right in both directions, because the two set pieces this
  pool has always fed get up to FIGHT you: the Manager and the guard on the cameras were
  both a bad roll away from the same paralysis, silently, since the day they were seated.
- **The ANIMATOR is what stands a body up, and nothing else may do it.** `stand` in
  `enemy-anim.js` puts the hips and shoulders back where `rigs.js` left them, and it is the
  only thing that ever does: the walk cycle writes limb ROTATIONS every frame and recovers
  on its own, but a limb's POSITION is moved by `hinge` and by nothing else. Clearing
  `e.seat` from inside `_wander` skipped that, so a body got out of its chair still carrying
  the chair's joints — measured, `legL` at (-0.12, **0.71**, **-0.40**) against the rig's
  (-0.12, 0.43, 0) — and walked the rest of the floor with its hips and shoulders dropped
  into a seat that was not there. It is exactly as obvious as it sounds: "walks like an
  alien". `_wander` now only stops holding `idle`, and the frame ends with `animate` seeing
  a seated body in `wander` and standing it up the one way that works.

**One bug in this file was found twice over while seating them, and it is the `edgeProp`
table again.** A chair's turn is a quarter turn round from the thing it is pulled up to, and
written out by hand as four coordinates and four turns half of them were wrong: every chair
in the new cafeteria, and — pre-existing, for as long as `meetingRoom` has existed — every
chair in any meeting room whose table runs east-west, all of them seated with their backs to
the table they belong to. Proved on the geometry rather than argued about, by asking which
side of each chair its backrest was on: 9 of 20 chairs on the test floor had it on the table
side, and 0 of 20 after. Both now derive the turn the way `seatFacing` always has — `side` is
the quarter turn naming which way the chair is offset, `(side + 2)` is what brings its front
back round — and the same `QUARTER` rotates the offset along the table, so a table running
north-south needs no second set of coordinates.

**And nobody is staffed into it** — `_spawnPoints` in `enemies.js` now keys that off
`layout.spawnRoom` rather than off the `'lobby'` role. A role name is a fact about how a
room is FURNISHED, while "do not put anybody here" is a fact about where the player
materialises; left as the role test, a cafeteria floor would have opened with a dozen
people standing round the arrival point. The mid-sized `canteen` role is untouched and the
two are meant to read differently: that one is somewhere on the floor to eat, this one is
the canteen the floor is arranged around.

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

**And the same bug had a second home, in `scatter` itself** (`SCATTER_LANE` in
`gen/rooms.js`). A static prop dropped in the middle of the floor is the only thing the
furnisher does that can wall a room off, and `canPlace` rounds a footprint outward to whole
tiles — so two props in diagonally adjacent tile blocks pass it and still leave a gap no body
fits through. Found by adding cardboard to every room, which shifted the rng stream and turned
up an itbay with **2266 cells of its own floor cut off behind exactly two scattered crates,
with a two-cell neck between them** — the same 0.53 m of perpendicular clearance against a
0.8 m body. A scattered static now has to leave a body's radius clear on every side, which
costs a little density in a busy room (a crate that cannot leave a lane beside it does not
land) and takes that room from 482 reachable cells to 2682. Loose props are exempt: you walk
into a carton and it moves.

Worth knowing how thin the evidence for "no failures" can be. The 300-floor sweep was green
before the cardboard and red after, and the mechanism was not the cardboard — it was two
crates that could have been dealt to any seed. A **690-floor** sweep of the pre-cardboard code
found nothing, which is how a 1-in-300 fragility hides: the seeds are fixed, so a green sweep
is evidence about those seeds and not about the generator.

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

### A panel slides as far as the wall goes (`slidePocketRun` in `gen/tiles.js`)
`slidePocketSide` answers whether a doorway can hold a panel at all: it proves the wall
beside the opening carries `span` SOLID tiles, which is exactly the panel's own width. The
builder then slid the panel `width * 1.02` — a hair further than its width, so its trailing
edge finishes inside the jamb rather than flush with it — and on the doorways where that
proven minimum is *all* the wall there is, the hair put **3 to 4 cm of the panel's far end out
the other side**, standing in whatever was there. Measured over five floors: 3 to 6 doors
each, 674 sliding doors swept, and none of them touching furniture — this is the whole of
"some doors clip through things", and it is a sliver of door edge in the next room.

`slidePocketRun` measures how much wall is actually there (most doorways have more than the
minimum, and keep the hair), and the travel is clamped to it less `POCKET_CLEAR`. That 2 cm
is not slack either: it stops the panel's far face landing exactly coplanar with the far face
of the wall it is inside, which is a shimmering rectangle of door on the end of a wall — a
worse artefact than the one it replaces. After: **zero panels past the wall on 674 doors
across six floors.**

A hall door's leaves were measured in the same sweep and are fine. A folded leaf overlaps the
wall it folds against by half its thickness, which is by design and invisible; nothing of
either kind ever reaches furniture.

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

**Being seen is not being shot: a shooter has to get on target first** (`AIM_CONE`,
`AIM_DRAIN`, `AIM_BANK` in `enemies.js`, `aim` in `tuningFor`). Sight is line of sight and
nothing else, and `fireCooldown` has been ticking down since the floor was generated — so a
body that heard a shot two rooms ago stood in `chase` with its cooldown long expired and
fired the frame you crossed its door frame, with its back to you if that is how it happened
to be standing. Rounding a corner into three of those is not a fight you lost, it is one you
were never in. `tuning.aim` is now the beat before the first round: 0.85 s on floor 1 down to
0.34 s deep, times the type's own `aimMul` — 0.65 for a Sentry Unit that was bought to watch
a corridor, 1.25 for a Sysadmin who was doing a spreadsheet ninety seconds ago. Four things
about it are the design rather than the tuning:

- **Only time spent POINTING at you counts** (`AIM_CONE`, ~60°). Turning round is already a
  real cost — the yaw smoothing in `_move` — so this is what makes the body facing the wrong
  way the one you get to surprise. Measured on floor 1: 0.83 s to the first round facing you,
  0.95 s if it has to come round first.
- **It drains rather than resets** (`AIM_DRAIN`, 0.6 s per second out of sight), which is the
  rule `cameras.js` already uses and for the same reason: one frame behind the door frame is
  not a pardon, and a player bobbing in and out of a doorway must not be permanently
  un-shootable. The second peek costs them less than the first.
- **...but the credit is capped** (`AIM_BANK`, 1.6× what they need). Without it a body 30
  seconds into a firefight holds 30 seconds of aim, the drain buys you nothing for the rest
  of it, and stepping out of cover is instantly fatal for ever after. Measured: banked aim
  tops out at 1.36 s, a 1 s break leaves 0.76 s (so a quick re-peek costs 0.09 s), and 4 s
  of cover wipes it — a fresh sighting then costs the full 0.92 s again.
- **Melee is exempt**, because it already pays the same courtesy in the same coin: a swing
  lands part-way through rather than on the wind-up (`SWING_TIME`), so you can back out of
  reach after seeing it start.

It is a different number from `tuning.reaction`, which is the idle → `alert` → `chase`
delay: that one is how long somebody takes to *notice*, and it does nothing at all for the
body that noticed you a minute ago and is already walking your way.

Each floor rolls a **theme** that tilts the type weights (Infestation, Automated,
Lockdown…), so floors have their own character without any of them becoming one enemy
repeated; the name is shown on the way in. Types share one rig with different numbers and
colours; the visor colour tells you what is about to happen.

A crowd of **neutrals** — the Panicking Staffer looking for a toilet, plus Night Cleaners and
Couriers — are placed by hand in the corridors of every floor rather than rolled
(`weight: 0`). The two halves of that are drawn deliberately differently (`HALL_PANICKERS`,
`HALL_BYSTANDERS`): the toilet guy is a flat one or two whatever the floor is, because he is
a joke and a joke lands twice and is a running gag by the sixth time, while the rest are the
building's background traffic and so scale with `layout.areaRatio` — six people over a slab
half again the usual size is an empty office, and the same six over a small one is a crowd.
The same question `tuningFor` and `cameras.js` already ask. They are placed `NEUTRAL_GAP`
apart, because `this.corridors` samples every tenth tile and that is coarse enough to stand
a courier inside a cleaner once there are a dozen of them. They are
not in the state machine at all: no alert, no chase, no weapon, and seeing or hearing you
changes nothing. They do **not** count toward clearing the floor (`hostileCount`, not
`aliveCount`), so you can walk past every one and take the exit. Shoot one and it flees for
a few seconds — the same wander loop, quicker, with destinations filtered to somewhere
further from you — then goes back to its day. They show yellow on the minimap, because "do
I have to shoot this" needs answering from the far end of a corridor.

Visors answer that same question first and identity second. Every hostile wears a **grey**
— one ramp from near-white (Survey Drone, then Intern) to near-black (Sentry Unit),
brightest for what dies to a look and darkest for what does not — and the Reanimated wear
green. The harmless are the only ones in an actual colour: white for the Panicking Staffer,
brown for the Night Cleaner, yellow for the Courier, blue for the Staff on Break, violet for
the Porter Unit. So hue says threat, shade says which one, and no two types share a visor.

**The machines are on that same ramp rather than beside it**, and that is a rule being kept
rather than a palette being copied: neither question changes because the thing at the end of
the corridor has wheels. A Survey Drone is the brightest visor in the building and a Loader
Unit is nearly the darkest, for exactly the reasons an Intern and a Manager are.

**And none of them is holding a gun, which they all were.** `rigs.js` hid the sidearm on a
melee type and on nobody else, so every neutral in the building was walking about with a
pistol in its hand — measured on one floor, the Panicking Staffer 2 of 2, the Night Cleaner
3 of 3, the Maintenance Worker 4 of 4. The whole job of these people is that you can decide
not to shoot them from the far end of a corridor, and a silhouette holding a pistol has
already answered that the other way whatever colour its visor is. `gun.visible` now asks
`!type.melee && !type.neutral`.

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

### The machines (`chassis` in `rigs.js` + `drive` in `enemy-anim.js`)
The Automated floor is not staffed, it is **worked**, and that is the whole of what the
theme is now: **nine in ten** of what is on it is a machine and the tenth is whoever is left
to maintain them. It used to be three Sentry Units in four and a name — a floor named after
machines, with an ordinary office around them.

**A `chassis` is a rig, and there are six of them.** One builder plus a table, exactly the
way `TYPES` is one rig plus a table of numbers, because a floor that is 90% one robot is the
floor of one enemy repeated that `share` exists to prevent — and it would be that twice
over here, since the point of the shift is that the building is being worked. So the share
is split across the JOBS: a hundred Clerk Units at the desks (0.34), Sentry Units in the
corridors (0.20), Loader Units shifting stock (0.14), Welder Units on the racks (0.13) and
Survey Drones over all of it (0.09). Measured over 200k draws at floors 2, 3, 4, 6, 12 and
30: machines 89.9–90.2% throughout and every type within 0.2 of its share.

...and a sixth that is on the roster for a different reason. The **Legacy Unit** IS the
original Sentry Unit — the same numbers, the same grey shell over a pale under-layer, the
same near-black visor — kept because it is a silhouette the building already had. What it
does not have is a chassis, and that is its whole character: built on the human rig, it is
the only machine on the floor shaped like the people it replaced, and at the far end of a
corridor it reads as staff. Its visor sits a hair off the Sentry's, because no two types
share one and these two are the same numbers under different bodies.

Which is what `isMachine` is for, and it is a fix rather than a tidy: everywhere the game
asked whether something was a machine it read the answer off `chassis`, which is a question
about how a body is DRAWN. The Legacy Unit answered no, and the first thing to notice was
`_lunchOk` sending a robot to the canteen for its lunch.

Five of them are `weight: 0`, and that is how the theme stays a place rather than a tint:
outside an Automated floor none is ever rolled, so meeting a Loader Unit means you are on
the floor that has loaders on it. The **Sentry Unit** is the exception and always was —
Facilities bought it to watch a corridor in a building full of people, so it turns up in
one, and it is the reason `themeUsable` still holds Automated back to floor 2.

**A chassis hands back the SAME field names as a person** — `torso`, `head`, `armL`/`armR`,
`legL`/`legR`, `gun`, `blunt` — and that is the trick the whole thing rests on: the state
machine, the six hit zones, the ragdoll, the seating rule and the walk cycle never learn
that this one is on wheels. Exactly two things had to be told:

- **`drive`**, what it gets about on, which a leg swing cannot guess. Legs swing and bob as
  they always have; wheels roll off their own accumulator rather than off `walkPhase`,
  because the phase carries the idle sway everything with legs wants and *a wheel turning
  under a body standing still is the one thing a wheel must never do*; tracks do not move at
  all, which is most of what makes a Sentry Unit read as heavier than the thing beside it;
  and a hover rig floats on one sine with its rotors doing the arguing. Footfalls are gated
  on the two drives that have a foot — a wheel and a set of fans have nothing in the sound
  set, and silence is the honest answer rather than a step clip played at something that
  never lifts one.
- **`gunRest`/`gunAim`**, where the weapon is carried and where it comes up to. Those were
  constants inside `animate`, which was true of every body in the building right up until
  one of them was a metre and a quarter off the floor. The human rig now declares its own
  two, unchanged.

Three smaller things are worth knowing. Geometry is memoised **per chassis** rather than per
body, unlike the rat and the floor cleaner — those are one to five a floor, and a machine
floor is a hundred and fifty of one shape. The drone and the porter ragdoll `whole`, for the
rat's reason: six bones spent on something the weight of a chair that was in the air when it
stopped working. And the drone **is authored a metre and a quarter up** rather than made to
hover — a rig is placed at its body's feet, so a machine that flies is a machine whose parts
are simply higher up, and nothing in the engine has to learn what flight is.

The Loader Unit is the one machine painted a **colour** rather than a shade, which is right
(hi-vis is what plant is painted, and the hardest single hit in the building should be
legible from the end of a corridor) and was not enough on its own: two thirds of a metre of
flat yellow reads as a crate. A hazard band across the front and down each flank is what
turns it back into a machine.

**And they wear a finish** (`tech-textures.js`). Panel seams and a course of fasteners on the
paint and on the frame under it, hazard stripes on the Loader's band, and a lit readout on
every chest — which is the cheapest thing on the roster that says the difference between a
painted box and a box that is switched on, and the only part of a machine still doing
something while it stands still. Two details in it are not decoration: the readout is a
PlaneGeometry turned to face -Z, because a plane faces +Z and a machine does not, so without
the turn the one lit thing on the front of the chassis is a back face and is not drawn at
all; and it never casts, because a flat quad pressed against plating shadows itself along its
own edge. Measured on a floor of 166 machines: 0.5 ms and 15 draw calls for the lot.

**`bystanders` on a theme** is the same argument for the corridors. The harmless traffic is a
Night Cleaner and a Courier unless a theme names its own, and here it is the **Porter Unit** —
the courier joke told about the building instead of about a man, a parcel deck on wheels with
a beacon on a mast. The toilet guy is deliberately *not* on that list: he is a flat one or
two on every floor there has ever been, and the last human on a floor of robots running for a
lavatory is the joke landing harder rather than a joke out of place.

### A chair means harmless (`workstations` in `gen/build.js` + `_takeDesk`/`animateWorking`)
**Nothing that is going to fight you is ever found sitting down.** That is the rule, it is
the one tell in the building that is about behaviour rather than about identity, and
everything below is in service of it.

Three kinds of body are in a chair, and the first is the one the rule is really for:

- **Anybody on their break**, at the tables in the canteen the floor arrives in. Harmless
  while they are there, and the first bodies the player ever sees — so the tell is stated on
  the way in, with nothing at stake, before the first chair that matters. This used to be a
  fixed cast of permanently-neutral diners; it is now a **cycle** that ordinary employees
  walk too, which is the next section.
- **The Manager**, at his own desk behind the black door.
- **One guard**, on the cameras in the security office.

The last two are the only reason either room exists, and both are behind a lock.

**And nothing sits on the FLOOR either**, which is the second half of the same rule and was
missed the first time round. Two janitors used to be found on their break on the floor of the
broom closet, and the closet is behind a yellow door — but a janitor is hostile, swings the
longest reach on the floor, and counts toward `hostileCount`, so you cannot finish a floor
without killing both of them. A body sitting down was therefore a tell that meant "harmless"
in two rooms and meant nothing in a third, which is worse than no tell at all. They wait on
their feet now, and `animateFloor` went with them (in git, if anything harmless is ever put
in a cupboard).

**What a rolled body may NOT do is sit at its desk**, and that is the part that was taken
away. It used to be about 23 of a floor's ~175 bodies, found typing with their backs to the
door, and it read beautifully — but it read as a promise the state machine does not keep. A
body at a desk is `idle` like any other and is on its feet the frame it sees or hears you, so
"somebody is sitting at that desk" was information the player could not act on. A body at
LUNCH is different in the one way that matters: it is out of the state machine entirely, so
the chair is telling the truth. The floor pays for the lost desks in atmosphere, which is a
real cost and was accepted knowingly — an office of standing staff is less of a workplace
than an office of typing ones.

What did NOT change is any of the machinery below. The furnisher still places every chair
and still faces it at its desk, the pose still hinges a real joint, and everybody who does
sit goes through exactly the path all twenty-three used to.

**The furnisher decides where, because it is the only thing that knows.** A desk with a
monitor on it and a chair pulled up to it is a job, and `seatFacing` in `gen/rooms.js` is
the one call that places that chair — so it registers a **workstation** (where the chair
is, and the quarter turn that faces the desk) through `sink.workstation`. `enemies.js`
would otherwise be guessing at furniture from the nav grid, and `_seat` converts that turn
to a yaw with the same line `tryPlace` uses for a model, because a body and the chair under
it face the same way for the same reason. Levels do not collect them: the desks on the
generator's mezzanine are off the nav grid entirely, and a body seated somewhere nothing
can walk to is a body that stands up into a wall.

Four things about it were learned by measuring rather than by looking:

- **A chair pulled up to a desk could not be placed at all**, and had never been: floor is
  reserved by whole tiles (`stamp`), a desk is 0.97 m deep, so its reservation reaches half
  a metre past its own front face and the chair always landed inside it. 16 wall-backed
  desks on the floor this was measured on, 16 chairs refused — every private office in the
  building furnished with a desk nobody could be sitting at, which nobody had noticed
  because nobody was sitting at them. `sink.lend` waives that one prop's claim for the one
  prop that belongs to it, and nothing else: the wall behind, the doorway apron and the
  cabinet beside it all still stand.
- **A cubicle pod's chair had its back to its own desk.** It was placed at the *desk's*
  rotation, and the chair has to be a quarter turn round from that (`edgeProp`'s table
  again — see above). Invisible while the pods were empty; the moment there is a body in
  one it is the only thing in the room.
- **Which rooms get served before the roster runs out is the whole of where a floor's
  staff are.** The headcount is spread over a hundred-odd rooms and runs out long before
  all of them have had a turn, so the first pass goes to the rooms with desks in them and
  the archive gets whoever is left. Left to the shuffle it came out as **six** people at a
  desk on a floor of a hundred and six, with two thirds of the building's desks empty.
  First pass only: held for every pass it fills five rooms and empties the rest of a floor
  small enough to come round again.
- **A room with desks is dealt a shift, not the flat 0-3 a storeroom draws** (`DESK_TEAM`),
  and a desk nobody fits in front of is dropped from the pool rather than refused at the
  door — a third of a cubicle farm's pods fail `nav.clear` because the pitch is tight and
  the grid holds a body to whole tiles, and counting those deals a farm five people and
  then stands all five of them up. That count is now the *only* thing a room's desks decide:
  how many people are in the room, not where any of them stands. A twelve-pod farm is still
  where the work is whether or not anybody is sitting at it, so it is still staffed like it.

**The pose hinges the limbs about a real joint** (`hinge` in `enemy-anim.js`), and that is
the one thing here that is not free. Every part of a rig is a bare mesh (`part` in
`rigs.js`), so `rotation.x` alone turns a leg about the point half way down it — which the
walk cycle gets away with because the swing is a few degrees, and which at 70° leaves a
hand's width of daylight at the hip and puts the foot through the floor. `stand` puts the
limbs back when they get up, because nothing else in that file ever moves one. Both beats —
typing, and the pause to look at whatever it did — run off the `walkPhase` every body is
already seeded with, so no seated body needs one number stored beyond the one it already had. The sidearm goes to the hip rather than being hidden:
`animate` rewrites its position every frame for anybody on their feet and never gets the
chance here, so left alone it hangs in the air where a standing hand would be.

`e.seat` is `'desk'`, `'table'` or null. On the wire it is one bit that only ever stands
somebody up, plus the break bit beside it to say which kind of chair — a desk somebody was
PLACED at came from the shared seed and both browsers have it, and a canteen chair somebody
WALKED to did not. See Lunch below.

There is no longer a `standing` flag on the Sentry Unit, and its absence is the tell that
this rule is enforced in one place rather than per type. It existed to keep the one machine
on the roster out of a chair while everybody else sat down; nothing that is rolled sits at a
desk any more, so there is nothing for it to except, and a flag no code reads is a flag that
will be trusted by the next person to read the file. The machines are still kept out of the
canteen, and by the same one place: `type.chassis` in `_lunchOk`.

### Lunch (`_lunch` in `enemies.js` + `buildTray` in `rigs.js`)
The canteen had a job that was not fighting you, and the people in it did it for ever:
placed in a chair when the floor was generated and still in it when the floor ended. A break
that never ends is a tableau, not a shift.

So there is a **cycle**, and both halves of the canteen run the same one — walk in, queue at
the counter, take a tray, find a seat, eat, take the tray back, walk out. The staff the floor
opens on start half way through it, already seated and already eating, because that is the
picture the arrival is for; they get a longer first sitting than anybody else (`EAT_FIRST`)
for the same reason, since four people who file out inside a minute is the picture gone
before the player has finished reading it.

**What makes it more than scenery is who else joins.** An ordinary employee takes a break:
they down tools, their visor goes to the canteen blue, they walk the whole cycle, and their
own colour comes back as they leave the room. That is the first thing in the building that
changes a visor at runtime, so the rule it states had to stay exactly true in both
directions:

- **Blue eyes are not fighting you.** A body on its break is out of the state machine as
  completely as a neutral — no alert, no chase, nothing in its hands. Walking past one costs
  nothing, which is the promise the chair has always made.
- **...and the tell is live.** Any damage ends the break on the spot (`_damage` calls
  `_lunchEnd` before anything else), so the frame a body stops being harmless is the frame
  its eyes stop saying it is. Measured: a Security shot mid-walk went blue → `#7d7973`,
  sidearm back, `alert`, inside one call; a diner shot at the table dropped its tray, kept
  its own blue — that IS its colour — and was out of the chair on the next tick.

**Two things it deliberately does not change, and both are correctness rather than taste.**
`hostileCount` reads `e.neutral`, which is a fact about the TYPE and is never touched here —
measured at 88 before, during and after three lunches, and at 214 across a floor that sent
nine people to eat. A count that moved would make "floor cleared" fire and un-fire, and the
black card is timed off it. And the minimap still shows them as what they are, because the
two markers answer different questions: the map says whether you have to shoot this
eventually, the visor says whether it is about to shoot you.

**Machines do not eat** (`type.chassis`) and neither do the Reanimated (`type.undead`).
Between them that is every hostile in the building that is not staff.

**And a seat is only a seat while the furniture is still there** (`_seatGone`). A seated pose
is drawn relative to a prop, and that prop is LOOSE: one round ends it and walking into it
moves it, and neither used to reach the body — destroy a canteen and the people in it went on
sitting in mid-air, which is what a player reported. So `_seat` records what the pose is drawn
against (the chair under it, and for a canteen seat the table in front of it) and `_seatGone`
checks them once a frame for the handful of bodies that are sitting down. The lists are the
ones the player already collides against, handed over rather than copied, so they stay live: a
shot prop retires its own collider with `top = -1` and a shoved one moves its own bounds, and
neither is an event anybody has to send. Null is an ordinary answer and means *do not check* —
a lookup that fails must never read as the chair having gone.

The chair is checked for every seat and the table only for a canteen one, because they fail
differently: losing the chair is a body sitting on nothing, which is wrong wherever it
happens, while losing the table leaves the chair doing its job and only the tray in the air.
Measured: a shot chair, a chair shoved 2.65 m, a shot table and the seated set piece all stand
up with their joints restored to the rig's own, an untouched chair sits 0.009 m from its body
and is still at 0.009 m ten seconds later against a 0.5 m tolerance, and four floors produced
zero spontaneous stand-ups.

**`stand` is exported for it**, because `animate` could no longer be the only thing that
decides a body is out of a chair — its own rule is that `idle` and `alert` HOLD the pose, and
"the chair is not there any more" has to stand up somebody who is idle and staying idle.
Clearing `e.seat` and calling `stand` are still one operation, wrapped in `_standUp`, which is
the whole of what that rule was ever protecting.

**And a body sits ON its chair, which it did not** (`_settleOnto`, `SEAT_SNAP`). Found while
verifying the above and worse than the bug that prompted it: everybody who WALKED to lunch sat
down about a metre from their chair — all 46 measured seatings between 0.98 and 1.09 m out —
because a flow field walks to tile centres and a chair is not at one, so `LUNCH_ARRIVE` was
being read as "close enough to sit", which it never was. The field gets them to the chair and
the last metre is walked in a straight line over what is open room floor by construction (the
furnisher only offers a station a whole body fits in front of), with `_seat` closing the last
few centimetres exactly. Worst gap over 22 seatings is now 0.03 m.

Three things came out of measuring rather than writing it:

- **A route is only a route if the BODY is on it.** Flooding to the counter says nothing
  about whether the flood reached the walker, and most of the staff are behind a badged door,
  which is out of the nav grid entirely (the same rule that makes `pathDistance` come back
  -1 for hearing). Before both halves were checked, bodies set off for a canteen they could
  not reach and spent the whole stage cap re-flooding the floor thirty times a second from a
  tile they were not standing on. The answer is the best thing in here, because it MOVES
  over a floor: with nothing in your pocket **5 of 79** staff can reach the canteen — the
  ones already in the corridors — and one white card opens 170 doorways and makes it **77 of
  79**. The building goes to lunch once the building has been opened, which is not a rule
  anybody wrote.
- **Reachability is asked before anything is committed.** A failed attempt that had already
  created the break would mark that body as having had one (`lunchDone`, which is what stops
  the same man queueing twice while nobody else goes), and nine tenths of the floor would be
  out of the running before the player had opened a door. It is also **one flood per
  attempt, not one per dart**: the field from a fixed counter is the same field whoever is
  asking, and two dozen floods of a ten thousand tile floor to answer one question is the
  shape of loop this file has been caught writing three times.
- **The stage cap is 100 seconds**, not the 55 it started at. A walk from an office at one
  end of a deep floor took a Security fifty seconds at lunch pace, and a body that gives up
  half way goes back to work in the middle of a corridor for no reason the player can see.
  It is a backstop rather than a timeout anybody should reach — a break that quietly never
  ends is a body that is harmless for the rest of the floor and still has to be killed.

**The furnisher says where the queue is**, through the same `sink.workstation` pipe the
chairs use and under names of its own (`servery`, `trays`). It is the only thing that knows
where the counter actually landed — `cafeteria` asks for the wall opposite the door and may
miss it entirely — so it is the only thing that can say where you stand to be served, which
is exactly the argument `seatFacing` makes about a chair. Three places down the line rather
than one in the middle of it, because a serving line is long on purpose and four people
queueing on the same tile is one body inside another; the tray rack takes the far end, pulled
a little inboard so it is not against the room's own wall (one canteen in ten lost its rack
that way). A rack that still cannot be stood at falls back to the counter, which is not a
fudge: handing your tray back across the counter you took it from is what you would do, and
what it buys is that the cycle can always be finished.

**They look like they are running, and that took putting the motion somewhere visible.** A
belt is fitted at 2.16 m, so the one surface you never see is the one the stock moves on, and
the underside you DO see faces away from every light in the building — the scrolling tread on
the deck is honest and invisible, and a line that was running looked exactly like a line that
had stopped. The `runway` strip is that motion put on the outer face where somebody standing
in the corridor reads it: bright dashes on a dark band, scrolled at belt speed. Its offset
runs backwards, because a plane turned to face out of a wall has its u against the way the
stock travels, and a running light crawling the wrong way down a belt is the one detail on it
anybody checks. The rails wear the same hazard stripes the Loader's band does.

The belt, its rails and its running light are per RUN rather than shared, because all three
carry a pattern that has to run the length of that particular line and a repeat lives on the
texture rather than on the material. `clone` shares the canvas underneath, so what is per run
is two numbers.

`_stroll` is the walk lifted out of `_wander` so both callers can have it, and it **returns
what happened** rather than recovering itself — a neutral makes a whole new plan and somebody
on their lunch re-floods to the same counter, and neither wants the other's answer.

Costs about 0.1 ms a frame per walker on a floor of 147 (1.85 → 2.04 ms with two out), which
is the ordinary cost of a wandering body: they already carry a field of their own.

**On the wire it is two more bits** in the slot the seat already rode in (`SNAP_BREAK`,
`SNAP_TRAY`). The visor is the game's one universal tell, and a joiner looking at an employee
wearing its own colour that is not going to shoot back is being lied to. The tray goes over
rather than being derived from the break, because a body walks the first and last beat of a
lunch without one — and the break bit is also what tells a joiner that the chair is a canteen
table, since unlike every other seat in the building a chair somebody WALKED to did not come
from the shared seed.

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
included, the room you spawn in excluded (a reader on the room you start inside is a
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
with nothing in your pocket — and every one of them carries it. Two more wait in
the broom closet, marked `behindLock` and dealt no card at all, because two men
standing in the room their own key opens holding that key is the exact failure this
system exists to prevent. They are only posted **if at least one janitor made it
onto rounds**; without a reachable holder the closet pair would be a floor that
cannot be cleared, since they count toward clearing it like any other hostile. Same shape as the manager one tier down: take the card off
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
  floor is one room and two hundred shut doors.
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

### Parcel lines (`conveyors.js`)
Belts along the corridor walls with the building's own stock moving on them. A floor run by
machines should say so before anything on it has shot at you, and the staff are only half of
that — the other half is that the **work is visible**. It is also the only piece of scenery
in the game that is still moving when nothing else is.

`conveyors` on a theme is its third lever on the **building** rather than on who is standing
in it, alongside the tint and the floor units. Absent, a floor has none: measured across
floors 1–8 of one seed, zero runs on all seven non-Automated floors and ten on the Automated
one. Two decisions shape the module, and they pull against each other.

- **It is fitted above everything.** `CLEAR_Y` is the larger of two clearances that both have
  to hold — a body's own `BODY_H`, and the tallest thing in the furniture catalogue, because
  a belt is fitted to a building that already has two-metre shelving standing in it. It is
  written as that `max` rather than as the 2.11 that came out of it, so making the player
  taller moves it. This is the whole reason a module may put geometry into a **finished**
  floor without re-proving one invariant: it touches no nav tile, reserves no floor, and
  cannot make a room unreachable however it lands.
- **...and it is still solid.** Clearing a standing body is not the same as not being there:
  a player who jumps against the wall under one has their head at 3.2 m, and a conveyor you
  can put your eye inside is worse than no conveyor. So a run contributes **one collider with
  a `base`**, the way the plant room's tall door header does, and `barrier` is what keeps it
  from also becoming a kerb or a floor. Measured against the real `Player`: walking at the
  wall under a belt closes to 0.18 m of its centre line, the same walk with the feet off the
  ground is held at 0.40, and walking *along* underneath one is unobstructed — which is the
  right answer both ways round, because a head scraping a belt does not stop you walking
  forward under it.

**The parcels are the destructible half and the belt is not.** A line is building services
hung off the structure, like the suspended ceiling and the slab. A round takes a box off it,
it falls, it bursts on the carpet, and the line sends another after six to fourteen seconds —
that is stock being replaced, which is what a running line does. Measured end to end: shot at
2.24 m, on the floor and hidden inside 0.7 s, back at the head of the belt when the timer runs
out. A parcel waiting to be restocked is hidden **and** scaled to nothing, and neither is
redundant: a `Raycaster` does not test `visible`, and an invisible box that still stops
bullets is worse than no box.

Three smaller things. Placement walks a shuffled list of corridor tiles with a wall beside
them, like the cameras and for the same reason — a tile that survives every test is a few
percent of a floor, so darts deliver three lines on one floor and nine on the next. A run
extends along its wall for as long as the corridor continues *and* the wall stays solid, so a
doorway is what ends it: a line across an opening has nothing to hang off and would be a line
across an opening. And parcels scale up out of one drive head and down into the other
(`EDGE`), which is the cheapest honest answer to a loop — a belt IS a loop, and the return leg
is inside the housing.

**The shift is now rolled in `game.js`** rather than inside `enemies.spawn`, because the
building has to know it before the floor's colliders go to the solver. It is still the first
draw off the floor's rng, exactly where it was, so nothing after it moved.

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

### Co-op (`net.js`, `netplay.js`, `remote-player.js`, `mp-menu.js`)
MULTIPLAYER on the start screen opens a panel with a six-character code in it, a box to
type somebody else's into, and one line saying what the wire is doing. Opening the panel
publishes the code, so "wait for someone to join you" is simply not pressing anything
else. Connecting starts a fresh run at floor 1 on both machines.

**The floor is not sent, it is REBUILT.** Every floor is a pure function of one integer
seed (`gen/rng.js`), so the host rolls one, sends four bytes, and the other browser
generates the same building down to which filing cabinet is in which corner and which of
two hundred people is standing in it. Everything on the wire after that is a correction to
a simulation the other end is already running, which is the only reason any of this fits
down a data channel. Four things follow, and they are the whole design:

- **The staff are the host's.** Both rosters are the same roster in the same order, so a
  body's index in `enemies.items` is its name on the wire. The host thinks for all of them
  and streams positions at 12 Hz; the joiner poses its copies (`enemies.puppet`,
  `_poseAll`) and never runs the AI. Two browsers each running it would not be one floor,
  it would be two — a shot fired at somebody who, over there, is in the next room.
- **Damage is the host's.** The joiner's shots are real and immediate on its own screen —
  tracer, flash, flesh impact — but the health is the host's and the kill comes back as a
  message (`hit` in `enemies.js`). It deliberately does not predict the death: predicting
  it shows bodies dropping that the host has not agreed are dead, and then standing back
  up. The death message carries whose kill it was, because a joiner's shots come back as
  `'hit'` whatever they did and that is the only place it can be told.
- **Destruction is symmetric.** Either browser may shoot a desk apart, because `_shatter`
  is idempotent. Worth syncing rather than leaving local because destroying a prop hands
  its tiles back to the nav grid — leave it out and the joiner watches the staff walk
  through a cabinet that is still standing.
- **Cards are the team's.** One of you badging a door while the other stands in front of it
  refusing to open is not a lock, it is a bug. Identified on the wire by TIER rather than
  by any id, which works because only one card of a tier is ever on the floor at once
  (`pending`) and makes the whole thing self-healing.

The pieces that had to change to allow two players at all:

- **`enemies.update` works against a LIST of targets**, `{x, y, z, layer, dead, hurt()}`.
  Single player hands over a list of one and nothing notices. `_pick` chooses which one
  each body is dealing with — sight beats distance, then nearest — and `hurt` is what
  makes the two interchangeable: for the player at this keyboard it is health and a
  chevron, for the other it is a message, and `enemies.js` never learns which.
- **The flow field floods from BOTH players** (`_flood` takes a list of origins). A
  multi-source BFS costs nothing extra and every tile then holds the walk to the NEARER of
  you, so "the staff chase whoever is closest" and hearing measured on `pathDistance` both
  fall out for free rather than needing a second field.
- **Door sensors answer to both.** A panel that only opens for the browser it is running in
  is one your friend walks into, and worse, one that opens in front of you and stays shut
  in front of them in the same doorway.
- **An alarm is host-only, and this is the sharp edge.** `enemies.alarm` APPENDS four
  bodies to `items`, so a joiner raising its own would leave the two rosters different
  lengths and every index after that landing on the wrong person. The joiner's cameras
  report instead, and the host sends back a seed per responder so both browsers build the
  same man.
- **The joiner still floods the field** even though it routes nothing with it, because
  `soundPath` reads it: without it every gunshot on the floor arrives through the plaster
  instead of round the doorway. Measured — 206 flooded tiles before the first card, 11,048
  after it, matching the host exactly at both.
- **A hidden tab keeps simulating** while a session is up (`main.js`). `requestAnimationFrame`
  stops for a tab nobody is looking at, which is correct alone and catastrophic here: the
  host is thinking for two hundred people, so a host who alt-tabs to paste their code into
  a chat window freezes their friend's floor solid. The render is skipped and the
  simulation runs off a timer — and Chrome exempts a tab making a noise from its harshest
  throttling, which this one is.

The **snapshot's sixth slot** is three bits of state and three flags — in a chair, on a
break, carrying a tray. The last two are there because the visor is the game's one universal
tell: a joiner looking at an employee wearing its own colour that is not going to shoot back
is being lied to. See Lunch above.

**Not synced, on purpose:** ragdoll poses, spent brass, decals, debris, extinguisher gas
and the generator's arcs. All cosmetic, all hundreds of bodies a floor, none of it changes
what either player can do. Nor is joining mid-floor: a floor half fought through is two
hundred healths, a scattering of wreckage and a wallet, and that is a lot of protocol for
the one moment in a session it would ever be used.

**The menu is the only interactive UI in the game**, and that makes it the one hazard.
Every other element is `pointer-events: none` so nothing can swallow the click that grabs
pointer lock, and the start screen is one enormous click target built on exactly that rule.
So `mp-menu.js` holds the opposite line: every press inside the panel is stopped where it
lands, across the whole family of pointer events, because three separate listeners are
waiting on the way out — the overlay's click grabs the lock, `main.js`'s mousedown restarts
a dead run, and `input.js`'s mousedown pulls the trigger. For the same reason `input.js`
now ignores keystrokes aimed at a text field: codes are drawn from A–Z and 2–9, so typing
one otherwise walks the player forward, sideways, reloads, and swaps weapon four times.

The code's alphabet has no I, O, 0, 1 or 5 in it, which is a legibility decision rather
than an entropy one — these get read out loud. `normaliseCode` is forgiving about
presentation (case, spaces, dashes) and strict about content: it will not guess at a
character we never issue, because inventing a code the player did not give us either dials
a stranger or reports "nobody is waiting" for one that was merely mistyped.

**The broker is the weak link and there is no fallback.** WebRTC cannot introduce two
browsers to each other without a server both can already reach, we cannot host one from a
static Pages site, and so this uses PeerJS's public one. Only the code and the WebRTC
handshake ever go there; once the channel is up every byte is browser to browser. It is
rate-limited and occasionally down, which is why `net.js` reports failures as English
rather than leaving a menu that quietly does nothing — and why a dropped broker socket
reconnects rather than failing, since a tab waiting to be joined is idle by definition and
a backgrounded one has its keepalive throttled to about once a minute.

`#netrole` is the chip that says which end of the wire you are, and it earned a note in
`/dev-layout.html`: top centre is the one strip of screen edge with nothing on it, except
that the touch fullscreen button is already there, and on a phone the floor readout and the
minimap leave no room between them either. Both collisions were found by measuring, not by
looking, and the harness now watches the chip so the next one is too.

### Touch controls (`touch.js` + `#touch` in `index.html`)
The game is playable on a phone, and none of it is on a PC — the on-screen controls do
not exist until a finger actually lands. Four things carry the design:

- **The layer is inert and the module hit-tests the rectangles itself.** Everything in
  `#touch` is `pointer-events: none`, and one document-level `touchstart` listener works
  out what each finger is doing by measuring the buttons. Walking, looking and shooting
  are three fingers down at the same time, and per-element listeners see that as three
  unrelated gesture streams with no way to tell which finger is which. Holding the touch
  identifiers is what makes it one pair of hands on a controller. It also means a button
  can never swallow the tap that starts the run, which is the rule the HUD already lives
  under.
- **Detection is a guess plus a fact.** `pointer: coarse` and no `any-pointer: fine` is
  the opening guess, so a phone shows "TAP TO PLAY" and the touch legend before it has
  been touched; a tablet with a trackpad correctly boots to the desktop controls. The
  fact is the first real `touchstart`, which enables the controls whatever the guess
  said — and a `KeyW` hands them back, so a laptop somebody prodded once returns to
  mouse and keyboard.
- **The mouse paths have to go quiet, not just be ignored.** A tap on a phone still emits
  a synthetic `mousedown`/`mousemove` pair at the finger. Leave those live and every tap
  fires the gun and every second tap snaps the view to wherever the finger landed, so
  `input.js` holds a `touchMode` flag that shuts both off. The two exceptions are
  deliberate: the tap that starts the run and the tap that restarts after dying are
  `click` and `mousedown` handlers, so `touch.js` does **not** `preventDefault` while the
  start screen or the death screen is up. Consuming those makes the game unstartable, on
  mobile only.
- **`applyLook` is shared with the mouse fallback**, because the pitch clamp already
  existed twice once and the second copy is what aimed the gun's kick at the floor.

The stick's base jumps to wherever the thumb landed and goes home on release, so its
drawn position is a suggestion rather than a target. Sprint is full deflection rather
than a sixth button.

**The HUD moves out of the way rather than being drawn over.** The left column climbs
above the stick and the right column above the button stack, off `--tier-*` variables in
`style.css` that the buttons are laid out from — declared on `:root` and not on `#touch`,
because `#health` and `#gunbox` live in `#hud` and a custom property on a sibling subtree
reads as unset, which silently collapses the whole rule. Sizes are `vmin`-based and
clamped at both ends, so a control is the same fraction of the short edge whichever way
the phone is held. Small-screen typography is keyed off the viewport rather than off
`body.touch`, because a browser window dragged thin has exactly the same problem and
should not have to be touched before it fits. `/dev-layout.html` is what proves any of
this.

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

  **And that half of the bargain is load-bearing, not a nicety.** The generator's
  blackout broke ~200 ceiling tubes and asked for a break and a settle for every one:
  ~400 voices, each with a panner and most with an occlusion lowpass, all started inside
  a second and each lasting longer than that, so they piled up faster than they retired.
  The audio thread stopped keeping up and `ctx.currentTime` fell **2.7 seconds** behind
  the wall clock — which is the floor going silent for a second or two, exactly as a
  player described it. `blackoutPanels` in `destruction.js` now voices only the panels
  inside the `AUDIBLE` range that already governs enemy noise, capped at
  `BLACKOUT_VOICES`; the rest break in silence, with the same geometry, debris and light
  removal. 388 live voices became 20 and the drift became 8 ms.

  Two things generalise. The tubes out of earshot were **never audible** — the panner's
  falloff and the lowpass had already taken them to nothing — so this cost nothing to
  give up; a sound you cannot hear is not a sound you are losing, it is work. And the
  range test alone was not enough (23 tubes were still in earshot on the test floor) nor
  was a budget alone (it spends itself on the far side of the building): an event that
  fans out over a whole floor needs both.

  **The measurement that found it is worth copying**, because three plausible theories
  died first — the limiter ducking the mix (~5 dB, and it sits on the master so it cannot
  spare the ambience), sound routing degrading (`soundPath` identical before and after),
  and the main thread stalling (real, 49 ms, fixed, and not the cause). What settled it
  was **`ctx.currentTime` against `performance.now()`**: the audio clock is driven by the
  sound device rather than by the page, so drift between the two is the one number that
  says the fault is *below* the game rather than in it. Frame times and a count of
  `sfx.play` calls alongside it partition the rest — a stalled main thread, a game that
  stopped asking, and sounds that start and are inaudible all look identical from a chair.
- **Clips are measured and conditioned at decode.** Generated audio arrives at wildly
  inconsistent levels: the first pass drew three pistol takes at 1/50th the loudness of
  the shotgun's, which played as silence and read as the gun randomly misfiring. Takes
  are pulled toward a common RMS (bounded, never into clipping) and started at their
  onset, because a take whose blast sits 480 ms into the file makes every burst ragged
  no matter how many voices are free.
- **Never the same take twice in a row**, and every play draws a random playback rate.
  That, not clip count, is what stops repetition sounding cheap.

**A LOOP is a different problem from a one-shot, and it took a player to notice.** Two things
in `sfx.js` are the fix, and both are about the floor cleaner's motor:

- **Loop the part of the clip that is actually running** (`loopWindow`). The engine conditions
  one-shots by starting them at their onset, and `bed` exempts a clip from that on the grounds
  that trimming a bed's head would break the seam it loops on. The roomba clip is a `bed`, and
  measured: its **first 2.4 seconds are near-silent** (windowed RMS 8.7 → 0.7 before the motor
  arrives at 2.4 s, steady ~22 after). Looping the whole 8 s buffer therefore switched the
  vacuum off for a third of every cycle — "its sound should be continuous, not on and off",
  exactly. `loopStart`/`loopEnd` now bracket the stretch that carries the clip's own level,
  found by windowed RMS rather than the sample-level onset detector: that one is looking for a
  transient, and a motor fading up over a second and a half has no transient to find.
- **A loop names the range it should be audible over** (`loopFalloff`, and `MOTOR_AUDIBLE` in
  `audio.js`). A positional loop is the one sound in the game with **no occlusion** — it is not
  routed through `soundPath`, because re-routing it every frame would swing the source across
  the room — so it arrived from the far end of the floor at full brightness while everything
  else lost its treble and half its level through a wall. Its falloff is `linear` rather than
  the inverse model every one-shot uses, which is the point: inverse never reaches zero, so
  "audible within twelve metres" comes out as a hum that is merely quiet everywhere. Full level
  to 2.5 m, straight down, silent at 12 — and louder up close than it was, because making
  something local and not making it louder just makes it quiet.

The parcel lines are the **second** positional loop in the set (`conveyor`, `startBelt`),
and everything the `loopFalloff` note above says applies to them with one difference: there
are several running at once on a floor rather than one following a body about, so the range
is shorter still (10 m against the floor cleaner's 12) and a long run asks for a motor every
nine metres of belt. A twenty metre line heard from one point is a machine in a corner rather
than a line down a corridor.

`/dev-sounds.html` measures the whole set and flags duds — a variant far quieter than
its siblings is a clip to regenerate, not to amplify. Check it after generating anything;
roughly a third of first-pass draws came back unusable and none of it is audible as a
fault from inside the game. Note what it does **not** measure: whether a clip is fit to be
looped. That is `loopWindow`'s business now, but the 2.4 s of dead air sat in the set for
months with every measurement in the harness reading healthy.

Enemy types name a vocal set with `voice` (`enemy` staff who shout at you, `zombie`,
`robot`), so a new type gets its own throat by adding four files.

Every prop carries a `substance` (`gen/props.js`), which picks its impact, break and
settle clips from one table in `audio.js` — a filing cabinet and a pot plant have no
business sounding alike when shot, destroyed, or landing. Window glazing and ceiling
tubes are building, not furniture, so their `kind` names their substance instead.

### Cardboard, and what happens to it (`carton` in `gen/props.js`)
Every room rolls for a little cardboard on top of its own recipe (`cartons` in
`gen/rooms.js`): three rooms in five get one to seven cartons, half against a wall and half
dropped where somebody put them down. About 200 crushable props on a floor of a hundred
rooms, counting the `crateStack`s the storerooms already had.

It is the one prop that loses every argument it is in. 2.2 kg against a chair's 9, so walking
into one sends it sliding; 8 hp, so one round of anything ends it; and `crushable`, so
**anybody who walks over one flattens it** — which includes the staff going about their day,
and is most of what makes it worth having. `crush` in `destruction.js` is the same path a
shot takes with a different noise on the end and no impact flash: nothing struck it, it was
stood on.

Three things about the flattening are load-bearing:

- **The staff have no idea it is there.** A loose prop is not on the nav grid, so a body walks
  straight through where it stood. That is what makes flattening the honest reading of it
  rather than a clipping bug, and it is why `CRUSH_REACH` is tight: a box crushed by somebody
  who walked *past* it would read as the box breaking on its own.
- **It is asked per prop, not per body** (`enemies.anyNear`, off the same per-frame bucket grid
  `_separate` uses). The alternative is what this file has been caught doing three times
  already: a loop over 200 bodies for every one of a growing number of things.
- **...and only a slice of them each frame** (`CRUSH_SLICE`). 200 props × the 25 cells that
  could hold a body near one is five thousand lookups a frame for an event that happens a few
  times a minute; a round-robin covers the floor in four frames, which is 70 ms — less than
  the time a body takes to cross the box it is flattening. Same trick as `snapshot` in
  `enemies.js`, for the same reason.

Host-only in a co-op session, like every other break: the message goes out through
`onBreakProp`. A joiner's `anyNear` finds nobody anyway, because the grid it reads is only
rebuilt by the side running the AI.

### Water on the floor (`spills.js`)
Shooting a water cooler used to leave plastic and a dry carpet, which is the same class of lie
as a round through somebody's forearm that does not scratch them: the player did a thing, it
had no consequence, and the tell is that they can see where the water should be.

`spills: 'water'` on the prop is the whole of the wiring; `damageProp` reads it. **Two events,
one system.** A round into the bottle OPENS it — a glug, a stream down the outside of the
machine, and a patch that spreads while it empties. Killing it BURSTS it — the whole bottle at
once, a gush, and a patch four times the size. Both then drip for nine seconds, because a
floor that has been wet for a minute is still wet. An intact cooler burbles to itself every
ten seconds or so if you are in the room with it (`_coolerGlug` in `game.js`), which is the
cheapest way to make a breakroom sound occupied.

Five things were learned by looking at it rather than by writing it:

- **A puddle needs two layers.** Wet floor is DARKER than dry, which is what says "wet" on
  pale vinyl — and on the dark grey tile half this building is floored with, a dark patch is
  invisible. 0.85 of near-black on grey tile came out as a slightly grubby tile. So the
  darkening stays and an additive sheen goes on top of it, which is also what a shallow puddle
  does under a ceiling panel: the sheen carries it on a dark floor, the darkening on a light one.
- **The patch belongs to the PROP, not to the shot** (`dyn.puddle`). A cooler hit three times
  spreads one puddle rather than stacking three on one tile.
- **Water lands on the floor the prop is standing on** — its own underside, not y = 0 — so a
  cooler shot in an attic wets the attic.
- **The stream comes out where the round went in.** The first version ran it down the centre
  line of the cooler, which is inside its own plinth and therefore behind it from every angle.
- **The cooler had to be re-authored to be worth shooting** (six boxes instead of two). A prop
  comes apart into exactly the boxes it was drawn from, so a 1.0 m plinth and a 0.42 m bottle
  threw two fragments the size of the machine — which landed where the machine had been
  standing, so a destroyed cooler looked like an intact one that had stopped being solid.

Pooled and bounded like brass and debris: 20 patches, oldest reused, nothing allocated per
event. Patches deliberately do **not** time out — a puddle is a mark on the floor like a
scorch, and water that dried while you watched would be worse than no water at all. Not
synced in co-op, for the same reason decals are not.

### The solver's world is the building's (`GUARD_MARGIN` in `physics.js`)
The two backstop planes — one under the floor, one over the roof — are **derived from the
colliders the floor hands over**, not written down. Nothing is meant to touch either: the
floor plate, the roofs, every level's own slab and the plant room's high roof are all real
colliders, and the planes only catch a body that has found a gap between them.

**Written down is how they came to be wrong, and it cost both of a player's bug reports at
once.** `ceilingY` was 3.0 — "the suspended ceiling, as far as the solver is concerned" —
from a building whose tallest point was an ordinary room. An attic's floor is
`LEVEL_Y` = 3.2 (`gen/stairs.js`), so **every attic in the game was above the lid**, and a
cannon `Plane` is an infinite half-space: the lid shoved every loose crate up there back
down while the attic's own slab held it up, and the two never agreed. Measured on floor 1,
old lid, five seconds of simulation: **27 of 27 loose props sunk below the attic floor, 26 of
them penetrating its walls, worst 0.20 m, 26 still awake**. With the lid derived (8.1 m on
that floor) the same sweep is **zero of everything, all asleep**. A box dropped in an attic
used to oscillate between 3.28 and 3.35 m for ever; it now lands at 3.520 and is asleep
inside a second, unchanged at 6 s. The basement was never affected — it is above
`floorGuardY` — and it measured clean before and after, which is worth knowing when reading
a report that mentions both.

So this is one bug with two symptoms, and the second one is the lesson: **things clipping
through each other in a level and things refusing to settle in a level were the same fault**,
because a solver being pushed two ways at once resolves it sideways. The generator's own
placement was never wrong — a freshly generated floor measures zero interpenetration on every
level, before the first tick.

The generator room's mezzanine deck (`WALL_H`) puts debris in the same place, and its roof is
at `WALL_H * 2` — over twice the old lid — so both were quietly on the wrong side of it too.

### Destruction (`destruction.js` + `gen/geom.js` + `physics.js`)
Everything on a floor can be destroyed: all furniture, the window glazing, and the ceiling
tubes. Only the shell — walls, floor, ceiling slab — is permanent, because the generator's
connectivity and sealing invariants are proved once at generation and nothing re-proves them
at runtime.

One prop is destroyed and yet still there: the generator leaves a **wreck** (see the plant
room below). It is the exception that proves the rule rather than a hole in it — a wreck
keeps its collider and its nav tiles, so the floor it occupies was never given back and
nothing about connectivity changed.

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
