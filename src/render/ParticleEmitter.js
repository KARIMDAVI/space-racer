import * as THREE from 'three';
import { radialTexture } from './gradientTexture.js';

/**
 * ARCHITECTURE: Pooled GPU particles
 * Decision: one THREE.Points per emitter, backed by typed arrays sized once at construction.
 *   A particle is an index, not an object. Nothing in this file allocates after the
 *   constructor returns — no Vector3 per spawn, no array push per frame, no splice on death.
 * Reason: Principle III, and this is the whole reason the class exists rather than three
 *   hand-rolled emitters. Particle systems are the classic per-frame-allocation offender:
 *   the naive shape is an array of {position, velocity, life} objects, filtered every frame.
 *   At 300 particles and 60fps that is 18,000 short-lived objects a second handed to the GC,
 *   which buys a collection pause at an unpredictable moment — on mobile, a dropped frame in
 *   the middle of a dodge. ObstacleManager already solved the same problem the same way for
 *   meshes; this is that pattern applied to vertices.
 * Trade-off: a hard ceiling per emitter. Emitting into a saturated pool drops the particle
 *   (see #spawn) rather than growing the buffer, because growing means reallocating a
 *   Float32Array mid-frame, which is the exact thing this design exists to prevent. A missing
 *   spark is invisible; a GC pause is not.
 * Ownership note: this file is a mechanism, not a domain. It lives under render/ next to
 *   RenderPipeline but owns none of RenderPipeline's concerns (no composer, no pass, no
 *   camera) and is never constructed by it. The Ownership Map's domain owners construct and
 *   drive their own emitters — the Blueprint's Phase 2 line asks for exactly that, "not a new
 *   global".
 * If particles vanish the instant they spawn, check frustumCulled first: see the note in the
 *   constructor. If they never appear at all, the emitter is almost certainly saturated —
 *   rate * life must stay under max, and #spawn silently drops the overflow.
 */

/**
 * ADR (Principle III / measured, not assumed): the position and colour attributes are marked
 * wholesale with `needsUpdate` each frame rather than through r171's update-range mechanism
 * (BufferAttribute.addUpdateRange, consumed and cleared in WebGLAttributes.updateBuffer).
 * The API is available and was considered. It buys nothing here: live particles are scattered
 * across the pool by construction — a free list hands back whatever index died last, not a
 * contiguous run — so the one range covering them is the whole buffer within a few frames of
 * the stream starting. The buffer it would be narrowing is 3.6KB at max = 300; a full
 * bufferSubData of that is ~0.4 MB/s at 60fps, against a per-particle min/max branch in the
 * hot loop to compute a range that saves nothing. The uploads are skipped entirely while the
 * emitter is idle (see the liveCount guard in update), which is the case that actually
 * mattered — a menu costs zero.
 */

/**
 * The soft dot every emitter draws. Shared: the emitters differ by colour, size and blending,
 * all of which are material state, so there is no reason for more than one texture upload.
 * Built on first use rather than at import time so the module stays importable without a DOM.
 */
let sharedSprite = null;
const SPRITE_STOPS = [
  [0.0, 'rgba(255,255,255,1)'],
  [0.22, 'rgba(255,255,255,0.72)'],
  [0.55, 'rgba(255,255,255,0.16)'],
  [1.0, 'rgba(255,255,255,0)']
];
const SPRITE_SIZE = 64;

const sprite = () => (sharedSprite ??= radialTexture(SPRITE_STOPS, SPRITE_SIZE));

/**
 * Where dead particles are parked. Colour-to-black already makes a corpse invisible under
 * additive blending, but only under additive — parking it outside every plausible frustum
 * makes it invisible under any blending mode the caller picks, for three float writes on
 * death rather than per frame.
 */
const GRAVEYARD_Y = -100000;

/** Floor on the per-particle brightness roll, so no particle spawns already invisible. */
const MIN_BRIGHTNESS = 0.55;

const DEFAULT_STREAM = Object.freeze({
  direction: Object.freeze([0, 0, 1]),
  speed: Object.freeze([10, 20]),
  jitter: 0.3,   // world-unit spread of the spawn point around the origin
  scatter: 1.0   // world-unit/sec spread added to the launch velocity
});

export class ParticleEmitter {
  // One flat array per property. Interleaving them into a single struct-of-arrays buffer
  // would save nothing: `position` and `color` have to be their own BufferAttributes anyway,
  // and the rest never reaches the GPU.
  #positions;
  #velocities;
  #life;        // seconds remaining; <= 0 means the slot is free
  #invLife;     // 1 / lifespan, cached so the fade is a multiply rather than a divide
  #brightness;

  #colors;
  #free;        // stack of free indices — same O(1) pooling shape as ObstacleManager
  #freeCount;
  #liveCount = 0;

  #max;
  #gravity;
  #drag;
  #lifespan;
  #lifeJitter;
  #stream;
  #r; #g; #b;

  #positionAttribute;
  #colorAttribute;

  #rate = 0;
  #pending = 0;                      // fractional carry between frames — see #emitStream
  #origin = new THREE.Vector3();     // the one Vector3 this class owns, reused forever

  /**
   * `stream` configures setContinuous: a base direction, a speed range, and how much to
   * scatter both. It lives in the constructor rather than in setContinuous's signature
   * because it describes what the emitter *is* — a thruster always fires backwards — while
   * rate is what changes frame to frame.
   */
  constructor(scene, {
    max,
    color,
    size,
    blending = THREE.AdditiveBlending,
    gravity = 0,
    drag = 0,
    life = 1,
    lifeJitter = 0.35,
    stream = DEFAULT_STREAM
  }) {
    this.#max = max;
    this.#gravity = gravity;
    this.#drag = drag;
    this.#lifespan = life;
    this.#lifeJitter = lifeJitter;
    this.#stream = stream;

    const tint = new THREE.Color(color);
    this.#r = tint.r;
    this.#g = tint.g;
    this.#b = tint.b;

    this.#positions = new Float32Array(max * 3);
    this.#velocities = new Float32Array(max * 3);
    this.#colors = new Float32Array(max * 3);
    this.#life = new Float32Array(max);
    this.#invLife = new Float32Array(max);
    this.#brightness = new Float32Array(max);
    this.#free = new Int32Array(max);

    // Every slot starts free and parked. Filling the stack in reverse means the first burst
    // hands out indices 0, 1, 2… which makes a buffer dump readable when something is wrong.
    this.#freeCount = max;
    for (let i = 0; i < max; i++) {
      this.#free[i] = max - 1 - i;
      this.#positions[i * 3 + 1] = GRAVEYARD_Y;
    }

    const geometry = new THREE.BufferGeometry();
    this.#positionAttribute = new THREE.BufferAttribute(this.#positions, 3);
    this.#colorAttribute = new THREE.BufferAttribute(this.#colors, 3);
    this.#positionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.#colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.#positionAttribute);
    geometry.setAttribute('color', this.#colorAttribute);

    const points = new THREE.Points(geometry, new THREE.PointsMaterial({
      size,
      map: sprite(),
      vertexColors: true,   // this is also the fade: colour scaled by remaining life
      blending,
      transparent: true,
      depthWrite: false,    // additive sprites must not occlude each other
      sizeAttenuation: true,
      fog: false            // fog multiplies toward black, which on an additive sprite is a
                            // second, invisible fade fighting the one life already applies
    }));

    // Non-negotiable, and the single most likely reason a rewrite of this file renders
    // nothing: three computes a bounding sphere once, from whatever is in the buffer at the
    // time — here, every particle parked 100km underground — and then culls the whole Points
    // object against it forever. Recomputing the sphere per frame is O(max) and pointless.
    points.frustumCulled = false;

    scene.add(points);
  }

  /**
   * One-shot burst: `spread` is the radius of the random offset the particles spawn within,
   * and `speedRange` is `[min, max]` launch speed. Direction is random over the sphere and is
   * reused as the offset direction, so debris flies outward from where it appeared, which is
   * both correct and three fewer random calls.
   *
   * `speedRange` is read, never retained. Call sites should pass a frozen module constant
   * rather than an array literal — bursts are rare enough that it would not matter, but the
   * habit is what keeps this file's guarantee true at the call site too.
   */
  emitBurst(origin, count, spread, speedRange) {
    const [minSpeed, maxSpeed] = speedRange;

    for (let i = 0; i < count; i++) {
      const dx = Math.random() * 2 - 1;
      const dy = Math.random() * 2 - 1;
      const dz = Math.random() * 2 - 1;
      // Normalising three uniform samples biases very slightly toward the cube's corners
      // versus true spherical sampling. In a cloud of debris that is unobservable, and
      // rejection sampling would loop an unbounded number of times to fix it.
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const scale = (minSpeed + Math.random() * (maxSpeed - minSpeed)) / length;

      const spawned = this.#spawn(
        origin.x + dx * spread, origin.y + dy * spread, origin.z + dz * spread,
        dx * scale, dy * scale, dz * scale
      );
      if (!spawned) return; // pool saturated — the rest of this burst has nowhere to go
    }
  }

  /**
   * Continuous stream. Safe to call every frame — it copies into the emitter's own Vector3
   * and writes one number. `rate` is particles per second; 0 stops emission without
   * disturbing the particles already in flight.
   */
  setContinuous(origin, rate) {
    this.#origin.copy(origin);
    this.#rate = rate;
  }

  /** Kills everything in flight immediately. The restart path needs it; nothing else should. */
  clear() {
    for (let i = 0; i < this.#max; i++) {
      if (this.#life[i] > 0) this.#kill(i);
    }
    this.#pending = 0;
    this.#positionAttribute.needsUpdate = true;
    this.#colorAttribute.needsUpdate = true;
  }

  update(dt) {
    this.#emitStream(dt);
    if (this.#liveCount === 0) return; // idle emitter: no loop, no upload, no cost

    // Hoisted out of the loop: both are the same for every particle this frame, and inside
    // they would be `max` redundant multiplies. Clamped because a large dt with a strong drag
    // would otherwise flip the damping negative and fling particles backwards.
    const damping = Math.max(0, 1 - this.#drag * dt);
    const fall = this.#gravity * dt;

    for (let i = 0; i < this.#max; i++) {
      const current = this.#life[i];
      if (current <= 0) continue; // free slot: skipped in place, never spliced out

      const remaining = current - dt;
      if (remaining <= 0) { this.#kill(i); continue; }

      this.#life[i] = remaining;
      const p = i * 3;

      this.#velocities[p + 1] += fall;
      this.#velocities[p] *= damping;
      this.#velocities[p + 1] *= damping;
      this.#velocities[p + 2] *= damping;

      this.#positions[p] += this.#velocities[p] * dt;
      this.#positions[p + 1] += this.#velocities[p + 1] * dt;
      this.#positions[p + 2] += this.#velocities[p + 2] * dt;

      // Fade to black. Under additive blending that *is* the fade to invisible, so the
      // particle dies out without the per-vertex alpha PointsMaterial has no channel for.
      const fade = remaining * this.#invLife[i] * this.#brightness[i];
      this.#colors[p] = this.#r * fade;
      this.#colors[p + 1] = this.#g * fade;
      this.#colors[p + 2] = this.#b * fade;
    }

    this.#positionAttribute.needsUpdate = true;
    this.#colorAttribute.needsUpdate = true;
  }

  #emitStream(dt) {
    if (this.#rate <= 0) {
      this.#pending = 0;
      return;
    }

    // Fractional carry rather than rounding per frame: at 30 particles/sec and 60fps every
    // frame owes 0.5 of a particle, and a per-frame floor would emit nothing, ever.
    // Capped at the pool size so a pathological rate can't spin this loop.
    this.#pending = Math.min(this.#pending + this.#rate * dt, this.#max);

    const { direction, speed, jitter, scatter } = this.#stream;
    const span = speed[1] - speed[0];

    while (this.#pending >= 1) {
      this.#pending -= 1;
      const launch = speed[0] + Math.random() * span;
      this.#spawn(
        this.#origin.x + (Math.random() - 0.5) * jitter,
        this.#origin.y + (Math.random() - 0.5) * jitter,
        this.#origin.z,
        direction[0] * launch + (Math.random() - 0.5) * scatter,
        direction[1] * launch + (Math.random() - 0.5) * scatter,
        direction[2] * launch
      );
    }
  }

  /** Returns false when the pool is saturated. Never grows it — see the class ADR. */
  #spawn(x, y, z, vx, vy, vz) {
    if (this.#freeCount === 0) return false;

    const index = this.#free[--this.#freeCount];
    const p = index * 3;

    this.#positions[p] = x;
    this.#positions[p + 1] = y;
    this.#positions[p + 2] = z;
    this.#velocities[p] = vx;
    this.#velocities[p + 1] = vy;
    this.#velocities[p + 2] = vz;

    const lifespan = this.#lifespan * (1 - this.#lifeJitter * Math.random());
    this.#life[index] = lifespan;
    this.#invLife[index] = 1 / lifespan;
    this.#brightness[index] = MIN_BRIGHTNESS + Math.random() * (1 - MIN_BRIGHTNESS);

    this.#liveCount++;
    return true;
  }

  #kill(index) {
    const p = index * 3;
    this.#life[index] = 0;
    this.#positions[p + 1] = GRAVEYARD_Y;
    this.#colors[p] = 0;
    this.#colors[p + 1] = 0;
    this.#colors[p + 2] = 0;

    this.#free[this.#freeCount++] = index;
    this.#liveCount--;
  }
}
