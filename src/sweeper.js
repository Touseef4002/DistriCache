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
  let keys = store.keys();

  function sweep() {
    if (store.size() === 0) {
      keys = store.keys();
      return;
    }

    let expiredCount = 0;

    for (let i = 0; i < batchSize; i++) {
      const next = keys.next();
      if (next.done) {
        keys = store.keys();
        break;
      }
      if (store.deleteIfExpired(next.value)) expiredCount++;
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
