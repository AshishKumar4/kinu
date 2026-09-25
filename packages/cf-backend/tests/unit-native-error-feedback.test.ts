import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import { chatSessionTurns, gatewayWorkspace, hostedSubordinateHarness, orchestratorHarness, runDelegatedTask } from './helpers/actor-harness';
import { requestOf, scriptedGateway } from './helpers/platform-gateway';

function modelCallingFile() {
  return scriptedTurnModel({ doGenerate: options => {
    const call = options.tools?.some(tool => tool.name === 'file')
      && !options.prompt.some(message => message.role === 'tool');

    return {
      content: call
        ? [{ type: 'tool-call', toolCallId: 'native-file-refusal', toolName: 'file', input: JSON.stringify({ action: 'transmogrify', path: '/' }) }]
        : [{ type: 'text', text: 'done' }],
      finishReason: { unified: call ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    };
  } });
}

function assertNativeFeedback(model: MockLanguageModelV3) {
  const next = model.doStreamCalls.find(call => call.prompt.some(message => message.role === 'tool'));
  const outputs = next?.prompt.flatMap(message => message.role === 'tool' ? message.content : []);

  const call = next?.prompt.flatMap(message => message.role === 'assistant' ? message.content : [])
    .find(part => part.type === 'tool-call' && part.toolName === 'file');

  if (call?.type !== 'tool-call') throw new Error('the next request lost its native tool call');
  const result = outputs?.find(part => part.type === 'tool-result' && part.toolCallId === call.toolCallId);

  if (result?.type !== 'tool-result' || result.output.type !== 'error-json') throw new Error('native error output was not structured');
  expect(JSON.stringify(result.output.value)).toStartWith('{"reason":');
  expect(outputs).toEqual(expect.arrayContaining([expect.objectContaining({
    type: 'tool-result', toolCallId: call.toolCallId, toolName: 'file',
    output: { type: 'error-json', value: { reason: 'bad_input', error: expect.stringContaining('transmogrify') } },
  })]));
}

test('Think orchestrator sends typed native error feedback in the NEXT provider request', async () => {
  const agent = orchestratorHarness().agent;
  const model = modelCallingFile();
  agent.modelFactory = () => model;
  await agent.onStart();
  await chatSessionTurns(agent).run('Try the file operation.');
  assertNativeFeedback(model);
});

/** A refusal as the provider request carries it: the typed error the tool returned, serialised whole. */
const RefusalSchema = v.object({ reason: v.string(), error: v.string() });

test('a delegated turn sends the same typed native error feedback in its NEXT provider request', async () => {
  // A hired child's delegated turn on the platform gateway; its `file` tool is built over the child's runtime by the
  // production builder, so the refusal is the loop's own, not a fixture's.
  const gateway = scriptedGateway([{ tool: 'file', args: { action: 'transmogrify', path: '/' } }]);
  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'error-prover', displayName: 'Error prover', nameOrigin: 'user',
    mission: 'Try the file operation.',
  });

  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Try the file operation.');
  const next = gateway.runs.map(requestOf).find((request) => request.messages.some((message) => message.role === 'tool'));
  const results = next?.messages.filter((message) => message.role === 'tool') ?? [];

  expect(results).toHaveLength(1);
  const refusal = v.parse(RefusalSchema, JSON.parse(v.parse(v.string(), results[0]?.content)));
  expect(refusal.reason).toBe('bad_input');
  expect(refusal.error).toContain('transmogrify');
});
