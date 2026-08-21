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
  #score;
  #startScreen;
  #gameOverScreen;
  #finalScore;

  constructor(game, bus) {
    this.#game = game;
    this.#score = requireElement('scoreValue');
    this.#startScreen = requireElement('startScreen');
    this.#gameOverScreen = requireElement('gameOverScreen');
    this.#finalScore = requireElement('finalScore');

    requireElement('startButton').addEventListener('click', () => game.start());
    requireElement('restartButton').addEventListener('click', () => game.start());

    bus.on('stateChanged', ({ to }) => this.#onStateChanged(to));
  }

  update() {
    if (this.#game.state !== State.PLAYING) return;
    this.#score.textContent = Math.floor(this.#game.score);
  }

  #onStateChanged(to) {
    if (to === State.PLAYING) {
      this.#startScreen.classList.add(HIDDEN);
      this.#gameOverScreen.classList.add(HIDDEN);
      return;
    }

    if (to === State.GAME_OVER) {
      this.#finalScore.textContent = Math.floor(this.#game.score);
      this.#gameOverScreen.classList.remove(HIDDEN);
    }
  }
}
