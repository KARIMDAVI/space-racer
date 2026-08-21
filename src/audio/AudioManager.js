import { BASE_SPEED, SPEED_CEILING, State } from '../core/GameManager.js';
import {
  ENGINE_SUB_RATIO,
  createEngineVoice,
  createNoiseBuffer,
  createWindVoice,
  holdParam,
  playBlip,
  playNoiseBurst
} from './voices.js';

/**
 * ARCHITECTURE: Sound
 * Decision: raw Web Audio — one AudioContext, opened on the first user gesture that
 *   reaches this module, feeding a small bus (master ← music, sfx). Continuous voices
 *   (engine, wind) are built once and modulated forever; one-shots (crash, UI ticks)
 *   build a throwaway graph per trigger and disconnect themselves when they end. The
 *   voices themselves live in `voices.js`; this file owns the context, the lifecycle,
 *   the mix, and every decision about what plays when.
 * Reason: Principle IV. Howler and Tone.js are 30-100KB gzipped and both exist to
 *   solve problems this game does not have — sprite sheets, format fallback matrices,
 *   a transport clock, a synthesis DSL. What is actually needed is a gain tree, two
 *   oscillators and a noise buffer. The one thing a library would genuinely buy is
 *   codec fallback, and there is no codec to fall back from: everything here is
 *   synthesised, and the single optional file asset can be whatever the person
 *   dropping it in wants.
 * Trade-off: no cross-browser shims. The node-constructor form (`new GainNode(ctx)`)
 *   and unprefixed AudioContext are the baseline — Safari 14.1+, Chrome 55+,
 *   Firefox 53+. A `webkitAudioContext` fallback would be a dead branch, since every
 *   browser old enough to need it also lacks the constructors used throughout.
 *
 * ADR (Principle III — per-frame allocation): the one-shot helpers do create nodes at
 * trigger time, and that is not the violation it looks like. Principle III targets
 * per-*frame* work; a crash is once per run and a UI tick is once per click, so the
 * ceiling is single digits per minute rather than 60 per second. It is also the only
 * pattern Web Audio permits: an OscillatorNode and an AudioBufferSourceNode are
 * single-use by specification — once stopped, a source can never be restarted — so
 * "pool the sources" is not available. What *is* poolable is everything continuous,
 * and all of it is pooled: the engine's two oscillators, the wind loop, and the noise
 * AudioBuffer, generated once and shared by the wind and by every crash burst. The
 * per-frame path (`update`) allocates nothing at all.
 *
 * If it is silent, check in this order: 1) `ctx.state` — a context that was never
 * given a gesture reads 'suspended', 2) the mute flag in localStorage under
 * `spaceracer.v1`, which survives reloads by design, 3) the master gain, which is
 * ramped rather than switched and so is briefly mid-slide after a toggle.
 */

// --- Mix. Everything sums into one master, so these are the numbers that decide
// whether the bus clips. Held well under 1.0 on purpose: four voices can be live at
// once (engine, sub, wind, a one-shot) and headroom is cheaper than a limiter.
const MASTER_GAIN = 0.5;
const MUSIC_GAIN = 0.35;
const SFX_GAIN = 0.6;
const MUTE_RAMP = 0.03;  // seconds — a hard 0 on a live oscillator is an audible click

/**
 * --- Engine performance. (The engine's *timbre* is in voices.js; these map the run onto it.)
 *
 * ADR: written as the two *endpoints* of GameManager's speed range and imported from it,
 * rather than as a slope with the top of the range left implicit. The previous form was
 * `52 + speed * 40`, above a comment reading "roughly 1.0 → 2.5 over a long run, so that is
 * the range tuned for" — and the range was never 1.0 → 2.5. Speed was unbounded, so the run
 * simply kept walking up the slope: the cutoff passed Nyquist at speed ~26.3 and every
 * parameter write after that logged a BiquadFilter range warning. The tuning was not wrong,
 * its unstated assumption was, and the fix for that is to stop leaving it unstated. If the
 * ceiling moves, these follow it; a stale comment cannot lie about the top of the range
 * because there is no longer a comment holding that number.
 *
 * The value at BASE_SPEED is preserved to the digit, because that one *was* verified — it is
 * what every run has sounded like in its opening seconds. The value at the ceiling is a
 * fresh choice: one octave over the whole run reads as a motor winding out, where the old
 * slope extended to the real ceiling would have put the top of a long run at 244Hz, which is
 * a whine rather than an engine, and is where an unbounded run then sat forever.
 */
const ENGINE_HZ_AT_BASE = 92;         // exactly what the old 52 + 40 * 1.0 produced
const ENGINE_HZ_AT_CEILING = 184;     // one octave up, and the top of the range for good
const ENGINE_CUTOFF_AT_BASE = 1220;   // exactly what the old 320 + 900 * 1.0 produced
/** Holds the old tuning's cutoff-to-fundamental ratio (~17) at the top, so the timbre lands the same. */
const ENGINE_CUTOFF_AT_CEILING = 3200;

const SPEED_SPAN = SPEED_CEILING - BASE_SPEED;
const ENGINE_HZ_PER_SPEED = (ENGINE_HZ_AT_CEILING - ENGINE_HZ_AT_BASE) / SPEED_SPAN;
const ENGINE_BASE_HZ = ENGINE_HZ_AT_BASE - ENGINE_HZ_PER_SPEED * BASE_SPEED;
const ENGINE_CUTOFF_PER_SPEED = (ENGINE_CUTOFF_AT_CEILING - ENGINE_CUTOFF_AT_BASE) / SPEED_SPAN;
const ENGINE_CUTOFF_BASE = ENGINE_CUTOFF_AT_BASE - ENGINE_CUTOFF_PER_SPEED * BASE_SPEED;
const ENGINE_GAIN = 0.22;
const ENGINE_GLIDE = 0.12;         // setTargetAtTime constant — pitch chases speed, never jumps
const ENGINE_FADE = 0.25;          // slower, so leaving PLAYING is a spin-down not a cut

/**
 * --- Wind performance. Linear in speed now, where it used to be `speed * speed * 0.055`.
 *
 * The square was there for dynamic range, not for physics: the note it replaces argued that
 * "a linear ramp leaves the bottom of the speed range as breezy as the top of it", which was
 * true of the 2.5x span it assumed. Over the ceiling's real 4.8x span linear already opens a
 * wider gap than the square opened over 2.5x, so the square is no longer buying anything —
 * and it had become actively harmful, because squaring a speed 4.8 gives a gain of 1.27 on a
 * bus this file's own header keeps "well under 1.0 on purpose". The run would have ended as
 * wind with an engine somewhere underneath it.
 *
 * The coefficient is deliberately the same 0.055, dropping only the exponent: the launch
 * level is therefore bit-identical to before, and the top of the run lands at 0.264 — inside
 * the 0.344 the old tuning was aiming at, with the headroom back.
 */
const NOISE_SECONDS = 2;           // long enough that the loop point is not a rhythm
const WIND_GAIN_PER_SPEED = 0.055; // speed 1.0 → 0.055 (unchanged), ceiling → 0.264
const WIND_GLIDE = 0.3;            // lazier than the engine; wind should lag the throttle

/**
 * ADR (Principle III): the same trick RenderPipeline uses on the projection matrix.
 * `speed` is asymptotic and moves by ~0.01/sec, so re-targeting every parameter every
 * frame would push ~300 automation events per second onto the param timelines for
 * changes in the third decimal place. Below this threshold nothing is retargeted at
 * all. 0.004 works out to a retarget roughly twice a second, which the 0.12s glide
 * smooths into a continuous slide — and 0.004 of speed is under 0.1Hz, far below what an
 * ear resolves at these frequencies. (The "asymptotic" above was aspirational when it was
 * written and is now literally true, which only makes the throttle cheaper: speed slows as
 * it approaches the ceiling, so late in a run there is even less to retarget.)
 */
const SPEED_EPSILON = 0.004;

// --- Crash. Noise burst for the impact, a pitch dive on the live engine for the motor
// dying, and a lowpass slammed across the music bus so the world goes underwater.
const CRASH_BURST = { level: 0.55, seconds: 0.9, openHz: 5200, closeHz: 260 };
const CRASH_DIVE_HZ = 26;
const CRASH_DIVE_SECONDS = 0.55;   // tracks main.js's 0.3s slow-motion beat, plus its tail
const CRASH_DIVE_CUTOFF_HZ = 140;
const CRASH_DIVE_FADE_START = 0.6; // fraction of the dive that passes before the gain goes
const CRASH_TAIL_SECONDS = 0.6;    // how long after the dive update() keeps its hands off
const MUSIC_OPEN_HZ = 18000;       // "filter effectively bypassed", without a bypass branch
const CRASH_MUSIC_HZ = 300;
const CRASH_MUSIC_CLOSE = 0.12;
const CRASH_MUSIC_RECOVER = 2.5;

// --- UI. Short, quiet, and pitched well above the engine so it cuts without being loud.
const UI_CLICK = { fromHz: 900, toHz: 450, level: 0.22, decay: 0.09 };
const UI_HOVER = { fromHz: 1400, level: 0.07, decay: 0.05 };

/**
 * --- Pickups. Both sweep *upward*, which is the whole design: every existing one-shot in this
 * file falls (the UI click drops an octave, the crash dives), so a rising blip is unambiguously
 * a good thing without the player having to learn it.
 *
 * The orb is a triangle rather than the UI's square — fewer odd harmonics, so it sits under the
 * engine instead of cutting across it. It fires several times in a few seconds when a line is
 * collected, and a square wave at that rate is a woodpecker. Kept quiet for the same reason.
 *
 * The crate is louder, longer and sweeps further, because it happens roughly once every thirty
 * seconds and is the one pickup worth interrupting the mix for.
 */
const ORB_PICKUP = { type: 'triangle', fromHz: 880, toHz: 1620, level: 0.15, decay: 0.11 };
const CRATE_PICKUP = { type: 'triangle', fromHz: 520, toHz: 2100, level: 0.3, decay: 0.32 };

/**
 * ADR (Principle V — "complete, not a TODO", measured rather than assumed): the music
 * slot is resolved at *build* time, not probed at runtime.
 *
 * The obvious implementation is `fetch('audio/music.mp3')` against `public/` and treat
 * a 404 as "no track". That was built first and measured, and it fails the bar in two
 * separate ways. In dev, Vite answers a missing public file with the SPA fallback, so
 * the absent track arrives as `200 text/html`, reaches decodeAudioData and throws. In a
 * production build on a plain static server it is a true 404 — and Chrome logs
 * "Failed to load resource: 404" to the console from the network stack, at error level,
 * on every single load. `fetch` cannot suppress that; nothing in JS can. Shipping a
 * permanent console error for a file we deliberately do not ship is not graceful.
 *
 * `import.meta.glob` resolves against the source tree at build time, so when no track
 * is present this object is empty and *no request is ever made* — no 404, no fallback
 * HTML, no console line. Drop a file in and Vite hashes it into the build like any
 * other asset, which also buys cache-busting that `public/` would not.
 * Trade-off: the drop-in lives under `src/assets/audio/` rather than `public/`, and
 * adding one needs a rebuild — which a production `public/` asset needs anyway. The
 * glob takes any extension, so the "which container?" question disappears with it.
 * See `src/assets/audio/README.md`.
 */
const MUSIC_TRACKS = import.meta.glob('../assets/audio/music.*', {
  query: '?url', import: 'default', eager: true
});
const MUSIC_URL = Object.values(MUSIC_TRACKS)[0] ?? null;

export class AudioManager {
  #persistence;
  #assets;
  #ctx = null;
  #dead = false;
  #muted;

  #master = null;
  #musicFilter = null;
  #sfx = null;
  #engine = null;
  #windGain = null;
  #noise = null;

  #lastSpeed = -1;         // -1 so the first update() always writes, whatever speed is
  #engineHeldUntil = 0;    // ctx time until which the crash owns the engine params

  constructor(bus, persistence, assets) {
    this.#persistence = persistence;
    this.#assets = assets;
    this.#muted = persistence.isMuted();

    // Subscribed in the constructor like every other module, so EventBus's ordering
    // note holds. Nothing here touches Web Audio until a gesture arrives; the handler
    // no-ops on a null context.
    bus.on('crashed', () => this.#crash());

    // Exactly what voices.js predicted these would cost: "one bus.on and one call to playBlip
    // with different numbers". No new synthesis, no new lifecycle. #pickup no-ops before a
    // context exists, which is every event fired before the start button is pressed — and
    // there are none, since a pickup requires a run.
    bus.on('orbCollected', () => this.#pickup(ORB_PICKUP));
    bus.on('powerupFound', () => this.#pickup(CRATE_PICKUP));
  }

  get muted() { return this.#muted; }

  /**
   * A UI sound. `kind` is 'click' or 'hover'.
   *
   * ADR (autoplay policy): 'click' is the only kind allowed to bring the context into
   * existence, and that asymmetry is the entire reason for the parameter. A click
   * carries user activation, so a context created inside it starts 'running'.
   * `pointerenter` does not carry activation — creating a context there is precisely
   * what makes Chrome log "The AudioContext was not allowed to start", and since the
   * start button is a large target that most players hover before pressing, that
   * warning would fire on essentially every session. Hover therefore plays only into a
   * context a click already opened, and is silently skipped before that.
   */
  ui(kind) {
    const ctx = kind === 'click' ? this.#ensureContext() : this.#ctx;
    if (!ctx) return;
    // The click drops an octave over its decay, which is what makes it a "tick" rather
    // than a beep. The hover holds its pitch — a swept hover reads as a notification.
    playBlip(ctx, this.#sfx, kind === 'hover' ? UI_HOVER : UI_CLICK);
  }

  /** Flips mute, persists it, and returns the new state so the caller can label a button. */
  toggleMute() {
    this.#muted = !this.#muted;
    this.#persistence.setMuted(this.#muted);

    // Pressing the mute button is itself a click, so it is a legitimate place to open
    // the context — a player who unmutes before starting gets sound on the first frame
    // of the run rather than only after the start button.
    const ctx = this.#ensureContext();
    if (ctx) this.#master.gain.setTargetAtTime(this.#muted ? 0 : MASTER_GAIN, ctx.currentTime, MUTE_RAMP);

    return this.#muted;
  }

  /**
   * Called every frame from the tick, deliberately outside main.js's pause gate — a
   * paused game has to fall quiet, and a module that isn't ticked cannot ramp itself down.
   *
   * ADR: no `dt`. Every ramp below is scheduled against `ctx.currentTime`, the audio
   * thread's own clock, and that is the correct clock for audio: it does not stall when
   * requestAnimationFrame does, and it is not the dilated delta main.js hands the
   * simulation during the crash slow-motion — pitch-bending the entire mix by a quarter
   * for 0.3s is not an effect anyone asked for. Accepting a `dt` this method must then
   * ignore would be an invitation to use it.
   */
  update(game) {
    if (!this.#ctx) return;

    // PAUSED keeps its speed (GameManager freezes the tick rather than zeroing it), so
    // this state test is load-bearing and cannot be replaced by reading speed alone.
    const speed = game.state === State.PLAYING ? game.speed : 0;
    if (Math.abs(speed - this.#lastSpeed) < SPEED_EPSILON) return;
    this.#lastSpeed = speed;

    const now = this.#ctx.currentTime;
    // Collapsing "not playing" into speed 0 means one comparison covers both the
    // throttle and every exit from PLAYING: menu, pause and game-over all arrive here
    // as a step to 0, which is always larger than the epsilon.
    this.#windGain.gain.setTargetAtTime(speed * WIND_GAIN_PER_SPEED, now, WIND_GLIDE);

    // The crash schedules a pitch dive and then a fade; re-targeting those params while
    // it runs would drag the dive back up on the very next frame.
    if (now < this.#engineHeldUntil) return;

    const { osc, sub, filter, gain } = this.#engine;
    const hz = ENGINE_BASE_HZ + speed * ENGINE_HZ_PER_SPEED;
    osc.frequency.setTargetAtTime(hz, now, ENGINE_GLIDE);
    sub.frequency.setTargetAtTime(hz * ENGINE_SUB_RATIO, now, ENGINE_GLIDE);
    filter.frequency.setTargetAtTime(ENGINE_CUTOFF_BASE + speed * ENGINE_CUTOFF_PER_SPEED, now, ENGINE_GLIDE);
    gain.gain.setTargetAtTime(speed > 0 ? ENGINE_GAIN : 0, now, ENGINE_FADE);
  }

  /**
   * A collectible sound. Never opens the context — unlike `ui('click')`, a pickup carries no
   * user activation, and a context created here would be born suspended with Chrome's autoplay
   * warning attached. By the time any pickup can happen the start button has already opened it.
   */
  #pickup(voice) {
    if (!this.#ctx) return;
    playBlip(this.#ctx, this.#sfx, voice);
  }

  /**
   * The lazy half of the lifecycle. Every public method a user gesture can reach goes
   * through here; nothing else does.
   *
   * ADR (autoplay policy): the context is not created in the constructor, and not at
   * module load. Chrome blocks and warns about a context created without user
   * activation, and main.js constructs every module at boot — so a context built there
   * would be born 'suspended' with a console warning attached, on every single load.
   */
  #ensureContext() {
    if (this.#dead) return null;

    if (!this.#ctx) {
      try {
        this.#ctx = new AudioContext();
        this.#buildGraph();
        // Fire and forget: the run must not wait on an optional asset. The load cannot
        // reject — see AssetManager.loadAudioBuffer — so there is nothing to catch.
        this.#startMusic();
      } catch (error) {
        // No Web Audio at all. A game without sound is a game; a game that throws in
        // its click handler is not. Warn once and stay quiet forever.
        console.warn('AudioManager: Web Audio unavailable, running silent', error);
        this.#dead = true;
        return null;
      }
    }

    // A context created under a gesture starts 'running', but one can be suspended
    // later by the browser (backgrounded tab, OS audio focus). Re-asserting is cheap,
    // and this is the only place a gesture is known to be in hand.
    if (this.#ctx.state === 'suspended') this.#ctx.resume().catch(() => {});
    return this.#ctx;
  }

  #buildGraph() {
    const ctx = this.#ctx;

    // Built at the muted gain rather than ramped down after, so an unmuted frame of
    // audio never escapes on a load where the player had muted last session.
    this.#master = new GainNode(ctx, { gain: this.#muted ? 0 : MASTER_GAIN });
    this.#master.connect(ctx.destination);

    this.#sfx = new GainNode(ctx, { gain: SFX_GAIN });
    this.#sfx.connect(this.#master);

    // The music filter sits ahead of the music gain so the crash can sweep the track
    // without touching its level — ducking and filtering are separate gestures. Only
    // the filter is kept as a field: the gain node stays alive because it is connected,
    // and a field nothing reads is a field that lies about being needed.
    const musicBus = new GainNode(ctx, { gain: MUSIC_GAIN });
    musicBus.connect(this.#master);
    this.#musicFilter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: MUSIC_OPEN_HZ });
    this.#musicFilter.connect(musicBus);

    this.#noise = createNoiseBuffer(ctx, NOISE_SECONDS);
    this.#engine = createEngineVoice(ctx, this.#sfx, {
      baseHz: ENGINE_BASE_HZ,
      cutoffHz: ENGINE_CUTOFF_BASE
    });
    this.#windGain = createWindVoice(ctx, this.#sfx, this.#noise);
  }

  /**
   * Fires on the `crashed` event, ahead of main.js's own handler — AudioManager is
   * constructed first and EventBus dispatches in subscription order — so the engine is
   * still at full song when the dive is scheduled, rather than already spinning down
   * from the state change.
   */
  #crash() {
    if (!this.#ctx) return;
    const now = this.#ctx.currentTime;

    playNoiseBurst(this.#ctx, this.#sfx, this.#noise, CRASH_BURST);

    const { osc, sub, filter, gain } = this.#engine;
    for (const param of [osc.frequency, sub.frequency, filter.frequency, gain.gain]) holdParam(param, now);

    osc.frequency.exponentialRampToValueAtTime(CRASH_DIVE_HZ, now + CRASH_DIVE_SECONDS);
    sub.frequency.exponentialRampToValueAtTime(CRASH_DIVE_HZ * ENGINE_SUB_RATIO, now + CRASH_DIVE_SECONDS);
    filter.frequency.exponentialRampToValueAtTime(CRASH_DIVE_CUTOFF_HZ, now + CRASH_DIVE_SECONDS);
    // setTargetAtTime, not an exponential ramp: the gain can legitimately be sitting at
    // 0 here (a crash on the first frame of a run) and an exponential ramp from 0 is
    // undefined. Started partway into the dive so the pitch fall is heard, not implied.
    gain.gain.setTargetAtTime(0, now + CRASH_DIVE_SECONDS * CRASH_DIVE_FADE_START, 0.18);
    this.#engineHeldUntil = now + CRASH_DIVE_SECONDS + CRASH_TAIL_SECONDS;

    // Slam the music behind a lowpass and let it swim back up. Harmless when no track
    // is loaded — the filter is simply passing silence.
    const cutoff = this.#musicFilter.frequency;
    holdParam(cutoff, now);
    cutoff.exponentialRampToValueAtTime(CRASH_MUSIC_HZ, now + CRASH_MUSIC_CLOSE);
    cutoff.exponentialRampToValueAtTime(MUSIC_OPEN_HZ, now + CRASH_MUSIC_RECOVER);
  }

  /**
   * The music slot. No track ships with the game; dropping one into
   * `src/assets/audio/` is the entire installation step.
   *
   * This is complete as a *mechanism*, which is the Principle V bar — not a stub
   * waiting on code, but a working loader waiting on a file, with the absence of that
   * file a supported and tested state rather than a broken one.
   */
  async #startMusic() {
    if (!MUSIC_URL) return; // no track in the build — the correct, silent outcome

    const buffer = await this.#assets.loadAudioBuffer(MUSIC_URL, this.#ctx);
    if (!buffer) return; // resolved but unusable; AssetManager has already said so

    const source = new AudioBufferSourceNode(this.#ctx, { buffer, loop: true });
    source.connect(this.#musicFilter);
    source.start();
  }
}
