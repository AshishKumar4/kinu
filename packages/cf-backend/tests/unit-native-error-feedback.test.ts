import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { MockLanguageModelV3 } from 'ai/test';
import { createProviderRegistry } from '@kinu.run/core';
import { hostedSubordinateHarness, thinkTurns, orchestratorHarness } from './helpers/actor-harness';

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
  await thinkTurns(agent).run('Try the file operation.');
  assertNativeFeedback(model);
});

test('parallel hosted native calls retain their SDK identities after reverse completion', async () => {
  const agent = orchestratorHarness().agent;
  await agent.onStart();
  const files = agent.observeRuntime().storage.vfs;
  await files.writeFile('identical.txt', 'same result');
  const first = Promise.withResolvers<void>();
  const readFile = files.readFile.bind(files);
  let reads = 0;
  files.readFile = async (...args) => {
    if (args[0] === 'identical.txt' && reads++ === 0) await first.promise;

    return await readFile(...args);
  };

  // The order the tools SETTLED in, read where the loop's runner reports each
  // result: the actor's extension host.
  const order: string[] = [];
  agent.harnessRegisterExtension({
    name: 'probe.tool-order',
    onToolResult: (context) => {
      order.push(context.toolCallId ?? '');

      if (context.toolCallId === 'call-B') first.resolve();
    },
  });

  let step = 0;

  const model = scriptedTurnModel({ doGenerate: () => {
    const calls = step++ === 0;

    return {
      content: calls ? ['call-A', 'call-B'].map((toolCallId) => ({
        type: 'tool-call' as const, toolCallId, toolName: 'file', input: JSON.stringify({ action: 'read', path: 'identical.txt' }),
      })) : [{ type: 'text', text: 'done' }],
      finishReason: { unified: calls ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    };
  } });

  agent.modelFactory = () => model;

  try {
    await thinkTurns(agent).run('Read the file twice in parallel.');
    const run = (await agent.listRuns()).items[0];

    if (run === undefined) throw new Error('the chat did not retain a run');
    const recorded = (await agent.getRunEvents(run.runId)).filter((event) => event.type === 'tool_call_end');

    expect(order).toEqual(['call-B', 'call-A']);
    expect(recorded.map((event) => event.toolCallId)).toEqual(['call-B', 'call-A']);
    const request = model.doStreamCalls.at(-1);
    const returned = request?.prompt.flatMap((message) => message.role === 'tool' ? message.content : []);

    const requested = request?.prompt.flatMap((message) => message.role === 'assistant' ? message.content : [])
      .flatMap((part) => part.type === 'tool-call' ? [part.toolCallId] : []);

    expect(returned).toHaveLength(2);
    expect(returned?.flatMap((part) => part.type === 'tool-result' ? [part.toolCallId] : []).sort()).toEqual(requested?.sort());
  } finally {
    first.resolve();
    files.readFile = readFile;
  }
});

test('a delegated turn sends the same typed native error feedback in its NEXT provider request', async () => {
  // A hired child running the production delegated runner — admission,
  // confined tools, report relay — with an injected model. A builtin loop
  // needs no parent versions, so this reaches the shared inference loop
  // without the seeding the node path requires. The `file` tool it calls is
  // the child's own, built over the child's runtime by the production
  // builder, which is what makes the refusal the loop's own rather than a
  // fixture's.
  const workspace = orchestratorHarness();

  const child = await hostedSubordinateHarness(workspace, {
    name: 'error-prover', displayName: 'Error prover', nameOrigin: 'user',
    mission: 'Try the file operation.',
  });

  const model = modelCallingFile();
  workspace.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: () => model,
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  });
  await workspace.agent.runHostedTaskTurn(child.actor, 'Try the file operation.');
  assertNativeFeedback(model);
});
