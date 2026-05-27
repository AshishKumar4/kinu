import { describe, test, expect } from 'bun:test';
import { createRLMProvider } from '../src/rlm.ts';
import type { AgentProviderRegistry } from '../src/providers/agent-registry.ts';
import type { LanguageModel } from 'ai';

// We don't go through the AI SDK here — we exercise the codemode-tool
// surface that the LLM's sandbox code calls. The execute() fn is the
// thing that matters: it must (a) reject empty inputs, (b) call the
// registry's resolveModel with the right spec, (c) call generateText
// with the right options, (d) surface errors as `{error}` not thrown.

function stubRegistry(opts: {
  resolveModel?: (spec: string) => LanguageModel;
  normalizeSpecSync?: (spec: string | null) => string;
} = {}): AgentProviderRegistry {
  return {
    resolveModel: opts.resolveModel ?? (() => ({
      specificationVersion: 'v2', provider: 'stub',
    } as unknown as LanguageModel)),
    normalizeSpecSync: opts.normalizeSpecSync ?? ((spec) => spec ?? 'workers-ai/x'),
    resolveSpec: async (spec) => spec ?? 'workers-ai/x',
    registry: {} as never,
    deps: {} as never,
  };
}

describe('llm provider (Recursive Language Models)', () => {
  test('exposes a single `query` tool', () => {
    const p = createRLMProvider(stubRegistry(), () => 'workers-ai/x');
    expect(p.name).toBe('llm');
    expect(Object.keys(p.tools)).toEqual(['query']);
  });

  test('query rejects empty/non-string input', async () => {
    const p = createRLMProvider(stubRegistry(), () => 'workers-ai/x');
    const r1 = await p.tools.query.execute('', {}) as { error: string };
    expect(r1.error).toMatch(/non-empty string/);

    const r2 = await p.tools.query.execute(null as never, {}) as { error: string };
    expect(r2.error).toMatch(/non-empty string/);
  });

  test('query passes opts.model override through normalizeSpecSync', async () => {
    let resolvedSpec: string | undefined;
    const p = createRLMProvider(
      stubRegistry({
        resolveModel: () => ({ specificationVersion: 'v2' } as unknown as LanguageModel),
        normalizeSpecSync: (s) => { resolvedSpec = s as string; return s ?? 'd'; },
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
      stubRegistry({}),
      () => { currentSpecCalled = true; return 'workers-ai/x'; },
    );
    await p.tools.query.execute('hi', {});
    expect(currentSpecCalled).toBe(true);
  });

  test('query surfaces model-resolution errors as {error}, not throws', async () => {
    const p = createRLMProvider(
      stubRegistry({
        resolveModel: () => { throw new Error('boom'); },
      }),
      () => 'workers-ai/x',
    );
    const r = await p.tools.query.execute('hi', {}) as { error: string };
    expect(r.error).toMatch(/unresolvable/);
    expect(r.error).toMatch(/boom/);
  });
});
