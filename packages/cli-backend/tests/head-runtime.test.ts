// createCLIHeadRuntime — local in-process branching heads. A head is a FORK of
// the parent runtime: the parent's real host executor + files, a private durable
// scratch. These tests drive a full HeadController split → run → merge cycle with
// a prompt-aware fake model, assert the head's real tool surface, and prove the
// runtime-level fork capability (real /workspace files + real `run laptop` exec)
// that the caffe fork lacked — all without a network LLM.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import {
  HeadController, HeadJournal, initHeadsTables, buildHeadToolSet, HeadCapture,
  type HeadInput, type WebSearchProvider, type AgentRuntime,
} from '@proteus/core';
import { createCLIHeadRuntime, type CLIHeadRuntimeDeps } from '../src/head-runtime.js';
import { makeSql, makeExecRaw, createCLIRuntime, buildCLIHeadRuntime } from '../src/runtime.js';

/** A never-called web provider — the surface tests only inspect tool NAMES. */
const stubWeb: WebSearchProvider = {
  search: async () => ({ query: '', results: [], source: 'stub' as never }),
  fetch: async () => ({ url: '', title: '', markdown: '', retrievedAt: '' }),
};

/** A parent CLI runtime — the real execution surface every head forks. */
function makeParent(): AgentRuntime {
  return createCLIRuntime(new Database(':memory:') as never, {
    dbPath: '/tmp/parent.db', llm: { name: 'x', baseURL: 'http://l', headers: {}, model: 'm' },
  });
}

/** Head-runtime deps around a fresh parent, with test overrides. */
function headDeps(model: LanguageModel, over?: Partial<CLIHeadRuntimeDeps>): CLIHeadRuntimeDeps {
  return {
    model, parentRuntime: makeParent(), cwd: process.cwd(),
    webSearch: stubWeb, codemodeExtras: () => [], ...over,
  };
}

/** Records the tool names the SDK hands a head's generateText call. */
function capturingHeadModel(answer: string, sink: (names: string[]) => void): LanguageModel {
  return {
    specificationVersion: 'v2', provider: 'fake', modelId: 'fake', supportedUrls: {},
    doGenerate: async (opts: { tools?: Array<{ name: string }> }) => {
      sink((opts.tools ?? []).map((t) => t.name));
      return {
        content: [{ type: 'text', text: answer }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        response: { id: 'r', modelId: 'fake', timestamp: new Date(0) },
        warnings: [],
      };
    },
  } as unknown as LanguageModel;
}

const aHeadInput = (over?: Partial<HeadInput>): HeadInput => ({
  id: 'h1', rootId: 'r1', parentId: null, depth: 0, task: 't', rationale: 'r',
  inheritedContext: [], budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
  mergeStrategy: 'synthesize', ...over,
});

/** A v2 generateText model that answers differently for a head run vs the merge
 *  synthesis (the merge prompt says "merging the findings of N … heads"). */
function fakeHeadsModel(capture?: (options: {
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}, isMerge: boolean) => void): LanguageModel {
  const usage = { inputTokens: 8, outputTokens: 12 };
  return {
    specificationVersion: 'v2', provider: 'fake', modelId: 'fake', supportedUrls: {},
    doGenerate: async (opts: {
      prompt?: unknown;
      maxOutputTokens?: number;
      providerOptions?: Record<string, Record<string, unknown>>;
    }) => {
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
  } as unknown as LanguageModel;
}

function controllerWithCLIRuntime(model: LanguageModel, providerFamily?: string) {
  const db = new Database(':memory:');
  initHeadsTables(makeExecRaw(db));
  const journal = new HeadJournal(makeSql(db));
  return new HeadController(createCLIHeadRuntime(headDeps(model, providerFamily ? { providerFamily } : {})), journal);
}

describe('createCLIHeadRuntime — full split → run → merge', () => {
  test('two heads run in-process and the merge synthesizes their findings', async () => {
    const controller = controllerWithCLIRuntime(fakeHeadsModel());
    const result = await controller.run({
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

  test('merge synthesis uses low provider effort without an output cap', async () => {
    let mergeOptions: {
      maxOutputTokens?: number;
      providerOptions?: Record<string, Record<string, unknown>>;
    } | undefined;
    const controller = controllerWithCLIRuntime(
      fakeHeadsModel((options, isMerge) => { if (isMerge) mergeOptions = options; }),
      'openai',
    );
    await controller.run({
      parentHeadId: null,
      inheritedContext: [],
      request: {
        rationale: 'compare two views',
        heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }],
      },
      parentBudget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    expect(mergeOptions?.maxOutputTokens).toBeUndefined();
    expect(mergeOptions?.providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });
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
    const controller = controllerWithCLIRuntime(fakeHeadsModel());
    const phases: string[] = [];
    await controller.run({
      parentHeadId: null,
      inheritedContext: [],
      request: { rationale: 'r', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: Date.now() },
      onPhase: (e) => phases.push(e.kind),
    });
    expect(phases).toEqual(['split', 'merge']);
  });
});

describe('a local head forks the parent runtime (the caffe-fork capability)', () => {
  test('sees real workspace files, runs real commands, keeps /local private', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proteus-head-'));
    writeFileSync(join(dir, 'hello.txt'), 'from the real workspace');
    const parent = makeParent();
    const headDb = new Database(':memory:');
    const rt = buildCLIHeadRuntime(headDb as never, {
      parentRuntime: parent, cwd: dir, agentId: 'h', agentName: 'head-h',
    });

    // Real workspace files are visible through the /workspace mount — the exact
    // thing the old :memory:-backed fork could not see.
    const seen = await rt.storage.vfs.readFile('/workspace/hello.txt', { encoding: 'utf8' });
    expect(seen).toBe('from the real workspace');

    // Real commands run through the parent's shared laptop executor.
    const laptop = rt.executionRouter!.getProvider('laptop')!;
    const out = await laptop.tools.exec!.execute(`cat ${join(dir, 'hello.txt')}`);
    expect(String(out)).toContain('from the real workspace');

    // /local is a PRIVATE scratch overlay, not a window onto the host.
    await rt.storage.vfs.writeFile('/local/scratch.txt', 'private');
    expect(existsSync(join(dir, 'scratch.txt'))).toBe(false);
    headDb.close();
  });

  test('the head run tool reaches the real host with runtime=laptop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proteus-head-'));
    writeFileSync(join(dir, 'note.txt'), 'real file content');
    const rt = buildCLIHeadRuntime(new Database(':memory:') as never, {
      parentRuntime: makeParent(), cwd: dir, agentId: 'h2', agentName: 'head-h2',
    });
    const capture = new HeadCapture();
    const tools = buildHeadToolSet({
      input: aHeadInput(), capture, rt,
      executeTool: { description: 'x', inputSchema: {}, execute: async () => ({ result: 'unused' }) },
      webSearch: stubWeb,
      split: async () => ({ narrative: '', decisions: [], unresolvedQuestions: [], childHeadIds: [], headCount: 0 }),
    }) as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>;

    const out = await tools.run!.execute({ command: `cat ${join(dir, 'note.txt')}`, runtime: 'laptop' }, {});
    expect(String(out)).toContain('real file content');
  });
});
