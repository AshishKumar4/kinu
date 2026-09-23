// A delegation's resolved role and tier reach the work, and the ledger row names the model
// that actually ran, including on re-drive from the frozen snapshot.
import { describe, test, expect } from 'bun:test';
import { createJSONLLM, createTestRuntime, toolExecute, scriptedTurnModel } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';
import type { MockLanguageModelV3 } from 'ai/test';
import type { ToolExecutionOptions } from 'ai';
import * as v from 'valibot';
import { RESUME_REDRIVE_OPTION } from '../src/jobs/index';
import { initMctsSearchTable, MctsSearchStore } from '../src/mcts/search-store';
import { initSearchTables } from '../src/mcts/schemas';
import { insertSearchNode } from '../src/mcts/record-node';
import { readStartedSwarmProfile } from '../src/strategy/swarm-resume';
import { configDigestOf, resolveSwarm } from '../src/strategy/swarm';
import {
  createAgentsTool, profileCatalogDigest, resolveTurnProfile,
  type AgentsSwarmDeps, type AgentsProfileContext, type AgentsToolDeps, type AgentsToolInput,
  type ProfileCatalogEnvelope, type ProviderCatalogSnapshot, type ResolvedTurnProfile,
  type RoleDefinition, type SwarmProfileSnapshot, type TierAssignments,
} from '../src/index';
import type { JsonObject } from '../src/utils/json';
import type { AgentRuntime } from '../src/types/agent-runtime';

/** `default` is the caller's own turn; `deep` is what a delegation must reach. */
const TIERS_V1: TierAssignments = {
  default: { model: 'm-default' },
  deep: { model: 'm-deep-v1' },
};

/** `deep` re-pointed; an in-flight search must not notice. */
const TIERS_V2: TierAssignments = {
  default: { model: 'm-default' },
  deep: { model: 'm-deep-v2' },
};

const LEAD: RoleDefinition = {
  description: 'Runs the room.',
  instructions: 'Delegate.',
  tier: 'default',
  preset: 'ideate',
  spawns: '*',
};

/** Scored `verify`, which makes the stored preset observable. */
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

/** Counted in `doGenerate`: toolless nodes complete and agent nodes stream. */
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
  readonly execute: (input: AgentsToolInput, options?: ToolExecutionOptions) => Promise<JsonObject>;
  readonly rt: AgentRuntime;
  readonly resolvedSpecs: string[];
  readonly callerCalls: () => number;
  readonly deepV1Calls: () => number;
  readonly deepV2Calls: () => number;
}

function harness(input: {
  readonly envelope: ProfileCatalogEnvelope;
  readonly roleId: string;
}): Harness {
  const { rt, testSql } = createTestRuntime({ llm: createJSONLLM('a verdict in prose, not a score') });
  const caller = countingModel('m-default');
  const deepV1 = countingModel('m-deep-v1');
  const deepV2 = countingModel('m-deep-v2');
  const resolvedSpecs: string[] = [];

  const swarm: AgentsSwarmDeps = {
    rt,
    hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode,
    model: caller.model,
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

  const deps: AgentsToolDeps = { mode: 'build', swarm, profile };
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

/** The re-drive marker is a property of the call: the input is the stored row. */
const REDRIVE = { toolCallId: 'tc-redrive', messages: [], [RESUME_REDRIVE_OPTION]: true };

const RoutedResultSchema = v.object({
  preset: v.string(),
  caps: v.object({ branches: v.object({ value: v.number(), origin: v.string() }) }),
  profile: v.object({
    profile: v.object({ tier: v.object({ id: v.string(), model: v.string() }) }),
    sources: v.object({ tierSource: v.string(), presetSource: v.string() }),
  }),
});

/** Built through the real resolver, so the reader is not just echoing the test. */
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

/** A re-entry adopts the existing root, so a ledger row with no tree is not resumable. */
function seedInterruptedRun(input: {
  readonly rt: AgentRuntime;
  readonly task: string;
  readonly roleId: string;
}): string {
  const { sql, execRaw } = input.rt.storage;
  initMctsSearchTable(execRaw);
  initSearchTables(execRaw);
  const rootId = `root-${input.roleId}`;
  new MctsSearchStore(sql, input.rt.actor).begin({
    rootId,
    task: input.task,
    engine: 'swarm',
    rootMsgId: null,
    config: { budget: 4, branches: 1, profile: frozenSnapshot(input.roleId) },
    budget: 4,
    now: Date.now(),
  });
  insertSearchNode(sql, input.rt.actor, {
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

    expect(h.resolvedSpecs).toEqual(['m-deep-v1']);
    expect(h.deepV1Calls()).toBeGreaterThan(0);
    expect(h.callerCalls()).toBe(0);

    expect(result.profile.profile.tier).toEqual({ id: 'deep', model: 'm-deep-v1' });
    expect(result.profile.sources.tierSource).toBe('explicit');

    const [row] = h.rt.storage.sql<{ root_id: string }>`
      SELECT root_id FROM mcts_search_runs
      WHERE actor_id = ${h.rt.actor.actorId} AND engine = 'swarm' LIMIT 1`;

    expect(row).toBeDefined();

    if (!row) return;
    const stored = new MctsSearchStore(h.rt.storage.sql, h.rt.actor).readSwarmProfile(row.root_id);
    expect(stored?.profile.tier.model).toBe('m-deep-v1');
  });

  test('a role\'s own tier routes without the caller naming one', async () => {
    // Provenance must say role-derived, not explicit.
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
  });

  test('an unrouted actor — no catalog — still runs its nodes on the caller\'s model', async () => {
    const { rt, testSql } = createTestRuntime();
    const caller = countingModel('m-default');

    const entry = createAgentsTool({
      mode: 'build',
      swarm: { rt, hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode, model: caller.model },
    });

    if (!entry) throw new Error('Expected the agents tool to be created');

    const result = v.parse(v.object({ preset: v.string() }), await toolExecute<AgentsToolInput, unknown>(entry)({
      action: 'swarm', preset: 'ideate', task: 'anything', branches: 1, depth: 1,
    }));

    expect(result.preset).toBe('ideate');
    expect(caller.calls()).toBeGreaterThan(0);
  });
});

describe('a re-drive continues under the profile it started under', () => {
  const task = 'audit the retry path for lost work';

  test('a catalog edit between the interruption and the re-drive changes nothing', async () => {
    // Only the frozen row keeps this run on m-deep-v1.
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
  });

  test('the stored role\'s preset selects the axes, not the literal fallback', async () => {
    // Calls identical except the row's role: `lead` defaults to `ideate`, `auditor` to `audit`,
    // and only `audit` asks this harness's unparseable judge and faults.
    const stored = harness({ envelope: envelopeOf(TIERS_V2, 2), roleId: 'lead' });
    seedInterruptedRun({ rt: stored.rt, task, roleId: 'auditor' });
    const pending = stored.execute({ action: 'swarm', task }, REDRIVE);
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await expect(pending).rejects.toThrow('the judge faulted while scoring');

    const flat = harness({ envelope: envelopeOf(TIERS_V2, 2), roleId: 'lead' });
    seedInterruptedRun({ rt: flat.rt, task, roleId: 'lead' });

    const result = v.parse(RoutedResultSchema, await flat.execute({
      action: 'swarm', task,
    }, REDRIVE));

    expect(result.preset).toBe('ideate');
    expect(result.caps.branches).toEqual({ value: 5, origin: 'preset' });
  });

  test('the stored profile is readable before the claim, and only for a running row', () => {
    // Must pick the same row `reenterSwarm` claims, before it claims it.
    const { rt } = createTestRuntime();
    initMctsSearchTable(rt.storage.execRaw);
    expect(readStartedSwarmProfile(rt.storage, rt.actor, task)).toBeNull();

    seedInterruptedRun({ rt, task, roleId: 'auditor' });
    expect(readStartedSwarmProfile(rt.storage, rt.actor, task)?.profile.defaultPreset).toBe('audit');
    expect(readStartedSwarmProfile(rt.storage, rt.actor, 'some other task')).toBeNull();

    new MctsSearchStore(rt.storage.sql, rt.actor).converge('root-auditor', 0, Date.now());
    expect(readStartedSwarmProfile(rt.storage, rt.actor, task)).toBeNull();
  });
});

/** `scriptedTurnModel` answers `answered by <modelId>`, so a node names its model. */
const PerNodeResultSchema = v.object({
  preset: v.string(),
  caps: v.object({ branches: v.object({ value: v.number(), origin: v.string() }) }),
  candidates: v.array(v.object({
    id: v.string(),
    artifact: v.string(),
    score: v.nullable(v.number()),
  })),
});

function perNodeHarness() {
  const { rt, testSql } = createTestRuntime();
  const caller = countingModel('m-default');
  const a = countingModel('m-alpha');
  const b = countingModel('m-beta');
  const resolvedSpecs: string[] = [];

  const swarm: AgentsSwarmDeps = {
    rt,
    hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode,
    model: caller.model,
    resolveModel: (spec) => {
      resolvedSpecs.push(spec);

      if (spec === 'm-alpha') return a.model;

      if (spec === 'm-beta') return b.model;

      if (spec === 'm-default') return caller.model;
      throw new Error(`test fixture has no model for ${spec}`);
    },
  };

  const deps: AgentsToolDeps = { mode: 'build', swarm };
  const entry = createAgentsTool(deps);

  if (!entry) throw new Error('Expected the agents tool to be created');

  return {
    execute: toolExecute<AgentsToolInput, JsonObject>(entry),
    resolvedSpecs,
    aCalls: a.calls,
    bCalls: b.calls,
    callerCalls: caller.calls,
  };
}

describe('`models` routes each node to its own assigned model', () => {
  test('the default is unchanged: no field, one model for all nodes, seam never asked', async () => {
    const h = perNodeHarness();

    const result = v.parse(PerNodeResultSchema, await h.execute({
      action: 'swarm', preset: 'ideate', task: 'three angles on the cold start',
      branches: 2, depth: 1,
    }));

    expect(result.candidates).toHaveLength(2);
    expect(h.resolvedSpecs).toEqual([]);
    expect(h.callerCalls()).toBeGreaterThanOrEqual(2);
    expect(h.aCalls()).toBe(0);
    expect(h.bCalls()).toBe(0);
  });

  test('a supplied list routes each node to its assigned resolved model, by slot', async () => {
    const h = perNodeHarness();

    const result = v.parse(PerNodeResultSchema, await h.execute({
      action: 'swarm', preset: 'ideate', task: 'recon then synthesis',
      models: ['m-alpha', 'm-beta'],
      branches: 4, depth: 1,
    }));

    expect(result.candidates).toHaveLength(4);
    // Resolved once per spec, before any node runs.
    expect(h.resolvedSpecs).toEqual(['m-alpha', 'm-beta']);
    expect(h.aCalls()).toBeGreaterThanOrEqual(2);
    expect(h.bCalls()).toBeGreaterThanOrEqual(2);
    expect(h.callerCalls()).toBe(0);
    const byModel = result.candidates.map((candidate) => candidate.artifact);
    expect(byModel.filter((text) => text.includes('m-alpha'))).toHaveLength(2);
    expect(byModel.filter((text) => text.includes('m-beta'))).toHaveLength(2);
  });

  test('a list shorter than the wave wraps, and one longer than it truncates', async () => {
    // The list need not match `branches`.
    const one = perNodeHarness();

    const oneResult = v.parse(PerNodeResultSchema, await one.execute({
      action: 'swarm', preset: 'ideate', task: 'one model everywhere',
      models: ['m-alpha'], branches: 3, depth: 1,
    }));

    expect(oneResult.candidates).toHaveLength(3);
    expect(one.aCalls()).toBeGreaterThanOrEqual(3);
    expect(one.bCalls()).toBe(0);
    expect(one.callerCalls()).toBe(0);
    const long = perNodeHarness();

    const longResult = v.parse(PerNodeResultSchema, await long.execute({
      action: 'swarm', preset: 'ideate', task: 'a wide list on a narrow wave',
      models: ['m-alpha', 'm-beta', 'm-default', 'm-alpha', 'm-beta'],
      branches: 2, depth: 1,
    }));

    expect(longResult.candidates).toHaveLength(2);
    expect(long.resolvedSpecs).toEqual(['m-alpha', 'm-beta', 'm-default', 'm-alpha', 'm-beta']);
    expect(long.aCalls()).toBeGreaterThanOrEqual(1);
    expect(long.bCalls()).toBeGreaterThanOrEqual(1);
  });

  test('an unresolvable spec is refused by name, before any node runs', async () => {
    const h = perNodeHarness();

    const pending = h.execute({ action: 'swarm', preset: 'ideate', task: 'refuse me cleanly',
      models: ['m-alpha', 'm-ghost'], branches: 2, depth: 1 });

    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow('m-ghost');
    await expect(pending).rejects.toThrow('models');
    expect(h.aCalls()).toBe(0);
    expect(h.bCalls()).toBe(0);
    expect(h.callerCalls()).toBe(0);
    expect(h.resolvedSpecs).toEqual(['m-alpha', 'm-ghost']);
  });

  test('naming models and tier together is refused rather than resolved by precedence', async () => {
    const h = harness({ envelope: envelopeOf(TIERS_V1, 1), roleId: 'lead' });

    const pending = h.execute({ action: 'swarm', preset: 'ideate', task: 'two routing decisions',
      models: ['m-alpha'], tier: 'deep', branches: 1, depth: 1 });

    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow('tier');
    await expect(pending).rejects.toThrow('models');
    await expect(pending).rejects.toThrow('ignored');
  });

  test('the identity digest changes when the models change', () => {
    // The digest is the record's identity key, so routing-only differences must not collide.
    const base = { preset: 'custom' as const, label: 'digest', task: 'same task' };

    const axes = {
      unit: { kind: 'answer' as const }, context: 'fresh' as const, expand: 'sample' as const,
      score: { kind: 'none' as const }, advance: { kind: 'none' as const },
      carry: { kind: 'none' as const },
    };

    const unrouted = resolveSwarm({ ...base, config: axes, branches: 2, depth: 1 });
    const alpha = resolveSwarm({ ...base, config: axes, branches: 2, depth: 1, models: ['m-alpha'] });

    const beta = resolveSwarm({
      ...base, config: axes, branches: 2, depth: 1, models: ['m-alpha', 'm-beta'],
    });

    if ('reason' in unrouted || 'reason' in alpha || 'reason' in beta) {
      throw new Error('the digest suite\'s own composition refused to resolve');
    }

    const unroutedDigest = configDigestOf(unrouted);
    const alphaDigest = configDigestOf(alpha);
    const betaDigest = configDigestOf(beta);
    expect(unroutedDigest).not.toBe(alphaDigest);
    expect(alphaDigest).not.toBe(betaDigest);
    expect(unroutedDigest).not.toBe(betaDigest);
  });
});
