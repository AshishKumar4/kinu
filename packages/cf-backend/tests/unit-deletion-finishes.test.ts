/**
 * A workspace's deletion lands, whatever its agents were doing when it began. Staging rc21, 2026-10-19,
 * eval-office-3-dj5qhl: the deletion's quiet was refused by its own fence, the destroy joined that refusal, the row
 * stayed marked with nothing to finish it, and the agent's wake, standing through it all, woke the agent about once a
 * minute for six hours (426 starts, 687 owed reports, 2,102 calls into its isolate).
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sandboxIdForWorkspace } from '@kinu.run/core';
import { renderThrownChain, setDiagnosticsSink } from '@kinu.run/core/obs';
import { createRecordingLogger, type RecordingLogger } from '@kinu.run/test-utils';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { agentWakes, gatewayWorkspace, orchestratorHarness, until, wakeForDelegatedTask, workspaceMainActor, type StartedHarness } from './helpers/actor-harness';
import { memoryBucket } from './helpers/r2';
import { pictureKey } from '../src/slates/pictures';
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
  const { subagent: hired } = await agent.createSubagentAgent();

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

// Production 2026-10-24, mossy-quarry-62346247: the person's DELETE waited 27 s on the teardown, 15.6 s of it its devbox
// listing an empty R2 prefix and 6.7 s reading the destroyed workspace again. The delete answers once it is durable and
// the list drops the workspace at once; the deletion's own job lands the teardown, its devbox's backups and its
// pictures in R2 included, even when the account's object reset with that job running.
test("a person's delete answers before its teardown, which its own job lands across a reset", async () => {
  const storage = new Database(':memory:');
  const backups = memoryBucket();
  const pictures = memoryBucket();
  const box = sandboxIdForWorkspace('ledger');
  const boxCalls: string[] = [];
  // The first teardown's devbox cleanup never answers: its activation ends under it.
  const cleanups: Array<() => Promise<void>> = [() => new Promise<void>(() => {})];
  let workspace: StartedHarness | null = null;

  const account = () => createTestUserDO({
    durableObjectId: OWNER, storage, slatePictures: pictures,
    quietWorkspaceGate: async (_name, owner) => { await workspace?.agent.quietForDeletion(owner); },
    destroyWorkspaceGate: async (_name, owner) => { await workspace?.agent.destroyAgent(owner); },
  });

  const first = account();
  const owner = await testOwner();

  await first.userDO.registerWorkspace(owner, 'ledger');
  await first.userDO.registerWorkspace(owner, 'kept');
  backups.objects.set(`boxes/${box}/backups/0001.tar.zst`, new Uint8Array([1]));
  pictures.objects.set(pictureKey('ledger', 'board', 'a'.repeat(64)), new Uint8Array([1]));

  workspace = orchestratorHarness(undefined, {
    workspace: 'ledger', ownerUserId: OWNER, container: true, boxCalls,
    box: (name) => ({
      discardState: async () => {
        boxCalls.push(`${name}.discardState`);
        await (cleanups.shift() ?? (async () => {}))();

        for (const { key } of (await backups.list({ prefix: `boxes/${name}/backups/` })).objects) await backups.delete(key);
      },
      destroy: async () => { boxCalls.push(`${name}.destroy`); },
    }),
  });

  await first.userDO.requestWorkspaceRemoval(owner, 'ledger', OWNER);

  // Answered with nothing torn down, and gone from the person's list.
  expect({ box: boxCalls, destroyed: first.destroyedWorkspaces, listed: (await first.userDO.listWorkspaces(owner)).entries.map((entry) => entry.name) })
    .toEqual({ box: [], destroyed: [], listed: ['kept'] });

  // Its job runs from the alarm, and the account's object resets with the teardown in its devbox's cleanup.
  const firstEnded: string[] = [];

  first.userDO.alarm().then(() => { firstEnded.push('answered'); }, () => { firstEnded.push('failed'); });
  await until(() => boxCalls.length > 0, 'the deletion job never reached the devbox');
  expect(first.db.query<{ running: number }, []>("SELECT running FROM cf_agents_jobs WHERE id = 'workspace-deletion:ledger'").all()).toEqual([{ running: 1 }]);

  const second = account();

  await second.userDO.alarm();

  expect({
    box: boxCalls,
    backups: (await backups.list({ prefix: `boxes/${box}/` })).objects,
    pictures: (await pictures.list({ prefix: 'slate-pictures/ledger/' })).objects,
    tables: workspace.tableNames().filter((name) => name !== 'sqlite_sequence'),
    marked: second.db.query<{ name: string }, []>('SELECT name FROM user_workspaces WHERE delete_pending = 1').all(),
    listed: (await second.userDO.listWorkspaces(owner)).entries.map((entry) => entry.name),
    reads: second.destroyReads,
  }).toEqual({
    box: [`${box}.discardState`, `${box}.discardState`, `${box}.destroy`],
    backups: [],
    pictures: [],
    tables: [],
    marked: [],
    listed: ['kept'],
    reads: [],
  });
  // The first activation's teardown never answered: the second's job landed it on its own.
  expect(firstEnded).toEqual([]);
});

// A teardown calls into its workspace, which calls back into the account, and an alarm's work went on from inside that
// call: one alarm that ran a burst of deletions went a call deeper with each, and the deepest failed "Subrequest depth
// limit exceeded" (staging 0e47a6958, 2026-10-24: three of 37). Each alarm tears down one; the next is due at once.
test("a burst of a person's deletes is torn down one per alarm, each alarm the next one's", async () => {
  const user = createTestUserDO({ durableObjectId: OWNER });
  const owner = await testOwner();
  const names = ['ledger', 'drafts', 'archive'];

  for (const name of names) await user.userDO.registerWorkspace(owner, name);

  for (const name of names) await user.userDO.requestWorkspaceRemoval(owner, name, OWNER);

  const torn: number[] = [];

  for (const _ of names) {
    await user.userDO.alarm();
    torn.push(user.destroyedWorkspaces.length);
  }

  expect({ torn, destroyed: [...user.destroyedWorkspaces].sort(), jobs: user.db.query<{ id: string }, []>("SELECT id FROM cf_agents_jobs WHERE id LIKE 'workspace-deletion:%'").all() })
    .toEqual({ torn: [1, 2, 3], destroyed: ['archive', 'drafts', 'ledger'], jobs: [] });
});

// An account's delete writes its intent and every workspace's mark in one transaction, so a reset at any later point
// leaves an account the next activation finishes: each workspace, then the account (review, 2026-10-25: a reset between
// per-workspace marks left one unmarked, and the account's job would never run).
test("an account's delete reset after its write is finished by the next activation, every workspace and then itself", async () => {
  const storage = new Database(':memory:');
  // The deployment's sign-in directory answers beside the account; it has no share recipients here.
  const account = () => createTestUserDO({ durableObjectId: OWNER, storage, accounts: (id) => { throw new Error(`no share recipient ${id}`); } });
  const first = account();
  const owner = await testOwner();

  for (const name of ['ledger', 'drafts']) await first.userDO.registerWorkspace(owner, name);

  expect(await first.userDO.deleteAccount(owner, OWNER)).toEqual({ ok: true, workspaces: 2 });
  // The first activation ends here, none of its jobs run: the answer came with nothing torn down.
  expect({ destroyed: first.destroyedWorkspaces, marked: first.db.query<{ name: string }, []>('SELECT name FROM user_workspaces WHERE delete_pending = 1 ORDER BY name').all() })
    .toEqual({ destroyed: [], marked: [{ name: 'drafts' }, { name: 'ledger' }] });

  const second = account();

  // An alarm a workspace, one for the account's clearing, one that destroys it; its abort comes a tick after.
  for (let lap = 0; lap < 4 && second.accountDeleted.length < 2; lap += 1) await second.userDO.alarm();
  await second.userDO.alarm();
  await second.abortRaised();

  expect({ destroyed: [...second.destroyedWorkspaces].sort(), reached: [...second.accountDeleted].sort(), aborted: second.aborted })
    .toEqual({ destroyed: ['drafts', 'ledger'], reached: [`mailbox:${OWNER}`, `sign-in:${OWNER}`], aborted: ['destroyed'] });
});

// A workspace still holds its capability while its account is being deleted. One it hires then would be a row the delete
// never marked, so the account's job would wait on it forever and the person could never sign in again (review,
// 2026-10-25). The account admits nothing new once its deletion is marked, and the deletion still lands.
test("a workspace that hires another while its account is being deleted is refused, and the deletion lands", async () => {
  const harness = createTestUserDO({ durableObjectId: OWNER, accounts: (id) => { throw new Error(`no share recipient ${id}`); } });
  const owner = await testOwner();
  const live = { workspaceToken: await provisionTestWorkspace(harness, 'ledger', 'Ledger') };

  expect(await harness.userDO.deleteAccount(owner, OWNER)).toEqual({ ok: true, workspaces: 1 });

  const hired = await Promise.allSettled([
    harness.userDO.registerWorkspace(live, 'ledger-helper'),
    harness.userDO.reserveWorkspace(live, 'ledger-fork', 'Ledger fork'),
  ]);

  expect(hired.map((each) => (each.status === 'rejected' ? renderThrownChain({ cause: each.reason }) : 'admitted')))
    .toEqual([expect.stringContaining('This account is being deleted.'), expect.stringContaining('This account is being deleted.')]);

  for (let lap = 0; lap < 4 && harness.accountDeleted.length < 2; lap += 1) await harness.userDO.alarm();
  await harness.userDO.alarm();
  await harness.abortRaised();

  expect({ destroyed: harness.destroyedWorkspaces, aborted: harness.aborted }).toEqual({ destroyed: ['ledger'], aborted: ['destroyed'] });
});
