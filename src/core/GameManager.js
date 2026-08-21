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

/** An orb, in score. Worth more than a graze because it costs a deliberate detour, not a line. */
const ORB_BONUS = 25;

/**
 * ARCHITECTURE: Power-ups as timed modifiers owned here
 * Decision: three floats — seconds remaining per kind — living on this object, ticked by this
 *   object's own update(), and mutated by exactly two methods below. Every other module either
 *   reads `game.powerups` or reacts to `powerupStarted`/`powerupEnded`. Nothing else writes.
 * Reason: Constitution Principle II and the Blueprint's Phase 3 exit criterion, which names
 *   active power-up state specifically as a thing that must not acquire a second source of
 *   truth. The tempting shape is a flag on PlayerCar for the shield, a flag on
 *   CollectibleManager for the magnet, and a couple of fields on RenderPipeline for
 *   hyperdrive's bloom and FOV — four owners, four clocks, and a guaranteed disagreement the
 *   first time a run ends mid-effect.
 * Trade-off: consumers pay a property read per frame instead of holding a cached boolean, and
 *   the visual modules have to be idempotent because an activation is allowed to re-fire while
 *   already active (see activatePowerup). Both are cheaper than four clocks.
 * If an effect outlives its power-up, look for a subscriber that reacted to `powerupStarted`
 *   but not to `powerupEnded` — the pairing is the contract, and nothing here enforces it.
 *
 * ADR (Principle III / main.js's clock): the countdown runs in update(dt), against the same
 * delta as everything else, rather than on setTimeout. A timer would keep running through a
 * pause, would ignore the crash slow-motion the tick applies, and would fire its callback at a
 * moment no frame owns — three ways for a shield to expire while the game is not looking. It
 * would also need cancelling on game-over, which is a second lifecycle to get wrong.
 */
const POWERUP_DURATIONS = Object.freeze({ shield: 12, magnet: 10, hyperdrive: 4 });

/** Indexed rather than iterated with for-in: a fixed list, no enum cache, no allocation. */
export const POWERUP_KINDS = Object.freeze(['shield', 'magnet', 'hyperdrive']);

/**
 * Hyperdrive's speed multiplier, applied on top of the normal curve rather than replacing it,
 * so it is a boost from wherever the run had reached instead of a jump to a fixed speed.
 *
 * It compounds, and that is intended: speed feeds moveDist feeds score feeds speed, so four
 * seconds of hyperdrive leaves the run permanently a little faster than it would have been.
 * The size of that is small — 1.45x for 4s adds roughly 180 points, well under one tier — and
 * it is the honest reward for the pickup.
 *
 * The patterns' solvability margins are audited at tier-5 speed with no allowance for a
 * multiplier on top, and this does not violate that: invulnerability is keyed to the same
 * field as the boost, so the two begin and end on the same frame and there is no instant where
 * the player is both faster than the audit and mortal.
 *
 * One bounded interaction is worth knowing about. initPulse anchors a pulse gate's open half
 * against the travel time measured at *spawn*, so a gate that spawns during hyperdrive and
 * arrives after it ends is anchored ~30% early. At tier 5 that trims the stable warning from
 * 0.49s to ~0.33s against a 0.42s worst-case crossing — thin, and only reachable in the last
 * half-second of the four. Re-anchoring live would mean a per-frame recompute on every pulse
 * record to fix a case this narrow, which is the trade Principle III says not to make.
 */
const HYPERDRIVE_SPEED_SCALE = 1.45;

export class GameManager {
  #bus;
  #persistence;
  #state = State.MENU;
  #score = 0;
  #speed = 0;
  #moveDist = 0;
  #tier = 0;

  /**
   * Seconds remaining per kind; 0 means inactive. One object, built once, mutated in place
   * forever — readers hold the same reference for the life of the game, so `game.powerups` is
   * a property read and never an allocation (Principle III).
   */
  #powerups = { shield: 0, magnet: 0, hyperdrive: 0 };

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
   * Live remaining seconds, keyed by kind. Handed out by reference rather than copied, which
   * makes it writable by a determined caller — the same shape `hitbox` and the pattern objects
   * already use elsewhere. The guarantee here is architectural, not enforced: activatePowerup
   * and absorbImpact are the only two places in the codebase that assign to these fields, and
   * that is a property a grep can check.
   */
  get powerups() { return this.#powerups; }

  /**
   * Whether an impact would be survived. Derived rather than stored, for the same reason `tier`
   * is derived: a cached boolean is a second thing to expire, and the day it disagreed with the
   * timers the player would take a hit through a shield that was still on screen.
   */
  get invulnerable() { return this.#powerups.shield > 0 || this.#powerups.hyperdrive > 0; }

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
    // Already zero unless the previous run was abandoned from the menu — gameOver() ends every
    // active power-up on its way out precisely so subscribers get told, rather than having
    // their visuals silently orphaned by a value being reset underneath them here.
    this.#clearPowerups();
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
    // Before the transition, not after: PlayerCar shatters off stateChanged, and a shield
    // bubble still standing around the debris would be the last thing the player sees. Ending
    // them here also means start() finds nothing to clean up.
    this.#clearPowerups();

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
    // Countdown first, so a power-up that expires this frame does not also get to apply its
    // modifier to it. The alternative ordering gives hyperdrive one extra boosted frame after
    // the invulnerability it is paired with has already lapsed.
    this.#tickPowerups(dt);

    // Order is load-bearing and matches the pre-split loop exactly: speed comes from
    // *last* frame's score, then this frame's distance is banked into it. Flipping
    // these two lines compounds the speed curve and the run gets measurably faster.
    const boost = this.#powerups.hyperdrive > 0 ? HYPERDRIVE_SPEED_SCALE : 1;
    this.#speed = (BASE_SPEED + this.#score * SPEED_GAIN_PER_POINT) * boost;
    this.#moveDist = this.#speed * DISTANCE_PER_SPEED_UNIT * dt;
    this.#score += this.#moveDist * SCORE_PER_DISTANCE;
    this.#advanceTier();
  }

  /**
   * Awarded by ObstacleManager through the bus for a near miss it detected. A method rather
   * than a public setter for the same reason gameOver() is a method: score has one writer,
   * and "add exactly this much, only while playing" is a rule that has to live with the
   * value it guards. The guard itself now sits in #award, shared with the orb bonus.
   */
  awardGraze() {
    this.#award(GRAZE_BONUS);
  }

  /**
   * An orb was driven through. Same one-way hop as the graze: CollectibleManager decides a
   * pickup happened, this decides what one is worth.
   */
  awardOrb() {
    this.#award(ORB_BONUS);
  }

  /**
   * Starts (or refreshes) a timed modifier. Called through the bus hop in main.js when
   * CollectibleManager reports a crate was collected — the crate names a kind, this owns how
   * long one lasts, so retuning a duration never means touching the module that spawns them.
   *
   * A refresh re-emits `powerupStarted` rather than quietly extending the clock, which makes
   * every subscriber's handler have to be idempotent (raising an already-raised shield is a
   * no-op; HUD simply re-renders the chip). That is the cheaper half of the trade: the
   * alternative is a `refreshed` event that every subscriber must then also handle correctly,
   * to say something none of them currently need to distinguish.
   */
  activatePowerup(kind) {
    if (this.#state !== State.PLAYING) return;
    const duration = POWERUP_DURATIONS[kind];
    // An unknown kind writes nothing. Storing it would put a NaN on a timeline that only ever
    // counts down, so the modifier would be permanent and invisible.
    if (duration === undefined) return;

    this.#powerups[kind] = duration;
    this.#bus.emit('powerupStarted', { kind, duration });
  }

  /**
   * An impact happened and the car survived it — spend whatever paid for that.
   *
   * ObstacleManager asks `invulnerable` before deciding a contact was fatal and reports the
   * absorbed ones on the bus; this is the other end of that hop. Hyperdrive is checked first
   * and deliberately consumes nothing: it is invincibility for its full duration, so a run of
   * obstacles taken at speed costs the same as one. A shield is the opposite — exactly one hit,
   * then it breaks — and `broken: true` is how PlayerCar tells a pop from a timeout.
   */
  absorbImpact() {
    if (this.#state !== State.PLAYING) return;
    if (this.#powerups.hyperdrive > 0) return;
    if (this.#powerups.shield <= 0) return; // nothing to spend: the contact should have been fatal
    this.#endPowerup('shield', true);
  }

  /** One writer for the score's two bonuses, so "only while playing" is stated once. */
  #award(amount) {
    // Not theoretical — the crash frame emits `grazed` for obstacles still clearing the car
    // after the impact that killed the run.
    if (this.#state !== State.PLAYING) return;
    this.#score += amount;
    // Carries the amount because HUD shows it and this is the only module that knows it. A
    // subscriber that only wants "something good happened" can ignore the payload.
    this.#bus.emit('scoreBonus', { amount });
  }

  #tickPowerups(dt) {
    for (let i = 0; i < POWERUP_KINDS.length; i++) {
      const kind = POWERUP_KINDS[i];
      const remaining = this.#powerups[kind];
      if (remaining <= 0) continue;

      const next = remaining - dt;
      if (next > 0) {
        this.#powerups[kind] = next;
        continue;
      }
      this.#endPowerup(kind, false); // ran out on its own clock — not broken, just over
    }
  }

  /** Ends every active modifier. Silent about the ones that already were. */
  #clearPowerups() {
    for (let i = 0; i < POWERUP_KINDS.length; i++) {
      if (this.#powerups[POWERUP_KINDS[i]] > 0) this.#endPowerup(POWERUP_KINDS[i], false);
    }
  }

  /**
   * Zeroed before the emit, never after. A subscriber is entitled to read `game.powerups`
   * inside its own handler — HUD's chip render does exactly that — and doing it in the other
   * order would show it a value the event has just announced is over.
   */
  #endPowerup(kind, broken) {
    this.#powerups[kind] = 0;
    this.#bus.emit('powerupEnded', { kind, broken });
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
