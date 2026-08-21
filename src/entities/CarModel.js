import * as THREE from 'three';
import { equirectGradient, radialTexture } from '../render/gradientTexture.js';

/**
 * ARCHITECTURE: What the car looks like
 * Decision: the silhouette, the materials and the light pool are built here; PlayerCar.js keeps
 *   the motion, the hitbox, the particles and the crash. Nothing in this file moves or reads
 *   game state — it assembles a scene graph and hands it back.
 * Reason: the call Environment already made when it delegated the road to Road.js. Ownership is
 *   unchanged — the Map gives PlayerCar "car creation", and this is constructed only from
 *   there and reachable from nowhere else, so it is a sub-module, not a peer. It earned its own
 *   file for the same reason Road.js did: a 14-point extrusion profile, five materials and a
 *   generated texture sitting in the middle of the motion code made both halves harder to read,
 *   and together they pushed one file past the 500-line smell threshold.
 * Trade-off: retuning the shape and retuning the handling are now two files. They are two
 *   different jobs on two different days, so that is a feature rather than a cost.
 *
 * ADR (Principle IV): the car stays procedural rather than becoming a downloaded .glb, and the
 * AssetManager/model line in Blueprint Phase 2 is deliberately not taken up here.
 *   1) The Tron-edge silhouette *is* the art direction. EdgesGeometry needs authored hard edges
 *      to trace; a marketplace model is dense and smooth-shaded and would hand back a hairball
 *      of triangle edges instead of a clean neon outline.
 *   2) Zero asset-licensing risk — nothing here needs a provenance audit before release.
 *   3) Zero network payload: a .glb is a fetch, a parse, a progress UI and a failure path, all
 *      of which have to exist before the first frame renders.
 *   4) three's own geometry generators solve this, so a model pipeline must justify itself
 *      against them, and for one car it cannot.
 * If Phase 3's garage ever needs a dozen distinct cars that arithmetic flips — a dozen
 * hand-authored profiles is not a win — and this decision should be revisited then.
 */

/**
 * The car's side profile, in (length, height), nose first. Length runs -2.70 to +2.42; height 0
 * is where the wheels touch the road. Extruded across the width and given a quarter turn, so
 * *this array is the car*: nose low, hood rising, a raked windscreen into a short roof, a
 * fastback drop, then the tail kicking back up into an integrated spoiler lip.
 *
 * Replaces five boxes (chassis, hood, cabin, spoiler wing, two struts) and their four edge
 * twins. Beyond the draw calls, the point is that a box stack cannot express a wedge — every
 * silhouette line in the old car was axis-aligned because it had to be. Fourteen points buy
 * every angle for free.
 *
 * Must stay a simple polygon: the top run's lengths ascend, the bottom run's descend, and the
 * two never cross. Break that and ExtrudeGeometry's bevel inverts faces rather than erroring.
 */
const BODY_PROFILE = Object.freeze([
  [-2.70, 0.28], // nose tip
  [-2.44, 0.44],
  [-1.55, 0.53], // hood
  [-0.72, 0.62], // windscreen base  ← WINDSCREEN_FACE
  [-0.05, 1.06], // windscreen top   ←
  [0.58, 1.12],  // cabin peak
  [1.48, 0.84],  // fastback
  [2.06, 0.66],  // rear deck
  [2.22, 0.94],  // tail kick
  [2.42, 0.90],  // spoiler lip
  [2.42, 0.46],  // tail face
  [2.10, 0.14],  // diffuser
  [-2.30, 0.12], // floor pan
  [-2.58, 0.19]  // splitter
]);

/** The two profile indices the windscreen spans, so the glass follows a retuned shape. */
const WINDSCREEN_FACE = [3, 4];

const BODY_WIDTH = 2.2;
/**
 * Small on purpose. The bevel gives the clearcoat something to catch — a perfectly sharp edge
 * has no facet to throw a highlight off. Kept well under the shortest profile edge (0.15, at
 * the splitter): three offsets bevel corners without checking for self-intersection, so a
 * bevelSize past a short edge silently folds the geometry inside out.
 */
const BEVEL_SIZE = 0.035;
const BEVEL_THICKNESS = 0.05;

/**
 * Tumblehome — the sideways taper from sills to roof.
 *
 * An extrusion comes out of the generator as a constant-width slab, and this is the one place
 * that genuinely matters: the chase camera sits *behind* the car, so what the player looks at
 * all game is the rear elevation, where a 14-point side profile contributes almost nothing and
 * width is the only shape cue there is. Untapered, the wedge reads as a van. Squeezing x as a
 * function of height turns the slab into bodywork — wide at the sills, narrow at the roof —
 * and recovers the two-tier chassis/cabin silhouette the old box stack got for free by making
 * the cabin box narrower than the chassis box.
 *
 * Done to the vertex buffer once at construction, so it costs nothing per frame, and applied
 * identically to the outline twin so the neon still traces the body it belongs to.
 */
const TUMBLE_START = 0.35;  // below this height the body keeps its full width
const TUMBLE_END = 1.12;    // the cabin peak
const TUMBLE_NARROW = 0.62; // roof width as a fraction of BODY_WIDTH

/**
 * Dark steel blue — dark, but deliberately not the near-black this started as.
 *
 * On a metal, `color` is not a pigment sitting under the reflection, it *is* the reflectance
 * tint the environment gets multiplied by. At metalness 0.9 a near-black base (the 0x0b0e18
 * this began with, linear ~0.005) multiplies the whole envMap down to nothing, and no amount of
 * clearcoat or light tuning rescues it — verified on screen, which is the only reason this
 * number moved. This value keeps the car unmistakably dark while leaving the metal something to
 * reflect with. The tension is real and worth naming: "metalness 0.9" and "near-black" are
 * physically the same instruction as "reflect nothing".
 */
const BODY_COLOR = 0x2e3850;
const LINE_COLOR = 0xff8800;
/**
 * Multiplies the outline past 1.0 in the linear HDR buffer, which is what makes it bloom — the
 * same trick as Road.js's GLOW, but note the arithmetic there is done in sRGB and the number
 * that actually matters is the linear one.
 *
 * THREE.Color converts a hex through sRGB→linear on assignment (ColorManagement is on by
 * default in r171), so LINE_COLOR reaches the shader as linear (1.0, 0.246, 0), which
 * LuminosityHighPassShader weights Rec601 to luma 0.444 — not the 0.61 the sRGB triple suggests.
 * Against the pass's 0.85 threshold that needs a multiplier over 1.91 to bloom at all, which is
 * why a first attempt at 1.6 changed nothing on screen. 2.4 lands it at 1.07: clearly over,
 * without the headroom to smear.
 *
 * This matters more than it sounds. The old car got its Tron read from *nine* outlined boxes
 * stacked into a wireframe; one body means one outline, so the single edge left has to carry
 * what nine used to.
 */
const LINE_GLOW = 2.4;

/**
 * The car's reflection environment, top of the sky to the road below. Authored to agree with
 * what the car is actually sitting in: Environment's near-black zenith, its violet horizon, and
 * a warm band underneath standing in for the glowing grid the bodywork is driving over.
 *
 * Held under the bloom pass's 0.85 threshold on purpose — this is meant to *light* the car, not
 * to become a light source. Pushed brighter, every panel facing the road clears the threshold
 * and the whole car turns into a lamp.
 */
const SHEEN_STOPS = [
  [0.0, '#05050c'],  // zenith
  [0.38, '#2c1442'],  // violet sky, matching Environment's dome
  // The band that does the visible work. In equirect mapping this is the horizontal ring, and
  // the horizontal ring is what the panels facing the chase camera reflect — a roof reflects
  // the near-black zenith and the underside reflects the road, neither of which the player can
  // see. Tuned by looking at the car, not by looking at the gradient.
  [0.55, '#6e2f55'],
  [0.72, '#96420a'],  // the road's warm bounce coming back up at the bodywork
  [1.0, '#c26010']
];
const NEON_COLOR = 0xffaa00;
const TIRE_COLOR = 0x050505;

const GLASS_WIDTH = 1.5;
const GLASS_INSET = 0.86;  // fraction of the face the glass covers, so it sits inside the frame
const GLASS_PROUD = 0.02;  // pushed along the face normal, or it z-fights the panel it lies on

const NOSE_BLADE = Object.freeze({ w: 2.34, h: 0.3, d: 0.1, y: 0.32, z: -2.4 });
const TAIL_BAR = Object.freeze({ w: 1.9, h: 0.24, d: 0.06, y: 0.66, z: 2.45 });

const WHEEL_RADIUS = 0.45;
/** [x, z, steers]. The front pair is at negative z — the nose end. */
const WHEEL_LAYOUT = Object.freeze([
  [-1.25, -1.5, true], [1.25, -1.5, true],
  [-1.25, 1.6, false], [1.25, 1.6, false]
]);

const UNDERGLOW_WIDTH = 4.4;
const UNDERGLOW_LENGTH = 7.4;
/**
 * A hot near-white core clearing the bloom pass's 0.85 luminance threshold, falling through
 * amber to nothing.
 *
 * The mid-stops carry deliberately more energy than a textbook falloff would. The car sits on
 * top of the quad and hides its centre completely, so the *only* part a player ever sees is the
 * spill past the bodywork — a gradient tuned to look right in isolation puts all its brightness
 * where nothing can see it and reads as a dull smudge on the road. The quad is likewise sized
 * past the car's own footprint for the same reason.
 */
const UNDERGLOW_STOPS = [
  [0.0, 'rgba(255,244,224,1)'],
  [0.30, 'rgba(255,170,60,0.85)'],
  [0.62, 'rgba(255,105,10,0.42)'],
  [1.0, 'rgba(255,60,0,0)']
];

const boxAt = (w, h, d, material, x, y, z) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
};

const profileShape = () => {
  const shape = new THREE.Shape();
  shape.moveTo(BODY_PROFILE[0][0], BODY_PROFILE[0][1]);
  for (let i = 1; i < BODY_PROFILE.length; i++) shape.lineTo(BODY_PROFILE[i][0], BODY_PROFILE[i][1]);
  shape.closePath();
  return shape;
};

/**
 * Extrudes the profile across the width and lays it into car space. ExtrudeGeometry builds along
 * +z from a shape in xy, so the result is centred on the width axis and given a quarter turn
 * about y, mapping the profile's length axis onto world z with the nose at -z.
 *
 * Both transforms are baked into the geometry rather than set on the mesh: that is what lets the
 * edge twin share the same origin with no transform copying, and it means the group can be
 * scaled and spun during a crash without the outline drifting off the body.
 */
const layIntoCarSpace = (geometry, halfWidth) => {
  geometry.translate(0, 0, -halfWidth);
  geometry.rotateY(-Math.PI / 2);

  // Tumblehome, applied after the quarter turn so this is plainly "squeeze the car's width as
  // a function of its height" rather than an argument about which local axis is which.
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const t = THREE.MathUtils.smoothstep(position.getY(i), TUMBLE_START, TUMBLE_END);
    position.setX(i, position.getX(i) * THREE.MathUtils.lerp(1, TUMBLE_NARROW, t));
  }
  position.needsUpdate = true;
  // The taper moved every surface, so the generator's normals are now wrong — unlit-looking
  // flanks are the symptom of skipping this. ExtrudeGeometry is non-indexed, so recomputing
  // gives per-triangle normals and the faceting stays crisp rather than going smooth-shaded.
  geometry.computeVertexNormals();

  return geometry;
};

const buildBody = (material, lineMaterial) => {
  const shape = profileShape();

  // The bevel adds BEVEL_THICKNESS at both caps, so the span stays symmetric about depth/2.
  const geometry = layIntoCarSpace(new THREE.ExtrudeGeometry(shape, {
    depth: BODY_WIDTH,
    bevelEnabled: true,
    bevelSize: BEVEL_SIZE,
    bevelThickness: BEVEL_THICKNESS,
    bevelSegments: 2
  }), BODY_WIDTH / 2);

  // The outline is traced off a separate, *unbevelled* extrusion. Running EdgesGeometry over the
  // bevelled body returns every chamfer facet — each bevel segment turns ~30°, past any
  // threshold that still keeps the profile's shallow creases — and the silhouette comes back as
  // a wireframe. The twin is extruded to the bevelled body's full outer width and given the
  // identical taper, so its edges trace exactly the shape they outline.
  const silhouette = layIntoCarSpace(new THREE.ExtrudeGeometry(shape, {
    depth: BODY_WIDTH + BEVEL_THICKNESS * 2,
    bevelEnabled: false
  }), BODY_WIDTH / 2 + BEVEL_THICKNESS);

  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(silhouette), lineMaterial);
  silhouette.dispose(); // EdgesGeometry copied what it needed; the source was scaffolding

  return [new THREE.Mesh(geometry, material), outline];
};

/** The cockpit glass, laid onto the profile's windscreen face rather than hand-positioned. */
const buildWindscreen = (material) => {
  const [[u0, v0], [u1, v1]] = WINDSCREEN_FACE.map((i) => BODY_PROFILE[i]);
  const du = u1 - u0;
  const dv = v1 - v0;
  const length = Math.sqrt(du * du + dv * dv);

  const glass = new THREE.Mesh(new THREE.PlaneGeometry(GLASS_WIDTH, length * GLASS_INSET), material);
  // Rotating a plane about x by `a` sends its local +y to (0, cos a, -sin a). a = atan2(-du, dv)
  // puts that along the face's (dv, du) tangent, so the quad lies flat on the panel whatever
  // rake the profile is given. The position is then nudged along that face's outward normal,
  // (du, -dv), so the glass sits on the bodywork instead of fighting a coplanar surface.
  glass.rotation.x = Math.atan2(-du, dv);
  glass.position.set(
    0,
    (v0 + v1) / 2 + (du / length) * GLASS_PROUD,
    (u0 + u1) / 2 - (dv / length) * GLASS_PROUD
  );
  return glass;
};

/** Four wheels sharing one tyre geometry and one rim geometry, each in its own Group. */
const buildWheels = (tireMaterial, neonMaterial) => {
  const tireGeometry = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 24);
  const rimGeometry = new THREE.TorusGeometry(0.28, 0.05, 12, 24);

  return WHEEL_LAYOUT.map(([x, z, steers]) => {
    const node = new THREE.Group();

    const tire = new THREE.Mesh(tireGeometry, tireMaterial);
    tire.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(rimGeometry, neonMaterial);
    rim.rotation.y = Math.PI / 2;
    rim.position.x = x > 0 ? 0.16 : -0.16; // push the glowing rim to the outboard face

    node.add(tire, rim);
    node.position.set(x, WHEEL_RADIUS, z);
    // Euler order matters here and the default gets it backwards. PlayerCar writes rotation.x
    // (roll) and rotation.y (steering yaw) on this node; under the default 'XYZ' the matrix is
    // Rx·Ry·Rz, so the yaw applies first and the roll then happens about the *car's* axle rather
    // than the steered wheel's — a wheel that wobbles instead of rolling. 'YXZ' gives Ry·Rx·Rz:
    // roll in wheel space, then steer. One field instead of a nested hub group per wheel.
    node.rotation.order = 'YXZ';

    return { node, steers };
  });
};

/**
 * ADR (Principle III): a fake light pool instead of a real one. The obvious way to put light
 * under the car is a fourth THREE.Light, and it is the wrong way — every extra dynamic light
 * recompiles every lit material with another light slot and costs per-fragment work across the
 * whole road, for an effect that is one soft ellipse. An additive quad with a generated gradient
 * costs one draw call of two triangles, no shader variant, and the bloom pass turns its hot core
 * into the halo a real light would have thrown. The scene stays at three lights: Environment's
 * ambient and directional, plus the car's own point light.
 *
 * Returned separately and deliberately *not* parented to the car, and both reasons cost a bug if
 * ignored. A pool cast on the road must not bank when the car banks — at full lean a 3.6-wide
 * quad inside the group dips half a unit through the road surface and gets depth-clipped in
 * half. And everything inside the group is measured into PlayerCar's hitbox, so a glow wider
 * than the car would silently inflate the player's collision box. PlayerCar follows it in x
 * instead: two float writes a frame, no allocation, no rotation inherited.
 */
const buildUnderglow = () => {
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(UNDERGLOW_WIDTH, UNDERGLOW_LENGTH),
    new THREE.MeshBasicMaterial({
      map: radialTexture(UNDERGLOW_STOPS),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    })
  );
  glow.rotation.x = -Math.PI / 2; // lay it flat
  return glow;
};

/** Returns `{ car, wheels, underglow }`. The caller adds the car and the glow to the scene. */
export const buildCar = () => {
  const car = new THREE.Group();

  const bodyMaterial = new THREE.MeshPhysicalMaterial({
    color: BODY_COLOR,
    metalness: 0.9,
    roughness: 0.25,
    // Without this the other four lines are decoration. See equirectGradient()'s ADR: a metal
    // reflects its environment and almost nothing else, so metalness 0.9 against an empty
    // environment is a black cutout by construction, and that is exactly how the first pass of
    // this material rendered on screen. The gradient is what the clearcoat has to work with.
    envMap: equirectGradient(SHEEN_STOPS),
    envMapIntensity: 1.0,
    // A dielectric coat over the metal flake, and the change that makes the wedge read as
    // bodywork. A bare metalness-0.9 surface with no environment map reflects only the three
    // direct lights and renders as a near-black cutout — which is exactly what the old chassis
    // did. Clearcoat adds a second specular lobe that the car's point light and Environment's
    // directional both catch, so the shape is described by highlights running along the bevels
    // rather than by the outline alone. Depends on the ACES tone mapping RenderPipeline already
    // sets: untonemapped, the coat's highlight clips flat white and reads as plastic.
    clearcoat: 1.0,
    clearcoatRoughness: 0.15,
    // Pushes the filled body a hair further from the camera in depth so the neon outline wins
    // the coincident-surface fight. The twin is only geometrically proud of the body near the
    // caps, where the bevel insets it — everywhere around the profile the two are coplanar by
    // construction, which rendered the Tron edge as a dim, dashed line broken up by z-fighting.
    // The textbook fix for wireframe-over-solid, and cheaper than scaling the twin out, which
    // would distort the shape it is supposed to be tracing.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0xffddaa, roughness: 0.1, metalness: 0.9,
    emissive: 0xff8800, emissiveIntensity: 0.6,
    // The chase camera sits behind and above, so the face we actually see is the *back* of the
    // windscreen. Single-sided, the cockpit glow would be invisible from the only angle that
    // matters. One unculled quad beats reorienting the panel away from its own face.
    side: THREE.DoubleSide
  });
  const neonMaterial = new THREE.MeshBasicMaterial({ color: NEON_COLOR });
  const lineMaterial = new THREE.LineBasicMaterial({ color: LINE_COLOR, linewidth: 2 });
  lineMaterial.color.multiplyScalar(LINE_GLOW); // set after construction: the ctor clamps a hex
  const tireMaterial = new THREE.MeshStandardMaterial({ color: TIRE_COLOR, roughness: 0.9 });

  car.add(...buildBody(bodyMaterial, lineMaterial));
  car.add(buildWindscreen(glassMaterial));

  // One blade through the nose and one bar across the tail face, replacing the old pair of
  // headlight slits. The blade is wider than the body so it protrudes through both flanks — the
  // nose is a wedge tip with no flat face to mount a light on, and a light buried inside an
  // opaque body is a light nobody sees.
  car.add(boxAt(NOSE_BLADE.w, NOSE_BLADE.h, NOSE_BLADE.d, neonMaterial, 0, NOSE_BLADE.y, NOSE_BLADE.z));
  car.add(boxAt(TAIL_BAR.w, TAIL_BAR.h, TAIL_BAR.d, neonMaterial, 0, TAIL_BAR.y, TAIL_BAR.z));

  const wheels = buildWheels(tireMaterial, neonMaterial);
  for (const wheel of wheels) car.add(wheel.node);

  // Travels with the car so it stays lit against the near-black bodywork. Parented on purpose:
  // when the crash hides the group the light goes with it, because an invisible parent is never
  // traversed and its lights are never collected.
  //
  // Moved back over the tail from the straight-overhead position it inherited. A specular lobe
  // leaves a surface at the mirror of the incoming angle, so a light directly above the roof
  // threw its highlight straight up and away from a chase camera sitting at roughly 17° of
  // elevation — the clearcoat was doing its job into empty sky. Above *and behind* aims the
  // lobe back down the camera's line, which is what actually makes the bodywork read as a
  // surface instead of a silhouette. Still one light; only its position changed.
  const carLight = new THREE.PointLight(NEON_COLOR, 10, 20);
  carLight.position.set(0, 2, 2.2);
  car.add(carLight);

  return { car, wheels, underglow: buildUnderglow() };
};
