/**
 * An assignment a dead activation had leased is owed work of the next one. The drain leases a row
 * (`markConsumed`) before its turn admits a claim, so a reset in between left a row that no wake predicate
 * matched: not pending (it holds a turn id), no claim, and the activation owed nothing, so the turn stalled until
 * something unrelated woke the workspace (HardenDurable P1; kinu-logs/onstart/DESIGN.md S2).
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import type { SQLQueryBindings } from 'bun:sqlite';
import { admitSubordinateTask, EventLog, TERMINAL_EFFECT_RETRY_BASE_MS, WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { AwaitedList } from '@kinu.run/test-utils';
import { makeSqlExec } from '../../core/tests/helpers';
import {
  agentSql, armedWakes, catalogTurn, GATEWAY_CATALOG, gatewayWorkspace, hostedSubordinateHarness, nextTurn, reactivateOrchestratorHarness, rosterOver, runDelegatedTask, until,
  wakeForDelegatedTask,
} from './helpers/actor-harness';
import { TERMINAL_RETRY_JOB } from '../src/wake-jobs';
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
  await until(() => armedWakes(workspace.db).some((wake) => wake.id === TERMINAL_RETRY_JOB),
    'the activation armed a wake for the leased assignment');
  await next.agent.terminalRetryPass();
  await joinHarnessFibers();

  expect(gateway.runs.some((run) => openingOf(run).includes(BRIEF))).toBe(true);
});

type Lifetime = 'task' | 'durable';

/** A hire of `lifetime` on the root's roster, as the `agents` tool hires one. */
async function hire(workspace: ReturnType<typeof gatewayWorkspace>, lifetime: Lifetime, origin: 'agent' | 'evolution' = 'agent'): Promise<string> {
  const child = await workspace.agent.actorDirectory({
    action: 'register', creationId: `hire-${lifetime}`, name: 'summariser', origin, lifetime,
  });

  rosterOver(workspace.db).create({
    name: 'summariser', actorReference: child.reference, birth: null, deleteRequested: false,
    status: 'working', currentTask: BRIEF, createdAt: Date.now(), dismissedAt: null, taskEventId: null,
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

/** The assignment's turns the model was asked for; the agent naming itself after its brief is not one. */
const asked = (gateway: StubbedAiBinding): number => gateway.runs
  .filter((run) => openingOf(run).includes(BRIEF) && !JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)).length;

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
  // The hire's turn claim is in its own database.
  expect(agentSql(actorId)<{ settled: number }>`
    SELECT outcome IS NOT NULL AS settled FROM actor_turn_claims WHERE actor_id = ${actorId}`).toEqual([{ settled: 1 }]);
});

test('an evolution helper whose answer was stored for its lane is not run again after a reset', async () => {
  const gateway = answeringGateway('summarised');
  const workspace = gatewayWorkspace(gateway);
  const actorId = await hire(workspace, 'task', 'evolution');

  // A refiner's answer goes to its lane's durable inbox, never the root's rail.
  rosterOver(workspace.db).helpers.record('summariser', { requestId: 'refine-1' }, Date.now());

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

afterEach(() => { setSystemTime(); });

// The report is the agent's own owed effect: a reset that rolls back the relay's commit leaves it owed in the agent's
// ledger, and the agent's next wake delivers it. The relay's commit is aborted where it writes the report.
test('a report a reset rolled back before it reached the parent reaches it once, and the turn does not run again', async () => {
  const gateway = answeringGateway('summarised');
  const workspace = gatewayWorkspace(gateway);
  const actorId = await hire(workspace, 'task');

  const reports = () => workspace.db.query(`SELECT 1 FROM agent_log WHERE variant = 'subordinate_report'
    AND dedupe_key = (SELECT 'subordinate_report:' || id FROM agent_log WHERE actor_id = ? AND variant = 'subordinate_task')`).all(actorId).length;

  workspace.db.run(`CREATE TRIGGER reset_mid_relay BEFORE INSERT ON agent_log WHEN NEW.variant = 'subordinate_report'
    BEGIN SELECT RAISE(ABORT, 'the workspace reset mid-relay'); END`);
  await runDelegatedTask(workspace, actorId, BRIEF);
  expect(reports()).toBe(0);
  workspace.db.run('DROP TRIGGER reset_mid_relay');

  // The reset takes the agent's isolate with it; its ledger is on disk.
  workspace.agent.harnessResetAgentIsolate(workspace.agent.agentOf(actorId).storageKey);
  abandonHarnessFibers();
  setSystemTime(new Date(Date.now() + TERMINAL_EFFECT_RETRY_BASE_MS + 1));
  await nextActivation(workspace, gateway);
  await until(() => reports() === 1, 'the owed report reached the parent');

  const leaseOpen = workspace.db.query(`SELECT 1 FROM agent_log WHERE actor_id = ? AND variant = 'subordinate_task'
    AND consumed_at IS NOT NULL`).all(actorId).length > 0;

  expect({ asked: asked(gateway), reports: reports(), leaseOpen }).toEqual({ asked: 1, reports: 1, leaseOpen: false });
});
