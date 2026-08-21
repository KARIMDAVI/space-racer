import * as THREE from 'three';

/**
 * ARCHITECTURE: The road surface
 * Decision: one static plane with a procedural grid in its fragment shader, plus two
 *   emissive edge rails. Nothing in this file moves. Scrolling is a float going into a
 *   uniform.
 * Reason: the two leapfrogging GridHelpers this replaces were geometry — two meshes whose
 *   transforms were rewritten every frame, wrapped by subtracting a span, with a seam
 *   visible once per lap because the wrap distance and the helper's extent had to agree by
 *   hand and the file said so in its own header. A shader grid deletes the whole class of
 *   bug: see SCROLL_PERIOD below for why the seam is now unrepresentable.
 * Trade-off: line placement is no longer inspectable in the scene graph, and getting it
 *   wrong is a shader edit rather than a number. Paid for by the grid now costing one draw
 *   call of two triangles regardless of how far the road runs.
 * If the grid renders as a solid glowing sheet, FADE_* is the control that matters — see
 *   the note on saturation in the fragment shader; the technique blows out at grazing
 *   angles by design and the fade is what hides it, not a decoration.
 */

const ROAD_WIDTH = 20;
const ROAD_LENGTH = 300;
const ROAD_NEAR_Z = 20;   // a little behind the camera at z=12, so the plane never ends on screen
const ROAD_Y = -1;        // the height the old GridHelpers sat at; the car's wheels rest here

/**
 * One cell is exactly one lane. ObstacleManager spawns on `lane * 3` for lanes -2..2, so
 * matching its LANE_WIDTH puts a grid line on every lane *boundary* (±1.5, ±4.5, ±7.5 —
 * see the half-cell offset in the shader) rather than through the middle of a lane. The
 * road reads as five channels the obstacles actually occupy. If LANE_WIDTH ever moves,
 * this moves with it or the lanes stop lining up with the thing drawing them.
 */
const CELL = 3;

/**
 * Outside the car, inside the road. PlayerCar stops its *origin* at ±8 and the car measures
 * 1.2 from origin to its widest point (the spoiler), so the bodywork actually reaches ±9.2 —
 * rails at a flat ±9 put the car visibly on top of them at full lock. 9.5 clears that and
 * still leaves a shoulder inside the ±10 road edge.
 */
const RAIL_X = 9.5;
const RAIL_WIDTH = 0.18;
const RAIL_HEIGHT = 0.26;
/**
 * Well over 1.0, so the bloom pass's 0.85 threshold catches the rails and they read as light
 * sources rather than lit objects. Kept thin (above) rather than dim: a rail runs the whole
 * 300 units to the vanishing point, so its screen area is enormous and brightness is the
 * wrong dial — turning it up fills the sky with glow, turning the cross-section down keeps
 * the hot core and gives bloom far less to smear.
 */
const RAIL_EMISSIVE_INTENSITY = 2.5;

const LINE_COLOR = 0xff8800;
const BASE_COLOR = 0x060010; // near-black with a purple bias, to sit against the sky dome
const RAIL_COLOR = 0xff9500;
/**
 * Multiplies the line colour past 1.0 in the linear HDR buffer, which is what makes it bloom.
 * Only just past, and the margin is the whole point. LuminosityHighPassShader weights Rec601
 * (0.299/0.587/0.114), so LINE_COLOR sits at 0.61 and 1.5 lands it at 0.92 against the pass's
 * 0.85 threshold. A line's antialiased edge is a fraction of its core, so the edge falls back
 * under the threshold and only the core blooms: the grid glows *along its lines* rather than
 * glowing as a sheet. At 1.7 the edges cleared the threshold too and the road turned milky.
 */
const GLOW = 1.5;

/**
 * The pattern repeats every 1.0 in shader space, so the scroll offset is kept modulo 1.
 * Two things fall out of that, both of them the point of this rewrite:
 *   1) uScroll and uScroll+1 are the same image, exactly — so the wrap is not "small enough
 *      to miss", it is arithmetically invisible. There is no seam to see.
 *   2) the uniform never grows. Left unwrapped it reaches ~5e4 over a ten-minute run, where
 *      a float32's ulp is ~0.007 of a cell, and fract() starts quantising the lines into a
 *      visible shimmer. Wrapping costs one modulo and removes the failure mode outright.
 */
const SCROLL_PERIOD = 1;

const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * three compiles ShaderMaterial as `#version 300 es` and #defines the GLSL-1 spellings back
 * (WebGLProgram.js:862), so `varying`/`gl_FragColor` are fine here and `fwidth` is core —
 * no GL_OES_standard_derivatives dance, which on this version would be dead configuration.
 *
 * The plane's extents are baked in from the JS constants rather than passed as uniforms:
 * they cannot change at runtime, and a uniform for a constant is a uniform that eventually
 * disagrees with the geometry. uLineColor/uBaseColor/uGlow are the opposite case — Phase 3's
 * environment shifts drive those, so they stay uniforms even though nothing writes them yet.
 */
const FRAGMENT_SHADER = /* glsl */`
  uniform float uScroll;
  uniform vec3 uLineColor;
  uniform vec3 uBaseColor;
  uniform float uGlow;
  varying vec2 vUv;

  // Screen-space-derivative antialiasing: the line is exactly one pixel wide at any depth,
  // because w = fwidth(p) reports how much the pattern coordinate moves per pixel right here.
  float gridLine(vec2 p, vec2 w) {
    vec2 g = abs(fract(p - 0.5) - 0.5) / w;
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    // x: world units / CELL, shifted half a cell so lines land on lane boundaries.
    // y: distance along the road / CELL, plus the scroll.
    vec2 p = vec2(
      (vUv.x - 0.5) * ${(ROAD_WIDTH / CELL).toFixed(5)} + 0.5,
      vUv.y * ${(ROAD_LENGTH / CELL).toFixed(5)} + uScroll
    );
    vec2 w = fwidth(p);

    // Once a pixel spans a large fraction of a cell there is no line left to draw — the
    // divisor in gridLine() swamps the numerator, every fragment returns ~1, and the far
    // plane turns into a solid sheet of line colour that bloom then smears over the sky.
    // Fading on the derivative attacks that directly and is resolution-independent, which a
    // hand-tuned distance constant is not: it stops drawing the grid exactly when the grid
    // stops being representable, at whatever resolution and FOV the frame happens to use.
    float resolved = 1.0 - smoothstep(0.25, 0.8, max(w.x, w.y));

    // Artistic falloff on top, doubling as the distance haze. The road needs no fog chunk
    // because scene.fog is black and so is uBaseColor — fading to base and fogging to black
    // are the same picture.
    float fade = smoothstep(1.0, 0.35, vUv.y);

    vec3 col = uBaseColor + uLineColor * gridLine(p, w) * uGlow * fade * resolved;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** One shared geometry and one shared material across both rails — they differ only in x. */
const buildRails = () => {
  const geometry = new THREE.BoxGeometry(RAIL_WIDTH, RAIL_HEIGHT, ROAD_LENGTH);
  const material = new THREE.MeshStandardMaterial({
    color: RAIL_COLOR,
    emissive: RAIL_COLOR,
    emissiveIntensity: RAIL_EMISSIVE_INTENSITY,
    roughness: 0.4,
    metalness: 0.1
  });

  const rails = new THREE.Group();
  for (const x of [-RAIL_X, RAIL_X]) {
    const rail = new THREE.Mesh(geometry, material);
    rail.position.set(x, ROAD_Y + RAIL_HEIGHT / 2, ROAD_NEAR_Z - ROAD_LENGTH / 2);
    rails.add(rail);
  }
  return rails;
};

export class Road {
  #uniforms;

  constructor(scene) {
    this.#uniforms = {
      uScroll: { value: 0 },
      uLineColor: { value: new THREE.Color(LINE_COLOR) },
      uBaseColor: { value: new THREE.Color(BASE_COLOR) },
      uGlow: { value: GLOW }
    };

    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_WIDTH, ROAD_LENGTH),
      new THREE.ShaderMaterial({
        uniforms: this.#uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER
      })
    );
    // -90° about x lays the plane flat and points its +v axis down the track, so vUv.y == 0
    // is the near edge and 1 is the horizon. The fade above depends on that orientation.
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(0, ROAD_Y, ROAD_NEAR_Z - ROAD_LENGTH / 2);

    scene.add(surface, buildRails());
  }

  /** The whole per-frame cost of the road: one add, one modulo, one uniform write. */
  update(moveDist) {
    this.#uniforms.uScroll.value = (this.#uniforms.uScroll.value + moveDist / CELL) % SCROLL_PERIOD;
  }
}
