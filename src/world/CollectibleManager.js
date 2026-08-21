import { State } from '../core/GameManager.js';
import { ParticleEmitter } from '../render/ParticleEmitter.js';
import { CRATE_KINDS, SPAWN_Y, TYPES, buildCollectiblePools } from './collectibleTypes.js';
import { CRATE_SAFE } from './patterns.js';

/**
 * ARCHITECTURE: Collectible lifecycle
 * Decision: this module owns the orb and crate pool, where they are placed, their motion, the
 *   magnet's attraction, the pickup test and despawn. It reports pickups on the bus and awards
 *   nothing, activates nothing, and reads no power-up state it does not need.
 * Reason: it is ObstacleManager's twin, and it holds the same line for the same reason
 *   (Principle II). This file decides a collectible *was* collected; GameManager decides what
 *   one is worth and how long a modifier lasts. A crate that called `game.activatePowerup` with
 *   its own duration would put "how long is a shield" in the module that spawns crates.
 * Trade-off: a pickup costs one bus hop and lands mid-update rather than at a frame boundary.
 *   Synchronous, so nothing observes a torn state — the same trade `crashed` and `grazed` make.
 * If orbs never appear, check in this order: 1) the pattern's `orbLane` in patterns.js is null,
 *   which is a deliberate "no lane survives this one" and covers half the table, 2) the
 *   `patternStarted` subscription — ObstacleManager owns the schedule and this module only ever
 *   hears about it, so a pattern change that stops emitting stops orbs silently, 3) pool
 *   exhaustion, which warns once in the console.
 */

/**
 * Both mirrored from ObstacleManager rather than imported from it. They are the same numbers
 * for the same reason — the fog line and a point safely behind the camera — but importing them
 * would mean exporting ObstacleManager's private geometry to make one module's spawn line the
 * other's dependency. Two modules agreeing about where the world starts is not shared state.
 */
const SPAWN_Z = -200;
const DESPAWN_Z = 20;

/** Only test collectibles within ±this of the car. Wider than the obstacle window: a magnet drags them. */
const PICKUP_WINDOW = 14;

/** 3, 4 or 5 orbs, spaced far enough apart to read as a line rather than a cluster. */
const ORB_LINE_MIN = 3;
const ORB_LINE_SPAN = 3;
const ORB_SPACING = 14;

/**
 * How far into the pattern a crate sits. Deliberately not at the head, where the orb line is —
 * two pickups arriving together read as one, and the crate is the one worth noticing. Every
 * pattern that can carry a crate is at least 280 units long and its orbLane is clear for the
 * whole span, so 120 is inside the audited window with room either side.
 */
const CRATE_DEPTH = 120;
const CRATE_INTERVAL_MIN = 25;   // seconds of continuous play
const CRATE_INTERVAL_SPAN = 10;  // …so 25-35s, resolved on the next eligible pattern

/**
 * ADR (Principle III): the magnet is a distance check on active orbs and nothing more. The
 * textbook answer to "find things near a point" is a spatial index, and building one here would
 * be a uniform grid or a quadtree maintained every frame to accelerate a scan of at most 16
 * objects — strictly more work than the scan, plus a structure to keep correct. The orb pool is
 * small *by construction* (see its `pool` size), so the naive loop is not a shortcut, it is the
 * right algorithm at this n.
 *
 * Squared range, so the per-orb test never takes a square root.
 */
const MAGNET_RANGE = 6;
const MAGNET_RANGE_SQ = MAGNET_RANGE * MAGNET_RANGE;
/**
 * Fraction of the remaining distance closed per second. Exponential rather than a fixed speed:
 * an orb at the edge of range drifts in and then accelerates, which reads as attraction, while
 * a constant speed reads as the orb being dragged on a string. Clamped against dt below so a
 * slow frame cannot overshoot the car and fling it out the far side.
 */
const MAGNET_PULL = 5;

/** Mint, matching the orbs. Zero gravity — these are sparks of energy, not debris. */
const SPARKLE = Object.freeze({
  max: 160, color: 0x9effe0, size: 0.26, gravity: 0, drag: 2.6, life: 0.45
});
const SPARKLE_SPEED = Object.freeze([3, 10]);
const ORB_SPARKS = 20;
const CRATE_SPARKS = 60;
const CRATE_SPREAD = 0.9;
const ORB_SPREAD = 0.3;

const laneCentre = (lane) => lane * 3; // LANE_WIDTH, same value obstacleTypes.js lays out against

const release = (record) => {
  record.mesh.visible = false;
  record.pool.push(record);
};

export class CollectibleManager {
  #bus;
  #pools;
  #crateMaterials;
  #sparkle;
  #active = [];
  #warned = new Set();

  #untilCrate = CRATE_INTERVAL_MIN;

  #carObject;
  #carHalfX;
  #carHalfZ;
  #carOffsetX;
  #carOffsetZ;

  constructor(scene, bus, player) {
    this.#bus = bus;

    const built = buildCollectiblePools(scene);
    this.#pools = built.pools;
    this.#crateMaterials = built.crateMaterials;
    this.#sparkle = new ParticleEmitter(scene, SPARKLE);

    // The car's *true* half-extents, unshrunk. ObstacleManager pulls these in by 0.4 a side so
    // a hit feels fair; a pickup wants the opposite, and the collectible's own half already
    // carries the grow (see PICKUP_GROW). Applying a shrink here too would make an orb harder
    // to collect than an obstacle is to hit, which is exactly backwards.
    const { halfX, halfZ, offsetX, offsetZ } = player.hitbox;
    this.#carObject = player.object3d;
    this.#carHalfX = halfX;
    this.#carHalfZ = halfZ;
    this.#carOffsetX = offsetX;
    this.#carOffsetZ = offsetZ;

    bus.on('stateChanged', ({ from, to }) => {
      // A resume enters PLAYING too, and reset() would clear the road of collectibles the
      // player was driving toward — the same exclusion ObstacleManager makes.
      if (to === State.PLAYING && from !== State.PAUSED) this.reset();
    });

    // ObstacleManager owns the pattern schedule and announces each pick; this module reads two
    // fields off the frozen pattern it is handed and never asks for the scheduler itself.
    bus.on('patternStarted', (pattern) => this.#onPatternStarted(pattern));
  }

  reset() {
    for (let i = 0; i < this.#active.length; i++) release(this.#active[i]);
    this.#active.length = 0;
    this.#sparkle.clear();
    // A fresh run should not owe a crate from the last one, and should not open with one either.
    this.#untilCrate = CRATE_INTERVAL_MIN;
  }

  update(dt, game) {
    // Ahead of the state gate: the sparkle from the last pickup of a run should finish burning
    // out over the game-over screen rather than freezing mid-air.
    this.#sparkle.update(dt);
    if (game.state !== State.PLAYING) return;

    this.#untilCrate -= dt;

    const carX = this.#carObject.position.x + this.#carOffsetX;
    const carZ = this.#carObject.position.z + this.#carOffsetZ;
    const magnet = game.powerups.magnet > 0;

    this.#advance(dt, game.moveDist, carX, carZ, magnet);
  }

  #advance(dt, moveDist, carX, carZ, magnet) {
    for (let i = this.#active.length - 1; i >= 0; i--) {
      const record = this.#active[i];
      const { position } = record.mesh;

      position.z += moveDist;
      record.age += dt;
      record.behavior(record, dt);

      if (magnet && record.kind === null) this.#attract(record, dt, carX, carZ);

      if (position.z > -PICKUP_WINDOW && position.z < PICKUP_WINDOW &&
          this.#tryCollect(record, carX, carZ)) {
        this.#retire(i);
        continue;
      }

      if (position.z > DESPAWN_Z) this.#retire(i);
    }
  }

  /**
   * Orbs only — `kind === null` is what an orb is. A magnet that hauled crates in would delete
   * the one decision a crate exists to pose, which is whether the detour is worth it.
   *
   * The y axis is left to the orb's own bob so an attracted orb keeps floating rather than
   * flattening onto the car's plane, and the bob is what makes the arrival read as alive.
   */
  #attract(record, dt, carX, carZ) {
    const { position } = record.mesh;
    const dx = carX - position.x;
    const dz = carZ - position.z;
    if (dx * dx + dz * dz > MAGNET_RANGE_SQ) return;

    // Clamped at 1: a long frame must close at most the whole gap, never more than it.
    const step = Math.min(1, MAGNET_PULL * dt);
    position.x += dx * step;
    position.z += dz * step;
  }

  /**
   * Analytic XZ overlap, the same subtract-and-compare ObstacleManager uses and for the same
   * reason — no Box3, no hierarchy walk, no allocation. Half-extents are a single scalar here
   * because both kinds are radially symmetric about y, so x and z share one number.
   *
   * `collected` makes a second payout impossible by construction rather than by an argument
   * about loop direction. The record is retired on the same frame it pays out, so today the
   * flag is belt-and-braces — but "this record has already been cashed" is a fact about the
   * record, and putting it on the record is what keeps it true if the retire ever moves.
   */
  #tryCollect(record, carX, carZ) {
    if (record.collected) return false;

    const { position } = record.mesh;
    if (Math.abs(carZ - position.z) - this.#carHalfZ - record.half >= 0) return false;
    if (Math.abs(carX - position.x) - this.#carHalfX - record.half >= 0) return false;

    record.collected = true;
    this.#sparkle.emitBurst(
      position,
      record.kind === null ? ORB_SPARKS : CRATE_SPARKS,
      record.kind === null ? ORB_SPREAD : CRATE_SPREAD,
      SPARKLE_SPEED
    );

    if (record.kind === null) this.#bus.emit('orbCollected');
    else this.#bus.emit('powerupFound', { kind: record.kind });

    return true;
  }

  /** Swap-and-pop, for the same no-allocation reason ObstacleManager gives: splice returns an array. */
  #retire(index) {
    release(this.#active[index]);
    this.#active[index] = this.#active[this.#active.length - 1];
    this.#active.length--;
  }

  #onPatternStarted(pattern) {
    if (pattern.orbLane === null) return; // no lane survives this pattern — see the ADR in patterns.js

    const x = laneCentre(pattern.orbLane);
    const count = ORB_LINE_MIN + Math.floor(Math.random() * ORB_LINE_SPAN);
    for (let i = 0; i < count; i++) this.#spawn('orb', x, SPAWN_Z - i * ORB_SPACING, null);

    if (this.#untilCrate > 0 || !CRATE_SAFE.includes(pattern.id)) return;
    this.#untilCrate = CRATE_INTERVAL_MIN + Math.random() * CRATE_INTERVAL_SPAN;
    // Rolled here rather than carried on the pattern: which power-up a crate holds is a
    // property of the crate, and tying it to the pattern would make the table predictable in a
    // way an authored obstacle table is supposed to be and a reward is not.
    this.#spawn('crate', x, SPAWN_Z - CRATE_DEPTH, CRATE_KINDS[Math.floor(Math.random() * CRATE_KINDS.length)]);
  }

  #spawn(id, x, z, kind) {
    const pool = this.#pools[id];
    if (pool.length < TYPES[id].pieces) {
      // Never grow the pool — that reintroduces the mid-frame allocation this design removes.
      if (!this.#warned.has(id)) {
        this.#warned.add(id);
        console.warn(`CollectibleManager: ${id} pool exhausted; raise its \`pool\` in collectibleTypes.js`);
      }
      return;
    }

    const record = pool.pop();

    // Every shared field back to a known value before the spawn writes the ones it uses. A
    // stale `kind` from the last occupant is the single most likely bug in a pooled system, and
    // here it would present as an orb that silently hands out a hyperdrive.
    record.age = 0;
    record.collected = false;
    record.kind = kind;
    record.mesh.position.set(x, SPAWN_Y, z);
    record.mesh.rotation.set(0, 0, 0);

    const materials = kind === null ? null : this.#crateMaterials[kind];
    record.mesh.material = materials ? materials.body : record.defaultBody;
    record.mesh.children[0].material = materials ? materials.edge : record.defaultEdge;

    record.mesh.visible = true;
    this.#active.push(record);
  }
}
