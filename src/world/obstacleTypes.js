import * as THREE from 'three';

/**
 * ARCHITECTURE: Obstacle types as data
 * Decision: every obstacle type is a row in TYPES holding its geometry, its colours, how
 *   many pooled records one spawn consumes, a pure `init` that configures a record, and a
 *   pure `behavior` that mutates it per frame. Both are module-scope functions shared by
 *   every record of that type. Nothing here closes over a spawn.
 * Reason: Principle III. The obvious shape for "obstacles that move differently" is a
 *   closure per spawn — `record.move = (dt) => { ... captured lane, amp, phase ... }`.
 *   Obstacles spawn continuously for the whole run, so that is a fresh Function object and
 *   a fresh Context object every few hundred milliseconds, handed to the GC on despawn:
 *   the same uncontrolled-allocation pattern S2 deleted from the mesh path, reintroduced
 *   one level up. Static functions plus per-record scalar fields is the same expressive
 *   power with a fixed object count. It is also how S2's records already worked — data on
 *   the record, static functions consume it — so this is that pattern extended, not a new one.
 * Trade-off: behaviour state lives in flat fields on a record shared by all types, so a
 *   block carries an unused `amp` and a slider carries an unused `dir`. That is deliberate:
 *   one record shape means one hidden class, and a monomorphic per-frame loop. Eight dead
 *   floats per record is cheaper than a polymorphic property lookup 60 times a second.
 * If a new type moves wrongly, check in this order: 1) `#take()` in ObstacleManager resets
 *   the shared fields — a stale `phase` from the last occupant reads as a random offset,
 *   2) `record.age` is advanced by the manager, not by the behaviour, so a behaviour that
 *   increments it again runs at double rate, 3) the half-extents below, which are what
 *   collision uses regardless of what the mesh looks like.
 */

/** Lanes are -2..2, matching Road.js's CELL so a lane boundary lands on a grid line. */
const LANE_WIDTH = 3;

/**
 * Half the full playable span, and it is the *rail* at ±9.5 rather than PlayerCar's ±8
 * origin limit. A "full width" wall that stopped at 8 would leave the car — whose hitbox
 * reaches 8.66 at full lock — able to drive around the outside of it, which is the exact
 * unfair-feeling cheat lane a gate exists to remove. Matches Road.js's RAIL_X so the wall
 * visually lands on the rail instead of floating short of it.
 */
const ROAD_HALF = 9.5;

/** Every obstacle sits in the same height band as the car — see the y-axis note in ObstacleManager. */
export const SPAWN_Y = -0.5;

// Must stay under the thinnest half-depth in the table below (0.5, the panel) — a shrink
// past it drives halfZ negative, which silently makes that type impossible to hit.
const SHRINK = 0.2;

/**
 * ADR (design intent — a pattern must read the same at every tier): the splitter opens over
 * a fixed *distance travelled*, not a fixed number of seconds. The spec's "~1.5s" is what
 * 130 units is at launch speed, so tier 0 is unchanged; the difference is at tier 5, where
 * the world scrolls at ~420 units/sec and the whole flight from the spawn line to the car
 * lasts 0.5s. A 1.5s timer there would still be 30% open on arrival — the splitter would
 * read as one fat block rather than as two, and the pattern that teaches "go through the
 * middle" would be teaching the opposite of what it does. Distance-driven, it is fully open
 * 70 units before the car at every speed the game reaches.
 *
 * Sliders and hunter drones stay time-driven on purpose: their rates are specified in units
 * per second and, unlike the splitter, neither has a completion the player has to see.
 */
const SPLIT_DISTANCE = 130;
/** How far each splitter half travels, in world units — exactly one lane. */
const SPLIT_SPREAD = LANE_WIDTH;

/**
 * Where in its passable window a pulse gate's open half sits when it reaches the car.
 * 1.0 is the instant it opens, 2.0 the instant it shuts; 1.7 means the half the player is
 * meant to take has already been visibly open for 70% of the window by the time they get
 * there. See the fairness ADR on initPulse().
 */
const PULSE_ANCHOR = 1.7;

/** A roller closes on the player faster than the world scrolls — that is its whole threat. */
const ROLLER_Z_RATE = 1.3;
const ROLLER_SPIN = 3.4;   // rad/sec, cosmetic only
const HUNTER_SPIN = 1.8;   // rad/sec about y, cosmetic only

/**
 * Per-tier tuning, indexed by tier directly. `gap` is the inter-pattern breathing room in
 * world units and is the main density dial; the rest scale the types that have a rate.
 * Slider amplitude tops out at exactly LANE_WIDTH so a slider sweeps its own lane plus one
 * either side and never more — the lanes two out stay permanently clear, which is what
 * makes a slider readable rather than a dice roll.
 */
export const TIER_TUNING = Object.freeze([
  Object.freeze({ gap: 220, sliderAmp: 2.4, sliderRate: 1.4, pulseWindow: 1.20, hunterTurn: 1.2 }),
  Object.freeze({ gap: 190, sliderAmp: 2.6, sliderRate: 1.6, pulseWindow: 1.10, hunterTurn: 1.5 }),
  Object.freeze({ gap: 160, sliderAmp: 2.8, sliderRate: 1.8, pulseWindow: 1.00, hunterTurn: 1.8 }),
  Object.freeze({ gap: 130, sliderAmp: 3.0, sliderRate: 2.0, pulseWindow: 0.90, hunterTurn: 2.1 }),
  Object.freeze({ gap: 110, sliderAmp: 3.0, sliderRate: 2.3, pulseWindow: 0.80, hunterTurn: 2.3 }),
  Object.freeze({ gap: 95, sliderAmp: 3.0, sliderRate: 2.6, pulseWindow: 0.70, hunterTurn: 2.5 })
]);

const laneCentre = (lane) => lane * LANE_WIDTH;

/**
 * Stretches a unit-width panel across [fromX, toX]. The panel geometry is 1 unit wide so
 * scale.x *is* the width — no division, and the LineSegments child inherits the stretch, so
 * the outline stays welded to the shape it outlines.
 *
 * This is the one place half-extents become a property of the spawn rather than the type.
 * S2 baked them per type because obstacles only ever translated; a barricade that is two
 * lanes wide in one pattern and three in the next cannot. The per-frame test is unchanged —
 * it still reads two cached numbers off the record.
 */
const spanPanel = (record, fromX, toX) => {
  const width = toX - fromX;
  record.mesh.scale.x = width;
  record.mesh.position.x = (fromX + toX) / 2;
  record.halfX = width / 2 - SHRINK;
};

const initLane = (record, piece, step) => {
  record.mesh.position.x = laneCentre(step.lane);
};

/** `from`/`to` are inclusive lane indices, so a barricade's span is visible in the pattern data. */
const initBarricade = (record, piece, step) => {
  spanPanel(record, laneCentre(step.from) - LANE_WIDTH / 2, laneCentre(step.to) + LANE_WIDTH / 2);
};

/** Two panels, rail to rail, with `step.gap`'s lane left genuinely empty between them. */
const initGate = (record, piece, step) => {
  const edge = laneCentre(step.gap);
  if (piece === 0) spanPanel(record, -ROAD_HALF, edge - LANE_WIDTH / 2);
  else spanPanel(record, edge + LANE_WIDTH / 2, ROAD_HALF);
};

const initSlider = (record, piece, step, tuning) => {
  record.baseX = laneCentre(step.lane);
  record.amp = tuning.sliderAmp;
  record.omega = tuning.sliderRate;
  // Authored, never rolled. The phase decides which way the slider is travelling when the
  // player first sees it, which is the entire read — randomising it would make the same
  // pattern a different puzzle every time, which is the opposite of pattern literacy.
  record.phase = step.phase;
  sweepSlider(record);
};

const initSplitter = (record, piece, step) => {
  record.baseX = laneCentre(step.lane);
  record.dir = piece === 0 ? -1 : 1;
  record.mesh.position.x = record.baseX;
};

const initHunter = (record, piece, step) => {
  record.mesh.position.x = laneCentre(step.lane);
  record.mesh.rotation.y = 0;
};

/** `step.lane` is the *left* lane of the two a roller covers, so it straddles the boundary. */
const initRoller = (record, piece, step) => {
  record.mesh.position.x = laneCentre(step.lane) + LANE_WIDTH / 2;
  record.mesh.rotation.x = 0;
  record.zRate = ROLLER_Z_RATE;
};

/**
 * ADR (design intent — solvable by construction, Principle V): a full-width gate that
 * toggles solid on a free-running clock is unfair by construction. The car has no brake, so
 * a player who arrives during a solid phase had no action available to them at any point —
 * that is death by dice roll, which is the one thing this step is meant not to ship.
 *
 * Two fixes, both taken. First, a pulse gate is two half-width panels in *antiphase*, so
 * exactly one side is solid at any instant and the answer is always "be on the other side" —
 * a lane decision the player owns. Second, the phase is anchored at spawn against the
 * measured travel time so the open half has been visibly open for 70% of its window when the
 * car arrives. At tier 5 that is 0.49s of stable warning; crossing from the far rail to the
 * safe side is 8.5 units at 20 units/sec, or 0.42s. The margin is thin on purpose — this is
 * the hardest type in the game — but it is a margin, not a coin toss.
 *
 * Travel time is computed from the speed at spawn and the speed keeps climbing during the
 * ~1.5s flight. The drift is under 1% of the window, which is why this is arithmetic and not
 * a per-frame re-anchor.
 */
const initPulse = (record, piece, step, tuning, travelTime) => {
  const window = tuning.pulseWindow;
  const period = window * 2;
  if (piece === 0) spanPanel(record, -ROAD_HALF, 0);
  else spanPanel(record, 0, ROAD_HALF);

  record.window = window;
  const openPhase = (((PULSE_ANCHOR * window - travelTime) % period) + period) % period;
  record.phase = piece === step.open ? openPhase : (openPhase + window) % period;
  applyPulse(record, isPulseSolid(record));
};

const sweepSlider = (record) => {
  record.mesh.position.x = record.baseX + record.amp * Math.sin(record.omega * record.age + record.phase);
};

/**
 * Smoothstep rather than linear: the halves ease apart, which reads as a machine opening.
 * A linear slide reads as two blocks drifting, and the moment the player needs to see — the
 * instant it commits to being two lanes — never lands.
 */
const slideSplitter = (record) => {
  const t = Math.min(1, record.dist / SPLIT_DISTANCE);
  record.mesh.position.x = record.baseX + record.dir * SPLIT_SPREAD * t * t * (3 - 2 * t);
};

const trackHunter = (record, dt, tuning, carX) => {
  const limit = tuning.hunterTurn * dt;
  const delta = carX - record.mesh.position.x;
  // Clamped, not lerped: a lerp is fastest when it is furthest away, so a drone would snap
  // to the player's lane the instant it spawned and then look inert. A hard cap on units per
  // second is the promise the player is being asked to read — outrun it sideways.
  record.mesh.position.x += Math.max(-limit, Math.min(limit, delta));
  record.mesh.rotation.y += HUNTER_SPIN * dt;
};

const spinRoller = (record, dt) => {
  record.mesh.rotation.x -= ROLLER_SPIN * dt;
};

const isPulseSolid = (record) => (record.age + record.phase) % (record.window * 2) < record.window;

/** Bright and solid, or a dim ghost you can drive through. Material *references* swap — nothing is built. */
const applyPulse = (record, solid) => {
  record.solid = solid;
  record.mesh.material = solid ? record.solidBody : record.ghostBody;
  record.mesh.children[0].material = solid ? record.solidEdge : record.ghostEdge;
};

const pulsePhase = (record) => {
  const solid = isPulseSolid(record);
  if (solid !== record.solid) applyPulse(record, solid); // only touch materials on an actual flip
};

/**
 * The table. Adding a ninth type is a row here plus a pattern that uses it — no branch in
 * ObstacleManager, which knows only `pieces`, `init` and `behavior`.
 *
 * `pool` sizes are the audited worst case per type plus headroom; the numbers and the method
 * behind them are documented on POOL_HEADROOM in ObstacleManager.
 */
export const TYPES = Object.freeze({
  block: {
    shape: { kind: 'box', w: 2, h: 2, d: 2 },
    body: 0x222222, edge: 0xff0044, pool: 6, pieces: 1,
    init: initLane, behavior: null
  },
  barricade: {
    shape: { kind: 'box', w: 1, h: 2.2, d: 1 },
    body: 0x1d1522, edge: 0xff0044, pool: 5, pieces: 1,
    init: initBarricade, behavior: null
  },
  gate: {
    shape: { kind: 'box', w: 1, h: 2.2, d: 1 },
    body: 0x101a24, edge: 0x00e5ff, pool: 8, pieces: 2,
    init: initGate, behavior: null
  },
  slider: {
    shape: { kind: 'box', w: 2, h: 2, d: 2 },
    body: 0x2a0a24, edge: 0xff00cc, pool: 6, pieces: 1,
    init: initSlider, behavior: sweepSlider
  },
  splitter: {
    shape: { kind: 'box', w: 2.6, h: 2, d: 2 },
    body: 0x2a1a06, edge: 0xff8800, pool: 8, pieces: 2,
    init: initSplitter, behavior: slideSplitter
  },
  pulse: {
    shape: { kind: 'box', w: 1, h: 2.6, d: 1 },
    body: 0x06222a, edge: 0x00e5ff, pool: 8, pieces: 2, ghost: true,
    init: initPulse, behavior: pulsePhase
  },
  hunter: {
    shape: { kind: 'oct', r: 1.3 },
    // An octahedron's widest cross-section is a diamond, and a box drawn round its points
    // would claim area the mesh does not occupy — a hitbox bigger than the thing on screen
    // is how a dodge game earns a reputation for cheating. These are the *inscribed* square's
    // half-extents (r / sqrt(2)), so the box sits inside the silhouette instead of around it.
    half: { x: 0.9, z: 0.9 },
    body: 0x1a2a06, edge: 0xaaff00, pool: 6, pieces: 1,
    init: initHunter, behavior: trackHunter
  },
  roller: {
    shape: { kind: 'cyl', r: 1.2, len: 6 },
    body: 0x14202c, edge: 0x88ccff, pool: 4, pieces: 1,
    init: initRoller, behavior: spinRoller
  }
});

const buildGeometry = ({ kind, w, h, d, r, len }) => {
  if (kind === 'cyl') {
    // Baked into the geometry rather than set on the mesh: with the axis already along world
    // X, "spinning" is `rotation.x`, one number. Rotating the mesh instead would make the
    // spin axis a composed rotation and the roll would wobble as it turned.
    const cylinder = new THREE.CylinderGeometry(r, r, len, 18, 1);
    cylinder.rotateZ(Math.PI / 2);
    return cylinder;
  }
  if (kind === 'oct') return new THREE.OctahedronGeometry(r, 0);
  return new THREE.BoxGeometry(w, h, d);
};

const halfExtents = (type) => {
  if (type.half) return type.half;
  const { kind, w, d, r, len } = type.shape;
  if (kind === 'cyl') {
    // halfZ is the radius, which is exact where it matters: the car's height band straddles
    // the cylinder's own centre line, so the cross-section it meets is the full-width one.
    return { x: len / 2 - SHRINK, z: r - SHRINK };
  }
  return { x: w / 2 - SHRINK, z: d / 2 - SHRINK };
};

/**
 * Builds every mesh the game will ever show, once, and hands back one free list per type.
 * Geometry, body material and edge material are shared across each pool — the meshes differ
 * only by transform, so one upload each is all the GPU needs.
 *
 * The only `scene.add` on the obstacle path, and it runs exactly sum(pool) times at boot.
 */
export const buildPools = (scene) => {
  const pools = {};

  for (const [id, type] of Object.entries(TYPES)) {
    const geometry = buildGeometry(type.shape);
    const edges = new THREE.EdgesGeometry(geometry);
    const body = new THREE.MeshStandardMaterial({ color: type.body, roughness: 0.5, metalness: 0.5 });
    const edge = new THREE.LineBasicMaterial({ color: type.edge, linewidth: 2 });

    // Only the pulse gate needs a second look. Built here so the swap in applyPulse() is a
    // reference assignment on a material that already exists on the GPU.
    const ghostBody = type.ghost
      ? new THREE.MeshStandardMaterial({ color: type.body, roughness: 0.6, metalness: 0.4, transparent: true, opacity: 0.15 })
      : null;
    const ghostEdge = type.ghost
      ? new THREE.LineBasicMaterial({ color: type.edge, transparent: true, opacity: 0.22 })
      : null;

    const half = halfExtents(type);
    const pool = [];

    for (let i = 0; i < type.pool; i++) {
      const mesh = new THREE.Mesh(geometry, body);
      mesh.add(new THREE.LineSegments(edges, edge));
      mesh.position.set(0, SPAWN_Y, 0);
      mesh.visible = false;
      scene.add(mesh);

      // One record shape for every type in the game — see the monomorphism note in the
      // header. Every field is initialised here so no record ever has a missing property.
      pool.push({
        mesh, pool, behavior: type.behavior,
        halfX: half.x, halfZ: half.z, baseHalfX: half.x,
        age: 0, dist: 0, zRate: 1, phase: 0, omega: 0, amp: 0, dir: 1, window: 1,
        baseX: 0, solid: true, minGapX: Infinity, grazed: false,
        solidBody: body, ghostBody, solidEdge: edge, ghostEdge
      });
    }

    pools[id] = pool;
  }

  return pools;
};
