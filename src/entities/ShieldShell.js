import * as THREE from 'three';
import { ParticleEmitter } from '../render/ParticleEmitter.js';

/**
 * ARCHITECTURE: The shield bubble
 * Decision: a low-poly icosahedron with a wireframe overlay, plus the burst it throws when it
 *   breaks. Owned and driven by PlayerCar, which is the only caller — this file holds no game
 *   state, subscribes to nothing, and does not know what a power-up is. It is told to raise,
 *   told to drop, and told the car's position each frame.
 * Reason: Principle I as PlayerCar already applies it to the underglow and its two emitters —
 *   the thing the shell surrounds is the car, so the car owns it. Its own file rather than
 *   another 80 lines inside PlayerCar because PlayerCar was already at 293 and this is a
 *   self-contained visual with its own animation clock.
 * Trade-off: two files to read to understand what happens when a shield breaks. Paid for by
 *   PlayerCar staying about the car's motion.
 * If the bubble renders as a solid ball, the fill material lost `transparent` or its additive
 *   blending — at opacity 1 an unlit basic material is exactly that, and the wireframe then
 *   disappears inside it rather than the two reading as one shell.
 */

/**
 * Deliberately *not* parented to the car group, for two reasons that both bite. The car banks
 * up to 0.3 radians through a turn, and a shell that rolled with it would read as bodywork
 * bolted on rather than as a field around the car. And PlayerCar measures its hitbox with
 * Box3.setFromObject over the group — anything parented into it lands in that measurement, and
 * a 2.6-radius sphere would roughly double the car's collision box. The underglow is unparented
 * for the same second reason; this is that precedent, not a new one.
 */
const RADIUS = 2.6;
const DETAIL = 1;   // 80 faces — a geodesic dome, not a sphere, and the facets are the look

const COLOR = 0x33ddff;         // the crate's own ice blue, so the pickup and the effect match
const FILL_OPACITY = 0.13;
const WIRE_OPACITY = 0.5;

/** Seconds. The raise is a snap because it has to beat the obstacle you grabbed it in front of. */
const RAISE_TIME = 0.18;
const FADE_TIME = 0.45;         // a natural expiry dissolves; a break does not use this at all

const PULSE_RATE = 3.2;         // rad/sec
const PULSE_DEPTH = 0.035;      // fraction of radius
const CENTRE_Y = 0.55;          // the car's rough centre of mass, so the shell is not sitting low

/**
 * The pop. Short-lived and drag-heavy so the shards stop almost where the shell was, which
 * reads as the surface shattering in place rather than as debris being thrown.
 */
const POP = Object.freeze({
  max: 90, color: 0x8ce9ff, size: 0.3, gravity: 0, drag: 2.2, life: 0.5
});
const POP_COUNT = 70;
const POP_SPEED = Object.freeze([4, 13]);

export class ShieldShell {
  #group;
  #fill;
  #wire;
  #pop;

  #age = 0;
  #alpha = 0;      // 0..1, drives both materials' opacity and the raise/fade
  #target = 0;     // what #alpha is heading for; 1 while up, 0 while dissolving

  constructor(scene) {
    const geometry = new THREE.IcosahedronGeometry(RADIUS, DETAIL);

    this.#fill = new THREE.MeshBasicMaterial({
      color: COLOR,
      transparent: true,
      opacity: FILL_OPACITY,
      // Additive so the shell brightens whatever is behind it instead of tinting it, which is
      // what makes it read as energy. DoubleSide because the camera sits inside it at times.
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false   // never occludes the car it surrounds
    });
    this.#wire = new THREE.LineBasicMaterial({ color: COLOR, transparent: true, opacity: WIRE_OPACITY });

    this.#group = new THREE.Group();
    this.#group.add(new THREE.Mesh(geometry, this.#fill));
    // WireframeGeometry rather than EdgesGeometry: EdgesGeometry drops edges between coplanar
    // faces, and on a subdivided icosahedron that erases most of the lattice — the whole point
    // of the shape is that every facet is drawn.
    this.#group.add(new THREE.LineSegments(new THREE.WireframeGeometry(geometry), this.#wire));
    this.#group.visible = false;
    scene.add(this.#group);

    this.#pop = new ParticleEmitter(scene, POP);
  }

  /** Idempotent: GameManager re-emits powerupStarted on a refresh, and a raised shell stays raised. */
  raise() {
    this.#target = 1;
    this.#group.visible = true;
  }

  /**
   * `broken` is the whole distinction between a shield that was spent and one that ran out.
   * A break is instant and violent — the burst *is* the animation, so there is nothing left to
   * fade. An expiry dissolves, because a shell that vanished on a timer with no impact behind
   * it would read as a rendering glitch.
   */
  drop(broken) {
    this.#target = 0;
    if (!broken) return;

    this.#pop.emitBurst(this.#group.position, POP_COUNT, RADIUS * 0.92, POP_SPEED);
    this.#alpha = 0;
    this.#group.visible = false;
  }

  /**
   * Runs in every state PlayerCar does, including GAME_OVER — the pop from a shield broken on
   * the frame the run ended still has half a second of particles to spend.
   */
  update(dt, carPosition) {
    this.#pop.update(dt);
    if (!this.#group.visible) return;

    this.#age += dt;
    this.#group.position.set(carPosition.x, carPosition.y + CENTRE_Y, carPosition.z);

    // One rate for the way up and another for the way down, rather than a lerp toward a target:
    // a shield has to be visibly *there* before the impact it was collected for, and the same
    // curve that does that would make the expiry snap out just as hard.
    const rate = this.#target > this.#alpha ? dt / RAISE_TIME : -dt / FADE_TIME;
    this.#alpha = Math.min(1, Math.max(0, this.#alpha + rate));

    if (this.#alpha === 0) {
      this.#group.visible = false; // fully dissolved: out of the render walk entirely
      return;
    }

    // Breathing, and it is not decoration — a perfectly static shell is indistinguishable from
    // a modelling artefact, while one that pulses is obviously a running effect with a clock.
    const pulse = 1 + Math.sin(this.#age * PULSE_RATE) * PULSE_DEPTH;
    this.#group.scale.setScalar(pulse);

    this.#fill.opacity = FILL_OPACITY * this.#alpha;
    this.#wire.opacity = WIRE_OPACITY * this.#alpha;
  }

  /** The restart path needs it, for the same reason PlayerCar clears its emitters. */
  clear() {
    this.#target = 0;
    this.#alpha = 0;
    this.#group.visible = false;
    this.#pop.clear();
  }
}
