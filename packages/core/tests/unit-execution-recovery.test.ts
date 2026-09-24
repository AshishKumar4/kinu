/**
 * Execution-recovery findings (evolution/recovery.ts) driven as production drives
 * them. Fails if findings stop being recorded at observation, stop being injectable
 * mid-turn, or leak into MEMORY.md corroboration or the corroborated-only export.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AgentOrchestrator } from '../src/orchestrator/agent-orchestrator';
import { closeTurnRun } from '../src/orchestrator/turn-lifecycle';
import { EvolutionEngine } from '../src/evolution/engine';
import type { EvolutionEvent } from '../src/evolution/types';
import {
  MAX_RECOVERY_FINDINGS, listRecoveryFindings, recordRecoveryFinding, recoveryFindingText,
  type RecoveryFinding,
} from '../src/evolution/recovery';
import {
  corroborateLessonsForTurn, initTurnOutcomeTables, listLessons,
} from '../src/evolution/outcomes';
import { composePrepareStep } from '../src/prompting/prepare-step';
import {
  DynamicContextLedger, agentDynamicContext, renderDynamicContextBlock,
} from '../src/prompting/volatile-context';
import type { BackendHost } from '../src/types/backend-host';
import { EventLog } from '../src/events/hub/log';
import { initEventsHubTables } from '../src/events/hub/schema';
import type { RunEventInput } from '../src/events/types';
import { createTestRuntime, makeExecRaw, makeSql, makeSqlExec } from './helpers';
import { createTestActors, unobservedSpend } from '@kinu.run/test-utils';

function finding(overrides: Partial<RecoveryFinding> = {}): RecoveryFinding {
  return {
    tool: 'shell',
    failures: 3,
    failedArgs: '{"command":"npm test"}',
    succeededArgs: '{"command":"bun test"}',
    failedSignature: 'run abc123',
    ...overrides,
  };
}

/** One actor threaded through both halves: under a mismatched handle an empty window
 *  looks like "no findings yet". */
function ledgerDb() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initTurnOutcomeTables(execRaw);
  const actors = createTestActors(sql, execRaw);

  return { sql, db, actor: actors.main, sibling: (name: string) => actors.sibling(name) };
}

describe('the ledger', () => {
  test('a finding lands as a provisional lesson bound to no turn, and reads back newest first', () => {
    const { sql, actor } = ledgerDb();
    expect(recordRecoveryFinding(sql, actor, finding(), 1_000)).toBe(true);
    expect(recordRecoveryFinding(sql, actor, finding({ tool: 'web_fetch', failedSignature: 'web_fetch d4' }), 2_000)).toBe(true);

    expect(listRecoveryFindings(sql, actor)).toEqual([
      recoveryFindingText(finding({ tool: 'web_fetch', failedSignature: 'web_fetch d4' })),
      recoveryFindingText(finding()),
    ]);
    const rows = listLessons(sql, actor, { source: 'execution_recovery' });
    expect(rows.every((r) => r.status === 'provisional' && r.turnIds.length === 0)).toBe(true);
  });

  test('a finding already inside the injection window is not recorded twice', () => {
    const { sql, actor } = ledgerDb();
    expect(recordRecoveryFinding(sql, actor, finding())).toBe(true);
    expect(recordRecoveryFinding(sql, actor, finding())).toBe(false);
    expect(listLessons(sql, actor, { source: 'execution_recovery' })).toHaveLength(1);
  });

  test('a finding that recurred after falling out of the window records again — the recurrence is signal', () => {
    const { sql, actor } = ledgerDb();
    expect(recordRecoveryFinding(sql, actor, finding(), 1_000)).toBe(true);

    for (let i = 0; i < MAX_RECOVERY_FINDINGS; i++) {
      expect(recordRecoveryFinding(sql, actor, finding({ tool: `tool_${i}` }), 2_000 + i)).toBe(true);
    }

    expect(listRecoveryFindings(sql, actor)).not.toContain(recoveryFindingText(finding()));
    expect(recordRecoveryFinding(sql, actor, finding(), 9_000)).toBe(true);
    expect(listRecoveryFindings(sql, actor)[0]).toBe(recoveryFindingText(finding()));
  });

  test('the injection window is bounded at MAX_RECOVERY_FINDINGS', () => {
    const { sql, actor } = ledgerDb();

    for (let i = 0; i < MAX_RECOVERY_FINDINGS + 3; i++) {
      recordRecoveryFinding(sql, actor, finding({ tool: `tool_${i}` }), 1_000 + i);
    }

    expect(listRecoveryFindings(sql, actor)).toHaveLength(MAX_RECOVERY_FINDINGS);
  });

  test('corroboration can never touch a finding: bound to no turn, it stays provisional forever', () => {
    const { sql, actor } = ledgerDb();
    recordRecoveryFinding(sql, actor, finding());
    expect(corroborateLessonsForTurn(sql, actor, 'turn-1')).toEqual([]);
    expect(listLessons(sql, actor, { source: 'execution_recovery' })[0].status).toBe('provisional');
  });

  test('an empty ledger reads as empty, never as a throw', () => {
    const { sql, actor } = ledgerDb();
    expect(listRecoveryFindings(sql, actor)).toEqual([]);
  });

  test("a sibling actor's window is EMPTY, and its own finding does not widen ours", () => {
    // Two real actors on one database: neither's finding reaches the other's next step.
    const { sql, actor, sibling } = ledgerDb();
    const other = sibling('peer');
    expect(recordRecoveryFinding(sql, actor, finding(), 1_000)).toBe(true);

    expect(listRecoveryFindings(sql, actor)).toEqual([recoveryFindingText(finding())]);
    expect(listRecoveryFindings(sql, other)).toEqual([]);

    // The dedupe window is per actor too.
    expect(recordRecoveryFinding(sql, other, finding(), 2_000)).toBe(true);
    expect(listRecoveryFindings(sql, actor)).toHaveLength(1);
    expect(listRecoveryFindings(sql, other)).toHaveLength(1);
  });
});

const host: BackendHost = {
  broadcast: () => {},
  enqueueTurn: async () => ({ status: 'queued' }),
  turnInFlight: () => false,
  setTimer: () => {},
};

/** A real handle, since the log stamps every row with its `actorId`. */
function eventLog(): EventLog {
  const db = new Database(':memory:');
  const exec = makeSqlExec(db);
  initEventsHubTables(exec);

  return new EventLog(exec, createTestActors(makeSql(db), makeExecRaw(db)).main);
}

/** Distinct failing calls, then one changed call that runs clean. */
async function grindThenRecover(orch: AgentOrchestrator): Promise<void> {
  const extension = orch.turnExtension;

  if (!extension.onToolResult) throw new Error('Expected an onToolResult extension');

  for (let attempt = 0; attempt < 3; attempt++) {
    await extension.onToolResult({
      toolName: 'shell', args: { command: 'npm test', attempt }, result: 'Error (exit 1): npm not found',
      success: false, reason: 'io', execution: { exitCode: 1 },
    });
  }

  await extension.onToolResult({
    toolName: 'shell', args: { command: 'bun test' }, result: '12 tests passed', success: true,
  });
}

describe('the loop, through the production seams', () => {
  test('a recovery observed mid-turn is durable immediately and injectable on the very next step', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend });
    const events: EvolutionEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });

    orch.beginTurn(Date.now());
    await grindThenRecover(orch);

    // Durable at observation; no turn boundary crossed.
    const injectable = listRecoveryFindings(rt.storage.sql, rt.actor);
    expect(injectable).toHaveLength(1);
    expect(injectable[0]).toContain('`shell` failed 3x in a row');
    expect(injectable[0]).toContain('npm test');
    expect(injectable[0]).toContain('bun test');

    // The engine narrated it once.
    expect(events.filter((e) => e.message.startsWith('[execution recovery]'))).toHaveLength(1);

    // The per-step snapshot carries the finding into the dynamic-context block.
    const block = renderDynamicContextBlock(agentDynamicContext({
      factsBlock: undefined,
      memoryTail: undefined,
      recoveryFindings: injectable,
      executors: [],
      runningJobs: { items: [], total: 0 },
      openTasks: { items: [], total: 0 },
      liveHeadRuns: { items: [], total: 0 },
      missingCapabilities: [],
    }));

    if (!block) throw new Error('Expected an execution recovery context block');
    expect(block).toContain('## Proven by execution');
    expect(block).toContain('bun test');

    // The turn's run record names the streak.
    const snapshot = orch.recoverySnapshot();
    expect(snapshot?.recoveries).toHaveLength(1);
    expect(snapshot?.recoveries[0]).toMatchObject({ tool: 'shell', failures: 3 });
    expect(snapshot?.recoveries[0]?.failedSignature).toMatch(/^shell/);
  });

  test('a finding recorded between two steps reaches the NEXT step\'s request — the episode improves while running', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend });
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });
    // The per-step pipeline as both backends wire it.
    const ledger = new DynamicContextLedger();

    const step = async (stepNumber: number) => composePrepareStep({
      dynamic: {
        ledger,
        snapshot: () => agentDynamicContext({
          factsBlock: undefined,
          memoryTail: undefined,
          recoveryFindings: listRecoveryFindings(rt.storage.sql, rt.actor),
          executors: [],
          runningJobs: { items: [], total: 0 },
          openTasks: { items: [], total: 0 },
          liveHeadRuns: { items: [], total: 0 },
          missingCapabilities: [],
        }),
      },
    }, { stepNumber, messages: [{ role: 'user', content: 'fix the build' }], steps: [] });

    orch.beginTurn(Date.now());
    const before = await step(0);
    expect(JSON.stringify(before?.messages ?? [])).not.toContain('Proven by execution');

    await grindThenRecover(orch);
    const after = await step(1);
    const rendered = JSON.stringify(after?.messages ?? []);
    expect(rendered).toContain('Proven by execution');
    expect(rendered).toContain('bun test');
  });

  test('the same finding twice in one episode is one row and one run-event entry per turn', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend });
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });

    orch.beginTurn(Date.now());
    // Sequential: both calls drive one orchestrator's streak counter.
    await grindThenRecover(orch);
    await grindThenRecover(orch);
    expect(listRecoveryFindings(rt.storage.sql, rt.actor)).toHaveLength(1);
    // Both observations are real streaks; the run event counts both.
    expect(orch.recoverySnapshot()?.recoveries).toHaveLength(2);
  });

  test('with auto-evolution off, nothing is recorded at all — the bench arm measures the loop\'s absence', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend, enabled: false });
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });

    orch.beginTurn(Date.now());
    await grindThenRecover(orch);
    expect(listRecoveryFindings(rt.storage.sql, rt.actor)).toEqual([]);
    expect(orch.recoverySnapshot()).toBeNull();
  });

  test('the turn boundary clears the run record but never the ledger', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend });
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });

    orch.beginTurn(Date.now());
    await grindThenRecover(orch);
    orch.beginTurn(Date.now());
    expect(orch.recoverySnapshot()).toBeNull();
    expect(listRecoveryFindings(rt.storage.sql, rt.actor)).toHaveLength(1);
  });
});

describe('the run event', () => {
  test('closeTurnRun writes one execution_recovery row when a streak broke, and none otherwise', () => {
    const emitted: Array<{ runId: string; input: RunEventInput }> = [];
    const recorder = { emit: (runId: string, input: RunEventInput) => { emitted.push({ runId, input }); } };

    closeTurnRun(recorder, 'run-1', {
      turnIndex: 0, usage: { input: 1, output: 1 }, reason: 'completed',
      recoveries: { recoveries: [{ tool: 'shell', failures: 3, failedSignature: 'run abc' }] },
    });
    closeTurnRun(recorder, 'run-2', {
      turnIndex: 1, usage: { input: 1, output: 1 }, reason: 'completed',
      recoveries: null,
    });

    const rows = emitted.filter((e) => e.input.type === 'execution_recovery');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      runId: 'run-1',
      input: { type: 'execution_recovery', recoveries: [{ tool: 'shell', failures: 3, failedSignature: 'run abc' }] },
    });
  });
});
