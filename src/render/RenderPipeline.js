import * as THREE from 'three';
import { State } from '../core/GameManager.js';

/**
 * ARCHITECTURE: Rendering and camera
 * Decision: a thin wrapper over a plain WebGLRenderer plus the chase camera and its
 *   speed effects. No EffectComposer yet.
 * Reason: the Ownership Map names this module the owner of post-processing, so the
 *   seam has to exist before bloom can be dropped in. Building the composer now,
 *   with no passes to put in it, would be a placeholder (Principle V) and would
 *   move the frame-budget goalposts before there's anything to measure.
 * Trade-off: `render(dt)` currently ignores dt, and the camera effects it does run
 *   are frame-rate dependent lerps. Both are inherited and both are on the list for
 *   the rendering step; changing them here would change how the game feels, which
 *   is precisely what this refactor promised not to do.
 * If the view is stretched or blurry after a resize, check that resize() is being
 *   called at all — main.js owns that listener, not this module.
 */

const BASE_FOV = 75;
const CAMERA_Y = 4;
const CAMERA_Z = 12;
const FOV_PER_SPEED = 10;    // hyperspace stretch as the run accelerates
const FOV_LERP_IN = 0.05;
const FOV_LERP_OUT = 0.1;    // snaps back a little faster after a crash
const SHAKE_SCALE = 0.05;
const MAX_PIXEL_RATIO = 2;   // retina looks the same past 2x and costs 4x the fill

export class RenderPipeline {
  #renderer;
  #camera;
  #scene;
  #game;

  constructor(canvas, scene, game) {
    this.#scene = scene;
    this.#game = game;

    this.#camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.#camera.position.set(0, CAMERA_Y, CAMERA_Z);
    // Aimed exactly once. The shake below nudges position without re-aiming, so the
    // view swings very slightly rather than tracking a fixed point — that drift is
    // half of why the speed effect reads as violent. Calling lookAt per frame would
    // kill it.
    this.#camera.lookAt(0, 0, 0);

    this.#renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    this.#renderer.setSize(window.innerWidth, window.innerHeight);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  }

  resize() {
    this.#camera.aspect = window.innerWidth / window.innerHeight;
    this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render(dt) {
    const { state, speed } = this.#game;

    if (state === State.PLAYING) {
      const shake = (Math.random() - 0.5) * speed * SHAKE_SCALE;
      this.#camera.position.x = shake;
      this.#camera.position.y = CAMERA_Y + shake;
      this.#camera.fov = THREE.MathUtils.lerp(this.#camera.fov, BASE_FOV + speed * FOV_PER_SPEED, FOV_LERP_IN);
      this.#camera.updateProjectionMatrix();
    } else if (state === State.GAME_OVER) {
      this.#camera.fov = THREE.MathUtils.lerp(this.#camera.fov, BASE_FOV, FOV_LERP_OUT);
      this.#camera.updateProjectionMatrix();
    }

    this.#renderer.render(this.#scene, this.#camera);
  }
}
