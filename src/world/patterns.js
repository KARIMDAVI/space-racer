/**
 * ARCHITECTURE: Authored patterns, not per-obstacle dice
 * Decision: difficulty is a hand-written table of spawn scripts. The scheduler picks a
 *   pattern, plays its steps in order, rests, picks another. No obstacle is ever placed by
 *   a random lane roll.
 * Reason: this is the whole difference between a dodge game and a box spawner. A random
 *   spawner produces unsolvable frames — two wide walls a hundred units apart with no
 *   reachable gap — and the player cannot tell those apart from their own mistakes, so they
 *   learn nothing and blame the game. Every entry below is solvable by construction, and
 *   because they repeat, a returning player gets *better* at them. Randomness stays where it
 *   belongs: which pattern comes next, not what is in it.
 * Trade-off: content is finite and memorisable. That is the intended cost — memorising a
 *   pattern is the skill being sold. The mitigation is the tier filter, which keeps most of
 *   the table unseen until the player has earned it.
 *
 * Solvability rule, applied to every `z` below: a player crosses one lane (3 units) in
 * 3 / 20 = 0.15s, and at tier 5 the world scrolls at ~420 units/sec, so one lane costs
 * ~63 units of z. Every step that *requires* a lane change is spaced at least 90 units from
 * the one that forced it — ~1.4 lanes of budget for one lane of movement, at the fastest
 * speed the game reaches. Slower tiers get proportionally more room for free.
 *
 * Exit-lane rule, and it is the one that is easy to get wrong: a pattern is not solvable on
 * its own, it is solvable *followed by another pattern*. `length` minus the last step's `z`
 * is the clear tail, and the tail plus the tier's gap is all the room a player gets to move
 * from wherever this pattern left them to wherever the next one demands they be. Patterns
 * that end pinning the player against a rail therefore need ~260 units of tail (a rail-to-
 * rail crossing is ~12 units of x, which is 252 units of z at tier-5 speed); patterns that
 * release near the centre need ~100. Authoring a tight tail on a rail-ending pattern is how
 * this table produces a death the player could not have avoided, and it does not show up in
 * the pattern itself — only in the pair.
 *
 * The `clear:` line on each pattern is the audit: it names a lane path that survives it.
 * Verified by simulating the real init/behavior functions with a reachability sweep over
 * player position — every pattern alone, and all 484 ordered pattern pairs. See the S6 report.
 *
 * Steps must be ordered by ascending `z`; the scheduler walks them with a moving cursor and
 * never looks backwards. `length` is the z-span the pattern occupies, measured from its
 * first step, and the inter-pattern gap is added on top of it.
 */

/**
 * ADR (Principle II — one source of truth for a lane): `orbLane` is which lane a car can sit in
 * for this pattern's *entire* span without ever touching a solid obstacle, or null when no such
 * lane exists. CollectibleManager rides orb lines and power-up crates down it, which is what
 * makes a pickup teach the safe path rather than pull the player off it.
 *
 * It lives on the pattern rather than in a table beside CollectibleManager for the obvious
 * reason: it is a property of the steps below, so the day a step moves, the lane that survives
 * it moves in the same edit. A second file keyed by pattern id would be a second source of
 * truth for a fact this one already contains, and it would drift silently — the failure mode
 * being an orb line drawn straight through a wall.
 *
 * Every value was *measured*, not read off the `clear:` lines: a throwaway harness replayed the
 * real init/behavior functions from obstacleTypes.js at tier-5 tuning, with the real measured
 * car hitbox, and reported the minimum x-gap for a car parked in each of the five lanes across
 * the whole flight — at tier-5 speed and again with hyperdrive's multiplier on top, since a
 * time-driven type (slider, hunter) resolves differently when the world scrolls faster.
 *
 * That distinction earned its keep. The `clear:` line on splitter-open says lane 2 clears both
 * splitters; the harness measures lane 2 at -2.16, a solid collision, because a splitter half
 * travels a full LANE_WIDTH and the one at lane 1 therefore ends *on* lane 2. The lanes that
 * actually survive it are ±1. The comment is left as S6 wrote it — auditing the pattern library
 * is not this step's job — but no orbLane here is derived from one.
 *
 * Two patterns are null by judgement rather than by measurement. hunter-lone and hunter-gate
 * both have a lane the harness calls safe, and both are excluded anyway: a drone converges on
 * wherever the car is, so the whole read of a hunter is that no lane stays safe. An orb line
 * promising otherwise would teach exactly the habit that gets the player killed by hunter-pinch.
 */

/** Lanes are -2..2. `from`/`to` on a barricade are inclusive; `lane` on a roller is its left lane. */
export const PATTERNS = Object.freeze([
  {
    id: 'open-drift', minTier: 0, weight: 4, length: 300, orbLane: 2,
    // clear: hold lane 2 (or -2) throughout — nothing ever reaches the outer lanes.
    steps: [
      { type: 'block', lane: -1, z: 0 },
      { type: 'block', lane: 1, z: 110 },
      { type: 'block', lane: -1, z: 220 }
    ]
  },
  {
    id: 'slalom-right', minTier: 0, weight: 3, length: 480, orbLane: null,
    // clear: sit at lane 2 through z=300, then step to lane 1 for the last block (100 units).
    steps: [
      { type: 'block', lane: -2, z: 0 },
      { type: 'block', lane: -1, z: 100 },
      { type: 'block', lane: 0, z: 200 },
      { type: 'block', lane: 1, z: 300 },
      { type: 'block', lane: 2, z: 400 }
    ]
  },
  {
    id: 'slalom-left', minTier: 0, weight: 3, length: 480, orbLane: null,
    // clear: mirror of slalom-right — sit at lane -2, step to -1 for the last block.
    steps: [
      { type: 'block', lane: 2, z: 0 },
      { type: 'block', lane: 1, z: 100 },
      { type: 'block', lane: 0, z: 200 },
      { type: 'block', lane: -1, z: 300 },
      { type: 'block', lane: -2, z: 400 }
    ]
  },
  {
    id: 'wall-cross', minTier: 0, weight: 3, length: 290, orbLane: null,
    // clear: lane 1 or 2 for the first wall, cross to lane -1 or -2 for the second (180 units
    // for a 6-unit crossing — 8.5 units are available at tier 5).
    steps: [
      { type: 'barricade', from: -2, to: 0, z: 0 },
      { type: 'barricade', from: 0, to: 2, z: 180 }
    ]
  },
  {
    id: 'wall-hold', minTier: 0, weight: 3, length: 300, orbLane: 0,
    // clear: lane 0 survives both rows — the outer walls and the outer blocks never cover it.
    steps: [
      { type: 'barricade', from: -2, to: -1, z: 0 },
      { type: 'block', lane: 2, z: 0 },
      { type: 'barricade', from: 1, to: 2, z: 180 },
      { type: 'block', lane: -2, z: 180 }
    ]
  },
  {
    id: 'convoy-weave', minTier: 1, weight: 3, length: 460, orbLane: 2,
    // clear: lane 2 is clear of every block in the column; the convoy is a read, not a wall.
    steps: [
      { type: 'block', lane: -1, z: 0 },
      { type: 'block', lane: 0, z: 90 },
      { type: 'block', lane: 1, z: 180 },
      { type: 'block', lane: 0, z: 270 },
      { type: 'block', lane: -1, z: 360 }
    ]
  },
  {
    id: 'convoy-gate', minTier: 1, weight: 3, length: 400, orbLane: null,
    // clear: take the gate at lane -2, then walk out one lane at a time — -1 by z=140,
    // 0 by z=230, 1 by z=320. Each leg is one lane with 90+ units to make it.
    steps: [
      { type: 'gate', gap: -2, z: 0 },
      { type: 'block', lane: -2, z: 140 },
      { type: 'block', lane: -1, z: 230 },
      { type: 'block', lane: 0, z: 320 }
    ]
  },
  {
    id: 'gate-sweep', minTier: 1, weight: 2, length: 620, orbLane: null,
    // clear: lane 2 → lane 0 → lane -2, two lanes per leg with 180 units each.
    // The 260-unit tail is not padding — see the exit-lane rule in the header. This pattern
    // ends with the player pinned against the left rail, and at 440 the audit found it
    // unsolvable followed by wall-cross, finale-drive or itself: three patterns that open by
    // demanding the right-hand side, with only the 95-unit tier-5 gap to cross in.
    steps: [
      { type: 'gate', gap: 2, z: 0 },
      { type: 'gate', gap: 0, z: 180 },
      { type: 'gate', gap: -2, z: 360 }
    ]
  },
  {
    id: 'gate-nerve', minTier: 1, weight: 3, length: 400, orbLane: 0,
    // clear: lane 0 the whole way — the blocks bracket it without touching it.
    steps: [
      { type: 'gate', gap: 0, z: 0 },
      { type: 'block', lane: -1, z: 160 },
      { type: 'block', lane: 1, z: 160 },
      { type: 'gate', gap: 0, z: 320 }
    ]
  },
  {
    id: 'slider-single', minTier: 2, weight: 3, length: 300, orbLane: 2,
    // clear: lanes ±2. A slider's amplitude is one lane, so it never reaches past x = ±3.8.
    steps: [
      { type: 'slider', lane: 0, phase: 0, z: 0 },
      { type: 'slider', lane: 0, phase: 3.14159, z: 200 }
    ]
  },
  {
    id: 'slider-scissor', minTier: 2, weight: 2, length: 300, orbLane: 2,
    // clear: the two sliders converge on lane 0 and split back out, so the safe lane moves —
    // outside them (±2) while they are apart, lane 0 is never safe. Outer lanes always are:
    // the left slider tops out at x=0.8, the right bottoms out at x=-0.8.
    steps: [
      { type: 'slider', lane: -1, phase: 0, z: 0 },
      { type: 'slider', lane: 1, phase: 3.14159, z: 0 }
    ]
  },
  {
    id: 'splitter-open', minTier: 2, weight: 3, length: 280, orbLane: 1,
    // clear: lane ±1 clears both splitters — a splitter's halves stop one lane out from
    // centre and land ON lane ±2, not past it. Corrected 2026-08-21 after S7's replay
    // harness measured lane 2 as a solid collision (-2.16); lane ±1 is what orbLane already used.
    steps: [
      { type: 'splitter', lane: -1, z: 0 },
      { type: 'splitter', lane: 1, z: 170 }
    ]
  },
  {
    id: 'splitter-trap', minTier: 2, weight: 3, length: 300, orbLane: 0,
    // clear: the splitter opens to lanes ±1, so lane 0 is the hole it leaves — and the outer
    // blocks close the escape lanes, which is the whole point: go through the middle.
    steps: [
      { type: 'splitter', lane: 0, z: 0 },
      { type: 'block', lane: -2, z: 180 },
      { type: 'block', lane: 2, z: 180 }
    ]
  },
  {
    id: 'pulse-read', minTier: 3, weight: 3, length: 340, orbLane: null,
    // clear: the open half is anchored to arrival (see initPulse) — take the left half at
    // z=0, then cross to the right half by z=240 (a 240-unit leg for a half-width crossing).
    steps: [
      { type: 'pulse', open: 0, z: 0 },
      { type: 'pulse', open: 1, z: 240 }
    ]
  },
  {
    id: 'pulse-commit', minTier: 3, weight: 3, length: 280, orbLane: 1,
    // clear: come through the right half (x > 0), then the block at lane 2 pushes you back
    // to lane 0 or 1 — one to two lanes with 160 units.
    steps: [
      { type: 'pulse', open: 1, z: 0 },
      { type: 'block', lane: 2, z: 160 }
    ]
  },
  {
    id: 'roller-pair', minTier: 3, weight: 3, length: 320, orbLane: 2,
    // clear: lane 2 clears the first roller (lanes -1,0) and lane -2 clears the second
    // (lanes 0,1) — but lane 2 also clears the second, so holding lane 2 survives both.
    steps: [
      { type: 'roller', lane: -1, z: 0 },
      { type: 'roller', lane: 0, z: 200 }
    ]
  },
  {
    id: 'roller-drive', minTier: 3, weight: 2, length: 340, orbLane: 2,
    // clear: dodge the roller (lanes 0,1) into lane -2, then cross to lane 0+ for the wall.
    // 190 units for 6 units of travel. The roller closes at 1.3x, so it arrives early — the
    // wall is deliberately far enough back that the overlap never squeezes the crossing.
    steps: [
      { type: 'roller', lane: 0, z: 0 },
      { type: 'barricade', from: -2, to: -1, z: 190 }
    ]
  },
  {
    id: 'hunter-lone', minTier: 4, weight: 3, length: 320, orbLane: null,
    // clear: anywhere — a drone turns at 2.5 units/sec against the car's 20. Sidestep it.
    steps: [
      { type: 'hunter', lane: 0, z: 0 },
      { type: 'hunter', lane: 0, z: 220 }
    ]
  },
  {
    // 260-unit tail for the same reason as gate-sweep: it ends pinned against the right rail.
    id: 'hunter-gate', minTier: 4, weight: 3, length: 520, orbLane: null,
    // clear: the drone follows you toward lane 2; the gate's gap is at lane 2 and the drone
    // cannot cover the 6+ units it would need in the time the gate takes to arrive.
    steps: [
      { type: 'hunter', lane: 0, z: 0 },
      { type: 'gate', gap: 2, z: 260 }
    ]
  },
  {
    id: 'hunter-pinch', minTier: 4, weight: 2, length: 300, orbLane: null,
    // clear: two drones start on the rails and converge; the block at lane 0 forces you off
    // centre before either can close. Take lane 1, then step out as the right drone arrives.
    steps: [
      { type: 'hunter', lane: -2, z: 0 },
      { type: 'hunter', lane: 2, z: 0 },
      { type: 'block', lane: 0, z: 180 }
    ]
  },
  {
    id: 'finale-drive', minTier: 5, weight: 2, length: 700, orbLane: null,
    // clear: gate at lane 1 → splitter at lane 1 opens to lanes 0 and 2, so hold lane 1 →
    // pulse left half → roller covers lanes -1,0, so exit right. Every leg is 190+ units.
    steps: [
      { type: 'gate', gap: 1, z: 0 },
      { type: 'splitter', lane: 1, z: 190 },
      { type: 'pulse', open: 0, z: 400 },
      { type: 'roller', lane: -1, z: 600 }
    ]
  },
  {
    id: 'finale-hunt', minTier: 5, weight: 2, length: 680, orbLane: null,
    // clear: pulse right half → drone spawns at centre and trails → gate gap at lane -1
    // (200 units to cross from the right side, 6-9 units of travel) → slider at lane 0 sweeps
    // one lane either way, so finish on lane -2 or 2.
    steps: [
      { type: 'pulse', open: 1, z: 0 },
      { type: 'hunter', lane: 0, z: 200 },
      { type: 'gate', gap: -1, z: 400 },
      { type: 'slider', lane: 0, phase: 0, z: 580 }
    ]
  }
]);

/**
 * The pacing valley. Held apart from PATTERNS so the weighted pick below cannot draw it by
 * accident and so its length is not tangled up with the tier filter — a rest is scheduled,
 * not rolled. Roughly a second of empty road at launch speed, and it is the only reason the
 * ramp reads as escalation rather than as constant noise: without a floor to come back to,
 * the player has nothing to measure the peaks against.
 */
export const REST = Object.freeze({
  id: 'rest', minTier: 0, length: 280, steps: Object.freeze([]),
  // Empty road, so all five lanes measure clear. Centre because a rest is the beat the player
  // is meant to recover on, and lane 0 is where they can reach the next pattern's demand from
  // in the fewest units whichever side it lands on.
  orbLane: 0
});

/** Patterns between rests. Rolled fresh after every rest so the cadence never becomes a metronome. */
export const REST_INTERVAL_MIN = 5;
export const REST_INTERVAL_SPAN = 3; // 5, 6 or 7

/**
 * Which patterns may carry a power-up crate. Derived at module load rather than written out by
 * hand, so a pattern that gains a gate step stops being crate-safe in the same edit instead of
 * in a follow-up nobody makes.
 *
 * A crate is a *decision* — it is worth a detour, and the player will take one to reach it. Gate
 * and pulse patterns are the two whose safe window is a timing read rather than a lane, so a
 * crate inside one asks the player to weigh a reward against a window they are already spending
 * their whole attention on. Orbs stay allowed there: an orb is worth 25 points and no detour, so
 * it decorates the correct line instead of competing with it.
 */
const TIGHT_TYPES = ['gate', 'pulse'];

/**
 * A frozen array rather than a Set, and the difference is not stylistic: `Object.freeze` on a
 * Set freezes the object's properties and leaves `add`/`delete` working on its internal slots,
 * so a frozen Set is immutable-looking and mutable. Ten ids and one `includes` per pattern
 * change — a few times a second, never per frame — is not a lookup worth lying about.
 */
export const CRATE_SAFE = Object.freeze(
  [...PATTERNS, REST]
    .filter((pattern) => pattern.orbLane !== null && pattern.steps.every((step) => !TIGHT_TYPES.includes(step.type)))
    .map((pattern) => pattern.id)
);

/**
 * Weighted pick over everything unlocked, minus whatever just played. Two passes over a
 * frozen array and no allocation — this runs a few times a second at the top tier, which is
 * nowhere near per-frame, but building a filtered array here would be a needless GC customer
 * on the one code path that already knows exactly what it is looking for.
 *
 * `exclude` is the no-immediate-repeat rule. Back-to-back repeats are what make an authored
 * table feel smaller than it is — the same shape twice reads as "the game only has three of
 * these" even when it has twenty.
 */
export const selectPattern = (tier, exclude) => {
  let total = 0;
  for (let i = 0; i < PATTERNS.length; i++) {
    const pattern = PATTERNS[i];
    if (pattern.minTier <= tier && pattern.id !== exclude) total += pattern.weight;
  }

  let roll = Math.random() * total;
  for (let i = 0; i < PATTERNS.length; i++) {
    const pattern = PATTERNS[i];
    if (pattern.minTier > tier || pattern.id === exclude) continue;
    roll -= pattern.weight;
    if (roll <= 0) return pattern;
  }

  // Only reachable if the table ever holds fewer than two tier-0 entries, in which case the
  // exclusion emptied it. Returning the first entry repeats rather than crashing.
  return PATTERNS[0];
};
