/**
 * sweeper.js — Active expiry background task for DistriCache.
 *
 * THE PROBLEM THIS SOLVES
 * ═══════════════════════
 * Lazy expiry (checking TTL on GET) guarantees correctness — an expired key
 * is never returned. But what about keys that expire and are NEVER read again?
 *
 *   Example:
 *     SET session:abc "data" EX 300   (expires in 5 minutes)
 *     ... user closes browser, never comes back ...
 *     → session:abc is expired but still occupies memory
 *     → Without active expiry, it stays in memory FOREVER
 *
 * Active expiry solves this memory leak by periodically scanning for and
 * deleting expired keys, even if no one is reading them.
 *
 * THE ALGORITHM: RANDOM SAMPLING
 * ══════════════════════════════
 * We could scan ALL keys every tick, but that's O(n) and would block the
 * event loop on large stores. Instead, we sample a small random batch:
 *
 *   Every SWEEP_INTERVAL_MS (default: 100ms):
 *     1. Sample SWEEP_BATCH_SIZE (default: 20) random keys from the store
 *     2. Check each sampled key: is it expired?
 *     3. If yes, delete it
 *
 * This is probabilistic — it won't catch every expired key on every tick.
 * But over many ticks, it converges: an expired key will eventually be
 * sampled and removed. Combined with lazy expiry on GET, this gives us
 * both correctness AND memory reclaim.
 *
 * WHY RANDOM SAMPLING INSTEAD OF A SORTED EXPIRY QUEUE?
 * ─────────────────────────────────────────────────────
 * Alternative: maintain a min-heap or sorted set of (expiresAt, key) pairs,
 * and pop all entries with expiresAt <= now. This would be more precise
 * (O(k log n) where k = number expired) and wouldn't miss any expired keys.
 *
 * We chose random sampling because:
 *   - Simpler to implement (no heap maintenance on every SET/DEL)
 *   - O(batchSize) per tick regardless of store size
 *   - Good enough when combined with lazy expiry (correctness is already guaranteed)
 *   - This is what Redis actually does (redis.io/commands/expire — "How expires are handled")
 *
 * The trade-off: expired-but-unread keys may live slightly longer than their TTL
 * before being cleaned up. For a cache, this is acceptable — the data is already
 * stale, we just want to reclaim memory eventually.
 *
 * RANDOM KEY SELECTION
 * ────────────────────
 * JavaScript's Map doesn't support random access by index. To sample random keys:
 *   1. Convert Map keys to an Array (O(n) but only done once per tick)
 *   2. Pick random indices from the array
 *
 * This is the same approach Redis uses internally — converting to an array for
 * sampling is acceptable because SWEEP_BATCH_SIZE is small (20) and the tick
 * interval is long enough (100ms) that the O(n) array creation is amortized.
 *
 * For very large stores (millions of keys), a more efficient approach would be
 * to maintain a separate array of keys with TTLs. This is a documented v2
 * optimization if profiling shows the array creation is a bottleneck.
 */

/**
 * Creates and starts an active expiry sweeper.
 *
 * The sweeper runs as a background `setInterval` — it doesn't block
 * the event loop because each tick does a small, bounded amount of work.
 *
 * @param {import('./store.js').Store} store - The store to sweep
 * @param {object} [options]
 * @param {number} [options.intervalMs] - Sweep interval in ms (default: EXPIRY_SWEEP_INTERVAL env or 100)
 * @param {number} [options.batchSize] - Keys to sample per tick (default: EXPIRY_SWEEP_BATCH env or 20)
 * @param {import('./logger.js').createLogger} [options.logger] - Logger instance for sweep stats
 * @returns {{ stop: () => void }} Handle to stop the sweeper
 */
export function createSweeper(store, options = {}) {
  const intervalMs = options.intervalMs
    ?? (process.env.EXPIRY_SWEEP_INTERVAL ? parseInt(process.env.EXPIRY_SWEEP_INTERVAL, 10) : 100);
  const batchSize = options.batchSize
    ?? (process.env.EXPIRY_SWEEP_BATCH ? parseInt(process.env.EXPIRY_SWEEP_BATCH, 10) : 20);
  const log = options.logger || null;

  /**
   * One sweep tick: sample random keys and delete expired ones.
   *
   * The function is designed to be bounded: it never processes more than
   * `batchSize` keys per tick, regardless of how many expired keys exist.
   * This prevents the sweeper from blocking the event loop.
   */
  function sweep() {
    const storeSize = store.size();
    if (storeSize === 0) return;

    // Convert keys to array for random access.
    // This is O(n) but bounded by the store size and happens only once per tick.
    const allKeys = Array.from(store.keys());
    const sampleCount = Math.min(batchSize, allKeys.length);

    let expiredCount = 0;

    // If we can afford to check every key within our batch budget, do it
    // deterministically. Random sampling with replacement is only useful
    // when batchSize < total keys — otherwise we'd waste picks re-sampling
    // the same key and probabilistically miss others.
    //
    // Example of the bug this prevents:
    //   3 keys, batchSize=3 → 3 random picks from 3 keys (with replacement)
    //   P(miss at least one key) = 1 - 3!/3^3 ≈ 78%
    //   That's not a test problem — it's a real-world correctness gap.
    if (sampleCount >= allKeys.length) {
      // Full scan — check every key
      for (let i = 0; i < allKeys.length; i++) {
        if (store.deleteIfExpired(allKeys[i])) {
          expiredCount++;
        }
      }
    } else {
      // Random sampling — batchSize < total keys
      for (let i = 0; i < sampleCount; i++) {
        // Pick a random key from the entire keyspace.
        // Math.random() is fine here — we don't need cryptographic randomness,
        // just roughly uniform sampling.
        const randomIndex = Math.floor(Math.random() * allKeys.length);
        const key = allKeys[randomIndex];

        if (store.deleteIfExpired(key)) {
          expiredCount++;
        }
      }
    }

    if (expiredCount > 0 && log) {
      log.debug(`active expiry sweep: removed ${expiredCount} key(s)`);
    }
  }

  // Start the periodic sweep.
  // setInterval is non-blocking — it schedules the callback on the event loop,
  // so the server can still process requests between sweeps.
  const timer = setInterval(sweep, intervalMs);

  // Unref the timer so it doesn't prevent Node.js from exiting.
  // Without unref(), Node would keep running even after server.close()
  // because the setInterval is still scheduled. With unref(), Node knows
  // this timer alone shouldn't keep the process alive.
  timer.unref();

  return {
    /**
     * Stop the sweeper. Called during graceful shutdown.
     */
    stop() {
      clearInterval(timer);
    },

    // Exposed for testing — allows calling sweep() manually
    // without waiting for the interval timer.
    _sweep: sweep,
  };
}
