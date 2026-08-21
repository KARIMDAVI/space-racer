/**
 * ARCHITECTURE: Single source of truth for game state
 * Decision: one state machine plus the two derived run values (score, speed) that
 *   every other module reads. Everything is exposed through getters; the only ways
 *   in are start(), gameOver() and update().
 * Reason: Constitution Principle II. The pre-split build kept `isGameStarted`,
 *   `isGameOver`, `score` and `speed` as module-level `let`s that four different
 *   code paths wrote to — adding a Paused state to that was going to be a bug farm.
 * Trade-off: readers now pay a getter call and can't cache values across frames.
 *   That's the price of having exactly one writer, and it's a rounding error.
 * If a state transition seems not to happen, check that the caller isn't already
 *   in the target state — #transition() is a no-op on a self-transition and stays
 *   silent rather than re-emitting.
 */
/**
 * The four states from the Blueprint's Phase 1 state machine. PAUSED has no
 * trigger wired yet — that arrives with the visibility/touch work — but it is not
 * a placeholder: update() gates on PLAYING, so entering PAUSED already freezes the
 * whole simulation correctly the moment something calls for it.
 */
export const State = Object.freeze({
  MENU: 'MENU',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  GAME_OVER: 'GAME_OVER'
});

// Carried over verbatim from the pre-split loop. These numbers are the game's feel;
// Blueprint Phase 3 is where the speed curve is allowed to change, not here.
const BASE_SPEED = 1.0;
const DISTANCE_PER_SPEED_UNIT = 100; // "arbitrary multiplier for feel" — original's words
const SCORE_PER_DISTANCE = 0.1;
const SPEED_GAIN_PER_POINT = 0.001;

export class GameManager {
  #bus;
  #state = State.MENU;
  #score = 0;
  #speed = 0;
  #moveDist = 0;

  constructor(bus) {
    this.#bus = bus;
  }

  get state() { return this.#state; }
  get score() { return this.#score; }
  get speed() { return this.#speed; }

  /**
   * World units travelled this frame. Environment and ObstacleManager both need it,
   * and both deriving `speed * 100 * dt` independently would put the multiplier in
   * two places waiting to drift apart. Owned here, read there.
   */
  get moveDist() { return this.#moveDist; }

  start() {
    if (this.#state === State.PLAYING) return; // guard: never silently wipe a live run
    this.#score = 0;
    this.#speed = BASE_SPEED;
    this.#moveDist = 0;
    this.#transition(State.PLAYING);
  }

  gameOver() {
    if (this.#state !== State.PLAYING) return; // two obstacles in one frame, one death
    this.#speed = 0;
    this.#moveDist = 0;
    this.#transition(State.GAME_OVER);
  }

  update(dt) {
    if (this.#state !== State.PLAYING) return;
    // Order is load-bearing and matches the pre-split loop exactly: speed comes from
    // *last* frame's score, then this frame's distance is banked into it. Flipping
    // these two lines compounds the speed curve and the run gets measurably faster.
    this.#speed = BASE_SPEED + this.#score * SPEED_GAIN_PER_POINT;
    this.#moveDist = this.#speed * DISTANCE_PER_SPEED_UNIT * dt;
    this.#score += this.#moveDist * SCORE_PER_DISTANCE;
  }

  #transition(to) {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.#bus.emit('stateChanged', { from, to });
  }
}
