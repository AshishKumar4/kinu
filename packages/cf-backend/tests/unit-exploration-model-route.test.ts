/**
 * What model a facet's own work runs on, and who reports its cost.
 *
 * Two defects are locked down here, and they are the same defect at two seams.
 *
 * ROUTE. `MODEL_ROUTE_POLICY.mcts` is `invocation` — a rollout runs on the tier
 * the turn that ordered the search runs on. `explore()` and
 * `generateReflection()` passed a NULL spec at a hardcoded `'low'` effort, and a
 * null spec never reaches the profile at all: it asks the registry for the
 * account default. So a role on any tier but the default had its search carried
 * out by models it had not selected, and the comparison between branches was a
 * comparison between the wrong things.
 *
 * LANES. `facetRuntime` passed no profile hook, so `createProfileLaneLLM`
 * returned UNDEFINED for judge, fast and advisor, and the reflection lane threw
 * `reflection model lane has no active profile`. Composed with the MCTS engine —
 * which reads `rt.judgeModel` and falls back to `rt.llm` — every evaluation of a
 * facet-hosted search threw, scored the band floor, and the search reported
 * `no_acceptable_candidate` over branches that had really answered.
 *
 * REPORTING. The operation frame belongs here; the `model_call` row does NOT.
 * `explore` returns `usage` to `mcts/engine.ts`, which files one `mcts` row per
 * branch call from it (engine.ts:244) because only the engine can tell a
 * completed call from a rejected or malformed one. A second report at this seam
 * would double-count every rollout. The engine holds no operation sink and could
 * not open one across the RPC, so the lifecycle has no owner but this one.
 */

import { describe, expect, test } from 'bun:test';
import { APICallError } from 'ai';
import {
  BUILTIN_PROFILE_CATALOG,
  profileCatalogDigest,
  resolveTurnProfile,
  type ModelCallReport,
  type ModelOperationEvent,
  type ResolvedTurnProfile,
} from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { platformGatewayEnv, stubAiBinding } from './helpers/platform-gateway';
import * as v from 'valibot';

mockAgentsSdk();

// Dynamic by necessity, not by style: `mockAgentsSdk()` must register its
// `agents` and `cloudflare:*` stubs BEFORE this module graph loads, and a static
// import is hoisted above the call. Same reason and same shape as
// unit-head-fork.test.ts.
const { SubordinateAgent } = await import('../src/subordinate-agent');
const { facetHarness } = await import('./helpers/actor-harness');

/** The gateway serves these; a tier pinned outside the set would be refused by
 *  the resolver before routing could be observed at all. The spec carries the
 *  `ai-gateway/` provider prefix, and what reaches the wire is the remainder —
 *  so the two are written as one relationship rather than two constants that
 *  could drift. */
const TIER_MODEL_ID = 'workers-ai/@cf/openai/gpt-oss-20b';
const TIER_MODEL = `ai-gateway/${TIER_MODEL_ID}`;
const OTHER_MODEL = 'ai-gateway/workers-ai/@cf/openai/gpt-oss-120b';
const BRANCH_ANSWER = 'Parse the grammar with a Pratt parser.';

/**
 * A profile whose `default` tier is NOT the account's first listed model, so
 * "did the branch use the profile" has an observable answer. A fixture where
 * every tier agreed with the registry default could not tell a routed call from
 * an unrouted one.
 */
function profileFixture(): ResolvedTurnProfile {
  const catalog = {
    ...BUILTIN_PROFILE_CATALOG,
    tiers: {
      default: { model: TIER_MODEL, reasoningEffort: 'medium' as const },
      deep: { model: OTHER_MODEL, reasoningEffort: 'high' as const },
    },
  };
  return resolveTurnProfile({
    envelope: {
      authority: { kind: 'account', accountId: 'acct-1' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    },
    provider: { revision: 'rev-1', availableModels: [TIER_MODEL, OTHER_MODEL] },
    roleId: 'general',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
}

/** An OpenAI-shaped chat completion, which is what the gateway provider decodes. */
function completion(text: string): Response {
  return Response.json({
    id: 'cmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-oss-20b',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 },
  });
}

interface BranchHarness {
  explore: () => Promise<{ text: string; usage?: unknown }>;
  reflect: () => Promise<{ text: string; usage?: unknown }>;
  nodeRuntimeLanes: () => { judge: boolean; fast: boolean; advisor: boolean; reflection: boolean };
  setSharedParent: (name: string) => Promise<{ ok: true }>;
  operations: ModelOperationEvent[];
  modelCalls: ModelCallReport[];
  requestedModels: () => string[];
  profileCalls: () => number;
}

async function makeBranch(respond: (text: string) => Response = completion): Promise<BranchHarness> {
  const operations: ModelOperationEvent[] = [];
  const modelCalls: ModelCallReport[] = [];
  let profileCalls = 0;
  const ai = stubAiBinding(() => respond(BRANCH_ANSWER));
  const parentStub = {
    async facetTurnProfile(): Promise<ResolvedTurnProfile> {
      profileCalls += 1;
      return profileFixture();
    },
    async reportFacetModelOperation(event: ModelOperationEvent): Promise<void> {
      operations.push(event);
    },
    async reportFacetModelCall(report: ModelCallReport): Promise<void> {
      modelCalls.push(report);
    },
  };
  const bindings = {
    LOADER: {},
    Sandbox: {},
    ...platformGatewayEnv(ai),
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => parentStub },
    UserDO: { idFromName: (name: string) => name, get: () => ({}) },
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, bindings);
  // SAFETY: every binding branch work reaches is constructed above — the gateway
  // provider (AI_GATEWAY_URL + AI), the parent OrchestratorAgent namespace, the
  // UserDO namespace and LOADER. Branch work has no runtime and no sandbox, so
  // it touches nothing else on Env.
  const testEnv = partialEnv as Env;
  // The facet as `spawnBranchFacet` produces it: the production class under the
  // `exp:`-marked key, activated the way the SDK activates it before the first
  // `@callable` is dispatched.
  const { agent: concrete } = await facetHarness({ name: 'exp:branch-1', env: testEnv });

  const facetRuntimeMember = Object.getOwnPropertyDescriptor(
    SubordinateAgent.prototype,
    'facetRuntime',
  )?.value;
  if (!v.is(v.function(), facetRuntimeMember)) {
    throw new Error('SubordinateAgent facetRuntime seam is missing');
  }

  return {
    explore: () => concrete.explore([{ role: 'user', content: 'ship a parser' }], [], ['javascript'], 'plan', []),
    reflect: () => concrete.generateReflection('ship a parser', 'the fixture corpus still fails'),
    nodeRuntimeLanes: () => {
      const rt: unknown = facetRuntimeMember.call(concrete, 'node', 'node-1', {});
      const lanes = v.parse(v.object({
        llm: v.object({ complete: v.function() }),
        judgeModel: v.optional(v.unknown()),
        fastLlm: v.optional(v.unknown()),
        advisorLlm: v.optional(v.unknown()),
      }), rt);
      return {
        reflection: lanes.llm.complete !== undefined,
        judge: lanes.judgeModel !== undefined,
        fast: lanes.fastLlm !== undefined,
        advisor: lanes.advisorLlm !== undefined,
      };
    },
    setSharedParent: concrete.setSharedParent.bind(concrete),
    operations,
    modelCalls,
    // The model rides the request BODY: `GatewayRunRequest` is
    // `{provider, endpoint, headers, query}`, and `query` is the OpenAI payload.
    requestedModels: () => ai.runs.map(
      (run) => v.parse(v.object({ model: v.string() }), run.query).model,
    ),
    profileCalls: () => profileCalls,
  };
}

describe('an MCTS branch runs the turn\'s tier, not the account default', () => {
  test('explore resolves its model through the profile the parent turn resolved', async () => {
    const branch = await makeBranch();
    await branch.setSharedParent('kinu-main');

    const result = await branch.explore();

    expect(result.text).toBe(BRANCH_ANSWER);
    // The gateway was asked for the TIER's model. A null spec would have reached
    // the registry's own default instead, which is the defect.
    expect(branch.requestedModels()).toEqual([TIER_MODEL_ID]);
  });

  test('the reflection pass takes the same route', async () => {
    const branch = await makeBranch();
    await branch.setSharedParent('kinu-main');

    await branch.explore();
    await branch.reflect();

    expect(branch.requestedModels()).toEqual([
      TIER_MODEL_ID,
      TIER_MODEL_ID,
    ]);
    // One RPC for the pair: the profile is memoized per activation, so a branch
    // that explores and then reflects does not ask its parent twice.
    expect(branch.profileCalls()).toBe(1);
  });

  test('a branch with no parent refuses rather than silently using the default', async () => {
    const branch = await makeBranch();

    await expect(branch.explore()).rejects.toThrow('This facet was spawned without a parent workspace, so it cannot reach the profile that decides its model; setSharedParent must run before it does any model work.');
    // Nothing was billed for a call that never chose a model.
    expect(branch.requestedModels()).toEqual([]);
    expect(branch.operations).toEqual([]);
  });
});

describe('who records a branch\'s model call', () => {
  test('the operation frame is written here and the cost report is not', async () => {
    const branch = await makeBranch();
    await branch.setSharedParent('kinu-main');

    const result = await branch.explore();

    expect(branch.operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(branch.operations[0]!.operationId).toBe(branch.operations[1]!.operationId);
    expect(branch.operations.every((e) => e.source === 'mcts' && e.op === 'complete')).toBe(true);
    expect(branch.operations[0]!.spec).toBe(TIER_MODEL);
    expect(branch.operations[1]!.outcome).toBe('ok');
    // NO model_call row from this seam. The engine files exactly one from the
    // usage returned below; a report here would double-count every rollout.
    expect(branch.modelCalls).toEqual([]);
    // And the usage the engine needs to file it really came back.
    expect(result.usage).toEqual({ input: 31, output: 9 });
  });

  test('a provider failure closes the frame as failed and still reports no cost', async () => {
    // 400, not 500: a 5xx is a transient the provider layer retries with
    // backoff, which would measure the retry policy rather than this frame.
    const branch = await makeBranch(() => new Response('malformed request', { status: 400 }));
    await branch.setSharedParent('kinu-main');
    await expect(branch.explore()).rejects.toThrow(APICallError);

    // A start row with no end is the shape of a branch that hung; a failed end
    // is the shape of one that was answered badly, and they must not look alike.
    expect(branch.operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(branch.operations[1]!.outcome).toBe('failed');
    expect(branch.modelCalls).toEqual([]);
  });
});

describe('a facet runtime carries the profile its lanes need', () => {
  test('judge, fast, advisor and reflection lanes all exist', async () => {
    const branch = await makeBranch();
    await branch.setSharedParent('kinu-main');

    const lanes = branch.nodeRuntimeLanes();

    // `createProfileLaneLLM` returns undefined when neither profile hook is
    // wired, so an undefined lane here is the exact P1 defect: a facet-hosted
    // search whose every evaluation threw and scored the band floor.
    expect(lanes).toEqual({ judge: true, fast: true, advisor: true, reflection: true });
  });
});
