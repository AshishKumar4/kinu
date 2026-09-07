import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { MockLanguageModelV3 } from 'ai/test';
import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';
import { driveNode } from './helpers/three-kinds';

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

test.each(['orchestrator', 'subordinate'])('Think %s sends typed native error feedback in the NEXT provider request', async kind => {
  const agent = kind === 'orchestrator' ? orchestratorHarness().agent : subordinateHarness().agent;
  const model = modelCallingFile();
  agent.modelFactory = () => model;
  await agent.onStart();
  await agent.runTurn({ input: 'Try the file operation.' });
  assertNativeFeedback(model);
});

test('the shared head loop sends the same typed native error feedback in its NEXT provider request', async () => {
  const model = modelCallingFile();
  await driveNode({ steps: [] }, { model });
  assertNativeFeedback(model);
});
