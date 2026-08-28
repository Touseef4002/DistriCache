/**
 * integration.test.js — End-to-end test with real server processes and client.
 *
 * WHAT THIS TEST PROVES
 * ═════════════════════
 * This is the "it actually works" test. It starts 3 real DistriCache server
 * processes, creates a client that connects to all 3, performs SET/GET/DEL
 * operations, and verifies:
 *
 *   1. ROUND-TRIP CORRECTNESS: SET then GET returns the correct value
 *   2. DISTRIBUTION: Keys land on different nodes (not all on one)
 *   3. DEL WORKS: Deleted keys return null on subsequent GET
 *   4. PING WORKS: Health check returns PONG
 *   5. TTL WORKS: Keys with TTL expire and return null
 *
 * WHY INTEGRATION TESTS MATTER
 * ────────────────────────────
 * Unit tests verify individual components in isolation. But distributed
 * systems have emergent bugs that only appear when components interact:
 *   - TCP framing issues between client and server
 *   - Wire protocol serialization/deserialization mismatches
 *   - Connection pool behavior under real network conditions
 *   - Hash ring routing actually sending to the right server
 *
 * This test catches those issues by exercising the complete data path:
 *   Application → Client → Hash Ring → Connection Pool → TCP → Server → Store
 *
 * TEST SETUP
 * ──────────
 * We use ports 7100-7102 (not the default 7000) to avoid conflicts with
 * any running development servers. The servers are started programmatically
 * using the createCacheServer() factory from server.js.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createCacheServer } from '../src/server.js';
import { DistriCacheClient } from '../src/client/index.js';

// ─── Test cluster configuration ──────────────────────────────────────
const TEST_PORTS = [7100, 7101, 7102];
const TEST_NODES = TEST_PORTS.map(port => `localhost:${port}`);

let servers = [];
let client;

describe('Integration: 3-node cluster', () => {
  // ─── Setup: start 3 servers + create client ──────────────────────
  beforeAll(async () => {
    // Start 3 server instances on test ports
    for (let i = 0; i < TEST_PORTS.length; i++) {
      const server = createCacheServer({
        port: TEST_PORTS[i],
        nodeId: `test-node-${i}`,
        logLevel: 'error', // Suppress noisy logs during tests
      });
      await server.start();
      servers.push(server);
    }

    // Create a client connected to all 3 nodes
    // Health checking disabled to avoid background PING timers during tests
    client = new DistriCacheClient(TEST_NODES, { healthCheck: false });
  }, 15000); // 15s timeout for server startup

  // ─── Teardown: close client + stop servers ───────────────────────
  afterAll(async () => {
    if (client) {
      await client.close();
    }
    for (const server of servers) {
      await server.close();
    }
    servers = [];
  }, 15000);

  // ─── PING ─────────────────────────────────────────────────────────

  test('PING returns PONG from each node', async () => {
    for (const node of TEST_NODES) {
      const result = await client.ping(node);
      expect(result).toBe('PONG');
    }
  });

  // ─── SET + GET round-trip ──────────────────────────────────────────

  test('SET then GET returns the correct value', async () => {
    await client.set('user:1', 'alice');
    const value = await client.get('user:1');
    expect(value).toBe('alice');
  });

  test('SET with quoted value containing spaces', async () => {
    await client.set('greeting', 'hello world');
    const value = await client.get('greeting');
    expect(value).toBe('hello world');
  });

  test('SET overwrites existing key', async () => {
    await client.set('counter', 'one');
    expect(await client.get('counter')).toBe('one');

    await client.set('counter', 'two');
    expect(await client.get('counter')).toBe('two');
  });

  test('GET non-existent key returns null', async () => {
    const value = await client.get('does-not-exist');
    expect(value).toBeNull();
  });

  // ─── DEL ──────────────────────────────────────────────────────────

  test('DEL removes a key', async () => {
    await client.set('temp-key', 'temp-value');
    expect(await client.get('temp-key')).toBe('temp-value');

    const count = await client.del('temp-key');
    expect(count).toBe(1);

    expect(await client.get('temp-key')).toBeNull();
  });

  test('DEL non-existent key returns 0', async () => {
    const count = await client.del('never-existed');
    expect(count).toBe(0);
  });

  // ─── Multiple keys across nodes ───────────────────────────────────
  // This test verifies that the hash ring is actually routing keys to
  // different nodes, which is the whole point of consistent hashing.

  test('multiple keys are distributed across different nodes', async () => {
    // Set many keys and track which node each one routes to
    const keyCount = 50;
    const nodeHits = new Set();

    for (let i = 0; i < keyCount; i++) {
      const key = `dist-test:${i}`;
      await client.set(key, `value-${i}`);

      // Check which node the ring routes this key to
      nodeHits.add(client.ring.getNode(key));
    }

    // With 50 keys across 3 nodes and 150 virtual nodes,
    // we should definitely hit more than 1 node
    expect(nodeHits.size).toBeGreaterThan(1);

    // Verify all values can be retrieved correctly
    for (let i = 0; i < keyCount; i++) {
      const value = await client.get(`dist-test:${i}`);
      expect(value).toBe(`value-${i}`);
    }
  });

  // ─── TTL ──────────────────────────────────────────────────────────

  test('SET with TTL expires the key', async () => {
    // Set a key with a very short TTL (1 second)
    await client.set('ttl-key', 'expires-soon', 1);

    // Should exist immediately
    expect(await client.get('ttl-key')).toBe('expires-soon');

    // Wait for it to expire
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Should be gone now (lazy expiry on GET)
    expect(await client.get('ttl-key')).toBeNull();
  }, 10000); // 10s timeout to account for the wait

  // ─── Batch operations ─────────────────────────────────────────────

  test('many SET/GET operations in sequence', async () => {
    const count = 100;

    // SET 100 keys
    for (let i = 0; i < count; i++) {
      await client.set(`batch:${i}`, `data-${i}`);
    }

    // GET them all back and verify
    for (let i = 0; i < count; i++) {
      const value = await client.get(`batch:${i}`);
      expect(value).toBe(`data-${i}`);
    }

    // DEL them all
    for (let i = 0; i < count; i++) {
      const result = await client.del(`batch:${i}`);
      expect(result).toBe(1);
    }

    // Verify they're gone
    for (let i = 0; i < count; i++) {
      expect(await client.get(`batch:${i}`)).toBeNull();
    }
  }, 30000); // 30s timeout for 400 operations

  // ─── EXPIRE ────────────────────────────────────────────────────────

  test('EXPIRE sets TTL on an existing key', async () => {
    await client.set('expire-test', 'will-expire');

    // EXPIRE should return 1 (key exists)
    const node = client.ring.getNode('expire-test');
    const raw = await client.pool.send(node, 'EXPIRE expire-test 1\r\n');
    expect(raw).toBe(':1\r\n');

    // Key should still exist immediately
    expect(await client.get('expire-test')).toBe('will-expire');

    // Wait for TTL to pass
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Key should be gone now (lazy expiry on GET)
    expect(await client.get('expire-test')).toBeNull();
  }, 10000);

  test('EXPIRE on non-existent key returns 0', async () => {
    const node = client.ring.getNode('no-such-key');
    const raw = await client.pool.send(node, 'EXPIRE no-such-key 60\r\n');
    expect(raw).toBe(':0\r\n');
  });

  // ─── INFO ──────────────────────────────────────────────────────────

  test('INFO returns server stats as bulk string', async () => {
    // Send INFO directly to the first node
    const node = TEST_NODES[0];
    const raw = await client.pool.send(node, 'INFO\r\n');

    // Response should be a bulk string: $<len>\r\n<data>\r\n
    expect(raw[0]).toBe('$');

    // Parse the bulk string
    const headerEnd = raw.indexOf('\r\n');
    const length = parseInt(raw.slice(1, headerEnd), 10);
    expect(length).toBeGreaterThan(0);

    const body = raw.slice(headerEnd + 2, headerEnd + 2 + length);

    // Verify expected sections and fields
    expect(body).toContain('# Server');
    expect(body).toContain('node_id:');
    expect(body).toContain('uptime_seconds:');
    expect(body).toContain('port:');
    expect(body).toContain('# Stats');
    expect(body).toContain('keys:');
    expect(body).toContain('expired_keys:');
    expect(body).toContain('evicted_keys:');
    expect(body).toContain('total_commands:');
    expect(body).toContain('connections_active:');
    expect(body).toContain('# Memory');
    expect(body).toContain('max_entries:');
  });
});
