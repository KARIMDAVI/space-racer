import * as THREE from 'three';
import { State } from '../core/GameManager.js';
import { Road } from './Road.js';

/**
 * ARCHITECTURE: Ambient, non-interactive scene
 * Decision: stars and the two scene-wide lights live here; the road is delegated to Road.js
 *   and owned through it. Nothing in this module is collidable and nothing reads input.
 * Reason: Ownership Map — "everything ambient/non-interactive in the scene". Road is a
 *   sub-module, not a peer: it is constructed here, held privately, and no other module can
 *   reach it, so the ownership boundary the Map draws is intact. It got its own file because
 *   40 lines of GLSL in the middle of this one made both halves harder to read.
 * Trade-off: the road scroll needs the frame's travel distance, so Environment takes a
 *   read-only GameManager reference. It reads `state` and `moveDist` and writes neither.
 */

const STAR_COUNT = 4000;
const STAR_DRIFT = 5;   // units/sec — slow enough to read as parallax, not motion
const STAR_WRAP = 200;

const buildStarField = () => {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);

  // Preserved verbatim from the pre-split build, quirk included: the colour writes below
  // stride by 1 while the loop strides by 1, so each channel is overwritten by its neighbour
  // and the final star's B write falls off the end of the array (a silent no-op on a typed
  // array). The result is the exact blue/white speckle the game currently ships. Rewriting
  // it "correctly" changes the sky, so it stays as is until someone deliberately art-directs
  // the star colours.
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

export class Environment {
  #stars;
  #road;

  constructor(scene) {
    this.#stars = buildStarField();
    this.#road = new Road(scene);
    scene.add(this.#stars);

    scene.add(new THREE.AmbientLight(0xffffff, 0.3));

    const sun = new THREE.DirectionalLight(0xaabbff, 0.5);
    sun.position.set(100, 100, 50);
    scene.add(sun);
  }

  update(dt, game) {
    // Stars drift in every state, including the menu — that's what keeps the title screen
    // from looking like a still image. Only the road stops when the game does.
    this.#stars.position.z += STAR_DRIFT * dt;
    if (this.#stars.position.z > STAR_WRAP) this.#stars.position.z = 0;

    if (game.state !== State.PLAYING) return;

    this.#road.update(game.moveDist);
  }
}
