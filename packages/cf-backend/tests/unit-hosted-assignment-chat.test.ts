/**
 * An agent that has only ever worked assignments opens to its work: each delegated task is an event row in its own chat
 * naming its hirer (owner m1768, EVENTS-ONE-API-0926), and the answer lands under it.
 */
import { expect, test } from 'bun:test';
import { sqlOver } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  agentSql, driveUntil, gatewayWorkspace, hostedSubordinateHarness, runDelegatedTask, wakeForDelegatedTask,
} from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

/** What an open pane is sent: the transcript, or a turn's stream. */
const FrameSchema = v.variant('type', [
  v.looseObject({ type: v.literal('cf_agent_chat_messages'), messages: v.array(v.looseObject({ metadata: v.optional(v.record(v.string(), v.unknown())) })) }),
  v.looseObject({ type: v.literal('cf_agent_use_chat_response'), body: v.string(), done: v.boolean() }),
]);

test("a durable grandchild that only worked its assignment shows the task, from its hirer, and its answer", async () => {
  const gateway = stubAiBinding((run) => {
    const { messages } = requestOf(run);
    const opening = JSON.stringify(messages.filter((message) => message.role === 'user'));
    const answered = messages.some((message) => message.role === 'tool');

    if (opening.includes('Middle task.')) {
      return answered
        ? chatCompletion(run, 'Middle done.')
        : toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable');
    }

    return chatCompletion(run, 'Durable done.');
  });

  const workspace = gatewayWorkspace(gateway);

  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

  const middle = await hostedSubordinateHarness(workspace, {
    name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
  });

  const sql = sqlOver(workspace.db);

  const grandchild = (): string | undefined => sql<{ id: string }>`
    SELECT actor_id AS id FROM workspace_actors WHERE parent_actor_id = ${middle.actor.handle.actorId}`[0]?.id;

  // The agent's runs are in its own database.
  const ended = (actorId: string): boolean => (agentSql(actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = 'run_end'`[0]?.n ?? 0) > 0;

  await wakeForDelegatedTask(workspace, middle.actor.handle.actorId, 'Middle task.');
  await driveUntil(workspace, 'the helper never hired its durable agent', () => grandchild() !== undefined);
  const actorId = grandchild() ?? '';
  await driveUntil(workspace, 'the durable agent never ended its turn', () => ended(actorId));

  const { items } = await workspace.agent.getChatHistoryPage({ actor: actorId, limit: 20 });

  expect(items.map(({ role, content, metadata }) => ({ role, content, from: metadata?.['kinuFrom'], event: metadata?.['kinuEvent'] }))).toEqual([
    { role: 'system', content: 'Durable task.', from: 'middle', event: 'subordinate_task' },
    { role: 'assistant', content: 'Durable done.', from: undefined, event: undefined },
  ]);

  // The row is the chat's record of the task, not a second copy in the agent's own prompt.
  const prompts = gateway.runs.map((run) => JSON.stringify(requestOf(run).messages));
  const asked = prompts.find((prompt) => prompt.includes('Durable task.') && !prompt.includes('Middle task.')) ?? '';

  expect(asked.split('Durable task.').length - 1).toBe(1);
});

test("an open pane on the agent sees its task row before the answer streams, as it sees a sent message", async () => {
  const seen: string[] = [];
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Hello.')));

  await workspace.agent.setSoul('# Purpose\n\nGreet whoever asks.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();

  if (subordinate.actorId === null) throw new Error('the added agent has no actor');

  Object.defineProperty(workspace.agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => {
      const frame = v.safeParse(FrameSchema, JSON.parse(payload));

      if (!frame.success) return;

      if (frame.output.type === 'cf_agent_chat_messages') {
        if (!seen.includes('task row') && frame.output.messages.some((message) => message.metadata?.['kinuEvent'] === 'subordinate_task')) seen.push('task row');

        return;
      }

      if (frame.output.done) seen.push('turn ended');
      else if (frame.output.body.includes('text-delta')) seen.push('answer');
    },
  });

  await runDelegatedTask(workspace, subordinate.actorId, 'Say hello.');

  expect(seen.filter((entry, at) => entry !== seen[at - 1])).toEqual(['task row', 'answer', 'turn ended']);
});
