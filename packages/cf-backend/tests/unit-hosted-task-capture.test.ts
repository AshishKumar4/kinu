/**
 * Defends: a delegated turn's report coming back empty because the runner and
 * the tool surface recorded into two different `HeadCapture`s.
 */
import { expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { ADVISOR_HEADER, createProviderRegistry, type JsonObject } from '@kinu.run/core';
import { scriptedTurnModel, type ScriptedTurnResult, type ScriptedTurnOptions } from '@kinu.run/test-utils';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoningId: undefined, reasoning: undefined },
};

/** Read off the conversation, not a closure, so a retried request answers the same way. */
const step = (options: ScriptedTurnOptions): number =>
  options.prompt.filter((message) => message.role === 'tool').length;

/** One call, then whitespace with no prose: the loop reads a step's text as final
 *  only when non-blank, so the answer is synthesised from the capture. */
function turnCalling(name: string, args: JsonObject): MockLanguageModelV3 {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-task',
    doGenerate: async (options): Promise<ScriptedTurnResult> => {
      if (step(options) > 0) {
        return {
          content: [{ type: 'text' as const, text: '  ' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: USAGE, warnings: [],
        };
      }

      return {
        content: [{
          type: 'tool-call' as const,
          toolCallId: `call-${name}`,
          toolName: name,
          input: JSON.stringify(args),
        }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: USAGE, warnings: [],
      };
    },
  });
}

async function delegated(name: string, model: MockLanguageModelV3) {
  const workspace = orchestratorHarness();

  const child = await hostedSubordinateHarness(workspace, {
    name, displayName: name, nameOrigin: 'user', mission: 'record what you find.',
  });

  workspace.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: () => model,
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  });

  return await workspace.agent.runHostedTaskTurn(child.actor, 'Record what you find.');
}

test("a delegated turn's tool call reaches the answer its caller gets", async () => {
  const turn = await delegated('reader', turnCalling('file', { action: 'list', path: '/home/user' }));

  // No decision or finding, so the synthesis falls to the tool tally from the shared capture.
  expect(turn.text).toBe('Ran 1 tool call(s): file');
});

test('a hosted subordinate is advised without adding a turn to either evolution window', async () => {
  const workspace = orchestratorHarness();
  const rt = workspace.agent.observeRuntime();
  rt.actor.config.setAdvisorEnabled(true);
  const note = 'The probe failed but the reply claimed success. Read the exit status.';
  const requests: string[] = [];
  const reviews: string[] = [];

  const model = scriptedTurnModel({
    provider: 'fake', modelId: 'fake-task',
    doGenerate: async (options): Promise<ScriptedTurnResult> => {
      const prompt = JSON.stringify(options.prompt);
      const reviewing = prompt.includes('You are reviewing one finished turn');

      if (reviewing) reviews.push(prompt);
      else requests.push(prompt);

      return {
        content: [{ type: 'text', text: reviewing
          ? JSON.stringify({ note, severity: 'concern', class: 'wrong-work' }) : 'The probe succeeded.' }],
        finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [],
      };
    },
  });

  workspace.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: () => model,
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  });

  const child = await hostedSubordinateHarness(workspace, {
    name: 'advised', displayName: 'Advised', nameOrigin: 'user', mission: 'Check the probe.',
  });

  Object.defineProperty(child.actor.runtime, 'advisorLlm', { value: {
    async *stream() { yield ''; },
    complete: async (prompt: string) => {
      reviews.push(prompt);

      return JSON.stringify({ note, severity: 'concern', class: 'wrong-work' });
    },
  } });
  const before = rt.storage.sql<{ actor_id: string; turn: string }>`SELECT actor_id, turn FROM completed_turns`;
  const result = await workspace.agent.runHostedTaskTurn(child.actor, 'Check the probe.');
  expect(result.text).toBe('The probe succeeded.');
  expect(reviews).toHaveLength(2);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain(ADVISOR_HEADER);
  expect(rt.storage.sql<{ message: string }>`SELECT message FROM evolution_events
    WHERE actor_id = ${child.actor.handle.actorId} AND type = 'advisor_note'`).toEqual([{ message: note }]);
  expect(rt.storage.sql`SELECT actor_id, turn FROM completed_turns`).toEqual(before);
  expect(rt.storage.sql`SELECT message FROM evolution_events
    WHERE actor_id = ${rt.actor.actorId} AND type = 'advisor_note'`).toEqual([]);
});
