// createCLIHeadRuntime — local in-process branching heads. A head is a FORK of
// the parent runtime: the parent's real host executor + files, a private durable
// scratch. These tests drive a full HeadController split → run → merge cycle with
// a prompt-aware fake model, assert the head's real tool surface, and prove the
// runtime-level fork capability (real /parent files + real `run laptop` exec)
// that the caffe fork lacked — all without a network LLM.
import { afterAll, describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { LanguageModelV2, LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  HeadController, HeadJournal, initHeadsTables, buildHeadToolSet, HeadCapture, MergeOutputSchema,
  MissionGovernor, CRAFT_NEUTRAL_PRIOR, reasoningEffortOptions,
  type ReasoningEffort,
  type HeadInput, type WebSearchProvider, type AgentRuntime, type JsonObject,
  type ModelCallReport, type ModelOperationEvent,
} from '@kinu.run/core';
import {
  MERGE_POLICY_BINDING, MERGE_POLICY_JUDGE_MODEL, MERGE_POLICY_SPEND_SOURCE,
  mergePolicyProfile, scratchDir, scratchPath, toolExecute,
} from '@kinu.run/test-utils';
import { createCLIHeadRuntime, type CLIHeadRuntimeDeps } from '../src/head-runtime';
import { makeSql, makeExecRaw, createCLIRuntime, buildCLIHeadRuntime } from '../src/runtime';

// A local head's scratch is a real store under KINU_HOME (home.ts is the
// isolation boundary), so point that boundary at a temp dir before anything
// reads it: a test run must never write into the real home. Restored afterwards
// so files running later in the same process keep the caller's boundary.
const priorKinuHome = process.env.KINU_HOME;
process.env.KINU_HOME = scratchDir('head-runtime-home');
const HEAD_SCRATCH_DIR = join(process.env.KINU_HOME, 'heads');
afterAll(() => {
  if (priorKinuHome === undefined) delete process.env.KINU_HOME;
  else process.env.KINU_HOME = priorKinuHome;
});

/** Scratch stores present right now — [] before any head has ever run. */
function scratchStores(): string[] {
  return existsSync(HEAD_SCRATCH_DIR) ? readdirSync(HEAD_SCRATCH_DIR).filter((f) => f.endsWith('.db')) : [];
}

/** A never-called web provider — the surface tests only inspect tool NAMES. */
const stubWeb: WebSearchProvider = {
  search: async () => ({ query: '', results: [], source: 'duckduckgo' }),
  fetch: async () => ({ url: '', title: '', markdown: '', retrievedAt: '' }),
};

/** A parent CLI runtime — the real execution surface every head forks. */
function makeParent(): AgentRuntime {
  return createCLIRuntime(new Database(':memory:'), {
    dbPath: scratchPath('head-runtime-parent', 'parent.db'),
    llm: { name: 'x', baseURL: 'http://l', headers: {}, model: 'm' },
  });
}

/** A governor over its own scratch ledger. A local head charges through this
 *  directly — the cf backend's has to cross a facet boundary to reach one. */
function makeGovernor(): MissionGovernor {
  const db = new Database(':memory:');
  return new MissionGovernor({ storage: { sql: makeSql(db), execRaw: makeExecRaw(db) } });
}

/** A journal over its own scratch storage. A local head writes its steps here
 *  directly — the cf backend's has to cross a facet boundary to reach one. */
function makeJournal(): HeadJournal {
  const db = new Database(':memory:');
  initHeadsTables(makeExecRaw(db));
  return new HeadJournal(makeSql(db));
}

/** What the merge asked its binder for — the route it actually took. Shared by
 *  every deps builder below, so any merge in this file is measurable. */
interface RouteProbe {
  readonly asked: Array<{ spec: string; effort: ReasoningEffort }>;
}

/** Head-runtime deps around a fresh parent, with test overrides.
 *
 *  `profile` and `bindMergeModel` are the merge's whole local surface: core's
 *  `headMergeLLM` resolves the `judge` route off the profile and hands the
 *  resolution here, so this binder records the routed decision and answers with
 *  the merge model. It deliberately does NOT answer with `model` — the merge
 *  used to run the session's chat model at a hardcoded `'low'` effort while
 *  filing `judge` spend, and a binder that ignored the route could not tell
 *  that regression from the fix. */
function headDeps(
  model: LanguageModel,
  over?: Partial<CLIHeadRuntimeDeps>,
  probe?: RouteProbe,
): CLIHeadRuntimeDeps {
  const governor = makeGovernor();
  const journal = makeJournal();
  return {
    model: () => model, parentRuntime: makeParent(),
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

/** Records the tool names the SDK hands a head's generateText call. */
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
        runSchemaSink(JSON.stringify((opts.tools ?? []).find((candidate) => candidate.name === 'run')));
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
  inheritedContext: [], budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
  mergeStrategy: 'synthesize', ...over, mode: over?.mode ?? 'build',
});

/** A v2 generateText model that answers differently for a head run vs the merge
 *  synthesis (the merge prompt says "merging the findings of N … heads"). */
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
  const journal = new HeadJournal(makeSql(db));
  const overrides: Partial<CLIHeadRuntimeDeps> = { journal: () => journal };
  return {
    journal,
    controller: new HeadController(createCLIHeadRuntime(headDeps(model, overrides, probe)), journal),
  };
}

describe('createCLIHeadRuntime — full split → run → merge', () => {
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
      parentBudget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    expect(result.mergedNarrative).toContain('Unified');
    expect(result.recommendations).toContain('ship it');
    expect(result.costSummary.headCount).toBe(2);
    expect(result.headIds).toHaveLength(2);
  });

  // The merge is the one model call in a split that the head journal does not
  // carry: `summarizeCost` folds the HEADS' reports (core heads/controller.ts:
  // 611-624), so an unreported merge is spend nothing counts. The heads must NOT
  // report through here — their usage comes back in the journal, and two writers
  // for one call is how a workspace total learns to double-count.
  test('the merge reports its own spend as judge, and the heads report none', async () => {
    const reports: ModelCallReport[] = [];
    const db = new Database(':memory:');
  initHeadsTables(makeExecRaw(db));
    const journal = new HeadJournal(makeSql(db));
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
      parentBudget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      source: MERGE_POLICY_SPEND_SOURCE, usage: { input: 8, output: 12 },
    });
  });

  /**
   * THE DRIFT THIS CLOSES, measured on the local side.
   *
   * The merge ran `deps.model()` — the SESSION'S CHAT MODEL — at a hardcoded
   * `reasoningEffortOptions('low', …)`, and filed the result as `judge` spend.
   * The Cloudflare merge resolved the `judge` route off the turn profile and ran
   * at the deep tier's own effort. So one split, one account, two models, both
   * reported as deep-tier grading.
   *
   * The expectation is `MERGE_POLICY_BINDING` from the shared fixture — the same
   * value `unit-head-runtime-operations.test.ts` asserts on the cloud side over
   * the same catalog. Two suites, one equality.
   */
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
      parentBudget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    expect(probe.asked).toEqual([MERGE_POLICY_BINDING]);
    // Both halves of the tier, stated separately so a half-routed merge — the
    // routed model at somebody's constant effort — fails on the axis it dropped.
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
      parentBudget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    expect(mergeOptions?.maxOutputTokens).toBeUndefined();
    // The DEEP tier's effort, derived from the routed decision by the binder —
    // not the `'low'` this seam used to name for itself.
    expect(mergeOptions?.providerOptions).toEqual({
      openai: { reasoningEffort: MERGE_POLICY_BINDING.effort },
    });
  });

  test('a head is offered the real fork surface: run + file + execute_tools + web + record + split', async () => {
    let captured: string[] = [];
    const runtime = createCLIHeadRuntime(headDeps(capturingHeadModel('done', (t) => { captured = t; })));
    await (await runtime.spawnHead(aHeadInput())).run();
    expect(new Set(captured)).toEqual(new Set([
      'record_evidence', 'record_decision',
      'execute_tools', 'run', 'file', 'web',
      'split_subheads',
    ]));
  });

  test('the prompt names private scratch and the parent workspace exactly as the CLI exposes them', async () => {
    let prompt = '';
    let runSchema = '';
    const runtime = createCLIHeadRuntime(headDeps(capturingHeadModel(
      'done',
      () => {},
      (value) => { prompt = value; },
      (value) => { runSchema = value; },
    )));
    await (await runtime.spawnHead(aHeadInput())).run();

    expect(prompt).toContain('workspace.*` is your private scratch');
    expect(prompt).toContain('parent.*` is the canonical parent workspace');
    expect(prompt).toContain('runtime `parent`');
    expect(prompt).not.toContain('`workspace.*` is the canonical workspace you were forked from');
    expect(runSchema).toContain('"parent"');
  });

  test('allowedTools maps the PARENT vocabulary onto real tools (never empties)', async () => {
    // The old bug: a fork with allowedTools:["run"] was filtered against a
    // disjoint sandbox_* head surface and silently ran with ZERO tools. Now the
    // head's vocabulary IS the parent's, so ["run"] resolves to exactly run.
    let captured: string[] = [];
    const runtime = createCLIHeadRuntime(headDeps(capturingHeadModel('done', (t) => { captured = t; })));
    await (await runtime.spawnHead(aHeadInput({ allowedTools: ['run'] }))).run();
    expect(captured).toEqual(['run']);
  });

  test('phase events fire on split and merge', async () => {
    const { controller } = controllerWithCLIRuntime(fakeHeadsModel());
    const phases: string[] = [];
    await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: { rationale: 'r', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
      onPhase: (e) => phases.push(e.kind),
    });
    expect(phases).toEqual(['split', 'merge']);
  });

  /**
   * The trace has to REACH the journal, not merely exist as a shape.
   *
   * This is the one property the Exploration surface's live branch view rests
   * on, and the whole path was declared and connected nowhere: `head_steps`
   * existed, `HeadJournal.appendStep` had no callers, and
   * `HeadInferenceDeps.reportStep` was an optional seam with no provider — so
   * `await deps.reportStep?.(…)` no-opped on every step of every head and every
   * branch read "no step trace captured" for its whole life. Nothing failed;
   * the pane was simply always empty. Asserting through `readRun`, the exact
   * projection the surface reads, is what makes cutting that wire visible.
   */
  test('every head step reaches the journal, so a branch trace is readable', async () => {
    const { controller, journal } = controllerWithCLIRuntime(fakeHeadsModel());
    const result = await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: { rationale: 'trace me', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    const run = journal.readRun(result.headIds[0]!.split('-d')[0]!);
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
    const headDb = new Database(':memory:');
    const rt = buildCLIHeadRuntime(headDb, {
      parentRuntime: parent, agentId: 'h', agentName: 'head-h',
    });

    // The parent's workspace, through the parent EXECUTOR — the exact thing the
    // old :memory:-backed fork could not see.
    const parentExec = rt.executionRouter!.getProvider('parent')!;
    expect(await parentExec.tools.readFile.execute('hello.txt')).toBe('from the parent workspace');
    // And its real shell, in one call rather than a per-file walk.
    expect(String(await parentExec.tools.exec.execute('cat hello.txt')))
      .toContain('from the parent workspace');

    // Real commands run through the parent's shared laptop executor.
    const laptop = rt.executionRouter!.getProvider('laptop')!;
    const out = await laptop.tools.exec!.execute(`cat ${join(dir, 'hello.txt')}`);
    expect(String(out)).toContain('from the real machine');

    // Its own filesystem is PRIVATE scratch — not the host, not the parent.
    await rt.storage.vfs.writeFile('scratch.txt', 'private');
    expect(existsSync(join(dir, 'scratch.txt'))).toBe(false);
    expect(await parent.storage.vfs.exists('scratch.txt')).toBe(false);
    headDb.close();
  // Measured 2.7 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);

  test('the head run tool reaches the real host with runtime=laptop', async () => {
    const dir = scratchDir('head-runtime-cwd');
    writeFileSync(join(dir, 'note.txt'), 'real file content');
    const rt = buildCLIHeadRuntime(new Database(':memory:'), {
      parentRuntime: makeParent(), agentId: 'h2', agentName: 'head-h2',
    });
    const capture = new HeadCapture();
    const tools = buildHeadToolSet({
      input: aHeadInput(), capture, rt,
      executeTool: { description: 'x', inputSchema: {}, execute: async () => ({ result: 'unused' }) },
      webSearch: stubWeb,
      split: async () => ({ narrative: '', decisions: [], unresolvedQuestions: [], blindSpots: [], childHeadIds: [], headCount: 0 }),
    });

    const run = toolExecute<{ command: string; runtime: string }, string>(tools.run);
    const out = await run({ command: `cat ${join(dir, 'note.txt')}`, runtime: 'laptop' });
    expect(String(out)).toContain('real file content');
  });

  /**
   * A head's `workspace.*` plane reads AND writes the crafted-tool EMA
   * (`crafted_tools` quality columns) through the same inline executor the parent registers —
   * `listTools` quotes the score, `createTool` seeds the neutral prior — but over
   * the head's OWN scratch database, which `buildCLIHeadRuntime` provisions
   * itself. The parent's copy comes from `initWorkspaceSchema`; the scratch got
   * the VFS, the memory store and the craft store and nothing else, so every one
   * of those calls raised `no such table: crafted_tools` inside a head. A live
   * delegation run died there after the turn had already been paid for, and
   * `createTool` was worse than the raised read: the tool WAS written, then the
   * seed threw and the model was told its tool had failed.
   */
  test('its own workspace plane scores the tools it crafts', async () => {
    const rt = buildCLIHeadRuntime(new Database(':memory:'), {
      parentRuntime: makeParent(), agentId: 'h3', agentName: 'head-h3',
    });
    const workspace = rt.executionRouter!.getProvider('workspace')!;

    expect(await workspace.tools.listTools!.execute()).toEqual([]);
    expect(await workspace.tools.createTool!.execute(
      'echo_back', 'Return its argument.', 'async (args) => args',
    )).toEqual({ ok: true, name: 'echo_back', action: 'created' });
    expect(await workspace.tools.listTools!.execute()).toEqual([
      { name: 'echo_back', description: 'Return its argument.', qualityScore: CRAFT_NEUTRAL_PRIOR },
    ]);
  });
});

/** Releases every caller only once `n` of them have arrived, running `onRelease`
 *  first. Lets a test assert on a moment when every concurrent head is mid-run. */
function barrier(n: number, onRelease: () => void): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return async () => {
    if (++arrived === n) { onRelease(); open(); }
    await gate;
  };
}

/**
 * A head model that scripts three steps against the `file` tool: write its own
 * marker into /local, wait until every sibling has written, then read it back.
 * The barrier is what makes the isolation assertion deterministic — both heads
 * have written before either reads, so a SHARED scratch would hand one of them
 * the other's marker.
 */
function scratchProbeModel(arrive: () => Promise<void>): LanguageModel {
  const stepsByHead = new Map<string, number>();
  const envelope = (
    content: Awaited<ReturnType<LanguageModelV2['doGenerate']>>['content'],
    finishReason: 'tool-calls' | 'stop',
  ): Awaited<ReturnType<LanguageModelV2['doGenerate']>> => ({
    content,
    finishReason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    response: { id: 'r', modelId: 'fake-scratch', timestamp: new Date(0) },
    warnings: [],
  });
  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-scratch',
    doGenerate: async (opts) => {
      // Which head this is: its own system prompt names its task, and every
      // later step re-sends it.
      const marker = /Your task: (\w+)/.exec(JSON.stringify(opts.prompt ?? ''))?.[1] ?? 'unknown';
      const step = (stepsByHead.get(marker) ?? 0) + 1;
      stepsByHead.set(marker, step);
      const fileCall = (input: JsonObject) => envelope([{
        type: 'tool-call' as const, toolCallId: `${marker}-${step}`, toolName: 'file',
        input: JSON.stringify(input),
      }], 'tool-calls');
      if (step === 1) return fileCall({ action: 'write', path: 'note.txt', content: `scratch-of-${marker}` });
      if (step === 2) { await arrive(); return fileCall({ action: 'read', path: 'note.txt' }); }
      return envelope([{ type: 'text' as const, text: 'done' }], 'stop');
    },
  });
}

/**
 * What a head's `file` read returned, from its own step trace.
 *
 * Read out of the journal, which is where a head's steps live now — the report
 * carries the outcome, not the trace. Passing the journal in also means this
 * asserts the trace ARRIVED, which is the property the surface depends on.
 */
function readBack(journal: HeadJournal, rootId: string, headId: string): string {
  const head = journal.readRun(rootId)?.heads.find((h) => h.id === headId);
  return (head === undefined ? [] : journal.readSteps(head.id))
    .flatMap((s) => s.toolCalls)
    .filter((c) => c.name === 'file')
    .map((c) => JSON.stringify(c.output ?? ''))
    .join('\n');
}

describe("a local head's scratch is a real store, private to it, and swept when it finishes", () => {
  test('two concurrent heads each get their own durable scratch, and neither sees the other', async () => {
    const before = scratchStores();
    let midRun: string[] = [];
    const journal = makeJournal();
    const runtime = createCLIHeadRuntime(headDeps(
      scratchProbeModel(barrier(2, () => { midRun = scratchStores(); })),
      { journal: () => journal },
    ));

    const inputs = [
      aHeadInput({ id: 'alpha', task: 'alpha' }),
      aHeadInput({ id: 'beta', task: 'beta' }),
    ];
    for (const input of inputs) journal.insertSpawn(input);
    await Promise.all(inputs.map(async (input) => (await runtime.spawnHead(input)).run()));

    // Durable: while both heads were running, each had a real store on disk —
    // not a `new Database(':memory:')` living in this process's heap.
    expect(midRun.sort()).toEqual(['alpha.db', 'beta.db']);

    // Private: each head read back its OWN marker, and the sibling's is absent.
    // Read through the journal, so this also proves the trace arrived there.
    const root = inputs[0]!.rootId;
    expect(readBack(journal, root, 'alpha')).toContain('scratch-of-alpha');
    expect(readBack(journal, root, 'alpha')).not.toContain('scratch-of-beta');
    expect(readBack(journal, root, 'beta')).toContain('scratch-of-beta');
    expect(readBack(journal, root, 'beta')).not.toContain('scratch-of-alpha');

    // Swept: a finished head leaves nothing behind, so scratch never accumulates.
    expect(scratchStores()).toEqual(before);
  });

  test('a head that throws still leaves no scratch behind', async () => {
    const before = scratchStores();
    const exploding = new TestLanguageModelV2({
      provider: 'fake', modelId: 'boom',
      doGenerate: async () => { throw new Error('provider exploded'); },
    });
    const report = await (await createCLIHeadRuntime(headDeps(exploding)).spawnHead(aHeadInput())).run();
    expect(report.status).toBe('errored');
    expect(scratchStores()).toEqual(before);
  });
});

/**
 * A head model that writes its own file into the SHARED /parent, waits until
 * every sibling has done the same, and then extends it. The barrier is the whole
 * point: at the moment either head extends its file, BOTH heads' files exist on
 * the shared plane, so a design that answered "what did this head change?" by
 * diffing the workspace would hand each head the other's work too.
 */
function sharedWorkspaceProbeModel(arrive: () => Promise<void>): LanguageModel {
  const stepsByHead = new Map<string, number>();
  const envelope = (
    content: Awaited<ReturnType<LanguageModelV2['doGenerate']>>['content'],
    finishReason: 'tool-calls' | 'stop',
  ): Awaited<ReturnType<LanguageModelV2['doGenerate']>> => ({
    content,
    finishReason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    response: { id: 'r', modelId: 'fake-shared', timestamp: new Date(0) },
    warnings: [],
  });
  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-shared',
    doGenerate: async (opts) => {
      const marker = /Your task: (\w+)/.exec(JSON.stringify(opts.prompt ?? ''))?.[1] ?? 'unknown';
      const step = (stepsByHead.get(marker) ?? 0) + 1;
      stepsByHead.set(marker, step);
      // Through the parent EXECUTOR: that is where a head's writes to its
      // parent land, and where attribution is recorded.
      const write = (content: string) => envelope([{
        type: 'tool-call' as const, toolCallId: `${marker}-${step}`, toolName: 'execute_tools',
        input: JSON.stringify({
          code: `await parent.writeFile(${JSON.stringify(`${marker}.ts`)}, ${JSON.stringify(content)})`,
        }),
      }], 'tool-calls');
      if (step === 1) return write('one\n');
      if (step === 2) { await arrive(); return write('one\ntwo\nthree\n'); }
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

    // Each head reports exactly its own file, at its NET line count (two writes
    // to that path, one entry, three lines) — written while the other head was
    // still running, which is the smear scenario rather than a sequential one.
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

describe("a head's execute_tools holds the namespaces the shared description promises", () => {
  // The description every backend renders promises `state.set`/`state.get` to
  // every program. Red on 2026-09-05: the CLI head bound web and llm only, so a
  // fork program calling `state.set` answered a bare ReferenceError while the
  // same program on a hosted head ran.
  test('state.set and state.get work inside a local head, over its own scratch', async () => {
    const journal = makeJournal();
    let step = 0;
    const model = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-state',
      doGenerate: async () => {
        step += 1;
        const content = step === 1
          ? [{
            type: 'tool-call' as const, toolCallId: 'state-1', toolName: 'execute_tools',
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
      .filter((c) => c.name === 'execute_tools')
      .map((c) => JSON.stringify(c.output ?? ''));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toContain('kept');
    expect(outputs[0]).not.toContain('ReferenceError');
  });
});

describe('createCLIHeadRuntime — the mission ledger', () => {
  // A local head runs in the same process as the ledger, so its port is the
  // governor itself. The invariant is the same on both backends: labels or
  // nothing. Head execution caps were removed entirely, so this is the only
  // remaining bound on a head's spend — and it must not become a default one.
  test('a head with no labels never touches the ledger', async () => {
    const governor = makeGovernor();
    // A cap that WOULD refuse everything, if anything ever asked about it.
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
    // The exhausted label is untouched: nothing bound this head to it.
    expect(governor.snapshot('someone-elses-mission')[0]!.calls).toBe(1);
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

    const snap = governor.snapshot('sweep')[0]!;
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

/**
 * Per-fork models — `agents fork` advertises a per-fork `model` and the cf
 * backend honours it (exploration.ts resolves `input.model` per head). The CLI
 * ran `deps.model` for every head, so the field was a silent no-op here: a panel
 * asked for three vendors got three copies of one, and any measurement of panel
 * diversity on this backend would have compared a mixed panel against itself.
 */
describe('createCLIHeadRuntime — a fork runs the model it was given', () => {
  /** Answers like a head and reports which model id served the call. */
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

    // One fork's bad model must not take down a split the siblings are running.
    const report = await (await runtime.spawnHead(aHeadInput({ id: 'h-a', model: 'nope/nope' }))).run();

    expect(report.status).toBe('completed');
    expect(seen).toEqual(['session']);
  });
});

describe("the merge synthesis' operation lifecycle", () => {
  /** A model that answers ONLY the merge call, scripted per test. The usage is
   *  what the provider said — the shape the operation's end row must carry. */
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
    expect(operations[1]!.outcome).toBe('ok');
    expect(operations[1]!.usage).toEqual({ input: 8, output: 12 });
    expect(operations[1]!.modelId).toBe('fake-merge');
    // The cost report is unchanged by the lifecycle beside it.
    expect(reports).toEqual([{ source: 'judge', usage: { input: 8, output: 12 }, modelId: 'fake-merge' }]);
  });

  test('a thrown provider leaves a failed end row and rethrows', async () => {
    const { operations, reports, runtime } = runtimeWith(new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake',
      doGenerate: async () => { throw new Error('socket hung up'); },
    }));

    await expect(runtime.mergeLLM('merging the findings of 2 heads', MergeOutputSchema)).rejects.toThrow('socket hung up');

    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[1]!.outcome).toBe('failed');
    expect(operations[1]!.error).toContain('socket hung up');
    // No provider answer ⇒ no usage anywhere, and no cost report either.
    expect(operations[1]!.usage).toBeUndefined();
    expect(reports).toEqual([]);
  });

  test('malformed JSON still records completed provider usage before the parse refusal', async () => {
    const { operations, reports, runtime } = runtimeWith(mergeModel('not json at all'));

    await expect(runtime.mergeLLM('merging the findings of 2 heads', MergeOutputSchema)).rejects.toThrow();

    // The OPERATION succeeded — the provider answered and was billed; whether
    // the output parses is the controller's verdict, not this frame's.
    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[1]!.outcome).toBe('ok');
    expect(operations[1]!.usage).toEqual({ input: 8, output: 12 });
    expect(reports).toHaveLength(1);
  });
});
