/**
 * ARCHITECTURE: Cross-module signalling
 * Decision: a hand-rolled Map-of-Sets pub/sub instead of an EventEmitter package.
 * Reason: Constitution Principle IV — the whole thing is shorter than the import
 *   line would be expensive, and Node's EventEmitter isn't free in a browser bundle.
 * Trade-off: no wildcards, no once(), no priority ordering. Add them the day a
 *   caller actually needs one (Principle V), not in anticipation.
 * If debugging a handler that never fires, check in this order:
 *   1) event name typo — these are plain strings, nothing validates them,
 *   2) subscribe-after-emit — every module subscribes in its constructor for
 *      exactly this reason, so a late `new` is the usual culprit,
 *   3) the emitter is a different EventBus instance (there should be exactly one,
 *      built in main.js and injected).
 *
 * Deliberately for discrete transitions only — never per-frame data. The handler
 * copy in emit() allocates, which would violate Principle III at 60Hz but costs
 * nothing a handful of times per run.
 */
export class EventBus {
  #channels = new Map();

  /** Returns an unsubscribe function, so callers never need to keep the handler ref. */
  on(event, handler) {
    if (!this.#channels.has(event)) this.#channels.set(event, new Set());
    this.#channels.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.#channels.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const handlers = this.#channels.get(event);
    if (!handlers) return;
    // Snapshot first: a handler is allowed to unsubscribe itself mid-emit.
    for (const handler of [...handlers]) handler(payload);
  }
}
