import * as THREE from 'three';

import { AssetManager } from './core/AssetManager.js';
import { EventBus } from './core/EventBus.js';
import { GameManager } from './core/GameManager.js';
import { InputHandler } from './core/InputHandler.js';
import { PersistenceService } from './core/PersistenceService.js';
import { AudioManager } from './audio/AudioManager.js';
import { PlayerCar } from './entities/PlayerCar.js';
import { Environment } from './world/Environment.js';
import { ObstacleManager } from './world/ObstacleManager.js';
import { RenderPipeline } from './render/RenderPipeline.js';
import { HUD } from './ui/HUD.js';

/**
 * ARCHITECTURE: Composition root
 * Decision: this file builds every module, hands each one its dependencies, and
 *   runs the tick. It owns exactly one mutable value — the impact slow-motion
 *   timer below — and no game state or gameplay rule.
 * Reason: Principle I. Wiring in exactly one place is what lets each module below
 *   be read, and reasoned about, without reading any of the others.
 * Trade-off: the constructor argument lists are explicit rather than resolved by a
 *   container. That's the point — the dependency graph is the ten lines below, and
 *   a cycle would be visible on sight.
 * If nothing renders, work down the tick in order: a throw in any module's
 *   constructor kills the loop before it starts, and the console will name it.
 */

// Clamp the frame delta. A backgrounded tab hands back a multi-second delta on
// return; unclamped, obstacles teleport past the car's bounding box between two
// tests and the player dies to something they never saw, or survives something they
// should have hit. 1/30s is the largest step the collision window tolerates.
const MAX_FRAME_DELTA = 1 / 30;

/**
 * ARCHITECTURE: Impact slow motion
 * Decision: a crash dilates time for a fixed window of *real* seconds by scaling the delta
 *   handed to the simulation and the render pipeline. It is one countdown and one multiply,
 *   here in the tick.
 * Reason: it belongs to nobody else. It is not game state — nothing reads it as the answer to
 *   a question about the run, GameManager's machine is untouched, and no transition is added,
 *   delayed or duplicated. It is not a rendering effect either, so RenderPipeline cannot own
 *   it without inverting the dependency and letting the renderer dictate the simulation's
 *   clock. What it actually is, is a property of how fast the tick advances the world, and the
 *   tick lives here. Adding a module the Constitution does not name, for one float, is the
 *   alternative RenderPipeline already rejected for the camera.
 * Trade-off: the composition root is no longer literally stateless. One documented `let` in
 *   the loop that drives everything is a smaller cost than a fifth owner in the Ownership Map.
 *
 * The window is spent against the *unscaled* delta, so it is 0.3s of wall clock however slow
 * the world is running. That lines it up with the 0.3s opacity transition style.css gives the
 * game-over overlay: the wreck is still tumbling apart underneath while the screen fades in,
 * instead of the impact being over before the player has seen it.
 *
 * By the time the game is in GAME_OVER, GameManager and ObstacleManager have both stopped
 * early-returning anything meaningful, so what this actually stretches is precisely the crash:
 * the car's tumble and collapse, the shatter particles, and RenderPipeline's trauma decay.
 */
const SLOWMO_DURATION = 0.3;  // real seconds
const SLOWMO_SCALE = 0.25;
let slowmoRemaining = 0;

const canvas = document.querySelector('#gameCanvas');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.015); // deep space — also hides the spawn line

const bus = new EventBus();
const persistence = new PersistenceService();
const game = new GameManager(bus, persistence);
const input = new InputHandler(bus);
const player = new PlayerCar(scene, bus);
const environment = new Environment(scene, bus); // eases the road and fog on tierChanged
const obstacles = new ObstacleManager(scene, bus, player); // reads the car's hitbox once, at build time
const pipeline = new RenderPipeline(canvas, scene, game, bus); // subscribes to `crashed` for camera trauma
const assets = new AssetManager();
// Built before the bus.on lines below on purpose: EventBus dispatches in subscription
// order, so AudioManager's `crashed` handler runs while the engine is still at speed,
// rather than after game.gameOver() has already taken the run out of PLAYING.
const audio = new AudioManager(bus, persistence, assets);
const hud = new HUD(game, bus, audio); // owns the mute button; calls into audio, never past it

// ObstacleManager reports the impact; GameManager decides what death means. This one
// hop is what keeps GameManager the single mutation entry point (Principle II).
bus.on('crashed', () => game.gameOver());
bus.on('pauseToggled', () => game.togglePause());
// Same one-way hop as `crashed`: ObstacleManager decides a pass *was* a near miss,
// GameManager decides what one is worth.
bus.on('grazed', () => game.awardGraze());

// Lands mid-update, inside the obstacles.update() that detected the impact, so the dilation
// starts on the *next* frame. That is a frame of full-speed impact before the world slows,
// which is what gives the beat something to decelerate from.
bus.on('crashed', () => { slowmoRemaining = SLOWMO_DURATION; });

// Auto-pause on a lost tab, and deliberately no auto-resume on return: rAF stops
// while hidden, so an automatic resume would drop the player straight back into a
// live run they aren't looking at yet. Coming back to a paused frame is the kind
// thing to do. game.pause() is a no-op outside PLAYING, so the menu is unaffected.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.pause();
});

const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);

  // Read the clock every frame, paused or not. getDelta() measures since its own last
  // call, so skipping it while paused would bank the entire pause into the first
  // resumed frame and jump the world forward by it (up to the clamp, every time).
  const elapsed = Math.min(clock.getDelta(), MAX_FRAME_DELTA);

  // Spent against real time, scaled into world time. Counting the window down with the dilated
  // delta instead would make the beat outlast itself by 1/SLOWMO_SCALE.
  const dt = slowmoRemaining > 0 ? elapsed * SLOWMO_SCALE : elapsed;
  slowmoRemaining = Math.max(0, slowmoRemaining - elapsed);

  // Device polling stays live while paused — it's what receives the key that unpauses.
  input.update();

  // Pause freezes the simulation by not running it. Each module below already gates
  // on PLAYING internally, so this is belt-and-braces for all but Environment's star
  // drift; it earns its place by making "paused means nothing advances" a single
  // readable fact rather than a property emerging from five separate early returns.
  if (!game.isPaused) {
    game.update(dt);                  // advances score/speed; everything below reads them
    player.update(dt, input.steerAxis, game.speed);
    environment.update(dt, game);
    obstacles.update(dt, game);       // may emit `crashed`, which lands synchronously
    hud.update();
  }

  // Outside the gate for the mirror-image reason: a paused frame shows the frozen scene,
  // and a paused game falls quiet. A module that isn't ticked can't ramp itself down, so
  // gating this would leave the engine droning over the pause screen. AudioManager takes
  // no delta — it schedules against the audio clock, which neither stalls with rAF nor
  // dilates with the slow-motion beat above.
  audio.update(game);
  pipeline.render(dt);
}

tick();

window.addEventListener('resize', () => pipeline.resize());

