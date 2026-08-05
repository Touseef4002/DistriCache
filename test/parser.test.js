/**
 * parser.test.js — Unit tests for the wire protocol parser.
 *
 * Tests the parser at two levels:
 *   1. tokenize() — low-level tokenization (quoted strings, spaces)
 *   2. createParser().parse() — full stream parsing (buffering, \r\n framing)
 *
 * The parser must handle TCP stream semantics correctly:
 *   - Partial data (no \r\n yet → buffer and return [])
 *   - Multiple commands in one chunk
 *   - Split commands across multiple chunks
 */

import { describe, test, expect } from '@jest/globals';
import { createParser, parseLine, tokenize } from '../src/parser.js';

describe('tokenize', () => {
  test('splits simple space-separated tokens', () => {
    expect(tokenize('SET key value')).toEqual(['SET', 'key', 'value']);
  });

  test('handles double-quoted strings (preserves spaces inside quotes)', () => {
    expect(tokenize('SET key "hello world"')).toEqual(['SET', 'key', 'hello world']);
  });

  test('handles quoted string in the middle', () => {
    expect(tokenize('SET "my key" value')).toEqual(['SET', 'my key', 'value']);
  });

  test('handles multiple quoted strings', () => {
    expect(tokenize('"key one" "value two"')).toEqual(['key one', 'value two']);
  });

  test('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  test('handles multiple consecutive spaces', () => {
    expect(tokenize('SET  key   value')).toEqual(['SET', 'key', 'value']);
  });

  test('single token (no spaces)', () => {
    expect(tokenize('PING')).toEqual(['PING']);
  });

  test('leading and trailing spaces', () => {
    expect(tokenize('  SET key value  ')).toEqual(['SET', 'key', 'value']);
  });
});

describe('parseLine', () => {
  test('parses a simple command', () => {
    expect(parseLine('PING')).toEqual({ command: 'PING', args: [] });
  });

  test('uppercases the command name', () => {
    expect(parseLine('ping')).toEqual({ command: 'PING', args: [] });
    expect(parseLine('Set key val')).toEqual({ command: 'SET', args: ['key', 'val'] });
  });

  test('preserves argument casing', () => {
    const result = parseLine('SET MyKey MyValue');
    expect(result.args).toEqual(['MyKey', 'MyValue']);
  });

  test('parses SET with EX', () => {
    expect(parseLine('SET user:1 "alice" EX 60')).toEqual({
      command: 'SET',
      args: ['user:1', 'alice', 'EX', '60'],
    });
  });

  test('returns null for empty line', () => {
    expect(parseLine('')).toBeNull();
  });

  test('returns null for whitespace-only line', () => {
    expect(parseLine('   ')).toBeNull();
  });
});

describe('createParser', () => {
  test('parses a complete command in one chunk', () => {
    const parser = createParser();
    const commands = parser.parse('PING\r\n');

    expect(commands).toEqual([{ command: 'PING', args: [] }]);
  });

  test('buffers partial data until \\r\\n is received', () => {
    const parser = createParser();

    // First chunk — incomplete (no \r\n)
    let commands = parser.parse('SET ke');
    expect(commands).toEqual([]);

    // Second chunk — completes the line
    commands = parser.parse('y value\r\n');
    expect(commands).toEqual([{ command: 'SET', args: ['key', 'value'] }]);
  });

  test('handles multiple commands in a single chunk', () => {
    const parser = createParser();
    const commands = parser.parse('PING\r\nGET key\r\n');

    expect(commands).toEqual([
      { command: 'PING', args: [] },
      { command: 'GET', args: ['key'] },
    ]);
  });

  test('handles multiple commands split across chunks', () => {
    const parser = createParser();

    let commands = parser.parse('PING\r\nSET k');
    expect(commands).toEqual([{ command: 'PING', args: [] }]);

    commands = parser.parse('ey val\r\n');
    expect(commands).toEqual([{ command: 'SET', args: ['key', 'val'] }]);
  });

  test('skips empty lines', () => {
    const parser = createParser();
    const commands = parser.parse('\r\n\r\nPING\r\n');

    expect(commands).toEqual([{ command: 'PING', args: [] }]);
  });

  test('handles Buffer input (simulating real TCP data event)', () => {
    const parser = createParser();
    const commands = parser.parse(Buffer.from('PING\r\n'));

    expect(commands).toEqual([{ command: 'PING', args: [] }]);
  });

  test('each parser instance has its own buffer', () => {
    const parser1 = createParser();
    const parser2 = createParser();

    parser1.parse('SET k');
    const commands2 = parser2.parse('PING\r\n');

    // parser2 should not be affected by parser1's buffered data
    expect(commands2).toEqual([{ command: 'PING', args: [] }]);

    // parser1 should still have its buffered data
    const commands1 = parser1.parse('ey val\r\n');
    expect(commands1).toEqual([{ command: 'SET', args: ['key', 'val'] }]);
  });

  test('handles quoted strings across the protocol', () => {
    const parser = createParser();
    const commands = parser.parse('SET user:1 "hello world" EX 60\r\n');

    expect(commands).toEqual([{
      command: 'SET',
      args: ['user:1', 'hello world', 'EX', '60'],
    }]);
  });

  test('case insensitivity — mixed case commands are normalized', () => {
    const parser = createParser();
    const commands = parser.parse('pInG\r\nset KEY val\r\n');

    expect(commands).toEqual([
      { command: 'PING', args: [] },
      { command: 'SET', args: ['KEY', 'val'] },
    ]);
  });
});
