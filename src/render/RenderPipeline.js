import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { State } from '../core/GameManager.js';
import { BIOME_FADE, OPENING_BIOME, biomeFor } from '../world/biomes.js';

/**
 * ARCHITECTURE: Post-processing chain and the chase camera
 * Decision: RenderPass → (SMAA only when MSAA is unavailable) → UnrealBloom → OutputPass,
 *   drawn through an EffectComposer whose backing target is multisampled where the device
 *   allows it. The camera rig stays in this file.
 * Reason: the Ownership Map gives this module "EffectComposer and pass ordering", and the
 *   camera has nowhere better to live — its FOV and shake are rendering effects, not
 *   gameplay, and no other module reads it. Splitting it out would create a module the
 *   Constitution doesn't name, for one object.
 * Trade-off: bloom is not free. It is bought back by running the pass at half the render
 *   resolution (see #applySizes) and by capping pixel ratio at 2 — Principle III says the
 *   frame budget outranks the look, so the look is what gets sampled down.
 * If the scene renders black, suspect pass order before anything else: OutputPass must be
 *   last, and a chain that ends on a pass with `renderToScreen` unset draws to a target
 *   nobody presents. If it renders washed out, OutputPass is running twice — the renderer's
 *   own tone mapping is deliberately left to it, and applying both double-exposes.
 */

const BASE_FOV = 75;
const CAMERA_Y = 4;
const CAMERA_Z = 12;
const FOV_PER_SPEED = 10;    // hyperspace stretch as the run accelerates
const FOV_LERP_IN = 0.05;
const FOV_LERP_OUT = 0.1;    // snaps back a little faster after a crash
const FOV_EPSILON = 0.01;    // below this the projection matrix is not worth rebuilding
const MAX_PIXEL_RATIO = 2;   // retina looks the same past 2x and costs 4x the fill

const MSAA_SAMPLES = 4;

/**
 * Half the render resolution. Bloom is a stack of wide gaussian blurs — the signal it
 * carries is low-frequency by construction, so the halved buffer is not a visible
 * compromise, it is the correct sampling rate for what the pass actually produces.
 */
const BLOOM_RESOLUTION_SCALE = 0.5;
const BLOOM_RADIUS = 0.55;
/**
 * Tuned against the scene's actual materials, not picked off a tutorial. The composer buffer
 * is linear HDR — tone mapping happens in OutputPass, at the end — so this threshold is
 * compared against pre-ACES values, weighted Rec601 by LuminosityHighPassShader. Everything
 * meant to glow clears it (rails land at luma 1.60, grid line cores at 0.92) and every lit
 * surface is a dark roughness/metalness standard material that peaks well under it. 0.85 is
 * the gap between those two populations. Lowering it toward 0.6 pulls the car's grey chassis
 * and the antialiased edges of the grid lines in, and the whole frame goes milky.
 */
const BLOOM_THRESHOLD = 0.85;
/**
 * Held down to 0.55 rather than the 0.9 this started at. Strength is a multiplier on an
 * already-wide blur, and the rails and grid run the full length of the frame to the vanishing
 * point — there is a lot of qualifying surface, so the pass reaches an oversaturated look far
 * below the strength a scene with a few small emissive props would need. The neon still
 * clearly glows; the sky behind it stays a sky.
 */
const BLOOM_STRENGTH = 0.55;

/**
 * ADR (Principle III): camera shake is a decaying "trauma" scalar, not a per-frame random
 * offset. The previous build jittered the camera every frame by `speed * 0.05`, which made
 * a fast run permanently unreadable and left an impact with nothing to say — the camera was
 * already shaking as hard as it could. Trauma spends its budget where it means something.
 * The square is what makes it read as an impact rather than a rumble: it collapses the tail
 * of the decay fast, so the shake is violent and then simply over.
 */
const TRAUMA_PER_CRASH = 0.9;
const TRAUMA_DECAY = 1.6;     // units/sec — a crash shake lasts a bit over half a second
const TRAUMA_AMPLITUDE = 1.2; // world units at full trauma, before the ±0.5 random factor

/**
 * ADR (Principle II applied to a rendering value): hyperdrive's bloom is a *multiplier* held
 * separately from the biome's strength, never a saved-and-restored copy of it.
 *
 * The obvious implementation is `saved = bloom.strength; bloom.strength *= 1.6` on start and
 * `bloom.strength = saved` on end, and it is wrong in a way that only shows up in play: a biome
 * transition crossing a hyperdrive would have its per-frame writes overwritten on the way in
 * and then be stamped back to a stale value on the way out, leaving the run permanently at the
 * previous biome's bloom. Two owners, one field. Keeping the base and the scale apart means
 * "restore exactly" is not a thing that can be got wrong — ending hyperdrive sets the scale to
 * 1 and re-derives, and whatever the biome had reached in the meantime is simply still there.
 */
const HYPERDRIVE_BLOOM_SCALE = 1.6;

/**
 * Degrees of extra FOV while hyperdrive runs, added to the speed-derived target rather than
 * replacing it — the existing lerp then eases both the push and its release for free, which is
 * why this is one addend and not a second animation. The speed boost already widens the view
 * through FOV_PER_SPEED; this is the part that reads as the *world* rushing in rather than as
 * the car simply going faster.
 */
const HYPERDRIVE_FOV_PUSH = 11;

/**
 * Builds the chain and hands back the pieces that need to stay reachable.
 *
 * ADR (Principle IV / installed API): the Blueprint's Phase 2 line calls for SMAAPass, and
 * the obvious shape here is "MSAA on WebGL2, SMAA on WebGL1". That branch cannot exist on
 * three r171 — the renderer creates a `webgl2` context and nothing else, and
 * `capabilities.isWebGL2` is a hardcoded `true` kept only for backwards compatibility
 * (WebGLCapabilities.js:113). Writing that test would be a dead branch, which Principle V
 * rules out. `maxSamples` is the check that is actually live: it is read from the real
 * GL_MAX_SAMPLES, and a software or otherwise degraded context can report below the 4 the
 * multisampled target asks for. That is the case SMAA covers.
 */
const buildComposer = (renderer, scene, camera) => {
  const { maxSamples } = renderer.capabilities;
  const multisampled = maxSamples >= MSAA_SAMPLES;

  // Sizes here are placeholders — the constructor calls resize() before the first frame,
  // and that is the one code path that gets dimensions right. Passing a target at all is
  // what buys MSAA; EffectComposer's own default target is single-sampled.
  const composer = multisampled
    ? new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
        samples: MSAA_SAMPLES, type: THREE.HalfFloatType
      }))
    : new EffectComposer(renderer);

  composer.addPass(new RenderPass(scene, camera));

  // Only reached when the device cannot give us a multisampled target. Placed before bloom
  // so it resolves geometry edges while they are still hard edges; running it after would
  // hand it a frame the blur has already softened, and it would find nothing to fix.
  if (!multisampled) composer.addPass(new SMAAPass(1, 1));

  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  composer.addPass(bloom);
  composer.addPass(new OutputPass()); // owns tone mapping and the sRGB conversion; must be last

  return { composer, bloom, multisampled };
};

export class RenderPipeline {
  #renderer;
  #composer;
  #bloom;
  #camera;
  #game;
  #trauma = 0;

  // The bloom strength the biome asks for, and the multiplier hyperdrive lays over it. The pass
  // only ever sees their product — see #applyBloom and the ADR above.
  #bloomBase = BLOOM_STRENGTH;
  #bloomScale = 1;

  // This module's own copy of the biome cross-fade. Environment runs the same clock for the
  // scene's half of it; both read BIOME_FADE, so they cannot disagree about duration.
  #fromBloom = OPENING_BIOME.bloom;
  #toBloom = OPENING_BIOME.bloom;
  #biomeProgress = 1;

  #fovBoost = 0;

  constructor(canvas, scene, game, bus) {
    this.#game = game;

    this.#camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.#camera.position.set(0, CAMERA_Y, CAMERA_Z);
    // Aimed exactly once. The shake below nudges position without re-aiming, so the view
    // swings very slightly rather than tracking a fixed point — that drift is half of why
    // the impact reads as violent. Calling lookAt per frame would kill it.
    this.#camera.lookAt(0, 0, 0);

    // `antialias` is deliberately off: the composer never renders the scene to the canvas
    // directly, so the context's own AA buffer would be allocated and never written to.
    this.#renderer = new THREE.WebGLRenderer({ canvas });
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const built = buildComposer(this.#renderer, scene, this.#camera);
    this.#composer = built.composer;
    this.#bloom = built.bloom;

    if (!built.multisampled) {
      console.info('RenderPipeline: MSAA unavailable on this context, falling back to SMAAPass');
    }

    // Subscribed rather than polled: a crash is a discrete event, and reading GAME_OVER off
    // the state each frame could not tell a fresh impact from the second frame after one.
    bus.on('crashed', () => { this.#trauma = Math.min(1, this.#trauma + TRAUMA_PER_CRASH); });

    bus.on('tierChanged', ({ tier }) => this.#shiftBloom(biomeFor(tier).bloom));
    // A fresh run resets the tier silently (see GameManager.start), so the snap back has to
    // come off the state change. A resume is excluded — it enters PLAYING too.
    bus.on('stateChanged', ({ from, to }) => {
      if (to === State.PLAYING && from !== State.PAUSED) this.#snapBloom(OPENING_BIOME.bloom);
    });

    // Only hyperdrive touches the renderer. Shield and magnet are gameplay, and a pipeline that
    // switched on all three would be reaching for effects nobody asked it to own.
    bus.on('powerupStarted', ({ kind }) => this.#setHyperdrive(kind, true));
    bus.on('powerupEnded', ({ kind }) => this.#setHyperdrive(kind, false));

    this.resize(); // the single place sizes are computed — boot goes through it too
  }

  /**
   * The one hook Blueprint Phase 3's environment shifts need, and it still is one: writing
   * `bloom.strength` is genuinely all it takes — UnrealBloomPass reads the field at render
   * time, so there is no rebuild and no cost to ramping it every frame.
   *
   * What changed in S7 is that the value handed in is now the *base*, not the final strength.
   * Anything transient stacking on top (today, only hyperdrive) multiplies rather than
   * overwrites, so a caller ramping a biome here never has to know what else is running.
   */
  setBloomStrength(value) {
    this.#bloomBase = value;
    this.#applyBloom();
  }

  /**
   * Read-only observability, and deliberately not a matching pair of setters. Both values are
   * derived every frame from things this module already owns — the biome base times the
   * hyperdrive scale, and the speed-plus-boost FOV lerp — so a setter would be a second writer
   * for a number with a perfectly good first one. Exposing the result costs nothing and makes
   * "did the bloom actually go back to exactly where it was" a question that can be answered
   * from outside instead of inferred from a screenshot.
   */
  get bloomStrength() { return this.#bloom.strength; }
  get cameraFov() { return this.#camera.fov; }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();

    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.#renderer.setSize(width, height);
    this.#composer.setPixelRatio(this.#renderer.getPixelRatio());
    this.#composer.setSize(width, height);

    // Deliberately after composer.setSize, and deliberately overriding it. setSize hands
    // every pass the full device-pixel size, which would put bloom back at full resolution;
    // this is what actually holds it at BLOOM_RESOLUTION_SCALE. Losing this line costs no
    // pixels and roughly quadruples the pass's fill cost, silently.
    const ratio = this.#renderer.getPixelRatio();
    this.#bloom.setSize(width * ratio * BLOOM_RESOLUTION_SCALE, height * ratio * BLOOM_RESOLUTION_SCALE);
  }

  render(dt) {
    this.#advanceBloom(dt);
    this.#updateFov();
    this.#updateShake(dt);
    this.#composer.render(dt);
  }

  #applyBloom() {
    this.#bloom.strength = this.#bloomBase * this.#bloomScale;
  }

  /** Silent when the new tier maps to the same biome — four biomes over six tiers means it often does. */
  #shiftBloom(target) {
    if (target === this.#toBloom) return;
    // Interrupting a fade resumes from wherever it had reached, not from where it started.
    this.#fromBloom = this.#bloomBase;
    this.#toBloom = target;
    this.#biomeProgress = 0;
  }

  #snapBloom(target) {
    this.#fromBloom = target;
    this.#toBloom = target;
    this.#biomeProgress = 1;
    this.setBloomStrength(target);
  }

  #advanceBloom(dt) {
    if (this.#biomeProgress >= 1) return; // settled: no lerp, no write
    this.#biomeProgress = Math.min(1, this.#biomeProgress + dt / BIOME_FADE);
    this.setBloomStrength(this.#fromBloom + (this.#toBloom - this.#fromBloom) * this.#biomeProgress);
  }

  #setHyperdrive(kind, on) {
    if (kind !== 'hyperdrive') return;
    this.#bloomScale = on ? HYPERDRIVE_BLOOM_SCALE : 1;
    this.#fovBoost = on ? HYPERDRIVE_FOV_PUSH : 0;
    this.#applyBloom();
  }

  /**
   * ADR (Principle III): the projection matrix is rebuilt only when the FOV moved enough to
   * see. The lerp is asymptotic, so it never reaches its target and the old code rebuilt the
   * matrix on every frame of a run for changes in the fourth decimal place. FOV_EPSILON is
   * two orders of magnitude below one pixel of vertical shift at this resolution.
   */
  #updateFov() {
    const { state, speed } = this.#game;

    let target;
    // #fovBoost is only ever non-zero during PLAYING (GameManager ends every power-up on
    // game-over), so it rides on the speed term rather than needing a branch of its own.
    if (state === State.PLAYING) target = BASE_FOV + speed * FOV_PER_SPEED + this.#fovBoost;
    else if (state === State.GAME_OVER) target = BASE_FOV;
    else return; // menu and pause hold whatever the last run left, exactly as before

    const rate = state === State.PLAYING ? FOV_LERP_IN : FOV_LERP_OUT;
    const next = THREE.MathUtils.lerp(this.#camera.fov, target, rate);

    if (Math.abs(next - this.#camera.fov) < FOV_EPSILON) return;
    this.#camera.fov = next;
    this.#camera.updateProjectionMatrix();
  }

  /**
   * Runs in every state on purpose. Trauma is set on the crash frame, which is the frame the
   * game leaves PLAYING — gating this on the state would fire the shake and then immediately
   * stop drawing it. Once trauma decays to zero the camera sits exactly on its base position,
   * so the calm case costs two assignments and no drift.
   */
  #updateShake(dt) {
    if (this.#trauma <= 0) return;

    this.#trauma = Math.max(0, this.#trauma - TRAUMA_DECAY * dt);
    const magnitude = this.#trauma * this.#trauma * TRAUMA_AMPLITUDE;

    this.#camera.position.x = (Math.random() - 0.5) * magnitude;
    this.#camera.position.y = CAMERA_Y + (Math.random() - 0.5) * magnitude;

    // Settle exactly, rather than wherever the last random sample landed.
    if (this.#trauma === 0) this.#camera.position.set(0, CAMERA_Y, CAMERA_Z);
  }
}
