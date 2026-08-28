/**
 * distribution.test.js — Statistical test for key distribution evenness.
 *
 * WHY THIS TEST EXISTS
 * ════════════════════
 * The PRD (§3) and ARCHITECTURE.md (§6.5) both require that the even
 * distribution claim is "test-backed, not assumed." This test does exactly
 * that: it generates a large number of keys, counts how many land on each
 * node, and asserts that the distribution is reasonably even.
 *
 * THE METRIC: COEFFICIENT OF VARIATION (CV)
 * ──────────────────────────────────────────
 * We use standard deviation as a percentage of the mean (coefficient of
 * variation) because it's scale-independent — it works whether we have
 * 3 nodes or 30, and whether we test with 1,000 keys or 100,000.
 *
 *   CV = (std_dev / mean) × 100
 *
 *   CV < 5%   → excellent distribution
 *   CV < 10%  → good distribution
 *   CV < 15%  → acceptable distribution
 *   CV > 20%  → poor distribution (ring is too uneven)
 *
 * WHAT THIS VALIDATES
 * ───────────────────
 * - Our choice of 150 virtual nodes per physical node is sufficient
 * - The MD5 hash function distributes well enough for ring placement
 * - The binary search clockwise walk doesn't create systematic bias
 *
 * If this test fails, it means our hash ring is distributing keys unevenly,
 * which would cause some nodes to be overloaded while others are underutilized.
 */

import { describe, test, expect } from '@jest/globals';
import { ConsistentHashRing } from '../src/client/hash-ring.js';

/**
 * Calculate the standard deviation of an array of numbers.
 * Used to measure how "spread out" the per-node key counts are.
 *
 * @param {number[]} values
 * @returns {number} Standard deviation
 */
function standardDeviation(values) {
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const squaredDiffs = values.map(v => (v - mean) ** 2);
  const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / n;
  return Math.sqrt(variance);
}

describe('Key Distribution Evenness', () => {

  test('10,000 keys across 3 nodes: CV < 15%', () => {
    const nodes = ['node-a:7000', 'node-b:7001', 'node-c:7002'];
    const ring = new ConsistentHashRing(nodes);

    const keyCount = 10000;

    // Count how many keys land on each node
    const distribution = {};
    for (const node of nodes) {
      distribution[node] = 0;
    }

    for (let i = 0; i < keyCount; i++) {
      const key = `user:${i}`;
      const node = ring.getNode(key);
      distribution[node]++;
    }

    const counts = Object.values(distribution);
    const mean = keyCount / nodes.length;
    const stdDev = standardDeviation(counts);
    const cv = (stdDev / mean) * 100;

    // Log the distribution for visibility
    console.log('Distribution (10k keys, 3 nodes):');
    for (const [node, count] of Object.entries(distribution)) {
      const pct = ((count / keyCount) * 100).toFixed(1);
      console.log(`  ${node}: ${count} keys (${pct}%)`);
    }
    console.log(`  Mean: ${mean.toFixed(0)}, StdDev: ${stdDev.toFixed(1)}, CV: ${cv.toFixed(1)}%`);

    // Assert evenness: CV should be below 15%
    // With 150 virtual nodes, we typically see CV < 5%
    expect(cv).toBeLessThan(15);

    // Also verify that no single node has more than 50% of keys
    // (which would indicate a severely broken ring)
    for (const count of counts) {
      expect(count).toBeLessThan(keyCount * 0.5);
    }
  });

  test('50,000 keys across 5 nodes: CV < 10%', () => {
    const nodes = [
      'cache-1:7000', 'cache-2:7001', 'cache-3:7002',
      'cache-4:7003', 'cache-5:7004',
    ];
    const ring = new ConsistentHashRing(nodes);

    const keyCount = 50000;

    const distribution = {};
    for (const node of nodes) {
      distribution[node] = 0;
    }

    for (let i = 0; i < keyCount; i++) {
      const key = `session:${i}:data`;
      const node = ring.getNode(key);
      distribution[node]++;
    }

    const counts = Object.values(distribution);
    const mean = keyCount / nodes.length;
    const stdDev = standardDeviation(counts);
    const cv = (stdDev / mean) * 100;

    console.log('Distribution (50k keys, 5 nodes):');
    for (const [node, count] of Object.entries(distribution)) {
      const pct = ((count / keyCount) * 100).toFixed(1);
      console.log(`  ${node}: ${count} keys (${pct}%)`);
    }
    console.log(`  Mean: ${mean.toFixed(0)}, StdDev: ${stdDev.toFixed(1)}, CV: ${cv.toFixed(1)}%`);

    // With more nodes and keys, distribution should be even tighter
    expect(cv).toBeLessThan(10);
  });

  test('different key patterns produce similarly even distribution', () => {
    const nodes = ['node-a', 'node-b', 'node-c'];
    const ring = new ConsistentHashRing(nodes);
    const keyCount = 5000;

    // Test with different key patterns to ensure the hash function
    // doesn't have systematic bias for certain prefixes
    const patterns = [
      (i) => `user:${i}`,
      (i) => `session:${i}:token`,
      (i) => `cache:item:${i}`,
      (i) => `${i}`,  // Pure numeric keys
    ];

    for (const pattern of patterns) {
      const distribution = { 'node-a': 0, 'node-b': 0, 'node-c': 0 };

      for (let i = 0; i < keyCount; i++) {
        const key = pattern(i);
        const node = ring.getNode(key);
        distribution[node]++;
      }

      const counts = Object.values(distribution);
      const mean = keyCount / nodes.length;
      const stdDev = standardDeviation(counts);
      const cv = (stdDev / mean) * 100;

      // Each pattern should produce reasonably even distribution
      expect(cv).toBeLessThan(15);
    }
  });
});
