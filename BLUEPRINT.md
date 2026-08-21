# Space Racer — Enterprise Blueprint

**Status:** Approved for planning, not yet implemented
**Governs under:** `CONSTITUTION.md` v1.0.0
**Source:** Derived from the Antigravity CLI roadmap
(`~/.gemini/antigravity-cli/brain/e053024c-5276-4f9a-9d61-24b3197dd958/enterprise_roadmap.md`, 2026-07-11)
**Current codebase:** `main.js` (405 lines, global-variable state), `game.html`, `style.css` — no modules, no build-time asset pipeline

This document sequences the roadmap into gated phases. Each phase lists
concrete file targets, the Constitution principle it serves, and the exit
criteria that must hold before the next phase starts. No implementation
work is authorized by this document alone — each phase still needs its own
explicit go-ahead.

---

## Phase 0 — Baseline (reference only, no action)

Verified against current `main.js`:

| Concern | Location |
|---|---|
| `createCar()` | `main.js:85` |
| `createObstacle()` definition | `main.js:220` |
| Obstacle full-clear on restart | `main.js:280` |
| Obstacle spawn call site | `main.js:343` |
| Obstacle despawn (`scene.remove(ob)`) | `main.js:369` |

These are the seams the roadmap flags as the highest-leverage refactor
targets — object creation/destruction with no pooling, and a monolithic
file mixing state, rendering, and input.

---

## Phase 1 — Architectural Foundation
**Serves:** Principle I (Modular Ownership), Principle II (Single Source of
Truth), Principle III (Performance)

1. Split `main.js` into the modules defined in the Constitution's Ownership
   Map: `GameManager`, `PlayerCar`, `Environment`, `ObstacleManager`,
   `InputHandler`.
2. Replace scattered globals (`let speed`, `let isGameOver`, etc.) with
   `GameManager` as the sole state owner — a state machine covering
   Menu → Playing → Paused → Game Over.
3. Introduce an `ObstacleManager` object pool to replace the
   create/destroy pattern at `main.js:220`, `:343`, `:369` — recycle
   meshes instead of allocating and garbage-collecting them every spawn.
4. (Decision needed, not assumed): TypeScript migration — evaluate
   separately once modules exist, since it changes the build pipeline.
   Do not bundle this into the same PR as the module split.

**Exit criteria:** game behaves identically to current build, verified by
manual playtest, with state and obstacle lifecycle each owned by exactly
one module.

---

## Phase 2 — Rendering & Audio Polish
**Serves:** Principle III (Performance — pipeline must stay within frame
budget), ownership boundary for `RenderPipeline` and `AssetManager`

1. Add `RenderPipeline` module wrapping `EffectComposer` with
   `UnrealBloomPass` (currently only referenced in a comment, never
   implemented) and `SMAAPass`; optional chromatic aberration pass.
2. Add `AssetManager` using `THREE.LoadingManager` to preload `.glb`/`.gltf`
   models that will replace the primitive geometry in `createCar()`
   (`main.js:85`), with a loading-progress UI.
3. Particle emitters (thruster exhaust, graze sparks, crash shatter) — own
   module or folded into `Environment`/`PlayerCar` per the Ownership Map,
   not a new global.
4. Web Audio integration: background track, UI sounds, engine pitch tied
   to `speed` — owned by a new `AudioManager`, added to the Ownership Map
   before implementation starts.

**Exit criteria:** visuals/audio land without regressing the 60 FPS target
(Principle III) on the lowest-spec device tested.

---

## Phase 3 — Retention Mechanics
**Serves:** Principle I, Principle II — new state (currency, unlocks) must
still route through `GameManager`/`PersistenceService`, not new globals

1. Currency/collectible spawn logic — reuses `ObstacleManager`'s pooling
   pattern rather than inventing a second one.
2. Garage/customization UI — reads/writes through `PersistenceService`
   only.
3. Power-ups (Shield, Magnet, Hyperdrive) as timed modifiers on
   `PlayerCar`, dispatched by `GameManager`.
4. Dynamic environment shifts (color/grid/curves by score threshold) —
   owned by `Environment`, triggered by `GameManager` state, not polled
   independently.

**Exit criteria:** none of the above introduces a second source of truth
for score, currency, or active power-up state.

---

## Phase 4 — Monetization
**Serves:** Principle VI (monetization never degrades the core loop),
Principle VII (security)

1. `MonetizationService` behind an interface `GameManager` calls into —
   per the Ownership Map, the dependency direction is one-way.
2. Web game SDK integration (Poki/CrazyGames) for rewarded video.
3. If self-hosted: payment gateway (Stripe/Xsolla) for skins/currency
   packs — **no payment credentials in client code** (Principle VII, hard
   gate).
4. Leaderboard backend (Firebase/Supabase/AWS) — this is the first feature
   requiring a network-facing backend; needs its own security review
   before Phase 4 is marked complete, not deferred to Phase 5.

**Exit criteria:** disabling `MonetizationService` entirely still leaves a
fully playable game — proves the one-way dependency held.

---

## Phase 5 — Build, Security & Distribution
**Serves:** Principle VII (ship blockers), Principle III (performance on
real devices)

1. Vite build config: minification + obfuscation (e.g.
   `javascript-obfuscator`) for public releases.
2. Texture compression (KTX2); dynamic `renderer.setPixelRatio()` scaling
   by measured device performance.
3. Confirm custom rendering logic doesn't override Three.js's automatic
   frustum culling.
4. PWA: `manifest.json` + service worker for install-to-home-screen /
   offline play.

**Exit criteria:** production build passes a security review (no exposed
secrets, obfuscation verified) and hits 60 FPS on the target low-end
device.

---

## Sequencing Notes

- Phases are gated, not parallel-safe by default: Phase 1 must land before
  2–5 because every later phase assumes the module boundaries and state
  machine exist.
- Phases 2 and 3 can run concurrently once Phase 1 is done, since they
  touch disjoint modules (`RenderPipeline`/`AssetManager` vs. gameplay
  state) — but both must respect the Ownership Map before either starts.
- Phase 4 must not start until Phase 1's `GameManager` state machine
  exists — monetization hooks (e.g., "watch ad to continue") are state
  transitions and need a real owner to attach to.
- TypeScript migration (mentioned in the source roadmap under Phase 1) is
  intentionally left as an open decision, not scheduled — it's a build
  pipeline change orthogonal to the module split and deserves its own
  approval.

## Explicitly Out of Scope for This Document

This Blueprint does not authorize writing or modifying `main.js`,
`game.html`, `style.css`, or any new source file. It is a plan artifact
only. Each phase requires a separate, explicit go-ahead before
implementation begins.
