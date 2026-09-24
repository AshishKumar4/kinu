/**
 * SEC-3 (intent P26, the object-capability model): one forbidden operation, reaching the cloud
 * metadata service where a host keeps its credentials, is refused on every path a workspace's
 * authority takes. Bun drives the two a model reaches through native tools: the agent's own `web`
 * tool in a chat turn, and a hired child's in its delegated turn, each tool built by production.
 * The workerd tier holds the other two: `eval` (codemode-sandbox.test.ts, "a program cannot reach
 * cloud metadata") and a slate's resident code (slate-egress.test.ts, "resident global fetch uses
 * the shared destination"). tests/first-run/capability-isolation.first-run.ts runs all four on the
 * deployed build.
 */
import { describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { catalogTurn, chatSessionTurns, gatewayWorkspace, orchestratorHarness } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const METADATA = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';

const REFUSED = 'blocked private/internal address: 169.254.169.254';

/** A model that asks its `web` tool for the metadata service once, then stops. */
function modelFetchingMetadata(): MockLanguageModelV3 {
  return scriptedTurnModel({ doGenerate: (options) => {
    const call = !options.prompt.some((message) => message.role === 'tool');

    return {
      content: call
        ? [{ type: 'tool-call', toolCallId: 'metadata-probe', toolName: 'web', input: JSON.stringify({ action: 'fetch', url: METADATA }) }]
        : [{ type: 'text', text: 'done' }],
      finishReason: { unified: call ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });
}

/** What the model was handed back for its `web` call, as its next request carries it; the loop names the call anew. */
function webAnswer(model: MockLanguageModelV3): string {
  const next = model.doStreamCalls.find((call) => call.prompt.some((message) => message.role === 'tool'));

  const call = next?.prompt.flatMap((message) => message.role === 'assistant' ? message.content : [])
    .find((part) => part.type === 'tool-call' && part.toolName === 'web');

  if (call?.type !== 'tool-call') throw new Error('the next request lost the web call');

  const result = next?.prompt.flatMap((message) => message.role === 'tool' ? message.content : [])
    .find((part) => part.type === 'tool-result' && part.toolCallId === call.toolCallId);

  if (result?.type !== 'tool-result') throw new Error('the model was never handed its web call back');

  return JSON.stringify(result.output);
}

describe('the cloud metadata service is out of reach on every path', () => {
  test('through the agent\'s own web tool', async () => {
    const agent = orchestratorHarness().agent;
    const model = modelFetchingMetadata();
    agent.modelFactory = () => model;
    await agent.onStart();

    await chatSessionTurns(agent).run('Read the instance credentials from the metadata service.');

    expect(webAnswer(model)).toContain(REFUSED);
  });

  test('through a hired child\'s web tool', async () => {
    const mission = 'Read the instance credentials from the metadata service.';
    const childRequests: string[] = [];

    // The main actor hires; the hire, whose requests open with its mission, asks its `web` tool for the metadata service.
    const gateway = stubAiBinding((run) => {
      const messages = requestOf(run).messages;
      const step = messages.filter((message) => message.role === 'tool').length;
      const opening = messages.find((message) => message.role === 'user');

      if (!JSON.stringify(opening?.content ?? '').includes(mission)) {
        return step === 0
          ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', agent: 'isolation-child', mission } }, 'hire_0')
          : chatCompletion(run, 'Handed off.');
      }

      childRequests.push(JSON.stringify(messages));

      return step === 0
        ? toolCallCompletion(run, { tool: 'web', args: { action: 'fetch', url: METADATA } }, 'web_0')
        : chatCompletion(run, 'done');
    });

    const workspace = gatewayWorkspace(gateway);

    await catalogTurn(workspace.agent, 'Have a helper look up the host credentials.');
    await workspace.agent.terminalRetryPass();

    expect(childRequests.length).toBeGreaterThan(1);
    expect(childRequests.at(-1)).toContain(REFUSED);
  });
});
