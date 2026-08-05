/**
 * store.js — In-memory key-value store with LRU tracking.
 *
 * THE O(1) LRU CACHE PATTERN
 * ══════════════════════════
 * This module implements the classic interview data structure:
 *   HashMap + Doubly Linked List = O(1) LRU Cache
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │  Map (key → Node)     Doubly Linked List        │
 *   │  ┌───────────┐        HEAD ↔ A ↔ B ↔ C ↔ TAIL  │
 *   │  │ "A" → •───┼────→    ↑                        │
 *   │  │ "B" → •───┼────→        ↑                    │
 *   │  │ "C" → •───┼────→              ↑              │
 *   │  └───────────┘                                   │
 *   └─────────────────────────────────────────────────┘
 *
 * The Map provides O(1) lookup by key.
 * The list provides O(1) eviction of the least recently used entry.
 * Together, every operation (get, set, del, evict) is O(1).
 *
 * PHASE 1 SCOPE
 * ─────────────
 * In Phase 1, we build the core get/set/del without capacity-based eviction
 * or TTL. The LRU list is wired up for recency tracking, but `maxEntries`
 * eviction and TTL lazy/active expiry are added in Phase 2.
 *
 * Even without eviction, the LRU list is operational: every access updates
 * recency order. This lets us write tests now that verify the ordering
 * is correct, which Phase 2 will rely on for eviction correctness.
 *
 * STATS TRACKING
 * ──────────────
 * We track basic counters (hits, misses, total commands) from the start.
 * These feed into the INFO command (Phase 4) and are useful for debugging
 * and benchmarking. Tracking them now costs almost nothing and saves
 * retrofitting later.
 */

import { Node, DoublyLinkedList } from './lru.js';

export class Store {
  constructor() {
    /** @type {Map<string, Node>} key → Node (for O(1) lookup) */
    this.map = new Map();

    /** @type {DoublyLinkedList} LRU order tracking */
    this.list = new DoublyLinkedList();

    // --- Stats (cheap to track, useful for INFO command later) ---
    this.stats = {
      hits: 0,         // Successful GET (key found and not expired)
      misses: 0,       // GET miss (key not found or expired)
      totalSets: 0,    // Total SET commands processed
      totalDels: 0,    // Total DEL commands processed (successful deletions)
      evictions: 0,    // LRU evictions (will be used in Phase 2)
      expiredKeys: 0,  // Keys removed due to TTL (will be used in Phase 2)
    };
  }

  /**
   * Retrieve the value for a key.
   *
   * On a hit, the entry is moved to the front of the LRU list (marking it
   * as "most recently used"), which protects it from being the next eviction
   * victim. This is the core LRU behavior.
   *
   * @param {string} key
   * @returns {string|null} The value, or null if the key doesn't exist.
   */
  get(key) {
    const node = this.map.get(key);

    if (!node) {
      this.stats.misses++;
      return null;
    }

    // Move to front = "I was just accessed, don't evict me"
    this.list.moveToFront(node);
    this.stats.hits++;
    return node.value;
  }

  /**
   * Store a key-value pair.
   *
   * If the key already exists, its value is updated and it's moved to the
   * front of the LRU list (same as a GET — accessing a key refreshes its recency).
   *
   * If the key is new, a new node is created and inserted at the front.
   *
   * Note: In Phase 2, this method will also handle capacity-based eviction
   * (when map.size >= maxEntries) and TTL via the `expiresAt` field.
   *
   * @param {string} key
   * @param {string} value
   */
  set(key, value) {
    const existing = this.map.get(key);

    if (existing) {
      // Key exists → update value, refresh recency
      existing.value = value;
      this.list.moveToFront(existing);
    } else {
      // New key → create node, insert into both HashMap and LRU list
      const node = new Node(key, value);
      this.map.set(key, node);
      this.list.addToFront(node);
    }

    this.stats.totalSets++;
  }

  /**
   * Delete a key from the store.
   *
   * Removes the entry from both the HashMap and the LRU list.
   * Returns 1 if the key existed and was deleted, 0 otherwise.
   * (This matches Redis's DEL return value semantics.)
   *
   * @param {string} key
   * @returns {number} 1 if deleted, 0 if key didn't exist
   */
  del(key) {
    const node = this.map.get(key);

    if (!node) {
      return 0;
    }

    // Remove from both data structures to keep them in sync
    this.map.delete(key);
    this.list.remove(node);
    this.stats.totalDels++;
    return 1;
  }

  /**
   * Check if a key exists in the store.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.map.has(key);
  }

  /**
   * Return the number of keys currently in the store.
   * @returns {number}
   */
  size() {
    return this.map.size;
  }
}
