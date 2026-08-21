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
 * Trade-off: a per-frame textContent write is a layout-invalidating touch at 60Hz.
 *   Measured cost is small because the string usually doesn't change between
 *   frames, but throttling it is a known perf item for later.
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
    this.#score.textContent = Math.floor(this.#game.score);
    this.#updateChips();
  }

  /**
   * A countdown that only writes when the whole second changes. The score above writes every
   * frame and this file's header already flags that as a known cost; adding three more
   * per-frame textContent writes for a number that visibly changes once a second would be
   * taking that cost four times over for no extra information.
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
      this.#bestLabel.textContent = 'BEST';
      // Covers the reset case GameManager deliberately does not emit for — see start().
      // A resume re-renders the same number, which is free and keeps this branch honest.
      this.#renderSector(this.#game.tier);
      this.#startScreen.classList.add(HIDDEN);
      this.#gameOverScreen.classList.add(HIDDEN);
      return;
    }

    if (to === State.GAME_OVER) {
      this.#finalScore.textContent = Math.floor(this.#game.score);
      // GameManager persists the record before announcing the transition, so this
      // read is already current — see the ordering note in gameOver().
      this.#bestScore.textContent = this.#game.highScore;
      this.#gameOverScreen.classList.remove(HIDDEN);
    }
  }
}
