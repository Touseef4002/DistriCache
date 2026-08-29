import { createHash } from 'node:crypto';

/** @param {string} input @returns {number} */
function hashToPosition(input) {
  return createHash('md5').update(input).digest().readUInt32BE(0);
}

/**
 * Binary search for the first ring entry with position >= target.
 * Returns 0 (wrap-around) if target exceeds all positions.
 * @param {Array<{position: number, nodeId: string}>} ring
 * @param {number} target
 * @returns {number}
 */
function findNextClockwise(ring, target) {
  let low = 0;
  let high = ring.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (ring[mid].position >= target) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return ring[result].position < target ? 0 : result;
}

export class ConsistentHashRing {
  /**
   * @param {string[]} [nodes]
   * @param {number} [virtualNodesPerPhysical=150]
   */
  constructor(nodes = [], virtualNodesPerPhysical = 150) {
    this.virtualNodesPerPhysical = virtualNodesPerPhysical;

    /** @type {Array<{position: number, nodeId: string}>} */
    this.ring = [];

    /** @type {Set<string>} */
    this.nodeSet = new Set();

    for (const node of nodes) this.addNode(node);
  }

  /** @param {string} nodeId */
  addNode(nodeId) {
    if (this.nodeSet.has(nodeId)) return;
    this.nodeSet.add(nodeId);

    for (let i = 0; i < this.virtualNodesPerPhysical; i++) {
      this.ring.push({ position: hashToPosition(`${nodeId}:${i}`), nodeId });
    }

    this.ring.sort((a, b) => a.position - b.position);
  }

  /** @param {string} nodeId */
  removeNode(nodeId) {
    if (!this.nodeSet.has(nodeId)) return;
    this.nodeSet.delete(nodeId);
    this.ring = this.ring.filter(entry => entry.nodeId !== nodeId);
  }

  /**
   * @param {string} key
   * @returns {string|undefined}
   */
  getNode(key) {
    if (this.ring.length === 0) return undefined;
    return this.ring[findNextClockwise(this.ring, hashToPosition(key))].nodeId;
  }

  /** @returns {number} */
  getNodeCount() {
    return this.nodeSet.size;
  }

  /** @returns {string[]} */
  getNodes() {
    return Array.from(this.nodeSet);
  }
}

export { hashToPosition, findNextClockwise };
