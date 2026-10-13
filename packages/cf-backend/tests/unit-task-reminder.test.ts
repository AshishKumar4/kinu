/**
 * An agent that stops with tasks open is reminded of them by a turn of its own. Its `tasks` tool runs in the workspace
 * and writes the workspace's store, while its chat decides the reminder in its own isolate (D9): the chat reads the open
 * tasks where the tool wrote them.
 */
import { expect, test } from 'bun:test';
import { catalogTurn, driveUntil, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

test('a root turn that stops with its tasks open is reminded of them', async () => {
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    const { messages } = requestOf(run);
    const sent = JSON.stringify(messages);

    asked.push(sent);

    if (sent.includes('open task(s)')) return chatCompletion(run, 'Back on it.');

    return messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Started on the migration.')
      : toolCallCompletion(run, { tool: 'tasks', args: { op: 'add', titles: ['Migrate the ledger to integer cents'] } }, 'add_0');
  });

  const workspace = gatewayWorkspace(gateway);

  await catalogTurn(workspace.agent, 'Plan the ledger migration and start on it.');
  await driveUntil(workspace, 'the open task was never reminded', () => asked.some((sent) => sent.includes('open task(s)')));

  expect(asked.find((sent) => sent.includes('open task(s)'))).toContain('Migrate the ledger to integer cents');
});
