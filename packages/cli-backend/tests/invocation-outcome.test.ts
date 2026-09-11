import { expect, test } from 'bun:test';
import { stepCountIs } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import {
  ExtensionHost, runChat, TurnAccumulator, executionVerdict,
  type CodemodeProvider, type ChatEvent,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { createNodeExecuteToolFactory } from '../src/execute-tools-factory';

async function invoke(code: string, providers: CodemodeProvider[] = []) {
  let step = 0;

  const model = scriptedTurnModel({
    doGenerate: () => ({
      content: ++step === 1
        ? [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'execute_tools', input: JSON.stringify({ code }) }]
        : [{ type: 'text', text: 'done' }],
      finishReason: { unified: step === 1 ? 'tool-calls' : 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });

  const tool = createNodeExecuteToolFactory({ extraProviders: providers })({
    native: {}, craftedTools: () => ({}), providers: [],
  });

  const accumulator = new TurnAccumulator();
  const events: ChatEvent[] = [];

  const extensions = new ExtensionHost().register({
    name: 'record-invocation',
    onToolResult: (event) => {
      accumulator.recordToolCall(event.success
        ? { toolName: event.toolName, input: event.args, output: event.result, success: true }
        : { toolName: event.toolName, input: event.args, error: event.result,
            success: false, reason: event.reason, execution: event.execution });
    },
  });

  for await (const event of runChat({
    model, system: 'Run the requested program.', history: [{ role: 'user', content: 'go' }],
    tools: { execute_tools: tool }, extensions, stopWhen: stepCountIs(2),
  })) events.push(event);
  const result = events.find((event) => event.type === 'tool-result');

  if (result?.type !== 'tool-result') throw new Error('the invocation produced no result');

  return { result, accumulator };
}

test('arbitrary error-shaped program values remain successful data through SDK and evolution', async () => {
  const { result, accumulator } = await invoke('return { reason: "denied", error: "historical incident", exitCode: 7 };');
  expect(result).toMatchObject({ success: true });
  expect(JSON.parse(result.result)).toEqual({ result: { reason: 'denied', error: 'historical incident', exitCode: 7 } });
  expect(executionVerdict(accumulator)).toBe('succeeded');
});

test('a handled nested command refusal does not fail its enclosing program', async () => {
  let calls = 0;

  const { result, accumulator } = await invoke('const answer = await workspace.exec("blocked"); return { handled: answer.reason };', [{
    name: 'workspace', types: '', tools: {
      exec: { description: 'Refuse the command', execute: async () => {
        calls++;

        return { reason: 'denied', error: 'not run' };
      } },
    },
  }]);

  expect(result).toMatchObject({ success: true });
  expect(JSON.parse(result.result)).toEqual({ result: { handled: 'denied' } });
  expect(calls).toBe(1);
  expect(executionVerdict(accumulator)).toBe('succeeded');
});

test('unhandled program failures retain producer class, cause text, logs and one execution', async () => {
  let calls = 0;

  const { result, accumulator } = await invoke('console.log("before failure"); await probe.fail();', [{
    name: 'probe', types: '', tools: {
      fail: { description: 'Raise a classified command failure', execute: async () => {
        calls++;
        throw new KinuError('io', 'command failed', { cause: new Error('underlying cause'), execution: { exitCode: 7 } });
      } },
    },
  }]);

  expect(result).toMatchObject({ success: false, reason: 'io', execution: { exitCode: 7 } });
  expect(result.result).toContain('underlying cause');
  expect(result.result).toContain('before failure');
  expect(calls).toBe(1);
  expect(executionVerdict(accumulator)).toBe('failed');
});
