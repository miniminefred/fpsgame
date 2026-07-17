# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Alfred — 3D FPS

Browser-based 3D first-person shooter built with **Three.js** (ES modules via CDN import map).
Entire game lives in a single file: `index.html`. No build step, no bundler, no editor —
pure code, edited directly by Claude.

## Why Three.js

Three.js was chosen (June 2026) as the best fit for **pure Claude-based AI development**:
lightweight (~170 KB), code-first with no scene editor required, and backed by by far the
largest ecosystem / documentation corpus of any web 3D engine — which is exactly what makes
it the most reliable target for an AI writing everything by hand.

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
Check if already running; start if not, **always using the project venv** (never `python`
or `pip` directly on the system):
```powershell
.venv\Scripts\python -m http.server 8090
```
Game served at **http://localhost:8090** (port 8090 so it coexists with the blobgame on
8080). Auto-reload is baked into `index.html` — it polls `Last-Modified` every second and
reloads on change.

Then open the browser:
```powershell
Start-Process "http://localhost:8090"
```

> **Never install Python packages system-wide.** All Python tooling must go through `.venv`.
> If a package is missing, install it with `.venv\Scripts\pip install <pkg>`, never bare
> `pip install`.

### 3. Test after every change
Verify in the browser before considering the task done.

## Tech stack

- **Engine:** Three.js (latest, ES modules via jsDelivr import map)
- **Rendering:** WebGL (`THREE.WebGLRenderer`, antialias on)
- **Camera:** `PerspectiveCamera` driven by `PointerLockControls`
- **Input:** Pointer Lock API — click canvas to grab the mouse, `Esc` to release
- **Physics:** hand-rolled (gravity + ground clamp); no physics library yet
- **Assets:** none — geometry and materials are created procedurally in code
- **Server:** `.venv\Scripts\python -m http.server 8090`

## Controls

| Key | Action |
|-----|--------|
| Mouse | Look around (when pointer is locked) |
| W A S D | Move (relative to look direction) |
| Space | Jump |
| Esc | Release the mouse |
| Click | Grab the mouse (lock pointer) |

## World layout

- A large flat ground plane at `y = 0` with a grid helper for spatial reference.
- Player eye height ≈ 1.7 units; spawns a few units back from origin looking forward.
- Sky-blue background, hemisphere + directional lighting.

## Key systems

### Pointer lock
Clicking the canvas requests pointer lock; a centered overlay prompts for the click and
hides while locked. `Esc` (browser default) exits lock and re-shows the overlay.

### Movement
WASD sets a velocity in camera-local space each frame; movement is projected onto the
horizontal plane so looking up/down doesn't change walk speed. Space triggers a jump only
when grounded. Gravity integrates vertical velocity; the player is clamped to eye height
when landing.
