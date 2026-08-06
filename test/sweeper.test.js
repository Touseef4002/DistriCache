/**
 * sweeper.test.js — Unit tests for the active expiry sweeper.
 *
 * Tests the sweeper's behavior in isolation from the timer mechanism:
 * we call _sweep() directly instead of waiting for setInterval ticks.
 * This gives us deterministic, fast tests that don't depend on real time.
 *
 * We also mock Date.now to control TTL expiry precisely.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { Store } from '../src/store.js';
import { createSweeper } from '../src/sweeper.js';

describe('Sweeper', () => {
  let realNow;

  beforeEach(() => {
    realNow = Date.now;
  });

  afterEach(() => {
    Date.now = realNow;
  });

  test('removes expired keys on sweep', () => {
    const store = new Store();

    // Set keys with 1-second TTL
    store.set('a', '1', 1);
    store.set('b', '2', 1);
    store.set('c', '3'); // no TTL — should survive

    // Fast-forward past TTL
    Date.now = () => realNow() + 2000;

    // Run a single sweep with a large batch so all keys are sampled
    const sweeper = createSweeper(store, { intervalMs: 999999, batchSize: 100 });

    sweeper._sweep();
    sweeper.stop();

    // Expired keys should be gone
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(false);

    // Non-expiring key should still be there
    expect(store.has('c')).toBe(true);
    expect(store.size()).toBe(1);
  });

  test('leaves non-expired keys intact', () => {
    const store = new Store();

    store.set('a', '1', 60);  // 60s TTL — NOT expired
    store.set('b', '2', 60);
    store.set('c', '3');      // no TTL

    const sweeper = createSweeper(store, { intervalMs: 999999, batchSize: 100 });
    sweeper._sweep();
    sweeper.stop();

    // Nothing should be removed
    expect(store.size()).toBe(3);
  });

  test('respects batch size — only samples batchSize keys per sweep', () => {
    const store = new Store();

    // Create 100 keys, all expired
    for (let i = 0; i < 100; i++) {
      store.set(`key:${i}`, `val:${i}`, 1);
    }

    Date.now = () => realNow() + 2000;

    // Sweep with batch size of 5 — can only remove up to 5 per sweep
    const sweeper = createSweeper(store, { intervalMs: 999999, batchSize: 5 });
    sweeper._sweep();
    sweeper.stop();

    // At most 5 keys should have been removed (could be fewer if same key
    // was randomly sampled twice, but definitely not more than 5)
    expect(store.size()).toBeGreaterThanOrEqual(95);
    expect(store.size()).toBeLessThanOrEqual(100);
  });

  test('handles empty store gracefully', () => {
    const store = new Store();

    const sweeper = createSweeper(store, { intervalMs: 999999, batchSize: 20 });

    // Should not throw on empty store
    expect(() => sweeper._sweep()).not.toThrow();

    sweeper.stop();
  });

  test('increments expiredKeys stat for each removed key', () => {
    const store = new Store();

    store.set('a', '1', 1);
    store.set('b', '2', 1);

    Date.now = () => realNow() + 2000;

    const sweeper = createSweeper(store, { intervalMs: 999999, batchSize: 100 });
    sweeper._sweep();
    sweeper.stop();

    expect(store.stats.expiredKeys).toBe(2);
  });

  test('stop() halts the sweeper — no more sweeps occur', () => {
    const store = new Store();
    store.set('a', '1', 1);

    const sweeper = createSweeper(store, { intervalMs: 50, batchSize: 100 });

    // Stop immediately — no sweeps should have run yet
    sweeper.stop();

    // Fast-forward
    Date.now = () => realNow() + 2000;

    // Key should still be there (sweeper was stopped before it could sweep)
    // Note: the key IS expired, but without a sweep or a GET (lazy expiry),
    // it remains in the store
    expect(store.has('a')).toBe(true);
  });

  test('multiple sweeps progressively clean expired keys', () => {
    const store = new Store();

    // Create 50 expired keys
    for (let i = 0; i < 50; i++) {
      store.set(`key:${i}`, `val:${i}`, 1);
    }

    Date.now = () => realNow() + 2000;

    // Each sweep samples 10 keys — multiple sweeps should clean more
    const sweeper = createSweeper(store, { intervalMs: 999999, batchSize: 10 });

    const sizeAfterFirst = (() => { sweeper._sweep(); return store.size(); })();
    const sizeAfterSecond = (() => { sweeper._sweep(); return store.size(); })();

    sweeper.stop();

    // Second sweep should have removed more (or equal if all were already gone)
    expect(sizeAfterSecond).toBeLessThanOrEqual(sizeAfterFirst);
  });
});
