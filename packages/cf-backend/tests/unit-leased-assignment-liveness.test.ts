/**
 * An assignment a dead activation had leased is owed work of the next one. The drain leases a row
 * (`markConsumed`) before its turn admits a claim, so a reset in between left a row that no wake predicate
 * matched: not pending (it holds a turn id), no claim, and the activation owed nothing, so the turn stalled until
 * something unrelated woke the workspace (HardenDurable P1; kinu-logs/onstart/DESIGN.md S2).
 */
import { expect, test } from 'bun:test';
import type { SQLQueryBindings } from 'bun:sqlite';
import { admitSubordinateTask, EventLog } from '@kinu.run/core';
import { makeSqlExec } from '../../core/tests/helpers';
import {
  GATEWAY_CATALOG, gatewayWorkspace, hostedSubordinateHarness, reactivateOrchestratorHarness, rosterOver, runDelegatedTask, until,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { answeringGateway, openingOf } from './helpers/platform-gateway';

const BRIEF = 'Summarise the release notes.';

test('an assignment leased by a dead activation runs after the next activation, with nothing else arriving', async () => {
  const gateway = answeringGateway('summarised');
  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'summariser', displayName: 'Summariser', nameOrigin: 'user', mission: 'summarise',
  });

  // What a reset leaves between the lease and the claim: the row leased one minute ago, no claim, no run.
  const log = new EventLog(makeSqlExec(workspace.db), child.actor.handle);
  const admitted = admitSubordinateTask(log, { fromWorkspace: child.actor.handle.workspaceId, kind: 'task', body: BRIEF, mode: 'build', now: Date.now() });
  log.markConsumed(admitted.id, 'evt-dead-activation', 0, Date.now() - 60_000);

  // The next activation, reached by one call and nothing else.
  const next = await reactivateOrchestratorHarness(workspace.db, undefined, {
    world: { aiGateway: gateway },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  await next.agent.accountSpend();
  await until(() => workspace.db.query("SELECT 1 FROM cf_agents_schedules WHERE callback = '_kinuTerminalRetryTick'").get() !== null,
    'the activation armed a wake for the leased assignment');
  await next.agent.terminalRetryPass();
  await joinHarnessFibers();

  expect(gateway.runs.some((run) => openingOf(run).includes(BRIEF))).toBe(true);
});

/** A task hire's turn run to its report, then its lease put back as a reset before `markTurnCompleted` leaves it. */
async function finishedThenCutOff(options: { reportLost: boolean }) {
  const gateway = answeringGateway('summarised');
  const workspace = gatewayWorkspace(gateway);

  const child = await workspace.agent.actorDirectory({
    action: 'register', creationId: 'finished-proof', name: 'summariser', kind: 'subordinate', lifetime: 'task',
  });

  rosterOver(workspace.db).create({
    name: 'summariser', actorReference: child.reference, birth: null, deleteRequested: false, createdBy: 'orchestrator',
    status: 'working', currentTask: BRIEF, createdAt: Date.now(), dismissedAt: null, lifetime: 'task', taskEventId: null,
  });
  const actorId = child.reference.actorId;
  const rosterBefore = workspace.db.query<Record<string, SQLQueryBindings>, []>('SELECT * FROM actor_subordinates').all();

  await runDelegatedTask(workspace, actorId, BRIEF);

  const reports = () => workspace.db.query(`SELECT 1 FROM agent_log WHERE variant = 'subordinate_report'
    AND dedupe_key = (SELECT 'subordinate_report:' || id FROM agent_log WHERE actor_id = ? AND variant = 'subordinate_task')`).all(actorId).length;

  expect(reports()).toBe(1);

  // The relay is one transaction: the report on the rail and the roster it updates. A reset before it commits keeps neither.
  if (options.reportLost) {
    workspace.db.query(`DELETE FROM agent_log WHERE variant = 'subordinate_report'`).run();
    workspace.db.query('DELETE FROM actor_subordinates').run();

    for (const row of rosterBefore) {
      const columns = Object.keys(row);

      workspace.db.query(`INSERT INTO actor_subordinates (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => row[column] ?? null));
    }
  }

  workspace.db.query(`UPDATE agent_log SET turn_id = 'evt-dead-activation', consumed_at = ?
    WHERE actor_id = ? AND variant = 'subordinate_task'`).run(Date.now() - 60_000, actorId);

  const next = await reactivateOrchestratorHarness(workspace.db, undefined, {
    world: { aiGateway: gateway },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  await next.agent.accountSpend();
  await next.agent.terminalRetryPass();
  await joinHarnessFibers();

  const leaseOpen = workspace.db.query(`SELECT 1 FROM agent_log WHERE actor_id = ? AND variant = 'subordinate_task'
    AND consumed_at IS NOT NULL`).all(actorId).length > 0;

  return { asked: gateway.runs.filter((run) => openingOf(run).includes(BRIEF)).length, reports: reports(), leaseOpen };
}

test.each([
  { reportLost: false, asked: 1, case: 'a turn whose report reached its parent before the reset is not run again' },
  { reportLost: true, asked: 2, case: 'a turn cut off before its report reached the parent runs again, and the parent gets one report' },
])('$case', async ({ reportLost, asked }) => {
  expect(await finishedThenCutOff({ reportLost })).toEqual({ asked, reports: 1, leaseOpen: false });
});
