import { Node, DoublyLinkedList } from './lru.js';

export class Store {
  /** @param {{ maxEntries?: number }} [options] */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries
      ?? (process.env.MAX_ENTRIES ? parseInt(process.env.MAX_ENTRIES, 10) : 10000);

    /** @type {Map<string, Node>} */
    this.map = new Map();
    this.list = new DoublyLinkedList();

    this.stats = {
      hits: 0,
      misses: 0,
      totalSets: 0,
      totalDels: 0,
      evictions: 0,
      expiredKeys: 0,
    };
  }

  /**
   * @param {string} key
   * @returns {string|null}
   */
  get(key) {
    const node = this.map.get(key);

    if (!node) {
      this.stats.misses++;
      return null;
    }

    if (node.expiresAt !== null && node.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.list.remove(node);
      this.stats.expiredKeys++;
      this.stats.misses++;
      return null;
    }

    this.list.moveToFront(node);
    this.stats.hits++;
    return node.value;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @param {number|null} [ttlSeconds]
   */
  set(key, value, ttlSeconds = null) {
    const existing = this.map.get(key);

    if (existing) {
      existing.value = value;
      existing.expiresAt = ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null;
      this.list.moveToFront(existing);
    } else {
      if (this.map.size >= this.maxEntries) this._evict();

      const node = new Node(key, value);
      node.expiresAt = ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null;
      this.map.set(key, node);
      this.list.addToFront(node);
    }

    this.stats.totalSets++;
  }

  /**
   * @param {string} key
   * @returns {number} 1 if deleted, 0 if not found
   */
  del(key) {
    const node = this.map.get(key);
    if (!node) return 0;

    this.map.delete(key);
    this.list.remove(node);
    this.stats.totalDels++;
    return 1;
  }

  /** @param {string} key */
  has(key) {
    return this.map.has(key);
  }

  /** @returns {number} */
  size() {
    return this.map.size;
  }

  /**
   * @param {string} key
   * @param {number} ttlSeconds
   * @returns {number} 1 if key exists, 0 if not
   */
  setExpiry(key, ttlSeconds) {
    const node = this.map.get(key);
    if (!node) return 0;
    node.expiresAt = Date.now() + ttlSeconds * 1000;
    return 1;
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  deleteIfExpired(key) {
    const node = this.map.get(key);
    if (!node || node.expiresAt === null || node.expiresAt > Date.now()) return false;

    this.map.delete(key);
    this.list.remove(node);
    this.stats.expiredKeys++;
    return true;
  }

  /** @returns {IterableIterator<string>} */
  keys() {
    return this.map.keys();
  }

  /** @private */
  _evict() {
    const evicted = this.list.removeLast();
    if (evicted) {
      this.map.delete(evicted.key);
      this.stats.evictions++;
    }
  }
}
