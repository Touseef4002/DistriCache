/**
 * store.test.js — Unit tests for the in-memory key-value Store.
 *
 * Tests the Store as a black box: verifies that get/set/del behave
 * correctly and that the LRU ordering is maintained.
 *
 * Phase 1 scope: no eviction or TTL tests yet (those are Phase 2).
 * But we do test LRU ordering to confirm the list is wired correctly,
 * since Phase 2 eviction depends on correct ordering.
 */

import { describe, test, expect } from '@jest/globals';
import { Store } from '../src/store.js';

describe('Store', () => {
  // ─── Basic SET/GET ─────────────────────────────────────────────────

  test('SET then GET returns the stored value', () => {
    const store = new Store();

    store.set('key1', 'value1');

    expect(store.get('key1')).toBe('value1');
  });

  test('GET on a non-existent key returns null', () => {
    const store = new Store();

    expect(store.get('missing')).toBeNull();
  });

  test('SET overwrites an existing key', () => {
    const store = new Store();

    store.set('key1', 'original');
    store.set('key1', 'updated');

    expect(store.get('key1')).toBe('updated');
  });

  test('multiple keys are independent', () => {
    const store = new Store();

    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');

    expect(store.get('a')).toBe('1');
    expect(store.get('b')).toBe('2');
    expect(store.get('c')).toBe('3');
  });

  // ─── DEL ───────────────────────────────────────────────────────────

  test('DEL removes a key and returns 1', () => {
    const store = new Store();

    store.set('key1', 'value1');
    const count = store.del('key1');

    expect(count).toBe(1);
    expect(store.get('key1')).toBeNull();
  });

  test('DEL on non-existent key returns 0', () => {
    const store = new Store();

    const count = store.del('missing');

    expect(count).toBe(0);
  });

  test('DEL then SET re-creates the key', () => {
    const store = new Store();

    store.set('key1', 'v1');
    store.del('key1');
    store.set('key1', 'v2');

    expect(store.get('key1')).toBe('v2');
  });

  // ─── has / size ────────────────────────────────────────────────────

  test('has returns true for existing keys, false for missing', () => {
    const store = new Store();

    store.set('exists', 'yes');

    expect(store.has('exists')).toBe(true);
    expect(store.has('nope')).toBe(false);
  });

  test('size reflects the number of stored keys', () => {
    const store = new Store();

    expect(store.size()).toBe(0);

    store.set('a', '1');
    expect(store.size()).toBe(1);

    store.set('b', '2');
    expect(store.size()).toBe(2);

    store.del('a');
    expect(store.size()).toBe(1);
  });

  // ─── LRU ordering ─────────────────────────────────────────────────

  test('GET promotes a key to most recently used', () => {
    const store = new Store();

    store.set('a', '1'); // Order: a
    store.set('b', '2'); // Order: b, a
    store.set('c', '3'); // Order: c, b, a

    // 'a' is currently LRU. Accessing it should promote it to MRU.
    store.get('a');      // Order: a, c, b

    // Verify: 'b' should now be the LRU (last in the list)
    expect(store.list.peekLast().key).toBe('b');
    // Verify: 'a' should be the MRU (first in the list)
    expect(store.list.peekFront().key).toBe('a');
  });

  test('SET on existing key promotes it to most recently used', () => {
    const store = new Store();

    store.set('a', '1'); // Order: a
    store.set('b', '2'); // Order: b, a
    store.set('c', '3'); // Order: c, b, a

    // Overwrite 'a' — should promote to MRU
    store.set('a', 'new'); // Order: a, c, b

    expect(store.list.peekFront().key).toBe('a');
    expect(store.list.peekLast().key).toBe('b');
  });

  test('new SET inserts at MRU position', () => {
    const store = new Store();

    store.set('a', '1');
    store.set('b', '2');

    // Most recently SET key should be at the front
    expect(store.list.peekFront().key).toBe('b');
    expect(store.list.peekLast().key).toBe('a');
  });

  // ─── Stats tracking ───────────────────────────────────────────────

  test('stats track hits, misses, sets, and dels', () => {
    const store = new Store();

    store.set('a', '1');      // 1 set
    store.set('b', '2');      // 2 sets
    store.get('a');           // 1 hit
    store.get('missing');     // 1 miss
    store.del('a');           // 1 del
    store.del('nonexistent'); // del miss (not counted as totalDels)

    expect(store.stats.totalSets).toBe(2);
    expect(store.stats.hits).toBe(1);
    expect(store.stats.misses).toBe(1);
    expect(store.stats.totalDels).toBe(1);
  });

  // ─── Data structure consistency ────────────────────────────────────

  test('Map and LRU list stay in sync after mixed operations', () => {
    const store = new Store();

    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    store.del('b');
    store.set('d', '4');
    store.get('a');

    // Map should have: a, c, d (b was deleted)
    expect(store.size()).toBe(3);
    expect(store.list.length).toBe(3);

    // Verify all map entries exist in the list (structural consistency)
    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(false);
    expect(store.has('c')).toBe(true);
    expect(store.has('d')).toBe(true);
  });
});
