/**
 * What model a hosted branch's own work runs on, and who reports its cost.
 *
 * ROUTE. `MODEL_ROUTE_POLICY.mcts` is `invocation` — a rollout runs on the tier
 * the turn that ordered the search runs on. The facet version of this defect
 * passed a NULL spec at a hardcoded `'low'` effort, and a null spec never
 * reaches the profile at all: it asks the registry for the account default. So
 * a role on any tier but the default had its search carried out by models it
 * had not selected, and the comparison between branches was a comparison
 * between the wrong things. The hosted seat resolves the route from the
 * turn's profile on every call (`resolveModelRoute('mcts', profile)`), and a
 * null spec cannot arise because there is no spec argument left to pass one
 * through — which is what these tests pin: the spec the seat hands its
 * `complete` is the tier's, for explore and for reflection alike.
 *
 * REPORTING. The seat files nothing. The old facet wrote operation frames
 * here because the engine held no sink across the RPC; in one isolate the
 * engine owns the call, so the seat returns `usage` for the engine to file
 * and records no frame of its own. A second report at this seam would
 * double-count every rollout, so the assertion is the usage coming back
 * intact — and a provider failure propagating instead of filing.
 *
 * NOT PINNED HERE: lane existence (judge, fast, advisor, reflection) and a
 * no-parent refusal. A hosted branch resolves one model per call and holds no
 * lane objects, so there is nothing to enumerate — a missing profile refuses
 * at the route instead, which both tests below would trip. And a hosted
 * branch is always registered under main, so a parentless branch is
 * unrepresentable rather than refused.
 */

import { describe, expect, test } from 'bun:test';
import { APICallError, generateText } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createProviderRegistry } from '@kinu.run/core';
import type { AgentProviderRegistry } from '../src/providers/agent-registry';
import { hostBranch, type BranchCompletionRequest } from '../src/exploration-hosting';
import { hostedMainActor, orchestratorHarness } from './helpers/actor-harness';
/** The tier the search runs on; a tier pinned outside the registry default, so
 *  "did the branch use the profile" has an observable answer. */
const TIER_MODEL = 'fake-branch/m1';

/** A model that answers the branch task with metered usage. */
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

/** A hosted branch over the workspace's own seat factory, with the model call
 *  going through the production chain — profile route, registry, model — and
 *  the routed spec recorded where the seat hands it over. */
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
    explore: () => branch.explore([{ role: 'user', content: 'ship a parser' }], [], ['javascript'], 'plan', []),
    reflect: () => branch.generateReflection('ship a parser', 'the fixture corpus still fails'),
    specs,
  };
}

describe("an MCTS branch runs the turn's tier, not the account default", () => {
  test('explore resolves its model through the profile the turn resolved', async () => {
    const branch = await makeBranch();

    const result = await branch.explore();

    expect(result.text).toBe('Parse the grammar with a Pratt parser.');
    // The seat handed its `complete` the TIER's spec. A null spec would have
    // reached the registry's own default instead, which is the defect.
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

    // And the usage the engine needs to file it really came back.
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

    // A 400, not a 500: a 5xx is a transient the provider layer retries with
    // backoff, which would measure the retry policy rather than this
    // propagation.
    await expect(branch.explore([{ role: 'user', content: 'ship a parser' }], [], ['javascript'], 'plan', [])).rejects.toThrow(APICallError);
  });
});
