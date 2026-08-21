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
 * The four states from the Blueprint's Phase 1 state machine. PAUSED is reached
 * through pause()/resume() below, driven by the Escape key and by the tab losing
 * visibility; main.js skips the whole simulation block while it holds, and keeps
 * rendering so a paused frame shows the frozen scene rather than black.
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

/**
 * ADR (Principle II): difficulty tier is derived state, and it is derived *here* because it
 * is a function of score and score has exactly one owner. ObstacleManager consumes it and
 * could just as easily compute it from `game.score` — which is precisely the second source
 * of truth this principle exists to prevent, because the day a power-up freezes the tier
 * without freezing the score, the two would silently disagree.
 *
 * Score entering each tier. Deliberately *not* accompanied by a change to the speed curve
 * above: the original plan for this step swapped the linear curve for an asymptotic one, and
 * that decision belongs to whoever tunes pacing after playing the tiered obstacle set, not
 * bundled in silently alongside it. Tiers add difficulty through obstacle variety and
 * density; speed is untouched.
 */
const TIER_THRESHOLDS = Object.freeze([250, 600, 1200, 2000, 3200]);

/** A near miss, in score. Small enough to be a garnish, big enough to notice a good line. */
const GRAZE_BONUS = 15;

export class GameManager {
  #bus;
  #persistence;
  #state = State.MENU;
  #score = 0;
  #speed = 0;
  #moveDist = 0;
  #tier = 0;

  constructor(bus, persistence) {
    this.#bus = bus;
    this.#persistence = persistence;
  }

  get state() { return this.#state; }
  get score() { return this.#score; }
  get speed() { return this.#speed; }

  /** 0..5. Which obstacle types and how much breathing room the road is allowed to use. */
  get tier() { return this.#tier; }

  /**
   * Asked once per frame by the tick. A getter rather than main.js comparing against
   * State keeps the composition root free of state-machine vocabulary — it needs to
   * know whether to run the simulation, not which enum member is current.
   */
  get isPaused() { return this.#state === State.PAUSED; }

  /**
   * World units travelled this frame. Environment and ObstacleManager both need it,
   * and both deriving `speed * 100 * dt` independently would put the multiplier in
   * two places waiting to drift apart. Owned here, read there.
   */
  get moveDist() { return this.#moveDist; }

  /** Proxied so HUD reads save data through the state owner, never the store directly. */
  get highScore() { return this.#persistence.getHighScore(); }

  start() {
    if (this.#state === State.PLAYING) return; // guard: never silently wipe a live run
    this.#score = 0;
    this.#speed = BASE_SPEED;
    this.#moveDist = 0;
    // Reset silently rather than emitting tierChanged back to 0: a new run is not a tier
    // transition, and subscribers that care about the opening state already get told the run
    // began by stateChanged. Emitting both would make "the tier went down" a representable
    // event that nothing should ever have to handle.
    this.#tier = 0;
    this.#transition(State.PLAYING);
  }

  /**
   * ADR (Principle II): pause is a *state transition and nothing else*. It is
   * deliberately not implemented as "set speed to 0", which is what gameOver() does
   * and what the pre-split build would have reached for. Zeroing speed would round
   * the score's growth to nothing, hand Environment and ObstacleManager a moveDist
   * of 0 that they cannot distinguish from a dead stop, and leave nothing to restore
   * on resume — the run's momentum would have to be reconstructed from the score.
   * Freezing the *tick* instead leaves every value exactly where it was.
   */
  pause() {
    if (this.#state !== State.PLAYING) return; // nothing to freeze in a menu
    this.#transition(State.PAUSED);
  }

  resume() {
    if (this.#state !== State.PAUSED) return;
    this.#transition(State.PLAYING);
  }

  /** The shape a single key wants. Both halves still go through the guards above. */
  togglePause() {
    if (this.#state === State.PLAYING) this.pause();
    else if (this.#state === State.PAUSED) this.resume();
  }

  gameOver() {
    if (this.#state !== State.PLAYING) return; // two obstacles in one frame, one death
    this.#speed = 0;
    this.#moveDist = 0;

    const final = Math.floor(this.#score);
    const isRecord = final > this.#persistence.getHighScore();
    // Persist BEFORE announcing the transition: HUD renders the best score off the
    // stateChanged handler, so the store has to already be current when it reads.
    if (isRecord) this.#persistence.submitScore(final);

    this.#transition(State.GAME_OVER);
    if (isRecord) this.#bus.emit('newHighScore', { score: final });
  }

  update(dt) {
    if (this.#state !== State.PLAYING) return;
    // Order is load-bearing and matches the pre-split loop exactly: speed comes from
    // *last* frame's score, then this frame's distance is banked into it. Flipping
    // these two lines compounds the speed curve and the run gets measurably faster.
    this.#speed = BASE_SPEED + this.#score * SPEED_GAIN_PER_POINT;
    this.#moveDist = this.#speed * DISTANCE_PER_SPEED_UNIT * dt;
    this.#score += this.#moveDist * SCORE_PER_DISTANCE;
    this.#advanceTier();
  }

  /**
   * Awarded by ObstacleManager through the bus for a near miss it detected. A method rather
   * than a public setter for the same reason gameOver() is a method: score has one writer,
   * and "add exactly this much, only while playing" is a rule that has to live with the
   * value it guards. The PLAYING check is not theoretical — the crash frame emits `grazed`
   * for obstacles still clearing the car after the impact that killed the run.
   */
  awardGraze() {
    if (this.#state !== State.PLAYING) return;
    this.#score += GRAZE_BONUS;
  }

  /**
   * One comparison, and it climbs at most one tier per call. Score only ever increases within
   * a run, so the current tier is a cursor into the table rather than something to search
   * for — and a single step is provably enough: the smallest gap between thresholds is 350
   * points, while the most a frame can add is one frame of distance plus a handful of graze
   * bonuses, nowhere near it. Same discipline as #transition(): silent unless something
   * actually changed, so a subscriber can treat tierChanged as a real edge.
   */
  #advanceTier() {
    if (this.#tier >= TIER_THRESHOLDS.length) return;
    if (this.#score < TIER_THRESHOLDS[this.#tier]) return;
    this.#tier++;
    this.#bus.emit('tierChanged', { tier: this.#tier });
  }

  #transition(to) {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.#bus.emit('stateChanged', { from, to });
  }
}
