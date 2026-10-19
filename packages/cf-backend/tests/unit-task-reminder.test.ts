/**
 * An agent that stops with tasks open is reminded of them by a turn of its own. Its `tasks` tool runs in the workspace
 * and writes the workspace's store, while its chat decides the reminder in its own isolate (D9): the chat reads the open
 * tasks where the tool wrote them.
 */
import { expect, test } from 'bun:test';
import type { OwnerAnswer } from '@kinu.run/core';
import { setDiagnosticsSink } from '@kinu.run/core/obs';
import { createRecordingLogger } from '@kinu.run/test-utils';
import { agentWakes, catalogTurn, driveUntil, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
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

const ASK = {
  questions: [{
    id: 'units', question: 'Which unit should the ledger store?', header: 'Units', recommended: 0,
    options: [{ label: 'Integer cents', description: 'Exact.' }, { label: 'Decimal dollars', description: 'Readable.' }],
  }],
};

const ANSWER: OwnerAnswer[] = [{ id: 'units', selected: ['Integer cents'] }];

// A turn that ended on a question to its owner with a task open queued its reminder behind the question, and the agent
// still read as owing a turn: each wake, about a minute apart, re-ran the reminder's effect, found its turn still queued,
// and armed the next, for as long as the question stood. Held behind the question, the reminder is parked: nothing wakes
// for it until the owner answers or withdraws the question, even when the isolate that queued it ended meanwhile.
for (const closing of ['answers', 'withdraws', 'withdraws after the isolate ended'] as const) {
  test(`a reminder that waits behind an open question arms no wake, and runs once the owner ${closing}`, async () => {
    const asked: string[] = [];

    const gateway = stubAiBinding((run) => {
      const { messages } = requestOf(run);
      const sent = JSON.stringify(messages);
      const results = messages.filter((message) => message.role === 'tool').length;

      asked.push(sent);

      if (sent.includes('open task(s)')) return chatCompletion(run, 'Back on it.');

      if (results === 0) return toolCallCompletion(run, { tool: 'tasks', args: { op: 'add', titles: ['Migrate the ledger to integer cents'] } }, 'add_0');

      return results === 1 ? toolCallCompletion(run, { tool: 'ask_owner', args: ASK }, 'call_ask') : chatCompletion(run, 'Storing integer cents.');
    });

    const workspace = gatewayWorkspace(gateway);
    const main = workspaceMainActor(workspace.db).actorId;
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      await catalogTurn(workspace.agent, 'Plan the ledger migration and start on it.');
      await workspace.agent.terminalRetryPass();
    } finally {
      restore();
    }

    const [question] = (await workspace.agent.listOwnerQuestions()).filter((asking) => asking.asked.status === 'open');
    const parked = log.emitted.filter((line) => line.event === 'turn.terminal_effect_parked').map((line) => line.fields.waits);

    expect({ open: question !== undefined, wakes: agentWakes(workspace.db).filter((actor) => actor === main), reminded: asked.some((sent) => sent.includes('open task(s)')), parked })
      .toEqual({ open: true, wakes: [], reminded: false, parked: ['owner_question'] });

    if (closing === 'withdraws after the isolate ended') workspace.agent.harnessResetAgentIsolate(workspace.agent.agentOf(main).storageKey);

    if (closing === 'answers') await workspace.agent.answerOwnerQuestions(question?.asked.id ?? '', ANSWER);
    else await workspace.agent.dismissOwnerQuestions(question?.asked.id ?? '');

    await driveUntil(workspace, `the reminder never ran once the owner ${closing}`, () => asked.some((sent) => sent.includes('open task(s)')));
  });
}
