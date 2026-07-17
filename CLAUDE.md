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

## Project layout

```
index.html        Thin entry shell (overlay markup + <script src="/src/main.js">)
vite.config.js    Dev/preview server pinned to port 8090
src/
  main.js         Bootstrap: wires modules, runs the render loop
  scene.js        Renderer, scene, camera, lights, resize handling
  world.js        Static world geometry (ground plane, grid, reference boxes)
  input.js        Keyboard state + pointer-lock overlay wiring
  player.js       Player class: PointerLockControls + movement + jump physics
  style.css       All UI/overlay/crosshair styling
```

## Tech stack

- **Engine:** Three.js (npm `three`)
- **Bundler / dev server:** Vite (`npm run dev` / `npm run build` / `npm run preview`)
- **Rendering:** WebGL (`THREE.WebGLRenderer`, antialias + soft shadow maps)
- **Camera:** `PerspectiveCamera` driven by `PointerLockControls`
- **Input:** Pointer Lock API — click to grab the mouse, `Esc` to release
- **Physics:** hand-rolled (gravity + ground clamp); no physics library yet
- **Assets:** none — geometry and materials are created procedurally in code

## Controls

| Key | Action |
|-----|--------|
| Mouse | Look around (when pointer is locked) |
| W A S D | Move (relative to look direction) |
| Space | Jump |
| Esc | Release the mouse |
| Click | Grab the mouse (lock pointer) |

## Key systems

### Pointer lock (`input.js` + `player.js`)
Clicking the canvas or overlay requests pointer lock; a centered overlay prompts for the
click and hides while locked. `Esc` (browser default) exits lock and re-shows the overlay.

### Movement (`player.js`)
WASD sets a velocity in camera-local space each frame, projected onto the horizontal plane
so pitch doesn't affect walk speed. Space jumps only when grounded. Gravity integrates
vertical velocity; the player is clamped to eye height (1.7) on landing. `dt` is clamped to
50 ms to avoid tunneling on lag spikes.
