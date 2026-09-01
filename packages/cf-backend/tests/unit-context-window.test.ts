// Per-model context windows — the static fallback table + the catalog lookup
// that feed the compaction extension's transformContext trigger.
import { describe, test, expect } from "bun:test";
import { userCredentialSource } from './helpers/user-credentials';
import { createAgentProviderRegistry } from "../src/providers/agent-registry";
import { WORKERS_AI_FALLBACK_MODEL_CATALOG } from "../src/providers/workers-ai-catalog";
import {
  catalogModelInfo,
  contextWindowForModel,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  type ModelProvider,
  type ProviderDeps,
} from "@kinu.run/core";

describe("contextWindowForModel", () => {
  test("the offline Workers AI catalog keeps DeepSeek V4 Pro as the first default", () => {
    expect(WORKERS_AI_FALLBACK_MODEL_CATALOG[0]).toEqual({
      id: "@cf/zai-org/glm-5.3",
      label: "GLM 5.3",
      capabilities: ["tools", "streaming", "reasoning"],
      contextWindow: 1_048_576,
      inputModalities: ["text"],
    });
  });

  test("matches known model families on their spec", () => {
    expect(contextWindowForModel("minimax/m3")).toBe(1_000_000);
    expect(contextWindowForModel("workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813")).toBe(1_048_576);
    expect(contextWindowForModel("workers-ai/@cf/zai-org/glm-5.3")).toBe(1_048_576);
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

  test("a default-configured agent resolves to the real DeepSeek V4 Pro window", () => {
    // The C3 regression: sizing from the RAW stored spec gave "" → the 128k
    // default window could drift from the selected model. The
    // orchestrator resolves the EFFECTIVE spec first (the same
    // normalizeSpecSync resolution getModel() uses) before sizing.
    const userDOStub = userCredentialSource({
      getAuthHeaders: async () => null,
      listCredentials: async () => [],
      getCredentialBaseURL: async () => null,
    });
    const reg = createAgentProviderRegistry({ env: {}, userDO: userDOStub });
    const effectiveSpec = reg.normalizeSpecSync(null);
    expect(effectiveSpec).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(contextWindowForModel(effectiveSpec)).toBe(1_048_576);
  });
});

describe("catalogModelInfo", () => {
  const deps: ProviderDeps = {
    env: {},
    getAuth: async () => null,
    hasCredential: async () => false,
  };

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

  test("returns null for unknown providers and unknown models, and surfaces a catalog it cannot read", async () => {
    expect(await catalogModelInfo(undefined, deps, "x")).toBeNull();
    const noMatch = { listModels: async () => [{ id: "other" }] };
    expect(await catalogModelInfo(noMatch, deps, "x")).toBeNull();
    // Null for a failed READ would be the same answer as "no such model", which
    // is how every model silently ends up on a static context window. The
    // degraded path is kept where it can say so instead: the lookup seam
    // (ModelCatalogSession.armLookup) records the reason and leaves the static
    // fallbacks authoritative.
    const throws = { listModels: async () => { throw new Error("offline"); } };
    await expect(catalogModelInfo(throws, deps, "x")).rejects.toThrow("offline");
  });
});
