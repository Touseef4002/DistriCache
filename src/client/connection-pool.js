/**
 * connection-pool.js — TCP connection pool for DistriCache client.
 *
 * WHY POOL CONNECTIONS?
 * ═════════════════════
 * Every TCP connection starts with a 3-way handshake (SYN → SYN-ACK → ACK).
 * For a cache that may handle thousands of ops/sec, creating a new connection
 * per request would add a round-trip of latency to every single operation.
 *
 * A connection pool maintains persistent connections — one per cache node —
 * and reuses them across requests. The handshake cost is paid once, and all
 * subsequent requests on that connection skip it entirely.
 *
 * This is the same pattern used by:
 *   - Database connection pools (pg-pool, HikariCP)
 *   - HTTP keep-alive / HTTP/2 connection reuse
 *   - Redis client libraries (ioredis, node-redis)
 *
 * LAZY CREATION
 * ─────────────
 * Connections are created on first use, not at construction time. This avoids:
 *   - Connecting to nodes that might not be needed during short-lived sessions
 *   - Startup failures if a node is temporarily down when the client is created
 *
 * REQUEST/RESPONSE CORRELATION
 * ────────────────────────────
 * TCP is a stream protocol — there's no built-in concept of "this response
 * belongs to that request." Our wire protocol uses a simple solution:
 * requests and responses are 1:1 and in order (no pipelining in v1).
 *
 * We use a FIFO promise queue per connection: each send() pushes a resolver
 * onto the queue, and when a complete response arrives, it resolves the
 * front-of-queue promise. This serializes requests per-connection, which
 * is correct for our single-command protocol.
 *
 * RESPONSE PARSING
 * ────────────────
 * The pool needs to understand the wire protocol response format enough to
 * know when a complete response has arrived (since TCP may deliver partial
 * data). It handles all 5 response types from ARCHITECTURE.md §3.2:
 *
 *   +OK\r\n          → simple string (read until \r\n)
 *   -ERR msg\r\n     → error (read until \r\n)
 *   :42\r\n          → integer (read until \r\n)
 *   $-1\r\n          → null (read until \r\n)
 *   $5\r\nalice\r\n  → bulk string (read length, then read that many bytes + \r\n)
 */

import net from 'node:net';

/**
 * Parse the address string "host:port" into its components.
 * @param {string} address - e.g., "localhost:7000"
 * @returns {{ host: string, port: number }}
 */
function parseAddress(address) {
  const lastColon = address.lastIndexOf(':');
  return {
    host: address.slice(0, lastColon),
    port: parseInt(address.slice(lastColon + 1), 10),
  };
}

/**
 * A single managed TCP connection with response framing.
 *
 * Handles the complexity of:
 *   - TCP stream buffering (partial reads)
 *   - Wire protocol response parsing (knowing when a response is complete)
 *   - Promise-based request/response correlation
 *
 * @param {string} host - The hostname to connect to
 * @param {number} port - The port to connect to
 * @returns {object} Connection handle with send() and close() methods
 */
function createConnection(host, port) {
  const socket = new net.Socket();
  let buffer = '';
  let connected = false;
  let destroyed = false;

  /**
   * Queue of pending request resolvers.
   * Each send() pushes { resolve, reject } onto this queue.
   * When a complete response is parsed, the front entry is shifted and resolved.
   * @type {Array<{resolve: Function, reject: Function}>}
   */
  const pending = [];

  /**
   * Connect to the server. Returns a promise that resolves when connected.
   * @returns {Promise<void>}
   */
  function connect() {
    return new Promise((resolve, reject) => {
      if (destroyed) {
        reject(new Error('Connection has been destroyed'));
        return;
      }

      socket.connect(port, host, () => {
        connected = true;
        resolve();
      });

      socket.once('error', (err) => {
        if (!connected) {
          reject(err);
        }
      });
    });
  }

  // ─── TCP stream handling ─────────────────────────────────────────
  // When data arrives, we accumulate it in a buffer and try to parse
  // complete responses. A response may arrive in fragments across
  // multiple 'data' events — the buffer handles this.

  socket.on('data', (data) => {
    buffer += data.toString();
    drainBuffer();
  });

  socket.on('error', (err) => {
    // Reject all pending requests when the connection errors out.
    // This surfaces the error to the caller instead of leaving
    // promises hanging forever.
    while (pending.length > 0) {
      const { reject } = pending.shift();
      reject(err);
    }
  });

  socket.on('close', () => {
    connected = false;
    // Reject any remaining pending requests
    while (pending.length > 0) {
      const { reject } = pending.shift();
      reject(new Error('Connection closed'));
    }
  });

  /**
   * Try to parse and deliver complete responses from the buffer.
   *
   * This is the core protocol parsing logic. It identifies the response
   * type from the first character and reads accordingly:
   *
   *   '+', '-', ':' → single-line: read until \r\n
   *   '$'           → bulk: read length line, then read that many bytes + \r\n
   *                   Special case: $-1\r\n is null (no payload line)
   */
  function drainBuffer() {
    while (pending.length > 0 && buffer.length > 0) {
      const firstChar = buffer[0];

      if (firstChar === '+' || firstChar === '-' || firstChar === ':') {
        // ─── Single-line response ────────────────────────────────
        // Format: <prefix><content>\r\n
        const end = buffer.indexOf('\r\n');
        if (end === -1) return; // Incomplete — wait for more data

        const line = buffer.slice(0, end + 2); // Include \r\n
        buffer = buffer.slice(end + 2);

        const { resolve } = pending.shift();
        resolve(line);

      } else if (firstChar === '$') {
        // ─── Bulk string response ────────────────────────────────
        // Format: $<length>\r\n<data>\r\n  OR  $-1\r\n (null)
        const headerEnd = buffer.indexOf('\r\n');
        if (headerEnd === -1) return; // Incomplete header

        const lengthStr = buffer.slice(1, headerEnd);
        const length = parseInt(lengthStr, 10);

        if (length === -1) {
          // Null bulk string: $-1\r\n (no payload)
          const line = buffer.slice(0, headerEnd + 2);
          buffer = buffer.slice(headerEnd + 2);

          const { resolve } = pending.shift();
          resolve(line);
        } else {
          // Bulk string: $<len>\r\n<data>\r\n
          // Total bytes needed after header: <data> (length bytes) + \r\n (2 bytes)
          const payloadStart = headerEnd + 2;
          const totalNeeded = payloadStart + length + 2;

          if (buffer.length < totalNeeded) return; // Incomplete payload

          const fullResponse = buffer.slice(0, totalNeeded);
          buffer = buffer.slice(totalNeeded);

          const { resolve } = pending.shift();
          resolve(fullResponse);
        }
      } else {
        // Unknown response type — this shouldn't happen with a well-behaved server.
        // Reject the current request to surface the issue instead of hanging.
        const { reject } = pending.shift();
        reject(new Error(`Unknown response type: ${firstChar}`));
        // Try to recover by clearing to the next \r\n
        const end = buffer.indexOf('\r\n');
        if (end !== -1) {
          buffer = buffer.slice(end + 2);
        } else {
          buffer = '';
        }
      }
    }
  }

  return {
    connect,

    /**
     * Send a raw command string and return the raw response.
     *
     * The command MUST already include the \r\n terminator.
     *
     * @param {string} rawCommand - e.g., "SET key value\r\n"
     * @returns {Promise<string>} The raw response string, e.g., "+OK\r\n"
     */
    send(rawCommand) {
      return new Promise((resolve, reject) => {
        if (destroyed || !connected) {
          reject(new Error('Connection not available'));
          return;
        }

        pending.push({ resolve, reject });
        socket.write(rawCommand);
      });
    },

    /**
     * Close the connection gracefully.
     */
    close() {
      destroyed = true;
      connected = false;
      socket.destroy();
    },

    /** @returns {boolean} Whether the connection is currently connected */
    get isConnected() { return connected && !destroyed; },
  };
}

export class ConnectionPool {
  /**
   * Create a connection pool.
   *
   * @param {object} [options]
   * @param {number} [options.connectTimeout=5000] - Timeout for connecting to a node (ms)
   */
  constructor(options = {}) {
    this.connectTimeout = options.connectTimeout ?? 5000;

    /**
     * Map of nodeAddress → connection handle.
     * Connections are lazily created on first send().
     * @type {Map<string, object>}
     */
    this.connections = new Map();
  }

  /**
   * Get or create a connection to a node.
   *
   * LAZY CREATION: The first time a node address is used, a TCP connection
   * is established. Subsequent calls reuse the existing connection.
   *
   * RECONNECTION: If the existing connection is dead (socket closed/errored),
   * it's replaced with a new one. This provides basic resilience without
   * complex retry logic.
   *
   * @param {string} nodeAddress - e.g., "localhost:7000"
   * @returns {Promise<object>} The connection handle
   */
  async _getConnection(nodeAddress) {
    const existing = this.connections.get(nodeAddress);
    if (existing && existing.isConnected) {
      return existing;
    }

    // Connection doesn't exist or is dead — create a new one
    const { host, port } = parseAddress(nodeAddress);
    const conn = createConnection(host, port);

    // Connect with a timeout to avoid hanging on unreachable nodes
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Connection to ${nodeAddress} timed out`)), this.connectTimeout);
    });

    await Promise.race([conn.connect(), timeoutPromise]);

    this.connections.set(nodeAddress, conn);
    return conn;
  }

  /**
   * Send a command to a specific node and return the raw response.
   *
   * @param {string} nodeAddress - Target node, e.g., "localhost:7000"
   * @param {string} rawCommand - Wire protocol command with \r\n terminator
   * @returns {Promise<string>} Raw response string from the server
   */
  async send(nodeAddress, rawCommand) {
    const conn = await this._getConnection(nodeAddress);
    return conn.send(rawCommand);
  }

  /**
   * Close all connections in the pool.
   *
   * Should be called when the client is done with the cluster
   * to avoid leaking TCP sockets.
   */
  async close() {
    for (const [, conn] of this.connections) {
      conn.close();
    }
    this.connections.clear();
  }
}
