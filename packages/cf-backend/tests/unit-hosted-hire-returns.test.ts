/**
 * Every hire returns at once (owner, SUBAGENTS.md §4): the hirer's turn ends, and the child's answer or failure
 * arrives later as a message that opens the hirer's next turn, through the durable report path. A Stop reaches the
 * agents a stopped agent hired.
 */
import { expect, test } from 'bun:test';
import { sqlOver } from '@kinu.run/test-utils';
import { catalogTurn, driveUntil, gatewayWorkspace, hostedSubordinateHarness, wakeForDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

/** A model call's own user turns, without the runtime's context blocks (which list other agents' briefs). */
const openingOf = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages.filter((message) =>
  message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context')));

const toolResults = (run: RecordedGatewayRun): number => requestOf(run).messages.filter((message) => message.role === 'tool').length;

/** A model call that answers only when its turn is aborted, the way a stopped provider call ends. */
function heldUntilAborted(run: RecordedGatewayRun): Promise<Response> {
  const { promise, reject } = Promise.withResolvers<Response>();
  run.signal?.addEventListener('abort', () => { reject(run.signal?.reason); }, { once: true });

  return promise;
}

async function helperWorkspace(respond: (run: RecordedGatewayRun) => Response | Promise<Response>) {
  const gateway = stubAiBinding(respond);
  const workspace = gatewayWorkspace(gateway);
  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

  const middle = await hostedSubordinateHarness(workspace, {
    name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
  });

  const sql = sqlOver(workspace.db);

  const count = (actorId: string, type: 'run_start' | 'run_end'): number => sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = ${type}`[0]?.n ?? 0;

  const hired = (): string | undefined => sql<{ id: string }>`
    SELECT actor_id AS id FROM workspace_actors WHERE parent_actor_id = ${middle.actor.handle.actorId}`[0]?.id;

  const retiring = (actorId: string): boolean => sql<{ at: number | null }>`
    SELECT retiring_at AS at FROM workspace_actors WHERE actor_id = ${actorId}`[0]?.at != null;

  return { gateway, workspace, middleId: middle.actor.handle.actorId, count, hired, retiring };
}

test("a helper's task hire returns at once, and the answer opens the helper's next turn", async () => {
  const release = Promise.withResolvers<void>();
  let leafAsked = false;

  const { gateway, workspace, middleId, count, hired, retiring } = await helperWorkspace(async (run) => {
    const opening = openingOf(run);

    if (opening.includes('Leaf task.')) {
      leafAsked = true;
      await release.promise;

      return chatCompletion(run, 'Leaf done.');
    }

    if (opening.includes('Leaf done.')) return chatCompletion(run, 'Middle relays Leaf done.');

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', lifetime: 'task', mission: 'Leaf task.' } }, 'call_leaf')
      : chatCompletion(run, 'Middle waits.');
  });

  await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
  await driveUntil(workspace, 'the helper\'s turn never ended while its task hire worked', () => leafAsked && count(middleId, 'run_end') > 0);
  // The hire returned while its agent was still working: the helper's turn ended holding no wait.
  expect(gateway.unanswered.size).toBe(1);

  release.resolve();
  await driveUntil(workspace, 'the task agent\'s answer never opened the helper\'s next turn', () => count(middleId, 'run_start') >= 2);
  await driveUntil(workspace, 'the helper never answered on its task agent\'s message', () => count(middleId, 'run_end') >= 2);
  expect(gateway.runs.some((run) => openingOf(run).includes('Leaf done.'))).toBe(true);
  // The task agent retires once its answer is held, keeping its history.
  const leaf = hired() ?? '';
  await driveUntil(workspace, 'the answered task agent never retired', () => retiring(leaf));
});

test("a durable hire whose turn fails delivers its failure to its hirer as a message", async () => {
  const { gateway, workspace, middleId, count } = await helperWorkspace((run) => {
    const opening = openingOf(run);

    if (opening.includes('Durable task.')) return new Response('', { status: 400 });

    if (toolResults(run) === 0 && opening.includes('Middle task.') && !opening.includes('failed')) {
      return toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable');
    }

    return chatCompletion(run, 'Middle noted.');
  });

  await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
  await driveUntil(workspace, 'the failed hire\'s failure never opened its hirer\'s next turn', () => count(middleId, 'run_start') >= 2);
  await driveUntil(workspace, 'the helper never answered on its hire\'s failure', () => count(middleId, 'run_end') >= 2);

  const told = gateway.runs.filter((run) => openingOf(run).includes('This turn failed before an answer existed'));

  expect(told.length).toBe(1);
});

test("a Stop reaches the agent a stopped helper hired, and wakes no one", async () => {
  let durableAsked = false;

  const { workspace, middleId, count, hired } = await helperWorkspace((run) => {
    const opening = openingOf(run);

    if (opening.includes('Durable task.')) {
      durableAsked = true;

      return heldUntilAborted(run);
    }

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable')
      : chatCompletion(run, 'Middle waits.');
  });

  await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
  await driveUntil(workspace, 'the durable hire never started its turn', () => durableAsked);
  const durableId = hired() ?? '';

  await workspace.agent.cancelCurrentWork();
  await driveUntil(workspace, 'the Stop never ended the hired agent\'s turn', () => count(durableId, 'run_end') > 0);

  expect(count(middleId, 'run_start')).toBe(1);
});

// hire.test flaked on this (staging-flows-scripted-569bb6869d run 1; flake-gate 3 of 6): a task helper's progress note
// and its hire's answer queued as two turns, and the helper settled on the first, with the answer still queued.
test("a task agent does not settle while more input is queued for it: its answer is its last turn's", async () => {
  const parked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const gateway = stubAiBinding(async (run) => {
    const opening = openingOf(run);

    if (opening.includes('Queued note.')) return chatCompletion(run, 'second answer');

    if (opening.includes('Helper brief.')) {
      parked.resolve();
      await release.promise;

      return chatCompletion(run, 'first answer');
    }

    if (opening.includes('answer')) return chatCompletion(run, 'Root noted.');

    return toolResults(run) === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', lifetime: 'task', mission: 'Helper brief.' } }, 'call_helper')
      : chatCompletion(run, 'Root waits.');
  });

  const workspace = gatewayWorkspace(gateway);
  const sql = sqlOver(workspace.db);
  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

  const turn = catalogTurn(workspace.agent, 'Hire a helper.');

  await driveUntil(workspace, 'the task helper never started', () => gateway.runs.some((run) => openingOf(run).includes('Helper brief.')));
  await turn;
  const helperId = sql<{ id: string }>`SELECT actor_id AS id FROM workspace_actors WHERE kind = 'subordinate'`[0]?.id ?? '';
  // More input queues for the helper while its first turn is still out.
  await wakeForDelegatedTask(workspace, helperId, 'Queued note.');
  release.resolve();

  const rootTold = (): string[] => gateway.runs.map(openingOf).filter((opening) => opening.includes('[subordinate_report]'));

  await driveUntil(workspace, 'the task helper\'s answer never reached the root', () => rootTold().length > 0);

  expect(rootTold().join(' ')).toContain('second answer');
  expect(rootTold().join(' ')).not.toContain('first answer');
});
