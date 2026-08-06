/**
 * store.js — In-memory key-value store with LRU eviction and TTL expiry.
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
 * EVICTION (Phase 2)
 * ──────────────────
 * When the store reaches its `maxEntries` capacity and a new (non-existing)
 * key is being SET, the least recently used entry (tail of the list) is
 * evicted to make room. This is the classic LRU eviction policy.
 *
 * The eviction unit is **entry count**, not byte-level memory. This is
 * simpler to implement and reason about, and sufficient for a portfolio
 * project. Byte-level eviction would require tracking the memory size of
 * every key and value, which adds complexity without much learning value.
 *
 * TTL EXPIRY (Phase 2)
 * ────────────────────
 * Two complementary mechanisms ensure expired keys are both correct and reclaimed:
 *
 *   1. LAZY EXPIRY: On every GET, check if the key's TTL has passed.
 *      If expired, delete it and return null. This guarantees correctness —
 *      an expired key is never returned, even if active expiry hasn't
 *      scanned it yet. Cost: one timestamp comparison per GET (essentially free).
 *
 *   2. ACTIVE EXPIRY: A background sweeper (sweeper.js) periodically samples
 *      random keys and deletes expired ones. This prevents memory leaks from
 *      expired keys that are never read again. The sweeper calls
 *      `store.deleteIfExpired()` on sampled keys.
 *
 * WHY BOTH?
 *   - Lazy only: correct, but expired keys that are never GET'd leak memory forever.
 *   - Active only: reclaims memory, but there's a race window where a GET could
 *     return an expired value between sweeps.
 *   - Both: correct AND memory-efficient. Hot keys (frequently read) are lazily
 *     expired. Cold keys (never read again) are actively swept.
 *
 * This is exactly how Redis handles expiry internally.
 */

import { Node, DoublyLinkedList } from './lru.js';

export class Store {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries=10000] - Maximum number of entries before LRU eviction kicks in.
   *   Uses the MAX_ENTRIES env var as default if available.
   */
  constructor(options = {}) {
    /** @type {number} Maximum entries before eviction. */
    this.maxEntries = options.maxEntries
      ?? (process.env.MAX_ENTRIES ? parseInt(process.env.MAX_ENTRIES, 10) : 10000);

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
      evictions: 0,    // LRU evictions when at capacity
      expiredKeys: 0,  // Keys removed due to TTL (lazy + active)
    };
  }

  /**
   * Retrieve the value for a key.
   *
   * On a hit, the entry is moved to the front of the LRU list (marking it
   * as "most recently used"), which protects it from being the next eviction
   * victim. This is the core LRU behavior.
   *
   * LAZY EXPIRY: If the key exists but its TTL has passed, it is deleted
   * and treated as a miss. This guarantees correctness — an expired key
   * is never returned to the caller.
   *
   * @param {string} key
   * @returns {string|null} The value, or null if the key doesn't exist or is expired.
   */
  get(key) {
    const node = this.map.get(key);

    if (!node) {
      this.stats.misses++;
      return null;
    }

    // ─── Lazy expiry check ───────────────────────────────────────
    // If this key has a TTL and it's past the expiration time, treat
    // it as if the key doesn't exist. Delete it from both data structures.
    //
    // This is O(1) — just one timestamp comparison on every GET.
    // The alternative (checking all keys on a timer) is O(n) per sweep.
    // Lazy expiry handles the hot path (frequently accessed keys) for free.
    if (node.expiresAt !== null && node.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.list.remove(node);
      this.stats.expiredKeys++;
      this.stats.misses++;
      return null;
    }

    // Move to front = "I was just accessed, don't evict me"
    this.list.moveToFront(node);
    this.stats.hits++;
    return node.value;
  }

  /**
   * Store a key-value pair, optionally with a TTL.
   *
   * If the key already exists, its value is updated and it's moved to the
   * front of the LRU list (same as a GET — accessing a key refreshes its recency).
   * If a new TTL is provided, it replaces the old one.
   *
   * If the key is new and the store is at capacity, the least recently used
   * entry is evicted before inserting the new one.
   *
   * @param {string} key
   * @param {string} value
   * @param {number|null} [ttlSeconds=null] - Time-to-live in seconds, or null for no expiry.
   */
  set(key, value, ttlSeconds = null) {
    const existing = this.map.get(key);

    if (existing) {
      // Key exists → update value, refresh recency
      existing.value = value;
      existing.expiresAt = ttlSeconds !== null
        ? Date.now() + (ttlSeconds * 1000)
        : null;
      this.list.moveToFront(existing);
    } else {
      // ─── LRU eviction ───────────────────────────────────────────
      // If at capacity, remove the least recently used entry (tail of list)
      // to make room for the new key.
      //
      // Why check `>=` instead of `>`?
      // Because we're about to add one more entry. If size == maxEntries,
      // adding one more would exceed capacity, so we evict first.
      if (this.map.size >= this.maxEntries) {
        this._evict();
      }

      // New key → create node, insert into both HashMap and LRU list
      const node = new Node(key, value);
      node.expiresAt = ttlSeconds !== null
        ? Date.now() + (ttlSeconds * 1000)
        : null;
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
   * Check if a key exists and is not expired.
   *
   * Does NOT trigger lazy expiry — this is a passive check.
   * (Lazy expiry only fires on GET, matching Redis behavior.)
   *
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.map.has(key);
  }

  /**
   * Return the number of keys currently in the store.
   * Note: This includes keys that may be expired but haven't been lazily or actively cleaned yet.
   * @returns {number}
   */
  size() {
    return this.map.size;
  }

  /**
   * Set or update the TTL on an existing key.
   *
   * This is used by the EXPIRE command (Phase 4):
   *   EXPIRE key 60 → set the key to expire in 60 seconds
   *
   * Returns 1 if the key exists (TTL was set), 0 if it doesn't.
   *
   * @param {string} key
   * @param {number} ttlSeconds - Time-to-live in seconds
   * @returns {number} 1 if key exists, 0 if not
   */
  setExpiry(key, ttlSeconds) {
    const node = this.map.get(key);
    if (!node) return 0;

    node.expiresAt = Date.now() + (ttlSeconds * 1000);
    return 1;
  }

  /**
   * Check if a specific key is expired and delete it if so.
   *
   * This is called by the active expiry sweeper (sweeper.js) on sampled keys.
   * Returns true if the key was expired and deleted.
   *
   * Unlike lazy expiry (which fires on GET), this is called proactively by
   * the background sweep to reclaim memory from keys that are never read.
   *
   * @param {string} key
   * @returns {boolean} true if the key was expired and deleted
   */
  deleteIfExpired(key) {
    const node = this.map.get(key);
    if (!node) return false;
    if (node.expiresAt === null) return false;
    if (node.expiresAt > Date.now()) return false;

    // Key is expired — remove it
    this.map.delete(key);
    this.list.remove(node);
    this.stats.expiredKeys++;
    return true;
  }

  /**
   * Get all keys in the store. Used by the sweeper for random sampling.
   *
   * WHY NOT ITERATE THE MAP DIRECTLY IN THE SWEEPER?
   * We expose this method instead of the Map itself to maintain encapsulation.
   * The sweeper shouldn't know about the store's internal data structures.
   *
   * @returns {IterableIterator<string>}
   */
  keys() {
    return this.map.keys();
  }

  /**
   * Evict the least recently used entry.
   *
   * Removes the node just before the tail sentinel — the entry that
   * hasn't been accessed for the longest time.
   *
   * @private
   */
  _evict() {
    const evicted = this.list.removeLast();
    if (evicted) {
      this.map.delete(evicted.key);
      this.stats.evictions++;
    }
  }
}
