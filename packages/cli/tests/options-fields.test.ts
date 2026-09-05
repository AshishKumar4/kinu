// The shared record-field contract both `run` (command payloads) and `debug`
// (bundle identity) read through: blank strings read as absent, numeric
// strings read as their number, and non-finite numbers never pass.
import { describe, expect, test } from 'bun:test';
import { numberField, stringField } from '../src/options';

describe('stringField', () => {
  test('trims and rejects empty strings', () => {
    expect(stringField({ a: ' x ' }, 'a')).toBe('x');
    expect(stringField({ a: '' }, 'a')).toBeUndefined();
    expect(stringField({ a: '   ' }, 'a')).toBeUndefined();
    expect(stringField({}, 'a')).toBeUndefined();
    expect(stringField({ a: 7 }, 'a')).toBeUndefined();
  });
});

describe('numberField', () => {
  test('reads finite numbers and numeric strings only', () => {
    expect(numberField({ n: 20 }, 'n')).toBe(20);
    expect(numberField({ n: '20' }, 'n')).toBe(20);
    expect(numberField({ n: ' 20 ' }, 'n')).toBe(20);
    expect(numberField({ n: '' }, 'n')).toBeUndefined();
    expect(numberField({ n: 'abc' }, 'n')).toBeUndefined();
    expect(numberField({ n: Number.NaN }, 'n')).toBeUndefined();
    expect(numberField({ n: Number.POSITIVE_INFINITY }, 'n')).toBeUndefined();
    expect(numberField({}, 'n')).toBeUndefined();
  });
});
