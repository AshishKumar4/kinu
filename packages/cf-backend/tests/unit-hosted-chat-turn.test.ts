/**
 * A hosted agent's chat turn ends with its answer while its title model still runs: the title once ran inside the
 * turn, so a new agent's first chat held Stop and Thinking for seconds past its answer, and a failed turn ended
 * without the chat being told why. A failed turn names nothing, as a CLI hire's does. The agent is added as the owner
 * adds one, its task admitted and drained as production drains it, its model the platform gateway's, and its chat read
 * from the frames the workspace's sockets are sent. A tab shows one error: the sender's chat keeps the first its stream
 * carries, and a watching tab takes the turn's terminal error frame (`terminalChatError`).
 */
import { expect, test } from 'bun:test';
import { terminalChatError, WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import * as v from 'valibot';
import { gatewayWorkspace, runDelegatedTask, wakeForDelegatedTask } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, requestOf, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

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
  const ended = Promise.withResolvers<void>();

  // The title is the agent's own model call, and answers only once the turn has ended: a turn that waited on it would
  // never end.
  const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
    if (!JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) return answer(run);
    await ended.promise;
    seen.push('title model');

    return chatCompletion(run, '{"title":"Greeter"}');
  }));

  await workspace.agent.setSoul('# Purpose\n\nGreet whoever asks.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();

  if (subordinate.actorId === null) throw new Error('the added agent has no actor');

  Object.defineProperty(workspace.agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => {
      const frame = v.safeParse(ChatResponseSchema, JSON.parse(payload));

      if (!frame.success) return;
      const card = terminalChatError(frame.output);
      const entry = entryOf(frame.output);

      if (card !== null) shown.push(card.body);

      if (entry !== null) seen.push(entry);

      if (frame.output.done) ended.resolve();
    },
  });

  await runDelegatedTask(workspace, subordinate.actorId, 'Say hello.');

  return { seen, shown };
}

test("a hosted agent's turn ends with its answer while its title model runs", async () => {
  expect(await firstTask((run) => chatCompletion(run, 'Hello.'))).toEqual({
    seen: ['answer: Hello.', 'turn ended', 'title model'], shown: [],
  });
});

test("a hosted agent's failed turn ends on one error, shown once", async () => {
  const { seen, shown } = await firstTask(() => new Response('', { status: 400 }));

  expect([seen.length, shown.length]).toEqual([1, 1]);
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
