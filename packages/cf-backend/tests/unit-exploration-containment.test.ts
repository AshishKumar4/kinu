// Head containment — asserted against the ToolSet a head is actually handed.
//
// A head is a FORK of its parent workspace: it rides the parent's exec planes
// and reads the parent's files. What it must never gain is the parent's
// AUTHORITY to create actors — `think`, `team` and `peers` open unbounded spawn
// trees, and `split_subheads` (depth-budgeted) must stay the only spawn route.
//
// These assertions run against buildHeadToolSet's real output rather than the
// text of exploration.ts, so they keep holding when the surface is refactored
// and they catch a tool that appears through a dependency instead of a literal.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestRuntime, createTestSql, toolExecute } from '@proteus/test-utils';
import { mockAgentsSdk } from './helpers/agents-sdk.js';
import {
  HeadCapture,
  HeadController,
  HeadJournal,
  buildHeadSystemPrompt,
  initHeadsTables,
  type HeadInput,
  type HeadReport,
  type HeadRuntime,
  type MergeOutput,
  type WebSearchProvider,
} from '@proteus/core';
import { HEAD_BUILTIN_TOOLS, buildHeadToolSet, type HeadSplitRequest, type HeadSplitResult } from '@proteus/core';

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
    tokenUsage: { input: 1, output: 1, total: 2 },
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
  const executeTool = { description: 'execute_tools', execute: async () => 'ran' };
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
    const result = await split({
      rationale: 'go deeper',
      heads: [{ task: 'a', rationale: 'a' }, { task: 'b', rationale: 'b' }],
    });
    expect(result).toContain('budget exhausted (wall-clock)');
    expect(splits).toBe(0);
    // Unrecorded, this refusal left no trace in the journal — so how often a
    // head is stopped mid-plan could not be asked of the ledger.
    expect(capture.toolCalls).toHaveLength(1);
    const refusal = capture.toolCalls.at(0);
    if (!refusal) throw new Error('Expected split refusal to be recorded');
    expect(refusal.name).toBe('split_subheads');
    expect(refusal.result).toContain('wall-clock');
  });

  test('split_subheads is NOT refused for spend — a long-running head may still split', async () => {
    let splits = 0;
    const { tools, capture } = buildSurface({
      input: headInput({ budget: { maxDepth: 3, spawnedAt: Date.now() - 60 * 60_000 } }),
      split: async () => { splits++; return { narrative: 'merged', decisions: [], unresolvedQuestions: [], blindSpots: [], childHeadIds: [], headCount: 2 }; },
    });
    // A head an hour in that has burned 2M tokens. Neither is a reason to refuse.
    capture.recordStepUsage(2_000_000, 500_000);
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
    expect(capture.toolCalls.map((c) => c.name)).toEqual(['execute_tools']);
  });

  test('the head prompt describes the real workspace it was given', () => {
    const { tools } = buildSurface();
    const prompt = buildHeadSystemPrompt(headInput(), Object.keys(tools));
    expect(prompt).toContain('`workspace.*` is the canonical workspace');
    expect(prompt).toContain('workspace.exec');
    expect(prompt).not.toContain('`parent.*`');
    expect(prompt).toContain('');
    expect(prompt).not.toContain('sandbox_exec');
  });
});

describe('MCTS branch mode stays isolated', () => {
  // ExplorationAgent is dual-purpose: explore() is an MCTS scoring branch,
  // runAsHead() is a research head. Only the head forks the parent's resources;
  // a branch is a bare generateText with no ToolSet and no runtime, which is why
  // StorageIsolation holds for branches by DO identity alone.
  //
  // The two assertions below read source because what they check is not
  // runtime-observable: which statements sit inside the MCTS-mode block, and
  // that the forked runtime is constructed in exactly one place. The CLASS TREE
  // is NOT asserted from source — see 'head containment is structural' below,
  // which imports the real constructors and reads the real prototype chain.
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'exploration.ts'), 'utf8');

  test('MCTS-mode callables acquire neither a runtime nor a ToolSet', () => {
    const mctsMode = source.slice(
      source.indexOf('  // ── MCTS mode @callables'),
      source.indexOf('  // ── Head mode @callables'),
    );
    expect(mctsMode).toContain('async explore(');
    expect(mctsMode).toContain('async generateReflection(');
    expect(mctsMode).not.toContain('this.headRuntime');
    expect(mctsMode).not.toContain('tools:');
  });

  test('the forked runtime is constructed in exactly one place', () => {
    expect(source.match(/createCFRuntime\(/g)).toHaveLength(1);
  });

  /**
   * A head's step trace must actually leave the facet.
   *
   * The journal lives on the orchestrator and a facet cannot write it, so the
   * trace only exists if `runAsHead` provides the `reportStep` sink. That seam is
   * optional in core, which is how it came to have no provider at all: nothing
   * failed, `head_steps` was simply always empty, and every branch in the
   * Exploration surface read `STEPS 0` with "no step trace" for its whole life.
   * The read is source-level for the same reason as the assertions above — the DO
   * class cannot be instantiated in this runner — but it pins the two halves that
   * were missing: the option is set, and it reaches the parent stub.
   */
  test('a head reports every step back to the parent journal', () => {
    const runAsHead = source.slice(
      source.indexOf('  async runAsHead('),
      source.indexOf('  private missionScope('),
    );
    expect(runAsHead).toContain('options.reportStep = reportStep');
    expect(runAsHead).toContain('parent.recordHeadStep(input.id, seq, step)');
    // Reached through the shared-parent stub, like the mission ledger's port —
    // never through this facet's own storage, which is not where the journal is.
    expect(runAsHead).toContain('this.getSharedParentStub()');
  });
});

/**
 * Head containment, asserted on the REAL class tree rather than on the text of
 * a class declaration.
 *
 * This replaces a pair of substring assertions that pinned the literal strings
 * 'export class ExplorationAgent extends Agent<Env>' and
 * NOT 'class ExplorationAgent extends ActorAgent'. Those were satisfied by how
 * the declaration was spelled, so they were blind to a head acquiring the actor
 * surface through a renamed base, a re-export, an intermediate class, or a
 * mixin — and they simultaneously forbade ANY refactor of the declaration,
 * which is why the base-class work they were guarding never landed.
 *
 * What follows is strictly stronger on both counts. `extends` sets the static
 * prototype chain, so `isPrototypeOf` on the constructors is the actual
 * inheritance relation and it cannot be spelled around. And rather than naming
 * a base class to avoid, the second test enumerates the members that CONSTITUTE
 * the actor surface and asserts a head cannot reach any of them — the invariant
 * the old assertions were approximating.
 *
 * Runnable here because `mockAgentsSdk()` replaces the `agents` module, whose
 * dist reaches `cloudflare:*` modules that exist only inside workerd. bun keeps
 * one mock per specifier and the first registration wins, so it runs before the
 * dynamic imports. The mock never participates in the assertions that matter:
 * those compare real Proteus classes to each other.
 */
describe('head containment is structural', () => {
  mockAgentsSdk();

  /**
   * The members that constitute the actor surface. `think`, `team` and `peers`
   * open unbounded spawn trees; the head controller and inherited-context
   * readers are the fork machinery itself; the journal RPCs are the root's
   * control plane. A head must reach none of them.
   */
  const ACTOR_ONLY_MEMBERS = [
    'getAgentsToolDeps',
    'getRawTools',
    'getHeadController',
    'getCFHeadRuntime',
    'readInheritedContext',
    'headJournalRecordSplit',
    'missionGuard',
    'getModel',
  ] as const;

  async function classes() {
    const { ActorAgent } = await import('../src/actor-agent.js');
    const { ExplorationAgent } = await import('../src/exploration.js');
    const { SubordinateAgent } = await import('../src/subordinate-agent.js');
    return { ActorAgent, ExplorationAgent, SubordinateAgent };
  }

  test('the enumerated members really are the actor surface (control)', async () => {
    // Without this control a typo in ACTOR_ONLY_MEMBERS makes every negative
    // assertion below pass vacuously, and an emptied array disarms the gate
    // silently — so the list must be non-empty AND every entry must resolve.
    const { ActorAgent } = await classes();
    expect(ACTOR_ONLY_MEMBERS.length).toBeGreaterThan(0);
    const actorOwnMembers = Object.getOwnPropertyNames(ActorAgent.prototype);
    for (const member of ACTOR_ONLY_MEMBERS) {
      expect(actorOwnMembers).toContain(member);
    }
  });

  test('a head cannot reach any actor-surface member', async () => {
    const { ExplorationAgent } = await classes();
    for (const member of ACTOR_ONLY_MEMBERS) {
      // `in` walks the ENTIRE prototype chain, so this rules out reaching the
      // member through any base, not merely on the class's own prototype.
      expect(member in ExplorationAgent.prototype).toBe(false);
    }
  });

  test('ExplorationAgent does not inherit from ActorAgent; SubordinateAgent does', async () => {
    const { ActorAgent, ExplorationAgent, SubordinateAgent } = await classes();
    // THE invariant. A head is not an actor, however the declaration is spelled.
    expect(ActorAgent.isPrototypeOf(ExplorationAgent)).toBe(false);
    // The positive half, so the assertion above cannot pass because
    // isPrototypeOf silently stopped working.
    expect(ActorAgent.isPrototypeOf(SubordinateAgent)).toBe(true);
  });

  test('a head descends directly from the bare Agent base', async () => {
    const { ExplorationAgent } = await classes();
    expect(Object.getPrototypeOf(ExplorationAgent).name).toBe('Agent');
  });
});

describe('recursive split budget', () => {
  test('the controller decrements maxDepth for spawned subheads', async () => {
    const { db, sql } = createTestSql();
    initHeadsTables((ddl) => db.exec(ddl), sql);
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
    const controller = new HeadController(runtime, new HeadJournal(sql));

    await controller.run({
      parentHeadId: 'parent-head',
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

describe('the mission ledger crosses the facet boundary', () => {
  // A head runs as its own Durable Object with its own storage, resolving its
  // own model — so the governed `LLM` the fork seam wraps around the PARENT's
  // runtime never sees a call the head makes. Head execution caps were removed
  // outright (no wall clock, no token pool, no step guard), which makes the
  // mission budget the only remaining bound, and it reaches the head only over
  // an RPC to the actor that holds the ledger. That RPC cannot be exercised in
  // this runner, so the wiring is asserted at the source, like the branch
  // isolation above.
  const exploration = readFileSync(join(import.meta.dir, '..', 'src', 'exploration.ts'), 'utf8');
  const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
  const surface = readFileSync(join(import.meta.dir, '..', 'src', 'rpc-surface.ts'), 'utf8');

  test('a head with no labels takes no stub and issues no RPC', () => {
    const scope = exploration.slice(
      exploration.indexOf('private missionScope('),
      exploration.indexOf('// ── Head-mode tool builders'),
    );
    // The empty-label return comes BEFORE the parent stub is resolved, so an
    // unbudgeted head never even addresses the ledger.
    expect(scope.indexOf('labels.length === 0')).toBeLessThan(scope.indexOf('getSharedParentStub'));
    expect(scope).toContain('return null');
  });

  test('the head guards and debits over the parent, not over its own storage', () => {
    expect(exploration).toContain('parent.missionGuard(seam, scope)');
    expect(exploration).toContain('parent.missionDebit(tokens, opts)');
  });

  test('a subtree charges the mission its root does', () => {
    // Otherwise a head escapes its budget simply by splitting again.
    expect(exploration).toContain('controllerInput.missionLabels = parentInput.missionLabels');
  });

  test('the two ledger RPCs are cross-DO only, never public transport', () => {
    const guard = actor.slice(actor.indexOf('async missionGuard('), actor.indexOf('async missionDebit('));
    expect(guard).not.toContain('@callable');
    expect(actor).not.toContain("@callable()\n  async missionDebit(");
    // Reachable on a stub — and nowhere else — because the seal is an allowlist.
    expect(surface).toContain("'missionGuard'");
    expect(surface).toContain("'missionDebit'");
  });
});
