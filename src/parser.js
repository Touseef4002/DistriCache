/**
 * parser.js — Wire protocol parser for DistriCache.
 *
 * WHAT THIS MODULE DOES
 * ═════════════════════
 * Converts raw bytes from a TCP socket into structured command objects:
 *   Raw TCP data:  'SET user:1 "hello world" EX 60\r\n'
 *   Parsed output: { command: 'SET', args: ['user:1', 'hello world', 'EX', '60'] }
 *
 * WHY IS THIS HARDER THAN IT LOOKS?
 * ──────────────────────────────────
 * TCP is a *stream* protocol, not a *message* protocol. This means:
 *
 *   1. PARTIAL READS: A single `data` event might contain half a command
 *      ("SET us") — we need to buffer and wait for the \r\n terminator.
 *
 *   2. MULTIPLE COMMANDS: A single `data` event might contain multiple
 *      commands ("PING\r\nGET key\r\n") — we need to split and handle each.
 *
 *   3. SPLIT ACROSS EVENTS: A command might arrive as "SET ke" in one event
 *      and "y val\r\n" in the next — the buffer accumulates across events.
 *
 * This is a fundamental TCP concept that every protocol parser must handle.
 * HTTP servers, Redis servers, and database drivers all solve this same problem.
 * The solution is a per-connection buffer that accumulates data until a
 * complete message delimiter (\r\n) is found.
 *
 * QUOTED STRING HANDLING
 * ──────────────────────
 * Space-delimited arguments are simple until a value contains a space:
 *   SET key "hello world"  → args should be ['key', 'hello world'], not ['key', '"hello', 'world"']
 *
 * We handle this with a state machine that tracks whether we're inside quotes.
 * This is the same approach as shell argument parsing (simplified — no escape sequences in v1).
 *
 * PROTOCOL SPEC (from ARCHITECTURE.md §3):
 *   Request:  COMMAND arg1 arg2 ... argN\r\n
 *   Commands are case-insensitive (normalized to uppercase).
 *   Arguments are space-delimited, with double-quote support for spaces in values.
 */

/**
 * Creates a stateful parser for a single TCP connection.
 *
 * Each connection gets its own parser instance because each connection
 * has its own buffer (partial data from previous `data` events).
 * This is a closure-based factory — lighter weight than a class for
 * a simple state container.
 *
 * @returns {{ parse: (data: Buffer|string) => Array<{command: string, args: string[]}> }}
 */
export function createParser() {
  // Per-connection buffer for accumulating partial data.
  // This is the key to handling TCP's stream semantics correctly.
  let buffer = '';

  /**
   * Feed raw TCP data into the parser.
   *
   * Returns an array of parsed commands (0 if no complete line yet,
   * 1 for a single command, N if multiple commands arrived in one chunk).
   *
   * @param {Buffer|string} data - Raw data from the TCP socket's `data` event
   * @returns {Array<{command: string, args: string[]}>} - Parsed commands (may be empty)
   */
  function parse(data) {
    buffer += data.toString();

    const commands = [];
    let delimiterIndex;

    // Process all complete lines in the buffer.
    // Each \r\n marks the end of one command.
    while ((delimiterIndex = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, delimiterIndex);
      buffer = buffer.slice(delimiterIndex + 2); // Skip past \r\n

      if (line.length === 0) continue; // Ignore empty lines

      const parsed = parseLine(line);
      if (parsed) {
        commands.push(parsed);
      }
    }

    return commands;
  }

  return { parse };
}

/**
 * Parse a single protocol line into { command, args }.
 *
 * Examples:
 *   'PING'                    → { command: 'PING', args: [] }
 *   'SET key value'           → { command: 'SET', args: ['key', 'value'] }
 *   'SET key "hello world"'   → { command: 'SET', args: ['key', 'hello world'] }
 *   'set Key Value'           → { command: 'SET', args: ['Key', 'Value'] }
 *
 * Note: command is uppercased, but args preserve original casing
 * (keys and values are case-sensitive).
 *
 * @param {string} line - A single protocol line (without the \r\n terminator)
 * @returns {{ command: string, args: string[] } | null}
 */
export function parseLine(line) {
  const tokens = tokenize(line);
  if (tokens.length === 0) return null;

  return {
    command: tokens[0].toUpperCase(), // Commands are case-insensitive
    args: tokens.slice(1),            // Args preserve original casing
  };
}

/**
 * Tokenize a line into space-separated tokens, respecting double-quoted strings.
 *
 * This is a small state machine with two states:
 *   - NORMAL: characters are added to the current token; spaces delimit tokens
 *   - IN_QUOTES: characters (including spaces) are added until the closing quote
 *
 * WHY A STATE MACHINE?
 * A regex-based approach (e.g., matching quoted and unquoted groups) would also
 * work, but a state machine is:
 *   - Easier to extend (escape sequences, single quotes, etc.)
 *   - More explicit about edge cases
 *   - The standard approach in real protocol parsers
 *
 * @param {string} line - The raw input line
 * @returns {string[]} - Array of tokens
 */
export function tokenize(line) {
  const tokens = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      // Toggle quote state. The quote character itself is NOT included
      // in the token — it's a delimiter, not content.
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      // Space outside quotes = token boundary
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      // Regular character — accumulate into current token
      current += char;
    }
  }

  // Don't forget the last token (line doesn't end with a space)
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
