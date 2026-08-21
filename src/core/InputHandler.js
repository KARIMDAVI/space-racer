/**
 * ARCHITECTURE: Device input → game intent
 * Decision: hold key state in two booleans and expose a single steering axis.
 *   Consumers get -1/0/1 and never see a KeyboardEvent.
 * Reason: Ownership Map — sole translator from raw device events to intents. When
 *   touch and gamepad land they widen the axis here; PlayerCar's signature doesn't
 *   move, because it never knew what a keyboard was.
 * Trade-off: an axis can't express "both keys held" — left wins, matching the
 *   pre-split `if (keys.left) ... else if (keys.right)` chain exactly.
 * If steering dies, check: 1) focus is on the document and not an iframe/devtools
 *   pane, 2) some overlay called preventDefault upstream, 3) keyup was swallowed by
 *   a tab switch mid-press, which latches the key down until it's pressed again.
 */

// Matching on both `code` and `key` is inherited on purpose: `code` is layout-
// independent for the arrows, while A/D by `key` still works on AZERTY where the
// physical KeyA sits elsewhere.
const isLeftKey = (e) => e.code === 'ArrowLeft' || e.key === 'a' || e.key === 'A';
const isRightKey = (e) => e.code === 'ArrowRight' || e.key === 'd' || e.key === 'D';

export class InputHandler {
  #left = false;
  #right = false;

  constructor() {
    window.addEventListener('keydown', (e) => this.#setKey(e, true));
    window.addEventListener('keyup', (e) => this.#setKey(e, false));
  }

  /** -1 left, 1 right, 0 neutral. Left wins when both are held. */
  get steerAxis() {
    return this.#left ? -1 : this.#right ? 1 : 0;
  }

  /**
   * Nothing to do per frame while input is pure edge-driven booleans. Kept in the
   * tick anyway so that adding buffered taps or gamepad polling later is a change
   * inside this file, not a change to main.js's loop.
   */
  update() {}

  #setKey(event, pressed) {
    if (isLeftKey(event)) this.#left = pressed;
    else if (isRightKey(event)) this.#right = pressed;
  }
}
