import * as THREE from 'three';

/**
 * ARCHITECTURE: Collectibles as data, pooled exactly like obstacles
 * Decision: one row per collectible kind holding its geometry, its colours, how many pooled
 *   records exist, and a static per-frame `behavior`. buildCollectiblePools() builds every mesh
 *   the game will ever show and hands back one free list per kind. This is obstacleTypes.js's
 *   shape, deliberately, down to the field names.
 * Reason: Constitution Principle III and the Blueprint's Phase 3 line, which says collectible
 *   spawning "reuses ObstacleManager's pooling pattern rather than inventing a second one".
 *   The pattern is: pre-warm at boot, spawn by popping a record and flipping `visible`, despawn
 *   by pushing it back. After the constructor returns, nothing on this path calls `scene.add`,
 *   `scene.remove` or `new`.
 * Trade-off: two files describe two tables that look almost identical, and the obvious
 *   refactor is to merge them into one generic "pooled thing" module. That is refused on
 *   purpose — the two tables share a *shape*, not a meaning. An obstacle row carries
 *   half-extents tuned for a hitbox that must feel fair to hit; a collectible row carries them
 *   tuned for a pickup that must feel generous to catch, and they want to move in opposite
 *   directions. Merging them would put one set of numbers under two conflicting requirements.
 * If a collectible spawns invisible, check `pieces` — the manager reserves that many records
 *   per spawn and both kinds here are 1, so a row that grows a second piece needs the pool size
 *   to grow with it.
 */

/** Same height band as the car and every obstacle, so the y axis stays a non-separating axis. */
export const SPAWN_Y = -0.5;

/**
 * ADR (feel, and the mirror image of obstacleTypes.js's SHRINK): pickup boxes are *grown*, not
 * shrunk. An obstacle's box is pulled in 0.2 a side so the player is never killed by something
 * that looked like a miss; a collectible's is pushed out so they are never denied something
 * that looked like a hit. Same instinct, opposite sign, and it is the whole reason these two
 * tables are not one table.
 */
const PICKUP_GROW = 0.35;

/**
 * Orbs are mint rather than any of the eight obstacle edge colours (red 0xff0044, cyan
 * 0x00e5ff, magenta 0xff00cc, orange 0xff8800, lime 0xaaff00, ice 0x88ccff). That list is
 * nearly the whole wheel, which is exactly why the one thing the player is meant to *drive
 * into* has to sit outside it — and mint survives all four biomes, since none of them tints
 * toward green.
 */
const ORB_COLOR = 0x5cffd0;
const ORB_RADIUS = 0.5;
const ORB_SPIN = 2.1;   // rad/sec, cosmetic
const ORB_BOB = 0.22;   // world units of vertical float
const ORB_BOB_RATE = 3.4;

const CRATE_RADIUS = 0.8;
const CRATE_SPIN = 1.3;

/**
 * Emissive intensity well past 1.0 so both kinds clear RenderPipeline's 0.85 bloom threshold
 * and read as light sources — the same treatment Road gives its rails, and the reason a
 * collectible is legible against a dark road at any tier.
 */
const PICKUP_EMISSIVE = 2.2;

/**
 * One crate mesh, three looks. The kind is rolled at spawn and the material swapped by
 * *reference* — the identical trick the pulse gate uses for its ghost state, and for the
 * identical reason: three pools of one kind each would triple the mesh count to express a
 * difference that is one property on an already-uploaded material.
 */
export const CRATE_KINDS = Object.freeze(['shield', 'magnet', 'hyperdrive']);
const CRATE_COLORS = Object.freeze({
  shield: 0x33ddff,      // ice blue — the same family as the bubble it raises
  magnet: 0xff44aa,      // pink, the one hue no obstacle edge uses
  hyperdrive: 0xffdd22   // gold, hottest of the three, for the one that is pure speed
});

export const TYPES = Object.freeze({
  orb: {
    shape: { kind: 'oct', r: ORB_RADIUS },
    color: ORB_COLOR,
    // Half-extents of the *inscribed* square (r / sqrt(2)) plus the pickup grow, matching how
    // obstacleTypes.js measures its octahedral hunter — an octahedron's silhouette is a
    // diamond, and a box drawn round its points claims area the mesh does not occupy.
    half: ORB_RADIUS / Math.SQRT2 + PICKUP_GROW,
    /**
     * Sized against the worst case the scheduler can produce: an orb line is at most 5, one
     * line is placed per pattern, and the live corridor routinely holds two patterns at once
     * (220 units of road against a 375-unit shortest pattern-plus-gap at tier 5). 10 is that
     * peak; 16 carries the same "peak plus one whole spawn group plus one" headroom
     * ObstacleManager's pools use, and an idle pooled mesh is `visible = false`, which prunes
     * it from the render walk entirely.
     */
    pool: 16,
    pieces: 1,
    behavior: (record, dt) => {
      record.mesh.rotation.y += ORB_SPIN * dt;
      record.mesh.rotation.x += ORB_SPIN * 0.6 * dt;
      record.mesh.position.y = SPAWN_Y + Math.sin(record.age * ORB_BOB_RATE) * ORB_BOB;
    }
  },
  crate: {
    shape: { kind: 'ico', r: CRATE_RADIUS },
    color: CRATE_COLORS.shield, // the pool's built-in material; swapped per spawn by kind
    half: CRATE_RADIUS + PICKUP_GROW,
    // One crate is live at a time by construction (the manager's cadence timer), but a crate
    // spawned at the very end of one pattern can still be on the road when the next one's
    // arrives if the player left it. 3 covers that with a spare.
    pool: 3,
    pieces: 1,
    behavior: (record, dt) => {
      record.mesh.rotation.y += CRATE_SPIN * dt;
      record.mesh.rotation.z += CRATE_SPIN * 0.4 * dt;
    }
  }
});

const buildGeometry = ({ kind, r }) =>
  // Detail 0 for the orb keeps it a hard-edged gem; detail 1 for the crate reads as a rounder
  // "container" at a glance, which is the only silhouette difference the player needs.
  kind === 'ico' ? new THREE.IcosahedronGeometry(r, 1) : new THREE.OctahedronGeometry(r, 0);

const buildMaterial = (color) => new THREE.MeshStandardMaterial({
  color,
  emissive: color,
  emissiveIntensity: PICKUP_EMISSIVE,
  roughness: 0.3,
  metalness: 0.2
});

/**
 * Builds every collectible mesh once and returns `{ pools, crateMaterials }`.
 *
 * The only `scene.add` on this path, and it runs exactly sum(pool) times at boot. Geometry and
 * the edge material are shared across each pool — the meshes differ only by transform.
 */
export const buildCollectiblePools = (scene) => {
  const pools = {};

  for (const [id, type] of Object.entries(TYPES)) {
    const geometry = buildGeometry(type.shape);
    const edges = new THREE.EdgesGeometry(geometry);
    const body = buildMaterial(type.color);
    const edge = new THREE.LineBasicMaterial({ color: type.color });

    const pool = [];
    for (let i = 0; i < type.pool; i++) {
      const mesh = new THREE.Mesh(geometry, body);
      mesh.add(new THREE.LineSegments(edges, edge));
      mesh.position.set(0, SPAWN_Y, 0);
      mesh.visible = false;
      scene.add(mesh);

      // One record shape across both kinds, for the same monomorphism reason obstacleTypes.js
      // gives: one hidden class, one polymorphic-free per-frame loop. Every field initialised
      // here so no record ever has a missing property.
      pool.push({
        mesh, pool, behavior: type.behavior,
        half: type.half,
        age: 0, kind: null, collected: false,
        defaultBody: body, defaultEdge: edge
      });
    }

    pools[id] = pool;
  }

  // Built alongside the pools so the swap at spawn is a reference assignment on a material the
  // GPU already holds — never a construction mid-run.
  const crateMaterials = {};
  for (const kind of CRATE_KINDS) {
    const color = CRATE_COLORS[kind];
    crateMaterials[kind] = { body: buildMaterial(color), edge: new THREE.LineBasicMaterial({ color }) };
  }

  return { pools, crateMaterials };
};
