import { describe, expect, test } from 'bun:test';
import {
  extractJsonArray, extractJsonObject, jsonArrayOnlyInstruction, jsonObjectOnlyInstruction,
  stripMarkdownFences,
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
    expect(() => extractJsonObject('no json')).toThrow(/no JSON object/);
    expect(() => extractJsonArray('no json')).toThrow(/no JSON array/);
  });

  test('instructions are strict and format-specific', () => {
    expect(jsonObjectOnlyInstruction()).toContain('JSON object');
    expect(jsonArrayOnlyInstruction()).toContain('JSON array');
  });
});

describe('stripMarkdownFences', () => {
  test('unwraps the first fenced block regardless of its tag or surrounding prose', () => {
    expect(stripMarkdownFences('before\n```typescript\nconst value = 1;\n```\nafter'))
      .toBe('const value = 1;');
    expect(stripMarkdownFences('```python\nprint(1)\n```')).toBe('print(1)');
    expect(stripMarkdownFences('```\nplain\n```')).toBe('plain');
  });

  test('leaves an unfenced response intact', () => {
    expect(stripMarkdownFences('plain text')).toBe('plain text');
  });
});
