import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createParser } from './parser.js';
import { Store } from './store.js';
import { createLogger } from './logger.js';
import { createSweeper } from './sweeper.js';

function simpleString(msg) { return `+${msg}\r\n`; }
function errorString(msg)  { return `-ERR ${msg}\r\n`; }
function bulkString(value) { return `$${value.length}\r\n${value}\r\n`; }
function nullBulk()        { return '$-1\r\n'; }
function integerReply(n)   { return `:${n}\r\n`; }

const COMMANDS = {
  PING() {
    return simpleString('PONG');
  },

  SET(args, store) {
    if (args.length < 2) return errorString('wrong number of arguments for SET');

    const [key, value, ...rest] = args;
    let ttlSeconds = null;

    if (rest.length >= 2 && rest[0].toUpperCase() === 'EX') {
      ttlSeconds = parseInt(rest[1], 10);
      if (isNaN(ttlSeconds) || ttlSeconds <= 0) {
        return errorString('invalid expire time in SET');
      }
    }

    store.set(key, value, ttlSeconds);
    return simpleString('OK');
  },

  GET(args, store) {
    if (args.length < 1) return errorString('wrong number of arguments for GET');
    const value = store.get(args[0]);
    return value === null ? nullBulk() : bulkString(value);
  },

  DEL(args, store) {
    if (args.length < 1) return errorString('wrong number of arguments for DEL');
    return integerReply(store.del(args[0]));
  },

  EXPIRE(args, store) {
    if (args.length < 2) return errorString('wrong number of arguments for EXPIRE');

    const seconds = parseInt(args[1], 10);
    if (isNaN(seconds) || seconds <= 0) {
      return errorString('invalid expire time in EXPIRE');
    }

    return integerReply(store.setExpiry(args[0], seconds));
  },

  INFO(_args, store, ctx) {
    const uptimeSeconds = Math.floor((Date.now() - ctx.startTime) / 1000);
    const body = [
      '# Server',
      `node_id: ${ctx.nodeId}`,
      `uptime_seconds: ${uptimeSeconds}`,
      `port: ${ctx.port}`,
      '',
      '# Stats',
      `keys: ${store.size()}`,
      `expired_keys: ${store.stats.expiredKeys}`,
      `evicted_keys: ${store.stats.evictions}`,
      `total_commands: ${ctx.totalCommands}`,
      `connections_active: ${ctx.activeConnections}`,
      '',
      '# Memory',
      `max_entries: ${store.maxEntries}`,
    ].join('\r\n');

    return bulkString(body);
  },
};

/**
 * @param {{ port?: number, nodeId?: string, maxEntries?: number, logLevel?: string }} [options]
 * @returns {{ start: () => Promise<void>, close: () => Promise<void>, store: Store, server: net.Server }}
 */
export function createCacheServer(options = {}) {
  const port = options.port ?? (parseInt(process.env.PORT, 10) || 7000);
  const nodeId = options.nodeId ?? process.env.NODE_ID ?? `node-${port}`;
  const maxEntries = options.maxEntries
    ?? (process.env.MAX_ENTRIES ? parseInt(process.env.MAX_ENTRIES, 10) : 10000);

  const log = createLogger({ nodeId, level: options.logLevel });
  const store = new Store({ maxEntries });
  const startTime = Date.now();

  let activeConnections = 0;
  let totalCommands = 0;

  const ctx = {
    nodeId,
    port,
    startTime,
    get activeConnections() { return activeConnections; },
    get totalCommands() { return totalCommands; },
  };

  const server = net.createServer((socket) => {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    log.info(`client connected: ${remoteAddr}`);
    activeConnections++;

    const parser = createParser();

    socket.on('data', (data) => {
      for (const { command, args } of parser.parse(data)) {
        log.debug(`${command} ${args.join(' ')}`);
        totalCommands++;

        const handler = COMMANDS[command];
        if (!handler) {
          socket.write(errorString(`unknown command '${command}'`));
          continue;
        }

        socket.write(handler(args, store, ctx));
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

  const sweeper = createSweeper(store, { logger: log });

  return {
    store,
    server,

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

    close() {
      return new Promise((resolve) => {
        sweeper.stop();
        server.close(() => {
          log.info('server closed');
          resolve();
        });
        server.unref();
      });
    },
  };
}

const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const instance = createCacheServer();
  instance.start();

  const shutdown = (signal) => {
    console.log(`received ${signal}, shutting down...`);
    instance.close().then(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { COMMANDS };
