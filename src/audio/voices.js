/**
 * ARCHITECTURE: Synthesis primitives
 * Decision: the node graphs themselves — how a voice is *built* and how a one-shot is
 *   *played* — live here as free functions over an AudioContext and a destination
 *   node. AudioManager keeps the context, the lifecycle, and every decision about
 *   which voice plays when and at what pitch.
 * Reason: AudioManager crossed 450 lines doing both, and the seam was obvious once it
 *   was looked for: nothing in this file knows the game exists. No import of `State`,
 *   no notion of speed or score, no event bus. It is timbre; the manager is
 *   performance. That also makes the file the natural home for the next voice, which
 *   is what S6/S7 will be adding.
 * Trade-off: the tuning constants are now split across two files — the ones that shape
 *   a voice are here, the ones that map game speed onto it are in AudioManager. That
 *   is a real cost when tuning by ear, and it is still the right line: a constant that
 *   mentions `speed` does not belong in a module that has never heard of speed.
 * If a one-shot plays once and then everything goes quiet, look at the `onended`
 *   disconnects below — disconnecting the wrong node takes the shared destination bus
 *   down with it.
 */

const SILENCE = 0.0001;        // exponential ramps cannot reach 0; this is close enough
const ATTACK = 0.006;          // long enough not to click, short enough to feel instant

// Engine timbre. The pitch these run at is AudioManager's business; this is the shape.
export const ENGINE_SUB_RATIO = 0.5;  // the sine sits one octave under the sawtooth
const ENGINE_SUB_GAIN = 0.45;
const ENGINE_Q = 4;            // enough peak to sing at the cutoff, short of whistling

// Wind timbre. Wide on purpose — a narrow band whistles instead of rushing.
const WIND_BAND_HZ = 1200;
const WIND_Q = 0.5;

/**
 * White noise, generated once and shared by the wind loop and every crash burst.
 *
 * White rather than pink: both consumers are shaped by a filter downstream — a wide
 * bandpass for wind, a closing lowpass for the burst — and those filters do the
 * spectral work a pink generator would then be doing twice. A Voss-McCartney bank
 * here would be a dozen lines buying an effect the bandpass immediately flattens.
 */
export const createNoiseBuffer = (ctx, seconds) => {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
};

/**
 * Freeze a param where it currently stands and clear everything queued behind it.
 *
 * `cancelAndHoldAtTime` is the one-call version and is deliberately not used: it is
 * the least-supported corner of the AudioParam API, and this pair does the same job
 * everywhere. Without the hold, cancelling drops the param back to the value its last
 * *scheduled* event set, which mid-glide is audibly not where it actually is.
 */
export const holdParam = (param, when) => {
  param.cancelScheduledValues(when);
  param.setValueAtTime(param.value, when);
};

/**
 * Sawtooth for the buzz + a sub-octave sine for the weight, summed into one resonant
 * lowpass so opening the filter reads as the motor loading up.
 *
 * Started here and never stopped. Oscillators are cheap to leave running, and a
 * stopped OscillatorNode is dead for good by specification — start/stop per run would
 * mean rebuilding the whole voice on every restart.
 */
export const createEngineVoice = (ctx, destination, { baseHz, cutoffHz }) => {
  const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: baseHz });
  const sub = new OscillatorNode(ctx, { type: 'sine', frequency: baseHz * ENGINE_SUB_RATIO });
  const subGain = new GainNode(ctx, { gain: ENGINE_SUB_GAIN });
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: cutoffHz, Q: ENGINE_Q });
  const gain = new GainNode(ctx, { gain: 0 }); // silent until a run starts

  osc.connect(filter);
  sub.connect(subGain).connect(filter);
  filter.connect(gain).connect(destination);

  osc.start();
  sub.start();
  return { osc, sub, filter, gain };
};

/**
 * Looped noise → wide bandpass → gain. Only the gain comes back, because gain is the
 * only thing the caller modulates; the source and filter need no reference, since a
 * connected node is reachable from the graph and will not be collected out from under
 * the loop.
 */
export const createWindVoice = (ctx, destination, buffer) => {
  const source = new AudioBufferSourceNode(ctx, { buffer, loop: true });
  const filter = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: WIND_BAND_HZ, Q: WIND_Q });
  const gain = new GainNode(ctx, { gain: 0 });

  source.connect(filter).connect(gain).connect(destination);
  source.start();
  return gain;
};

/**
 * The one-shot workhorse: one oscillator, optionally swept, under an attack/decay
 * envelope, disconnected the moment it ends.
 *
 * Deliberately generic. The graze zap, orb pickup, power-up sweeps and tier sting that
 * S6/S7 bring are each one `bus.on(...)` and one call to this with different numbers —
 * which is why none of them are stubbed for events that do not exist yet.
 */
export const playBlip = (ctx, destination, { type = 'square', fromHz, toHz = fromHz, level, decay }) => {
  const at = ctx.currentTime;
  const osc = new OscillatorNode(ctx, { type, frequency: fromHz });
  const gain = new GainNode(ctx, { gain: 0 });
  osc.connect(gain).connect(destination);

  // Anchored with setValueAtTime first: an exponential ramp with no prior event
  // interpolates from whatever the param happens to hold, which turns fragile the day
  // a second sweep is added to the same voice.
  osc.frequency.setValueAtTime(fromHz, at);
  if (toHz !== fromHz) osc.frequency.exponentialRampToValueAtTime(toHz, at + decay);

  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(level, at + ATTACK);
  gain.gain.exponentialRampToValueAtTime(SILENCE, at + decay);

  osc.start(at);
  osc.stop(at + decay);
  // Without this the finished node stays reachable from the destination bus and the
  // graph grows by one voice per trigger for the life of the page. `onended` fires once.
  osc.onended = () => gain.disconnect();
};

/**
 * A filtered noise hit. Shares the wind's buffer — only the envelope makes it an impact.
 *
 * Closing the filter alongside the envelope is what turns a hiss into debris: the
 * bright transient is the collision, the dark tail is the wreckage settling.
 */
export const playNoiseBurst = (ctx, destination, buffer, { level, seconds, openHz, closeHz }) => {
  const at = ctx.currentTime;
  const source = new AudioBufferSourceNode(ctx, { buffer });
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: openHz });
  const gain = new GainNode(ctx, { gain: 0 });
  source.connect(filter).connect(gain).connect(destination);

  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(level, at + ATTACK);
  gain.gain.exponentialRampToValueAtTime(SILENCE, at + seconds);

  filter.frequency.setValueAtTime(openHz, at);
  filter.frequency.exponentialRampToValueAtTime(closeHz, at + seconds);

  // Offset into the buffer at random so two bursts in a session are never the same
  // noise. Free variation; the alternative is generating a fresh buffer per trigger.
  source.start(at, Math.random() * Math.max(0, buffer.duration - seconds));
  source.stop(at + seconds);
  source.onended = () => gain.disconnect();
};
