import * as THREE from 'three';
import { State } from '../core/GameManager.js';

/**
 * ARCHITECTURE: The player's car
 * Decision: this module owns the car's Group, every mesh inside it, the headlight
 *   PointLight parented to it, and all of its motion.
 * Reason: Ownership Map gives Environment "lighting", but the car's rim light is a
 *   *child of the car group*. Handing it to Environment would mean Environment
 *   reaching into PlayerCar's Group to attach it — the exact internals-poking
 *   Principle I forbids. Ambient and directional light stay with Environment; the
 *   light that travels with the car belongs to the car.
 * Trade-off: "all lighting lives in one file" is no longer literally true. Grep
 *   for `Light` finds two places instead of one. Worth it for a car that can be
 *   added to any scene and still look right.
 */

const CAR_SPEED_X = 20;   // lateral units/sec — deliberately unrelated to forward speed
const X_LIMIT = 8;        // road edge
const BANK_LERP = 0.1;    // per-frame, NOT dt-scaled: see update()
const BANK_ROLL = 0.3;
const BANK_YAW = 0.1;
const CRASH_SPIN = 5;     // rad/sec tumble

const START_X = 0;
const START_Y = -1;
const START_Z = 0;

const boxAt = (w, h, d, material, x, y, z) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
};

/** Tron-style outline: an EdgesGeometry twin sharing the source mesh's transform. */
const outline = (mesh, material) => {
  const line = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), material);
  line.position.copy(mesh.position);
  line.rotation.copy(mesh.rotation);
  return line;
};

const buildCar = () => {
  const car = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2, metalness: 0.8 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xffddaa, roughness: 0.1, metalness: 0.9, emissive: 0xff8800, emissiveIntensity: 0.6
  });
  const neonMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xff8800, linewidth: 2 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 });

  const chassis = boxAt(2.2, 0.4, 4.6, bodyMat, 0, 0.3, 0);
  const hood = boxAt(2.0, 0.3, 1.8, bodyMat, 0, 0.45, -1.8);
  hood.rotation.x = Math.PI / 16; // set before outlining — the edge twin copies it
  const cabin = boxAt(1.6, 0.5, 2.0, bodyMat, 0, 0.75, 0.2);
  const spoilerWing = boxAt(2.4, 0.1, 0.6, bodyMat, 0, 1.2, 2.1);

  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.2), glassMat);
  windshield.position.set(0, 0.78, -0.65);
  windshield.rotation.x = -Math.PI / 3.5;

  for (const part of [chassis, hood, cabin]) car.add(part, outline(part, lineMat));
  car.add(windshield); // no outline: the emissive material is the effect
  car.add(spoilerWing, outline(spoilerWing, lineMat));

  car.add(boxAt(0.1, 0.5, 0.2, bodyMat, -0.8, 0.95, 2.0)); // spoiler struts
  car.add(boxAt(0.1, 0.5, 0.2, bodyMat, 0.8, 0.95, 2.0));

  // Wheel geometry is shared across all four — four Meshes, one BufferGeometry each.
  const tireGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.3, 24);
  const rimGeo = new THREE.TorusGeometry(0.28, 0.05, 12, 24);
  for (const [x, z] of [[-1.25, -1.5], [1.25, -1.5], [-1.25, 1.6], [1.25, 1.6]]) {
    const wheel = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(rimGeo, neonMat);
    rim.rotation.y = Math.PI / 2;
    rim.position.x = x > 0 ? 0.16 : -0.16; // push the glowing rim to the outboard face
    wheel.add(tire, rim);
    wheel.position.set(x, 0.45, z);
    car.add(wheel);
  }

  car.add(boxAt(0.6, 0.05, 0.05, neonMat, -0.7, 0.4, -2.65)); // headlight slits
  car.add(boxAt(0.6, 0.05, 0.05, neonMat, 0.7, 0.4, -2.65));
  car.add(boxAt(1.8, 0.2, 0.1, neonMat, 0, 0.5, 2.3));        // rear thruster bar

  // Travels with the car so it stays lit against the near-black chassis material.
  const carLight = new THREE.PointLight(0xffaa00, 10, 20);
  carLight.position.set(0, 2, 0);
  car.add(carLight);

  car.position.set(START_X, START_Y, START_Z);
  return car;
};

export class PlayerCar {
  #group;
  #crashing = false;
  #steerable = false;

  constructor(scene, bus) {
    this.#group = buildCar();
    scene.add(this.#group);
    bus.on('stateChanged', ({ to }) => this.#onStateChanged(to));
  }

  /** The car's scene node. Read-only handle — ObstacleManager bounds-tests against it. */
  get object3d() { return this.#group; }

  reset() {
    this.#group.position.set(START_X, START_Y, START_Z);
    this.#group.rotation.set(0, 0, 0);
  }

  /**
   * `speed` is unused today — lateral steering is deliberately independent of how
   * fast the world is moving, which is what makes the car feel controllable at high
   * score. It stays in the signature because speed-scaled handling is a known
   * upcoming change and this is the interface it will arrive through.
   */
  update(dt, steerAxis, speed) {
    if (this.#crashing) {
      this.#group.rotation.y += CRASH_SPIN * dt;
      this.#group.rotation.z += CRASH_SPIN * dt;
      return;
    }
    if (!this.#steerable) return; // menus: the car sits perfectly still, as before

    const { position, rotation } = this.#group;

    // The rail check lives in the *condition*, not as a clamp after the move. Pinned
    // against the edge the car falls through to the neutral branch and levels out
    // instead of holding its bank. That asymmetry is the pre-split behaviour and the
    // S1 gate compares against it, so it is preserved on purpose.
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
   * ADR (Principle II): these two flags mirror a GameManager transition rather than
   * duplicating it. They select an animation mode — they are never read as the
   * answer to "is the game over?", and nothing outside this file can see them.
   */
  #onStateChanged(to) {
    this.#crashing = to === State.GAME_OVER;
    this.#steerable = to === State.PLAYING;
    if (to === State.PLAYING) this.reset();
  }
}
