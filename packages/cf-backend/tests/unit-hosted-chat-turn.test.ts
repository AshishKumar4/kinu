/**
 * A hosted agent's chat turn ends with its answer, before the title model and the relay to its parent run. Both ran
 * inside the turn, so a new agent's first chat held Stop and Thinking for seconds past its answer, and a failed turn
 * ended without the chat being told why. The agent is added as the owner adds one, its task admitted and drained as
 * production drains it, its model the platform gateway's, and its chat read from the frames the workspace's sockets
 * are sent. A tab shows one error: the sender's chat keeps the first its stream carries, and a watching tab takes the
 * turn's terminal error frame (`terminalChatError`).
 */
import { expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { terminalChatError } from '@kinu.run/core';
import * as v from 'valibot';
import { gatewayWorkspace, runDelegatedTask, wakeForDelegatedTask } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

const ChatResponseSchema = v.looseObject({
  type: v.literal('cf_agent_use_chat_response'), body: v.string(), done: v.boolean(), error: v.optional(v.boolean()),
});

const ChunkSchema = v.pipe(v.string(), v.parseJson(), v.variant('type', [
  v.looseObject({ type: v.literal('text-delta'), delta: v.string() }),
  v.looseObject({ type: v.literal('error'), errorText: v.string() }),
]));

/** A chat frame as the record reads it: a streamed word or error, the turn's end, or its failure. */
function entryOf(frame: v.InferOutput<typeof ChatResponseSchema>): string | null {
  if (frame.error === true) return `${frame.done ? 'turn failed' : 'error'}: ${frame.body}`;

  if (frame.done) return 'turn ended';
  const chunk = v.safeParse(ChunkSchema, frame.body);

  if (!chunk.success) return null;

  return chunk.output.type === 'error' ? `stream error: ${chunk.output.errorText}` : `answer: ${chunk.output.delta}`;
}

/** A new agent's first task: one ordered record of its chat and its title model's call, and the error a tab shows. */
async function firstTask(answer: (run: RecordedGatewayRun) => Response): Promise<{ seen: string[]; shown: string[] }> {
  const seen: string[] = [];
  const shown: string[] = [];
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

  Object.defineProperty(workspace.agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => {
      const frame = v.safeParse(ChatResponseSchema, JSON.parse(payload));

      if (!frame.success) return;
      const card = terminalChatError(frame.output, new Set());
      const entry = entryOf(frame.output);

      if (card !== null) shown.push(card.body);

      if (entry !== null) seen.push(entry);
    },
  });

  await runDelegatedTask(workspace, subordinate.actorId, 'Say hello.');

  return { seen, shown };
}

test("a hosted agent's turn ends with its answer, before its title model runs", async () => {
  expect(await firstTask((run) => chatCompletion(run, 'Hello.'))).toEqual({
    seen: ['answer: Hello.', 'turn ended', 'title model'], shown: [],
  });
});

test("a hosted agent's failed turn ends on one error, its reason, before its title model runs", async () => {
  const { seen, shown } = await firstTask(() => new Response('', { status: 400 }));

  expect(seen).toEqual([expect.stringMatching(/^turn failed: .*the provider refused the request/u), 'title model']);
  expect(shown).toEqual([expect.stringContaining('the provider refused the request')]);
});

test('a task admitted while the drain runs another is run by that drain', async () => {
  const parked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const answered: string[] = [];

  const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
    const opening = JSON.stringify(run);

    if (opening.includes('First task.') && !opening.includes('Second task.')) {
      parked.resolve();
      await release.promise;
    }

    answered.push(opening.includes('Second task.') ? 'second' : 'first');

    return chatCompletion(run, 'Done.');
  }));

  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();

  if (subordinate.actorId === null) throw new Error('the added agent has no actor');

  await wakeForDelegatedTask(workspace, subordinate.actorId, 'First task.');
  await parked.promise;
  // The wake for the second task finds the drain running the first.
  await wakeForDelegatedTask(workspace, subordinate.actorId, 'Second task.');
  release.resolve();
  await joinHarnessFibers();

  expect(answered).toContain('second');
});
