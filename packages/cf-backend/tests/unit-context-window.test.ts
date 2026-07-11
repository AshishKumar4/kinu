// Per-model context windows — the static fallback table + the catalog lookup
// that feed the compaction extension's transformContext trigger.
import { describe, test, expect } from "bun:test";
import { contextWindowForModel, catalogContextWindow } from "../src/lib/context-window";
import { createAgentProviderRegistry } from "../src/providers/agent-registry";
import type { ProviderDeps } from "@proteus/core";

describe("contextWindowForModel", () => {
  test("matches known model families on their spec", () => {
    expect(contextWindowForModel("minimax/m3")).toBe(1_000_000);
    expect(contextWindowForModel("@cf/moonshotai/kimi-k2.6")).toBe(262_144);
    expect(contextWindowForModel("@cf/meta/llama-4-scout")).toBe(131_072);
    expect(contextWindowForModel("anthropic/claude-opus-4-7")).toBe(1_000_000);
    expect(contextWindowForModel("openai/gpt-5.5")).toBe(1_050_000);
    expect(contextWindowForModel("codex/gpt-5.5")).toBe(272_000);
    expect(contextWindowForModel("openai/gpt-5.1")).toBe(256_000);
    expect(contextWindowForModel("google/gemini-2.5-pro")).toBe(1_000_000);
  });

  test("falls back to a conservative default for unknown specs", () => {
    expect(contextWindowForModel("")).toBe(128_000);
    expect(contextWindowForModel("some/unknown-model")).toBe(128_000);
  });

  test("a default-configured agent (no stored model) resolves to the real Kimi window", () => {
    // The C3 regression: sizing from the RAW stored spec gave "" → the 128k
    // default window → compaction at 41% of Kimi's real 262,144 window. The
    // orchestrator resolves the EFFECTIVE spec first (the same
    // normalizeSpecSync resolution getModel() uses) before sizing.
    const userDOStub = {
      getAuthHeaders: async () => null,
      listCredentials: async () => [],
      getCredentialBaseURL: async () => null,
    } as unknown as Parameters<typeof createAgentProviderRegistry>[0]["userDOStub"];
    const reg = createAgentProviderRegistry({ env: {}, userDOStub });
    const effectiveSpec = reg.normalizeSpecSync(null);
    expect(effectiveSpec).toBe("workers-ai/@cf/moonshotai/kimi-k2.6");
    expect(contextWindowForModel(effectiveSpec)).toBe(262_144);
  });
});

describe("catalogContextWindow", () => {
  const deps = {} as ProviderDeps;

  test("returns the catalog window for a known model id", async () => {
    const provider = {
      listModels: async () => [
        { id: "@cf/moonshotai/kimi-k2.6", contextWindow: 262_144 },
        { id: "@cf/openai/gpt-oss-120b", contextWindow: 128_000 },
      ],
    };
    expect(await catalogContextWindow(provider, deps, "@cf/moonshotai/kimi-k2.6")).toBe(262_144);
  });

  test("returns null for unknown providers, unknown models, missing windows, and catalog failures", async () => {
    expect(await catalogContextWindow(undefined, deps, "x")).toBeNull();
    const noMatch = { listModels: async () => [{ id: "other" }] };
    expect(await catalogContextWindow(noMatch, deps, "x")).toBeNull();
    const noWindow = { listModels: async () => [{ id: "x" }] };
    expect(await catalogContextWindow(noWindow, deps, "x")).toBeNull();
    const throws = { listModels: async () => { throw new Error("offline"); } };
    expect(await catalogContextWindow(throws, deps, "x")).toBeNull();
  });
});
