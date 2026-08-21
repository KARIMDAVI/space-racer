import * as THREE from 'three';

/**
 * ARCHITECTURE: Generated gradient textures, no asset pipeline
 * Decision: draw gradients into an offscreen <canvas> once and hand back a CanvasTexture.
 * Reason: Principle IV. Three callers want gradients — a soft particle dot, the car's light
 *   pool, and the car's reflection environment — and the alternatives cost more than they are
 *   worth. Image files mean binary assets, fetches, an AssetManager to sequence them, a
 *   progress UI, a failure path and a licence question, for something Canvas2D draws in four
 *   lines. A ShaderMaterial means a program to compile and maintain so a fragment can compute
 *   a lerp. The 2D context is already in the browser and produces a real, filtered texture.
 * Trade-off: the falloffs are baked at generation time, so retuning one is a code change and a
 *   reload rather than a uniform write. Nothing using these animates its gradient, so the
 *   flexibility would be paid for and never spent.
 * If a sprite renders as a hard-edged square, its stop list never reached a zero alpha — the
 *   texture is sampled across the whole quad and the outermost stop fills the corners.
 */

/** Shared by both builders: a fresh canvas, sized, with its 2D context. */
const surface = (width, height) => {
  // A fresh canvas per texture, deliberately. CanvasTexture holds a live reference to the
  // element and uploads it lazily at first render, so a shared canvas would hand every texture
  // built from it whatever happened to be drawn there last.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return [canvas, canvas.getContext('2d')];
};

const paint = (canvas, context, gradient, stops) => {
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  // The stops are CSS colours, which are sRGB. Saying so is what lets the renderer linearise
  // them before they reach the composer's linear HDR buffer; left at the default they would be
  // treated as already-linear, and everything drawn with them reads washed out and too bright.
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

/**
 * A soft radial blob. `stops` is `[[offset, cssColor], …]`, centre first. Keep `size` a power of
 * two — three only builds a mipmap chain for POT textures, and these are sampled at wildly
 * varying screen sizes (a particle a metre away and one at the vanishing point).
 */
export const radialTexture = (stops, size = 128) => {
  const [canvas, context] = surface(size, size);
  const centre = size / 2;
  return paint(canvas, context, context.createRadialGradient(centre, centre, 0, centre, centre, centre), stops);
};

/**
 * A top-to-bottom gradient for use as an equirectangular reflection environment.
 *
 * ADR (Principle IV): this exists because a metalness-0.9 material with nothing to reflect is
 * *black by definition* — a metal's colour response comes almost entirely from its environment,
 * so with no envMap the car rendered as a cutout no amount of clearcoat tuning could rescue.
 * The three real options were: drop metalness (abandons the brief and the look), light the car
 * harder (a fourth dynamic light, which Principle III rules out and which flattens the shape
 * anyway), or give it something to reflect. A 16x64 canvas gradient costs 4KB, no fetch and no
 * HDR loader, and because it is authored from the scene's own palette the reflection agrees
 * with the sky and road the car is actually sitting in.
 * Trade-off: it is not a real capture of the scene, so the car does not reflect obstacles or
 * the rails. At this size on screen that is invisible, and the alternative — a per-frame cube
 * camera — is exactly the kind of cost Principle III exists to refuse.
 *
 * Width is deliberately tiny: the gradient varies only with latitude, so horizontal resolution
 * carries no information at all.
 */
export const equirectGradient = (stops) => {
  const [canvas, context] = surface(16, 64);
  const texture = paint(canvas, context, context.createLinearGradient(0, 0, 0, canvas.height), stops);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
};
