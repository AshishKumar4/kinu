/**
 * Where a hosted child's report lands on its hosted hirer. A durable child's report waits out the hirer's turn, so the
 * hirer's drain meets it between turns; a report written mid-turn sat past the drain until the stranded-delivery grace.
 */
import { expect, test } from 'bun:test';
import { sqlOver } from '@kinu.run/test-utils';
import { gatewayWorkspace, hostedSubordinateHarness, nextTurn, wakeForDelegatedTask } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

test("a durable helper's report reaches its working hirer after the hirer's turn, not during it", async () => {
  const parked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
    const { messages } = requestOf(run);
    // Keyed on the user turns; the hirer's are checked first, since its context names the helper's mission.
    const opening = JSON.stringify(messages.filter((message) => message.role === 'user'));
    const answered = messages.some((message) => message.role === 'tool');

    if (opening.includes('Middle task.')) {
      if (!answered) return toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', mission: 'Grandchild task.' } }, 'call_hire');

      // The hirer, its hire made, is still in its turn.
      parked.resolve();
      await release.promise;

      return chatCompletion(run, 'Done.');
    }

    // The helper's own durable hire reports once, then ends its turn.
    if (opening.includes('Grandchild task.')) {
      return answered ? chatCompletion(run, 'Reported.') : toolCallCompletion(run, { tool: 'report', args: { status: 'completed', content: 'news' } }, 'call_report');
    }

    return chatCompletion(run, 'Done.');
  }));

  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

  const middle = await hostedSubordinateHarness(workspace, {
    name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
  });

  const reports = (): number => sqlOver(workspace.db)<{ n: number }>`
    SELECT COUNT(*) AS n FROM agent_log WHERE actor_id = ${middle.actor.handle.actorId} AND variant = 'subordinate_report'`[0]?.n ?? 0;

  await wakeForDelegatedTask(workspace, middle.actor.handle.actorId, 'Middle task.');
  await parked.promise;
  // The wake the hire armed: it starts the grandchild's turn beside the parked hirer.
  await workspace.agent.terminalRetryPass();

  // Laps enough for the grandchild's turn and an unqueued ingress; the hirer's turn stays parked throughout.
  for (let lap = 0; lap < 500 && reports() === 0; lap++) await nextTurn();

  expect(reports()).toBe(0);
  release.resolve();
  await joinHarnessFibers();
  expect(reports()).toBe(1);
});

// One turn slot (DELEGATED_TURN_SLOTS): a helper waiting on its task hire frees the slot; its durable hire must not
// then hold that slot while its report queues behind the waiting helper, or the task hire never runs.
test("a helper waiting on its task hire still gets its answer while its durable hire reports", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages } = requestOf(run);
    const opening = JSON.stringify(messages.filter((message) => message.role === 'user'));
    const results = messages.filter((message) => message.role === 'tool').length;

    if (opening.includes('Middle task.')) {
      if (results === 0) return toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable');

      if (results === 1) return toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', lifetime: 'task', mission: 'Task task.' } }, 'call_task');

      return chatCompletion(run, 'Middle done.');
    }

    return chatCompletion(run, opening.includes('Durable task.') ? 'Durable done.' : 'Task done.');
  }));

  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

  const middle = await hostedSubordinateHarness(workspace, {
    name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
  });

  const middleDone = (): boolean => (sqlOver(workspace.db)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middle.actor.handle.actorId} AND type = 'run_end'`[0]?.n ?? 0) > 0;

  await wakeForDelegatedTask(workspace, middle.actor.handle.actorId, 'Middle task.');

  // Bounded: a deadlock fails here by name instead of hanging the suite.
  for (let lap = 0; lap < 300 && !middleDone(); lap++) {
    await workspace.agent.terminalRetryPass();
    await nextTurn();
  }

  expect(middleDone()).toBe(true);
});
