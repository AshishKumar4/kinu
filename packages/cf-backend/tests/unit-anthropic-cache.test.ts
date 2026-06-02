// markLastToolForAnthropicCache — one cache breakpoint on the last tool.
import { describe, test, expect } from "bun:test";
import { markLastToolForAnthropicCache } from "../src/providers/anthropic-cache";
import type { ToolSet } from "ai";

function tool(description: string) {
  return { description, inputSchema: { type: "object" }, execute: async () => ({}) } as unknown;
}

describe("markLastToolForAnthropicCache", () => {
  test("sets an ephemeral anthropic cache breakpoint on the LAST tool only", () => {
    const tools = { a: tool("a"), b: tool("b"), c: tool("c") } as unknown as ToolSet;
    markLastToolForAnthropicCache(tools);
    const c = tools.c as { providerOptions?: Record<string, unknown> };
    const a = tools.a as { providerOptions?: Record<string, unknown> };
    expect(c.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(a.providerOptions).toBeUndefined(); // earlier tools untouched
  });

  test("preserves any existing providerOptions on the last tool", () => {
    const last = { ...(tool("z") as object), providerOptions: { openai: { x: 1 } } };
    const tools = { z: last } as unknown as ToolSet;
    markLastToolForAnthropicCache(tools);
    expect((tools.z as { providerOptions?: Record<string, unknown> }).providerOptions).toEqual({
      openai: { x: 1 },
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  test("empty tool set is a no-op", () => {
    const tools = {} as ToolSet;
    expect(() => markLastToolForAnthropicCache(tools)).not.toThrow();
  });
});
