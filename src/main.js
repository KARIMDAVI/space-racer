import * as THREE from 'three';

import { EventBus } from './core/EventBus.js';
import { GameManager } from './core/GameManager.js';
import { InputHandler } from './core/InputHandler.js';
import { PersistenceService } from './core/PersistenceService.js';
import { PlayerCar } from './entities/PlayerCar.js';
import { Environment } from './world/Environment.js';
import { ObstacleManager } from './world/ObstacleManager.js';
import { RenderPipeline } from './render/RenderPipeline.js';
import { HUD } from './ui/HUD.js';

/**
 * ARCHITECTURE: Composition root
 * Decision: this file builds every module, hands each one its dependencies, and
 *   runs the tick. It holds no game state and contains no gameplay rule.
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

const canvas = document.querySelector('#gameCanvas');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.015); // deep space — also hides the spawn line

const bus = new EventBus();
const persistence = new PersistenceService();
const game = new GameManager(bus, persistence);
const input = new InputHandler();
const player = new PlayerCar(scene, bus);
const environment = new Environment(scene);
const obstacles = new ObstacleManager(scene, bus, player); // reads the car's hitbox once, at build time
const pipeline = new RenderPipeline(canvas, scene, game);
const hud = new HUD(game, bus);

// ObstacleManager reports the impact; GameManager decides what death means. This one
// hop is what keeps GameManager the single mutation entry point (Principle II).
bus.on('crashed', () => game.gameOver());

const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);

  const dt = Math.min(clock.getDelta(), MAX_FRAME_DELTA);

  input.update();
  game.update(dt);                    // advances score/speed; everything below reads them
  player.update(dt, input.steerAxis, game.speed);
  environment.update(dt, game);
  obstacles.update(dt, game);         // may emit `crashed`, which lands synchronously
  hud.update();
  pipeline.render(dt);
}

tick();

window.addEventListener('resize', () => pipeline.resize());
