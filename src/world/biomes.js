import * as THREE from 'three';

/**
 * ARCHITECTURE: Biomes as a shared palette table, applied by whoever owns each value
 * Decision: this file is data and nothing else. It holds four palettes and the tier → biome
 *   map, and it applies none of them. `Road` writes its own uniforms and rail material,
 *   `Environment` writes the scene fog and owns the transition clock, `RenderPipeline` writes
 *   its own bloom strength. Three readers, one table, no writer in the middle.
 * Reason: Principle I. The obvious alternative is a `BiomeManager` that holds references to
 *   Road, the fog and the pipeline and pushes values into all three — which is precisely one
 *   module reaching into three others' internals, and it would put the bloom strength under
 *   two owners the first time anything else wanted to touch it. A table every owner reads is
 *   the same coordination with none of the authority.
 * Trade-off: the transition is eased in two places (Environment for the scene, RenderPipeline
 *   for bloom) rather than one. Both read BIOME_FADE below, so they cannot drift apart in
 *   duration; what they *can* do is start a frame apart, which is invisible over three seconds.
 * If a biome never arrives, check that `tierChanged` still fires — GameManager emits it at
 *   most once per tier and deliberately stays silent on a self-transition, so a subscriber
 *   that misses the edge waits forever rather than catching up on the next frame.
 */

/**
 * ADR (art direction, weighed against Principle III): every base colour below is near-black
 * with a hue bias, not a saturated tint, and `fog` tracks it closely. That is not timidity —
 * it is the invariant Road's fragment shader is written against. The grid fades toward
 * uBaseColor at distance *instead of* carrying a fog chunk, on the stated grounds that fading
 * to base and fogging to black are the same picture. A biome that lifted uBaseColor to a real
 * colour would break that equivalence: the road would fade to cyan while every obstacle on it
 * faded to black, and the horizon would tear along the line where they met.
 *
 * So the biome's colour lives in `line` and `rail` — the two emissive elements, which are also
 * the only two that clear the bloom threshold and therefore the only two the player reads as
 * "the world changed colour". The base and the fog move just enough to stop the neon sitting
 * on a neutral grey.
 *
 * `glow` is per-biome rather than constant because the bloom pass weights Rec601, so equal
 * `glow` across hues does not mean equal bloom: a cyan line carries far more luma through
 * 0.587·G + 0.114·B than an orange one does. The numbers below hold the *bloomed* line width
 * roughly constant across the four, which is what keeps the road legible at tier 5.
 */
const BIOMES = Object.freeze([
  Object.freeze({
    // Tiers 0-1. The shipped look, transcribed verbatim from Road.js's own constants and
    // RenderPipeline's BLOOM_STRENGTH — this entry exists so the opening of a run is served
    // by the same code path as every other biome, not so it can look different.
    id: 'ember',
    line: new THREE.Color(0xff8800),
    base: new THREE.Color(0x060010),
    rail: new THREE.Color(0xff9500),
    fog: new THREE.Color(0x000000),
    glow: 1.5,
    density: 0.015,
    bloom: 0.55
  }),
  Object.freeze({
    // Tiers 2-3. Cold, and deliberately the same cyan as the gate and pulse edges the player
    // has just been handed — the world turning the colour of the new hardware is the cheapest
    // legible way to say "this is what changed".
    id: 'coolant',
    line: new THREE.Color(0x00d5ff),
    base: new THREE.Color(0x00060f),
    rail: new THREE.Color(0x22ddff),
    fog: new THREE.Color(0x000308),
    glow: 1.32,
    density: 0.016,
    bloom: 0.58
  }),
  Object.freeze({
    // Tier 4. Hunter drones arrive here; violet is the one hue on the wheel that reads as
    // hostile without yet reading as an alarm, which tier 5 needs to still have available.
    id: 'violet',
    line: new THREE.Color(0xff33cc),
    base: new THREE.Color(0x0a0014),
    rail: new THREE.Color(0xff55d5),
    fog: new THREE.Color(0x040008),
    glow: 1.42,
    density: 0.016,
    bloom: 0.62
  }),
  Object.freeze({
    // Tier 5. Red, and the only entry that lifts bloom meaningfully — the top tier is the one
    // place the frame is allowed to be slightly too bright to read comfortably, because that
    // discomfort is the difficulty being announced rather than a rendering mistake.
    id: 'critical',
    line: new THREE.Color(0xff2233),
    base: new THREE.Color(0x120004),
    rail: new THREE.Color(0xff4433),
    fog: new THREE.Color(0x090000),
    glow: 1.62,
    density: 0.018,
    bloom: 0.74
  })
]);

/**
 * Six tiers onto four biomes. The grouping is not even, and that is the point: tiers 0-1 share
 * the opening look because a biome shift in the first thirty seconds would spend the effect
 * before the player has anything to compare it against, while tiers 4 and 5 get one each
 * because that is where the run is being escalated hardest and the shifts are the reward for
 * getting there. Indexed directly by tier — GameManager clamps the tier to 0..5, so there is
 * no bounds check to get wrong.
 */
const TIER_BIOME = Object.freeze([0, 0, 1, 1, 2, 3]);

/** Seconds a biome transition takes. Long enough to notice happening, not long enough to wait for. */
export const BIOME_FADE = 3;

/** What a run opens on, and what a restart snaps back to. */
export const OPENING_BIOME = BIOMES[0];

export const biomeFor = (tier) => BIOMES[TIER_BIOME[tier]];
