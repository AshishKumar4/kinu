// extractJsonObject + generateJson — robust structured output (the heads merge
// path). generateJson replaces ai-v6 generateObject (whose tool-mode `.input`
// deref crashed on Workers AI); these tests pin that it extracts + validates a
// model's text response and throws (caller falls back) on a schema mismatch.
import { describe, test, expect } from "bun:test";
import * as v from "valibot";
import { MockLanguageModelV3 } from "ai/test";
import { extractJsonObject, generateJson } from "../src/prompts/structured";

function modelReturning(text: string, capture?: (options: { maxOutputTokens?: number }) => void) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      capture?.(options);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

const Schema = v.object({ a: v.number(), b: v.array(v.string()) });

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

describe("generateJson", () => {
  test("extracts + validates a model JSON response (fenced + prosey)", async () => {
    const model = modelReturning('Sure, here you go:\n```json\n{"a":1,"b":["x","y"]}\n```');
    const out = await generateJson({ model, schema: Schema, prompt: "go" });
    expect(out).toEqual({ a: 1, b: ["x", "y"] });
  });

  test("sends no output cap — completion length is the model's", async () => {
    const seen: Array<number | undefined> = [];
    const model = modelReturning('{"a":1,"b":[]}', (options) => seen.push(options.maxOutputTokens));
    await generateJson({ model, schema: Schema, prompt: "go" });
    // This substrate carries the heads merge, the scaffold judge and the GEPA
    // metric, and every one of them asks a model for JSON it must finish. A cap
    // here truncates that JSON mid-object, which arrives as a parse failure and
    // a fallback rather than as the cost control it was mistaken for.
    expect(seen).toEqual([undefined]);
  });

  test("throws on schema mismatch so the caller can fall back", async () => {
    const model = modelReturning('{"a":"not-a-number","b":[]}');
    await expect(generateJson({ model, schema: Schema, prompt: "go" })).rejects.toThrow();
  });

  test("throws when the model returns no JSON object", async () => {
    const model = modelReturning("I cannot help with that.");
    await expect(generateJson({ model, schema: Schema, prompt: "go" })).rejects.toThrow(/no JSON object/);
  });
});
