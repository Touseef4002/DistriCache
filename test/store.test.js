/**
 * store.test.js — Unit tests for the in-memory key-value Store.
 *
 * Tests the Store as a black box: verifies that get/set/del behave
 * correctly, LRU ordering is maintained, eviction fires at capacity,
 * and TTL expiry works both lazily (on GET) and via the active sweeper.
 */

import { describe, test, expect, jest } from '@jest/globals';
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

  // ═════════════════════════════════════════════════════════════════════
  // PHASE 2: LRU Eviction
  // ═════════════════════════════════════════════════════════════════════

  describe('LRU Eviction', () => {
    test('evicts the LRU entry when at capacity', () => {
      const store = new Store({ maxEntries: 3 });

      store.set('a', '1'); // [a]
      store.set('b', '2'); // [b, a]
      store.set('c', '3'); // [c, b, a]  — at capacity

      // Adding a 4th key should evict 'a' (the LRU)
      store.set('d', '4'); // [d, c, b]  — 'a' evicted

      expect(store.get('a')).toBeNull();   // evicted
      expect(store.get('b')).toBe('2');    // still there
      expect(store.get('c')).toBe('3');    // still there
      expect(store.get('d')).toBe('4');    // newly added
      expect(store.size()).toBe(3);        // didn't exceed capacity
    });

    test('GET protects a key from eviction (refreshes recency)', () => {
      const store = new Store({ maxEntries: 3 });

      store.set('a', '1'); // [a]
      store.set('b', '2'); // [b, a]
      store.set('c', '3'); // [c, b, a]  — at capacity

      // Access 'a' — promotes it to MRU, 'b' becomes LRU
      store.get('a');      // [a, c, b]

      // Adding a 4th key should evict 'b' (now the LRU), NOT 'a'
      store.set('d', '4'); // [d, a, c]

      expect(store.get('a')).toBe('1');    // protected by GET
      expect(store.get('b')).toBeNull();   // evicted (was LRU)
      expect(store.get('d')).toBe('4');    // newly added
    });

    test('overwriting an existing key does NOT trigger eviction', () => {
      const store = new Store({ maxEntries: 3 });

      store.set('a', '1');
      store.set('b', '2');
      store.set('c', '3');

      // Overwriting 'a' should NOT evict anything — it's not a new key
      store.set('a', 'updated');

      expect(store.size()).toBe(3);
      expect(store.get('a')).toBe('updated');
      expect(store.get('b')).toBe('2');
      expect(store.get('c')).toBe('3');
    });

    test('eviction increments the stats counter', () => {
      const store = new Store({ maxEntries: 2 });

      store.set('a', '1');
      store.set('b', '2');
      store.set('c', '3'); // evicts 'a'
      store.set('d', '4'); // evicts 'b'

      expect(store.stats.evictions).toBe(2);
    });

    test('capacity of 1 evicts on every new key', () => {
      const store = new Store({ maxEntries: 1 });

      store.set('a', '1');
      expect(store.get('a')).toBe('1');

      store.set('b', '2'); // evicts 'a'
      expect(store.get('a')).toBeNull();
      expect(store.get('b')).toBe('2');
      expect(store.size()).toBe(1);
    });

    test('Map and list stay in sync after evictions', () => {
      const store = new Store({ maxEntries: 3 });

      // Fill, evict, refill
      store.set('a', '1');
      store.set('b', '2');
      store.set('c', '3');
      store.set('d', '4'); // evicts 'a'
      store.set('e', '5'); // evicts 'b'

      expect(store.size()).toBe(3);
      expect(store.list.length).toBe(3);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // PHASE 2: TTL Expiry
  // ═════════════════════════════════════════════════════════════════════

  describe('TTL — Lazy Expiry', () => {
    test('GET returns null for an expired key (lazy expiry)', () => {
      const store = new Store();

      // Set a key with a TTL of 1 second
      store.set('key1', 'value1', 1);

      // Immediately, it should still be available
      expect(store.get('key1')).toBe('value1');

      // Fast-forward time past the TTL using Date.now mock
      const realNow = Date.now;
      Date.now = () => realNow() + 2000; // 2 seconds later

      // Now GET should return null (expired) and delete the key
      expect(store.get('key1')).toBeNull();
      expect(store.size()).toBe(0); // key was removed from map
      expect(store.list.length).toBe(0); // key was removed from list

      Date.now = realNow; // restore
    });

    test('expired key increments expiredKeys and misses stats', () => {
      const store = new Store();
      store.set('key1', 'value1', 1);

      const realNow = Date.now;
      Date.now = () => realNow() + 2000;

      store.get('key1'); // triggers lazy expiry

      expect(store.stats.expiredKeys).toBe(1);
      expect(store.stats.misses).toBe(1);

      Date.now = realNow;
    });

    test('key without TTL never expires', () => {
      const store = new Store();
      store.set('key1', 'value1'); // no TTL

      const realNow = Date.now;
      Date.now = () => realNow() + 999999999; // way into the future

      expect(store.get('key1')).toBe('value1'); // still available

      Date.now = realNow;
    });

    test('SET with TTL then overwrite without TTL removes expiry', () => {
      const store = new Store();
      store.set('key1', 'value1', 1); // TTL = 1s
      store.set('key1', 'value2');    // no TTL — should clear expiry

      const realNow = Date.now;
      Date.now = () => realNow() + 2000;

      // Key should still be available — TTL was cleared by second SET
      expect(store.get('key1')).toBe('value2');

      Date.now = realNow;
    });

    test('SET with new TTL replaces old TTL', () => {
      const store = new Store();
      store.set('key1', 'value1', 10); // TTL = 10s
      store.set('key1', 'value1', 1);  // TTL = 1s (shortened)

      const realNow = Date.now;
      Date.now = () => realNow() + 2000; // 2s later

      // Key should be expired (TTL was shortened to 1s)
      expect(store.get('key1')).toBeNull();

      Date.now = realNow;
    });
  });

  describe('setExpiry', () => {
    test('sets TTL on an existing key, returns 1', () => {
      const store = new Store();
      store.set('key1', 'value1'); // no TTL

      const result = store.setExpiry('key1', 1); // set 1s TTL
      expect(result).toBe(1);

      const realNow = Date.now;
      Date.now = () => realNow() + 2000;

      expect(store.get('key1')).toBeNull(); // expired

      Date.now = realNow;
    });

    test('returns 0 for non-existent key', () => {
      const store = new Store();

      expect(store.setExpiry('missing', 60)).toBe(0);
    });
  });

  describe('deleteIfExpired', () => {
    test('deletes an expired key and returns true', () => {
      const store = new Store();
      store.set('key1', 'value1', 1);

      const realNow = Date.now;
      Date.now = () => realNow() + 2000;

      expect(store.deleteIfExpired('key1')).toBe(true);
      expect(store.size()).toBe(0);
      expect(store.stats.expiredKeys).toBe(1);

      Date.now = realNow;
    });

    test('returns false for non-expired key', () => {
      const store = new Store();
      store.set('key1', 'value1', 60); // 60s TTL — not expired yet

      expect(store.deleteIfExpired('key1')).toBe(false);
      expect(store.size()).toBe(1); // still there
    });

    test('returns false for key without TTL', () => {
      const store = new Store();
      store.set('key1', 'value1'); // no TTL

      expect(store.deleteIfExpired('key1')).toBe(false);
    });

    test('returns false for non-existent key', () => {
      const store = new Store();

      expect(store.deleteIfExpired('missing')).toBe(false);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // PHASE 2: Eviction + TTL Interaction
  // ═════════════════════════════════════════════════════════════════════

  describe('Eviction + TTL interaction', () => {
    test('expired keys can be evicted by LRU before lazy expiry fires', () => {
      const store = new Store({ maxEntries: 2 });

      store.set('a', '1', 1); // TTL 1s
      store.set('b', '2');

      // 'a' is LRU. Adding 'c' evicts 'a' (by LRU, not TTL)
      store.set('c', '3');

      expect(store.get('a')).toBeNull();
      expect(store.size()).toBe(2);
    });

    test('SET with TTL at capacity evicts LRU then inserts with TTL', () => {
      const store = new Store({ maxEntries: 2 });

      store.set('a', '1');
      store.set('b', '2');
      store.set('c', '3', 1); // evicts 'a', 'c' has TTL

      expect(store.get('a')).toBeNull(); // evicted
      expect(store.get('c')).toBe('3');  // present with TTL

      const realNow = Date.now;
      Date.now = () => realNow() + 2000;

      expect(store.get('c')).toBeNull(); // now expired

      Date.now = realNow;
    });
  });
});
