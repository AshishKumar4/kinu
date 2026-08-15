import { describe, test, expect } from 'bun:test';
import { createRLMProvider, type RLMModelResolver } from '../src/rlm.ts';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';

const ErrorResultSchema = v.object({ error: v.string() });

// We don't go through the AI SDK here — we exercise the codemode-tool
// surface that the LLM's sandbox code calls. The execute() fn is the
// thing that matters: it must (a) reject empty inputs, (b) call the
// registry's resolveModel with the right spec, (c) call generateText
// with the right options, (d) surface errors as `{error}` not thrown.

function stubResolver(opts: {
  resolveModel?: (spec: string) => LanguageModel;
  normalizeSpecSync?: (spec: string | null) => string;
} = {}): RLMModelResolver {
  return {
    resolveModel: opts.resolveModel ?? (() => new MockLanguageModelV3()),
    normalizeSpecSync: opts.normalizeSpecSync ?? ((spec) => spec ?? 'workers-ai/x'),
  };
}

describe('llm provider (Recursive Language Models)', () => {
  test('exposes a single `query` tool', () => {
    const p = createRLMProvider(stubResolver(), () => 'workers-ai/x');
    expect(p.name).toBe('llm');
    expect(Object.keys(p.tools)).toEqual(['query']);
  });

  test('query rejects empty/non-string input', async () => {
    const p = createRLMProvider(stubResolver(), () => 'workers-ai/x');
    const r1 = v.parse(ErrorResultSchema, await p.tools.query.execute('', {}));
    expect(r1.error).toMatch(/non-empty string/);

    const r2 = v.parse(ErrorResultSchema, await p.tools.query.execute(null, {}));
    expect(r2.error).toMatch(/non-empty string/);
  });

  test('query rejects an invalid reasoning effort at the tool boundary', async () => {
    const p = createRLMProvider(stubResolver(), () => 'workers-ai/x');
    const result = v.parse(
      ErrorResultSchema,
      await p.tools.query.execute('hi', { reasoning_effort: 'extreme' }),
    );
    expect(result.error).toContain('must be low, medium, or high');
  });

  test('query passes opts.model override through normalizeSpecSync', async () => {
    let resolvedSpec: string | undefined;
    const p = createRLMProvider(
      stubResolver({
        resolveModel: () => new MockLanguageModelV3(),
        normalizeSpecSync: (spec) => {
          if (spec !== null) resolvedSpec = spec;
          return spec ?? 'd';
        },
      }),
      () => 'should-not-be-used',
    );
    // generateText will fail because our stub model isn't a real LanguageModel
    // — that's expected. We only assert the spec routing.
    await p.tools.query.execute('hi', { model: 'codex/gpt-5.5' });
    expect(resolvedSpec).toBe('codex/gpt-5.5');
  });

  test('query falls back to currentSpec() when no model opt', async () => {
    let currentSpecCalled = false;
    const p = createRLMProvider(
      stubResolver({}),
      () => { currentSpecCalled = true; return 'workers-ai/x'; },
    );
    await p.tools.query.execute('hi', {});
    expect(currentSpecCalled).toBe(true);
  });

  test('query defaults to low provider effort with no output cap and honors an explicit cap', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const p = createRLMProvider(
      stubResolver({ resolveModel: () => model }),
      () => 'openai/gpt-5.5',
    );

    await p.tools.query.execute('uncapped');
    await p.tools.query.execute('capped', { maxOutputTokens: 77, reasoning_effort: 'high' });

    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBeUndefined();
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });
    expect(model.doGenerateCalls[1]?.maxOutputTokens).toBe(77);
    expect(model.doGenerateCalls[1]?.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });

  test('query surfaces model-resolution errors as {error}, not throws', async () => {
    const p = createRLMProvider(
      stubResolver({
        resolveModel: () => { throw new Error('boom'); },
      }),
      () => 'workers-ai/x',
    );
    const r = v.parse(ErrorResultSchema, await p.tools.query.execute('hi', {}));
    expect(r.error).toMatch(/unresolvable/);
    expect(r.error).toMatch(/boom/);
  });
});
