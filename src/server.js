/**
 * server.js — TCP server entry point for a DistriCache node.
 *
 * WHAT THIS MODULE DOES
 * ═════════════════════
 * This is the main process for a single cache node. It:
 *   1. Listens for TCP connections on a configurable port
 *   2. Creates a per-connection parser to handle TCP stream framing
 *   3. Dispatches parsed commands to the in-memory Store
 *   4. Formats responses according to the wire protocol (ARCHITECTURE.md §3.2)
 *   5. Sends responses back over the TCP socket
 *
 * WHY RAW TCP INSTEAD OF HTTP?
 * ────────────────────────────
 * HTTP adds overhead that a cache doesn't need:
 *   - Request/response headers (Content-Type, Accept, etc.) — irrelevant for a cache
 *   - HTTP parsing complexity — we only need simple line-based commands
 *   - Connection semantics — HTTP/1.1 keep-alive is basically just "use TCP directly"
 *
 * Raw TCP with a custom text protocol gives us:
 *   - Minimal latency (no header parsing overhead)
 *   - Direct control over the protocol design (a learning goal)
 *   - Testability via telnet/nc (the whole point of choosing text over binary)
 *
 * This is the same architectural choice Redis makes (and memcached, and most
 * high-performance caches). It's a deliberate trade-off: we lose HTTP's
 * ecosystem (browsers, Postman, REST conventions) but gain simplicity and speed
 * where they matter most for a cache.
 *
 * RESPONSE FORMAT (from ARCHITECTURE.md §3.2):
 *   +OK\r\n               — Simple string (success)
 *   -ERR message\r\n       — Error
 *   $<len>\r\n<value>\r\n  — Bulk string (GET hit)
 *   $-1\r\n                — Null (GET miss)
 *   :<integer>\r\n         — Integer (DEL count)
 */

import net from 'node:net';
import { createParser } from './parser.js';
import { Store } from './store.js';
import { createLogger } from './logger.js';
import { createSweeper } from './sweeper.js';

// ─── Configuration from environment ───────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 7000;
const NODE_ID = process.env.NODE_ID || `node-${PORT}`;

// ─── Initialize core components ───────────────────────────────────────
const log = createLogger({ nodeId: NODE_ID });
const store = new Store();

// Track server start time for INFO command (Phase 4)
const startTime = Date.now();

// ─── Response formatting helpers ──────────────────────────────────────

/**
 * Format a simple string response: +<message>\r\n
 * Used for SET success, PING response, etc.
 */
function simpleString(msg) {
  return `+${msg}\r\n`;
}

/**
 * Format an error response: -ERR <message>\r\n
 * Used for unknown commands, wrong argument counts, etc.
 */
function errorString(msg) {
  return `-ERR ${msg}\r\n`;
}

/**
 * Format a bulk string response: $<len>\r\n<value>\r\n
 * Used for GET hits. The length prefix allows the client to know
 * exactly how many bytes to read for the value, even if the value
 * contains \r\n (though in our text protocol, values won't).
 */
function bulkString(value) {
  return `$${value.length}\r\n${value}\r\n`;
}

/**
 * Format a null bulk string: $-1\r\n
 * Used for GET misses. The -1 length is a sentinel value meaning "no data".
 * This is directly inspired by Redis's RESP protocol.
 */
function nullBulk() {
  return '$-1\r\n';
}

/**
 * Format an integer response: :<integer>\r\n
 * Used for DEL (returns count of deleted keys).
 */
function integerReply(n) {
  return `:${n}\r\n`;
}

// ─── Command handlers ────────────────────────────────────────────────

/**
 * Command dispatch table.
 *
 * Using a dispatch table (object lookup) instead of if/else chains because:
 *   - O(1) dispatch vs O(n) for if/else
 *   - Easy to extend: adding a new command = adding one property
 *   - Each handler is isolated and independently testable
 *   - This is the standard pattern in protocol servers (Redis, HTTP servers, etc.)
 */
const COMMANDS = {
  /**
   * PING — Health check / connectivity test.
   *
   * Used by the client's health checker (Phase 4) to detect if a node is alive.
   * Also useful for manual testing: `telnet localhost 7000` → `PING` → `+PONG`
   */
  PING(_args, _store) {
    return simpleString('PONG');
  },

  /**
   * SET key value [EX seconds]
   *
   * Stores a key-value pair. Optionally sets a TTL (EX = "expire in N seconds").
   * If the store is at capacity and the key is new, the LRU entry is evicted.
   * If EX is provided, the key will be lazily expired on GET and actively
   * swept by the background sweeper.
   *
   * Argument validation:
   *   - Requires at least 2 args (key and value)
   *   - EX requires a positive integer
   */
  SET(args, cacheStore) {
    if (args.length < 2) {
      return errorString('wrong number of arguments for SET');
    }

    const [key, value, ...rest] = args;

    // Parse optional EX argument
    let ttlSeconds = null;
    if (rest.length >= 2 && rest[0].toUpperCase() === 'EX') {
      ttlSeconds = parseInt(rest[1], 10);
      if (isNaN(ttlSeconds) || ttlSeconds <= 0) {
        return errorString('invalid expire time in SET');
      }
    }

    cacheStore.set(key, value, ttlSeconds);
    return simpleString('OK');
  },

  /**
   * GET key
   *
   * Retrieves the value for a key.
   *   - Hit: returns the value as a bulk string ($<len>\r\n<value>\r\n)
   *   - Miss: returns null bulk string ($-1\r\n)
   *
   * Lazy TTL expiry is handled inside store.get() — if the key exists
   * but is expired, it's deleted and null is returned.
   */
  GET(args, cacheStore) {
    if (args.length < 1) {
      return errorString('wrong number of arguments for GET');
    }

    const value = cacheStore.get(args[0]);

    if (value === null) {
      return nullBulk();
    }

    return bulkString(value);
  },

  /**
   * DEL key
   *
   * Removes a key from the store.
   * Returns an integer: 1 if the key was deleted, 0 if it didn't exist.
   *
   * This matches Redis semantics — the return value tells the caller
   * whether the key actually existed, which is useful for conditional logic.
   */
  DEL(args, cacheStore) {
    if (args.length < 1) {
      return errorString('wrong number of arguments for DEL');
    }

    const count = cacheStore.del(args[0]);
    return integerReply(count);
  },
};

// ─── TCP Server ──────────────────────────────────────────────────────

/**
 * Create and start the TCP server.
 *
 * Each incoming connection gets:
 *   - Its own parser instance (to handle TCP stream buffering per-connection)
 *   - Event handlers for data, error, and close
 *
 * The server is a standard Node.js `net.createServer()` — the built-in
 * TCP server. No frameworks, no dependencies.
 *
 * @returns {net.Server} The TCP server instance
 */
function startServer() {
  const server = net.createServer((socket) => {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    log.info(`client connected: ${remoteAddr}`);

    // Each connection gets its own parser for TCP stream buffering
    const parser = createParser();

    socket.on('data', (data) => {
      const commands = parser.parse(data);

      for (const { command, args } of commands) {
        log.debug(`${command} ${args.join(' ')}`);

        const handler = COMMANDS[command];

        if (!handler) {
          socket.write(errorString(`unknown command '${command}'`));
          continue;
        }

        const response = handler(args, store);
        socket.write(response);
      }
    });

    socket.on('error', (err) => {
      // Client disconnected abruptly (e.g., Ctrl+C in telnet).
      // ECONNRESET is normal for TCP — the client closed the connection
      // without sending a FIN. Not worth logging as an error.
      if (err.code === 'ECONNRESET') {
        log.debug(`client reset connection: ${remoteAddr}`);
      } else {
        log.error(`socket error (${remoteAddr}):`, err.message);
      }
    });

    socket.on('close', () => {
      log.info(`client disconnected: ${remoteAddr}`);
    });
  });

  server.listen(PORT, () => {
    log.info(`DistriCache node "${NODE_ID}" listening on port ${PORT}`);
    log.info(`capacity: ${store.maxEntries} entries (LRU eviction)`);
  });

  // ─── Start active expiry sweeper ──────────────────────────────────
  // The sweeper runs in the background, sampling random keys and deleting
  // expired ones. It complements lazy expiry (on GET) to prevent memory
  // leaks from expired keys that are never read again.
  const sweeper = createSweeper(store, { logger: log });

  // ─── Graceful shutdown ────────────────────────────────────────────
  // Handle SIGTERM/SIGINT for clean Docker container stops.
  // Without this, Docker would forcefully kill the process after a timeout.
  function shutdown(signal) {
    log.info(`received ${signal}, shutting down...`);
    sweeper.stop();
    server.close(() => {
      log.info('server closed');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// ─── Start the server ────────────────────────────────────────────────
const server = startServer();

export { startServer, store, COMMANDS };
