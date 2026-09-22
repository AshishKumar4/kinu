// Per-model context windows and the input allocation they compose into. The table answers only for
// measured models; anything else is a marked stand-in no gate may spend as a fact.
import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { userCredentialSource } from './helpers/user-credentials';
import { createAgentProviderRegistry } from "../src/providers/agent-registry";
import { WORKERS_AI_FALLBACK_MODEL_CATALOG } from "@kinu.run/core";
import {
  assembleTurnMessages,
  catalogModelInfo,
  classifyTurnFailure,
  contextWindowForModel,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  ModelCatalogSession,
  stepContextLimit,
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
      reasoningEfforts: ["low", "medium", "high"],
    });
  });

  test("matches known model families on their spec", () => {
    expect(contextWindowForModel("minimax/m3").window).toBe(1_000_000);
    expect(contextWindowForModel("workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813").window).toBe(1_048_576);
    expect(contextWindowForModel("workers-ai/@cf/zai-org/glm-5.3").window).toBe(1_048_576);
    expect(contextWindowForModel("@cf/moonshotai/kimi-k2.6").window).toBe(262_144);
    expect(contextWindowForModel("@cf/meta/llama-4-scout").window).toBe(131_072);
    expect(contextWindowForModel("anthropic/claude-opus-4-7").window).toBe(1_000_000);
    expect(contextWindowForModel("openai/gpt-5.5").window).toBe(1_050_000);
    expect(contextWindowForModel("codex/gpt-5.5").window).toBe(272_000);
    expect(contextWindowForModel("openai/gpt-5.1").window).toBe(256_000);
    expect(contextWindowForModel("google/gemini-2.5-pro").window).toBe(1_000_000);
    // Every match is a figure read off a published catalog, so it may gate a request.
    expect(contextWindowForModel("openai/gpt-5.1").measured).toBe(true);
  });

  test("the families this product's own catalogs serve are measured, not stood in for", () => {
    // #20: a spec matching no entry got the stand-in window and was refused against half of it.
    expect(contextWindowForModel("opencode-go/muse-spark-1.3-contributor"))
      .toEqual({ measured: true, window: 1_048_576 });
    expect(contextWindowForModel("workers-ai/@cf/nvidia/nemotron-3-120b-a12b"))
      .toEqual({ measured: true, window: 256_000 });
    expect(contextWindowForModel("workers-ai/@cf/google/gemma-4-26b-a4b-it"))
      .toEqual({ measured: true, window: 256_000 });
    // Not the gpt-5 rule's figure: nobody measured that for GPT-OSS.
    expect(contextWindowForModel("workers-ai/@cf/openai/gpt-oss-120b"))
      .toEqual({ measured: true, window: 128_000 });
  });

  test("an unmeasured spec says so instead of reporting a window as a fact", () => {
    expect(contextWindowForModel("")).toEqual({ measured: false, window: 128_000 });
    expect(contextWindowForModel("some/unknown-model")).toEqual({ measured: false, window: 128_000 });
  });

  test("a default-configured agent resolves to the real DeepSeek V4 Pro window", () => {
    // C3: size from the effective spec (normalizeSpecSync, as getModel() uses), not the raw stored one.
    const userDOStub = userCredentialSource({
      getAuthHeaders: async () => null,
      listCredentials: async () => [],
      getCredentialBaseURL: async () => null,
    });

    const reg = createAgentProviderRegistry({ env: {}, userDO: userDOStub });
    const effectiveSpec = reg.normalizeSpecSync(null);
    expect(effectiveSpec).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(contextWindowForModel(effectiveSpec)).toEqual({ measured: true, window: 1_048_576 });
  });
});

// #20: the defect was the composition. An unanswered catalog read as "the answer may take the whole
// window", halving an unmeasured window and refusing a 124,644-token request against 64,000.
describe("the input allocation a resolved model leaves", () => {
  function unanswered(spec: string): ModelCatalogSession {
    const session = new ModelCatalogSession({ effectiveSpec: () => spec, lookup: async () => null });
    session.info();

    return session;
  }

  function allocation(session: ModelCatalogSession): number {
    return stepContextLimit({
      contextWindow: session.contextWindow(),
      modelOutputLimit: session.modelOutputLimit(),
    });
  }

  test("an unreported answer allowance reserves nothing, so the whole window is admitted", async () => {
    const session = unanswered("opencode-go/muse-spark-1.3-contributor");
    await Promise.resolve();

    expect(session.contextWindow()).toBe(1_048_576);
    expect(session.modelOutputLimit()).toBeNull();
    expect(allocation(session)).toBe(1_048_576);
  });

  test("an unlisted spec does not yield a 64,000-token input allocation", async () => {
    const session = unanswered("opencode-go/unlisted-model-9");
    await Promise.resolve();

    // The stand-in window may size a budget, but is spent whole rather than halved by an unreported allowance.
    expect(allocation(session)).not.toBe(64_000);
    expect(allocation(session)).toBe(session.contextWindow());
  });

  test("a REPORTED allowance is still bounded by half the window", async () => {
    const session = new ModelCatalogSession({
      effectiveSpec: () => "anthropic/claude-opus-4-7",
      lookup: async () => ({ id: "claude-opus-4-7", contextWindow: 1_000_000, modelOutputLimit: 128_000 }),
    });

    expect(await session.resolved()).toEqual({
      contextWindow: 1_000_000, modelOutputLimit: 128_000, windowMeasured: true,
    });
    expect(allocation(session)).toBe(872_000);
  });
});

// #20, the admission: provenance alone decides whether a request may be refused; the two cases
// below differ in nothing else.
describe("admission on an unmeasured window", () => {
  const HISTORY: ModelMessage[] = [
    { role: "user", content: "the long conversation this turn continues" },
  ];

  /** The turn of #20, already force-compacted so its one compaction is spent. */
  async function admit(windowMeasured: boolean): Promise<ModelMessage[] | Error> {
    try {
      return await assembleTurnMessages({
        system: "SYS",
        history: HISTORY,
        sessionKey: "k",
        contextWindow: 128_000,
        trigger: "force",
        admission: {
          count: async () => ({ kind: "counted", tokens: 124_644 }),
          limits: { contextWindow: 128_000, modelOutputLimit: 128_000, windowMeasured },
        },
      });
    } catch (caught) {
      return caught instanceof Error ? caught : new Error(String(caught));
    }
  }

  test("a request over a stand-in allocation is admitted, and the provider answers", async () => {
    expect(await admit(false)).toEqual(HISTORY);
  });

  test("the same request on a MEASURED window is still refused before submission", async () => {
    // Negative control: an admission that refuses nothing would otherwise pass.
    const refused = await admit(true);
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : "").toContain("refused before submission");
  });

  test("the refusal is not a transient blip the client should retry through", async () => {
    const refused = await admit(true);
    expect(refused).toBeInstanceOf(Error);
    // The class is pinned in packages/core/tests/unit-turn-admission.test.ts; here, the refusal must be one
    // the client acts on rather than retries.
    expect(classifyTurnFailure(refused instanceof Error ? refused.message : "")).not.toBe("transient");
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
    // Null for a failed read would equal "no such model"; the lookup seam (ModelCatalogSession.armLookup)
    // records the reason and leaves the static fallbacks authoritative.
    const throws = { listModels: async () => { throw new Error("offline"); } };
    await expect(catalogModelInfo(throws, deps, "x")).rejects.toThrow("offline");
  });
});
