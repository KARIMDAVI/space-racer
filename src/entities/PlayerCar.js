import * as THREE from 'three';
import { State } from '../core/GameManager.js';
import { buildCar } from './CarModel.js';
import { ShieldShell } from './ShieldShell.js';
import { ParticleEmitter } from '../render/ParticleEmitter.js';

/**
 * ARCHITECTURE: The player's car
 * Decision: this module owns the car's Group, the light pool under it, its two particle
 *   emitters, its measured hitbox, and all of its motion. The meshes themselves are assembled
 *   by CarModel.js, which this file is the only caller of.
 * Reason: Ownership Map gives Environment "lighting", but the car's rim light is a *child of
 *   the car group*. Handing it to Environment would mean Environment reaching into PlayerCar's
 *   Group to attach it — the exact internals-poking Principle I forbids. The same argument
 *   covers the emitters: Blueprint Phase 2 asks for thruster and crash particles owned by a
 *   domain module, "not a new global", and the thing they are attached to is the car.
 * Trade-off: "all lighting lives in one file" is no longer literally true. Grep for `Light`
 *   finds two places instead of one. Worth it for a car that can be added to any scene and
 *   still look right.
 * If the car renders but nothing trails it, check in this order: 1) game.speed — the plume rate
 *   is derived from it, so a zero speed is a silent, correct-looking off switch, 2) the
 *   emitter's own saturation note in ParticleEmitter.js, 3) that update() is still being called
 *   in every state, because the crash animation and the debris both run outside PLAYING.
 */

const CAR_SPEED_X = 20;   // lateral units/sec — deliberately unrelated to forward speed
const X_LIMIT = 8;        // road edge
const BANK_LERP = 0.1;    // per-frame, NOT dt-scaled: see #drive()
const BANK_ROLL = 0.3;
const BANK_YAW = 0.1;
const CRASH_SPIN = 5;     // rad/sec tumble

const START_X = 0;
const START_Y = -1;
const START_Z = 0;

const UNDERGLOW_Y = 0.04; // above the wheel contact plane, clear of the road surface

/**
 * Deliberately not the physically correct rate. The world scrolls at speed * 100 units/sec
 * (GameManager's DISTANCE_PER_SPEED_UNIT), which on a 0.45-radius wheel is ~222 rad/sec — 3.7
 * radians between two frames at 60fps. Past half a spoke period per frame the eye reads the
 * wagon-wheel effect: the rims stall, then crawl backwards. 9 rad/sec per unit of speed is ~1.4
 * turns a second at the start of a run — clearly rolling, still visibly accelerating with the
 * score, never aliasing. Correct here means legible, not accurate.
 */
const WHEEL_SPIN_RATE = 9;
const WHEEL_YAW = 0.28;
const WHEEL_YAW_LERP = 0.18;

/**
 * Thruster exhaust. rate * lifespan is the live-particle ceiling: 420 * 0.55 = 231, comfortably
 * under max, so the plume never starves at the top of the speed curve. The cap earns its place —
 * rate scales with game speed, and speed has no upper bound over a long run.
 */
const THRUSTER = Object.freeze({
  max: 300, color: 0xff7a1a, size: 0.34, gravity: 2.2, drag: 0.9, life: 0.55,
  stream: Object.freeze({
    direction: Object.freeze([0, 0, 1]), // backwards, toward the camera
    speed: Object.freeze([22, 46]),
    jitter: 0.5,
    scatter: 3
  })
});
const THRUSTER_RATE_PER_SPEED = 150;
const THRUSTER_MAX_RATE = 420;
/**
 * Car-space exhaust port, level with the tail bar. A Vector3 rather than an array because the
 * only consumer copies it into a scratch vector every frame, and `set(...array)` builds an
 * arguments object on each call — a per-frame allocation for nothing (Principle III).
 */
const THRUSTER_NOZZLE = new THREE.Vector3(0, 0.5, 2.35);

const SHATTER = Object.freeze({
  max: 200, color: 0xff9a2e, size: 0.32, gravity: -12, drag: 1.2, life: 1.1
});
const SHATTER_COUNT = 150;
const SHATTER_SPREAD = 1.1;                   // debris spawns within the car's own volume
const SHATTER_SPEED = Object.freeze([6, 22]); // frozen: emitBurst reads it, never keeps it
const SHATTER_ORIGIN_Y = 0.6;                 // the car's rough centre of mass
/** Seconds of game time the wreck takes to collapse into its own debris cloud. */
const CRASH_COLLAPSE = 0.38;

/**
 * The car's footprint, measured once from the assembled mesh in its rest pose.
 * Principle III: the alternative is `Box3.setFromObject` every frame, which walks every mesh in
 * the group to rediscover numbers that cannot change.
 *
 * Reported as half-extents plus the offset of the box centre from the group origin, because the
 * car is *not* centred on its own origin — the nose reaches further forward than the tail does
 * back, so a collision test that assumed `position` was the centre would sit the hitbox behind
 * the car by that difference, which is small enough to look like bad luck rather than a bug.
 *
 * This is also why CarModel returns the underglow unparented: anything inside the group lands
 * in this measurement, and the glow quad is wider and longer than the car.
 */
const measureHitbox = (car) => {
  const box = new THREE.Box3().setFromObject(car);
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  return Object.freeze({
    halfX: size.x / 2,
    halfZ: size.z / 2,
    offsetX: centre.x - car.position.x,
    offsetZ: centre.z - car.position.z
  });
};

export class PlayerCar {
  #group;
  #wheels;
  #underglow;
  #thruster;
  #shatter;
  #shield;
  #hitbox;
  #crashing = false;
  #steerable = false;
  #crashTime = 0;
  #wheelYaw = 0;
  /** The two scratch vectors this class owns. Mutated in place, never reallocated. */
  #nozzle = new THREE.Vector3();
  #burstOrigin = new THREE.Vector3();

  constructor(scene, bus) {
    const { car, wheels, underglow } = buildCar();
    this.#group = car;
    this.#wheels = wheels;
    this.#underglow = underglow;
    scene.add(this.#group, this.#underglow);

    this.#thruster = new ParticleEmitter(scene, THRUSTER);
    this.#shatter = new ParticleEmitter(scene, SHATTER);
    this.#shield = new ShieldShell(scene);

    this.reset();
    // Measured after reset and before the first frame, while rotation is still zero. Steering
    // banks the car, and a bank would inflate the measurement into the lean.
    this.#hitbox = measureHitbox(this.#group);
    bus.on('stateChanged', ({ from, to }) => this.#onStateChanged(from, to));

    /**
     * ADR (Principle II): the shield's *visual* is driven by the two events, never by this file
     * keeping its own timer. PlayerCar does not know how long a shield lasts and has no field
     * saying whether one is up — GameManager owns both, and the pair of handlers below is the
     * whole of what this module knows about power-ups. The shell's own `raise`/`drop` are
     * idempotent, which is what makes a re-fired `powerupStarted` (a refresh) harmless.
     *
     * `broken` is the only payload either handler reads, and it is the difference between the
     * shell popping and the shell dissolving — a distinction only GameManager can make, since
     * only it knows whether an impact or the clock ended it.
     */
    bus.on('powerupStarted', ({ kind }) => { if (kind === 'shield') this.#shield.raise(); });
    bus.on('powerupEnded', ({ kind, broken }) => { if (kind === 'shield') this.#shield.drop(broken); });
  }

  /** The car's scene node. Read-only handle — ObstacleManager reads its position. */
  get object3d() { return this.#group; }

  /**
   * Frozen `{ halfX, halfZ, offsetX, offsetZ }` in world units, relative to `object3d.position`.
   * The collision *feel* constants are not applied here — this is the car's true size, and
   * ObstacleManager owns how forgiving to be about it.
   */
  get hitbox() { return this.#hitbox; }

  reset() {
    this.#group.position.set(START_X, START_Y, START_Z);
    this.#group.rotation.set(0, 0, 0);
    this.#group.scale.setScalar(1);
    this.#group.visible = true;

    this.#underglow.position.set(START_X, START_Y + UNDERGLOW_Y, START_Z);
    this.#underglow.visible = true;

    this.#crashTime = 0;
    // A fast restart would otherwise inherit the previous run's debris hanging in mid-air.
    this.#shatter.clear();
    this.#thruster.clear();
    // Belt-and-braces against GameManager, which already ends every power-up on game-over: if
    // that ordering ever changes, a stale bubble following the car through a fresh run is a
    // very confusing bug to look at.
    this.#shield.clear();
  }

  /**
   * `speed` drives the wheel spin and the exhaust rate. Lateral steering stays deliberately
   * independent of how fast the world is moving — that is what keeps the car controllable at
   * high score — so it is the *visuals* that read the speed, not the handling.
   *
   * Runs in every state the tick is not paused for, including GAME_OVER: the crash animation and
   * the debris both live past the end of the run.
   */
  update(dt, steerAxis, speed) {
    if (this.#crashing) this.#collapse(dt);
    else this.#drive(dt, steerAxis);

    this.#spinWheels(dt, steerAxis, speed);
    this.#feedThruster(speed);
    this.#thruster.update(dt);
    this.#shatter.update(dt);
    // Handed the car's position rather than reading it back off a parent transform — see the
    // unparenting note in ShieldShell. Last, so it follows where the car actually ended up
    // this frame instead of trailing it by one.
    this.#shield.update(dt, this.#group.position);
    this.#underglow.position.x = this.#group.position.x;
  }

  #drive(dt, steerAxis) {
    if (!this.#steerable) return; // menus: the car sits perfectly still, as before

    const { position, rotation } = this.#group;

    // The rail check lives in the *condition*, not as a clamp after the move. Pinned against the
    // edge the car falls through to the neutral branch and levels out instead of holding its
    // bank. That asymmetry is the pre-split behaviour and the S1 gate compares against it, so it
    // is preserved on purpose.
    if (steerAxis < 0 && position.x > -X_LIMIT) {
      position.x -= CAR_SPEED_X * dt;
      rotation.z = THREE.MathUtils.lerp(rotation.z, BANK_ROLL, BANK_LERP);
      rotation.y = THREE.MathUtils.lerp(rotation.y, BANK_YAW, BANK_LERP);
    } else if (steerAxis > 0 && position.x < X_LIMIT) {
      position.x += CAR_SPEED_X * dt;
      rotation.z = THREE.MathUtils.lerp(rotation.z, -BANK_ROLL, BANK_LERP);
      rotation.y = THREE.MathUtils.lerp(rotation.y, -BANK_YAW, BANK_LERP);
    } else {
      rotation.z = THREE.MathUtils.lerp(rotation.z, 0, BANK_LERP);
      rotation.y = THREE.MathUtils.lerp(rotation.y, 0, BANK_LERP);
    }
  }

  /**
   * The wreck tumbles and collapses into the debris its own crash threw. This replaces the old
   * endless spin rather than joining it: a car that tumbles forever behind the game-over screen
   * reads as a stuck animation, and pairing it with a burst would say the burst was decoration.
   * Squared so the car holds its shape for the first instant — the frame the shatter fires —
   * then goes fast; a linear collapse reads as the car politely shrinking. Once it is gone the
   * group is hidden outright rather than left at scale 0, which keeps a degenerate matrix out of
   * the render walk and takes the car's point light with it.
   */
  #collapse(dt) {
    if (!this.#group.visible) return;

    this.#group.rotation.y += CRASH_SPIN * dt;
    this.#group.rotation.z += CRASH_SPIN * dt;

    this.#crashTime += dt;
    const t = Math.min(1, this.#crashTime / CRASH_COLLAPSE);
    if (t === 1) {
      this.#group.visible = false;
      this.#underglow.visible = false;
      return;
    }
    this.#group.scale.setScalar(1 - t * t);
  }

  #spinWheels(dt, steerAxis, speed) {
    const roll = speed * WHEEL_SPIN_RATE * dt;
    // Lerped rather than snapped, on the same sign convention the body banks with, so the wheels
    // lead the chassis into a turn instead of hitting full lock on the first frame.
    this.#wheelYaw = THREE.MathUtils.lerp(this.#wheelYaw, -steerAxis * WHEEL_YAW, WHEEL_YAW_LERP);

    // Indexed rather than for-of, matching ObstacleManager's per-frame loops. for-of over an
    // array constructs an ArrayIterator; V8 usually elides it once the function is optimised,
    // but "usually elided" is a weaker guarantee than "never created", and this file's whole
    // claim is the latter (Principle III).
    for (let i = 0; i < this.#wheels.length; i++) {
      const wheel = this.#wheels[i];
      wheel.node.rotation.x += roll;
      if (wheel.steers) wheel.node.rotation.y = this.#wheelYaw;
    }
  }

  /**
   * Exhaust is emitted in *world* space and not parented to the car: a trail that followed the
   * car laterally would move with it and stop reading as something left behind. The nozzle is
   * carried through the group's matrix so the plume swings correctly when the car banks — one
   * matrix-vector multiply on a vector this class already owns.
   */
  #feedThruster(speed) {
    this.#nozzle.copy(THRUSTER_NOZZLE);
    this.#group.localToWorld(this.#nozzle);
    // Speed is 0 in the menu and 0 after a crash, so the plume switches itself off in both
    // without either state being named here.
    const rate = Math.min(speed * THRUSTER_RATE_PER_SPEED, THRUSTER_MAX_RATE);
    this.#thruster.setContinuous(this.#nozzle, rate);
  }

  /**
   * ADR (Principle II): these two flags mirror a GameManager transition rather than duplicating
   * it. They select an animation mode — they are never read as the answer to "is the game
   * over?", and nothing outside this file can see them.
   *
   * The shatter fires from here rather than off a second `crashed` subscription. This handler
   * already runs inside that emit chain (crashed → gameOver → stateChanged), so it is the same
   * frame either way, and routing through the state machine means the burst inherits its
   * guarantee of firing exactly once per death: gameOver() ignores a second impact, and
   * #transition() is a no-op on a self-transition.
   */
  #onStateChanged(from, to) {
    this.#crashing = to === State.GAME_OVER;
    this.#steerable = to === State.PLAYING;
    if (this.#crashing) this.#shatterCar();
    // A resume enters PLAYING too. Without the `from` check, unpausing would snap the car back
    // to the centre lane and level its bank — a teleport, mid-dodge.
    if (to === State.PLAYING && from !== State.PAUSED) this.reset();
  }

  #shatterCar() {
    this.#crashTime = 0;
    // The burst origin is the car's own centre of mass, not the impact point: this debris is the
    // car coming apart, and where the obstacle was is ObstacleManager's business.
    this.#burstOrigin.copy(this.#group.position);
    this.#burstOrigin.y += SHATTER_ORIGIN_Y;
    this.#shatter.emitBurst(this.#burstOrigin, SHATTER_COUNT, SHATTER_SPREAD, SHATTER_SPEED);
  }
}
