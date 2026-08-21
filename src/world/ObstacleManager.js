import * as THREE from 'three';
import { State } from '../core/GameManager.js';

/**
 * ARCHITECTURE: Obstacle lifecycle
 * Decision: this module owns the obstacle array, spawning, motion, collision and
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

const LANE_WIDTH = 3;
const LANE_COUNT = 5;           // lanes -2..2
const WALL_CHANCE = 0.8;        // Math.random() above this spawns a wide wall (~20%)
const SPAWN_Z = -200;           // just beyond the fog, so obstacles fade in
const DESPAWN_Z = 20;           // safely behind the camera
const COLLISION_WINDOW = 10;    // only bounds-test obstacles within ±this of the car
const MIN_SPAWN_DELAY = 0.3;
const SPAWN_DELAY_BASE = 1.5;
const SPAWN_DELAY_PER_SPEED = 0.2;
const CAR_HITBOX_SHRINK = 0.4;  // forgiving: the player's box is smaller than the car
const OBSTACLE_HITBOX_SHRINK = 0.2;

export class ObstacleManager {
  #scene;
  #bus;
  #obstacles = [];
  #spawnTimer = 0;

  // Scratch bounds reused every frame. Principle III: `new THREE.Box3()` twice per
  // frame is 120 short-lived objects a second handed to the GC for no reason.
  #carBox = new THREE.Box3();
  #obstacleBox = new THREE.Box3();

  constructor(scene, bus) {
    this.#scene = scene;
    this.#bus = bus;
    bus.on('stateChanged', ({ to }) => {
      if (to === State.PLAYING) this.reset();
    });
  }

  reset() {
    for (const obstacle of this.#obstacles) this.#scene.remove(obstacle);
    this.#obstacles.length = 0;
    // #spawnTimer is deliberately NOT cleared: it only advances while playing, so it
    // carries the crash frame's value into the next run and the first obstacle of
    // run two arrives on run one's clock. That is the shipped behaviour and the S1
    // gate is "identical", so it is preserved rather than quietly corrected.
  }

  update(dt, game, player) {
    if (game.state !== State.PLAYING) return;

    this.#spawnTimer += dt;
    const spawnDelay = Math.max(MIN_SPAWN_DELAY, SPAWN_DELAY_BASE - game.speed * SPAWN_DELAY_PER_SPEED);
    if (this.#spawnTimer > spawnDelay) {
      this.#spawn();
      this.#spawnTimer = 0;
    }

    // Computed once per frame, not once per obstacle — the car doesn't move between
    // tests, and setFromObject walks the whole car hierarchy.
    const carBox = this.#carBox.setFromObject(player.object3d).expandByScalar(-CAR_HITBOX_SHRINK);
    const { moveDist } = game;

    for (let i = this.#obstacles.length - 1; i >= 0; i--) {
      const obstacle = this.#obstacles[i];
      obstacle.position.z += moveDist;

      if (obstacle.position.z > -COLLISION_WINDOW && obstacle.position.z < COLLISION_WINDOW) {
        const obstacleBox = this.#obstacleBox
          .setFromObject(obstacle)
          .expandByScalar(-OBSTACLE_HITBOX_SHRINK);

        if (carBox.intersectsBox(obstacleBox)) {
          this.#bus.emit('crashed', { position: obstacle.position.clone() });
          break; // remaining obstacles hold position this frame, exactly as before
        }
      }

      if (obstacle.position.z > DESPAWN_Z) {
        this.#scene.remove(obstacle);
        this.#obstacles.splice(i, 1);
      }
    }
  }

  #spawn() {
    const lane = Math.floor(Math.random() * LANE_COUNT) - 2;
    const isWall = Math.random() > WALL_CHANCE;

    // Allocating geometry and material per spawn is the pattern the pool replaces in
    // the next step. Left untouched here on purpose: this is the exact code that
    // step is scoped to delete, and pre-optimising it would give it a moving target.
    const geometry = isWall ? new THREE.BoxGeometry(8, 2, 1) : new THREE.BoxGeometry(2, 2, 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0x222222, roughness: 0.5, metalness: 0.5
    }));

    // Red neon outline — the only thing that reads as "danger" against black fog.
    mesh.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xff0044, linewidth: 2 })
    ));

    mesh.position.set(lane * LANE_WIDTH, -0.5, SPAWN_Z);
    this.#scene.add(mesh);
    this.#obstacles.push(mesh);
  }
}
