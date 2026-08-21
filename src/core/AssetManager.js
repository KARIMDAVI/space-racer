import * as THREE from 'three';

/**
 * ARCHITECTURE: Asset loading
 * Decision: one module owning `THREE.LoadingManager`, exposing exactly one loader —
 *   the audio-buffer fetch S5 needs — and reporting that fetch through the manager's
 *   item bookkeeping so the count is honest from the first asset onward.
 * Reason: Ownership Map gives this module "THREE.LoadingManager and all preload
 *   sequencing". Three ships loaders for models and textures that take a
 *   LoadingManager in their constructor, but it has nothing for audio: an AudioBuffer
 *   has to be decoded by an AudioContext, which is AudioManager's to own. So the
 *   division is deliberate — this module owns *when and whether bytes arrive*,
 *   AudioManager owns *what happens to them*. `decodeAudioData` is called with a
 *   context passed in, never one this module created.
 * Trade-off: no progress UI. S5's only asset is an optional music track that loads
 *   after the run has already started, so the player never waits on it — a loading
 *   screen here would be a screen that never appears, which Principle V rules out
 *   just as firmly as it rules out a TODO. The manager is wired to count and to
 *   report errors; the moment a `.glb` blocks the first frame, the progress hook
 *   goes on top of a count that is already correct.
 * If a load yields null, check in this order: 1) the asset really shipped — callers
 *   resolve URLs through `import.meta.glob` at build time, so a miss here means the
 *   emitted file did not survive the deploy, 2) the bytes are a container this browser
 *   can decode (`decodeAudioData` is the strictest consumer in the stack), 3) the
 *   fetch was not blocked cross-origin, which fails before the status is ever read.
 */
export class AssetManager {
  #manager = new THREE.LoadingManager();

  constructor() {
    // The manager's own error channel, rather than a console.warn at each call site.
    // Every loader added later reports here for free; the alternative is remembering
    // to log in each one, which is the kind of thing that gets remembered twice and
    // then forgotten.
    this.#manager.onError = (url) => console.warn(`AssetManager: could not load ${url}`);
  }

  /**
   * Resolves to a decoded AudioBuffer, or to null if the asset could not be loaded.
   *
   * Never rejects. Callers fire these off without awaiting them (a run must not wait on
   * a background asset), and a rejected fire-and-forget promise surfaces as an
   * unhandled rejection in the console — an error report for a game that is otherwise
   * working perfectly and merely quiet. Returning null makes the caller handle it.
   */
  async loadAudioBuffer(url, ctx) {
    this.#manager.itemStart(url);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await ctx.decodeAudioData(await response.arrayBuffer());
    } catch {
      // Every URL that reaches this method was resolved from the source tree at build
      // time, so the asset is supposed to exist — "not there" is not a case handled
      // here, it is decided by the caller before calling. Anything that fails at this
      // point is a broken deploy or corrupt bytes, and is reported as the error it is.
      this.#manager.itemError(url);
      return null;
    } finally {
      // Runs on both paths. Skipping it on the error path is how a LoadingManager
      // ends up permanently mid-load and never fires onLoad again.
      this.#manager.itemEnd(url);
    }
  }
}
