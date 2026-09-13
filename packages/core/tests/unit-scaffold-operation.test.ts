import { expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { createScaffoldLLMStream, createScaffoldCandidateSurface, buildSystemPromptSync, currentDateForPrompt,
  BUILTIN_PROFILE_CATALOG, profileCatalogDigest, resolveTurnProfile,
  currentOperationProfile,
  type ModelCallReport, type ModelOperationEvent, type ProfileCatalog,
} from '../src/index';
import { createTestRuntime } from './helpers';

function fixture(failure?: Error) {
  const operations: ModelOperationEvent[] = [];
  const reports: ModelCallReport[] = [];

  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'answer' });
          controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'partial' });

          if (failure) {
            controller.enqueue({ type: 'error', error: failure });
            controller.close();

            return;
          }

          controller.enqueue({ type: 'text-end', id: 'answer' });
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            } });
          controller.close();
        },
      }),
    }),
  });

  const stream = createScaffoldLLMStream({ model, tools: () => ({}),
    spend: { source: 'scaffold', report: report => reports.push(report), operations: event => operations.push(event) },
  })({ system: 'Answer the question.', messages: [{ role: 'user', content: 'Question' }] });

  return { model, stream, operations, reports };
}

function candidateProfile(spec: string) {
  const catalog: ProfileCatalog = {
    roles: BUILTIN_PROFILE_CATALOG.roles,
    tiers: { default: { model: 'openai/chat-fast', reasoningEffort: 'low' },
      deep: { model: spec, reasoningEffort: 'high' } },
  };

  return resolveTurnProfile({
    envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
    provider: { revision: 'one', availableModels: ['openai/chat-fast', spec] },
    roleId: 'task', workMode: 'build', availableTools: ['tool_a', 'tool_b'], activeSkills: [],
  });
}

test('closing a scaffold model stream records exactly one failed terminal operation', async () => {
  const { stream, operations, reports } = fixture();

  for await (const event of stream) {
    expect(event.type).toBe('text-delta');
    break;
  }

  expect(operations.map(event => event.phase)).toEqual(['start', 'end']);
  expect(operations[1]?.outcome).toBe('failed');
  expect(operations[1]?.operationId).toBe(operations[0]?.operationId);
  expect(reports).toEqual([]);
});

test('draining a scaffold model stream records exactly one successful terminal operation and usage report', async () => {
  const { stream, operations, reports } = fixture();

  for await (const event of stream) expect(event.type).toBeDefined();

  expect(operations.map(event => event.phase)).toEqual(['start', 'end']);
  expect(operations[1]?.outcome).toBe('ok');
  expect(reports).toHaveLength(1);
  expect(reports[0]?.usage).toMatchObject({ input: 2, output: 1 });
});

test('closing at the scaffold done event retains successful accounting', async () => {
  const { stream, operations, reports } = fixture();

  for await (const event of stream) {
    if (event.type === 'done') break;
  }

  expect(operations.map(event => event.phase)).toEqual(['start', 'end']);
  expect(operations[1]?.outcome).toBe('ok');
  expect(reports).toHaveLength(1);
});

test('a failed scaffold model stream preserves its failure and records one terminal operation', async () => {
  const failure = new Error('candidate provider failed');
  const { stream, operations, reports } = fixture(failure);

  const drain = async () => {
    for await (const event of stream) expect(event.type).toBeDefined();
  };

  await expect(drain()).rejects.toThrow('candidate provider failed');
  expect(operations.map(event => event.phase)).toEqual(['start', 'end']);
  expect(operations[1]?.outcome).toBe('failed');
  expect(operations[1]?.error).toContain('candidate provider failed');
  expect(reports).toEqual([]);
});

for (const provider of ['openai', 'anthropic']) {
  test(`a ${provider} scaffold candidate uses deep routing, native effort, one frame and metered default inference`, async () => {
    const spec = `${provider}/candidate-deep`;

    const profile = candidateProfile(spec);

    const { rt } = createTestRuntime();
    const { model, operations, reports } = fixture();
    const bound: string[] = [];
    let resolutions = 0;

    const surface = createScaffoldCandidateSurface({
      rt, tools: () => ({}), history: undefined,
      modelContext: async modelSpec => ({ id: modelSpec, contextWindow: 100_000, modelOutputLimit: 10_000 }),
      profile: async () => {
        resolutions += 1;

        return profile;
      },
      bindModel: modelSpec => {
        bound.push(modelSpec);

        return model;
      },
      spend: { source: 'scaffold', report: report => reports.push(report), operations: event => operations.push(event) },
    }, 'candidate task');

    const inference = surface.defaultInference;

    if (!inference) throw new Error('candidate default inference is required');

    for await (const chunk of inference()) expect(chunk).toHaveProperty('event');

    expect(resolutions).toBe(1);
    expect(bound).toEqual([spec]);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.providerOptions?.[provider]).toMatchObject(
      provider === 'openai' ? { reasoningEffort: 'high' } : { effort: 'high' },
    );
    expect(model.doStreamCalls[0]?.providerOptions?.['workers-ai']).toBeUndefined();
    expect(model.doStreamCalls[0]?.prompt[0]).toEqual({ role: 'system', content: buildSystemPromptSync(rt, {
      model: { id: spec }, currentDate: currentDateForPrompt(),
    }) });
    expect(model.doStreamCalls[0]?.prompt.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'candidate task' }] });
    expect(operations.map(event => event.phase)).toEqual(['start', 'end']);
    expect(operations.every(event => event.spec === spec)).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ spec, source: 'scaffold', usage: { input: 2, output: 1 } });
  });
}

test('a long-lived candidate surface snapshots tools and profile per issued request across A/B interleaving', async () => {
  const { rt } = createTestRuntime();
  const { model } = fixture();
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const bound: string[] = [];
  const scopes: Array<string | undefined> = [];
  let profile = candidateProfile('openai/deep-a');

  const native = tool({
    inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
    execute: async () => 'observed',
  });

  const tools: ToolSet = { tool_a: native };

  const surface = createScaffoldCandidateSurface({
    rt, profile: async () => profile,
    tools: () => {
      scopes.push(currentOperationProfile(rt.actor)?.profile.tiers.deep.model);

      return tools;
    },
    bindModel: spec => {
      bound.push(spec);

      return model;
    },
    modelContext: async spec => {
      if (spec === 'openai/deep-a') {
        started.resolve();
        await held.promise;
      }

      return { id: spec, contextWindow: 100_000, modelOutputLimit: 10_000 };
    },
    history: undefined, spend: { source: 'scaffold', report: () => {} },
  }, 'answer');

  const drain = async () => {
    for await (const event of surface.llmStream({ system: 'Answer.', messages: [{ role: 'user', content: 'task' }] })) {
      expect(event.type).toBeDefined();
    }
  };

  const first = drain();
  await started.promise;
  profile = candidateProfile('openai/deep-b');
  delete tools.tool_a;
  tools.tool_b = native;
  await drain();
  held.resolve();
  await first;

  expect(bound).toEqual(['openai/deep-b', 'openai/deep-a']);
  expect(scopes).toEqual(['openai/deep-a', 'openai/deep-b']);
  expect(model.doStreamCalls.map(call => call.tools?.map(entry => entry.name))).toEqual([['tool_b'], ['tool_a']]);
});
