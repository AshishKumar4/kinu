// Head containment, asserted on buildHeadToolSet's real output: a head forks its parent's exec planes and
// files but never its authority to create actors; `split_subheads` (depth-budgeted) is the only spawn route.
import { describe, expect, test } from 'bun:test';
import { createTestActorsOver, createTestRuntime, createTestSql, toolExecute } from '@kinu.run/test-utils';
import { tool, jsonSchema } from 'ai';
import { hostedExplorationHarness, orchestratorHarness, rpcReachableFrom, workspaceMainActor } from './helpers/actor-harness';
import { isAgentRpcMethod } from '../src/cli/rpc-gate';
import { hostBranch } from '../src/exploration-hosting';
import {
  HeadCapture,
  HeadController,
  HeadJournal,
  agentHome,
  buildHeadSystemPrompt,
  headAgentName,
  parseActorKey,
  initHeadsTables,
  type HeadInput,
  type HeadReport,
  type HeadRuntime,
  type MergeOutput,
  type WebSearchProvider,
} from '@kinu.run/core';
import { HEAD_BUILTIN_TOOLS, buildHeadToolSet, type HeadSplitRequest, type HeadSplitResult } from '@kinu.run/core';

function report(id: string): HeadReport {
  return {
    id,
    status: 'completed',
    summary: `completed ${id}`,
    evidence: [],
    decisions: [],
    artifactRefs: [],
    fileChanges: [],
    childHeadIds: [],
    toolCalls: [],
    stepCount: 0,
    usage: { input: 1, output: 1 },
    wallClockMs: 1,
  };
}

const mergeOutput: MergeOutput = {
  narrative: 'merged child findings',
  selected_decisions: [],
  unresolved_questions: [],
  recommendations: [],
  blind_spots: [],
};

const noopWebSearch: WebSearchProvider = {
  search: async (query: string) => ({ query, results: [], source: 'duckduckgo' }),
  fetch: async (url: string) => ({ url, markdown: '', retrievedAt: new Date(0).toISOString() }),
};

interface SplitToolInput {
  rationale: string;
  heads: Array<{ task: string; rationale: string }>;
  merge_strategy?: 'synthesize' | 'best_of' | 'consensus';
}

function headInput(overrides?: Partial<HeadInput>): HeadInput {
  return {
    id: 'head-1', rootId: 'root-1', parentId: null, depth: 0,
    task: 'study the cloned repo', rationale: 'the parser angle',
    inheritedContext: [],
    budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    // A fork explores under the loop it forks from; a fresh bootstrap loop measures the wrong program.
    loop: { kind: 'inherit' },
    mergeStrategy: 'synthesize',
    ...overrides,
    mode: overrides?.mode ?? 'build',
  };
}

function buildSurface(opts?: {
  input?: HeadInput;
  split?: (request: HeadSplitRequest) => Promise<HeadSplitResult>;
}) {
  const { rt, stores } = createTestRuntime();
  const capture = new HeadCapture();

  const codemodeTool = tool({ description: 'eval', inputSchema: jsonSchema<{ code: string }>({
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
  }), execute: async () => 'ran' });

  const tools = buildHeadToolSet({
    input: opts?.input ?? headInput(),
    capture,
    rt,
    history: stores.history,
    codemodeTool,
    webSearch: noopWebSearch,
    split: opts?.split ?? (async () => ({
      narrative: 'merged', decisions: [], unresolvedQuestions: [], blindSpots: [], childHeadIds: [], headCount: 0,
    })),
  });

  return { tools, capture };
}

function countingSplit(
  calls: { splits: number },
  result: { narrative: string; headCount: number },
): (request: HeadSplitRequest) => Promise<HeadSplitResult> {
  return async () => {
    calls.splits++;

    return {
      narrative: result.narrative, decisions: [], unresolvedQuestions: [], blindSpots: [],
      childHeadIds: [], headCount: result.headCount,
    };
  };
}

describe('head tool surface — containment', () => {
  test('a head has no think / team / peers / report / release tool', () => {
    const { tools } = buildSurface();

    for (const forbidden of ['think', 'team', 'peers', 'report', 'release']) {
      expect(Object.keys(tools)).not.toContain(forbidden);
    }
  });

  test('split_subheads is the only tool that can start anything', () => {
    const { tools } = buildSurface();
    expect(tools.split_subheads).toBeDefined();
    const spawnCapable = Object.keys(tools).filter((name) => /split|spawn|subordinate|delegate/i.test(name));
    expect(spawnCapable).toEqual(['split_subheads']);
  });

  test('the surface is exactly the declared allow-list plus the head-only tools', () => {
    const { tools } = buildSurface();
    expect(Object.keys(tools).sort()).toEqual([
      ...HEAD_BUILTIN_TOOLS,
      'record_evidence', 'record_decision', 'split_subheads',
    ].sort());
  });

  test('a head reaches the real workspace: eval and run are present', () => {
    const { tools } = buildSurface();
    expect(tools.eval).toBeDefined();
    expect(tools.shell).toBeDefined();

    for (const gone of ['sandbox_exec', 'sandbox_read', 'sandbox_write', 'sandbox_list']) {
      expect(Object.keys(tools)).not.toContain(gone);
    }
  });

  test('split_subheads is not on the surface at all once the depth budget is spent', async () => {
    // Depth is fixed for the run, so the tool could only ever refuse.
    const { tools } = buildSurface({
      input: headInput({ budget: { maxDepth: 0, maxWallClockMs: 60_000, spawnedAt: Date.now() } }),
    });

    expect(tools.split_subheads).toBeUndefined();

    for (const name of HEAD_BUILTIN_TOOLS) expect(tools[name]).toBeDefined();
  });

  test('the surface states the depth that is actually left', async () => {
    const { tools } = buildSurface({
      input: headInput({ budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() } }),
    });

    expect(tools.split_subheads?.description).toContain('2 more level(s)');
  });

  test('split_subheads refuses once a caller-requested deadline has passed, and records the refusal', async () => {
    // Wall-clock can pass mid-run, unlike depth, so the tool stays and refuses when called.
    const calls = { splits: 0 };

    const { tools, capture } = buildSurface({
      input: headInput({ budget: { maxDepth: 3, maxWallClockMs: 50, spawnedAt: Date.now() - 5_000 } }),
      split: countingSplit(calls, { narrative: '', headCount: 0 }),
    });

    const split = toolExecute<SplitToolInput, string>(tools.split_subheads);
    await expect(split({ rationale: 'go deeper', heads: [{ task: 'a', rationale: 'a' }, { task: 'b', rationale: 'b' }] }))
      .rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('budget exhausted (wall-clock)') });
    expect(calls.splits).toBe(0);
    expect(capture.toolCalls).toHaveLength(1);
    const refusal = capture.toolCalls.at(0);

    if (!refusal) throw new Error('Expected split refusal to be recorded');
    expect(refusal.name).toBe('split_subheads');
    expect(refusal.result).toContain('wall-clock');
    expect(refusal.outcome).toEqual({ success: false, reason: 'denied' });
  });

  test('split_subheads is NOT refused for spend — a long-running head may still split', async () => {
    const calls = { splits: 0 };

    const { tools, capture } = buildSurface({
      input: headInput({ budget: { maxDepth: 3, spawnedAt: Date.now() - 60 * 60_000 } }),
      split: countingSplit(calls, { narrative: 'merged', headCount: 2 }),
    });

    capture.recordStepUsage({ input: 2_000_000, output: 500_000 });
    const split = toolExecute<SplitToolInput, string>(tools.split_subheads);
    await split({
      rationale: 'go deeper',
      heads: [{ task: 'a', rationale: 'a' }, { task: 'b', rationale: 'b' }],
    });
    expect(calls.splits).toBe(1);
  });

  test('allowedTools narrows the surface further, never widens it', () => {
    const { tools } = buildSurface({ input: headInput({ allowedTools: ['shell', 'record_evidence', 'think'] }) });
    expect(Object.keys(tools).sort()).toEqual(['record_evidence', 'shell']);
  });

  test('builtin tool calls land in the HeadCapture so the report keeps them', async () => {
    const { tools, capture } = buildSurface();
    const execute = toolExecute<{ code: string }, string>(tools.eval);
    await execute({ code: 'return 1' });
    expect(capture.toolCalls).toEqual([{ toolCallId: 'test-tool-call', name: 'eval', args: { code: 'return 1' }, result: 'ran', outcome: { success: true } }]);
  });

  test('the head prompt describes the real workspace it was given', () => {
    const { tools } = buildSurface();
    const prompt = buildHeadSystemPrompt(headInput(), Object.keys(tools));
    expect(prompt).toContain('workspace.exec');
    expect(prompt).not.toContain('`parent.*`');
    expect(prompt).not.toContain('sandbox_exec');
  });
});

/** Where an exploration actor's trace lands and what a rollout branch may touch (C2: one journal per subtree). */
describe('exploration actors write the workspace journal and acquire only their own plane', () => {
  test("a head's step trace lands in the workspace's journal, under the workspace's own actor", async () => {
    const workspace = orchestratorHarness();
    const head = await hostedExplorationHarness(workspace, 'head', 'head-1');
    const root = workspaceMainActor(workspace.db).actorId;
    // Distinct actors: a step filed under the head's own id would be invisible to the subtree's journal readers.
    expect(head.actor.handle.actorId).not.toBe(root);

    await workspace.agent.observeExplorationSeams().recordStep('head-1', 1, {
      text: 'read the parser', toolCalls: [],
    });

    // Unscoped on purpose: a read filtered by the expected actor would pass on a row filed under the wrong owner.
    const rows = workspace.db.prepare<{ actor_id: string; head_id: string; text: string }, []>(
      'SELECT actor_id, head_id, text FROM head_steps',
    ).all();

    expect(rows).toEqual([{ actor_id: root, head_id: 'head-1', text: 'read the parser' }]);
  });

  test('a rollout branch reasons through the caller\'s model seam and is given no plane to act on', async () => {
    const workspace = orchestratorHarness();
    const asked: string[] = [];
    // `register` is idempotent per creation id, so seat and branch handle bind one actor.
    const branchRecord = (await hostedExplorationHarness(workspace, 'branch', 'branch-1')).actor.record;

    const branch = await hostBranch(workspace.agent.observeExplorationSeams(), 'branch-1', {
      explorePrompt: ({ context }) => ({ system: 'score this rollout', user: `context: ${context}` }),
      reflectionPrompt: (task, traces) => `why did ${task} score badly after ${traces}`,
      complete: async (request) => {
        asked.push(request.user);

        return { text: 'the parser branch looks promising' };
      },
    });

    const answer = await branch.explore({
      priorHistory: [{ role: 'user', content: 'probe the parser' }],
      craftedTools: [],
      languages: ['typescript'],
      mode: 'build',
    });

    expect(answer.text).toBe('the parser branch looks promising');
    expect(asked).toEqual(['context: user: probe the parser']);
    // `hostedHomeKind` is null for a branch, while a head gets home and credential; asserted as a pair so
    // "no directory" cannot hold trivially. Keyed off the storage key the directory issued.
    const head = await hostedExplorationHarness(workspace, 'head', 'head-2');
    const headHome = agentHome(headAgentName(parseActorKey(head.actor.record.storageKey).id));
    const branchHome = agentHome(headAgentName(parseActorKey(branchRecord.storageKey).id));
    expect(await workspace.agent.statWorkspaceFile(headHome))
      .toMatchObject({ ok: true, value: expect.objectContaining({ isDir: true }) });
    expect(await workspace.agent.statWorkspaceFile(branchHome))
      .toMatchObject({ ok: true, value: null });
    await branch.release();
  });
});

/**
 * Containment rides the actor (`actor_id` in every scoped key, per-statement handle checks, release fence):
 * see the actor-scoping suites, `unit-rpc-surface.test.ts` and `tests/workerd/plan-announce-probe.ts`.
 */

describe('recursive split budget', () => {
  test('the controller decrements maxDepth for spawned subheads', async () => {
    const { db, sql } = createTestSql();
    const actor = createTestActorsOver(db).main;
    initHeadsTables((ddl) => db.exec(ddl));
    const spawned: HeadInput[] = [];

    const runtime: HeadRuntime = {
      async spawnHead(input) {
        spawned.push(input);

        return {
          id: input.id,
          async run() { return report(input.id); },
          async abort() {},
        };
      },
      async mergeLLM() { return mergeOutput; },
    };

    const controller = new HeadController(runtime, new HeadJournal(sql, actor));

    await controller.run({
      parentHeadId: 'parent-head',
      parentDepth: 0,
      rootId: 'root-head',
      inheritedContext: [],
      mode: 'build',
      request: {
        rationale: 'split the investigation',
        heads: [
          { task: 'child one', rationale: 'first angle' },
          { task: 'child two', rationale: 'second angle' },
        ],
      },
      parentBudget: {
        maxDepth: 2,
        maxWallClockMs: 60_000,
        spawnedAt: Date.now(),
      },
    });

    expect(spawned).toHaveLength(2);
    expect(spawned.map((input) => input.budget.maxDepth)).toEqual([1, 1]);
    expect(spawned.map((input) => input.depth)).toEqual([1, 1]);
  });
});

describe('the mission ledger bounds a hosted head', () => {
  // A head has no execution cap of its own, so the mission budget is the only bound on a fork.

  test('an unbudgeted head is given no ledger at all, and a budgeted one is given its own labels', () => {
    const seams = orchestratorHarness().agent.observeExplorationSeams();
    // Null, not an inert port: an undeclared run must not touch the table.
    expect(seams.mission(headInput())).toBeNull();
    // The denominator: without it the null above holds for a seam that always answers null.
    const scoped = seams.mission(headInput({ missionLabels: ['q3-migration'] }));
    expect(scoped?.labels).toEqual(['q3-migration']);
  });

  test('the port charges the ledger of the actor that declared the budget', async () => {
    const workspace = orchestratorHarness();

    const scoped = workspace.agent.observeExplorationSeams()
      .mission(headInput({ missionLabels: ['q3-migration'] }));

    if (!scoped) throw new Error('a head with labels is given a mission port');

    // The debit lands on this workspace's own ledger; a closure over a released or foreign handle throws on `assertCurrent`.
    expect(await scoped.port.guard('model_call', scoped.labels)).toBeNull();
    await scoped.port.debit(120, { labels: scoped.labels, calls: 1 });
    expect(await scoped.port.guard('model_call', scoped.labels)).toBeNull();
  });

  test('the two ledger members serve a sibling object and never a public transport', () => {
    // A spend ledger must not become writable over the public WS/HTTP transport, yet a hosted head's
    // object charges it over the DO stub.
    const { agent } = orchestratorHarness();

    for (const method of ['missionGuard', 'missionDebit']) {
      expect(rpcReachableFrom(agent)).toContain(method);
      expect(isAgentRpcMethod(method)).toBe(false);
    }
  });
});
