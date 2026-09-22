/**
 * A hosted branch's model route and cost reporting: `MODEL_ROUTE_POLICY.mcts` is `invocation`, so the seat hands
 * `complete` the turn tier's spec, never a null spec that falls to the account default. The seat files nothing and
 * returns `usage` for the engine; a second report here would double-count every rollout.
 */

import { describe, expect, test } from 'bun:test';
import { APICallError, generateText } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createProviderRegistry } from '@kinu.run/core';
import type { AgentProviderRegistry } from '../src/providers/agent-registry';
import { hostBranch, type BranchCompletionRequest } from '../src/exploration-hosting';
import { hostedMainActor, orchestratorHarness } from './helpers/actor-harness';

/** Pinned outside the registry default, so "did the branch use the profile" is observable. */
const TIER_MODEL = 'fake-branch/m1';

function answerModel(answer: string) {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-branch',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: answer }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 31, noCache: 31, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 9, text: 9, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

interface BranchHarness {
  explore: () => Promise<{ text: string; usage?: unknown }>;
  reflect: () => Promise<{ text: string; usage?: unknown }>;
  specs: string[];
}

/** A hosted branch over the workspace's own seat factory, recording the routed spec the seat hands over. */
async function makeBranch(answer = 'Parse the grammar with a Pratt parser.'): Promise<BranchHarness> {
  const workspace = orchestratorHarness();
  await hostedMainActor(workspace);
  workspace.agent.harnessInstallCatalog({
    tiers: { default: { model: TIER_MODEL } },
    availableModels: [TIER_MODEL],
  });
  const specs: string[] = [];
  const model = answerModel(answer);
  workspace.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: () => model,
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  } satisfies AgentProviderRegistry);
  const seams = workspace.agent.observeExplorationSeams();

  const complete = async (request: BranchCompletionRequest) => {
    specs.push(request.spec);

    const result = await generateText({
      model: seams.resolveModel(request.spec),
      system: request.system,
      prompt: request.user,
    });

    return {
      text: result.text,
      usage: { input: result.usage.inputTokens ?? undefined, output: result.usage.outputTokens ?? undefined },
    };
  };

  const branch = await hostBranch(seams, 'branch-1', {
    explorePrompt: ({ context }) => ({ system: 'Explore.', user: context }),
    reflectionPrompt: (task, traces) => `${task}\n${traces}`,
    complete,
  });

  return {
    explore: () => branch.explore({
      priorHistory: [{ role: 'user', content: 'ship a parser' }],
      craftedTools: [],
      languages: ['javascript'],
      mode: 'plan',
      siblings: [],
    }),
    reflect: () => branch.generateReflection('ship a parser', 'the fixture corpus still fails'),
    specs,
  };
}

describe("an MCTS branch runs the turn's tier, not the account default", () => {
  test('explore resolves its model through the profile the turn resolved', async () => {
    const branch = await makeBranch();

    const result = await branch.explore();

    expect(result.text).toBe('Parse the grammar with a Pratt parser.');
    // A null spec would reach the registry's own default instead.
    expect(branch.specs).toEqual([TIER_MODEL]);
  });

  test('the reflection pass takes the same route', async () => {
    const branch = await makeBranch();

    await branch.explore();
    await branch.reflect();

    expect(branch.specs).toEqual([TIER_MODEL, TIER_MODEL]);
  });
});

describe('the seat files nothing; the usage it returns is what the engine files', () => {
  test('usage comes back intact for the engine to file', async () => {
    const branch = await makeBranch();

    const result = await branch.explore();

    expect(result.usage).toEqual({ input: 31, output: 9 });
  });

  test('a provider failure propagates instead of filing', async () => {
    const workspace = orchestratorHarness();
    await hostedMainActor(workspace);
    workspace.agent.harnessInstallCatalog({
      tiers: { default: { model: TIER_MODEL } },
      availableModels: [TIER_MODEL],
    });

    const failing = scriptedTurnModel({
      provider: 'fake',
      modelId: 'fake-branch',
      doGenerate: async () => {
        throw new APICallError({ message: 'malformed request', url: 'https://fake-gateway.example/v1', requestBodyValues: {}, statusCode: 400, responseHeaders: {} });
      },
    });

    workspace.agent.overrideProviderRegistry({
      registry: createProviderRegistry(),
      deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
      resolveModel: () => failing,
      normalizeSpecSync: (spec) => spec ?? 'test/model',
    } satisfies AgentProviderRegistry);
    const seams = workspace.agent.observeExplorationSeams();

    const branch = await hostBranch(seams, 'branch-fail', {
      explorePrompt: ({ context }) => ({ system: 'Explore.', user: context }),
      reflectionPrompt: (task, traces) => `${task}\n${traces}`,
      complete: async (request) => {
        const result = await generateText({
          model: seams.resolveModel(request.spec),
          system: request.system,
          prompt: request.user,
        });

        return { text: result.text };
      },
    });

    // A 400, not a 5xx: the provider layer retries 5xx with backoff, which would test the retry policy.
    await expect(branch.explore({
      priorHistory: [{ role: 'user', content: 'ship a parser' }],
      craftedTools: [],
      languages: ['javascript'],
      mode: 'plan',
      siblings: [],
    })).rejects.toThrow(APICallError);
  });
});
