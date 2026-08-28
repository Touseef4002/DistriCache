/**
 * health-checker.test.js — Tests for client-side failure detection.
 *
 * WHAT THIS TEST PROVES
 * ═════════════════════
 * These tests verify the health checker's state machine transitions and
 * its integration with the hash ring. We use real server processes (same
 * pattern as integration.test.js) to test actual TCP PING behavior.
 *
 * KEY SCENARIOS:
 *   1. All nodes start as healthy
 *   2. A killed node transitions: Healthy → Suspect → Down
 *   3. A Down node is removed from the hash ring
 *   4. A restarted node recovers: Down → Healthy
 *   5. A recovered node is re-added to the hash ring
 *
 * TIMING:
 * We use aggressive intervals (pingInterval=200ms, pingTimeout=100ms,
 * failureThreshold=2) to keep tests fast (~2-3s) while still testing
 * real TCP behavior. The helper `waitForCondition` polls a predicate
 * to avoid fragile fixed-delay waits.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { createCacheServer } from '../src/server.js';
import { HealthChecker, NodeState } from '../src/client/health-checker.js';
import { ConsistentHashRing } from '../src/client/hash-ring.js';

// ─── Test configuration ────────────────────────────────────────────────
const TEST_PORTS = [7200, 7201, 7202];
const TEST_NODES = TEST_PORTS.map(port => `localhost:${port}`);

// Aggressive timing for fast tests
const HEALTH_OPTIONS = {
  pingInterval: 200,
  pingTimeout: 100,
  failureThreshold: 2,
};

/**
 * Wait for a condition to become true, checking every `intervalMs`.
 * Times out after `timeoutMs` and throws a descriptive error.
 *
 * WHY NOT setTimeout WITH A FIXED DELAY?
 * A fixed delay (e.g., "wait 2 seconds") is fragile — it might be too
 * short on a slow CI machine or too long on a fast one. Polling a
 * condition gives us the exact wait time needed, with a safety timeout.
 */
function waitForCondition(predicate, description, timeoutMs = 5000, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function check() {
      if (predicate()) {
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for: ${description}`));
      } else {
        setTimeout(check, intervalMs);
      }
    }

    check();
  });
}

// ─── Unit tests (no servers needed) ──────────────────────────────────

describe('HealthChecker — unit (no servers)', () => {
  test('all nodes start as healthy', () => {
    const ring = new ConsistentHashRing(TEST_NODES);
    const checker = new HealthChecker(TEST_NODES, ring, HEALTH_OPTIONS);

    for (const node of TEST_NODES) {
      expect(checker.getNodeStatus(node)).toBe(NodeState.HEALTHY);
    }

    // Don't start the checker — we're testing initial state only
  });

  test('getAllNodeStatuses returns a map of all nodes', () => {
    const ring = new ConsistentHashRing(TEST_NODES);
    const checker = new HealthChecker(TEST_NODES, ring, HEALTH_OPTIONS);

    const statuses = checker.getAllNodeStatuses();

    expect(statuses.size).toBe(3);
    for (const node of TEST_NODES) {
      expect(statuses.get(node)).toBe(NodeState.HEALTHY);
    }
  });

  test('getNodeStatus for unknown node returns "down"', () => {
    const ring = new ConsistentHashRing(TEST_NODES);
    const checker = new HealthChecker(TEST_NODES, ring, HEALTH_OPTIONS);

    expect(checker.getNodeStatus('unknown:9999')).toBe(NodeState.DOWN);
  });

  test('stop() is idempotent — can be called multiple times', () => {
    const ring = new ConsistentHashRing(TEST_NODES);
    const checker = new HealthChecker(TEST_NODES, ring, HEALTH_OPTIONS);

    // Should not throw
    checker.stop();
    checker.stop();
  });
});

// ─── Integration tests (with real servers) ───────────────────────────

describe('HealthChecker — with servers', () => {
  let servers = [];
  let ring;
  let checker;

  beforeAll(async () => {
    // Start all 3 servers
    for (let i = 0; i < TEST_PORTS.length; i++) {
      const server = createCacheServer({
        port: TEST_PORTS[i],
        nodeId: `health-test-${i}`,
        logLevel: 'error',
      });
      await server.start();
      servers.push(server);
    }
  }, 15000);

  afterAll(async () => {
    for (const server of servers) {
      await server.close();
    }
    servers = [];
  }, 15000);

  afterEach(() => {
    if (checker) {
      checker.stop();
      checker = null;
    }
  });

  test('all nodes remain healthy when servers are running', async () => {
    ring = new ConsistentHashRing(TEST_NODES);
    checker = new HealthChecker(TEST_NODES, ring, HEALTH_OPTIONS);
    checker.start();

    // Wait a couple of ping cycles
    await new Promise(resolve => setTimeout(resolve, HEALTH_OPTIONS.pingInterval * 3));

    for (const node of TEST_NODES) {
      expect(checker.getNodeStatus(node)).toBe(NodeState.HEALTHY);
    }

    // All nodes should still be on the ring
    expect(ring.getNodeCount()).toBe(3);
  });

  test('node marked down after server is killed', async () => {
    ring = new ConsistentHashRing(TEST_NODES);
    checker = new HealthChecker(TEST_NODES, ring, HEALTH_OPTIONS);
    checker.start();

    // Wait for initial health checks to confirm all healthy
    await waitForCondition(
      () => checker.getNodeStatus(TEST_NODES[0]) === NodeState.HEALTHY,
      'node-0 to be confirmed healthy',
    );

    // Kill the first server
    await servers[0].close();

    // Wait for the health checker to detect the failure.
    // With failureThreshold=2 and pingInterval=200ms, it should take
    // ~400-600ms to transition through Suspect → Down.
    await waitForCondition(
      () => checker.getNodeStatus(TEST_NODES[0]) === NodeState.DOWN,
      'node-0 to be marked down',
      3000,
    );

    expect(checker.getNodeStatus(TEST_NODES[0])).toBe(NodeState.DOWN);

    // Down node should be removed from the ring
    expect(ring.getNodeCount()).toBe(2);
    expect(ring.getNodes()).not.toContain(TEST_NODES[0]);

    // Other nodes should still be healthy
    expect(checker.getNodeStatus(TEST_NODES[1])).toBe(NodeState.HEALTHY);
    expect(checker.getNodeStatus(TEST_NODES[2])).toBe(NodeState.HEALTHY);

    // Restart the server for subsequent tests
    const restarted = createCacheServer({
      port: TEST_PORTS[0],
      nodeId: 'health-test-0-restarted',
      logLevel: 'error',
    });
    await restarted.start();
    servers[0] = restarted;
  }, 15000);

  test('down node recovers when server restarts', async () => {
    ring = new ConsistentHashRing(TEST_NODES);
    checker = new HealthChecker(TEST_NODES, ring, HEALTH_OPTIONS);
    checker.start();

    // Wait for all nodes to be confirmed healthy
    await waitForCondition(
      () => checker.getNodeStatus(TEST_NODES[1]) === NodeState.HEALTHY,
      'node-1 to be confirmed healthy',
    );

    // Kill server 1
    await servers[1].close();

    // Wait for it to be marked down
    await waitForCondition(
      () => checker.getNodeStatus(TEST_NODES[1]) === NodeState.DOWN,
      'node-1 to be marked down',
      3000,
    );

    expect(ring.getNodeCount()).toBe(2);

    // Restart server 1
    const restarted = createCacheServer({
      port: TEST_PORTS[1],
      nodeId: 'health-test-1-restarted',
      logLevel: 'error',
    });
    await restarted.start();
    servers[1] = restarted;

    // Wait for the health checker to detect recovery
    await waitForCondition(
      () => checker.getNodeStatus(TEST_NODES[1]) === NodeState.HEALTHY,
      'node-1 to recover to healthy',
      3000,
    );

    expect(checker.getNodeStatus(TEST_NODES[1])).toBe(NodeState.HEALTHY);

    // Node should be back on the ring
    expect(ring.getNodeCount()).toBe(3);
    expect(ring.getNodes()).toContain(TEST_NODES[1]);
  }, 15000);

  test('onStateChange callback fires on transitions', async () => {
    ring = new ConsistentHashRing(TEST_NODES);
    const transitions = [];

    checker = new HealthChecker(TEST_NODES, ring, {
      ...HEALTH_OPTIONS,
      onStateChange: (node, from, to) => {
        transitions.push({ node, from, to });
      },
    });
    checker.start();

    // Wait for initial healthy confirmation
    await new Promise(resolve => setTimeout(resolve, HEALTH_OPTIONS.pingInterval * 2));

    // Kill server 2
    await servers[2].close();

    // Wait for Down transition
    await waitForCondition(
      () => checker.getNodeStatus(TEST_NODES[2]) === NodeState.DOWN,
      'node-2 to be marked down',
      3000,
    );

    // Should have at least Healthy→Suspect and Suspect→Down transitions
    const nodeTransitions = transitions.filter(t => t.node === TEST_NODES[2]);
    expect(nodeTransitions.length).toBeGreaterThanOrEqual(2);

    const suspectTransition = nodeTransitions.find(t => t.to === NodeState.SUSPECT);
    const downTransition = nodeTransitions.find(t => t.to === NodeState.DOWN);

    expect(suspectTransition).toBeDefined();
    expect(suspectTransition.from).toBe(NodeState.HEALTHY);

    expect(downTransition).toBeDefined();
    expect(downTransition.from).toBe(NodeState.SUSPECT);

    // Restart for cleanup
    const restarted = createCacheServer({
      port: TEST_PORTS[2],
      nodeId: 'health-test-2-restarted',
      logLevel: 'error',
    });
    await restarted.start();
    servers[2] = restarted;
  }, 15000);
});
