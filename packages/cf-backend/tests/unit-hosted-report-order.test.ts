/**
 * Where a hosted child's report lands on its hosted hirer. A durable child's report is written at once, and the hirer
 * acts on it after its own turn ends; a drain signalled mid-turn left the report stranded until the delivery grace.
 */
import { expect, test } from 'bun:test';
import { sqlOver } from '@kinu.run/test-utils';
import {
  agentSql, armedWakes, driveUntil, GATEWAY_CATALOG, gatewayWorkspace, hostedSubordinateHarness, reactivateOrchestratorHarness, wakeForDelegatedTask,
} from './helpers/actor-harness';
import { abandonHarnessFibers, joinHarnessFibers, joinHarnessKeepAlives } from './helpers/agents-sdk';
import { KINU_TIMER_JOB } from '../src/wake-jobs';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

// A helper that hired durable then task: the durable hire's report must not wait on the helper while its task hire runs.
test("a helper waiting on its task hire gets its answer, then takes up the report its durable hire made meanwhile", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages } = requestOf(run);
    const opening = JSON.stringify(messages.filter((message) => message.role === 'user'));
    const results = messages.filter((message) => message.role === 'tool').length;

    if (opening.includes('Middle task.')) {
      if (results === 0) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable');

      if (results === 1) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', mission: 'Task task.' } }, 'call_task');

      return chatCompletion(run, 'Middle done.');
    }

    return chatCompletion(run, opening.includes('Durable task.') ? 'Durable done.' : 'Task done.');
  }));

  await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

  const middle = await hostedSubordinateHarness(workspace, {
    name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
  });

  // The helper's runs are in its own database.
  const middleDone = (): boolean => (agentSql(middle.actor.handle.actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middle.actor.handle.actorId} AND type = 'run_end'`[0]?.n ?? 0) > 0;

  await wakeForDelegatedTask(workspace, middle.actor.handle.actorId, 'Middle task.');

  await driveUntil(workspace, 'the helper\'s turn never ended', middleDone);

  // The durable hire reported while the helper waited: the helper takes it up in a turn of its own.
  const turns = (): number => agentSql(middle.actor.handle.actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middle.actor.handle.actorId} AND type = 'run_start'`[0]?.n ?? 0;

  await driveUntil(workspace, 'the helper never took up the report in a turn of its own', () => turns() >= 2);
  expect(turns()).toBe(2);
});

// A helper that asks its durable hire anything that waits on that hire's queue must not block the hire, which waits
// inside its own task hire.
const ASKS = {
  msg: (agent: string) => ({ op: 'message', agent, message: 'Also note this.' }),
  assign: (agent: string) => ({ op: 'assign', agent, message: 'Another task.' }),
  status: (agent: string) => ({ op: 'list', agent }),
  dismiss: (agent: string) => ({ op: 'dismiss', agent }),
} as const;

// The last case: the hire also notes its progress with the report tool, mid-turn, while its hirer's msg waits on it.
const CASES = [
  ...Object.entries(ASKS).map(([verb, args]) => ({ verb, args, notes: false })),
  { verb: 'msg', args: ASKS.msg, notes: true },
];

for (const { verb, args, notes } of CASES) {
  test(`a helper's ${verb} to its durable hire, while that hire waits on its own task hire${notes ? ' and then reports progress' : ''}, still finishes`, async () => {
    let parked = false;
    const release = Promise.withResolvers<void>();

    const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
      const { messages } = requestOf(run);
      const users = messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message));
      const results = messages.filter((message) => message.role === 'tool').length;
      const second = users.map((user) => /Second: ([a-z0-9-]+)/.exec(user)?.[1]).find((name) => name !== undefined);

      if (second !== undefined) {
        // Counted from its own brief: the helper's history carries the first turn's hire result.
        const brief = messages.map((message) => JSON.stringify(message).includes('Second: ')).lastIndexOf(true);
        const asked = messages.slice(brief).some((message) => message.role === 'tool');

        return !asked ? toolCallCompletion(run, { tool: 'agents', args: args(second) }, 'call_ask') : chatCompletion(run, 'Second done.');
      }

      if (users.some((user) => user.includes('Middle task.'))) {
        return results === 0
          ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable')
          : chatCompletion(run, 'Middle done.');
      }

      if (users.some((user) => user.includes('Durable task.'))) {
        if (notes && results === 1) return toolCallCompletion(run, { tool: 'report', args: { status: 'progress', content: 'halfway' } }, 'call_note');

        if (results > 0) return chatCompletion(run, 'Durable done.');
        parked = true;
        await release.promise;

        return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', mission: 'Leaf task.' } }, 'call_leaf');
      }

      return chatCompletion(run, 'Leaf done.');
    }));

    await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

    const middle = await hostedSubordinateHarness(workspace, {
      name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
    });

    const sql = sqlOver(workspace.db);
    const middleId = middle.actor.handle.actorId;
    const turnsEnded = (): number => agentSql(middleId)<{ n: number }>`SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middleId} AND type = 'run_end'`[0]?.n ?? 0;

    await wakeForDelegatedTask(workspace, middleId, 'Middle task.');

    await driveUntil(workspace, 'the durable hire never started its turn', () => parked);

    const durable = sql<{ name: string }>`SELECT s.name FROM actor_subordinates s
      JOIN workspace_actors a ON a.actor_id = json_extract(s.actor_reference, '$.actorId')
      WHERE s.actor_id = ${middleId} AND a.lifetime = 'durable'`[0]?.name;

    if (durable === undefined) throw new Error('the helper hired no durable agent');
    // Queued while the durable hire's turn is still parked.
    await wakeForDelegatedTask(workspace, middleId, `Second: ${durable}`);
    release.resolve();

    await driveUntil(workspace, 'the helper never ended both its turns', () => turnsEnded() >= 2);
    expect(turnsEnded()).toBe(2);
  });
}

test("a report its durable hire made during a helper's turn is taken up though the workspace reset before that turn ended", async () => {
  let takenUp = false;

  // The first activation's leaf never answers: the helper's turn is still waiting on it when the reset comes.
  const script = (leafAnswers: boolean) => async (run: RecordedGatewayRun): Promise<Response> => {
    const { messages } = requestOf(run);
    const users = messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message));
    const results = messages.filter((message) => message.role === 'tool').length;

    if (users.some((user) => user.includes('Durable done.'))) {
      takenUp = true;

      return chatCompletion(run, 'Noted.');
    }

    if (users.some((user) => user.includes('Middle task.'))) {
      if (results === 0) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable');

      if (results === 1) return toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', mission: 'Leaf task.' } }, 'call_task');

      return chatCompletion(run, 'Middle done.');
    }

    if (users.some((user) => user.includes('Durable task.'))) return chatCompletion(run, 'Durable done.');

    if (!leafAnswers) return await new Promise<Response>(() => {});

    return chatCompletion(run, 'Leaf done.');
  };

  const world = { versionId: 'build-report-reset' };
  const first = gatewayWorkspace(stubAiBinding(script(false)), world);
  await first.agent.setSoul('# Purpose\n\nDo each task asked.');

  const middle = await hostedSubordinateHarness(first, {
    name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
  });

  const sql = sqlOver(first.db);
  const middleId = middle.actor.handle.actorId;

  const pendingReports = (): number => sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM agent_log WHERE actor_id = ${middleId} AND variant = 'subordinate_report' AND turn_id IS NULL`[0]?.n ?? 0;

  await wakeForDelegatedTask(first, middleId, 'Middle task.');

  await driveUntil(first, 'the durable hire never reported mid-turn', () => pendingReports() > 0);
  expect(pendingReports()).toBe(1);

  abandonHarnessFibers();

  const second = await reactivateOrchestratorHarness(first.db, undefined, {
    world: { ...world, aiGateway: stubAiBinding(script(true)) },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  await driveUntil(second, 'the helper never took up the report after the reset', () => takenUp);
  expect(takenUp).toBe(true);
});

// Review P1 (integration/0963): a hosted hirer's drain was only an in-memory debounce, so a reset right after its
// hire's report landed left that report pending with no wake that would ever take it up.
test("a report to an idle helper survives a reset before its drain: the durable wake takes it up", async () => {
  let takenUp = false;

  const script = (run: RecordedGatewayRun): Response => {
    const { messages } = requestOf(run);
    const users = messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message));
    const results = messages.filter((message) => message.role === 'tool').length;

    if (users.some((user) => user.includes('Durable done.'))) {
      takenUp = true;

      return chatCompletion(run, 'Noted.');
    }

    if (users.some((user) => user.includes('Middle task.'))) {
      return results === 0
        ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable')
        : chatCompletion(run, 'Middle waits.');
    }

    return chatCompletion(run, 'Durable done.');
  };

  const world = { versionId: 'build-idle-report-reset' };
  const first = gatewayWorkspace(stubAiBinding(script), world);
  await first.agent.setSoul('# Purpose\n\nDo each task asked.');

  const middle = await hostedSubordinateHarness(first, {
    name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
  });

  const sql = sqlOver(first.db);
  const middleId = middle.actor.handle.actorId;

  const pendingReports = (): number => sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM agent_log WHERE actor_id = ${middleId} AND variant = 'subordinate_report' AND turn_id IS NULL`[0]?.n ?? 0;

  await wakeForDelegatedTask(first, middleId, 'Middle task.');
  await driveUntil(first, 'the durable hire never reported', () => pendingReports() > 0);
  // The first activation's debounced drains run out before the reset, so none of them can take the report up later.
  await joinHarnessKeepAlives(first.agent);
  expect(pendingReports()).toBe(1);
  abandonHarnessFibers();

  const second = await reactivateOrchestratorHarness(first.db, undefined, {
    world: { ...world, aiGateway: stubAiBinding(script) },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  // Still owed after the restart, and the only thing that will take it up is the durable wake the activation armed.
  expect(pendingReports()).toBe(1);
  expect(armedWakes(first.db).map((wake) => wake.id)).toContain(KINU_TIMER_JOB);
  // Due now, and fired the way the platform fires it: through the SDK's alarm.
  first.db.prepare('UPDATE cf_agents_jobs SET time = ? WHERE id = ?').run(Date.now() - 1, KINU_TIMER_JOB);
  await second.agent.alarm();
  await joinHarnessFibers();
  expect(pendingReports()).toBe(0);

  await driveUntil(second, 'the helper never took up the report after the reset', () => takenUp);
});
