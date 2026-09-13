/**
 * A DELEGATED TURN'S REPORT CARRIES WHAT THAT TURN DID.
 *
 * `runHostedTask` builds one `HeadInput` and hands it to both the runner and
 * the tool surface, for the stated reason that two shapes for one turn can
 * disagree. The findings accumulator was the same kind of value and was NOT
 * shared: the runner passed `runHeadInference` a fresh `HeadCapture` while
 * `hostedTaskTools` built the surface over a second one of its own, so a
 * delegated turn's decisions, evidence, artifacts and tool calls were recorded
 * into an object nothing reads and the report came back empty of all four.
 *
 * WHAT MAKES IT OBSERVABLE, and it is the caller's own answer rather than an
 * internal read: a turn that ends without closing prose has its summary
 * SYNTHESISED from the capture (`synthesizeHeadSummary` — decisions and
 * findings first, and the tool-call tally when there were neither), and that
 * summary is what `runHostedTask` returns and what the relay sends the hiring
 * parent. With two captures the synthesis had nothing to read and every such
 * turn answered "completed without producing a textual summary" however much
 * work it had done.
 *
 * ONE ARM, because the synthesis renders the tool tally only when the turn
 * banked no decision and no finding — and a delegated turn banks neither: the
 * head accumulators are not on its surface (it reports upward through
 * `report` instead), so the tally is the arm its capture can reach.
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

/** The step this request is: how many tool results the prompt already carries.
 *  Read off the conversation rather than counted in a closure, so a retried
 *  request answers the same way the first one did. */
const step = (options: ScriptedTurnOptions): number =>
  options.prompt.filter((message) => message.role === 'tool').length;

/** A turn that makes ONE call and then stops with no closing prose — the shape
 *  whose answer is synthesised from the capture. Whitespace rather than an
 *  empty content list: the loop reads a step's text as final only when it is
 *  non-blank, and a real model that trails off emits exactly this. */
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

/** A hired child with a model of its own, run through the production delegated
 *  runner — admission, confined tools, report relay. */
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

  // The turn banked no decision and no finding, so the synthesis falls to the
  // tally — which is empty unless the BUILTIN's own call landed in the run's
  // own capture, and the builtins are wrapped by the surface builder rather
  // than by the runner that reads the report.
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
