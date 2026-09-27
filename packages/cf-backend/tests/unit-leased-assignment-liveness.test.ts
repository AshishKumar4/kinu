/**
 * An assignment a dead activation had leased is owed work of the next one. The drain leases a row
 * (`markConsumed`) before its turn admits a claim, so a reset in between left a row that no wake predicate
 * matched: not pending (it holds a turn id), no claim, and the activation owed nothing, so the turn stalled until
 * something unrelated woke the workspace (HardenDurable P1; kinu-logs/onstart/DESIGN.md S2).
 */
import { expect, test } from 'bun:test';
import { admitSubordinateTask, EventLog } from '@kinu.run/core';
import { makeSqlExec } from '../../core/tests/helpers';
import {
  GATEWAY_CATALOG, gatewayWorkspace, hostedSubordinateHarness, reactivateOrchestratorHarness, until,
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
