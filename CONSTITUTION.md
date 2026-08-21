# Space Racer — Project Constitution

**Status:** Ratified
**Version:** 1.0.0
**Ratified:** 2026-07-24

## Preamble

This document governs *how decisions get made* as Space Racer moves from
prototype to commercial-grade product. It contains principles and ownership
boundaries only. It does not contain tasks, timelines, or implementation
detail — those live in `BLUEPRINT.md` and must never be back-filled here.
If a proposed edit to this file cites a file/line number, a library version,
or a task, it belongs in the Blueprint instead.

## Core Principles

### I. Modular Ownership
Each module owns exactly one responsibility domain and is the only module
permitted to mutate state within it. No module reaches into another's
internals. Cross-module communication happens through explicit interfaces,
not shared globals.

### II. Single Source of Truth for State
Game state (menu, playing, paused, game-over) has exactly one owner. Any
code that needs to know or change the current state goes through that
owner — never through ad hoc booleans scattered across files.

### III. Performance Is a Feature, Not a Pass
60 FPS on mobile is a requirement, not an aspiration. Changes that
introduce per-frame allocation, uncontrolled object creation/destruction,
or unbounded growth are rejected regardless of how they look in isolation.

### IV. Native-First, Dependency-Minimal
No third-party library earns a place if native platform APIs solve the
same problem in a reasonable amount of code. Every added dependency must
justify itself against the maintenance and bundle-size cost it imposes.

### V. Complete, Surgical Changes
Changes touch only what's broken or in scope. No TODOs, no placeholder
functions, no half-finished features merged "to come back to later."
State the root cause before fixing it.

### VI. Monetization Never Degrades the Core Loop
Ads, IAP, and SDK integrations are additive. If a monetization feature
measurably harms frame rate, input latency, or the core driving feel, the
monetization feature is what gets cut or redesigned — not the game.

### VII. Security & IP Protection Are Ship Blockers
No secrets, API keys, or payment credentials ship in client code. Builds
intended for public release are obfuscated. This is a release gate, not a
nice-to-have.

## Ownership Map

Ownership here means *architectural authority* — which module is allowed
to originate changes to a given concern — not employment or credit.

| Domain | Owning Module | Boundary |
|---|---|---|
| Game state transitions (menu/playing/paused/game-over) | `GameManager` | Only module allowed to write state; all others read-only |
| Player car creation, movement, animation | `PlayerCar` | Owns car mesh, physics response, and input-to-motion mapping |
| Scene environment (grid, stars, lighting, road) | `Environment` | Owns everything ambient/non-interactive in the scene |
| Obstacle lifecycle (spawn, pool, collide, despawn) | `ObstacleManager` | Owns the object pool; no other module creates/destroys obstacle meshes |
| Keyboard/touch input | `InputHandler` | Sole translator from raw device events to game intents |
| Asset loading (models, textures, audio) | `AssetManager` | Owns `THREE.LoadingManager` and all preload sequencing |
| Post-processing (bloom, AA, chromatic aberration) | `RenderPipeline` | Owns `EffectComposer` and pass ordering |
| Monetization (ads, IAP, SDK calls) | `MonetizationService` | Isolated behind an interface `GameManager` calls into — never the reverse |
| Persistence (scores, currency, unlocks) | `PersistenceService` | Sole writer to local storage / backend; nothing else touches save data directly |

## Governance

- This Constitution supersedes ad hoc technical decisions made in
  implementation or planning sessions. Where the Blueprint conflicts with
  a principle here, the Constitution wins and the Blueprint is amended.
- Amendments require an explicit, separate approval — they are not implied
  by approving a Blueprint or a task.
- Version bumps: PATCH for wording clarifications, MINOR for adding a
  principle or ownership entry, MAJOR for removing or redefining one.
- Every architectural decision made downstream (in code or in the
  Blueprint) that trades off against a principle here must be recorded as
  an ADR comment at the point of implementation, citing which principle is
  being weighed.
