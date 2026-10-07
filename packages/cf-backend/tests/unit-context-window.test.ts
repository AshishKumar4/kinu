// A model's window is its catalog row's or unknown, and the input allocation it composes into. An unknown window
// sizes, triggers and refuses nothing.
import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import {
  assembleTurnMessages,
  catalogModelInfo,
  classifyTurnFailure,
  ModelCatalogSession,
  stepContextLimit,
  type ModelProvider,
  type ProviderDeps,
} from "@kinu.run/core";

// #20: the defect was the composition. An unanswered catalog read as "the answer may take the whole
// window", halving an unmeasured window and refusing a 124,644-token request against 64,000.
describe("the input allocation a resolved model leaves", () => {
  function unanswered(spec: string): ModelCatalogSession {
    const session = new ModelCatalogSession({ effectiveSpec: () => spec, lookup: async () => null, measured: () => null });
    session.info();

    return session;
  }

  function allocation(session: ModelCatalogSession): number {
    return stepContextLimit({
      contextWindow: session.contextWindow(),
      modelOutputLimit: session.window().modelOutputLimit,
    });
  }

  test("an unanswered catalog leaves the window unknown and the allocation unbounded, never a halved guess", async () => {
    const session = unanswered("opencode-go/unlisted-model-9");
    await Promise.resolve();

    expect(session.contextWindow()).toBeNull();
    expect(allocation(session)).toBe(Number.POSITIVE_INFINITY);
  });

  test("a REPORTED allowance is still bounded by half the window", async () => {
    const session = new ModelCatalogSession({
      effectiveSpec: () => "anthropic/claude-opus-4-7",
      lookup: async () => ({ id: "claude-opus-4-7", contextWindow: 1_000_000, modelOutputLimit: 128_000 }),
      measured: () => null,
    });

    expect(await session.resolved()).toEqual({ contextWindow: 1_000_000, modelOutputLimit: 128_000 });
    expect(allocation(session)).toBe(872_000);
  });
});

// #20, the admission: only a known window refuses; the two cases below differ in nothing else.
describe("admission on an unknown window", () => {
  const HISTORY: ModelMessage[] = [
    { role: "user", content: "the long conversation this turn continues" },
  ];

  /** The turn of #20, already force-compacted so its one compaction is spent. */
  async function admit(contextWindow: number | null): Promise<ModelMessage[] | Error> {
    try {
      return (await assembleTurnMessages({
        model: 'test/model',
        system: "SYS",
        history: HISTORY,
        sessionKey: "k",
        contextWindow,
        trigger: "force",
        admission: {
          count: async () => ({ kind: "counted", tokens: 124_644 }),
          limits: { contextWindow, modelOutputLimit: 128_000 },
        },
      })).messages;
    } catch (caught) {
      return caught instanceof Error ? caught : new Error(String(caught));
    }
  }

  test("a request on an unknown window is admitted, and the provider answers", async () => {
    expect(await admit(null)).toEqual(HISTORY);
  });

  test("the same request on a KNOWN window is still refused before submission", async () => {
    // Negative control: an admission that refuses nothing would otherwise pass.
    const refused = await admit(128_000);
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : "").toContain("refused before submission");
  });

  test("the refusal is not a transient blip the client should retry through", async () => {
    const refused = await admit(128_000);
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
