/**
 * ARCHITECTURE: Device input → game intent
 * Decision: hold key state in two booleans, touch state in two pointer ids, and expose a
 *   single steering axis over both. Consumers get -1/0/1 and never see a KeyboardEvent or a
 *   PointerEvent.
 * Reason: Ownership Map — sole translator from raw device events to intents. S2 wrote that
 *   "when touch and gamepad land they widen the axis here; PlayerCar's signature doesn't move",
 *   and S7 is that promise being cashed: touch is entirely contained in this file, and not one
 *   line downstream changed to accept it.
 * Trade-off: an axis can't express "both keys held" — left wins, matching the pre-split
 *   `if (keys.left) ... else if (keys.right)` chain exactly. Touch inherits the same rule.
 * If steering dies, check: 1) focus is on the document and not an iframe/devtools
 *   pane, 2) some overlay called preventDefault upstream, 3) keyup was swallowed by
 *   a tab switch mid-press, which latches the key down until it's pressed again.
 * If *touch* steering dies, check `touch-action: none` on the canvas in style.css first — the
 *   browser claims the gesture for scrolling otherwise and the pointermove stream stops dead
 *   part-way through a drag, which presents as steering that latches on.
 */

/**
 * ADR (Principle I — the overlay decides what is clickable, not this module): pointer listeners
 * go on the canvas, not on window. #uiContainer covers the viewport but sets
 * `pointer-events: none`, so a tap over live gameplay hit-tests through to the canvas and
 * arrives here; .overlay-screen sets `pointer-events: auto`, so while the start, pause or
 * game-over screen is up, *it* is the target and nothing reaches this file. The mute button
 * opts itself back in the same way.
 *
 * That means "don't steer while a menu is open" and "don't steer when the player is reaching
 * for the mute button" are both already true, with no state test here and no knowledge of what
 * a menu is. The alternative — listening on window and walking `event.target.closest('button')`
 * — would put a copy of the overlay's layout rules in the input module, where they would
 * quietly stop matching the CSS.
 */

/** Where the screen splits. Half, and it is the only sane answer for a two-direction control. */
const TOUCH_SPLIT = 0.5;

/** No pointer. -1 rather than null so the field never changes type. */
const NO_POINTER = -1;

// Matching on both `code` and `key` is inherited on purpose: `code` is layout-
// independent for the arrows, while A/D by `key` still works on AZERTY where the
// physical KeyA sits elsewhere.
const isLeftKey = (e) => e.code === 'ArrowLeft' || e.key === 'a' || e.key === 'A';
const isRightKey = (e) => e.code === 'ArrowRight' || e.key === 'd' || e.key === 'D';
// One check is enough here where the steering keys need two: Escape reports the same
// `code` on every keyboard layout, because it isn't a character key.
const isPauseKey = (e) => e.code === 'Escape';

export class InputHandler {
  #bus;
  #canvas;
  #left = false;
  #right = false;

  /**
   * Which pointer, if any, is currently holding each side. Ids rather than booleans because
   * multi-touch is not optional on the device this is for: two thumbs down means two live
   * pointers, and lifting one has to clear only the side *that* pointer held. A pair of
   * booleans would have the second thumb's release cancel the first thumb's steer.
   *
   * Two fields rather than a Map keyed by pointerId — there are exactly two sides, so the
   * mapping is small enough to invert, and nothing is allocated when a finger lands.
   */
  #leftPointer = NO_POINTER;
  #rightPointer = NO_POINTER;

  constructor(bus, canvas) {
    this.#bus = bus;
    this.#canvas = canvas;
    window.addEventListener('keydown', (e) => this.#onKeyDown(e));
    window.addEventListener('keyup', (e) => this.#setKey(e, false));

    // Pointer events rather than touch events: one code path covers touch, pen and mouse, and
    // a click-and-hold on the canvas steering the car is a free and harmless side effect.
    // Touch events would need a parallel mouse path to get the same coverage.
    canvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.#onPointerMove(e));
    // pointercancel matters as much as pointerup here: the browser fires it when it decides a
    // gesture belongs to it after all, and a missed one latches the steer on permanently.
    for (const type of ['pointerup', 'pointercancel']) {
      canvas.addEventListener(type, (e) => this.#releasePointer(e.pointerId));
    }
  }

  /** -1 left, 1 right, 0 neutral. Left wins when both are held, whichever device is holding them. */
  get steerAxis() {
    if (this.#left || this.#leftPointer !== NO_POINTER) return -1;
    if (this.#right || this.#rightPointer !== NO_POINTER) return 1;
    return 0;
  }

  /**
   * Nothing to do per frame while input is pure edge-driven booleans. Kept in the
   * tick anyway so that adding buffered taps or gamepad polling later is a change
   * inside this file, not a change to main.js's loop.
   */
  update() {}

  /**
   * `pauseToggled` is an intent, not a command: this module says the player asked to
   * pause, and GameManager decides whether that's legal from the current state
   * (Principle II). It stays an intent for the same reason `crashed` does.
   */
  #onKeyDown(event) {
    // Held keys auto-repeat keydown ~30x/sec. Steering doesn't care — every repeat
    // re-sets a boolean that's already true — but a toggle would strobe, so the
    // guard covers the whole handler rather than just the pause branch.
    if (event.repeat) return;

    if (isPauseKey(event)) this.#bus.emit('pauseToggled');
    else this.#setKey(event, true);
  }

  #setKey(event, pressed) {
    if (isLeftKey(event)) this.#left = pressed;
    else if (isRightKey(event)) this.#right = pressed;
  }

  /**
   * Capture is what makes the release reliable. Without it, a finger that slides off the canvas
   * — over the mute button, or past the edge of the screen — delivers its pointerup somewhere
   * else and this module never hears the lift, leaving the car steering into the rail until the
   * player taps again. With it, every event for this pointer is retargeted here until release.
   */
  #onPointerDown(event) {
    // Stops the browser synthesising a mouse event pair from the touch, and stops the
    // long-press text-selection gesture. The canvas has nothing selectable, but the selection
    // UI appearing mid-run is its own kind of broken.
    event.preventDefault();
    this.#canvas.setPointerCapture(event.pointerId);
    this.#assignPointer(event);
  }

  /** Only tracked pointers are followed — a hovering mouse with no button down is not a steer. */
  #onPointerMove(event) {
    if (event.pointerId !== this.#leftPointer && event.pointerId !== this.#rightPointer) return;
    this.#assignPointer(event);
  }

  /**
   * A finger that crosses the midline changes sides rather than latching where it landed. That
   * is not a flourish: on a phone the natural correction for oversteering is to slide the thumb
   * across rather than lift and re-tap, and a control that ignored it would feel stuck.
   */
  #assignPointer(event) {
    const id = event.pointerId;
    if (event.clientX < window.innerWidth * TOUCH_SPLIT) {
      this.#leftPointer = id;
      if (this.#rightPointer === id) this.#rightPointer = NO_POINTER;
      return;
    }
    this.#rightPointer = id;
    if (this.#leftPointer === id) this.#leftPointer = NO_POINTER;
  }

  #releasePointer(id) {
    if (this.#leftPointer === id) this.#leftPointer = NO_POINTER;
    if (this.#rightPointer === id) this.#rightPointer = NO_POINTER;
  }
}
