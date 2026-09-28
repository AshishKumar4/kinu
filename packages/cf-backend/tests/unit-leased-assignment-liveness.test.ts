/**
 * An assignment a dead activation had leased is owed work of the next one. The drain leases a row
 * (`markConsumed`) before its turn admits a claim, so a reset in between left a row that no wake predicate
 * matched: not pending (it holds a turn id), no claim, and the activation owed nothing, so the turn stalled until
 * something unrelated woke the workspace (HardenDurable P1; kinu-logs/onstart/DESIGN.md S2).
 */
import { expect, test } from 'bun:test';
import type { SQLQueryBindings } from 'bun:sqlite';
import { admitSubordinateTask, EventLog } from '@kinu.run/core';
import { AwaitedList } from '@kinu.run/test-utils';
import { makeSqlExec } from '../../core/tests/helpers';
import {
  catalogTurn, GATEWAY_CATALOG, gatewayWorkspace, nextTurn, hostedSubordinateHarness, reactivateOrchestratorHarness, rosterOver, runDelegatedTask, until,
  wakeForDelegatedTask,
} from './helpers/actor-harness';
import { abandonHarnessFibers, joinHarnessFibers } from './helpers/agents-sdk';
import {
  answeringGateway, chatCompletion, openingOf, requestOf, scriptedGateway, stubAiBinding, toolCallCompletion, type StubbedAiBinding,
} from './helpers/platform-gateway';

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

type Lifetime = 'task' | 'durable';

/** A hire of `lifetime` on the root's roster, as the `agents` tool hires one. */
async function hire(workspace: ReturnType<typeof gatewayWorkspace>, lifetime: Lifetime): Promise<string> {
  const child = await workspace.agent.actorDirectory({
    action: 'register', creationId: `hire-${lifetime}`, name: 'summariser', kind: 'subordinate', lifetime,
  });

  rosterOver(workspace.db).create({
    name: 'summariser', actorReference: child.reference, birth: null, deleteRequested: false, createdBy: 'orchestrator',
    status: 'working', currentTask: BRIEF, createdAt: Date.now(), dismissedAt: null, lifetime, taskEventId: null,
  });

  return child.reference.actorId;
}

/** The next activation over the same rows, reached by one call, and everything it starts. */
async function nextActivation(workspace: ReturnType<typeof gatewayWorkspace>, gateway: StubbedAiBinding): Promise<void> {
  const next = await reactivateOrchestratorHarness(workspace.db, undefined, {
    world: { aiGateway: gateway },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  await next.agent.accountSpend();
  await next.agent.terminalRetryPass();
  await joinHarnessFibers();
}

const asked = (gateway: StubbedAiBinding): number => gateway.runs.filter((run) => openingOf(run).includes(BRIEF)).length;

/**
 * A turn run to its end under a reset that lands after the answer's delivery and before the drain's own completion
 * mark: the mark never lands. The next activation must not ask the model again.
 */
async function answeredThenCutOff(lifetime: Lifetime, gateway: StubbedAiBinding): Promise<{ first: number; again: number }> {
  const workspace = gatewayWorkspace(gateway);
  const actorId = await hire(workspace, lifetime);
  const mark = Object.getOwnPropertyDescriptor(EventLog.prototype, 'markTurnCompleted');

  Object.defineProperty(EventLog.prototype, 'markTurnCompleted', { configurable: true, value: () => undefined });

  try {
    await runDelegatedTask(workspace, actorId, BRIEF);
  } finally {
    if (mark) Object.defineProperty(EventLog.prototype, 'markTurnCompleted', mark);
  }

  const first = asked(gateway);

  await nextActivation(workspace, gateway);

  return { first, again: asked(gateway) - first };
}

test.each([
  { path: 'the turn-end relay', lifetime: 'task' as const, calls: [] },
  { path: 'a durable hire whose turn relays nothing at its end', lifetime: 'durable' as const, calls: [{ tool: 'report', args: { status: 'progress', content: 'halfway' } }] },
  { path: 'the report tool', lifetime: 'task' as const, calls: [{ tool: 'report', args: { status: 'completed', content: 'summarised' } }] },
])('an assignment answered through $path is not run again after a reset', async ({ lifetime, calls }) => {
  const { first, again } = await answeredThenCutOff(lifetime, scriptedGateway(calls, 'summarised'));

  expect(first).toBe(calls.length + 1);
  expect(again).toBe(0);
});

test('a turn cut off after its report-tool answer, mid-turn, is not run again and its claim settles', async () => {
  let cut = true;
  const parked = new AwaitedList<true>();

  // The answer, then a step the reset ends: its model call never returns in the first activation.
  const gateway = stubAiBinding((run) => {
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    if (step === 0) return toolCallCompletion(run, { tool: 'report', args: { status: 'completed', content: 'summarised' } }, 'call_0');

    if (!cut) return chatCompletion(run, 'summarised');
    parked.push(true);

    return new Promise<Response>(() => {});
  });

  const workspace = gatewayWorkspace(gateway);
  const actorId = await hire(workspace, 'task');

  await wakeForDelegatedTask(workspace, actorId, BRIEF);
  await parked.until((seen) => seen.length === 1);
  const first = asked(gateway);

  abandonHarnessFibers();
  cut = false;
  await nextActivation(workspace, gateway);

  expect(asked(gateway) - first).toBe(0);
  expect(workspace.db.query(`SELECT outcome IS NOT NULL AS settled FROM actor_turn_claims WHERE actor_id = ?`).all(actorId)).toEqual([{ settled: 1 }]);
});

test('an evolution helper whose answer was stored for its lane is not run again after a reset', async () => {
  const gateway = answeringGateway('summarised');
  const workspace = gatewayWorkspace(gateway);
  const actorId = await hire(workspace, 'task');

  // A refiner's answer goes to its lane's durable inbox, never the root's rail.
  rosterOver(workspace.db).helpers.record('summariser', { requestId: 'refine-1' }, Date.now());
  workspace.db.run(`UPDATE actor_subordinates SET created_by = 'evolution' WHERE name = 'summariser'`);

  const mark = Object.getOwnPropertyDescriptor(EventLog.prototype, 'markTurnCompleted');

  Object.defineProperty(EventLog.prototype, 'markTurnCompleted', { configurable: true, value: () => undefined });

  try {
    await runDelegatedTask(workspace, actorId, BRIEF);
  } finally {
    if (mark) Object.defineProperty(EventLog.prototype, 'markTurnCompleted', mark);
  }

  const first = asked(gateway);

  expect(rosterOver(workspace.db).helpers.answerFor({ requestId: 'refine-1' })).toMatchObject({ state: 'answered' });
  await nextActivation(workspace, gateway);
  expect(asked(gateway) - first).toBe(0);
});

type Snapshot = readonly { readonly table: string; readonly rows: Record<string, SQLQueryBindings>[] }[];

/** Whole tables as they stand, to put back as a reset that rolled back every later write would leave them. */
function snapshot(workspace: ReturnType<typeof gatewayWorkspace>, tables: readonly string[]): Snapshot {
  return tables.map((table) => ({ table, rows: workspace.db.query<Record<string, SQLQueryBindings>, []>(`SELECT * FROM ${table}`).all() }));
}

function restore(workspace: ReturnType<typeof gatewayWorkspace>, tables: Snapshot): void {
  for (const { table, rows } of tables) {
    workspace.db.query(`DELETE FROM ${table}`).run();

    for (const row of rows) {
      const columns = Object.keys(row);

      workspace.db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => row[column] ?? null));
    }
  }
}

/** The hire's assignment row, once the parent's `agents` call has written it; that call spawns across macrotasks. */
async function assigned(workspace: ReturnType<typeof gatewayWorkspace>): Promise<void> {
  while (workspace.db.query(`SELECT 1 FROM agent_log WHERE variant = 'subordinate_task'`).get() === null) {
    await nextTurn();
  }
}

test('a task hire whose answer settled its waiting hirer is not run again after a reset', async () => {
  // The root hires a task agent; the hire answers at its turn's end.
  const gateway = stubAiBinding((run) => {
    if (openingOf(run).includes(BRIEF)) return chatCompletion(run, 'summarised');
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    return step === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'task', lifetime: 'task', mission: BRIEF } }, 'hire_0')
      : chatCompletion(run, 'Done.');
  });

  const workspace = gatewayWorkspace(gateway);
  const mark = Object.getOwnPropertyDescriptor(EventLog.prototype, 'markTurnCompleted');
  let beforeRelease: Snapshot = [];

  Object.defineProperty(EventLog.prototype, 'markTurnCompleted', { configurable: true, value: () => undefined });

  try {
    const turn = catalogTurn(workspace.agent, 'Have a task agent summarise the release notes.');

    await assigned(workspace);
    beforeRelease = snapshot(workspace, ['workspace_actors', 'actor_subordinates']);
    await workspace.agent.terminalRetryPass();
    await turn;
    await joinHarnessFibers();
  } finally {
    if (mark) Object.defineProperty(EventLog.prototype, 'markTurnCompleted', mark);
  }

  // The reset lands after the answer was held and before the hire was archived and retired.
  restore(workspace, beforeRelease);

  const first = asked(gateway);

  expect(first).toBe(1);
  await nextActivation(workspace, gateway);
  expect(asked(gateway) - first).toBe(0);
});

/** The relay's transaction rolled back by a reset: no report on the rail, the roster and the actor as before it, the lease open. */
async function reportLostToReset(): Promise<{ asked: number; reports: number; leaseOpen: boolean }> {
  const gateway = answeringGateway('summarised');
  const workspace = gatewayWorkspace(gateway);
  const actorId = await hire(workspace, 'task');
  // A task agent retires only after its report is held, so a reset that lost the report lost the retire too.
  const rosterBefore = snapshot(workspace, ['actor_subordinates', 'workspace_actors']);

  await runDelegatedTask(workspace, actorId, BRIEF);

  const reports = () => workspace.db.query(`SELECT 1 FROM agent_log WHERE variant = 'subordinate_report'
    AND dedupe_key = (SELECT 'subordinate_report:' || id FROM agent_log WHERE actor_id = ? AND variant = 'subordinate_task')`).all(actorId).length;

  expect(reports()).toBe(1);

  workspace.db.query(`DELETE FROM agent_log WHERE variant = 'subordinate_report'`).run();
  restore(workspace, rosterBefore);

  workspace.db.query(`UPDATE agent_log SET turn_id = 'evt-dead-activation', consumed_at = ?
    WHERE actor_id = ? AND variant = 'subordinate_task'`).run(Date.now() - 60_000, actorId);

  await nextActivation(workspace, gateway);

  const leaseOpen = workspace.db.query(`SELECT 1 FROM agent_log WHERE actor_id = ? AND variant = 'subordinate_task'
    AND consumed_at IS NOT NULL`).all(actorId).length > 0;

  return { asked: asked(gateway), reports: reports(), leaseOpen };
}

test('a turn cut off before its report reached the parent runs again, and the parent gets one report', async () => {
  expect(await reportLostToReset()).toEqual({ asked: 2, reports: 1, leaseOpen: false });
});
