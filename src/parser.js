const MAX_COMMAND_LENGTH = 64 * 1024;

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
      if (idx > MAX_COMMAND_LENGTH) throw new RangeError('command exceeds 64 Ki characters');
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      if (line.length === 0) continue;

      const parsed = parseLine(line);
      if (parsed) commands.push(parsed);
    }

    if (buffer.length > MAX_COMMAND_LENGTH) throw new RangeError('command exceeds 64 Ki characters');

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
  let tokenStarted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '\\' && inQuotes && (line[i + 1] === '"' || line[i + 1] === '\\')) {
      current += line[++i];
      tokenStarted = true;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      tokenStarted = true;
    } else if (/\s/.test(char) && !inQuotes) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
    } else {
      current += char;
      tokenStarted = true;
    }
  }

  if (inQuotes) throw new SyntaxError('unterminated quoted string');
  if (tokenStarted) tokens.push(current);

  return tokens;
}
