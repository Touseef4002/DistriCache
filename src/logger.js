/**
 * logger.js — Structured logger for DistriCache nodes.
 *
 * WHY A CUSTOM LOGGER INSTEAD OF console.log?
 * ─────────────────────────────────────────────
 * In a multi-node distributed system, every log line needs context:
 *   - Which node emitted it (NODE_ID prefix)
 *   - What severity level it is (so operators can filter noise)
 *   - A consistent format (so logs are grep-able and parseable)
 *
 * This is the same motivation behind structured logging in production systems
 * (e.g., Winston, Bunyan, Pino in Node.js; logrus, zap in Go).
 * We build a minimal version from scratch to keep zero dependencies.
 *
 * LOG LEVELS (lowest to highest severity):
 *   debug → info → warn → error
 *
 * Setting LOG_LEVEL=warn means only warn and error messages are printed.
 * This is a standard log-level filtering pattern used in virtually every
 * production logging framework.
 *
 * DESIGN DECISIONS:
 * - ISO timestamp for machine-parseable logs
 * - NODE_ID from environment for multi-node identification
 * - Singleton-style: each import gets the same configured logger
 * - No file output in v1 — stdout only (12-factor app principle:
 *   treat logs as event streams, let the runtime route them)
 */

// Numeric levels for comparison — lower number = more verbose.
// This pattern lets us do a simple numeric comparison to decide
// whether a message should be emitted at the current log level.
const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Creates a logger instance configured from environment variables.
 *
 * @param {object} [options]
 * @param {string} [options.nodeId]   - Identifier for this node (default: NODE_ID env or 'node')
 * @param {string} [options.level]    - Minimum log level (default: LOG_LEVEL env or 'info')
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export function createLogger(options = {}) {
  const nodeId = options.nodeId || process.env.NODE_ID || 'node';
  const levelName = (options.level || process.env.LOG_LEVEL || 'info').toLowerCase();
  const minLevel = LEVELS[levelName] ?? LEVELS.info;

  /**
   * Emit a log line if the message's level meets the minimum threshold.
   *
   * Format: [ISO timestamp] [LEVEL] [node-id] message
   *
   * This format is deliberately simple and grep-friendly:
   *   grep "\[ERROR\]" logs.txt   → all errors
   *   grep "\[node-a\]" logs.txt  → all logs from node-a
   */
  function log(level, ...args) {
    if (LEVELS[level] < minLevel) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${nodeId}]`;

    // Route to the appropriate console method.
    // warn and error go to stderr (standard Unix convention),
    // everything else goes to stdout.
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
