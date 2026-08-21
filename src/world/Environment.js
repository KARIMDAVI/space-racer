import * as THREE from 'three';
import { State } from '../core/GameManager.js';

/**
 * ARCHITECTURE: Ambient, non-interactive scene
 * Decision: stars, the scrolling neon grid, and the two scene-wide lights live
 *   here. Nothing in this module is collidable and nothing reads input.
 * Reason: Ownership Map — "everything ambient/non-interactive in the scene".
 * Trade-off: the grid scroll needs the frame's travel distance, so Environment
 *   takes a read-only GameManager reference. It reads `state` and `moveDist` and
 *   writes neither; the one-way direction is what keeps Principle II intact.
 * If the road looks like it's teleporting, the wrap threshold and the grid's own
 *   size have drifted apart — GRID_SPAN must equal the GridHelper's extent and the
 *   offset of the second helper, or the seam becomes visible once per lap.
 */

const STAR_COUNT = 4000;
const STAR_DRIFT = 5;   // units/sec — slow enough to read as parallax, not motion
const STAR_WRAP = 200;
const GRID_SPAN = 200;  // matches the GridHelper size below; see the note above

const buildStarField = () => {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);

  // Preserved verbatim from the pre-split build, quirk included: the colour writes
  // below stride by 1 while the loop strides by 1, so each channel is overwritten by
  // its neighbour and the final star's B write falls off the end of the array (a
  // silent no-op on a typed array). The result is the exact blue/white speckle the
  // game currently ships. Rewriting it "correctly" changes the sky, so it stays as
  // is until someone deliberately art-directs the star colours.
  for (let i = 0; i < STAR_COUNT * 3; i++) {
    if (i % 3 === 0) positions[i] = (Math.random() - 0.5) * 400;      // x
    if (i % 3 === 1) positions[i] = (Math.random() - 0.5) * 200 + 50; // y, biased overhead
    if (i % 3 === 2) positions[i] = (Math.random() - 0.5) * 400;      // z

    colors[i] = Math.random() > 0.8 ? 1.0 : 0.6;
    colors[i + 1] = Math.random() > 0.8 ? 0.6 : 0.8;
    colors[i + 2] = Math.random() > 0.5 ? 1.0 : 0.8;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  return new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 0.2, vertexColors: true, transparent: true, opacity: 0.8
  }));
};

/** Two grid tiles chased end to end — cheaper than one huge grid, and it wraps clean. */
const buildGrid = () => {
  const group = new THREE.Group();
  for (const [z, over, under] of [[0, 0xff8800, 0xff5500], [-GRID_SPAN, 0xffaa00, 0x552200]]) {
    const helper = new THREE.GridHelper(GRID_SPAN, 50, over, under);
    helper.position.set(0, -1, z);
    helper.material.transparent = true;
    helper.material.opacity = 0.5;
    group.add(helper);
  }
  return group;
};

export class Environment {
  #stars;
  #grid;

  constructor(scene) {
    this.#stars = buildStarField();
    this.#grid = buildGrid();
    scene.add(this.#stars, this.#grid);

    scene.add(new THREE.AmbientLight(0xffffff, 0.3));

    const sun = new THREE.DirectionalLight(0xaabbff, 0.5);
    sun.position.set(100, 100, 50);
    scene.add(sun);
  }

  update(dt, game) {
    // Stars drift in every state, including the menu — that's what keeps the title
    // screen from looking like a still image. Only the road stops when the game does.
    this.#stars.position.z += STAR_DRIFT * dt;
    if (this.#stars.position.z > STAR_WRAP) this.#stars.position.z = 0;

    if (game.state !== State.PLAYING) return;

    this.#grid.position.z += game.moveDist;
    if (this.#grid.position.z > GRID_SPAN) this.#grid.position.z -= GRID_SPAN;
  }
}
