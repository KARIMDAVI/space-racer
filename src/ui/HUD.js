import { POWERUP_KINDS, State } from '../core/GameManager.js';

/**
 * ARCHITECTURE: DOM overlay
 * Decision: every element reference is resolved once in the constructor and cached.
 *   Screens are driven off `stateChanged`; only the live score text is written per
 *   frame. Buttons call `game.start()` and nothing else.
 * Reason: Ownership Map — sole writer to the DOM overlay, reads game state and
 *   never mutates it. The pre-split build had the game loop poking `innerText` and
 *   the button handlers resetting the car and clearing obstacles, which is how the
 *   UI ended up owning gameplay.
 *   The mute button follows the same rule against AudioManager: HUD calls `ui()` and
 *   `toggleMute()` and reads `muted`, and knows nothing about contexts or gain nodes.
 * Trade-off: the live score is a DOM write on a clock, so the number a player reads
 *   can be up to SCORE_WRITE_INTERVAL_MS stale. See the ADR on that constant — the
 *   per-frame version this replaced cost a full style recalc and layout every frame.
 * If a screen never appears, check: 1) the id in index.html still matches the
 *   lookup below — a null here fails loudly at boot, which is deliberate, 2) the
 *   `hidden` class is still what style.css keys the fade off.
 */

const HIDDEN = 'hidden';

/**
 * ADR (Principle IV, and Principle III's "no per-frame allocation" read honestly): the bonus
 * flash is driven by `Element.animate` — the Web Animations API, native since 2020 in every
 * browser this game's `new GainNode(ctx)` baseline already requires.
 *
 * The CSS-class alternative needs the reflow hack (`remove`, read `offsetWidth`, `add`) to
 * retrigger an animation that is already running, and a graze followed 200ms later by an orb
 * does exactly that. Forcing a synchronous layout flush mid-frame to restart a decoration is a
 * worse trade than the one Animation object this allocates, which happens a few times a run at
 * a scale of pickups, not frames. The keyframes and timing are hoisted to module constants so
 * the call itself builds nothing.
 */
const BONUS_KEYFRAMES = [
  { opacity: 1, transform: 'translateY(4px)' },
  { opacity: 1, transform: 'translateY(-6px)', offset: 0.35 },
  { opacity: 0, transform: 'translateY(-24px)' }
];
const BONUS_TIMING = Object.freeze({ duration: 750, easing: 'ease-out' });

/**
 * ADR (Principle III): the live score readout is written at most once per this interval,
 * and then only when the integer it displays actually changed.
 *
 * Measured, because the pre-existing note here called the cost "small" without having
 * measured it and deferred the fix. Chrome trace, `disabled-by-default-devtools.timeline`,
 * 6x CPU throttle, 8s window at tier 5 with hyperdrive up: the per-frame write produced
 * 961 UpdateLayoutTree and 961 Layout events across 960 frames — one full style recalc and
 * one full layout every frame, 639ms of the 8000ms window, ~8% of wall clock. The menu,
 * where this same update() early-returns, produced *zero* of either. `textContent` replaces
 * the element's text node whether or not the string differs, so the invalidation was
 * unconditional and the "usually doesn't change" reasoning did not hold.
 *
 * 100ms is chosen against what the number is for, not against the frame rate. The score is
 * a readout a human glances at; at tier-5 speed it climbs ~120/s, so 10Hz still moves it
 * every tick and no player can read faster than that. Going to per-frame buys no
 * information and costs a layout; going much slower starts to look frozen.
 *
 * Wall clock rather than the simulation delta on purpose: this is a property of how often a
 * human can read a number, so it should not dilate with the crash slow-motion the tick
 * applies, and update() does not run while paused so a pause cannot bank interval either.
 */
const SCORE_WRITE_INTERVAL_MS = 100;

/** Chip labels. Uppercase in the markup would be a second place to change one. */
const POWERUP_LABELS = Object.freeze({
  shield: 'SHIELD', magnet: 'MAGNET', hyperdrive: 'HYPERDRIVE'
});

const requireElement = (id) => {
  const element = document.getElementById(id);
  // Fail at boot with a name, not at frame 900 with "cannot set property of null".
  if (!element) throw new Error(`HUD: missing #${id} in the document`);
  return element;
};

export class HUD {
  #game;
  #muteButton;
  #score;
  #sector;
  #startScreen;
  #pauseScreen;
  #gameOverScreen;
  #finalScore;
  #bestLabel;
  #bestScore;
  #bonus;
  #bonusAnimation = null;

  /** Last integer written to the score element, and when the next write is allowed. */
  #scoreShown = -1;
  #nextScoreWrite = 0;

  /** One element and one last-written integer per kind, both resolved once. */
  #chips = {};
  #chipSeconds = {};

  constructor(game, bus, audio) {
    this.#game = game;
    this.#score = requireElement('scoreValue');
    this.#sector = requireElement('sectorValue');
    this.#bonus = requireElement('bonusFlash');

    for (const kind of POWERUP_KINDS) {
      this.#chips[kind] = requireElement(`powerup${kind[0].toUpperCase()}${kind.slice(1)}`);
      // -1 rather than 0 so the first render always writes, whatever the duration rounds to.
      this.#chipSeconds[kind] = -1;
    }

    this.#startScreen = requireElement('startScreen');
    this.#pauseScreen = requireElement('pauseScreen');
    this.#gameOverScreen = requireElement('gameOverScreen');
    this.#finalScore = requireElement('finalScore');
    this.#bestLabel = requireElement('bestLabel');
    this.#bestScore = requireElement('bestScore');

    for (const id of ['startButton', 'restartButton']) {
      const button = requireElement(id);
      // The click sound goes first, and not because the ordering is audible — it isn't.
      // It's because this click is where AudioManager is allowed to open its
      // AudioContext (browsers block one created without user activation), and putting
      // it after game.start() would hand the context's birth to whatever start()
      // eventually grows into.
      button.addEventListener('click', () => { audio.ui('click'); game.start(); });
      // pointerenter, not mouseenter: it covers pen and the hover a touch device can
      // report, and it does not fire per-child the way pointerover would.
      button.addEventListener('pointerenter', () => audio.ui('hover'));
    }

    this.#muteButton = requireElement('muteButton');
    this.#muteButton.addEventListener('click', () => this.#renderMute(audio.toggleMute()));
    this.#renderMute(audio.muted); // the persisted state decides what the button says at boot

    bus.on('stateChanged', ({ to }) => this.#onStateChanged(to));
    bus.on('newHighScore', () => { this.#bestLabel.textContent = 'NEW RECORD'; });
    bus.on('tierChanged', ({ tier }) => this.#renderSector(tier));

    // GameManager carries the amount because it is the only module that knows what a graze or
    // an orb is worth — this one just shows the number it is handed, so retuning either bonus
    // never reaches the UI.
    bus.on('scoreBonus', ({ amount }) => this.#flashBonus(amount));
    // Show and hide come off the events; the countdown inside a visible chip is read per frame
    // in #updateChips. Splitting it that way means the chip cannot be left on screen by a
    // missed frame, and cannot tick by an event that would have to fire 12 times for one shield.
    bus.on('powerupStarted', ({ kind }) => this.#chips[kind].classList.remove(HIDDEN));
    bus.on('powerupEnded', ({ kind }) => this.#chips[kind].classList.add(HIDDEN));
  }

  update() {
    if (this.#game.state !== State.PLAYING) return;
    this.#updateScore();
    this.#updateChips();
  }

  /**
   * Fixed: the score was written to the DOM every frame, which forced a style recalc and a
   * full layout every frame (measured: 1.00 of each per frame during play, 0 on the menu).
   * Gated on a 10Hz clock first and on the value second — the clock is what removes the
   * per-frame layout, and the value check is what keeps a stalled score from writing at all.
   */
  #updateScore() {
    const now = performance.now();
    if (now < this.#nextScoreWrite) return;
    // Advanced before the value check, so a score that is not moving re-arms the clock
    // rather than re-testing itself on every frame until it does.
    this.#nextScoreWrite = now + SCORE_WRITE_INTERVAL_MS;

    const value = Math.floor(this.#game.score);
    if (value === this.#scoreShown) return;
    this.#scoreShown = value;
    this.#score.textContent = value;
  }

  /**
   * A countdown that only writes when the whole second changes — the same discipline
   * #updateScore now applies, arrived at here first. Three more per-frame textContent writes
   * for a number that visibly changes once a second would have bought no extra information
   * at four times the layout cost the score alone was measured to carry.
   */
  #updateChips() {
    const { powerups } = this.#game;

    for (let i = 0; i < POWERUP_KINDS.length; i++) {
      const kind = POWERUP_KINDS[i];
      const seconds = Math.ceil(powerups[kind]);
      if (seconds === this.#chipSeconds[kind]) continue;
      this.#chipSeconds[kind] = seconds;
      // Ceil, so a shield with 0.4s left still reads "1" — a chip that shows 0 while the effect
      // is demonstrably still working is worse than one that rounds up and then disappears.
      this.#chips[kind].textContent = `${POWERUP_LABELS[kind]} ${seconds}`;
    }
  }

  /**
   * Cancelled before restarting rather than left to stack. Each `animate` call returns its own
   * Animation, and two live at once on the same element compose their transforms — two bonuses
   * in quick succession would send the text twice as far up the screen as one.
   */
  #flashBonus(amount) {
    this.#bonus.textContent = `+${amount}`;
    this.#bonusAnimation?.cancel();
    this.#bonusAnimation = this.#bonus.animate(BONUS_KEYFRAMES, BONUS_TIMING);
  }

  /**
   * Label and aria-pressed from one boolean, in one place — the boot render and the
   * toggle both land here, so the button cannot end up saying one thing to a reader
   * and another to a screen reader.
   */
  #renderMute(muted) {
    this.#muteButton.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
    this.#muteButton.setAttribute('aria-pressed', String(muted));
  }

  /**
   * Tiers are 0-indexed because that is what indexes the tuning table; sectors are 1-indexed
   * because "SECTOR 00" reads like an error. The conversion lives here, in the one place that
   * shows the number to a human, rather than being baked into GameManager where it would
   * make every other consumer subtract one.
   */
  #renderSector(tier) {
    this.#sector.textContent = `SECTOR 0${tier + 1}`;
  }

  #onStateChanged(to) {
    // Toggled on every transition rather than shown/hidden in two branches: PAUSED is
    // the only state this overlay belongs to, and one expression can't get out of sync
    // with itself the way a matched pair of add/remove calls eventually does.
    this.#pauseScreen.classList.toggle(HIDDEN, to !== State.PAUSED);

    if (to === State.PLAYING) {
      // Re-arm the score throttle so a new run's 0 lands on the first frame instead of up
      // to SCORE_WRITE_INTERVAL_MS into it, still showing the last run's final number.
      // A resume passes through here too and simply forces one harmless write.
      this.#scoreShown = -1;
      this.#nextScoreWrite = 0;
      this.#bestLabel.textContent = 'BEST';
      // Covers the reset case GameManager deliberately does not emit for — see start().
      // A resume re-renders the same number, which is free and keeps this branch honest.
      this.#renderSector(this.#game.tier);
      this.#startScreen.classList.add(HIDDEN);
      this.#gameOverScreen.classList.add(HIDDEN);
      return;
    }

    if (to === State.GAME_OVER) {
      const final = Math.floor(this.#game.score);
      // Settle the live readout on the true final number. update() stops running at this
      // transition, so without this the throttled score could sit up to
      // SCORE_WRITE_INTERVAL_MS stale and disagree with the panel in front of it — the
      // overlay is translucent, so both numbers are on screen together.
      this.#score.textContent = final;
      this.#scoreShown = final;
      this.#finalScore.textContent = final;
      // GameManager persists the record before announcing the transition, so this
      // read is already current — see the ordering note in gameOver().
      this.#bestScore.textContent = this.#game.highScore;
      this.#gameOverScreen.classList.remove(HIDDEN);
    }
  }
}
