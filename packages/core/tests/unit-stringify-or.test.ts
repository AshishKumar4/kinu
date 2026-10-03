import { describe, expect, test } from 'bun:test';
import { stringifyOr } from '../src/utils/json';

describe('stringifyOr', () => {
  test('a stringifiable value is its JSON, and undefined stays undefined', () => {
    expect(stringifyOr({ value: { a: [1, 'b'] } }, () => 'unreached')).toBe('{"a":[1,"b"]}');
    expect(stringifyOr({ value: undefined }, () => 'unreached')).toBeUndefined();
  });

  test('a cycle answers the fallback with the rendered reason, never a throw', () => {
    const looped: object[] = [];
    looped.push(looped);

    const text = stringifyOr({ value: looped }, (reason) => `unserializable: ${reason}`);

    expect(text).toStartWith('unserializable: ');
    expect(text).toContain('cyclic');
  });

  test('the replacer applies', () => {
    expect(stringifyOr({ value: { n: 1 }, replacer: <Value>(_key: string, value: Value) => (value === 1 ? 'one' : value) }, () => 'unreached'))
      .toBe('{"n":"one"}');
  });
});
