/**
 * Execution-recovery findings (evolution/recovery.ts) — the step clock's
 * knowledge channel, driven exactly as production drives it: the
 * orchestrator's turn extension observes tool results, the engine's ledger
 * takes the write, and the dynamic-context plane reads it back per step.
 *
 * These tests are the regression contract for the intra-episode loop: every
 * one of them fails if findings stop being recorded at the moment of
 * observation, stop being injectable mid-turn, or start leaking into surfaces
 * the ceiling forbids (MEMORY.md corroboration, the experience library's
 * corroborated-only export).
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
  corroborateLessonsForTurn, initTurnOutcomeTables, listLessons, recordLesson,
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

function finding(overrides: Partial<RecoveryFinding> = {}): RecoveryFinding {
  return {
    tool: 'run',
    failures: 3,
    failedArgs: '{"command":"npm test"}',
    succeededArgs: '{"command":"bun test"}',
    failedSignature: 'run abc123',
    ...overrides,
  };
}

function ledgerDb() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initTurnOutcomeTables(makeExecRaw(db), sql);
  return { sql, db };
}

describe('the ledger', () => {
  test('a finding lands as a provisional lesson bound to no turn, and reads back newest first', () => {
    const { sql } = ledgerDb();
    expect(recordRecoveryFinding(sql, finding(), 1_000)).toBe(true);
    expect(recordRecoveryFinding(sql, finding({ tool: 'web_fetch', failedSignature: 'web_fetch d4' }), 2_000)).toBe(true);

    expect(listRecoveryFindings(sql)).toEqual([
      recoveryFindingText(finding({ tool: 'web_fetch', failedSignature: 'web_fetch d4' })),
      recoveryFindingText(finding()),
    ]);
    const rows = listLessons(sql, { source: 'execution_recovery' });
    expect(rows.every((r) => r.status === 'provisional' && r.turnIds.length === 0)).toBe(true);
  });

  test('a finding already inside the injection window is not recorded twice', () => {
    const { sql } = ledgerDb();
    expect(recordRecoveryFinding(sql, finding())).toBe(true);
    expect(recordRecoveryFinding(sql, finding())).toBe(false);
    expect(listLessons(sql, { source: 'execution_recovery' })).toHaveLength(1);
  });

  test('a finding that recurred after falling out of the window records again — the recurrence is signal', () => {
    const { sql } = ledgerDb();
    expect(recordRecoveryFinding(sql, finding(), 1_000)).toBe(true);
    for (let i = 0; i < MAX_RECOVERY_FINDINGS; i++) {
      expect(recordRecoveryFinding(sql, finding({ tool: `tool_${i}` }), 2_000 + i)).toBe(true);
    }
    expect(listRecoveryFindings(sql)).not.toContain(recoveryFindingText(finding()));
    expect(recordRecoveryFinding(sql, finding(), 9_000)).toBe(true);
    expect(listRecoveryFindings(sql)[0]).toBe(recoveryFindingText(finding()));
  });

  test('the injection window is bounded at MAX_RECOVERY_FINDINGS', () => {
    const { sql } = ledgerDb();
    for (let i = 0; i < MAX_RECOVERY_FINDINGS + 3; i++) {
      recordRecoveryFinding(sql, finding({ tool: `tool_${i}` }), 1_000 + i);
    }
    expect(listRecoveryFindings(sql)).toHaveLength(MAX_RECOVERY_FINDINGS);
  });

  test('corroboration can never touch a finding: bound to no turn, it stays provisional forever', () => {
    const { sql } = ledgerDb();
    recordRecoveryFinding(sql, finding());
    expect(corroborateLessonsForTurn(sql, 'turn-1')).toEqual([]);
    expect(listLessons(sql, { source: 'execution_recovery' })[0]!.status).toBe('provisional');
  });

  test('an empty ledger reads as empty, never as a throw', () => {
    const { sql } = ledgerDb();
    expect(listRecoveryFindings(sql)).toEqual([]);
  });
});

describe('the CHECK widening', () => {
  test('a lessons table from before the execution_recovery source is rebuilt in place, rows kept', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    db.exec(`CREATE TABLE lessons (
      id TEXT PRIMARY KEY,
      turn_ids TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('turn_reflection','session_reflection')),
      status TEXT NOT NULL CHECK (status IN ('provisional','corroborated')),
      created_at INTEGER NOT NULL,
      corroborated_at INTEGER
    )`);
    recordLesson(sql, { turnIds: ['t1'], text: 'old lesson', source: 'turn_reflection', status: 'provisional' });
    // On the narrow table the new source is refused by the CHECK itself.
    expect(() => recordRecoveryFinding(sql, finding())).toThrow();

    initTurnOutcomeTables(makeExecRaw(db), sql);
    expect(recordRecoveryFinding(sql, finding())).toBe(true);
    const rows = listLessons(sql);
    expect(rows.map((r) => r.text)).toContain('old lesson');
    expect(rows.map((r) => r.source)).toContain('execution_recovery');
  });

  test('a crash mid-rebuild is finished by the next init — rows stranded in lessons_legacy come back', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initTurnOutcomeTables(makeExecRaw(db), sql);
    recordLesson(sql, { turnIds: [], text: 'stranded', source: 'session_reflection', status: 'provisional' });
    // The crash point: renamed away, replacement never created.
    db.exec(`ALTER TABLE lessons RENAME TO lessons_legacy`);

    initTurnOutcomeTables(makeExecRaw(db), sql);
    expect(listLessons(sql).map((r) => r.text)).toContain('stranded');
    expect(() => db.query('SELECT 1 FROM lessons_legacy').all()).toThrow();
  });
});

// ── the loop, through the production seams ─────────────────────────────────

const host: BackendHost = {
  broadcast: () => {},
  enqueueTurn: async () => ({ status: 'queued' }),
  turnInFlight: () => false,
  setTimer: () => {},
};

function eventLog(): EventLog {
  const sql = makeSqlExec(new Database(':memory:'));
  initEventsHubTables(sql);
  return new EventLog(sql);
}

/** Distinct failing calls, then one CHANGED call that runs clean — the shape
 *  the finding exists for. Driven through the same turn extension both
 *  backends register. */
async function grindThenRecover(orch: AgentOrchestrator): Promise<void> {
  const onToolResult = orch.turnExtension.onToolResult;
  if (!onToolResult) throw new Error('Expected an onToolResult extension');
  for (let attempt = 0; attempt < 3; attempt++) {
    await onToolResult({
      toolName: 'run', args: { command: 'npm test', attempt }, result: 'Error (exit 1): npm not found', success: true,
    });
  }
  await onToolResult({
    toolName: 'run', args: { command: 'bun test' }, result: '12 tests passed', success: true,
  });
}

describe('the loop, through the production seams', () => {
  test('a recovery observed mid-turn is durable immediately and injectable on the very next step', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    const events: EvolutionEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });

    orch.beginTurn(Date.now());
    await grindThenRecover(orch);

    // Durable at the moment of observation — no turn boundary was crossed.
    const injectable = listRecoveryFindings(rt.storage.sql);
    expect(injectable).toHaveLength(1);
    expect(injectable[0]).toContain('`run` failed 3x in a row');
    expect(injectable[0]).toContain('npm test');
    expect(injectable[0]).toContain('bun test');

    // The engine narrated it once.
    expect(events.filter((e) => e.message.startsWith('[execution recovery]'))).toHaveLength(1);

    // The injection half: the same per-step snapshot read both backends wire
    // carries the finding into the dynamic-context block.
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

    // The turn's run record names the streak for the measurement query.
    const snapshot = orch.recoverySnapshot();
    expect(snapshot?.recoveries).toHaveLength(1);
    expect(snapshot?.recoveries[0]).toMatchObject({ tool: 'run', failures: 3 });
    expect(snapshot?.recoveries[0]?.failedSignature).toMatch(/^run/);
  });

  test('a finding recorded between two steps reaches the NEXT step\'s request — the episode improves while running', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });
    // The per-step pipeline exactly as both backends wire it: the ledger lives
    // for the activation, the snapshot re-reads the lessons ledger per step.
    const ledger = new DynamicContextLedger();
    const step = async (stepNumber: number) => composePrepareStep({
      dynamic: {
        ledger,
        snapshot: () => agentDynamicContext({
          factsBlock: undefined,
          memoryTail: undefined,
          recoveryFindings: listRecoveryFindings(rt.storage.sql),
          executors: [],
          runningJobs: { items: [], total: 0 },
          openTasks: { items: [], total: 0 },
          liveHeadRuns: { items: [], total: 0 },
          missingCapabilities: [],
        }),
      },
    }, { stepNumber, messages: [{ role: 'user', content: 'fix the build' }] });

    orch.beginTurn(Date.now());
    const before = await step(0);
    expect(JSON.stringify(before?.messages ?? [])).not.toContain('Proven by execution');

    grindThenRecover(orch);
    const after = await step(1);
    const rendered = JSON.stringify(after?.messages ?? []);
    expect(rendered).toContain('Proven by execution');
    expect(rendered).toContain('bun test');
  });

  test('the same finding twice in one episode is one row and one run-event entry per turn', () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });

    orch.beginTurn(Date.now());
    grindThenRecover(orch);
    grindThenRecover(orch);
    expect(listRecoveryFindings(rt.storage.sql)).toHaveLength(1);
    // Both observations are real streaks; the run event counts both.
    expect(orch.recoverySnapshot()?.recoveries).toHaveLength(2);
  });

  test('with auto-evolution off, nothing is recorded at all — the bench arm measures the loop\'s absence', () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt, { enabled: false });
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });

    orch.beginTurn(Date.now());
    grindThenRecover(orch);
    expect(listRecoveryFindings(rt.storage.sql)).toEqual([]);
    expect(orch.recoverySnapshot()).toBeNull();
  });

  test('the turn boundary clears the run record but never the ledger', () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    const orch = new AgentOrchestrator({ host, engine, eventLog: eventLog() });

    orch.beginTurn(Date.now());
    grindThenRecover(orch);
    orch.beginTurn(Date.now());
    expect(orch.recoverySnapshot()).toBeNull();
    expect(listRecoveryFindings(rt.storage.sql)).toHaveLength(1);
  });
});

describe('the run event', () => {
  test('closeTurnRun writes one execution_recovery row when a streak broke, and none otherwise', () => {
    const emitted: Array<{ runId: string; input: RunEventInput }> = [];
    const recorder = { emit: (runId: string, input: RunEventInput) => { emitted.push({ runId, input }); } };

    closeTurnRun(recorder, 'run-1', {
      turnIndex: 0, usage: { input: 1, output: 1 }, reason: 'completed',
      recoveries: { recoveries: [{ tool: 'run', failures: 3, failedSignature: 'run abc' }] },
    });
    closeTurnRun(recorder, 'run-2', {
      turnIndex: 1, usage: { input: 1, output: 1 }, reason: 'completed',
      recoveries: null,
    });

    const rows = emitted.filter((e) => e.input.type === 'execution_recovery');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      runId: 'run-1',
      input: { type: 'execution_recovery', recoveries: [{ tool: 'run', failures: 3, failedSignature: 'run abc' }] },
    });
  });
});
