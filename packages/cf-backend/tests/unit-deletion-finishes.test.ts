/**
 * A workspace's deletion lands, whatever its agents were doing when it began. Staging rc21, 2026-10-19,
 * eval-office-3-dj5qhl: the deletion's quiet was refused by its own fence, the destroy joined that refusal, the row
 * stayed marked with nothing to finish it, and the agent's wake, standing through it all, woke the agent about once a
 * minute for six hours (426 starts, 687 owed reports, 2,102 calls into its isolate).
 */
import { expect, test } from 'bun:test';
import { setDiagnosticsSink } from '@kinu.run/core/obs';
import { createRecordingLogger, type RecordingLogger } from '@kinu.run/test-utils';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { agentWakes, gatewayWorkspace, orchestratorHarness, wakeForDelegatedTask, workspaceMainActor, type StartedHarness } from './helpers/actor-harness';
import { cutNextDelivery, loseNextInterrupt } from './helpers/agent-facets';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const OWNER = 'abcdef0123456789abcdef0123456789';

interface Deleting {
  readonly user: TestUserDO;
  readonly workspace: StartedHarness;
  readonly main: string;
  /** Lets main's held model call answer. */
  readonly release: () => void;
}

/**
 * The owner's workspace, its account's deletion reaching the workspace's own quiet and destroy, with main's turn open on
 * a model call held until released.
 */
async function deletingMidTurn(): Promise<Deleting> {
  const reached = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  let workspace: StartedHarness | null = null;

  const user = createTestUserDO({
    durableObjectId: OWNER,
    quietWorkspaceGate: async (_name, owner) => { await workspace?.agent.quietForDeletion(owner); },
    destroyWorkspaceGate: async (_name, owner) => { await workspace?.agent.destroyAgent(owner); },
  });

  await user.userDO.registerWorkspace(await testOwner(), 'ledger');
  await user.userDO.ensureWorkspaceCapability('ledger', null);
  const token = user.installed.get('ledger');

  if (token === undefined) throw new Error('the workspace was not provisioned');

  const started = gatewayWorkspace(stubAiBinding(async (run) => {
    reached.resolve();
    await held.promise;

    return chatCompletion(run, 'Migrated.');
  }), { userDO: user.userDO, workspace: 'ledger', ownerUserId: OWNER });

  workspace = started;
  started.agent.harnessHoldsCapability(token);
  await started.agent.send('Migrate the ledger to integer cents.', crypto.randomUUID(), []);
  await reached.promise;

  return { user, workspace: started, main: workspaceMainActor(started.db).actorId, release: held.resolve };
}

/** What the deletion left: its quiet's failures, whether it landed, the account's marked rows, the workspace's tables. */
function left(deleting: Deleting, log: RecordingLogger) {
  return {
    failed: log.emitted.filter((line) => line.event.endsWith('quiet_failed')).map((line) => line.event),
    destroyed: log.emitted.filter((line) => line.event === 'workspace.destroyed').length,
    marked: deleting.user.db.query<{ name: string }, []>('SELECT name FROM user_workspaces WHERE delete_pending = 1').all(),
    tables: deleting.workspace.tableNames().filter((name) => name !== 'sqlite_sequence'),
  };
}

// Main's isolate had gone since its turn, its wake standing: the quiet's Stop opened its chat, which asks the workspace
// for its program first, and the quiet's own fence refused that ("This workspace is being deleted.").
test('a deletion stops an agent whose isolate restarted mid-turn, and lands', async () => {
  const deleting = await deletingMidTurn();
  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);

  try {
    deleting.workspace.agent.harnessResetAgentIsolate(deleting.workspace.agent.agentOf(deleting.main).storageKey);
    expect(agentWakes(deleting.workspace.db)).toEqual([deleting.main]);
    await deleting.user.userDO.removeWorkspace(await testOwner(), 'ledger', OWNER);
  } finally {
    restore();
    deleting.release();
  }

  expect(left(deleting, log)).toEqual({ failed: [], destroyed: 1, marked: [], tables: [] });
});

test('a quiet that could not stop an agent does not keep the destroy from landing', async () => {
  const deleting = await deletingMidTurn();
  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);

  try {
    loseNextInterrupt(deleting.workspace.agent.agentOf(deleting.main).storageKey);
    await deleting.user.userDO.removeWorkspace(await testOwner(), 'ledger', OWNER);
  } finally {
    restore();
    deleting.release();
  }

  expect(left(deleting, log)).toEqual({ failed: ['workspace.agent_quiet_failed'], destroyed: 1, marked: [], tables: [] });
});

test("a deletion ends every agent's wake as it begins, and its agents arm none after", async () => {
  const harness = orchestratorHarness(undefined, { ownerUserId: OWNER });
  const { agent, db } = harness;

  await agent.activateActor();
  await joinHarnessFibers();
  await agent.setSoul('# Purpose\n\nDo each task asked.');
  const { subordinate: hired } = await agent.createSubordinateAgent();

  if (hired.actorId === null) throw new Error('the added agent has no actor');
  // Its crossing dies before the agent takes it: owed, with the agent's wake armed to cross it again.
  cutNextDelivery(agent.agentOf(hired.actorId).storageKey, 'before-admit');
  await wakeForDelegatedTask(harness, hired.actorId, 'Tally the refunds.');
  expect(agentWakes(db)).toEqual([hired.actorId]);

  // The account's teardown quiets the workspace, and its destroy does not land.
  await agent.quietForDeletion(OWNER);
  await Promise.allSettled([wakeForDelegatedTask(harness, hired.actorId, 'Tally the chargebacks.')]);

  expect(agentWakes(db)).toEqual([]);
});
