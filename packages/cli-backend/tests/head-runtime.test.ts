// createCLIHeadRuntime — local in-process branching heads (re-arch P6b). Drives a
// full HeadController split → run → merge cycle through the CLI runtime with a
// prompt-aware fake model, so the whole local-heads path (spawn ephemeral runtime
// → runHeadInference → mergeLLM JSON) is covered without a network LLM.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { HeadController, HeadJournal, initHeadsTables } from '@proteus/core';
import { createCLIHeadRuntime } from '../src/head-runtime.js';
import { makeSql, makeExecRaw } from '../src/runtime.js';

/** A v2 generateText model that answers differently for a head run vs the merge
 *  synthesis (the merge prompt says "merging the findings of N … heads"). */
function fakeHeadsModel(): LanguageModel {
  const usage = { inputTokens: 8, outputTokens: 12 };
  return {
    specificationVersion: 'v2', provider: 'fake', modelId: 'fake', supportedUrls: {},
    doGenerate: async (opts: { prompt?: unknown }) => {
      const isMerge = JSON.stringify(opts.prompt ?? '').includes('merging the findings');
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

function controllerWithCLIRuntime(model: LanguageModel) {
  const db = new Database(':memory:');
  initHeadsTables(makeExecRaw(db));
  const journal = new HeadJournal(makeSql(db));
  return new HeadController(createCLIHeadRuntime({ model }), journal);
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
