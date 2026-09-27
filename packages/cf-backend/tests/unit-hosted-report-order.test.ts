/**
 * Where a hosted child's report lands on its hosted hirer. A durable child's report is written at once, and the hirer
 * acts on it after its own turn ends; a drain signalled mid-turn left the report stranded until the delivery grace.
 */
import { test } from 'bun:test';
import { sqlOver } from '@kinu.run/test-utils';
import { GATEWAY_CATALOG, type ActorHarness, type HarnessOrchestratorAgent, gatewayWorkspace, hostedSubordinateHarness, nextTurn, reactivateOrchestratorHarness, wakeForDelegatedTask } from './helpers/actor-harness';
import { abandonHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

/** Runs the object's wake while `pending`: no lap count, so a deadlock hangs and the hang is the report. */
async function driveWhile(workspace: ActorHarness<HarnessOrchestratorAgent>, pending: () => boolean): Promise<void> {
  while (pending()) {
    await workspace.agent.terminalRetryPass();
    await nextTurn();
  }
}

// One turn slot (DELEGATED_TURN_SLOTS): a helper waiting on its task hire frees the slot; its durable hire must not
// then hold that slot while its report queues behind the waiting helper, or the task hire never runs.
test("a helper waiting on its task hire gets its answer, then takes up the report its durable hire made meanwhile", async () => {
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
  await driveWhile(workspace, () => !middleDone());


  // The durable hire reported while the helper waited: the helper takes it up in a turn of its own.
  const turns = (): number => sqlOver(workspace.db)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middle.actor.handle.actorId} AND type = 'run_start'`[0]?.n ?? 0;

  await driveWhile(workspace, () => turns() < 2);

});

// One turn slot: a helper that holds it and asks its durable hire anything that waits on that hire's queue must free
// the slot, or the hire, waiting inside its own task hire, never gets its task helper run.
const ASKS = {
  msg: (agent: string) => ({ action: 'msg', agent, message: 'Also note this.' }),
  assign: (agent: string) => ({ action: 'hire', agent, message: 'Another task.' }),
  status: (agent: string) => ({ action: 'list', agent }),
  dismiss: (agent: string) => ({ action: 'dismiss', agent }),
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
          ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable')
          : chatCompletion(run, 'Middle done.');
      }

      if (users.some((user) => user.includes('Durable task.'))) {
        if (notes && results === 1) return toolCallCompletion(run, { tool: 'report', args: { status: 'progress', content: 'halfway' } }, 'call_note');

        if (results > 0) return chatCompletion(run, 'Durable done.');
        parked = true;
        await release.promise;

        return toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', lifetime: 'task', mission: 'Leaf task.' } }, 'call_leaf');
      }

      return chatCompletion(run, 'Leaf done.');
    }));

    await workspace.agent.setSoul('# Purpose\n\nDo each task asked.');

    const middle = await hostedSubordinateHarness(workspace, {
      name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate',
    });

    const sql = sqlOver(workspace.db);
    const middleId = middle.actor.handle.actorId;
    const turnsEnded = (): number => sql<{ n: number }>`SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middleId} AND type = 'run_end'`[0]?.n ?? 0;

    await wakeForDelegatedTask(workspace, middleId, 'Middle task.');

    await driveWhile(workspace, () => !parked);

    const durable = sql<{ name: string }>`SELECT name FROM actor_subordinates WHERE actor_id = ${middleId} AND lifetime = 'durable'`[0]?.name;

    if (durable === undefined) throw new Error('the helper hired no durable agent');
    // Queued for the slot before the leaf is: the durable hire still holds it, parked.
    await wakeForDelegatedTask(workspace, middleId, `Second: ${durable}`);
    release.resolve();

    // Bounded: a deadlock fails here by name instead of hanging the suite.
    await driveWhile(workspace, () => turnsEnded() < 2);

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
      if (results === 0) return toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', mission: 'Durable task.' } }, 'call_durable');

      if (results === 1) return toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', lifetime: 'task', mission: 'Leaf task.' } }, 'call_task');

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

  await driveWhile(first, () => pendingReports() === 0);

  abandonHarnessFibers();

  const second = await reactivateOrchestratorHarness(first.db, undefined, {
    world: { ...world, aiGateway: stubAiBinding(script(true)) },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  // Bounded: a report the helper never takes up fails here by name.
  await driveWhile(second, () => !takenUp);

});
