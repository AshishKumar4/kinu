/**
 * A hosted agent's chat turn ends with its answer, before the title model and the relay to its parent run. Both ran
 * inside the turn, so a new agent's first chat held Stop and Thinking for seconds past its answer, and a failed turn
 * ended without the chat being told why. The agent is added as the owner adds one, its task admitted and drained as
 * production drains it, its model the platform gateway's, and its chat read from the frames the workspace's sockets
 * are sent.
 */
import { expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import { gatewayWorkspace, runDelegatedTask, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

const ChatResponseSchema = v.looseObject({
  type: v.literal('cf_agent_use_chat_response'), body: v.string(), done: v.boolean(), error: v.optional(v.boolean()),
});

const TextDeltaSchema = v.pipe(
  v.string(), v.parseJson(), v.looseObject({ type: v.literal('text-delta'), delta: v.string() }),
);

/** A new agent's first task, as one ordered record of its chat and its title model's call. */
async function firstTask(answer: (run: RecordedGatewayRun) => Response): Promise<string[]> {
  const seen: string[] = [];
  const workspace = gatewayWorkspace(stubAiBinding(answer));

  workspace.agent.sideModelFactory = () => new MockLanguageModelV3({
    doGenerate: async () => {
      seen.push('title model');

      return {
        content: [{ type: 'text', text: '{"title":"Greeter"}' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 0, text: 0, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  await workspace.agent.setSoul('# Purpose\n\nGreet whoever asks.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();

  if (subordinate.actorId === null) throw new Error('the added agent has no actor');
  const main = workspaceMainActor(workspace.db);

  const agent = await workspace.agent.observeActorHost().acquire({
    actorId: subordinate.actorId, workspaceId: main.workspaceId, parentActorId: main.actorId,
  });

  Object.defineProperty(workspace.agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => {
      const frame = v.safeParse(ChatResponseSchema, JSON.parse(payload));

      if (!frame.success) return;

      if (frame.output.error === true) seen.push(`error: ${frame.output.body}`);
      else if (frame.output.done) seen.push('turn ended');
      else {
        const text = v.safeParse(TextDeltaSchema, frame.output.body);

        if (text.success) seen.push(`answer: ${text.output.delta}`);
      }
    },
  });

  await runDelegatedTask(workspace, agent, 'Say hello.');

  return seen;
}

test("a hosted agent's turn ends with its answer, before its title model runs", async () => {
  expect(await firstTask((run) => chatCompletion(run, 'Hello.'))).toEqual([
    'answer: Hello.', 'turn ended', 'title model',
  ]);
});

test("a hosted agent's failed turn says why and ends, before its title model runs", async () => {
  expect(await firstTask(() => new Response('', { status: 400 }))).toEqual([
    expect.stringMatching(/^error: .*the provider refused the request/u), 'turn ended', 'title model',
  ]);
});
