import * as THREE from 'three';
import { State } from '../core/GameManager.js';

/**
 * ARCHITECTURE: Obstacle lifecycle
 * Decision: this module owns the obstacle pool, spawning, motion, collision and
 *   despawn. It reports an impact on the bus and does not end the game itself.
 * Reason: Ownership Map gives it the obstacle lifecycle, and Principle II gives
 *   GameManager the only mutation entry point. Calling `game.gameOver()` from here
 *   would work today and would be the seam that rots first — every module that
 *   ever kills the player would grow its own opinion about what death means
 *   (score submission, ad breaks, revive prompts). Emitting `crashed` keeps that
 *   decision in one place.
 * Trade-off: one extra hop between detection and reaction, and the transition now
 *   lands mid-update rather than at a frame boundary. Both are synchronous, so
 *   nothing observes a torn state.
 * If obstacles pass straight through the car, check in this order: 1) the hitbox
 *   shrink constants below, 2) COLLISION_WINDOW — a slow frame can carry an
 *   obstacle across the whole window in one step and skip the test entirely,
 *   3) the dt clamp in main.js, which exists precisely to bound that jump.
 */

/**
 * ARCHITECTURE: Obstacle pooling
 * Decision: every mesh this module will ever show is built and added to the scene
 *   in the constructor. Spawning takes a record off a free list, repositions it and
 *   flips `visible`; despawning flips it back and returns the record. After the
 *   constructor returns, this file never calls `scene.add`, `scene.remove`, or
 *   `new` on a per-frame path again.
 * Reason: Principle III. The previous version allocated a BoxGeometry, an
 *   EdgesGeometry, two materials, a Mesh and a LineSegments *per spawn* — roughly
 *   one full mesh graph every second of play — and dropped the whole lot on the GC
 *   at despawn. That is textbook uncontrolled object creation/destruction, and it
 *   buys a GC pause at an unpredictable moment, which on mobile is a dropped frame
 *   in the middle of a dodge.
 * Trade-off: a fixed ceiling on simultaneous obstacles. Exhausting the pool skips
 *   the spawn rather than growing it — see #spawn(). A missing obstacle is a
 *   cosmetic hiccup; an allocation mid-frame is the defect this step exists to fix.
 * If obstacles stop appearing, check the pool-exhaustion warning in the console
 *   before looking anywhere else: it means POOL_SIZE_PER_TYPE is now too small for
 *   the spawn rate, which is exactly what a difficulty-tuning change would cause.
 */

const LANE_WIDTH = 3;
const LANE_COUNT = 5;           // lanes -2..2
const WALL_CHANCE = 0.8;        // Math.random() above this spawns a wide wall (~20%)
const SPAWN_Z = -200;           // just beyond the fog, so obstacles fade in
const SPAWN_Y = -0.5;           // every obstacle sits in the same height band as the car
const DESPAWN_Z = 20;           // safely behind the camera
const COLLISION_WINDOW = 10;    // only bounds-test obstacles within ±this of the car
const MIN_SPAWN_DELAY = 0.3;
const SPAWN_DELAY_BASE = 1.5;
const SPAWN_DELAY_PER_SPEED = 0.2;
const CAR_HITBOX_SHRINK = 0.4;  // forgiving: the player's box is smaller than the car
// Must stay under 0.5 — that is the wall's half-depth, and a shrink past it drives
// halfZ negative, which silently makes walls impossible to hit rather than erroring.
const OBSTACLE_HITBOX_SHRINK = 0.2;

/**
 * Measured, not guessed: replaying the spawn/despawn arithmetic above over ten
 * minutes of play peaks at *two* live obstacles, and it peaks at the start of a run
 * (speed ~1.03), not at the end — the spawn delay floors out at 0.3s while travel
 * time keeps shrinking with speed, so the field gets emptier as the run gets faster.
 * Eight per type is 4x that peak. The headroom is for Blueprint Phase 3's patterns,
 * which will spawn several obstacles in one tick; the cost of being wrong in this
 * direction is 16 invisible meshes, and `visible = false` prunes them from the
 * render walk entirely, so an idle pool costs memory and nothing else.
 */
const POOL_SIZE_PER_TYPE = 8;

// The two shapes the game ships. Kept as data because every pool is built the same
// way; adding a third type is a row here, not another branch in #spawn().
const OBSTACLE_TYPES = [
  { width: 2, height: 2, depth: 2 }, // block
  { width: 8, height: 2, depth: 1 }  // wide wall
];

/**
 * ARCHITECTURE: Analytic collision
 * Decision: compare cached half-extents on the X and Z axes with four subtractions
 *   and two comparisons. No Box3, no y axis, nothing allocated, nothing traversed.
 * Reason: Principle III. `Box3.setFromObject` allocated nothing per call here (the
 *   boxes were scratch fields) but it *walked the car's entire mesh hierarchy* every
 *   frame — ~20 meshes, each transforming 8 corners — to recompute a shape that only
 *   ever translates along x.
 * Trade-off: the car's box no longer grows when the car banks. Measured, the old
 *   per-frame box at full lean (roll 0.3, yaw 0.1) spanned x -1.400..1.145 where the
 *   fixed box spans ±1.06 — so a hard turn used to widen the hitbox by up to 0.34
 *   units on the leading side. Fixed extents are the standard choice precisely
 *   because a hitbox that inflates when the *model* leans is a rendering artefact
 *   leaking into physics; the change makes mid-turn collisions marginally more
 *   forgiving and nothing else. Rejected the alternative — rebuilding the rotated
 *   AABB analytically each frame — as paying real complexity to preserve a quirk.
 * Dropping the y axis is exact, not an approximation: every obstacle's shrunk box
 *   spans y -1.30..0.30 and the car's spans -0.60..-0.15, strictly inside it, in
 *   every state. The y axis can never be the separating one, so testing it can
 *   never change an answer. If obstacles ever leave that height band — a Phase 3
 *   flying or ground-hugging type — this assumption dies and y comes back.
 */
const overlapsXZ = (px, pz, phx, phz, ox, oz, ohx, ohz) =>
  Math.abs(px - ox) < phx + ohx && Math.abs(pz - oz) < phz + ohz;

/** Returns a mesh to its own free list. The record carries the list, so this is O(1). */
const release = (record) => {
  record.mesh.visible = false;
  record.pool.push(record);
};

/**
 * Builds one type's worth of meshes and adds them to the scene once and for all.
 * Geometry and the edge outline are shared across the whole pool — the meshes only
 * ever differ by transform, so one BufferGeometry each is all the GPU needs.
 */
const buildPool = (scene, { width, height, depth }, body, edge) => {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const edges = new THREE.EdgesGeometry(geometry); // red neon outline — the "danger" read
  const pool = [];

  for (let i = 0; i < POOL_SIZE_PER_TYPE; i++) {
    const mesh = new THREE.Mesh(geometry, body);
    mesh.add(new THREE.LineSegments(edges, edge));
    mesh.position.set(0, SPAWN_Y, SPAWN_Z);
    mesh.visible = false;
    scene.add(mesh); // the only scene.add in this file, and it runs POOL_SIZE times total

    // Half-extents are a property of the *type*, not the instance: obstacles only
    // ever translate along z, so these are correct for the mesh's whole lifetime.
    // The shrink is baked in here so the per-frame test is pure comparison.
    pool.push({
      mesh,
      pool,
      halfX: width / 2 - OBSTACLE_HITBOX_SHRINK,
      halfZ: depth / 2 - OBSTACLE_HITBOX_SHRINK
    });
  }

  return pool;
};

export class ObstacleManager {
  #bus;
  #pools = [];      // one free list per entry in OBSTACLE_TYPES
  #active = [];
  #spawnTimer = 0;
  #warnedExhausted = false;

  // The car's scene node and its pre-shrunk hitbox, resolved once. Held rather than
  // passed per frame because the hitbox has to be cached somewhere, and caching it
  // here keeps both forgiveness constants in the file that tunes collision feel.
  #carObject;
  #carHalfX;
  #carHalfZ;
  #carOffsetX;
  #carOffsetZ;

  constructor(scene, bus, player) {
    this.#bus = bus;

    const { halfX, halfZ, offsetX, offsetZ } = player.hitbox;
    this.#carObject = player.object3d;
    this.#carHalfX = halfX - CAR_HITBOX_SHRINK;
    this.#carHalfZ = halfZ - CAR_HITBOX_SHRINK;
    this.#carOffsetX = offsetX;
    this.#carOffsetZ = offsetZ;

    // One material pair for every obstacle in the game. The old code built a fresh
    // pair per spawn from identical arguments, so sharing them is pixel-identical
    // and costs the renderer one state change instead of one per mesh.
    const body = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.5 });
    const edge = new THREE.LineBasicMaterial({ color: 0xff0044, linewidth: 2 });

    for (const type of OBSTACLE_TYPES) this.#pools.push(buildPool(scene, type, body, edge));

    bus.on('stateChanged', ({ from, to }) => {
      // A resume enters PLAYING too, and reset() returns every live obstacle to the
      // pool — unpausing would clear the road the player was in the middle of dodging.
      if (to === State.PLAYING && from !== State.PAUSED) this.reset();
    });
  }

  reset() {
    for (let i = 0; i < this.#active.length; i++) release(this.#active[i]);
    this.#active.length = 0;
    // #spawnTimer is deliberately NOT cleared: it only advances while playing, so it
    // carries the crash frame's value into the next run and the first obstacle of
    // run two arrives on run one's clock. That is the shipped behaviour and the S1
    // gate is "identical", so it is preserved rather than quietly corrected.
  }

  update(dt, game) {
    if (game.state !== State.PLAYING) return;

    this.#spawnTimer += dt;
    const spawnDelay = Math.max(MIN_SPAWN_DELAY, SPAWN_DELAY_BASE - game.speed * SPAWN_DELAY_PER_SPEED);
    if (this.#spawnTimer > spawnDelay) {
      this.#spawn();
      this.#spawnTimer = 0;
    }

    // Resolved once per frame, not once per obstacle — the car cannot move between
    // two tests in the same frame.
    const carX = this.#carObject.position.x + this.#carOffsetX;
    const carZ = this.#carObject.position.z + this.#carOffsetZ;
    const { moveDist } = game;

    for (let i = this.#active.length - 1; i >= 0; i--) {
      const record = this.#active[i];
      const { position } = record.mesh;
      position.z += moveDist;

      if (position.z > -COLLISION_WINDOW && position.z < COLLISION_WINDOW &&
          overlapsXZ(carX, carZ, this.#carHalfX, this.#carHalfZ,
            position.x, position.z, record.halfX, record.halfZ)) {
        this.#bus.emit('crashed', { position: position.clone() });
        break; // remaining obstacles hold position this frame, exactly as before
      }

      if (position.z > DESPAWN_Z) this.#retire(i);
    }
  }

  /**
   * Swap-and-pop rather than splice: `splice(i, 1)` returns a new array of the
   * removed elements, which is a per-frame allocation for a value nobody reads.
   * Safe backwards — index i is overwritten with the tail, which this loop has
   * already visited.
   */
  #retire(index) {
    release(this.#active[index]);
    this.#active[index] = this.#active[this.#active.length - 1];
    this.#active.length--;
  }

  #spawn() {
    // RNG call order preserved from the pre-pool version: lane first, then shape.
    const lane = Math.floor(Math.random() * LANE_COUNT) - 2;
    const isWall = Math.random() > WALL_CHANCE;
    const pool = this.#pools[isWall ? 1 : 0];

    const record = pool.pop();
    if (!record) {
      // Never grow the pool here — that would reintroduce exactly the mid-frame
      // allocation this design removed. Warn once and drop the spawn instead.
      if (!this.#warnedExhausted) {
        console.warn(`ObstacleManager: ${isWall ? 'wall' : 'block'} pool exhausted; raise POOL_SIZE_PER_TYPE`);
        this.#warnedExhausted = true;
      }
      return;
    }

    record.mesh.position.set(lane * LANE_WIDTH, SPAWN_Y, SPAWN_Z);
    record.mesh.visible = true;
    this.#active.push(record);
  }
}
