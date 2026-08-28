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
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createParser } from './parser.js';
import { Store } from './store.js';
import { createLogger } from './logger.js';
import { createSweeper } from './sweeper.js';

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
  PING(_args, _store, _ctx) {
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
  SET(args, cacheStore, _ctx) {
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
  GET(args, cacheStore, _ctx) {
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
  DEL(args, cacheStore, _ctx) {
    if (args.length < 1) {
      return errorString('wrong number of arguments for DEL');
    }

    const count = cacheStore.del(args[0]);
    return integerReply(count);
  },

  /**
   * EXPIRE key seconds
   *
   * Sets or updates the TTL on an existing key (FR-10, P2).
   * Returns :1 if the key exists and the TTL was set, :0 if the key doesn't exist.
   *
   * This is separate from SET's EX option because it allows setting/changing
   * TTL on a key AFTER it was stored — useful when the expiry decision is
   * made separately from the write.
   *
   * Matches Redis EXPIRE semantics.
   */
  EXPIRE(args, cacheStore, _ctx) {
    if (args.length < 2) {
      return errorString('wrong number of arguments for EXPIRE');
    }

    const [key, secondsStr] = args;
    const seconds = parseInt(secondsStr, 10);

    if (isNaN(seconds) || seconds <= 0) {
      return errorString('invalid expire time in EXPIRE');
    }

    const result = cacheStore.setExpiry(key, seconds);
    return integerReply(result);
  },

  /**
   * INFO — Server statistics (FR-11, P2).
   *
   * Returns a multi-line bulk string with server stats, grouped into sections.
   * Format matches ARCHITECTURE.md §13.2:
   *
   *   # Server
   *   node_id: node-a
   *   uptime_seconds: 3600
   *   port: 7000
   *
   *   # Stats
   *   keys: 8542
   *   ...
   *
   * WHY A BULK STRING INSTEAD OF MULTIPLE SIMPLE STRINGS?
   * Multi-line output needs to be sent as a single response so the client's
   * response parser can treat it as one unit. A bulk string with $<len>\r\n
   * is the natural fit — the length prefix tells the client exactly how
   * many bytes to read, even though the content contains \r\n sequences.
   */
  INFO(_args, cacheStore, ctx) {
    const uptimeSeconds = Math.floor((Date.now() - ctx.startTime) / 1000);

    const lines = [
      '# Server',
      `node_id: ${ctx.nodeId}`,
      `uptime_seconds: ${uptimeSeconds}`,
      `port: ${ctx.port}`,
      '',
      '# Stats',
      `keys: ${cacheStore.size()}`,
      `expired_keys: ${cacheStore.stats.expiredKeys}`,
      `evicted_keys: ${cacheStore.stats.evictions}`,
      `total_commands: ${ctx.totalCommands}`,
      `connections_active: ${ctx.activeConnections}`,
      '',
      '# Memory',
      `max_entries: ${cacheStore.maxEntries}`,
    ];

    const body = lines.join('\r\n');
    return bulkString(body);
  },
};

// ─── Server Factory ──────────────────────────────────────────────────

/**
 * Create a DistriCache server instance with explicit configuration.
 *
 * WHY A FACTORY FUNCTION?
 * ───────────────────────
 * The original `startServer()` read config from env vars and auto-started
 * on import. That works for `node src/server.js` but makes integration
 * testing impossible — you can't start 3 servers on different ports
 * from the same test process.
 *
 * This factory accepts explicit options, returns an object with `start()`
 * and `close()` methods, and exposes the underlying store for inspection.
 * The old auto-start behavior is preserved at the bottom of this file
 * behind an `isMainModule` guard.
 *
 * @param {object} [options]
 * @param {number} [options.port=7000]          - TCP port to listen on
 * @param {string} [options.nodeId]             - Node identifier for logging
 * @param {number} [options.maxEntries=10000]   - LRU cache capacity
 * @returns {{ start: () => Promise<void>, close: () => Promise<void>, store: Store, server: net.Server }}
 */
export function createCacheServer(options = {}) {
  const port = options.port ?? (parseInt(process.env.PORT, 10) || 7000);
  const nodeId = options.nodeId ?? process.env.NODE_ID ?? `node-${port}`;
  const maxEntries = options.maxEntries ?? (process.env.MAX_ENTRIES ? parseInt(process.env.MAX_ENTRIES, 10) : 10000);

  const log = createLogger({ nodeId, level: options.logLevel });
  const store = new Store({ maxEntries });
  const startTime = Date.now();

  // ─── Counters for INFO command ──────────────────────────────────
  // These are tracked at the server level (not in the store) because
  // they're network-layer stats, not storage-layer stats.
  let activeConnections = 0;
  let totalCommands = 0;

  // Context object passed to command handlers that need server-level info
  // (currently only INFO uses it, but the pattern is extensible).
  const ctx = { nodeId, port, startTime, get activeConnections() { return activeConnections; }, get totalCommands() { return totalCommands; } };

  const server = net.createServer((socket) => {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    log.info(`client connected: ${remoteAddr}`);
    activeConnections++;

    // Each connection gets its own parser for TCP stream buffering
    const parser = createParser();

    socket.on('data', (data) => {
      const commands = parser.parse(data);

      for (const { command, args } of commands) {
        log.debug(`${command} ${args.join(' ')}`);
        totalCommands++;

        const handler = COMMANDS[command];

        if (!handler) {
          socket.write(errorString(`unknown command '${command}'`));
          continue;
        }

        const response = handler(args, store, ctx);
        socket.write(response);
      }
    });

    socket.on('error', (err) => {
      if (err.code === 'ECONNRESET') {
        log.debug(`client reset connection: ${remoteAddr}`);
      } else {
        log.error(`socket error (${remoteAddr}):`, err.message);
      }
    });

    socket.on('close', () => {
      activeConnections--;
      log.info(`client disconnected: ${remoteAddr}`);
    });
  });

  // ─── Start active expiry sweeper ──────────────────────────────────
  const sweeper = createSweeper(store, { logger: log });

  return {
    store,
    server,

    /**
     * Start listening on the configured port.
     * Returns a promise that resolves once the server is listening.
     */
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.removeListener('error', reject);
          log.info(`DistriCache node "${nodeId}" listening on port ${port}`);
          log.info(`capacity: ${store.maxEntries} entries (LRU eviction)`);
          resolve();
        });
      });
    },

    /**
     * Gracefully close the server and stop the sweeper.
     * Returns a promise that resolves once the server is fully closed.
     */
    close() {
      return new Promise((resolve) => {
        sweeper.stop();
        server.close(() => {
          log.info('server closed');
          resolve();
        });
        // Destroy any remaining open connections so close() doesn't hang.
        // Without this, the server waits for all clients to disconnect,
        // which can stall test teardown indefinitely.
        server.unref();
      });
    },
  };
}

// ─── Auto-start when run directly ────────────────────────────────────
// This guard ensures that `node src/server.js` still auto-starts,
// but importing this module from a test doesn't.
//
// We compare the file URL of this module against the process entry point.
// `import.meta.url` gives us `file:///path/to/server.js`.
// `process.argv[1]` gives us the OS path that was passed to `node`.
const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const instance = createCacheServer();
  instance.start();

  // ─── Graceful shutdown ──────────────────────────────────────────
  // Handle SIGTERM/SIGINT for clean Docker container stops.
  function shutdown(signal) {
    console.log(`received ${signal}, shutting down...`);
    instance.close().then(() => process.exit(0));
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { COMMANDS };
