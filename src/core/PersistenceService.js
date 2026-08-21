/**
 * ARCHITECTURE: Save data
 * Decision: one versioned JSON blob under a single localStorage key, read once
 *   into memory at boot and written through on change.
 * Reason: Ownership Map gives this module sole write access to save data. Keeping
 *   it to one key means a future schema migration is one branch on `.version`,
 *   not a hunt for scattered keys.
 * Trade-off: no cross-device sync, no integrity check — a determined player can
 *   edit their high score. That's acceptable until Phase 4's leaderboard backend,
 *   which is where server-side validation belongs.
 * If reads come back empty, check: 1) Safari private mode (getItem throws, not
 *   returns null), 2) the key was bumped without a migration, 3) file:// origin,
 *   where storage is partitioned per-file in some browsers.
 */
const STORAGE_KEY = 'spaceracer.v1';
// `muted` joins the blob rather than taking a key of its own — that is the whole point
// of the one-blob decision above, and a save written before it existed still boots
// because #load() spreads over these defaults.
const EMPTY_SAVE = { highScore: 0, muted: false };

export class PersistenceService {
  #save;

  constructor() {
    this.#save = this.#load();
  }

  getHighScore() {
    return this.#save.highScore;
  }

  submitScore(score) {
    this.#save.highScore = Math.floor(score);
    this.#flush();
  }

  isMuted() {
    return this.#save.muted;
  }

  setMuted(muted) {
    this.#save.muted = muted;
    this.#flush();
  }

  #load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // Spread over the defaults so a save written by an older build still boots.
      return raw ? { ...EMPTY_SAVE, ...JSON.parse(raw) } : { ...EMPTY_SAVE };
    } catch {
      // Private browsing, disabled storage, corrupt JSON — all mean "no save yet".
      // A missing high score must never be a reason the game refuses to start.
      return { ...EMPTY_SAVE };
    }
  }

  #flush() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#save));
    } catch {
      // Quota or private mode. The in-memory value still stands for this session.
    }
  }
}
