/**
 * index.js — DistriCacheClient: the public API for distributed cache operations.
 *
 * WHAT THIS MODULE DOES
 * ═════════════════════
 * This is the entry point for any application that wants to use DistriCache
 * as a distributed cache cluster. It orchestrates three components:
 *
 *   1. HASH RING (hash-ring.js):  Key → which node owns this key?
 *   2. CONNECTION POOL (connection-pool.js): Node → get me a TCP socket
 *   3. WIRE PROTOCOL: Serialize commands and parse responses
 *
 * The client is the ONLY component that understands the cluster topology.
 * Individual cache nodes know nothing about each other — all sharding
 * and routing decisions happen here. This is the same architecture as
 * Redis Cluster's client-side routing (smart client pattern).
 *
 * WHY CLIENT-SIDE ROUTING?
 * ────────────────────────
 * Alternative: a server-side proxy (like Twemproxy or Envoy) that sits
 * between the client and the cluster and routes requests.
 *
 *   Client-side routing (chosen):
 *     ✅ No single point of failure (no proxy to crash)
 *     ✅ One fewer network hop (client → node, not client → proxy → node)
 *     ✅ Simpler to deploy (no proxy service to manage)
 *     ❌ Routing logic must be in every client language
 *
 *   Server-side proxy:
 *     ✅ Clients can be "dumb" (just send to the proxy)
 *     ❌ Proxy is a SPOF and bottleneck
 *     ❌ Extra network hop adds latency
 *
 * For a portfolio project demonstrating distributed systems concepts,
 * client-side routing is more interesting — we actually implement the
 * consistent hashing and routing logic rather than deferring it to a proxy.
 *
 * USAGE:
 * ──────
 * ```javascript
 * import { DistriCacheClient } from './src/client/index.js';
 *
 * const client = new DistriCacheClient([
 *   'localhost:7000', 'localhost:7001', 'localhost:7002'
 * ]);
 *
 * await client.set('user:42', 'alice');
 * const value = await client.get('user:42');  // 'alice'
 * await client.del('user:42');
 * await client.close();
 * ```
 */

import { ConsistentHashRing } from './hash-ring.js';
import { ConnectionPool } from './connection-pool.js';
import { HealthChecker } from './health-checker.js';

/**
 * Parse a raw wire protocol response into a JavaScript value.
 *
 * This is the inverse of the server's response formatting:
 *   +OK\r\n          → 'OK'          (string)
 *   -ERR message\r\n → throws Error  (error)
 *   :42\r\n          → 42            (number)
 *   $-1\r\n          → null          (null/miss)
 *   $5\r\nalice\r\n  → 'alice'       (string)
 *
 * @param {string} raw - Raw response from the server
 * @returns {string|number|null} Parsed value
 * @throws {Error} If the response is an error (-ERR ...)
 */
function parseResponse(raw) {
  const firstChar = raw[0];

  switch (firstChar) {
    case '+':
      // Simple string: +<message>\r\n → message
      return raw.slice(1, -2);

    case '-':
      // Error: -ERR <message>\r\n → throw
      throw new Error(raw.slice(1, -2));

    case ':':
      // Integer: :<number>\r\n → number
      return parseInt(raw.slice(1, -2), 10);

    case '$': {
      // Bulk string: $<len>\r\n<data>\r\n → data (or null for $-1)
      const headerEnd = raw.indexOf('\r\n');
      const length = parseInt(raw.slice(1, headerEnd), 10);

      if (length === -1) return null;

      // Extract the data payload: starts after "$<len>\r\n", length bytes long
      const dataStart = headerEnd + 2;
      return raw.slice(dataStart, dataStart + length);
    }

    default:
      throw new Error(`Unknown response type: ${firstChar}`);
  }
}

export class DistriCacheClient {
  /**
   * Create a new DistriCache client.
   *
   * @param {string[]} nodes - Array of node addresses, e.g., ['localhost:7000', 'localhost:7001']
   * @param {object} [options]
   * @param {number} [options.virtualNodes=150] - Virtual nodes per physical node for the hash ring
   * @param {number} [options.connectTimeout=5000] - TCP connection timeout in ms
   * @param {boolean} [options.healthCheck=true] - Enable/disable health checking
   * @param {number} [options.pingInterval=2000] - Health check PING interval in ms
   * @param {number} [options.pingTimeout=1000] - Health check PING timeout in ms
   * @param {number} [options.failureThreshold=3] - Consecutive failures before marking node down
   * @param {Function} [options.onStateChange] - Callback for node state transitions
   */
  constructor(nodes, options = {}) {
    if (!nodes || nodes.length === 0) {
      throw new Error('At least one node address is required');
    }

    /** @type {ConsistentHashRing} */
    this.ring = new ConsistentHashRing(nodes, options.virtualNodes);

    /** @type {ConnectionPool} */
    this.pool = new ConnectionPool({
      connectTimeout: options.connectTimeout,
    });

    /** @type {string[]} All configured node addresses */
    this.nodes = [...nodes];

    /** @type {HealthChecker|null} */
    this.healthChecker = null;

    // Health checking is enabled by default.
    // Disable with options.healthCheck = false (useful for tests that
    // don't want background PING timers interfering with teardown).
    const healthCheckEnabled = options.healthCheck !== false;

    if (healthCheckEnabled) {
      this.healthChecker = new HealthChecker(nodes, this.ring, {
        pingInterval: options.pingInterval,
        pingTimeout: options.pingTimeout,
        failureThreshold: options.failureThreshold,
        onStateChange: options.onStateChange,
      });
      this.healthChecker.start();
    }
  }

  /**
   * Store a key-value pair in the cache.
   *
   * The key is hashed to determine which node owns it, then a SET command
   * is sent over TCP to that specific node.
   *
   * @param {string} key - The cache key
   * @param {string} value - The value to store
   * @param {number} [ttlSeconds] - Optional TTL in seconds
   * @returns {Promise<string>} 'OK' on success
   */
  async set(key, value, ttlSeconds) {
    const node = this.ring.getNode(key);
    if (!node) throw new Error('No nodes available');

    // Build the wire protocol command.
    // Values with spaces need to be quoted so the server's parser
    // treats them as a single argument.
    const quotedValue = value.includes(' ') ? `"${value}"` : value;
    let command = `SET ${key} ${quotedValue}`;

    if (ttlSeconds !== undefined && ttlSeconds !== null) {
      command += ` EX ${ttlSeconds}`;
    }

    command += '\r\n';

    const raw = await this.pool.send(node, command);
    return parseResponse(raw);
  }

  /**
   * Retrieve a value from the cache.
   *
   * @param {string} key - The cache key
   * @returns {Promise<string|null>} The value, or null if the key doesn't exist
   */
  async get(key) {
    const node = this.ring.getNode(key);
    if (!node) throw new Error('No nodes available');

    const raw = await this.pool.send(node, `GET ${key}\r\n`);
    return parseResponse(raw);
  }

  /**
   * Delete a key from the cache.
   *
   * @param {string} key - The cache key
   * @returns {Promise<number>} Number of keys deleted (0 or 1)
   */
  async del(key) {
    const node = this.ring.getNode(key);
    if (!node) throw new Error('No nodes available');

    const raw = await this.pool.send(node, `DEL ${key}\r\n`);
    return parseResponse(raw);
  }

  /**
   * Send a PING to a specific node or the first configured node.
   *
   * Useful for health checks and connectivity verification.
   *
   * @param {string} [nodeAddress] - Specific node to ping; defaults to first configured node
   * @returns {Promise<string>} 'PONG' on success
   */
  async ping(nodeAddress) {
    const target = nodeAddress || this.nodes[0];
    const raw = await this.pool.send(target, 'PING\r\n');
    return parseResponse(raw);
  }

  /**
   * Get the health status of a specific node.
   *
   * @param {string} nodeAddress - The node to check
   * @returns {string} 'healthy', 'suspect', or 'down'
   */
  getNodeStatus(nodeAddress) {
    if (!this.healthChecker) return 'healthy'; // No health checking → assume healthy
    return this.healthChecker.getNodeStatus(nodeAddress);
  }

  /**
   * Get health statuses for all nodes.
   *
   * @returns {Map<string, string>} nodeAddress → 'healthy' | 'suspect' | 'down'
   */
  getAllNodeStatuses() {
    if (!this.healthChecker) {
      const result = new Map();
      for (const node of this.nodes) {
        result.set(node, 'healthy');
      }
      return result;
    }
    return this.healthChecker.getAllNodeStatuses();
  }

  /**
   * Close all connections to the cluster and stop health checking.
   *
   * Must be called when the client is no longer needed to avoid
   * leaking TCP sockets. After close(), the client should not be reused.
   */
  async close() {
    if (this.healthChecker) {
      this.healthChecker.stop();
    }
    await this.pool.close();
  }
}

// Export the response parser for testing
export { parseResponse };
