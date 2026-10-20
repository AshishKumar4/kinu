import { describe, expect, test } from 'bun:test';
import {
  extractJsonArray, extractJsonObject,
} from '../src/index';

describe('structured prompt helpers', () => {
  test('extracts balanced JSON objects with nested braces and strings', () => {
    expect(extractJsonObject('prefix {"a":{"b":2},"s":"x } y {"} suffix')).toEqual({
      a: { b: 2 },
      s: 'x } y {',
    });
  });

  test('a non-JSON fence does not hide a valid object that follows it', () => {
    expect(extractJsonObject('```text\nhello\n```\n{"a":1}')).toEqual({ a: 1 });
  });

  test('extracts fenced JSON arrays', () => {
    expect(extractJsonArray('```json\n[{"task":"a"},{"task":"b"}]\n```')).toEqual([
      { task: 'a' },
      { task: 'b' },
    ]);
  });

  test('throws clear errors for missing JSON', () => {
    expect(() => extractJsonObject('no json')).toThrow(SyntaxError);
    expect(() => extractJsonArray('no json')).toThrow(SyntaxError);
  });
});
