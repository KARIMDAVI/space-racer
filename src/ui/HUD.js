import { State } from '../core/GameManager.js';

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
  #startScreen;
  #pauseScreen;
  #gameOverScreen;
  #finalScore;
  #bestLabel;
  #bestScore;

  constructor(game, bus, audio) {
    this.#game = game;
    this.#score = requireElement('scoreValue');
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
  }

  update() {
    if (this.#game.state !== State.PLAYING) return;
    this.#score.textContent = Math.floor(this.#game.score);
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

  #onStateChanged(to) {
    // Toggled on every transition rather than shown/hidden in two branches: PAUSED is
    // the only state this overlay belongs to, and one expression can't get out of sync
    // with itself the way a matched pair of add/remove calls eventually does.
    this.#pauseScreen.classList.toggle(HIDDEN, to !== State.PAUSED);

    if (to === State.PLAYING) {
      this.#bestLabel.textContent = 'BEST';
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
