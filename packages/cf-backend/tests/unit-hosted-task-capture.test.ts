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
 * TWO TESTS BECAUSE THE SYNTHESIS HAS TWO ARMS. Decisions and the tool tally
 * cannot both appear in one summary — the tally renders only when there is no
 * decision and no finding — so one turn cannot show both halves of the capture.
 * Each test drives one arm through the production runner.
 */
import { expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { createProviderRegistry, type JsonObject } from '@kinu.run/core';
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

test("a delegated turn's decision reaches the answer its caller gets", async () => {
  const turn = await delegated('decider', turnCalling('record_decision', {
    question: 'which parser', choice: 'the streaming one', rationale: 'it holds no whole file',
  }));

  // The decision the turn recorded, in the caller's own answer — which is the
  // report's summary verbatim, and the same text the relay carries to the
  // hiring parent: the tools and the runner wrote ONE capture, so the
  // synthesis had it to read.
  expect(turn.text).toBe('Decisions: which parser → the streaming one');
});

test("a delegated turn's tool call reaches the answer its caller gets", async () => {
  const turn = await delegated('reader', turnCalling('file', { action: 'list', path: '/home/user' }));

  // No decision and no finding, so the synthesis falls to the tally — which is
  // empty unless the CONFINED BUILTIN's own call landed in the run's capture,
  // and those tools are wrapped by the surface builder rather than the runner.
  expect(turn.text).toBe('Ran 1 tool call(s): file');
});
