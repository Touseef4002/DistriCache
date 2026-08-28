/**
 * hash-ring.test.js — Unit tests for the consistent hash ring.
 *
 * These tests verify the core properties of consistent hashing:
 *   1. DETERMINISM: Same key always maps to same node
 *   2. MINIMAL REMAPPING: Adding/removing a node remaps < 50% of keys
 *   3. CORRECTNESS: Clockwise walk lands on the right node
 *   4. EDGE CASES: Empty ring, single node, duplicate adds
 */

import { describe, test, expect } from '@jest/globals';
import { ConsistentHashRing, hashToPosition } from '../src/client/hash-ring.js';

describe('ConsistentHashRing', () => {
  // ─── Determinism ───────────────────────────────────────────────────
  // The most fundamental property: given the same ring configuration
  // and the same key, getNode() must always return the same node.
  // If this breaks, the distributed cache doesn't work at all.

  describe('determinism', () => {
    test('same key always maps to the same node', () => {
      const ring = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);

      const first = ring.getNode('user:42');
      const second = ring.getNode('user:42');
      const third = ring.getNode('user:42');

      expect(first).toBe(second);
      expect(second).toBe(third);
    });

    test('different ring instances with same config produce same mapping', () => {
      const ring1 = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);
      const ring2 = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);

      // Test many keys to be thorough
      for (let i = 0; i < 100; i++) {
        const key = `key:${i}`;
        expect(ring1.getNode(key)).toBe(ring2.getNode(key));
      }
    });

    test('node order in constructor does not affect mapping', () => {
      // Consistent hashing must be order-independent — the ring is
      // defined by the positions (hashes), not by insertion order.
      const ring1 = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);
      const ring2 = new ConsistentHashRing(['node-c', 'node-a', 'node-b']);

      for (let i = 0; i < 100; i++) {
        const key = `key:${i}`;
        expect(ring1.getNode(key)).toBe(ring2.getNode(key));
      }
    });
  });

  // ─── Hash function ────────────────────────────────────────────────

  describe('hashToPosition', () => {
    test('returns a 32-bit unsigned integer', () => {
      const pos = hashToPosition('test-string');
      expect(Number.isInteger(pos)).toBe(true);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(0xFFFFFFFF);
    });

    test('same input always produces same output', () => {
      const a = hashToPosition('consistent');
      const b = hashToPosition('consistent');
      expect(a).toBe(b);
    });

    test('different inputs produce different outputs (high probability)', () => {
      const positions = new Set();
      for (let i = 0; i < 1000; i++) {
        positions.add(hashToPosition(`key-${i}`));
      }
      // With 1000 inputs and 2^32 possible outputs, collisions are
      // astronomically unlikely. Allow 1 collision just in case.
      expect(positions.size).toBeGreaterThanOrEqual(999);
    });
  });

  // ─── Minimal remapping on add ──────────────────────────────────────
  // The whole point of consistent hashing: adding a node should remap
  // far fewer keys than modulo hashing would.
  //
  // With N nodes → N+1 nodes:
  //   - Modulo hashing remaps ~N/(N+1) keys (75% for 3→4)
  //   - Consistent hashing remaps ~1/(N+1) keys (25% for 3→4)
  //   - We test for < 50% to give a generous margin while still proving
  //     the property holds

  describe('add node — minimal remapping', () => {
    test('adding a 4th node remaps < 50% of keys', () => {
      const ring = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);

      // Record where 10,000 keys map before the topology change
      const keyCount = 10000;
      const beforeMap = new Map();
      for (let i = 0; i < keyCount; i++) {
        const key = `key:${i}`;
        beforeMap.set(key, ring.getNode(key));
      }

      // Add a 4th node
      ring.addNode('node-d');

      // Count how many keys changed their mapping
      let remapped = 0;
      for (let i = 0; i < keyCount; i++) {
        const key = `key:${i}`;
        if (ring.getNode(key) !== beforeMap.get(key)) {
          remapped++;
        }
      }

      const remapPercent = (remapped / keyCount) * 100;

      // Consistent hashing should remap significantly fewer than 50%
      // Theoretical ideal: ~25% (1/4 of keys move to the new node)
      expect(remapPercent).toBeLessThan(50);
    });

    test('adding a duplicate node is a no-op', () => {
      const ring = new ConsistentHashRing(['node-a', 'node-b']);
      const before = ring.getNode('test-key');

      ring.addNode('node-a'); // Duplicate

      expect(ring.getNodeCount()).toBe(2);
      expect(ring.getNode('test-key')).toBe(before);
    });
  });

  // ─── Minimal remapping on remove ───────────────────────────────────

  describe('remove node — minimal remapping', () => {
    test('removing 1 of 4 nodes remaps < 50% of keys', () => {
      const ring = new ConsistentHashRing(['node-a', 'node-b', 'node-c', 'node-d']);

      const keyCount = 10000;
      const beforeMap = new Map();
      for (let i = 0; i < keyCount; i++) {
        const key = `key:${i}`;
        beforeMap.set(key, ring.getNode(key));
      }

      // Remove node-c
      ring.removeNode('node-c');

      let remapped = 0;
      for (let i = 0; i < keyCount; i++) {
        const key = `key:${i}`;
        if (ring.getNode(key) !== beforeMap.get(key)) {
          remapped++;
        }
      }

      const remapPercent = (remapped / keyCount) * 100;

      // Only keys that were on node-c should remap.
      // Theoretical ideal: ~25% (1/4 of keys were on node-c)
      expect(remapPercent).toBeLessThan(50);
    });

    test('only keys on the removed node get remapped', () => {
      const ring = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);

      const keyCount = 5000;
      const beforeMap = new Map();
      for (let i = 0; i < keyCount; i++) {
        const key = `key:${i}`;
        beforeMap.set(key, ring.getNode(key));
      }

      ring.removeNode('node-b');

      // Keys NOT on node-b should still map to the same node
      for (let i = 0; i < keyCount; i++) {
        const key = `key:${i}`;
        if (beforeMap.get(key) !== 'node-b') {
          expect(ring.getNode(key)).toBe(beforeMap.get(key));
        }
      }
    });

    test('removing a non-existent node is a no-op', () => {
      const ring = new ConsistentHashRing(['node-a', 'node-b']);
      ring.removeNode('node-z');
      expect(ring.getNodeCount()).toBe(2);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  describe('edge cases', () => {
    test('empty ring returns undefined for getNode', () => {
      const ring = new ConsistentHashRing([]);
      expect(ring.getNode('any-key')).toBeUndefined();
    });

    test('single node — all keys map to it', () => {
      const ring = new ConsistentHashRing(['only-node']);

      for (let i = 0; i < 100; i++) {
        expect(ring.getNode(`key:${i}`)).toBe('only-node');
      }
    });

    test('getNodeCount returns the correct count', () => {
      const ring = new ConsistentHashRing([]);
      expect(ring.getNodeCount()).toBe(0);

      ring.addNode('node-a');
      expect(ring.getNodeCount()).toBe(1);

      ring.addNode('node-b');
      expect(ring.getNodeCount()).toBe(2);

      ring.removeNode('node-a');
      expect(ring.getNodeCount()).toBe(1);
    });

    test('getNodes returns all physical node IDs', () => {
      const ring = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);
      const nodes = ring.getNodes();

      expect(nodes).toHaveLength(3);
      expect(nodes).toContain('node-a');
      expect(nodes).toContain('node-b');
      expect(nodes).toContain('node-c');
    });

    test('adding and then removing a node restores original mapping', () => {
      const ring = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);

      // Record original mapping
      const originalMap = new Map();
      for (let i = 0; i < 1000; i++) {
        originalMap.set(`key:${i}`, ring.getNode(`key:${i}`));
      }

      // Add then remove a node
      ring.addNode('node-d');
      ring.removeNode('node-d');

      // All keys should map back to their original nodes
      for (let i = 0; i < 1000; i++) {
        expect(ring.getNode(`key:${i}`)).toBe(originalMap.get(`key:${i}`));
      }
    });
  });

  // ─── Ring wrap-around ─────────────────────────────────────────────

  describe('ring wrap-around', () => {
    test('keys that hash past the last virtual node wrap to the first', () => {
      // With 150 virtual nodes per physical node and 3 nodes = 450 points,
      // there will always be keys that hash higher than the max position.
      // These should wrap around to the first virtual node.
      const ring = new ConsistentHashRing(['node-a', 'node-b', 'node-c']);

      // Just verify that every key returns a valid node (no undefined/null)
      for (let i = 0; i < 1000; i++) {
        const node = ring.getNode(`wrap-test:${i}`);
        expect(node).toBeDefined();
        expect(['node-a', 'node-b', 'node-c']).toContain(node);
      }
    });
  });
});
