import * as THREE from 'three';
import { State } from '../core/GameManager.js';
import { buildCar } from './CarModel.js';

/**
 * ARCHITECTURE: The player's car
 * Decision: this module owns the car's Group, the light pool under it, its measured hitbox and
 *   all of its motion. The meshes themselves are assembled by CarModel.js, which this file is
 *   the only caller of.
 * Reason: Ownership Map gives Environment "lighting", but the car's rim light is a *child of
 *   the car group*, and the light pool is placed from this file every frame. Handing either to
 *   Environment would mean Environment reaching into PlayerCar's state to move them — the exact
 *   internals-poking Principle I forbids.
 * Trade-off: "all lighting lives in one file" is no longer literally true. Grep for `Light`
 *   finds two places instead of one. Worth it for a car that can be added to any scene and
 *   still look right.
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
  #hitbox;
  #crashing = false;
  #steerable = false;
  #wheelYaw = 0;

  constructor(scene, bus) {
    const { car, wheels, underglow } = buildCar();
    this.#group = car;
    this.#wheels = wheels;
    this.#underglow = underglow;
    scene.add(this.#group, this.#underglow);

    this.reset();
    // Measured after reset and before the first frame, while rotation is still zero. Steering
    // banks the car, and a bank would inflate the measurement into the lean.
    this.#hitbox = measureHitbox(this.#group);
    bus.on('stateChanged', ({ from, to }) => this.#onStateChanged(from, to));
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
    this.#underglow.position.set(START_X, START_Y + UNDERGLOW_Y, START_Z);
    this.#underglow.visible = true;

  }

  /**
   * `speed` now drives the wheel spin — it was accepted and ignored before this change, with a
   * note promising a future use. Lateral steering stays deliberately independent of how fast the
   * world is moving, which is what keeps the car controllable at high score, so it is the
   * *visuals* that read the speed and not the handling.
   */
  update(dt, steerAxis, speed) {
    if (this.#crashing) {
      this.#group.rotation.y += CRASH_SPIN * dt;
      this.#group.rotation.z += CRASH_SPIN * dt;
    } else {
      this.#drive(dt, steerAxis);
    }

    this.#spinWheels(dt, steerAxis, speed);
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
   * ADR (Principle II): these two flags mirror a GameManager transition rather than duplicating
   * it. They select an animation mode — they are never read as the answer to "is the game
   * over?", and nothing outside this file can see them.
   */
  #onStateChanged(from, to) {
    this.#crashing = to === State.GAME_OVER;
    this.#steerable = to === State.PLAYING;
    // A resume enters PLAYING too. Without the `from` check, unpausing would snap the car back
    // to the centre lane and level its bank — a teleport, mid-dodge.
    if (to === State.PLAYING && from !== State.PAUSED) this.reset();
  }
}
