const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/** @param {{ nodeId?: string, level?: string }} [options] */
export function createLogger(options = {}) {
  const nodeId = options.nodeId || process.env.NODE_ID || 'node';
  const levelName = (options.level || process.env.LOG_LEVEL || 'info').toLowerCase();
  const minLevel = LEVELS[levelName] ?? LEVELS.info;

  function log(level, ...args) {
    if (LEVELS[level] < minLevel) return;

    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${nodeId}]`;
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](prefix, ...args);
  }

  return {
    debug: (...args) => log('debug', ...args),
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args),
  };
}
