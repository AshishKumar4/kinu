// Per-model context windows — the static fallback table, the catalog lookup,
// and the INPUT ALLOCATION the two compose into. The table answers only for a
// model somebody measured; for anything else it stands in, and a stand-in is
// marked as one so no gate downstream can spend it as a fact.
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
    // Every match is a figure read off a published catalog, so it is allowed to
    // gate a request.
    expect(contextWindowForModel("openai/gpt-5.1").measured).toBe(true);
  });

  test("the families this product's own catalogs serve are measured, not stood in for", () => {
    // #20 was reported on this model: a 1M-window model whose spec matched no
    // entry, so the table stood in with 128k and the turn was refused against
    // half of that.
    expect(contextWindowForModel("opencode-go/muse-spark-1.3-contributor"))
      .toEqual({ measured: true, window: 1_048_576 });
    expect(contextWindowForModel("workers-ai/@cf/nvidia/nemotron-3-120b-a12b"))
      .toEqual({ measured: true, window: 256_000 });
    expect(contextWindowForModel("workers-ai/@cf/google/gemma-4-26b-a4b-it"))
      .toEqual({ measured: true, window: 256_000 });
    // Workers AI publishes 128k for both GPT-OSS sizes; the gpt-5 rule above
    // used to answer 256k for them, which is not a figure anybody measured.
    expect(contextWindowForModel("workers-ai/@cf/openai/gpt-oss-120b"))
      .toEqual({ measured: true, window: 128_000 });
  });

  test("an unmeasured spec says so instead of reporting a window as a fact", () => {
    expect(contextWindowForModel("")).toEqual({ measured: false, window: 128_000 });
    expect(contextWindowForModel("some/unknown-model")).toEqual({ measured: false, window: 128_000 });
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
    expect(contextWindowForModel(effectiveSpec)).toEqual({ measured: true, window: 1_048_576 });
  });
});

// #20. The window, the answer reserve and the input allocation are three
// different numbers, and the defect was in their COMPOSITION rather than in any
// one of them: an unanswered catalog read as "the answer may take the whole
// window", which halved a window nobody had measured and refused a 124,644-token
// request against 64,000.
describe("the input allocation a resolved model leaves", () => {
  /** A catalog session whose lookup answers nothing — an isolate that has just
   *  started, or a provider with no catalogue at all. */
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

    // The stand-in window may still SIZE a budget — something has to — but it
    // is spent whole rather than halved by an allowance nobody reported.
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

// #20, the other half: the admission that spends that allocation. PROVENANCE
// ALONE decides whether a request may be refused — the two cases below differ
// in nothing else, and the refusing one carries the 64,000-token allocation and
// the 124,644-token request the owner reported.
describe("admission on an unmeasured window", () => {
  const HISTORY: ModelMessage[] = [
    { role: "user", content: "the long conversation this turn continues" },
  ];

  /** The turn of #20: a 124,644-token request against a 128k window whose
   *  answer allowance nothing reported, already force-compacted so the one
   *  compaction it was entitled to is spent. */
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
    // The negative control for the case above: without it, an admission that
    // refuses nothing at all would pass.
    const refused = await admit(true);
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : "").toContain("refused before submission");
  });

  test("the refusal is not a transient blip the client should retry through", async () => {
    const refused = await admit(true);
    expect(refused).toBeInstanceOf(Error);
    // The class itself is pinned where the policy lives
    // (packages/core/tests/unit-turn-admission.test.ts); what belongs here is
    // that the composition above produces a refusal the client can act on
    // rather than one it should quietly try again.
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
    // Null for a failed READ would be the same answer as "no such model", which
    // is how every model silently ends up on a static context window. The
    // degraded path is kept where it can say so instead: the lookup seam
    // (ModelCatalogSession.armLookup) records the reason and leaves the static
    // fallbacks authoritative.
    const throws = { listModels: async () => { throw new Error("offline"); } };
    await expect(catalogModelInfo(throws, deps, "x")).rejects.toThrow("offline");
  });
});
