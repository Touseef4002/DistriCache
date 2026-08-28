/**
 * hash-ring.js — Consistent Hash Ring for key-to-node routing.
 *
 * THE PROBLEM: WHY NOT hash(key) % N?
 * ════════════════════════════════════
 * Naive modulo hashing (key % numberOfNodes) works until the number of
 * nodes changes. When you add or remove a node, N changes, and nearly
 * EVERY key remaps to a different node. For a cache, this means a mass
 * cache-miss storm — essentially invalidating your entire cache on every
 * topology change.
 *
 * Example with 3 nodes → 4 nodes:
 *   hash("user:1")=7  → 7%3=1, 7%4=3  ← remapped
 *   hash("user:2")=12 → 12%3=0, 12%4=0 ← lucky, stayed
 *   hash("user:3")=15 → 15%3=0, 15%4=3 ← remapped
 *
 * Statistically, ~(N-1)/N keys get remapped. With 3→4 nodes, that's 75%.
 *
 * THE SOLUTION: CONSISTENT HASHING
 * ─────────────────────────────────
 * Instead of modulo, place both nodes and keys on a circular ring
 * (a number line that wraps around from MAX back to 0). To find which
 * node owns a key: hash the key → find its position on the ring →
 * walk clockwise until you hit a node. That's the owning node.
 *
 * When a node is added/removed, only keys in the arc between the
 * affected node and its predecessor are remapped — all other keys
 * stay on their current node. This is O(K/N) remaps instead of O(K).
 *
 * VIRTUAL NODES
 * ─────────────
 * With only N physical nodes on the ring, distribution can be very
 * uneven (especially at small N like 3). Virtual nodes fix this by
 * placing each physical node at multiple positions on the ring.
 *
 * With 150 virtual nodes per physical node, a 3-node cluster has
 * 450 points on the ring, which gives much more even distribution
 * (verified by test/distribution.test.js, not just assumed).
 *
 * HASH FUNCTION: MD5
 * ──────────────────
 * We use MD5 (from Node.js crypto stdlib) because:
 *   - It's built into Node.js (zero dependencies)
 *   - It has excellent distribution properties (uniform output)
 *   - "MD5 is broken" only applies to cryptographic security (collision
 *     resistance for digital signatures). For hash ring placement,
 *     we only need uniform distribution, not collision resistance.
 *   - Alternative: MurmurHash is faster but requires an npm dependency.
 *     MD5's performance is more than adequate at our scale.
 *
 * DATA STRUCTURE: SORTED ARRAY + BINARY SEARCH
 * ─────────────────────────────────────────────
 * The ring is stored as a sorted array of { position, nodeId } entries.
 * Key lookup uses binary search to find the first position >= the key's
 * hash, which gives us O(log(V*N)) lookup time.
 *
 * Why not a balanced BST (e.g., red-black tree)?
 *   - Sorted array is simpler and cache-friendlier (contiguous memory)
 *   - Insertions/removals are O(V*N) but only happen on topology changes
 *     (rare), while lookups happen on every single cache operation (hot path)
 *   - At 450 entries (3 nodes × 150 vnodes), the difference is negligible
 */

import { createHash } from 'node:crypto';

/**
 * Hash a string using MD5 and extract a 32-bit unsigned integer position.
 *
 * We use the first 4 bytes of the MD5 digest as a big-endian uint32.
 * This gives us 2^32 ≈ 4 billion possible positions on the ring,
 * which is more than enough granularity for even large clusters.
 *
 * WHY BIG-ENDIAN?
 * The byte order doesn't actually matter as long as it's consistent.
 * We pick big-endian (most significant byte first) by convention.
 *
 * @param {string} input - The string to hash
 * @returns {number} A 32-bit unsigned integer (0 to 2^32 - 1)
 */
function hashToPosition(input) {
  const digest = createHash('md5').update(input).digest();
  // Read the first 4 bytes as an unsigned 32-bit big-endian integer.
  // Buffer.readUInt32BE(0) reads bytes [0..3] and interprets them as
  // a single number: byte[0]*2^24 + byte[1]*2^16 + byte[2]*2^8 + byte[3]
  return digest.readUInt32BE(0);
}

/**
 * Binary search for the first element in `ring` whose `position` is >= target.
 *
 * This is the "clockwise walk" operation: given a key's hash position,
 * find the next virtual node on the ring (going clockwise = ascending position).
 *
 * If the target is larger than all positions, it wraps around to index 0
 * (the ring is circular, so after the largest position comes the smallest).
 *
 * Time complexity: O(log n) where n = ring.length
 *
 * @param {Array<{position: number, nodeId: string}>} ring - Sorted array of virtual nodes
 * @param {number} target - The hash position to look up
 * @returns {number} Index of the first element with position >= target, or 0 if wrapping
 */
function findNextClockwise(ring, target) {
  let low = 0;
  let high = ring.length - 1;
  let result = 0; // Default to 0 = wrap around to the first node

  while (low <= high) {
    const mid = (low + high) >>> 1; // Unsigned right shift avoids overflow
    if (ring[mid].position >= target) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  // If target > all positions, result stays at 0 (wrap-around).
  // This is correct: the ring is circular.
  // But we need to check: did we actually find a position >= target?
  // If ring[result].position < target, we've wrapped around.
  if (ring[result].position < target) {
    return 0;
  }

  return result;
}

export class ConsistentHashRing {
  /**
   * Create a consistent hash ring.
   *
   * @param {string[]} [nodes=[]] - Initial list of physical node identifiers
   *   (e.g., ['localhost:7000', 'localhost:7001', 'localhost:7002'])
   * @param {number} [virtualNodesPerPhysical=150] - Number of virtual nodes
   *   per physical node. Higher = better distribution but more memory.
   *   150 is the architecture spec default (ARCHITECTURE.md §6.5).
   */
  constructor(nodes = [], virtualNodesPerPhysical = 150) {
    this.virtualNodesPerPhysical = virtualNodesPerPhysical;

    /**
     * The ring: a sorted array of { position, nodeId } entries.
     * Each physical node contributes `virtualNodesPerPhysical` entries.
     * @type {Array<{position: number, nodeId: string}>}
     */
    this.ring = [];

    /**
     * Set of physical node IDs currently on the ring.
     * Used to prevent duplicate additions and for getNodes().
     * @type {Set<string>}
     */
    this.nodeSet = new Set();

    // Add initial nodes
    for (const node of nodes) {
      this.addNode(node);
    }
  }

  /**
   * Add a physical node to the ring.
   *
   * This places `virtualNodesPerPhysical` virtual nodes at deterministic
   * positions on the ring. The positions are derived by hashing
   * "nodeId:0", "nodeId:1", ..., "nodeId:149".
   *
   * After adding all virtual nodes, the ring is re-sorted.
   * Time complexity: O(V * N * log(V * N)) due to the sort,
   * where V = virtual nodes per physical, N = number of physical nodes.
   * This is fine because node additions are rare (topology changes).
   *
   * @param {string} nodeId - The physical node identifier
   */
  addNode(nodeId) {
    if (this.nodeSet.has(nodeId)) return;
    this.nodeSet.add(nodeId);

    for (let i = 0; i < this.virtualNodesPerPhysical; i++) {
      // Hash "nodeId:i" to get a deterministic position for each virtual node.
      // The colon separator prevents collisions between node IDs and indices
      // (e.g., "node1" + ":0" vs "node10" + ":" — the colon makes them distinct).
      const position = hashToPosition(`${nodeId}:${i}`);
      this.ring.push({ position, nodeId });
    }

    // Re-sort the entire ring after adding all virtual nodes.
    // An alternative would be to insert each vnode at the correct position
    // using binary search + splice, but sorting once after batch insert
    // is simpler and fast enough for our scale.
    this.ring.sort((a, b) => a.position - b.position);
  }

  /**
   * Remove a physical node from the ring.
   *
   * Removes all virtual nodes belonging to this physical node.
   * Time complexity: O(V * N) for the filter operation.
   *
   * @param {string} nodeId - The physical node identifier to remove
   */
  removeNode(nodeId) {
    if (!this.nodeSet.has(nodeId)) return;
    this.nodeSet.delete(nodeId);

    // Filter out all virtual nodes belonging to this physical node.
    // We rebuild the array instead of splicing in-place because splice
    // inside a loop is O(n²) while filter is O(n).
    this.ring = this.ring.filter(entry => entry.nodeId !== nodeId);
  }

  /**
   * Determine which physical node owns a given key.
   *
   * Algorithm:
   *   1. Hash the key to a 32-bit position on the ring
   *   2. Binary search for the first virtual node at or after that position
   *   3. Return the physical node that owns that virtual node
   *
   * This is the "clockwise walk" — conceptually, we're walking clockwise
   * around the ring from the key's position until we hit a node.
   *
   * Time complexity: O(log(V * N)) — one binary search per lookup
   *
   * @param {string} key - The cache key to route
   * @returns {string|undefined} The owning physical node's identifier,
   *   or undefined if the ring is empty
   */
  getNode(key) {
    if (this.ring.length === 0) return undefined;

    const position = hashToPosition(key);
    const index = findNextClockwise(this.ring, position);
    return this.ring[index].nodeId;
  }

  /**
   * Return the number of physical nodes on the ring.
   * @returns {number}
   */
  getNodeCount() {
    return this.nodeSet.size;
  }

  /**
   * Return an array of all physical node identifiers on the ring.
   * @returns {string[]}
   */
  getNodes() {
    return Array.from(this.nodeSet);
  }
}

// Export for testing
export { hashToPosition, findNextClockwise };
