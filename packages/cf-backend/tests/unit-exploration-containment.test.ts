// Head containment — asserted against the ToolSet a head is actually handed.
//
// A head is a FORK of its parent workspace: it rides the parent's exec planes
// and reads the parent's files. What it must never gain is the parent's
// AUTHORITY to create actors — `think`, `team` and `peers` open unbounded spawn
// trees, and `split_subheads` (depth-budgeted) must stay the only spawn route.
//
// These assertions run against buildHeadToolSet's real output rather than the
// text of any class, so they keep holding when the surface is refactored and
// they catch a tool that appears through a dependency instead of a literal.
// That is now the WHOLE of head containment on this backend: a hosted head is
// not addressable over a stub at all, so what it may do is exactly what its
// ToolSet carries.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestActorsOver, createTestRuntime, createTestSql, toolExecute } from '@kinu.run/test-utils';
import { tool, jsonSchema } from 'ai';
import { hostedExplorationHarness, orchestratorHarness } from './helpers/actor-harness';
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
    // A fork explores under the loop it is forking FROM; a fresh bootstrap loop
    // would measure the wrong program.
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
  const { rt } = createTestRuntime();
  const capture = new HeadCapture();
  const executeTool = tool({ description: 'execute_tools', inputSchema: jsonSchema<{ code: string }>({
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
  }), execute: async () => 'ran' });
  const tools = buildHeadToolSet({
    input: opts?.input ?? headInput(),
    capture,
    rt,
    executeTool,
    webSearch: noopWebSearch,
    split: opts?.split ?? (async () => ({
      narrative: 'merged', decisions: [], unresolvedQuestions: [], blindSpots: [], childHeadIds: [], headCount: 0,
    })),
  });
  return { tools, capture };
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

  test('a head reaches the real workspace: execute_tools and run are present', () => {
    const { tools } = buildSurface();
    expect(tools.execute_tools).toBeDefined();
    expect(tools.run).toBeDefined();
    // The tools that lied about being a sandbox are gone — the real planes
    // are reached through execute_tools/run instead.
    for (const gone of ['sandbox_exec', 'sandbox_read', 'sandbox_write', 'sandbox_list']) {
      expect(Object.keys(tools)).not.toContain(gone);
    }
  });

  test('split_subheads is not on the surface at all once the depth budget is spent', async () => {
    // Depth is fixed for the whole run, so the tool could only ever refuse.
    // Offering it anyway spent a step to learn a limit the surface already knew.
    const { tools } = buildSurface({
      input: headInput({ budget: { maxDepth: 0, maxWallClockMs: 60_000, spawnedAt: Date.now() } }),
    });
    expect(tools.split_subheads).toBeUndefined();
    // The work tools are untouched — this removes a dead option, not capability.
    for (const name of HEAD_BUILTIN_TOOLS) expect(tools[name]).toBeDefined();
  });

  test('the surface states the depth that is actually left', async () => {
    const { tools } = buildSurface({
      input: headInput({ budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() } }),
    });
    expect(tools.split_subheads?.description).toContain('2 more level(s)');
  });

  test('split_subheads refuses once a caller-requested deadline has passed, and records the refusal', async () => {
    // Wall-clock stays a runtime check: unlike depth it can pass mid-run, so the
    // tool is present and refuses when called.
    let splits = 0;
    const { tools, capture } = buildSurface({
      input: headInput({ budget: { maxDepth: 3, maxWallClockMs: 50, spawnedAt: Date.now() - 5_000 } }),
      split: async () => { splits++; return { narrative: '', decisions: [], unresolvedQuestions: [], blindSpots: [], childHeadIds: [], headCount: 0 }; },
    });
    const split = toolExecute<SplitToolInput, string>(tools.split_subheads);
    await expect(split({ rationale: 'go deeper', heads: [{ task: 'a', rationale: 'a' }, { task: 'b', rationale: 'b' }] }))
      .rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('budget exhausted (wall-clock)') });
    expect(splits).toBe(0);
    // Unrecorded, this refusal left no trace in the journal — so how often a
    // head is stopped mid-plan could not be asked of the ledger.
    expect(capture.toolCalls).toHaveLength(1);
    const refusal = capture.toolCalls.at(0);
    if (!refusal) throw new Error('Expected split refusal to be recorded');
    expect(refusal.name).toBe('split_subheads');
    expect(refusal.result).toContain('wall-clock');
    expect(refusal.outcome).toEqual({ success: false, reason: 'denied' });
  });

  test('split_subheads is NOT refused for spend — a long-running head may still split', async () => {
    let splits = 0;
    const { tools, capture } = buildSurface({
      input: headInput({ budget: { maxDepth: 3, spawnedAt: Date.now() - 60 * 60_000 } }),
      split: async () => { splits++; return { narrative: 'merged', decisions: [], unresolvedQuestions: [], blindSpots: [], childHeadIds: [], headCount: 2 }; },
    });
    // A head an hour in that has burned 2M tokens. Neither is a reason to refuse.
    capture.recordStepUsage({ input: 2_000_000, output: 500_000 });
    const split = toolExecute<SplitToolInput, string>(tools.split_subheads);
    await split({
      rationale: 'go deeper',
      heads: [{ task: 'a', rationale: 'a' }, { task: 'b', rationale: 'b' }],
    });
    expect(splits).toBe(1);
  });

  test('allowedTools narrows the surface further, never widens it', () => {
    const { tools } = buildSurface({ input: headInput({ allowedTools: ['run', 'record_evidence', 'think'] }) });
    expect(Object.keys(tools).sort()).toEqual(['record_evidence', 'run']);
  });

  test('builtin tool calls land in the HeadCapture so the report keeps them', async () => {
    const { tools, capture } = buildSurface();
    const execute = toolExecute<{ code: string }, string>(tools.execute_tools);
    await execute({ code: 'return 1' });
    expect(capture.toolCalls).toEqual([{ name: 'execute_tools', args: { code: 'return 1' }, result: 'ran', outcome: { success: true } }]);
  });

  test('the head prompt describes the real workspace it was given', () => {
    const { tools } = buildSurface();
    const prompt = buildHeadSystemPrompt(headInput(), Object.keys(tools));
    expect(prompt).toContain('`workspace.*` is the canonical workspace');
    expect(prompt).toContain('workspace.exec');
    expect(prompt).not.toContain('`parent.*`');
    expect(prompt).not.toContain('sandbox_exec');
  });
});

/**
 * Where an exploration actor's trace lands, and what a rollout branch may
 * touch — driven through the production seams instead of read out of a class.
 *
 * Five source-text assertions stood here over `subordinate-agent.ts`: which
 * statements sat inside the MCTS-mode block, that `createCFRuntime` appeared
 * exactly once, that both run modes wired `reportStep`, and that the parent
 * journal was written in one place. Every one of them was a proxy for a
 * behaviour the runner could not execute, because the facet was a Durable
 * Object class. Both are executable now — one isolate, one database — so they
 * are asserted rather than approximated, and the C2 property they circled (one
 * journal for the whole subtree) becomes an assertion about WHOSE rows they
 * are, which no source scan could make.
 */
describe('exploration actors write the workspace journal and acquire only their own plane', () => {
  test("a head's step trace lands in the workspace's journal, under the workspace's own actor", async () => {
    const workspace = orchestratorHarness();
    const head = await hostedExplorationHarness(workspace, 'head', 'head-1');
    const root = workspace.agent.observeRuntime().actor.actorId;
    // DISTINCT actors, which is what makes the ownership assertion below mean
    // anything: a step filed under the head's own id would be invisible to
    // every reader of the subtree's journal, and that unreadable depth-2 head
    // is the defect this property exists for.
    expect(head.actor.handle.actorId).not.toBe(root);

    await workspace.agent.observeExplorationSeams().recordStep('head-1', 1, {
      text: 'read the parser', toolCalls: [],
    });

    // UNSCOPED, deliberately. The question is whose row this is, and a read
    // filtered by the actor it expects would answer an empty set for a row
    // filed under the wrong owner and pass.
    const rows = workspace.db.prepare<{ actor_id: string; head_id: string; text: string }, []>(
      'SELECT actor_id, head_id, text FROM head_steps',
    ).all();
    expect(rows).toEqual([{ actor_id: root, head_id: 'head-1', text: 'read the parser' }]);
  });

  test('a rollout branch reasons through the caller\'s model seam and is given no plane to act on', async () => {
    const workspace = orchestratorHarness();
    const asked: string[] = [];
    // The SAME creation id through both doors. `register` is idempotent per
    // creation id, so the seat and the branch handle below bind one actor —
    // which is what lets the home assertion name the row the directory issued
    // instead of a key the fixture invented.
    const branchRecord = (await hostedExplorationHarness(workspace, 'branch', 'branch-1')).actor.record;
    const branch = await hostBranch(workspace.agent.observeExplorationSeams(), 'branch-1', {
      explorePrompt: ({ context }) => ({ system: 'score this rollout', user: `context: ${context}` }),
      reflectionPrompt: (task, traces) => `why did ${task} score badly after ${traces}`,
      complete: async (request) => {
        asked.push(request.user);
        return { text: 'the parser branch looks promising' };
      },
    });

    const answer = await branch.explore(
      [{ role: 'user', content: 'probe the parser' }], [], ['typescript'], 'build',
    );

    // It REASONED: the answer came back through the only seam it has.
    expect(answer.text).toBe('the parser branch looks promising');
    expect(asked).toEqual(['context: user: probe the parser']);
    // And it was given nothing to act WITH. `hostedHomeKind` answers null for a
    // branch, so no home and no credential are provisioned — where a head of
    // the same workspace gets both. Asserted as a pair, because "no directory"
    // holds trivially for a tree nothing was ever provisioned on.
    //
    // Keyed off the storage key the DIRECTORY issued, decoded the way
    // `provisionHostedActorHome` decodes it: the home follows the issued
    // identity, never the creation id a caller happened to pass, so a fixture
    // that spelled the name itself would be asserting its own arithmetic.
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
 * THE SEED-BUILT CONTAINMENT BLOCK IS GONE, AND ITS SUBJECT WITH IT.
 *
 * Six tests stood here. They drove `facetHarness()`, pushed a production seed
 * (`initHead`, `initNode`, `setSubordinateIdentity`), and read `Object.hasOwn`
 * on the instance to see which family the constructor's seal had narrowed it
 * to — a head that could not resolve `setSubordinateIdentity`, a subordinate
 * that could not resolve `runAsHead`. Every one of those names is deleted:
 * there is no facet class, no seed RPC, and no per-family re-seal, because a
 * hosted actor is not addressable over a stub at all. There is no object to
 * hold a stub to, so there is nothing for a seal to narrow.
 *
 * What replaced the mechanism is not a smaller version of it. Containment rides
 * the ACTOR: `actor_id` in every scoped table's primary key, a handle each store
 * re-validates before every statement, a per-binding release fence, and one
 * `workspace_actors` row per actor under its parent's authority. That is
 * asserted where it lives — the actor-scoping suites for the rows, and
 * `unit-rpc-surface.test.ts` plus `tests/workerd/plan-announce-probe.ts` for
 * what a stub-holder may still reach on the one addressable object.
 *
 * What this file keeps is the half that was always the strongest and is now the
 * whole of head containment: `describe('head tool surface — containment')`
 * above, which reads the ToolSet a head is actually handed rather than the text
 * of any class. A hosted head may do exactly what that set carries.
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
  // A head carries no execution cap of its own — no wall clock, no token pool,
  // no step guard — which makes the mission budget the only bound on a fork. A
  // hosted head runs in the ledger holder's own isolate, so the port is a pair
  // of in-process calls and the seam that builds it can simply be driven; an
  // RPC to the actor that holds the ledger would be a cross-Durable-Object call
  // this runner cannot exercise, leaving only a source-level assertion of the
  // wiring.
  const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
  const surface = readFileSync(join(import.meta.dir, '..', 'src', 'rpc-surface.ts'), 'utf8');

  test('an unbudgeted head is given no ledger at all, and a budgeted one is given its own labels', () => {
    const seams = orchestratorHarness().agent.observeExplorationSeams();
    // NULL, not an inert port: an undeclared run must not touch the table, and
    // a port handed over "just in case" is how a cap gets created for a head
    // nobody budgeted.
    expect(seams.mission(headInput())).toBeNull();
    // The denominator. Without it the null above would hold for a seam that
    // answers null unconditionally.
    const scoped = seams.mission(headInput({ missionLabels: ['q3-migration'] }));
    expect(scoped?.labels).toEqual(['q3-migration']);
  });

  test('the port charges the ledger of the actor that declared the budget', async () => {
    const workspace = orchestratorHarness();
    const scoped = workspace.agent.observeExplorationSeams()
      .mission(headInput({ missionLabels: ['q3-migration'] }));
    if (!scoped) throw new Error('a head with labels is given a mission port');

    // Guarding an undeclared mission is not a refusal — there is no cap to
    // exceed — and the debit that follows lands on THIS workspace's own ledger
    // rather than on storage a fork would have had of its own. Driving both
    // halves is what proves the port reaches a live ledger: a closure over a
    // released or foreign handle throws on `assertCurrent` instead.
    expect(await scoped.port.guard('model_call', scoped.labels)).toBeNull();
    await scoped.port.debit(120, { labels: scoped.labels, calls: 1 });
    expect(await scoped.port.guard('model_call', scoped.labels)).toBeNull();
  });

  test('a subtree charges the mission its root does', () => {
    // Otherwise a head escapes its budget simply by splitting again. Still read
    // at the source: the recursive split needs a live head and a merge model,
    // which this runner has neither of.
    const orchestrator = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');
    expect(orchestrator).toContain('controllerInput.missionLabels = parent.missionLabels');
  });

  test('the two ledger members are cross-DO only, never public transport', () => {
    const guard = actor.slice(actor.indexOf('async missionGuard('), actor.indexOf('async missionDebit('));
    expect(guard).not.toContain('@callable');
    expect(actor).not.toContain("@callable()\n  async missionDebit(");
    // Still allowlisted, and that is not vestigial: a spend ledger must not
    // become writable over the public WS/HTTP transport just because the head
    // that charges it runs in-process.
    expect(surface).toContain("'missionGuard'");
    expect(surface).toContain("'missionDebit'");
  });
});
