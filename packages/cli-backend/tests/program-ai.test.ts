// An agent's program asks a model through `ai.run`: the slate's call, answered by the tier's model and filed as the
// agent's own spend, named as the program's, on the account the provider says paid.
import { expect, test } from 'bun:test';
import { createAiCodemodeProvider, narrowToolSurface, WORKSPACE_ROOT, type AiDeps, type JsonValue, type ModelCallReport } from '@kinu.run/core';
import { programAiAnswer } from '@kinu.run/core/slates';
import { freshServedStores, scriptedTurnModel, toolExecute } from '@kinu.run/test-utils';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function programWith(ai: AiDeps): (args: { code: string }) => Promise<{ result: JsonValue | undefined; error?: string }> {
  const factory = createNodeCodemodeToolFactory({ reach: narrowToolSurface(undefined), namespaces: [createAiCodemodeProvider(ai)] });

  return toolExecute(factory({ cwd: WORKSPACE_ROOT, stores: freshServedStores(), native: {}, external: () => ({}), craftedTools: () => [] }));
}

test("a program's ai.run answers from the tier's model and bills the agent's own spend on the account that paid", async () => {
  const prompts: string[] = [];
  const reports: ModelCallReport[] = [];

  const model = scriptedTurnModel({
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    doGenerate: (options) => {
      prompts.push(JSON.stringify(options.prompt));

      return {
        content: [{ type: 'text', text: 'blue' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [],
        response: { headers: { 'x-kinu-account': 'anthropic@work' } },
      };
    },
  });

  const answering = (origin: 'system' | 'swarm'): AiDeps => ({
    run: async (input) => programAiAnswer(input, { spec: 'anthropic/claude-haiku-4-5', tier: input.tier ?? 'default' }, {
      resolveModel: () => model, report: (report) => { reports.push(report); }, operations: () => undefined, origin,
    }),
  });

  const agent = await programWith(answering('system'))({
    code: 'const answer = await ai.run("What colour is a clear sky?", { tier: "fast" }); return [answer.text, answer.tier];',
  });

  const head = await programWith(answering('swarm'))({ code: 'return (await ai.run("And the sea?")).text;' });

  expect({ agent: agent.result, head: head.result }).toEqual({ agent: ['blue', 'fast'], head: 'blue' });
  expect(prompts.some((prompt) => prompt.includes('What colour is a clear sky?'))).toBe(true);
  expect(reports.map(({ source, via, spec, account }) => ({ source, via, spec, account: account?.name }))).toEqual([
    { source: 'agent', via: 'ai.run', spec: 'anthropic/claude-haiku-4-5', account: 'work' },
    { source: 'head', via: 'ai.run', spec: 'anthropic/claude-haiku-4-5', account: 'work' },
  ]);
});
