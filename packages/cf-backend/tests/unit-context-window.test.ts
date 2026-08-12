// Per-model context windows — the static fallback table + the catalog lookup
// that feed the compaction extension's transformContext trigger.
import { describe, test, expect } from "bun:test";
import { userCredentialSource } from './helpers/user-credentials.js';
import { createAgentProviderRegistry } from "../src/providers/agent-registry";
import { catalogModelInfo, contextWindowForModel, type ModelProvider, type ProviderDeps } from "@proteus/core";

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
    const userDOStub = userCredentialSource({
      getAuthHeaders: async () => null,
      listCredentials: async () => [],
      getCredentialBaseURL: async () => null,
    });
    const reg = createAgentProviderRegistry({ env: {}, userDO: userDOStub });
    const effectiveSpec = reg.normalizeSpecSync(null);
    expect(effectiveSpec).toBe("workers-ai/@cf/moonshotai/kimi-k2.6");
    expect(contextWindowForModel(effectiveSpec)).toBe(262_144);
  });
});

describe("catalogModelInfo", () => {
  const deps = {} as ProviderDeps;

  test("returns the catalog entry (window + input modalities) for a known model id", async () => {
    const provider: Pick<ModelProvider, 'listModels'> = {
      listModels: async () => [
        { id: "@cf/moonshotai/kimi-k2.6", contextWindow: 262_144, inputModalities: ["text", "image"] },
        { id: "@cf/openai/gpt-oss-120b", contextWindow: 128_000 },
      ],
    };
    const info = await catalogModelInfo(provider, deps, "@cf/moonshotai/kimi-k2.6");
    expect(info?.contextWindow).toBe(262_144);
    expect(info?.inputModalities).toEqual(["text", "image"]);
  });

  test("returns null for unknown providers, unknown models, and catalog failures", async () => {
    expect(await catalogModelInfo(undefined, deps, "x")).toBeNull();
    const noMatch = { listModels: async () => [{ id: "other" }] };
    expect(await catalogModelInfo(noMatch, deps, "x")).toBeNull();
    const throws = { listModels: async () => { throw new Error("offline"); } };
    expect(await catalogModelInfo(throws, deps, "x")).toBeNull();
  });
});
