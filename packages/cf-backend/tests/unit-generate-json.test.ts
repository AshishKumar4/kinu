// extractJsonObject — robust JSON extraction from LLM text (the merge path).
import { describe, test, expect } from "bun:test";
import { extractJsonObject } from "../src/lib/generate-json";

describe("extractJsonObject", () => {
  test("parses a bare JSON object", () => {
    expect(extractJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  test("strips ```json fences", () => {
    const t = 'Here is the result:\n```json\n{"narrative":"hi","ok":true}\n```\nDone.';
    expect(extractJsonObject(t)).toEqual({ narrative: "hi", ok: true });
  });

  test("ignores prose before and after the object", () => {
    expect(extractJsonObject('Sure! {"x":[1,2,3]} hope that helps')).toEqual({ x: [1, 2, 3] });
  });

  test("handles nested objects and braces inside strings", () => {
    const t = '{"a":{"b":2},"s":"a } b { c"}';
    expect(extractJsonObject(t)).toEqual({ a: { b: 2 }, s: "a } b { c" });
  });

  test("handles escaped quotes inside strings", () => {
    expect(extractJsonObject('{"s":"he said \\"hi\\""}')).toEqual({ s: 'he said "hi"' });
  });

  test("throws when there is no object", () => {
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });

  test("throws on an unterminated object", () => {
    expect(() => extractJsonObject('{"a":1')).toThrow(/unterminated/);
  });
});
