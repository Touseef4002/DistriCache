/**
 * @param {import('./store.js').Store} store
 * @param {{ intervalMs?: number, batchSize?: number, logger?: object }} [options]
 * @returns {{ stop: () => void, _sweep: () => void }}
 */
export function createSweeper(store, options = {}) {
  const intervalMs = options.intervalMs
    ?? (process.env.EXPIRY_SWEEP_INTERVAL ? parseInt(process.env.EXPIRY_SWEEP_INTERVAL, 10) : 100);
  const batchSize = options.batchSize
    ?? (process.env.EXPIRY_SWEEP_BATCH ? parseInt(process.env.EXPIRY_SWEEP_BATCH, 10) : 20);
  const log = options.logger || null;

  function sweep() {
    if (store.size() === 0) return;

    const allKeys = Array.from(store.keys());
    const sampleCount = Math.min(batchSize, allKeys.length);
    let expiredCount = 0;

    if (sampleCount >= allKeys.length) {
      for (let i = 0; i < allKeys.length; i++) {
        if (store.deleteIfExpired(allKeys[i])) expiredCount++;
      }
    } else {
      for (let i = 0; i < sampleCount; i++) {
        const key = allKeys[Math.floor(Math.random() * allKeys.length)];
        if (store.deleteIfExpired(key)) expiredCount++;
      }
    }

    if (expiredCount > 0 && log) {
      log.debug(`active expiry sweep: removed ${expiredCount} key(s)`);
    }
  }

  const timer = setInterval(sweep, intervalMs);
  timer.unref();

  return {
    stop() { clearInterval(timer); },
    _sweep: sweep,
  };
}
