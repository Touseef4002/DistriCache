/**
 * lru.js — Doubly Linked List for LRU (Least Recently Used) tracking.
 *
 * THE CORE DATA STRUCTURE IDEA
 * ════════════════════════════
 * An LRU cache needs to answer two questions in O(1) time:
 *   1. "Given a key, find its entry"          → HashMap (Map in JS)
 *   2. "What's the least recently used entry?" → Doubly Linked List
 *
 * The HashMap lives in store.js. This file implements the doubly linked list.
 *
 * WHY A DOUBLY LINKED LIST?
 * ─────────────────────────
 * A singly linked list can't remove a node in O(1) because you need the
 * previous node's pointer to re-link. A doubly linked list gives us both
 * `prev` and `next`, so we can unlink any node in constant time.
 *
 * Operations and their time complexities:
 *   addToFront(node)  → O(1) — insert after head sentinel
 *   remove(node)      → O(1) — unlink node from its current position
 *   moveToFront(node) → O(1) — remove + addToFront (marks as "most recently used")
 *   removeLast()      → O(1) — unlink the node just before the tail sentinel (the LRU victim)
 *
 * SENTINEL NODES
 * ──────────────
 * The head and tail are "dummy" sentinel nodes that are never removed.
 * They eliminate null-pointer edge cases for an empty list:
 *
 *   Without sentinels: if list is empty, head = null, must check before every operation.
 *   With sentinels:    list always has head ↔ tail, and "empty" means head.next === tail.
 *
 * This is a textbook technique — Redis's own internal linked list uses the same approach.
 *
 *   Visual (3 entries, A is most recent, C is least recent):
 *
 *     HEAD ↔ A ↔ B ↔ C ↔ TAIL
 *     (sentinel)          (sentinel)
 *
 *   On GET("C"): moveToFront(C) →
 *     HEAD ↔ C ↔ A ↔ B ↔ TAIL
 *
 *   On eviction: removeLast() removes B →
 *     HEAD ↔ C ↔ A ↔ TAIL
 */

/**
 * A single node in the doubly linked list.
 *
 * Each node stores a key-value pair and pointers to its neighbors.
 * The key is stored in the node (not just the value) so that when we
 * evict the LRU node, we know which key to remove from the HashMap.
 */
export class Node {
  /**
   * @param {string|null} key   - Cache key (null for sentinel nodes)
   * @param {string|null} value - Cache value (null for sentinel nodes)
   */
  constructor(key = null, value = null) {
    this.key = key;
    this.value = value;
    this.expiresAt = null; // Unix timestamp (ms) for TTL; null = no expiry
    this.prev = null;
    this.next = null;
  }
}

/**
 * Doubly linked list with sentinel head and tail nodes.
 *
 * This is a pure data structure — it knows nothing about cache capacity,
 * eviction policy, or TTL. The Store module (store.js) orchestrates
 * the HashMap and this list together to form the full LRU cache.
 */
export class DoublyLinkedList {
  constructor() {
    // Sentinel nodes — never hold real data, never get removed.
    // They simplify insertion/removal by guaranteeing that every
    // real node always has both a valid prev and a valid next.
    this.head = new Node();
    this.tail = new Node();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.length = 0;
  }

  /**
   * Insert a node right after the head sentinel (most recently used position).
   *
   * Before: HEAD ↔ X ↔ ... ↔ TAIL
   * After:  HEAD ↔ node ↔ X ↔ ... ↔ TAIL
   *
   * @param {Node} node - The node to insert (must not already be in the list)
   */
  addToFront(node) {
    // Wire the new node between HEAD and HEAD.next:
    //   HEAD.next (old first) becomes node.next
    //   node.prev becomes HEAD
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
    this.length++;
  }

  /**
   * Unlink a node from its current position in the list.
   *
   * Before: ... ↔ A ↔ node ↔ B ↔ ...
   * After:  ... ↔ A ↔ B ↔ ...            (node is detached)
   *
   * The node's prev/next are NOT nulled out — the caller may reuse the node
   * (e.g., moveToFront calls remove then addToFront).
   *
   * @param {Node} node - The node to remove (must be in the list, not a sentinel)
   */
  remove(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
    this.length--;
  }

  /**
   * Move an existing node to the front (most recently used position).
   *
   * This is the operation called on every GET or SET that touches an
   * existing key — it updates the recency order in O(1).
   *
   * @param {Node} node - The node to promote (must already be in the list)
   */
  moveToFront(node) {
    this.remove(node);
    this.addToFront(node);
  }

  /**
   * Remove and return the node just before the tail sentinel (least recently used).
   *
   * This is the eviction operation: when the cache is full, we call removeLast()
   * to evict the entry that hasn't been accessed for the longest time.
   *
   * @returns {Node|null} The evicted node, or null if the list is empty.
   */
  removeLast() {
    if (this.length === 0) return null;

    const lruNode = this.tail.prev;
    this.remove(lruNode);
    return lruNode;
  }

  /**
   * Peek at the most recently used node (right after head sentinel).
   * Returns null if the list is empty.
   *
   * @returns {Node|null}
   */
  peekFront() {
    if (this.length === 0) return null;
    return this.head.next;
  }

  /**
   * Peek at the least recently used node (right before tail sentinel).
   * Returns null if the list is empty.
   *
   * @returns {Node|null}
   */
  peekLast() {
    if (this.length === 0) return null;
    return this.tail.prev;
  }
}
