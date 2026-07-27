// createCLIHeadRuntime — local in-process branching heads (re-arch P6b). Drives a
// full HeadController split → run → merge cycle through the CLI runtime with a
// prompt-aware fake model, so the whole local-heads path (spawn ephemeral runtime
// → runHeadInference → mergeLLM JSON) is covered without a network LLM.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { HeadController, HeadJournal, initHeadsTables, type HeadInput } from '@proteus/core';
import { createCLIHeadRuntime } from '../src/head-runtime.js';
import { makeSql, makeExecRaw, createCLIRuntime } from '../src/runtime.js';

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
  inheritedContext: [], budget: { maxDepth: 2, maxTokens: 12_000, maxWallClockMs: 60_000, spawnedAt: Date.now() },
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
  return new HeadController(createCLIHeadRuntime({ model, providerFamily }), journal);
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
      parentBudget: { maxDepth: 2, maxTokens: 12_000, maxWallClockMs: 60_000, spawnedAt: Date.now() },
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
      parentBudget: { maxDepth: 2, maxTokens: 12_000, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    expect(mergeOptions?.maxOutputTokens).toBeUndefined();
    expect(mergeOptions?.providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });
  });

  test('a head is offered the FULL surface: record + sandbox + shared + split', async () => {
    let captured: string[] = [];
    const db = new Database(':memory:');
    const sharedVfs = createCLIRuntime(db as never, { dbPath: '/tmp/h.db', llm: { name: 'x', baseURL: 'http://l', headers: {}, model: 'm' } }).storage.vfs;
    const runtime = createCLIHeadRuntime({ model: capturingHeadModel('done', (t) => { captured = t; }), sharedVfs });
    await (await runtime.spawnHead(aHeadInput())).run();
    expect(new Set(captured)).toEqual(new Set([
      'record_evidence', 'record_decision',
      'sandbox_exec', 'sandbox_read', 'sandbox_write', 'sandbox_list',
      'shared_write', 'shared_read', 'shared_list',
      'split_subheads',
    ]));
  });

  test('without a shared VFS, shared_* are omitted (sandbox + split remain)', async () => {
    let captured: string[] = [];
    const runtime = createCLIHeadRuntime({ model: capturingHeadModel('done', (t) => { captured = t; }) });
    await (await runtime.spawnHead(aHeadInput())).run();
    expect(captured).not.toContain('shared_write');
    expect(captured).toContain('sandbox_exec');
    expect(captured).toContain('split_subheads');
  });

  test('phase events fire on split and merge', async () => {
    const controller = controllerWithCLIRuntime(fakeHeadsModel());
    const phases: string[] = [];
    await controller.run({
      parentHeadId: null,
      inheritedContext: [],
      request: { rationale: 'r', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 2, maxTokens: 12_000, maxWallClockMs: 60_000, spawnedAt: Date.now() },
      onPhase: (e) => phases.push(e.kind),
    });
    expect(phases).toEqual(['split', 'merge']);
  });
});
