import { describe, expect, test } from 'bun:test';
import { extractJsonArray, extractJsonObject, jsonArrayOnlyInstruction, jsonObjectOnlyInstruction } from '../src/index.ts';

describe('structured prompt helpers', () => {
  test('extracts balanced JSON objects with nested braces and strings', () => {
    expect(extractJsonObject('prefix {"a":{"b":2},"s":"x } y {"} suffix')).toEqual({
      a: { b: 2 },
      s: 'x } y {',
    });
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
