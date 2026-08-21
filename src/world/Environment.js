import * as THREE from 'three';
import { State } from '../core/GameManager.js';
import { Road } from './Road.js';

/**
 * ARCHITECTURE: Ambient, non-interactive scene
 * Decision: stars, the sky dome and the two scene-wide lights live here; the road is
 *   delegated to Road.js and owned through it. Nothing in this module is collidable and
 *   nothing reads input.
 * Reason: Ownership Map — "everything ambient/non-interactive in the scene". Road is a
 *   sub-module, not a peer: it is constructed here, held privately, and no other module can
 *   reach it, so the ownership boundary the Map draws is intact. It got its own file because
 *   40 lines of GLSL in the middle of this one made both halves harder to read.
 * Trade-off: the road scroll needs the frame's travel distance, so Environment takes a
 *   read-only GameManager reference. It reads `state` and `moveDist` and writes neither.
 * If the sky renders in front of the scene, check that the dome material still has
 *   side: BackSide — from the inside, a front-sided sphere is simply invisible, and the
 *   symptom of getting it backwards is a black frame, not an obviously inverted one.
 */

const STAR_COUNT = 2500;
/**
 * World units, and small on purpose. sizeAttenuation is on, so this is a *world* size: the
 * star field spans z ±200 around a camera sitting at z=12, which means a handful of stars are
 * only a dozen units away and scale up into chunky squares over the road. Turning fog off
 * (below) is what buys the room to keep this near the shipped 0.2 — the far half of the field
 * now contributes instead of being erased, so the sky reads full without leaning on size.
 */
const STAR_SIZE = 0.22;
const STAR_DRIFT = 5;   // units/sec — slow enough to read as parallax, not motion
const STAR_WRAP = 200;

const SKY_RADIUS = 500;      // inside the camera's far plane of 1000, outside everything else
const SKY_HORIZON = 0x1a0033; // deep violet where the road meets it
const SKY_ZENITH = 0x000006;  // effectively black overhead
const SKY_BLEND_LOW = -0.2;   // normalised y at which the gradient starts leaving the horizon
const SKY_BLEND_HIGH = 0.6;

const buildStarField = () => {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);

  // Preserved verbatim from the pre-split build, quirk included: the colour writes below
  // stride by 1 while the loop strides by 1, so each channel is overwritten by its neighbour
  // and the final star's B write falls off the end of the array (a silent no-op on a typed
  // array). The result is the exact blue/white speckle the game currently ships. Rewriting
  // it "correctly" changes the sky, so it stays as is until someone deliberately art-directs
  // the star colours. Only the count above changed.
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

  // fog is off here and it is a real change: FogExp2 at 0.015 erases anything past ~150
  // units, and the stars reach 280, so most of the field was being blended to black before
  // it ever reached the screen — the count could be cut to 2500 partly because a good half
  // of the old 4000 were invisible. Stars are meant to read as infinitely far away; fogging
  // them treats them as objects in the scene, which is the one thing they are not.
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    size: STAR_SIZE, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0.8, fog: false
  }));
};

/**
 * A gradient baked into vertex colours on a low-poly inverted sphere.
 *
 * ADR (Principle IV): the alternatives were a second ShaderMaterial or a CanvasTexture, and
 * both are more machinery than this needs. Interpolating 384 vertex colours across the
 * fragment stage is the same gradient for no shader to maintain and no texture to upload,
 * and MeshBasicMaterial skips lighting entirely — the dome costs one unlit draw call.
 */
const buildSky = () => {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);

  const horizon = new THREE.Color(SKY_HORIZON);
  const zenith = new THREE.Color(SKY_ZENITH);
  const scratch = new THREE.Color(); // one Color for the whole loop, reused per vertex

  for (let i = 0; i < position.count; i++) {
    const height = THREE.MathUtils.smoothstep(position.getY(i) / SKY_RADIUS, SKY_BLEND_LOW, SKY_BLEND_HIGH);
    scratch.copy(horizon).lerp(zenith, height);
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const sky = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false
  }));
  sky.renderOrder = -1; // drawn first, then overdrawn by everything — never occludes
  return sky;
};

export class Environment {
  #stars;
  #road;

  constructor(scene) {
    this.#stars = buildStarField();
    this.#road = new Road(scene);
    scene.add(this.#stars, buildSky());

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
