// createCLIHeadRuntime: a head forks the parent's host executor and files, with a private durable scratch.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { LanguageModelV2, LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  HeadController, HeadJournal, initHeadsTables, buildHeadToolSet, HeadCapture, MergeOutputSchema,
  MissionGovernor, CRAFT_NEUTRAL_PRIOR, reasoningEffortOptions, explorationActorKey, headAgentName, defaultLoopOrigin,
  initWorkspaceSchema, RunEventRecorder, startBranchHead, workspaceSpend, createAgentStores,
  type ReasoningEffort,
  type HeadInput, type WebSearchProvider, type JsonObject, type WriteObserver,
  type ModelCallReport, type ModelOperationEvent,
  type HeadStreamFrame, type ExecutionRouter, type AgentRuntime,
} from '@kinu.run/core';
import {
  MERGE_POLICY_BINDING, MERGE_POLICY_JUDGE_MODEL, MERGE_POLICY_SPEND_SOURCE,
  mergePolicyProfile, present, scratchDir, scratchPath, toolExecute, scriptedTurnModel, createTestActorsOver,
  type ScriptedTurnResult,
} from '@kinu.run/test-utils';
import * as v from 'valibot';
import { createCLIHeadRuntime, type CLIHeadRuntimeDeps } from '../src/head-runtime';
import { makeSql, makeExecRaw, makeWorkspaceSchemaSql, createCLIRuntime, type CLIRuntime } from '../src/runtime';
import { createHeadRuntime, headSeatFactory, localTestActorHost } from './actor-fixture';
import { openLocalActor } from '../src/actor-identity';
import { LocalAgentSession } from '../src/local-session';

// A head owns no store: its rows are actor-keyed in the parent's one database.

const stubWeb: WebSearchProvider = {
  search: async () => ({ query: '', results: [], source: 'duckduckgo' }),
  fetch: async () => ({ url: '', title: '', markdown: '', retrievedAt: '' }),
};

/** A parent CLI runtime; `db` rides along because `localTestActorHost` needs the parent's own connection. */
type LocalParent = CLIRuntime & { readonly db: Database };

type DoGenerateResult = Awaited<ReturnType<LanguageModelV2['doGenerate']>>;

function probeEnvelope(
  modelId: string,
): (content: DoGenerateResult['content'], finishReason: 'tool-calls' | 'stop') => DoGenerateResult {
  return (content, finishReason) => ({
    content,
    finishReason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    response: { id: 'r', modelId, timestamp: new Date(0) },
    warnings: [],
  });
}

function routerOf(rt: AgentRuntime): ExecutionRouter {
  return present(rt.executionRouter, 'the runtime execution router');
}

function makeParent(cwd?: string): LocalParent {
  const dbPath = scratchPath('head-runtime-parent', 'parent.db');
  const db = new Database(dbPath);
  // Production initializer first: hosted heads take claimed turns, which need tables `createCLIRuntime` does not create.
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));

  const config: Parameters<typeof createCLIRuntime>[1] = {
    dbPath,
    llm: { name: 'x', baseURL: 'http://l', headers: {}, model: 'm' },
  };

  if (cwd !== undefined) config.cwd = cwd;

  return Object.assign(createCLIRuntime(db, config), { db });
}

function makeGovernor(): MissionGovernor {
  const db = new Database(':memory:');

  return new MissionGovernor({ actor: createTestActorsOver(db).main, storage: { sql: makeSql(db), execRaw: makeExecRaw(db) } });
}

function makeJournal(): HeadJournal {
  const db = new Database(':memory:');
  initHeadsTables(makeExecRaw(db));

  return new HeadJournal(makeSql(db), createTestActorsOver(db).main);
}

interface RouteProbe {
  readonly asked: Array<{ spec: string; effort: ReasoningEffort }>;
}

/** Head-runtime deps around a fresh parent. The binder answers with the merge model, not `model`, so a merge
 *  that ignored the `judge` route is detectable. */
function headDeps(
  model: LanguageModel,
  over?: Partial<Omit<CLIHeadRuntimeDeps, 'parentRuntime'>> & { readonly parentRuntime?: LocalParent },
  probe?: RouteProbe,
): CLIHeadRuntimeDeps {
  const governor = makeGovernor();
  const journal = makeJournal();
  const parent = over?.parentRuntime ?? makeParent();
  // One slot shared by caller and host (the fixture's `LocalAgentSession.actorWrites`), filled per run before `acquire`.
  const writes = new Map<string, WriteObserver>();

  return {
    model: () => model, parentRuntime: parent,
    // The genuine host: heads acquired from it run the production session, stores and claimed loop.
    hostHead: headSeatFactory(parent, localTestActorHost(parent, parent.db, [], writes), 'fixture-run', writes),
    profile: async () => mergePolicyProfile(),
    bindMergeModel: (route) => {
      probe?.asked.push({ spec: route.model, effort: route.reasoningEffort });

      return {
        model,
        providerOptions: reasoningEffortOptions(route.reasoningEffort, 'openai') ?? {},
      };
    },
    reportModelCall: () => {},
    webSearch: stubWeb, codemodeExtras: () => [],
    governor: () => governor, journal: () => journal, ...over,
  };
}

/** The storage key the directory issued for one head id: read back, never derived. */
function headStorageKey(parent: CLIRuntime, id: string): string {
  return openLocalActor(parent.actor, explorationActorKey(id)).storageKey;
}

function capturingHeadModel(
  answer: string,
  sink: (names: string[]) => void,
  promptSink?: (prompt: string) => void,
  runSchemaSink?: (schema: string) => void,
): LanguageModel {
  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake',
    doGenerate: async (opts) => {
      sink((opts.tools ?? []).map((t) => t.name));
      promptSink?.(JSON.stringify(opts.prompt));

      if (runSchemaSink) {
        runSchemaSink(JSON.stringify((opts.tools ?? []).find((candidate) => candidate.name === 'shell')));
      }

      return {
        content: [{ type: 'text', text: answer }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        response: { id: 'r', modelId: 'fake', timestamp: new Date(0) },
        warnings: [],
      };
    },
  });
}

const aHeadInput = (over?: Partial<HeadInput>): HeadInput => ({
  id: 'h1', rootId: 'r1', parentId: null, depth: 0, task: 't', rationale: 'r',
  inheritedContext: [], budget: { maxDepth: 2, spawnedAt: Date.now() },
  mergeStrategy: 'synthesize', ...over,
  mode: over?.mode ?? 'build', loop: over?.loop ?? defaultLoopOrigin('head'),
});

function fakeHeadsModel(capture?: (options: {
  maxOutputTokens?: number;
  providerOptions?: LanguageModelV2CallOptions['providerOptions'];
}, isMerge: boolean) => void): LanguageModel {
  const usage = { inputTokens: 8, outputTokens: 12, totalTokens: 20 };

  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake',
    doGenerate: async (opts) => {
      const isMerge = JSON.stringify(opts.prompt ?? '').includes('merging the findings');
      capture?.(opts, isMerge);

      const text = isMerge
        ? '{"narrative":"Unified: both heads agree the parser is sound.","selected_decisions":[],"unresolved_questions":[],"recommendations":["ship it"]}'
        : 'This head examined its angle and found it solid.';

      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop' as const,
        usage,
        response: { id: 'r', modelId: 'fake', timestamp: new Date(0) },
        warnings: [],
      };
    },
  });
}

function controllerWithCLIRuntime(model: LanguageModel, probe?: RouteProbe) {
  const db = new Database(':memory:');
  initHeadsTables(makeExecRaw(db));
  const journal = new HeadJournal(makeSql(db), createTestActorsOver(db).main);
  const overrides = { journal: () => journal };

  return {
    journal,
    controller: new HeadController(createCLIHeadRuntime(headDeps(model, overrides, probe)), journal),
  };
}

describe('createCLIHeadRuntime — full split → run → merge', () => {
  test('a branch running beside a chat contributes its usage exactly once', async () => {
    const parent = makeParent();
    parent.actor.config.setDisplayNameOrigin('Spend measurement', 'user');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;

    const model = new TestLanguageModelV2({
      doGenerate: async () => {
        if (calls++ === 0) {
          entered.resolve();
          await release.promise;
        }

        return {
          content: [{ type: 'text', text: 'The inspection is complete.' }],
          finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 7, totalTokens: 107 }, warnings: [],
        };
      },
    });

    const session = new LocalAgentSession({ rt: parent, db: parent.db, model, noAutoEvolve: true, onEvent: () => {} });
    const turn = session.send('Inspect the parser.');

    try {
      await entered.promise;
      const journal = new HeadJournal(parent.storage.sql, parent.actor);

      const branch = await startBranchHead(session.headRuntime, journal, {
        id: 'spend-branch', task: 'Inspect another angle.', inheritedContext: [], missionLabels: [],
      });

      const report = await branch.result;

      expect(report.status).toBe('completed');
      expect(report.usage).toMatchObject({ input: 100, output: 7 });

      const spend = workspaceSpend({
        events: new RunEventRecorder(parent.storage.sql, parent.actor), sql: parent.storage.sql, actor: parent.actor,
      });

      expect(spend.total.usage).toMatchObject({ input: 100, output: 7 });
      expect(spend.producers.map((producer) => producer.source)).toEqual(['head']);
    } finally {
      release.resolve();
      await turn;
      await session.end();
      parent.db.close();
    }
  });

  test('reasoning and prose stream in order under the emitting head identity', async () => {
    const frames: HeadStreamFrame[] = [];

    const model = scriptedTurnModel({
      provider: 'fake', modelId: 'streamed-head',
      doGenerate: async () => ({
        content: [{ type: 'reasoning', text: 'checking the parser' }, { type: 'text', text: 'the answer' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 7, text: 5, reasoning: 2 },
        }, warnings: [],
      }),
    });

    const runtime = createCLIHeadRuntime(headDeps(model, { publishHeadStream: (frame) => { frames.push(frame); } }));
    await (await runtime.spawnHead(aHeadInput())).run();
    expect(frames).toEqual([
      { headId: 'h1', kind: 'reasoning', delta: 'checking the parser' },
      { headId: 'h1', kind: 'text', delta: 'the answer' },
    ]);
  });

  test('two heads run in-process and the merge synthesizes their findings', async () => {
    const { controller } = controllerWithCLIRuntime(fakeHeadsModel());

    const result = await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [{ id: 'm', role: 'user', content: 'is the parser sound?', createdAt: 1 }],
      request: {
        rationale: 'split the parser review across lexer + grammar angles',
        heads: [
          { task: 'review the lexer', rationale: 'utf-8 + tokens' },
          { task: 'review the grammar', rationale: 'precedence + recovery' },
        ],
      },
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    });

    expect(result.mergedNarrative).toContain('Unified');
    expect(result.recommendations).toContain('ship it');
    expect(result.costSummary.headCount).toBe(2);
    expect(result.headIds).toHaveLength(2);
  });

  // The merge is the one split call the head journal does not carry; heads reporting here would double-count.
  test('the merge reports its own spend as judge, and the heads report none', async () => {
    const reports: ModelCallReport[] = [];
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db));
    const journal = new HeadJournal(makeSql(db), createTestActorsOver(db).main);

    const controller = new HeadController(
      createCLIHeadRuntime(headDeps(fakeHeadsModel(), {
        journal: () => journal,
        reportModelCall: (report) => { reports.push(report); },
      })),
      journal,
    );

    await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: {
        rationale: 'split the parser review',
        heads: [
          { task: 'review the lexer', rationale: 'utf-8 + tokens' },
          { task: 'review the grammar', rationale: 'precedence + recovery' },
        ],
      },
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      source: MERGE_POLICY_SPEND_SOURCE, usage: { input: 8, output: 12 },
    });
  });

  /** The merge runs the routed `judge` tier at its own effort; `MERGE_POLICY_BINDING` is shared with `unit-head-runtime-operations.test.ts`. */
  test('the merge takes the judge route, not the session model at a constant effort', async () => {
    const probe: RouteProbe = { asked: [] };
    const { controller } = controllerWithCLIRuntime(fakeHeadsModel(), probe);
    await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: {
        rationale: 'compare two views',
        heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }],
      },
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    });

    expect(probe.asked).toEqual([MERGE_POLICY_BINDING]);
    expect(probe.asked[0]?.spec).toBe(MERGE_POLICY_JUDGE_MODEL);
    expect(probe.asked[0]?.effort).not.toBe('low');
  });

  test('the routed effort reaches the provider, and no output cap does', async () => {
    let mergeOptions: {
      maxOutputTokens?: number;
      providerOptions?: LanguageModelV2CallOptions['providerOptions'];
    } | undefined;

    const { controller } = controllerWithCLIRuntime(
      fakeHeadsModel((options, isMerge) => { if (isMerge) mergeOptions = options; }),
    );

    await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: {
        rationale: 'compare two views',
        heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }],
      },
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    });

    expect(mergeOptions?.maxOutputTokens).toBeUndefined();
    expect(mergeOptions?.providerOptions).toEqual({
      openai: { reasoningEffort: MERGE_POLICY_BINDING.effort },
    });
  });

  test('a head is offered the real fork surface: run + file + eval + web + record + split', async () => {
    let captured: string[] = [];
    const runtime = createCLIHeadRuntime(headDeps(capturingHeadModel('done', (t) => { captured = t; })));
    await (await runtime.spawnHead(aHeadInput())).run();
    expect(new Set(captured)).toEqual(new Set([
      'record_evidence', 'record_decision',
      'eval', 'shell', 'file', 'web',
      'split_subheads',
    ]));
  });

  test('a head neither advertises nor invokes workspace crafts its sandbox does not bind', async () => {
    const parent = makeParent();
    parent.craftStore.create({ name: 'secret_echo', description: 'A workspace-only echo', code: '(input) => input', params: null, scope: 'local' });
    let calls = 0;

    const model = scriptedTurnModel({ doGenerate: (): ScriptedTurnResult => {
      const invoke = calls++ === 0;

      return {
        content: invoke
          ? [{ type: 'tool-call', toolName: 'eval', toolCallId: 'unbound', input: JSON.stringify({ code: '// Probe an unbound function\nreturn await tools.secret_echo({});' }) }]
          : [{ type: 'text', text: 'done' }],
        finishReason: { unified: invoke ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
      };
    } });

    const runtime = createCLIHeadRuntime(headDeps(model, { parentRuntime: parent }));
    await (await runtime.spawnHead(aHeadInput({ task: 'Inspect the available sandbox.' }))).run();

    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain('secret_echo');
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt.filter((message) => message.role === 'tool'))).toContain('not a function');
  });

  test('the prompt identifies the canonical workspace reached by its file tools', async () => {
    let prompt = '';
    let runSchema = '';

    const runtime = createCLIHeadRuntime(headDeps(capturingHeadModel(
      'done',
      () => {},
      (value) => { prompt = value; },
      (value) => { runSchema = value; },
    )));

    await (await runtime.spawnHead(aHeadInput())).run();

    expect(prompt).toContain('workspace.exec');
    expect(prompt).not.toContain('`parent.*`');
    expect(runSchema).toContain('"parent"');
  });

  test('allowedTools maps the PARENT vocabulary onto real tools (never empties)', async () => {
    // A fork's allowedTools use the parent's vocabulary: ["shell"] resolves to run, not to zero tools.
    let captured: string[] = [];
    const runtime = createCLIHeadRuntime(headDeps(capturingHeadModel('done', (t) => { captured = t; })));
    await (await runtime.spawnHead(aHeadInput({ allowedTools: ['shell'] }))).run();
    expect(captured).toEqual(['shell']);
  });

  test('phase events fire on split and merge', async () => {
    const { controller } = controllerWithCLIRuntime(fakeHeadsModel());
    const phases: string[] = [];
    await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: { rationale: 'r', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
      onPhase: (e) => phases.push(e.kind),
    });
    expect(phases).toEqual(['split', 'merge']);
  });

  /** The trace must reach the journal: asserted through `readRun`, the projection the Exploration surface reads. */
  test('every head step reaches the journal, so a branch trace is readable', async () => {
    const { controller, journal } = controllerWithCLIRuntime(fakeHeadsModel());

    const result = await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: { rationale: 'trace me', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    });

    const run = journal.readRun(result.headIds[0].split('-d')[0]);
    const heads = run?.heads ?? [];
    expect(heads).toHaveLength(2);

    for (const head of heads) {
      expect(journal.readSteps(head.id).length).toBeGreaterThan(0);
      expect(head.lastStepAt).not.toBeNull();
    }
  });
  test('nested heads keep their reports and transcripts in the root journal', async () => {
    let split = false;

    const model = new TestLanguageModelV2({
      provider: 'fake', modelId: 'recursive-head',
      doGenerate: async (opts) => {
        const prompt = JSON.stringify(opts.prompt);
        let finishReason: 'tool-calls' | 'stop' = 'stop';
        let content: Awaited<ReturnType<LanguageModelV2['doGenerate']>>['content'];

        if (prompt.includes('merging the findings')) {
          content = [{ type: 'text', text: JSON.stringify({
            narrative: 'combined findings', selected_decisions: [], unresolved_questions: [],
            recommendations: [], blind_spots: [],
          }) }];
        } else if (prompt.includes('Your task: parent investigation') && !split) {
          split = true;
          finishReason = 'tool-calls';
          content = [{
            type: 'tool-call', toolCallId: 'nested-split', toolName: 'split_subheads',
            input: JSON.stringify({ rationale: 'deeper investigation', heads: [
              { task: 'nested lexer', rationale: 'tokens' },
              { task: 'nested grammar', rationale: 'parsing' },
            ] }),
          }];
        } else {
          content = [{ type: 'text', text: 'The branch preserves its findings.' }];
        }

        return {
          content, finishReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          response: { id: 'recursive', modelId: 'recursive-head', timestamp: new Date(0) }, warnings: [],
        };
      },
    });

    const { controller, journal } = controllerWithCLIRuntime(model);
    await controller.run({
      mode: 'build', parentHeadId: null, rootId: 'nested-local', inheritedContext: [],
      parentBudget: { maxDepth: 3, spawnedAt: Date.now() },
      request: { rationale: 'review all layers', heads: [
        { task: 'parent investigation', rationale: 'follow dependencies' },
        { task: 'sibling investigation', rationale: 'independent review' },
      ] },
    });
    const run = journal.readRun('nested-local');
    expect(run?.heads.map((head) => head.task).sort()).toEqual([
      'nested grammar', 'nested lexer', 'parent investigation', 'sibling investigation',
    ]);

    for (const head of run?.heads ?? []) {
      expect(head.status).toBe('completed');
      expect(journal.readSteps(head.id).some((step) => step.text.includes('preserves its findings'))).toBe(true);
    }
  });
});

describe('a local head forks the parent runtime (the caffe-fork capability)', () => {
  test("sees the parent's workspace, runs real commands, keeps its own scratch private", async () => {
    const dir = scratchDir('head-runtime-cwd');
    writeFileSync(join(dir, 'hello.txt'), 'from the real machine');
    const parent = makeParent();
    await parent.storage.vfs.writeFile('hello.txt', 'from the parent workspace');
    const rt = await createHeadRuntime(parent, 'h');

    const parentExec = present(routerOf(rt).getProvider('parent'), 'the parent executor');
    expect(await parentExec.tools.readFile.execute('hello.txt')).toBe('from the parent workspace');
    expect(v.parse(v.string(), await parentExec.tools.exec.execute('cat hello.txt')))
      .toContain('from the parent workspace');

    expect(routerOf(rt).getProvider('device')).toBeUndefined();

    await rt.storage.vfs.writeFile(`/home/head-${rt.actor.storageKey}/scratch.txt`, 'head-only');
    expect(existsSync(join(dir, 'scratch.txt'))).toBe(false);
    expect(await parent.storage.vfs.exists('scratch.txt')).toBe(false);
    expect(rt.storage.sql).toBe(parent.storage.sql);
    expect(rt.actor.actorId).not.toBe(parent.actor.actorId);
  });

  test('a head of a parent bound to a directory runs its shell there: the machine is the workspace', async () => {
    const dir = scratchDir('head-runtime-cwd');
    writeFileSync(join(dir, 'note.txt'), 'real file content');
    const rt = await createHeadRuntime(makeParent(dir), 'h2');
    const capture = new HeadCapture();

    const tools = buildHeadToolSet({
      input: aHeadInput(), capture, rt,
      history: createAgentStores(() => rt.storage.sql, () => rt.actor, rt.storage.transactionSync,
        async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor/.kinu/context' })).history,
      codemodeTool: { description: 'x', inputSchema: {}, execute: async () => ({ result: 'unused' }) },
      webSearch: stubWeb,
      split: async () => ({ narrative: '', decisions: [], unresolvedQuestions: [], blindSpots: [], childHeadIds: [], headCount: 0 }),
    });

    const run = toolExecute<{ command: string; runtime?: string }, string>(tools.shell);
    expect(String(await run({ command: 'cat note.txt' }))).toContain('real file content');
    await expect(run({ command: 'cat note.txt', runtime: 'device' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  /** A head's `workspace.*` crafted-tool EMA calls run over its own scratch database, which must carry `crafted_tools`. */
  test('its own workspace plane scores the tools it crafts', async () => {
    const rt = await createHeadRuntime(makeParent(), 'h3');
    const workspace = present(routerOf(rt).getProvider('workspace'), 'the workspace executor');

    expect(await workspace.tools.listTools.execute()).toEqual([]);
    expect(await workspace.tools.createTool.execute(
      'echo_back', 'Return its argument.', 'async (args) => args',
    )).toEqual({ ok: true, name: 'echo_back', action: 'created' });
    expect(await workspace.tools.listTools.execute()).toEqual([
      { name: 'echo_back', description: 'Return its argument.', qualityScore: CRAFT_NEUTRAL_PRIOR },
    ]);
  });
});

function barrier(n: number, onRelease: () => void): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });

  return async () => {
    if (++arrived === n) { onRelease(); open(); }

    await gate;
  };
}

/** Scripts write, wait, read on /local; the barrier means a shared scratch would hand one head the other's marker. */
function scratchProbeModel(arrive: () => Promise<void>, scratchPathFor: (name: string) => string): LanguageModel {
  const stepsByHead = new Map<string, number>();

  const envelope = probeEnvelope('fake-scratch');

  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-scratch',
    doGenerate: async (opts) => {
      const marker = /Your task: (\w+)/.exec(JSON.stringify(opts.prompt ?? ''))?.[1] ?? 'unknown';
      const step = (stepsByHead.get(marker) ?? 0) + 1;
      stepsByHead.set(marker, step);

      const fileCall = (input: JsonObject) => envelope([{
        type: 'tool-call' as const, toolCallId: `${marker}-${step}`, toolName: 'file',
        input: JSON.stringify(input),
      }], 'tool-calls');

      if (step === 1) return fileCall({ action: 'write', path: scratchPathFor(marker), content: `scratch-of-${marker}` });

      if (step === 2) {
        await arrive();

        return fileCall({ action: 'read', path: scratchPathFor(marker) });
      }

      return envelope([{ type: 'text' as const, text: 'done' }], 'stop');
    },
  });
}

function readBack(journal: HeadJournal, rootId: string, headId: string): string {
  const head = journal.readRun(rootId)?.heads.find((h) => h.id === headId);

  return (head === undefined ? [] : journal.readSteps(head.id))
    .flatMap((s) => s.toolCalls)
    .filter((c) => c.name === 'file')
    .map((c) => JSON.stringify(c.output ?? ''))
    .join('\n');
}

describe("a local head's state is its own actor's rows in the parent's ONE database", () => {
  test('two concurrent heads keep separate homes and separate rows, in one file', async () => {
    const parent = makeParent();
    const journal = makeJournal();
    // Captured while the head is live: a released head's directory row resolves to nothing.
    const issued = new Map<string, string>();

    const key = (id: string): string => {
      const known = issued.get(id);

      if (known !== undefined) return known;
      const minted = headStorageKey(parent, id);
      issued.set(id, minted);

      return minted;
    };

    const runtime = createCLIHeadRuntime(headDeps(
      scratchProbeModel(barrier(2, () => {}), (id) => `/home/${headAgentName(key(id))}/note.txt`),
      { journal: () => journal, parentRuntime: parent },
    ));

    const inputs = [
      aHeadInput({ id: 'alpha', task: 'alpha' }),
      aHeadInput({ id: 'beta', task: 'beta' }),
    ];

    for (const input of inputs) journal.insertSpawn(input);
    await Promise.all(inputs.map(async (input) => (await runtime.spawnHead(input)).run()));

    const root = inputs[0].rootId;
    expect(readBack(journal, root, 'alpha')).toContain('scratch-of-alpha');
    expect(readBack(journal, root, 'alpha')).not.toContain('scratch-of-beta');
    expect(readBack(journal, root, 'beta')).toContain('scratch-of-beta');
    expect(readBack(journal, root, 'beta')).not.toContain('scratch-of-alpha');

    expect(key('alpha')).not.toBe(key('beta'));
    expect(readdirSync(dirname(parent.db.filename)).filter((f) => f.endsWith('.db')))
      .toEqual([basename(parent.db.filename)]);
  });

  test('a head that throws retires its actor and leaves no live seat', async () => {
    const parent = makeParent();

    const exploding = new TestLanguageModelV2({
      provider: 'fake', modelId: 'boom',
      doGenerate: async () => { throw new Error('provider exploded'); },
    });

    const input = aHeadInput();
    const report = await (await createCLIHeadRuntime(headDeps(exploding, { parentRuntime: parent })).spawnHead(input)).run();
    expect(report.status).toBe('errored');
    expect(() => openLocalActor(parent.actor, explorationActorKey(input.id)))
      .toThrow(expect.objectContaining({ code: 'missing' }));
  });
});

/** Writes into shared /parent, waits for siblings, then extends: a workspace diff would misattribute sibling work. */
function sharedWorkspaceProbeModel(arrive: () => Promise<void>): LanguageModel {
  const stepsByHead = new Map<string, number>();

  const envelope = probeEnvelope('fake-shared');

  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-shared',
    doGenerate: async (opts) => {
      const marker = /Your task: (\w+)/.exec(JSON.stringify(opts.prompt ?? ''))?.[1] ?? 'unknown';
      const step = (stepsByHead.get(marker) ?? 0) + 1;
      stepsByHead.set(marker, step);

      const write = (content: string) => envelope([{
        type: 'tool-call' as const, toolCallId: `${marker}-${step}`, toolName: 'eval',
        input: JSON.stringify({
          code: `await parent.writeFile(${JSON.stringify(`${marker}.ts`)}, ${JSON.stringify(content)})`,
        }),
      }], 'tool-calls');

      if (step === 1) return write('one\n');

      if (step === 2) {
        await arrive();

        return write('one\ntwo\nthree\n');
      }

      return envelope([{ type: 'text' as const, text: 'done' }], 'stop');
    },
  });
}

describe('a head reports the files IT changed, with concurrent siblings on the same plane', () => {
  test('two heads writing at the same time do not smear into each other', async () => {
    const runtime = createCLIHeadRuntime(headDeps(
      sharedWorkspaceProbeModel(barrier(2, () => {})),
    ));

    const [alpha, beta] = await Promise.all([
      (await runtime.spawnHead(aHeadInput({ id: 'alpha', task: 'alpha' }))).run(),
      (await runtime.spawnHead(aHeadInput({ id: 'beta', task: 'beta' }))).run(),
    ]);

    expect(alpha.fileChanges).toEqual([
      { path: 'alpha.ts', status: 'added', added: 3, removed: 0 },
    ]);
    expect(beta.fileChanges).toEqual([
      { path: 'beta.ts', status: 'added', added: 3, removed: 0 },
    ]);
  });

  test('a head that touched no file reports none', async () => {
    const runtime = createCLIHeadRuntime(headDeps(capturingHeadModel('nothing to change', () => {})));
    const report = await (await runtime.spawnHead(aHeadInput())).run();
    expect(report.fileChanges).toEqual([]);
  });
});

describe("a head's eval holds the namespaces the shared description promises", () => {
  // Every backend's description promises `state.set`/`state.get` to every program, CLI heads included.
  test('state.set and state.get work inside a local head, over its own scratch', async () => {
    const journal = makeJournal();
    let step = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-state',
      doGenerate: async () => {
        step += 1;

        const content = step === 1
          ? [{
            type: 'tool-call' as const, toolCallId: 'state-1', toolName: 'eval',
            input: JSON.stringify({
              code: '// Keep a marker between programs\nawait state.set("marker", "kept");\nreturn await state.get("marker");',
            }),
          }]
          : [{ type: 'text' as const, text: 'done' }];

        return {
          content,
          finishReason: step === 1 ? 'tool-calls' as const : 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          response: { id: 'r', modelId: 'fake-state', timestamp: new Date(0) },
          warnings: [],
        };
      },
    });

    const runtime = createCLIHeadRuntime(headDeps(model, { journal: () => journal }));
    const input = aHeadInput({ id: 'stateful', task: 'stateful' });
    journal.insertSpawn(input);
    await (await runtime.spawnHead(input)).run();

    const outputs = journal.readSteps('stateful')
      .flatMap((s) => s.toolCalls)
      .filter((c) => c.name === 'eval')
      .map((c) => JSON.stringify(c.output ?? ''));

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toContain('kept');
    expect(outputs[0]).not.toContain('ReferenceError');
  });
});

describe('createCLIHeadRuntime — the mission ledger', () => {
  // Labels or nothing: this is the only bound on a head's spend and must not become a default one.
  test('a head with no labels never touches the ledger', async () => {
    const governor = makeGovernor();
    governor.declare('someone-elses-mission', { tokens: 1 }, {});
    governor.debit(10_000, { labels: ['someone-elses-mission'], calls: 1 });

    const runtime = createCLIHeadRuntime(headDeps(
      capturingHeadModel('did the work', () => {}),
      { governor: () => governor },
    ));

    const head = await runtime.spawnHead(aHeadInput());
    const report = await head.run();

    expect(report.status).toBe('completed');
    expect(report.summary).toBe('did the work');
    expect(governor.snapshot('someone-elses-mission')[0].calls).toBe(1);
  });

  test('a head carrying labels charges them as it runs', async () => {
    const governor = makeGovernor();
    governor.declare('sweep', { tokens: 1_000_000 }, {});

    const runtime = createCLIHeadRuntime(headDeps(
      capturingHeadModel('did the work', () => {}),
      { governor: () => governor },
    ));

    const head = await runtime.spawnHead(aHeadInput({ missionLabels: ['sweep'] }));
    expect((await head.run()).status).toBe('completed');

    const snap = governor.snapshot('sweep')[0];
    expect(snap.calls).toBe(1);
    expect(snap.spent.tokens).toBe(2);
  });

  test('a head carrying an exhausted label is refused before its first call', async () => {
    const governor = makeGovernor();
    governor.declare('sweep', { tokens: 5 }, {});
    governor.debit(10, { labels: ['sweep'], calls: 1 });

    let calls = 0;

    const runtime = createCLIHeadRuntime(headDeps(
      capturingHeadModel('should never run', () => { calls++; }),
      { governor: () => governor },
    ));

    const head = await runtime.spawnHead(aHeadInput({ missionLabels: ['sweep'] }));
    const report = await head.run();

    expect(report.status).toBe('budget_exceeded');
    expect(report.errorMessage).toContain('Mission budget "sweep" is spent');
    expect(calls).toBe(0);
  });
});

/** A per-search `model` from `agents swarm` is honoured per head, as on the cf backend. */
describe('createCLIHeadRuntime — a fork runs the model it was given', () => {
  function labelledModel(id: string, seen: string[]): LanguageModel {
    return new TestLanguageModelV2({
      provider: 'fake', modelId: id,
      doGenerate: async () => {
        seen.push(id);

        return {
          content: [{ type: 'text', text: `${id} looked at its angle.` }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          response: { id: 'r', modelId: id, timestamp: new Date(0) },
          warnings: [],
        };
      },
    });
  }

  test('each head resolves its OWN spec; a head that named none inherits the session model', async () => {
    const seen: string[] = [];

    const runtime = createCLIHeadRuntime(headDeps(labelledModel('session', seen), {
      resolveModel: (spec: string) => labelledModel(spec, seen),
    }));

    for (const input of [
      aHeadInput({ id: 'h-a', model: 'vendor-a/big' }),
      aHeadInput({ id: 'h-b', model: 'vendor-b/big' }),
      aHeadInput({ id: 'h-c' }),
    ]) {
      await (await runtime.spawnHead(input)).run();
    }

    expect(seen).toEqual(['vendor-a/big', 'vendor-b/big', 'session']);
  });

  test('a session with no resolver still runs every fork on its own model', async () => {
    const seen: string[] = [];
    const runtime = createCLIHeadRuntime(headDeps(labelledModel('session', seen)));

    await (await runtime.spawnHead(aHeadInput({ id: 'h-a', model: 'vendor-a/big' }))).run();

    expect(seen).toEqual(['session']);
  });

  test('an unresolvable spec degrades to the session model instead of failing the fork', async () => {
    const seen: string[] = [];

    const runtime = createCLIHeadRuntime(headDeps(labelledModel('session', seen), {
      resolveModel: (spec: string) => { throw new Error(`no such provider for ${spec}`); },
    }));

    const report = await (await runtime.spawnHead(aHeadInput({ id: 'h-a', model: 'nope/nope' }))).run();

    expect(report.status).toBe('completed');
    expect(seen).toEqual(['session']);
  });
});

describe("the merge synthesis' operation lifecycle", () => {
  function mergeModel(text: string): LanguageModel {
    return new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake',
      doGenerate: async () => ({
        content: [{ type: 'text', text }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
        response: { id: 'r', modelId: 'fake-merge', timestamp: new Date(0) },
        warnings: [],
      }),
    });
  }

  const GOOD_MERGE =
    '{"narrative":"Unified: both heads agree the parser is sound.","selected_decisions":[],"unresolved_questions":[],"recommendations":["ship it"]}';

  function runtimeWith(model: LanguageModel) {
    const operations: ModelOperationEvent[] = [];
    const reports: ModelCallReport[] = [];

    const runtime = createCLIHeadRuntime(headDeps(model, {
      operations: (event) => operations.push(event),
      reportModelCall: (report) => reports.push(report),
    }));

    return { operations, reports, runtime };
  }

  test('a successful merge writes start and end rows joined by operationId, with usage', async () => {
    const { operations, reports, runtime } = runtimeWith(mergeModel(GOOD_MERGE));

    await runtime.mergeLLM('merging the findings of 2 heads', MergeOutputSchema);

    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations.map((e) => [e.source, e.op])).toEqual([['judge', 'generate_json'], ['judge', 'generate_json']]);
    expect(operations[1].outcome).toBe('ok');
    expect(operations[1].usage).toEqual({ input: 8, output: 12 });
    expect(operations[1].modelId).toBe('fake-merge');
    expect(reports).toEqual([{ source: 'judge', usage: { input: 8, output: 12 }, modelId: 'fake-merge' }]);
  });

  test('a thrown provider leaves a failed end row and rethrows', async () => {
    const { operations, reports, runtime } = runtimeWith(new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake',
      doGenerate: async () => { throw new Error('socket hung up'); },
    }));

    await expect(runtime.mergeLLM('merging the findings of 2 heads', MergeOutputSchema)).rejects.toThrow('socket hung up');

    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[1].outcome).toBe('failed');
    expect(operations[1].error).toContain('socket hung up');
    expect(operations[1].usage).toBeUndefined();
    expect(reports).toEqual([]);
  });

  test('malformed JSON still records completed provider usage before the parse refusal', async () => {
    const { operations, reports, runtime } = runtimeWith(mergeModel('not json at all'));

    await expect(runtime.mergeLLM('merging the findings of 2 heads', MergeOutputSchema)).rejects.toThrow();

    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[1].outcome).toBe('ok');
    expect(operations[1].usage).toEqual({ input: 8, output: 12 });
    expect(reports).toHaveLength(1);
  });
});

test('the public head abort cancels its in-flight provider request, not a sibling head', async () => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<never>();
  let calls = 0;
  let providerStopped = false;

  const model = scriptedTurnModel({ provider: 'fake', modelId: 'cancel-head', doGenerate: options => {
    if (calls++ > 0) return {
      content: [{ type: 'text', text: 'sibling finished' }], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    };
    const signal = options.abortSignal;

    if (signal !== undefined) signal.addEventListener('abort', () => {
      providerStopped = true;
      pending.reject(signal.reason);
    }, { once: true });
    started.resolve();

    return pending.promise;
  } });

  const runtime = createCLIHeadRuntime(headDeps(model));
  const first = await runtime.spawnHead(aHeadInput({ id: 'cancel-first' }));
  const running = first.run();
  await started.promise;
  await first.abort('operator stopped this head');

  try {
    expect(providerStopped).toBe(true);
    expect(await running).toMatchObject({ status: 'aborted', errorMessage: 'operator stopped this head' });
    const second = await runtime.spawnHead(aHeadInput({ id: 'uncancelled-sibling' }));
    expect(await second.run()).toMatchObject({ status: 'completed', summary: 'sibling finished' });
  } finally {
    pending.reject(new Error('release the test provider'));
    await running;
  }
});
