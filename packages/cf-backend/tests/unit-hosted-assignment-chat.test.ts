/**
 * An agent that has only ever worked assignments opens to its work: each delegated task is an event row in its own chat
 * naming its hirer (owner m1768, EVENTS-ONE-API-0926), and the answer lands under it.
 */
import { expect, test } from 'bun:test';
import { sqlOver } from '@kinu.run/test-utils';
import {
  agentSql, driveUntil, gatewayWorkspace, hostedSubordinateHarness, wakeForDelegatedTask,
} from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

test("a durable grandchild that only worked its assignment shows the task, from its hirer, and its answer", async () => {
  const gateway = stubAiBinding((run) => {
    const { messages } = requestOf(run);
    const opening = JSON.stringify(messages.filter((message) => message.role === 'user'));
    const answered = messages.some((message) => message.role === 'tool');

    if (opening.includes('Middle task.')) {
      return answered
        ? chatCompletion(run, 'Middle done.')
        : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable');
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
