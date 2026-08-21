import { State } from '../core/GameManager.js';
import { buildPools, TYPES, TIER_TUNING, SPAWN_Y } from './obstacleTypes.js';
import { REST, REST_INTERVAL_MIN, REST_INTERVAL_SPAN, selectPattern } from './patterns.js';

/**
 * ARCHITECTURE: Obstacle lifecycle
 * Decision: this module owns the obstacle pool, the pattern scheduler, obstacle motion,
 *   collision, graze detection and despawn. It reports impacts and near-misses on the bus
 *   and does not end the game or change the score itself.
 * Reason: Ownership Map gives it the obstacle lifecycle, and Principle II gives GameManager
 *   the only mutation entry point. Calling `game.gameOver()` from here would work today and
 *   would be the seam that rots first — every module that ever kills the player would grow
 *   its own opinion about what death means (score submission, ad breaks, revive prompts).
 *   The graze bonus follows the same rule for the same reason: this file decides that a pass
 *   *was* a near miss, GameManager decides what a near miss is worth.
 * Trade-off: one extra hop between detection and reaction, and the transition lands
 *   mid-update rather than at a frame boundary. Both are synchronous, so nothing observes a
 *   torn state.
 * If obstacles pass straight through the car, check in this order: 1) the hitbox shrink
 *   constants in obstacleTypes.js, 2) COLLISION_WINDOW — a slow frame can carry an obstacle
 *   across the whole window in one step and skip the test entirely, 3) the dt clamp in
 *   main.js, which exists precisely to bound that jump, 4) `record.solid`, which a pulse
 *   gate turns off on purpose.
 */

/**
 * ARCHITECTURE: Obstacle pooling
 * Decision: every mesh this module will ever show is built and added to the scene by
 *   buildPools() at construction. Spawning takes a record off a free list, reconfigures it
 *   and flips `visible`; despawning flips it back and returns the record. After the
 *   constructor returns, the obstacle path never calls `scene.add`, `scene.remove` or `new`.
 * Reason: Principle III. The pre-pool version allocated a BoxGeometry, an EdgesGeometry, two
 *   materials, a Mesh and a LineSegments *per spawn*, and dropped the lot on the GC at
 *   despawn — textbook uncontrolled object creation, buying a GC pause at an unpredictable
 *   moment, which on mobile is a dropped frame in the middle of a dodge. S6 multiplies the
 *   spawn rate several times over, so the discipline matters more now, not less.
 * Trade-off: a fixed ceiling on simultaneous obstacles. Exhausting a pool skips the spawn
 *   rather than growing it. A missing obstacle is a cosmetic hiccup; an allocation mid-frame
 *   is the defect this design exists to prevent.
 * If obstacles stop appearing, check the pool-exhaustion warning in the console before
 *   looking anywhere else: it names the type whose `pool` count in obstacleTypes.js is now
 *   too small, which is exactly what adding a denser pattern would cause.
 */

const SPAWN_Z = -200;           // just beyond the fog, so obstacles fade in
const DESPAWN_Z = 20;           // safely behind the camera
const COLLISION_WINDOW = 10;    // only test obstacles within ±this of the car
const CAR_HITBOX_SHRINK = 0.4;  // forgiving: the player's box is smaller than the car

/**
 * How much clear air still counts as a near miss, in world units between the two shrunk
 * boxes. Both boxes are already generous — the car gives up 0.4 a side and every obstacle
 * 0.2 — so 1.2 units of *measured* gap is well under a car's width of real clearance. Wide
 * enough that a deliberate tight line is rewarded, narrow enough that a lane-and-a-half pass
 * is not.
 */
const GRAZE_MARGIN = 1.2;

/**
 * What a contact turned out to be. Three outcomes rather than the boolean this used to return,
 * because a shielded hit is neither "nothing happened" nor "the run is over" — it is an
 * obstacle that has to leave the road immediately, and the caller is the only place that knows
 * the index needed to retire it.
 */
const CONTACT_NONE = 0;
const CONTACT_FATAL = 1;
const CONTACT_ABSORBED = 2;

/**
 * ARCHITECTURE: Analytic collision
 * Decision: compare cached half-extents on the X and Z axes with subtractions and
 *   comparisons. No Box3, no y axis, nothing allocated, nothing traversed.
 * Reason: Principle III. `Box3.setFromObject` allocated nothing per call (the boxes were
 *   scratch fields) but *walked the car's entire mesh hierarchy* every frame — ~20 meshes,
 *   each transforming 8 corners — to recompute a shape that only ever translates along x.
 * Trade-off: the car's box no longer grows when the car banks, which makes mid-turn
 *   collisions marginally more forgiving and nothing else. A hitbox that inflates when the
 *   *model* leans is a rendering artefact leaking into physics.
 * Dropping the y axis is exact, not an approximation, and S6 keeps it that way deliberately:
 *   every type in obstacleTypes.js sits at SPAWN_Y = -0.5 and is at least 2 units tall, so
 *   its shrunk box spans at worst y -1.3..0.3, while the car's spans -0.60..-0.15 — strictly
 *   inside, in every state. The y axis can never be the separating one, so testing it can
 *   never change an answer. A flying or ground-hugging type would kill this assumption and
 *   bring y back; none of the eight is one.
 *
 * Gaps are returned rather than a boolean because the graze test needs the distance, not the
 * verdict — computing the overlap twice at two margins would double the work for a number
 * this already has.
 */
const gapOn = (a, b, halfA, halfB) => Math.abs(a - b) - halfA - halfB;

/** Returns a mesh to its own free list. The record carries the list, so this is O(1). */
const release = (record) => {
  record.mesh.visible = false;
  record.pool.push(record);
};

/**
 * ADR (Principle III / measured, not guessed): pool sizes live on each row of TYPES and were
 * measured, not chosen. S2 sized every pool at 8 against a peak of *two* live obstacles,
 * calling the rest headroom for exactly this step. That headroom is now spent, so the
 * numbers were re-derived by replaying the real scheduler over 20,000 simulated patterns at
 * tier 5 — the densest configuration the game can reach, since it unlocks every pattern and
 * uses the 95-unit gap floor — and recording peak concurrent records per type.
 *
 * Measured peaks, then the size in force:
 *   block 3→6, barricade 2→5, gate 4→8, slider 3→6, splitter 4→8, pulse 4→8, hunter 3→6,
 *   roller 1→4. 51 meshes total, down from S2's flat 8-per-type extrapolated to 64.
 *
 * The margin is peak + 3, rounded up to even for the types that spawn in pairs so no record
 * is stranded without a partner. Three is not a ratio pulled from the air: the largest group
 * a single step can claim is 2, so peak + 3 absorbs one whole extra spawn group plus one,
 * which is the realistic worst case for a pattern added later. Being wrong upward costs a
 * handful of invisible meshes — `visible = false` prunes them from the render walk entirely,
 * so an idle pool costs memory and nothing else. Being wrong downward trips the console
 * warning below, loudly, once.
 *
 * The peak is larger than the naive "steps per pattern" count for two reasons worth knowing
 * before re-tuning: a pattern's tail is still on the road while the next one's head spawns
 * (the live corridor is 220 units and the shortest pattern-plus-gap at tier 5 is 375, so two
 * patterns overlap routinely), and gate/pulse/splitter each consume two records per step.
 */

export class ObstacleManager {
  #bus;
  #pools;
  #active = [];
  #warned = new Set();

  // Scheduler state. `#cursor` is world units travelled since the current pattern's z origin;
  // every step and the hand-off to the next pattern are comparisons against it.
  #pattern = REST;
  #stepIndex = 0;
  #cursor = 0;
  #lastId = null;
  #untilRest = REST_INTERVAL_MIN;

  // The car's scene node and its pre-shrunk hitbox, resolved once. Held rather than passed
  // per frame because the hitbox has to be cached somewhere, and caching it here keeps the
  // forgiveness constants in the file that tunes collision feel.
  #carObject;
  #carHalfX;
  #carHalfZ;
  #carOffsetX;
  #carOffsetZ;

  constructor(scene, bus, player) {
    this.#bus = bus;
    this.#pools = buildPools(scene);

    const { halfX, halfZ, offsetX, offsetZ } = player.hitbox;
    this.#carObject = player.object3d;
    this.#carHalfX = halfX - CAR_HITBOX_SHRINK;
    this.#carHalfZ = halfZ - CAR_HITBOX_SHRINK;
    this.#carOffsetX = offsetX;
    this.#carOffsetZ = offsetZ;

    bus.on('stateChanged', ({ from, to }) => {
      // A resume enters PLAYING too, and reset() returns every live obstacle to the pool —
      // unpausing would clear the road the player was in the middle of dodging.
      if (to === State.PLAYING && from !== State.PAUSED) this.reset();
    });
  }

  /**
   * S2 deliberately preserved a quirk here — the spawn timer carried across runs, so run
   * two's first obstacle arrived on run one's clock — because the S1 gate was "behaves
   * identically". That timer no longer exists: S6 replaced the random spawner it belonged
   * to, so there is nothing left to preserve and the schedule is reset outright. Every run
   * now opens on a rest beat and a fresh pattern, which is also the fair thing to do.
   */
  reset() {
    for (let i = 0; i < this.#active.length; i++) release(this.#active[i]);
    this.#active.length = 0;
    this.#pattern = REST;
    this.#stepIndex = 0;
    this.#cursor = 0;
    this.#lastId = null;
    this.#untilRest = REST_INTERVAL_MIN;
  }

  update(dt, game) {
    if (game.state !== State.PLAYING) return;

    const tuning = TIER_TUNING[game.tier];
    const { moveDist } = game;

    // Resolved once per frame, not once per obstacle — the car cannot move between two tests
    // in the same frame, and the drones all chase the same number.
    const carX = this.#carObject.position.x + this.#carOffsetX;
    const carZ = this.#carObject.position.z + this.#carOffsetZ;

    // Resolved once per frame, not per obstacle, and read rather than reasoned about: this
    // module asks the state owner whether an impact would be survived and never asks *why*.
    // Which power-up is paying, and what it costs, stays entirely in GameManager (Principle II).
    if (this.#advance(dt, moveDist, tuning, carX, carZ, game.invulnerable)) return; // crashed: hold the frame

    this.#schedule(dt, moveDist, game.tier, tuning, carZ);
  }

  /**
   * Moves, animates and tests every live obstacle. Returns true if this frame killed the
   * player, in which case the caller stops — the remaining obstacles hold position and
   * nothing new is scheduled onto a road the run has already left.
   */
  #advance(dt, moveDist, tuning, carX, carZ, invulnerable) {
    for (let i = this.#active.length - 1; i >= 0; i--) {
      const record = this.#active[i];
      const { position } = record.mesh;

      // Per-record rather than the frame's flat moveDist: a roller closes at 1.3x, and its
      // own accumulated distance is what drives a splitter's opening, so both have to be
      // scaled by the same factor to stay consistent with each other.
      const travel = moveDist * record.zRate;
      position.z += travel;
      record.age += dt;
      record.dist += travel;
      if (record.behavior) record.behavior(record, dt, tuning, carX);

      if (position.z > -COLLISION_WINDOW && position.z < COLLISION_WINDOW) {
        const contact = this.#resolveContact(record, position, carX, carZ, invulnerable);
        if (contact === CONTACT_FATAL) return true;
        // Retired on the spot rather than ghosted and left to drift past. Vanishing on contact
        // is both the honest read — the shield destroyed it — and the fix for the alternative,
        // which is a solid block visibly clipping through the car for the rest of its flight.
        if (contact === CONTACT_ABSORBED) { this.#retire(i); continue; }
      }

      if (position.z > DESPAWN_Z) this.#retire(i);
    }

    return false;
  }

  /**
   * The hit and the near miss, in one pass. Returns true on a crash.
   *
   * A graze is resolved on the *exit* rather than the approach, and that ordering is the
   * whole design: the question "did that obstacle go past without hitting me" cannot be
   * answered while it is still alongside. Tracking the tightest x-gap seen during the overlap
   * and reading it once the obstacle clears the car's tail means a hit can never also pay a
   * graze bonus (a hit ends the run before the exit ever happens), and one flag caps the
   * award at one per obstacle, so idling alongside a long wall cannot farm it.
   */
  #resolveContact(record, position, carX, carZ, invulnerable) {
    const gapZ = gapOn(carZ, position.z, this.#carHalfZ, record.halfZ);

    // A ghosted pulse gate is scenery: no hit, and no near miss either — you cannot narrowly
    // avoid something you drove through.
    if (gapZ < 0 && record.solid) {
      const gapX = gapOn(carX, position.x, this.#carHalfX, record.halfX);
      if (gapX < 0) {
        if (invulnerable) {
          // No payload: nothing downstream needs the impact point, and `crashed` clones its
          // position for a camera shake that this event deliberately does not trigger. Left
          // bare, an absorbed hit costs zero allocation — which matters, because hyperdrive
          // can produce a run of them where a crash produces exactly one per run.
          this.#bus.emit('impactAbsorbed');
          return CONTACT_ABSORBED;
        }
        this.#bus.emit('crashed', { position: position.clone() });
        return CONTACT_FATAL;
      }
      if (gapX < record.minGapX) record.minGapX = gapX;
      return CONTACT_NONE;
    }

    if (!record.grazed && record.minGapX <= GRAZE_MARGIN && position.z > carZ) {
      record.grazed = true;
      this.#bus.emit('grazed', { gap: record.minGapX });
    }

    return CONTACT_NONE;
  }

  /**
   * Swap-and-pop rather than splice: `splice(i, 1)` returns a new array of the removed
   * elements, which is a per-frame allocation for a value nobody reads. Safe backwards —
   * index i is overwritten with the tail, which this loop has already visited.
   */
  #retire(index) {
    release(this.#active[index]);
    this.#active[index] = this.#active[this.#active.length - 1];
    this.#active.length--;
  }

  /**
   * Walks the current pattern's cursor forward and hands off to the next pattern once the
   * tail plus the tier's gap has cleared the spawn line.
   *
   * Runs *after* the movement loop so a step lands at exactly SPAWN_Z plus however far past
   * the line the cursor overshot this frame. Spawning first and letting the loop move the new
   * record would advance it by an extra frame — up to 7 units at tier 5 — and the whole point
   * of carrying the overshoot is that pattern spacing must not drift with frame rate.
   */
  #schedule(dt, moveDist, tier, tuning, carZ) {
    this.#cursor += moveDist;

    const span = this.#pattern.length + tuning.gap;
    if (this.#cursor >= span) {
      this.#cursor -= span;   // carry the overshoot rather than zeroing it
      this.#nextPattern(tier);
    }

    // World units per second, taken from the frame rather than re-deriving GameManager's
    // DISTANCE_PER_SPEED_UNIT here — one copy of that multiplier, in the module that owns it.
    const worldSpeed = dt > 0 ? moveDist / dt : 0;
    const travelTime = worldSpeed > 0 ? (carZ - SPAWN_Z) / worldSpeed : 0;

    const { steps } = this.#pattern;
    while (this.#stepIndex < steps.length && steps[this.#stepIndex].z <= this.#cursor) {
      const step = steps[this.#stepIndex++];
      this.#spawnStep(step, tuning, SPAWN_Z + (this.#cursor - step.z), travelTime);
    }
  }

  /**
   * Announces the pick on the bus so CollectibleManager can lay an orb line down the pattern's
   * audited clear lane. The frozen pattern object is passed by reference and nothing is built
   * for the event — a payload literal here would allocate a few times a second for the life of
   * a run, which is the sort of thing Principle III is actually about.
   *
   * The dependency direction is deliberate: this module owns the schedule and says what it
   * picked; it does not know collectibles exist, and nothing it does here changes if they stop.
   */
  #nextPattern(tier) {
    this.#stepIndex = 0;

    if (this.#untilRest <= 0) {
      // #lastId is left alone across a rest on purpose: a rest is a pause in the music, not a
      // pattern, and letting it launder a repeat would put the same shape either side of it.
      this.#pattern = REST;
      this.#untilRest = REST_INTERVAL_MIN + Math.floor(Math.random() * REST_INTERVAL_SPAN);
      this.#bus.emit('patternStarted', this.#pattern);
      return;
    }

    this.#untilRest--;
    this.#pattern = selectPattern(tier, this.#lastId);
    this.#lastId = this.#pattern.id;
    this.#bus.emit('patternStarted', this.#pattern);
  }

  /**
   * All-or-nothing: a gate with one panel missing is a barricade, and a pulse gate with one
   * half missing is a permanently open door. Checking the whole step against the free list
   * first means a starved pool drops a readable pattern rather than silently corrupting it
   * into an easier one.
   */
  #spawnStep(step, tuning, z, travelTime) {
    const type = TYPES[step.type];
    const pool = this.#pools[step.type];

    if (pool.length < type.pieces) {
      // Never grow the pool here — that reintroduces exactly the mid-frame allocation this
      // design removed. Warn once per type and drop the step instead.
      if (!this.#warned.has(step.type)) {
        this.#warned.add(step.type);
        console.warn(`ObstacleManager: ${step.type} pool exhausted; raise its \`pool\` in obstacleTypes.js`);
      }
      return;
    }

    for (let piece = 0; piece < type.pieces; piece++) {
      const record = pool.pop();

      // Every shared field back to its default before init() writes the ones this type uses.
      // A stale `phase` or `zRate` from the last occupant of this record is the single most
      // likely bug in a pooled system, and it presents as an obstacle that moves strangely
      // once in a while — the worst kind to reproduce.
      record.age = 0;
      record.dist = 0;
      record.zRate = 1;
      record.halfX = record.baseHalfX;
      record.minGapX = Infinity;
      record.grazed = false;
      record.solid = true;
      record.mesh.scale.x = 1;
      record.mesh.position.set(0, SPAWN_Y, z);

      type.init(record, piece, step, tuning, travelTime);
      record.mesh.visible = true;
      this.#active.push(record);
    }
  }
}
