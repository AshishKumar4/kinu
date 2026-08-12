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
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestRuntime } from '@proteus/test-utils';
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
  type SqlExecutor,
  type WebSearchProvider,
} from '@proteus/core';
import { HEAD_BUILTIN_TOOLS, buildHeadToolSet, type HeadSplitRequest } from '@proteus/core';

function makeSql(db: Database): SqlExecutor {
  return function <T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
    const query = strings.reduce((sql, part, index) => sql + part + (index < values.length ? '?' : ''), '');
    const statement = db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...(values as SQLQueryBindings[])) as T[];
    statement.run(...(values as SQLQueryBindings[]));
    return [];
  } as SqlExecutor;
}

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
    steps: [],
    tokenUsage: { input: 1, output: 1, total: 2 },
    wallClockMs: 1,
  };
}

const mergeOutput: MergeOutput = {
  narrative: 'merged child findings',
  selected_decisions: [],
  unresolved_questions: [],
  recommendations: [],
};

const noopWebSearch: WebSearchProvider = {
  search: async (query: string) => ({ query, results: [], source: 'test' }),
  fetch: async (url: string) => ({ url, markdown: '', retrievedAt: new Date(0).toISOString() }),
} as unknown as WebSearchProvider;

function headInput(overrides?: Partial<HeadInput>): HeadInput {
  return {
    id: 'head-1', rootId: 'root-1', parentId: null, depth: 0,
    task: 'study the cloned repo', rationale: 'the parser angle',
    inheritedContext: [],
    budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    mergeStrategy: 'synthesize',
    ...overrides,
  };
}

function buildSurface(opts?: {
  input?: HeadInput;
  split?: (request: HeadSplitRequest) => Promise<{
    narrative: string; decisions: []; unresolvedQuestions: []; childHeadIds: string[]; headCount: number;
  }>;
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
      narrative: 'merged', decisions: [], unresolvedQuestions: [], childHeadIds: [], headCount: 0,
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

  test('split_subheads refuses once the depth budget is spent', async () => {
    let splits = 0;
    const { tools } = buildSurface({
      input: headInput({ budget: { maxDepth: 0, maxWallClockMs: 60_000, spawnedAt: Date.now() } }),
      split: async () => { splits++; return { narrative: '', decisions: [], unresolvedQuestions: [], childHeadIds: [], headCount: 0 }; },
    });
    const result = await (tools.split_subheads as { execute: (args: unknown, opts: unknown) => Promise<string> })
      .execute({ rationale: 'go deeper', heads: [{ task: 'a', rationale: 'a' }, { task: 'b', rationale: 'b' }] }, {});
    expect(result).toContain('budget exhausted (max-depth)');
    expect(splits).toBe(0);
  });

  test('split_subheads refuses once a caller-requested deadline has passed', async () => {
    let splits = 0;
    const { tools } = buildSurface({
      input: headInput({ budget: { maxDepth: 3, maxWallClockMs: 50, spawnedAt: Date.now() - 5_000 } }),
      split: async () => { splits++; return { narrative: '', decisions: [], unresolvedQuestions: [], childHeadIds: [], headCount: 0 }; },
    });
    const result = await (tools.split_subheads as { execute: (args: unknown, opts: unknown) => Promise<string> })
      .execute({ rationale: 'go deeper', heads: [{ task: 'a', rationale: 'a' }, { task: 'b', rationale: 'b' }] }, {});
    expect(result).toContain('budget exhausted (wall-clock)');
    expect(splits).toBe(0);
  });

  test('split_subheads is NOT refused for spend — a long-running head may still split', async () => {
    let splits = 0;
    const { tools, capture } = buildSurface({
      input: headInput({ budget: { maxDepth: 3, spawnedAt: Date.now() - 60 * 60_000 } }),
      split: async () => { splits++; return { narrative: 'merged', decisions: [], unresolvedQuestions: [], childHeadIds: [], headCount: 2 }; },
    });
    // A head an hour in that has burned 2M tokens. Neither is a reason to refuse.
    capture.recordStepUsage(2_000_000, 500_000);
    await (tools.split_subheads as { execute: (args: unknown, opts: unknown) => Promise<string> })
      .execute({ rationale: 'go deeper', heads: [{ task: 'a', rationale: 'a' }, { task: 'b', rationale: 'b' }] }, {});
    expect(splits).toBe(1);
  });

  test('allowedTools narrows the surface further, never widens it', () => {
    const { tools } = buildSurface({ input: headInput({ allowedTools: ['run', 'record_evidence', 'think'] }) });
    expect(Object.keys(tools).sort()).toEqual(['record_evidence', 'run']);
  });

  test('builtin tool calls land in the HeadCapture so the report keeps them', async () => {
    const { tools, capture } = buildSurface();
    await (tools.execute_tools as { execute: (args: unknown, opts: unknown) => Promise<unknown> })
      .execute({ code: 'return 1' }, {});
    expect(capture.toolCalls.map((c) => c.name)).toEqual(['execute_tools']);
  });

  test('the head prompt describes the real workspace it was given', () => {
    const { tools } = buildSurface();
    const prompt = buildHeadSystemPrompt(headInput(), Object.keys(tools));
    expect(prompt).toContain('/workspace/');
    expect(prompt).toContain('/local/');
    expect(prompt).not.toContain('sandbox_exec');
  });
});

describe('MCTS branch mode stays isolated', () => {
  // ExplorationAgent is dual-purpose: explore() is an MCTS scoring branch,
  // runAsHead() is a research head. Only the head forks the parent's resources;
  // a branch is a bare generateText with no ToolSet and no runtime, which is why
  // StorageIsolation holds for branches by DO identity alone.
  //
  // This is the one assertion here that reads source instead of behaviour: the
  // DO classes import `agents`, which needs the workers runtime, so they cannot
  // be instantiated in this runner. Everything about the HEAD surface above is
  // asserted against the real ToolSet.
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

  test('heads stay bare Agents — no ActorAgent tool surface by inheritance', () => {
    expect(source).toContain('export class ExplorationAgent extends Agent<Env>');
    expect(source).not.toContain('class ExplorationAgent extends ActorAgent');
  });
});

describe('recursive split budget', () => {
  test('the controller decrements maxDepth for spawned subheads', async () => {
    const db = new Database(':memory:');
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
    const controller = new HeadController(runtime, new HeadJournal(makeSql(db)));

    await controller.run({
      parentHeadId: 'parent-head',
      rootId: 'root-head',
      inheritedContext: [],
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
    expect(exploration).toContain('missionLabels: parentInput.missionLabels');
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
