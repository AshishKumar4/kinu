// Where a delegation's ROLE and TIER actually reach the work.
//
// `tier` is documented as "the ONE routing input" for a delegation, the resolver
// turns it into a concrete model, and the run freezes that resolution into its
// own ledger row before it can detach. All three were true and the nodes still
// ran the CALLER's model, because nothing connected the resolved spec to the
// model a node was handed. The snapshot therefore recorded a model that never
// executed — worse than not routing at all, since the spend and the provenance
// both named it.
//
// Four properties, each asserted where it can actually fail:
//
//   1. A first attempt runs the resolved tier's model, and the ledger row names
//      that same model.
//   2. A role's own tier routes without the caller naming one, and the
//      provenance keeps the difference.
//   3. A re-drive runs the model its FROZEN snapshot names, however today's
//      catalog has since been edited.
//   4. A re-drive with no stored `preset` takes the preset from that snapshot's
//      role, not from the literal fallback. The durable row holds the raw tool
//      input, so a first attempt that took its preset from its role's default
//      stored none — and `ideate`'s axes re-entering an audit's own tree is a
//      different search wearing the same root id and the same claimed epoch.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, toolExecute, scriptedTurnModel } from '@kinu.run/test-utils';
import type { MockLanguageModelV3 } from 'ai/test';
import type { ToolExecutionOptions } from 'ai';
import * as v from 'valibot';
import { RESUME_REDRIVE_OPTION } from '../src/jobs/index';
import { initMctsSearchTable, MctsSearchStore } from '../src/mcts/search-store';
import { initSearchTables } from '../src/mcts/schemas';
import { insertSearchNode } from '../src/mcts/record-node';
import { readStartedSwarmProfile } from '../src/strategy/swarm-resume';
import {
  createAgentsTool, profileCatalogDigest, resolveTurnProfile,
  type AgentsForkDeps, type AgentsProfileContext, type AgentsToolDeps, type AgentsToolInput,
  type ProfileCatalogEnvelope, type ProviderCatalogSnapshot, type ResolvedTurnProfile,
  type RoleDefinition, type SwarmProfileSnapshot, type TierAssignments,
} from '../src/index';
import type { JsonObject } from '../src/utils/json';
import type { AgentRuntime } from '../src/types/agent-runtime';

/** Two tiers whose models are DISTINGUISHABLE, which is the instrument here:
 *  `default` is what the caller's own turn runs at, `deep` is what a delegation
 *  asking for it has to reach. */
const TIERS_V1: TierAssignments = {
  default: { model: 'm-default' },
  deep: { model: 'm-deep-v1' },
};
/** The same catalog after the owner re-pointed `deep`. Nothing an in-flight
 *  search may notice. */
const TIERS_V2: TierAssignments = {
  default: { model: 'm-default' },
  deep: { model: 'm-deep-v2' },
};

/** Default preset `ideate`: the one named preset that needs no objective, so a
 *  run under it settles without an instrument. */
const LEAD: RoleDefinition = {
  description: 'Runs the room.',
  instructions: 'Delegate.',
  tier: 'default',
  preset: 'ideate',
  spawns: '*',
};
/** Default preset `audit`, which is scored `verify` — so a composition resolved
 *  from THIS role refuses without an objective where one resolved from `lead`
 *  runs. That difference is what makes the stored preset observable. */
const AUDITOR: RoleDefinition = {
  description: 'Looks for what is wrong.',
  instructions: 'Audit.',
  tier: 'deep',
  preset: 'audit',
  spawns: '*',
};

const PROVIDER: ProviderCatalogSnapshot = {
  revision: 'rev-routing',
  availableModels: ['m-default', 'm-deep-v1', 'm-deep-v2'],
};

function envelopeOf(tiers: TierAssignments, version: number): ProfileCatalogEnvelope {
  const catalog = { roles: { lead: LEAD, auditor: AUDITOR }, tiers };
  return {
    authority: { kind: 'local' },
    version,
    digest: profileCatalogDigest(catalog),
    catalog,
  };
}

interface CountingModel {
  readonly model: MockLanguageModelV3;
  readonly calls: () => number;
}

/** A node's one answer, plus a COUNT of the calls this model served.
 *
 *  Counted inside `doGenerate` rather than off `doGenerateCalls`/`doStreamCalls`
 *  because the two node paths use different halves of the provider interface — a
 *  toolless node completes, an agent node streams — and `scriptedTurnModel`
 *  routes both through this one script. A fixture counting the wrong array reads
 *  zero and asserts nothing. */
function countingModel(modelId: string): CountingModel {
  let calls = 0;
  const model = scriptedTurnModel({
    modelId,
    doGenerate: () => {
      calls += 1;
      return {
        content: [{ type: 'text', text: `answered by ${modelId}` }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 2, text: 2, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, calls: () => calls };
}

interface Harness {
  /** The tool's own execute, with the options bag a background re-drive
   *  carries. Answers a JSON object either way: a settle report or a refusal. */
  readonly execute: (input: AgentsToolInput, options?: ToolExecutionOptions) => Promise<JsonObject>;
  readonly rt: AgentRuntime;
  /** Every spec the runner asked to have built, in order. */
  readonly resolvedSpecs: string[];
  readonly callerCalls: () => number;
  readonly deepV1Calls: () => number;
  readonly deepV2Calls: () => number;
}

/** The agents tool over a catalog-bearing actor, with each tier's model
 *  separately observable. */
function harness(input: {
  readonly envelope: ProfileCatalogEnvelope;
  readonly roleId: string;
}): Harness {
  const { rt } = createTestRuntime();
  const caller = countingModel('m-default');
  const deepV1 = countingModel('m-deep-v1');
  const deepV2 = countingModel('m-deep-v2');
  const resolvedSpecs: string[] = [];
  const fork: AgentsForkDeps = {
    rt,
    model: caller.model,
    // Branching on the three specs this fixture declares rather than a lookup
    // table, so an unexpected spec is a named failure instead of an undefined.
    resolveModel: (spec) => {
      resolvedSpecs.push(spec);
      if (spec === 'm-default') return caller.model;
      if (spec === 'm-deep-v1') return deepV1.model;
      if (spec === 'm-deep-v2') return deepV2.model;
      throw new Error(`test fixture has no model for ${spec}`);
    },
  };
  const profile = (): AgentsProfileContext => ({
    envelope: input.envelope,
    provider: PROVIDER,
    roleId: input.roleId,
    availableTools: [],
  });
  const deps: AgentsToolDeps = { mode: 'build', fork, profile };
  const entry = createAgentsTool(deps);
  if (!entry) throw new Error('Expected the agents tool to be created');
  return {
    execute: toolExecute<AgentsToolInput, JsonObject>(entry),
    rt,
    resolvedSpecs,
    callerCalls: caller.calls,
    deepV1Calls: deepV1.calls,
    deepV2Calls: deepV2.calls,
  };
}

/** The options bag a re-driven durable job arrives with. The marker is a
 *  property of the CALL, because the input IS the stored row. */
const REDRIVE = { toolCallId: 'tc-redrive', messages: [], [RESUME_REDRIVE_OPTION]: true };

const RoutedResultSchema = v.object({
  preset: v.string(),
  caps: v.object({ branches: v.object({ value: v.number(), origin: v.string() }) }),
  profile: v.object({
    profile: v.object({ tier: v.object({ id: v.string(), model: v.string() }) }),
    sources: v.object({ tierSource: v.string(), presetSource: v.string() }),
  }),
});
const RefusalSchema = v.object({ reason: v.string(), error: v.string() });

/** The profile a first attempt would have frozen, built through the REAL
 *  resolver against the v1 catalog — a hand-written snapshot would only prove
 *  the reader reads back whatever this test wrote into it. */
function frozenSnapshot(roleId: string): SwarmProfileSnapshot {
  const resolved: ResolvedTurnProfile = resolveTurnProfile({
    envelope: envelopeOf(TIERS_V1, 1),
    provider: PROVIDER,
    roleId,
    explicitTier: 'deep',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
  return {
    profile: resolved,
    sources: { roleSource: 'caller', tierSource: resolved.tier.source, presetSource: 'role_default' },
  };
}

/** One interrupted swarm, in the state a first attempt leaves when its host
 *  dies: a `running` ledger row whose config carries the frozen profile, and the
 *  root tree row the attempt had already written. Both halves matter — a
 *  re-entry adopts the existing root rather than minting one, so a ledger row
 *  with no tree behind it is not a resumable search. */
function seedInterruptedRun(input: {
  readonly rt: AgentRuntime;
  readonly task: string;
  readonly roleId: string;
}): string {
  const { sql, execRaw } = input.rt.storage;
  initMctsSearchTable(execRaw, sql);
  initSearchTables(execRaw, sql);
  const rootId = `root-${input.roleId}`;
  new MctsSearchStore(sql).begin({
    rootId,
    task: input.task,
    engine: 'swarm',
    rootMsgId: null,
    config: { budget: 4, branches: 1, profile: frozenSnapshot(input.roleId) },
    budget: 4,
    now: Date.now(),
  });
  insertSearchNode(sql, {
    nodeId: rootId, parentNodeId: null, parentMsgId: null, rootId,
    task: input.task, action: '', observation: input.task,
    codeUsed: null, depth: 0, msgId: null,
  });
  return rootId;
}

describe('a delegated tier routes the model its nodes run', () => {
  test('the deep tier\'s own model does the work, and the ledger names that model', async () => {
    const h = harness({ envelope: envelopeOf(TIERS_V1, 1), roleId: 'lead' });
    const result = v.parse(RoutedResultSchema, await h.execute({
      action: 'swarm',
      preset: 'ideate',
      task: 'three ways to shrink the cold start',
      tier: 'deep',
      branches: 2,
      depth: 1,
    }));

    // ROUTED. The tier's model served every node call and the caller's served
    // none — the assertion that fails on a runner passing `deps.model` down.
    expect(h.resolvedSpecs).toEqual(['m-deep-v1']);
    expect(h.deepV1Calls()).toBeGreaterThan(0);
    expect(h.callerCalls()).toBe(0);

    // AND THE RECORD AGREES. The same model in the snapshot the run returns and
    // in the ledger row a later re-drive reads. This pairing is what was broken:
    // the row said `m-deep-v1` while `m-default` did the work, so both the spend
    // and the provenance named a model that never ran.
    expect(result.profile.profile.tier).toEqual({ id: 'deep', model: 'm-deep-v1' });
    expect(result.profile.sources.tierSource).toBe('explicit');
    const [row] = h.rt.storage.sql<{ root_id: string }>`
      SELECT root_id FROM mcts_search_runs WHERE engine = 'swarm' LIMIT 1`;
    expect(row).toBeDefined();
    if (!row) return;
    const stored = new MctsSearchStore(h.rt.storage.sql).readSwarmProfile(row.root_id);
    expect(stored?.profile.tier.model).toBe('m-deep-v1');
  }, 30_000);

  test('a role\'s own tier routes without the caller naming one', async () => {
    // `auditor` declares tier `deep`, and nothing in this call says so. The
    // provenance has to report role-derived rather than flatten it to explicit.
    const h = harness({ envelope: envelopeOf(TIERS_V1, 1), roleId: 'auditor' });
    const result = v.parse(RoutedResultSchema, await h.execute({
      action: 'swarm',
      preset: 'ideate',
      task: 'where does this design break',
      branches: 1,
      depth: 1,
    }));
    expect(h.resolvedSpecs).toEqual(['m-deep-v1']);
    expect(h.deepV1Calls()).toBeGreaterThan(0);
    expect(h.callerCalls()).toBe(0);
    expect(result.profile.sources.tierSource).toBe('role');
  }, 30_000);

  test('an unrouted actor — no catalog — still runs its nodes on the caller\'s model', async () => {
    // The honest unrouted case, kept working: no profile authority means no tier
    // to route to, so the seam is never consulted and nothing refuses.
    const { rt } = createTestRuntime();
    const caller = countingModel('m-default');
    const entry = createAgentsTool({ mode: 'build', fork: { rt, model: caller.model } });
    if (!entry) throw new Error('Expected the agents tool to be created');
    const result = v.parse(v.object({ preset: v.string() }), await toolExecute<AgentsToolInput, unknown>(entry)({
      action: 'swarm', preset: 'ideate', task: 'anything', branches: 1, depth: 1,
    }));
    expect(result.preset).toBe('ideate');
    expect(caller.calls()).toBeGreaterThan(0);
  }, 30_000);
});

describe('a re-drive continues under the profile it started under', () => {
  const task = 'audit the retry path for lost work';

  test('a catalog edit between the interruption and the re-drive changes nothing', async () => {
    // TODAY's catalog points `deep` at m-deep-v2, and the tool is wired with it.
    // The only thing keeping this run on m-deep-v1 is that a re-drive reads its
    // frozen row instead of resolving again.
    const h = harness({ envelope: envelopeOf(TIERS_V2, 2), roleId: 'lead' });
    seedInterruptedRun({ rt: h.rt, task, roleId: 'lead' });

    const result = v.parse(RoutedResultSchema, await h.execute({
      action: 'swarm', task, branches: 1, depth: 1,
    }, REDRIVE));

    expect(h.resolvedSpecs).toEqual(['m-deep-v1']);
    expect(h.deepV1Calls()).toBeGreaterThan(0);
    expect(h.deepV2Calls()).toBe(0);
    expect(h.callerCalls()).toBe(0);
    expect(result.profile.profile.tier.model).toBe('m-deep-v1');
  }, 30_000);

  test('the stored role\'s preset selects the axes, not the literal fallback', async () => {
    // PAIRED, because either half alone proves nothing. The two calls are
    // byte-identical — same task, no `preset`, no `objective`, same re-drive
    // marker — and differ ONLY in the role on the interrupted row they claim.
    //
    // `lead`'s default is `ideate`, scored `none`. `auditor`'s is `audit`, which is
    // scored `verify` and, with nothing to measure, resolves to its judged sweep. So
    // the outcome names which preset was resolved, and before this fix both calls took
    // `ideate` and both ran.
    //
    // THE DISCRIMINATOR MOVED and the property did not. It used to be `audit`'s
    // `score:"verify"` REFUSAL, which is gone: a named preset with no objective is a
    // legal call now, so `audit` re-drives into a judged sweep instead of a scolding.
    // What still separates the two presets is that one of them ASKS A JUDGE — this
    // harness scripts a model that returns nothing parseable, so the ensemble comes
    // back empty and the run faults on its scorer. `ideate` is scored `none` and can
    // never produce that, which is exactly the asymmetry the pair needs.
    const stored = harness({ envelope: envelopeOf(TIERS_V2, 2), roleId: 'lead' });
    seedInterruptedRun({ rt: stored.rt, task, roleId: 'auditor' });
    const refusal = v.parse(RefusalSchema, await stored.execute({
      action: 'swarm', task,
    }, REDRIVE));
    expect(refusal.reason).toBe('unavailable');
    expect(refusal.error).toContain('the judge faulted while scoring');

    const flat = harness({ envelope: envelopeOf(TIERS_V2, 2), roleId: 'lead' });
    seedInterruptedRun({ rt: flat.rt, task, roleId: 'lead' });
    const result = v.parse(RoutedResultSchema, await flat.execute({
      action: 'swarm', task,
    }, REDRIVE));
    expect(result.preset).toBe('ideate');
    // The preset carries its own width, and nothing in the call named a number:
    // `ideate` fans 5. A preset read off the stored role brings its caps with it.
    expect(result.caps.branches).toEqual({ value: 5, origin: 'preset' });
  }, 60_000);

  test('the stored profile is readable before the claim, and only for a running row', () => {
    // The reader the preset derivation depends on. It has to answer BEFORE
    // `reenterSwarm` claims the row, because the axes resolve first — and it
    // must make the same choice of row, or a preset from one row would drive a
    // tree re-entered from another.
    const { rt } = createTestRuntime();
    initMctsSearchTable(rt.storage.execRaw, rt.storage.sql);
    expect(readStartedSwarmProfile(rt.storage, task)).toBeNull();

    seedInterruptedRun({ rt, task, roleId: 'auditor' });
    expect(readStartedSwarmProfile(rt.storage, task)?.profile.defaultPreset).toBe('audit');
    // Task-keyed, like the claim itself: another task's re-drive sees nothing.
    expect(readStartedSwarmProfile(rt.storage, 'some other task')).toBeNull();

    // Settled rows are not re-entered, so their profile is not offered either.
    new MctsSearchStore(rt.storage.sql).converge('root-auditor', 0, Date.now());
    expect(readStartedSwarmProfile(rt.storage, task)).toBeNull();
  });
});
