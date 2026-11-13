import { describe, test, expect } from '@jest/globals';
import { parsePositiveInteger } from '../src/positive-integer.js';
import { Store } from '../src/store.js';
import { COMMANDS } from '../src/server.js';

describe('positive integer validation', () => {
  test.each(['10abc', '1.5', '0', '-2', '9007199254740992'])('rejects %s', (input) => {
    expect(parsePositiveInteger(input)).toBeNull();
  });

  test('accepts positive safe decimal integers', () => {
    expect(parsePositiveInteger('42')).toBe(42);
  });

  test('rejects invalid cache capacity and direct TTL values', () => {
    expect(() => new Store({ maxEntries: '10abc' })).toThrow(RangeError);
    expect(() => new Store({ maxEntries: 0 })).toThrow(RangeError);

    const store = new Store({ maxEntries: 2 });
    expect(() => store.set('key', 'value', 1.5)).toThrow(RangeError);
    expect(() => store.setExpiry('key', 0)).toThrow(RangeError);
  });

  test('rejects an invalid MAX_ENTRIES environment value', () => {
    const previous = process.env.MAX_ENTRIES;
    process.env.MAX_ENTRIES = '10abc';
    try {
      expect(() => new Store()).toThrow(RangeError);
    } finally {
      if (previous === undefined) delete process.env.MAX_ENTRIES;
      else process.env.MAX_ENTRIES = previous;
    }
  });
});

describe('command argument validation', () => {
  test('SET rejects unsupported options, trailing arguments, and partial TTLs', () => {
    const store = new Store();
    for (const args of [
      ['key', 'value', 'NX'],
      ['key', 'value', 'EX', '10', 'extra'],
      ['key', 'value', 'EX'],
      ['key', 'value', 'EX', '10abc'],
    ]) {
      expect(COMMANDS.SET(args, store)).toMatch(/^-ERR/);
    }
    expect(store.size()).toBe(0);
  });

  test('commands reject extra or missing arguments', () => {
    const store = new Store();
    expect(COMMANDS.PING(['extra'])).toMatch(/^-ERR/);
    expect(COMMANDS.GET(['key', 'extra'], store)).toMatch(/^-ERR/);
    expect(COMMANDS.DEL(['key', 'extra'], store)).toMatch(/^-ERR/);
    expect(COMMANDS.EXPIRE(['key'], store)).toMatch(/^-ERR/);
    expect(COMMANDS.EXPIRE(['key', '10abc'], store)).toMatch(/^-ERR/);
    expect(COMMANDS.INFO(['extra'], store, {})).toMatch(/^-ERR/);
  });
});
