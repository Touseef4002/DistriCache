export function createParser() {
  let buffer = '';

  /**
   * @param {Buffer|string} data
   * @returns {Array<{command: string, args: string[]}>}
   */
  function parse(data) {
    buffer += data.toString();

    const commands = [];
    let idx;

    while ((idx = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      if (line.length === 0) continue;

      const parsed = parseLine(line);
      if (parsed) commands.push(parsed);
    }

    return commands;
  }

  return { parse };
}

/**
 * @param {string} line
 * @returns {{ command: string, args: string[] } | null}
 */
export function parseLine(line) {
  const tokens = tokenize(line);
  if (tokens.length === 0) return null;
  return { command: tokens[0].toUpperCase(), args: tokens.slice(1) };
}

/**
 * Tokenize a line into space-separated tokens, respecting double-quoted strings.
 * @param {string} line
 * @returns {string[]}
 */
export function tokenize(line) {
  const tokens = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}
