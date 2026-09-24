/**
 * What a fresh activation does with an interrupted drain lease or fiber; every case drives a real restart.
 * The fiber sweep's oracle is the reads it issues, not which rows survive. Terminal ledger: unit-durable-terminal.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import {
  historyOver, ledgerOver, orchestratorHarness, until, workspaceMainActor,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import type { FiberRecoveryContext } from 'agents';
import { CHAT_SESSION_ID } from '@kinu.run/core';
import {
  sweepUnrecoverableFibers,
  FIBER_RECOVERY_MAX_AGE_MS,
  SWEEP_MAX_ROWS,
  TERMINAL_LANE_FIBER,
  type FiberMetaRow,
  type FiberRowStore,
} from '../src/fiber-recovery';

// The actor harness replaces `agents`; load the installed artifact separately. A narrow
// `cloudflare:workers` mock here would drop `WorkerEntrypoint`/`tracing` for every suite in the process.
const installedAgentModule = [
  '../../../node_modules/agents/dist/index.js',
  'fiber-recovery-sql-probe',
].join('?');

const { Agent: InstalledAgent } = await import(installedAgentModule);

const InstalledRecoveryMethodsSchema = v.object({ _checkRunFibers: v.function() });

const installedRecoveryMethods = v.parse(InstalledRecoveryMethodsSchema, InstalledAgent.prototype);

const installedCheckRunFibers = installedRecoveryMethods._checkRunFibers;

// Dynamic: a static import would load the real SDK before the harness stand-in is installed.
const { TERMINAL_RETRY_CALLBACK } = await import('../src/actor-agent');

const FiberRecoveryEventSchema = v.object({
  fiberId: v.string(),
  fiberName: v.string(),
});

type FiberRecoveryEvent = v.InferOutput<typeof FiberRecoveryEventSchema>;

const ManagedRecoveryRowSchema = v.nullable(v.object({ fiber_id: v.string() }));

type ManagedRecoveryRow = v.InferOutput<typeof ManagedRecoveryRowSchema>;

const RecoverySnapshotSchema = v.nullable(v.object({}));

type RecoverySnapshot = v.InferOutput<typeof RecoverySnapshotSchema>;

const RecoveryMetadataSchema = v.object({});

type RecoveryMetadata = v.InferOutput<typeof RecoveryMetadataSchema>;

/** One admitted event bound to a synthetic drain turn with its lease open. Filed under the workspace's own
 *  actor: a row under any other id is invisible to actor-scoped reads, so assertions would hold vacuously. */
function boundDelivery(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  eventId: string,
  drainTurnId: string,
  consumedAt: number,
): void {
  harness.db.prepare(
    `INSERT INTO agent_log
       (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
        trust, priority, payload_visibility, payload, received_at,
        schema_version, dedupe_key, consumed_at)
     VALUES (?, ?, 'event', ?, 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
             'authenticated', 'normal', 'full',
             '{"webhook_id":"w1","http_method":"POST","http_headers":{},"body":{"x":1},"delivery_id":"d1"}',
             1, 1, NULL, ?)`,
  ).run(workspaceMainActor(harness.db).actorId, eventId, drainTurnId, consumedAt);
}

/** The transcript pair a resumed reply reads: the drain turn's user entry and its assistant answer. */
async function persistedDrainTurn(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  drainTurnId: string,
  answer: string | null,
): Promise<void> {
  const history = historyOver(harness);
  await history.record(CHAT_SESSION_ID, { id: `u-${drainTurnId}`, parentId: history.transcript(CHAT_SESSION_ID).newestId(), origin: 'input',
    message: { role: 'user', content: '1 event arrived while you were idle.' }, metadata: { kinuEvent: 'event_drain', drainTurnId } });

  if (answer === null) return;
  await history.record(CHAT_SESSION_ID, { id: `a-${drainTurnId}`, parentId: `u-${drainTurnId}`, origin: 'output',
    message: { role: 'assistant', content: answer } });
}

/** A prior activation's open claim for `turnId`'s answer, as core writes it. */
function openTransition(harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string): string {
  return ledgerOver(harness.db).begin({ turnId, messageId: 'a-1' });
}

/** `done` once the object closed the sequence; a still-open one answers `resumed`. */
function transitionState(harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string): string {
  return ledgerOver(harness.db).begin({ turnId, messageId: 'a-1' });
}

/** Activation classifies owed work by arming the retry wake and dispatching nothing. */
async function activateAndClassify(harness: ActorHarness<HarnessOrchestratorAgent>): Promise<void> {
  await harness.agent.activateActor();
  await until(() => harness.db.query<{ n: number }, [string]>(
    'SELECT COUNT(*) AS n FROM cf_agents_schedules WHERE callback = ?',
  ).get(TERMINAL_RETRY_CALLBACK)?.n === 1, 'the activation armed the terminal retry wake');
}

/** Inside the sweep's grace, so the sweep leaves it alone and only the resume is under test. */
const RECENT = Date.now();

function lease(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  eventId: string,
): { turn_id: string | null; consumed_at: number | null } {
  return v.parse(
    v.object({ turn_id: v.nullable(v.string()), consumed_at: v.nullable(v.number()) }),
    harness.db.query(`SELECT turn_id, consumed_at FROM agent_log WHERE id = ?`).get(eventId),
  );
}

describe('an interrupted terminal transition finishes the reply it still owed', () => {
  test('the answer already in the transcript is dispatched and the lease closes', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-owed', 'evt-owed', 5);
    await persistedDrainTurn(harness, 'evt-owed', 'the build passed');
    expect(openTransition(harness, 'u-owed')).toBe('first');

    // Classification arms the wake and dispatches nothing; the alarm frame sends the reply.
    await activateAndClassify(harness);
    expect(lease(harness, 'ev-owed')).toEqual({ turn_id: 'evt-owed', consumed_at: 5 });
    await harness.agent.terminalRetryPass();

    expect(lease(harness, 'ev-owed')).toEqual({ turn_id: 'evt-owed', consumed_at: null });
    expect(transitionState(harness, 'u-owed')).toBe('done');
  });

  /** Negative control: a lease whose turn produced no answer must stay open to be re-asked. */
  test('a lease whose turn never answered is left open for the sweep to re-ask', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-silent', 'evt-silent', RECENT);
    await persistedDrainTurn(harness, 'evt-silent', null);
    openTransition(harness, 'u-silent');
    // Without this, a row filed under another actor would read as no row and the case would pass vacuously.
    await activateAndClassify(harness);

    // The full wake frame (stale-lease sweep, then replay), not `resumeAll()` alone.
    await harness.agent.terminalRetryPass();

    expect(lease(harness, 'ev-silent')).toEqual({ turn_id: 'evt-silent', consumed_at: RECENT });
  });

  test('an empty answer does not count as a reply', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-blank', 'evt-blank', RECENT);
    await persistedDrainTurn(harness, 'evt-blank', '   ');
    openTransition(harness, 'u-blank');
    await activateAndClassify(harness);

    await harness.agent.terminalRetryPass();

    expect(lease(harness, 'ev-blank')).toEqual({ turn_id: 'evt-blank', consumed_at: RECENT });
  });

  test('an unfinished transition with nothing to resume stops being re-offered', async () => {
    const harness = orchestratorHarness();
    openTransition(harness, 'u-nothing');

    await harness.agent.terminalRetryPass();

    expect(transitionState(harness, 'u-nothing')).toBe('done');
  });

  test('activation finishes what was answered and re-asks only what was not', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-answered', 'evt-answered', 5);
    boundDelivery(harness, 'ev-unanswered', 'evt-unanswered', 5);
    await persistedDrainTurn(harness, 'evt-answered', 'the build passed');
    await persistedDrainTurn(harness, 'evt-unanswered', null);

    // The reconcile is detached from `onStart`; the wake it arms is its record that it ran.
    await activateAndClassify(harness);

    // Activation only proves existence and arms the wake; the wake frame does the work.
    expect(lease(harness, 'ev-answered')).toEqual({ turn_id: 'evt-answered', consumed_at: 5 });
    expect(lease(harness, 'ev-unanswered')).toEqual({ turn_id: 'evt-unanswered', consumed_at: 5 });
    await harness.agent.terminalRetryPass();

    expect(lease(harness, 'ev-answered').turn_id).toBe('evt-answered');
    expect(lease(harness, 'ev-answered').consumed_at).toBeNull();
    expect(lease(harness, 'ev-unanswered')).toEqual({ turn_id: null, consumed_at: null });
  });
});

const interruptedTerminalFiber: FiberRecoveryContext = {
  id: 'fiber-terminal',
  name: TERMINAL_LANE_FIBER,
  snapshot: { lane: TERMINAL_LANE_FIBER },
  createdAt: Date.now() - 60_000,
  recoveryReason: 'interrupted',
};

/** The SDK awaits the fiber-recovery hook inside `blockConcurrencyWhile`, so replaying there blocks the whole
 *  object into platform cancellation with the rows still owed: the arm must only schedule the wake. */
describe('an interrupted terminal fiber arms the durable wake rather than replaying', () => {
  test('the hook classifies and arms; the replay happens off the gate', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    expect(openTransition(harness, 'u-owed')).toBe('first');
    expect((await agent.listSchedules()).map((row) => row.callback))
      .not.toContain(TERMINAL_RETRY_CALLBACK);

    const result = await agent.onFiberRecovered(interruptedTerminalFiber);

    // The claim is still open when the hook returns: no replay ran inside the gate.
    expect(harness.db.query<{ result_json: string | null }, []>(
      "SELECT result_json FROM tool_effect_claims WHERE normalized_call_id LIKE 'terminal:response:%'",
    ).all().map((row) => row.result_json)).toEqual([null]);
    expect(result).toEqual({
      status: 'completed', snapshot: { lane: TERMINAL_LANE_FIBER, redrive: 'terminal-wake' },
    });

    await joinHarnessFibers();
    // The ledger's own retry row: the carrier the stale-schedule sweep spares.
    expect((await agent.listSchedules()).map((row) => row.callback))
      .toContain(TERMINAL_RETRY_CALLBACK);

    // The claim join keeps the wake and the detached reconcile from both replaying one row.
    await agent.terminalRetryPass();

    expect(transitionState(harness, 'u-owed')).toBe('done');
  });

  test('a workspace with no incomplete sequence arms no wake', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;

    await agent.onFiberRecovered(interruptedTerminalFiber);
    await joinHarnessFibers();

    expect((await agent.listSchedules()).map((row) => row.callback))
      .not.toContain(TERMINAL_RETRY_CALLBACK);
  });
});

interface SqlTrace {
  readonly query: string;
  readonly bindings: readonly SQLQueryBindings[];
}

function tracedSql(database: Database, trace: SqlTrace[]) {
  return (strings: TemplateStringsArray, ...bindings: SQLQueryBindings[]) => {
    const query = strings.join('?');
    trace.push({ query, bindings });
    const statement = database.prepare(query);

    if (statement.columnNames.length > 0) return statement.all(...bindings);
    statement.run(...bindings);

    return [];
  };
}

function installedFiberRecoveryScene() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE cf_agents_runs (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      snapshot TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE cf_agents_fibers (
      fiber_id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot TEXT,
      metadata_json TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );
  `);
  const queries: SqlTrace[] = [];
  const recovered: string[] = [];
  const events: Array<{ name: string; payload: FiberRecoveryEvent }> = [];
  const terminalNotifications: string[] = [];

  const terminalWaiters = new Map([
    ['terminal-managed', new Set([() => { terminalNotifications.push('terminal-managed'); }])],
  ]);

  const subject = {
    _runFiberRecoveryInProgress: false,
    _resolvedOptions: {
      fiberRecoveryMaxAgeMs: FIBER_RECOVERY_MAX_AGE_MS,
    },
    _runFiberActiveFibers: new Set<string>(),
    _managedFiberTerminalWaiters: terminalWaiters,
    _recoveryNoProgressScans: 0,
    sql: tracedSql(database, queries),
    _isTerminalFiberStatus(status: string): boolean {
      return ['completed', 'aborted', 'interrupted', 'error'].includes(status);
    },
    _notifyManagedFiberTerminal(fiberId: string): void {
      terminalNotifications.push(fiberId);
    },
    _emit(name: string, payload: FiberRecoveryEvent): void {
      events.push({ name, payload });
    },
    _fiberRecoveryPayload(
      ctx: { id: string; name: string; recoveryReason: string },
      managedRow: ManagedRecoveryRow,
    ) {
      return {
        fiberId: ctx.id,
        fiberName: ctx.name,
        managed: managedRow !== null,
        recoveryReason: ctx.recoveryReason,
      };
    },
    _parseFiberRecoverySnapshot(
      _fiberId: string,
      snapshot: string | null,
    ): RecoverySnapshot {
      if (snapshot === null) return null;

      return v.parse(RecoverySnapshotSchema, JSON.parse(snapshot));
    },
    _parseFiberJsonObject(metadata: string | null): RecoveryMetadata | undefined {
      if (metadata === null) return undefined;

      return v.parse(RecoveryMetadataSchema, JSON.parse(metadata));
    },
    async _runFiberRecoveryHook(ctx: { id: string }): Promise<boolean> {
      recovered.push(ctx.id);

      return true;
    },
    _hasPendingFiberRecovery(): boolean {
      return false;
    },
  };

  return { database, queries, recovered, events, terminalNotifications, subject };
}

describe('the installed Agents recovery scan', () => {
  test('pages metadata before loading only the fresh run and ledger snapshots', async () => {
    const scene = installedFiberRecoveryScene();
    const now = Date.now();
    const expiredRuns = 128;
    const largeSnapshot = JSON.stringify({ stash: 'x'.repeat(64 * 1024) });

    const insertRun = scene.database.prepare(
      'INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, ?, ?)',
    );

    const insertFiber = scene.database.prepare(`
      INSERT INTO cf_agents_fibers (
        fiber_id, idempotency_key, name, status, snapshot, metadata_json,
        error_message, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      for (let index = 0; index < expiredRuns; index++) {
        insertRun.run(
          `expired-unmanaged-${String(index)}`,
          'expired unmanaged',
          largeSnapshot,
          now - FIBER_RECOVERY_MAX_AGE_MS - 1,
        );
      }

      insertRun.run('terminal-managed', 'terminal managed', '{not-json', now);
      insertRun.run('fresh-control', 'fresh control', '{}', now);
      insertFiber.run(
        'terminal-managed', null, 'terminal managed', 'completed', '{not-json',
        null, null, now, null, now,
      );
      insertFiber.run(
        'ledger-only', null, 'ledger only', 'running', '{}',
        null, null, now, now, null,
      );

      await installedCheckRunFibers.call(scene.subject);

      const snapshotReads = scene.queries.filter(({ query }) => (
        query.trimStart().startsWith('SELECT') && query.includes('snapshot')
      ));

      expect(snapshotReads.map(({ bindings }) => bindings[0]))
        .toEqual(['fresh-control', 'ledger-only']);

      const runMetadataPages = scene.queries.filter(({ query }) => (
        query.includes('SELECT rowid AS rowid, id, name, created_at FROM cf_agents_runs')
      ));

      expect(runMetadataPages.length).toBeGreaterThan(expiredRuns);
      expect(runMetadataPages.every(({ query }) => (
        !query.includes('snapshot') && query.includes('ORDER BY rowid ASC LIMIT 1')
      ))).toBe(true);

      const managedMetadata = scene.queries.filter(({ query }) => (
        query.includes('SELECT fiber_id, idempotency_key, status, metadata_json')
        && query.includes('FROM cf_agents_fibers')
      ));

      expect(managedMetadata.length).toBeGreaterThan(0);
      expect(managedMetadata.every(({ query }) => !query.includes('snapshot'))).toBe(true);

      const ledgerMetadataPages = scene.queries.filter(({ query }) => (
        query.includes('SELECT f.rowid AS rowid, f.fiber_id, f.idempotency_key, f.name')
      ));

      expect(ledgerMetadataPages).toHaveLength(2);
      expect(ledgerMetadataPages.every(({ query }) => (
        !query.includes('snapshot') && query.includes('ORDER BY f.rowid ASC LIMIT 1')
      ))).toBe(true);

      const runBoundary = scene.queries.findIndex(({ query }) => (
        query.trim() === 'SELECT MAX(rowid) AS boundary FROM cf_agents_runs'
      ));

      const firstRunPage = scene.queries.findIndex(({ query }) => (
        query.includes('SELECT rowid AS rowid, id, name, created_at FROM cf_agents_runs')
      ));

      const freshSnapshot = scene.queries.findIndex(({ query, bindings }) => (
        query.includes('snapshot') && bindings[0] === 'fresh-control'
      ));

      const ledgerBoundary = scene.queries.findIndex(({ query }) => (
        query.trim() === 'SELECT MAX(rowid) AS boundary FROM cf_agents_fibers'
      ));

      const ledgerPage = scene.queries.findIndex(({ query }) => (
        query.includes('SELECT f.rowid AS rowid, f.fiber_id, f.idempotency_key, f.name')
      ));

      const ledgerSnapshot = scene.queries.findIndex(({ query, bindings }) => (
        query.includes('snapshot') && bindings[0] === 'ledger-only'
      ));

      expect(runBoundary).toBeGreaterThanOrEqual(0);
      expect(firstRunPage).toBeGreaterThan(runBoundary);
      expect(freshSnapshot).toBeGreaterThan(firstRunPage);
      expect(ledgerBoundary).toBeGreaterThan(freshSnapshot);
      expect(ledgerPage).toBeGreaterThan(ledgerBoundary);
      expect(ledgerSnapshot).toBeGreaterThan(ledgerPage);

      expect(scene.recovered).toEqual(['fresh-control', 'ledger-only']);
      expect(scene.terminalNotifications).toEqual(['terminal-managed', 'ledger-only']);
      expect(scene.events
        .filter(({ name }) => name === 'fiber:run:interrupted')
        .map(({ payload }) => payload.fiberId))
        .toEqual(['terminal-managed', 'fresh-control', 'ledger-only']);
      expect(scene.database.query('SELECT id FROM cf_agents_runs').all()).toEqual([]);
      expect(
        scene.database.query('SELECT status FROM cf_agents_fibers WHERE fiber_id = ?')
          .get('ledger-only'),
      ).toEqual({ status: 'interrupted' });
    } finally {
      scene.database.close();
    }
  });
});

/** A scripted {@link FiberRowStore} recording every question the sweep asks; no port member can return a snapshot.
 *  `onBoundaryRead` fires right after `upperBoundary()` answers. */
function scriptedFibers(
  rows: readonly FiberMetaRow[],
  onBoundaryRead?: (table: Map<string, FiberMetaRow>) => void,
) {
  const asked: string[] = [];
  const table = new Map(rows.map((row) => [row.id, row]));

  const store: FiberRowStore = {
    present: () => {
      asked.push('present');

      return true;
    },
    upperBoundary: () => {
      asked.push('upperBoundary');
      const live = [...table.values()];
      const boundary = live.length === 0 ? null : Math.max(...live.map((row) => row.rowid));
      onBoundaryRead?.(table);

      return boundary;
    },
    page: (after, through, cutoff) => {
      asked.push('page');

      return [...table.values()]
        .filter((row) => row.rowid > after && row.rowid <= through && row.created_at <= cutoff)
        .sort((a, b) => a.rowid - b.rowid)
        .slice(0, 1);
    },
    dropIfExpired: (id, cutoff) => {
      asked.push('dropIfExpired');
      const row = table.get(id);

      if (!row || row.created_at > cutoff) return false;
      table.delete(id);

      return true;
    },
  };

  return { store, asked, survivors: () => [...table.keys()].sort() };
}

describe('the interrupted-fiber sweep spends the budget before the memory', () => {

const NOW = 1_700_000_000_000;
  const overAge = (ms: number) => NOW - FIBER_RECOVERY_MAX_AGE_MS - ms;
  const inBudget = (ms: number) => NOW - ms;

  test('it asks only the four questions the port declares', () => {
    const scene = scriptedFibers([
      { rowid: 1, id: 'old-1', created_at: overAge(1) },
      { rowid: 2, id: 'fresh-1', created_at: inBudget(1_000) },
    ]);

    sweepUnrecoverableFibers(scene.store, NOW);

    // No `FiberRowStore` member can return a snapshot, so the property rides the interface, not a query string.
    expect(new Set(scene.asked)).toEqual(new Set(['present', 'upperBoundary', 'page', 'dropIfExpired']));
    // The cutoff lives in the query: the fresh row is never paged.
    expect(scene.asked.filter((question) => question === 'dropIfExpired')).toHaveLength(1);
  });

  test('it drops what the budget already refused and keeps what it did not', () => {
    const scene = scriptedFibers([
      { rowid: 1, id: 'old-1', created_at: overAge(1) },
      { rowid: 2, id: 'fresh-1', created_at: inBudget(1_000) },
      { rowid: 3, id: 'old-2', created_at: overAge(60_000) },
    ]);

    const result = sweepUnrecoverableFibers(scene.store, NOW);

    expect(result).toEqual({ dropped: 2, scanned: 2, truncated: false });
    expect(scene.survivors()).toEqual(['fresh-1']);
  });

  test('a workspace with no expired rows loses nothing', () => {
    const scene = scriptedFibers([
      { rowid: 1, id: 'fresh-1', created_at: inBudget(1) },
      { rowid: 2, id: 'fresh-2', created_at: inBudget(60_000) },
    ]);

    expect(sweepUnrecoverableFibers(scene.store, NOW))
      .toEqual({ dropped: 0, scanned: 0, truncated: false });
    expect(scene.survivors()).toEqual(['fresh-1', 'fresh-2']);
  });

  test('an empty table is zero rows, not a failure', () => {
    expect(sweepUnrecoverableFibers(scriptedFibers([]).store, NOW))
      .toEqual({ dropped: 0, scanned: 0, truncated: false });
  });

  /** 600 expired rows span more than two pages. */
  test('it pages until the frozen boundary rather than reading the table once', () => {
    const rows = Array.from({ length: 600 }, (_unused, index) => ({
      rowid: index + 1, id: `old-${index}`, created_at: overAge(index + 1),
    }));

    const scene = scriptedFibers(rows);

    const result = sweepUnrecoverableFibers(scene.store, NOW);

    expect(result.dropped).toBe(600);
    expect(scene.survivors()).toEqual([]);
    const pages = scene.asked.filter((question) => question === 'page').length;
    expect(pages).toBeGreaterThan(2);
  });

  /** A row landing above the frozen boundary survives; that is why no liveness check is needed. */
  test('a row written after the boundary was frozen is outside the pass', () => {
    const scene = scriptedFibers(
      [{ rowid: 1, id: 'old-1', created_at: overAge(1) }],
      (table) => {
        table.set('started-during', { rowid: 99, id: 'started-during', created_at: overAge(1) });
      },
    );

    const result = sweepUnrecoverableFibers(scene.store, NOW);

    expect(result.dropped).toBe(1);
    expect(scene.survivors()).toEqual(['started-during']);
  });

  test('the row budget stops the pass and says so, leaving the rest for the next wake', () => {
    const rows = Array.from({ length: SWEEP_MAX_ROWS + 200 }, (_unused, index) => ({
      rowid: index + 1, id: `old-${index}`, created_at: overAge(index + 1),
    }));

    const scene = scriptedFibers(rows);

    const result = sweepUnrecoverableFibers(scene.store, NOW);

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(SWEEP_MAX_ROWS);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.dropped).toBeLessThan(rows.length);
    expect(scene.survivors().length).toBeGreaterThan(0);
  });

  test('deletion is the cursor: the next wake reaches what this one did not', () => {
    // Rowid order tracks insertion, so no durable cursor is needed across wakes.
    const rows = Array.from({ length: SWEEP_MAX_ROWS + 300 }, (_unused, index) => ({
      rowid: index + 1, id: `old-${index}`, created_at: overAge(index + 1),
    }));

    const scene = scriptedFibers(rows);

    const first = sweepUnrecoverableFibers(scene.store, NOW);
    expect(first.truncated).toBe(true);

    const second = sweepUnrecoverableFibers(scene.store, NOW);
    expect(second.truncated).toBe(false);
    expect(first.dropped + second.dropped).toBe(rows.length);
    expect(scene.survivors()).toEqual([]);
  });

  test('an expired row behind a wall of fresh ones is dropped on the FIRST wake', () => {
    // Fresh timestamps at low rowids: the cutoff in the query keeps them unscanned.
    const rows = [
      ...Array.from({ length: SWEEP_MAX_ROWS + 10 }, (_unused, index) => ({
        rowid: index + 1, id: `fresh-${index}`, created_at: inBudget(index + 1),
      })),
      { rowid: SWEEP_MAX_ROWS + 11, id: 'expired-behind-the-wall', created_at: overAge(1) },
    ];

    const scene = scriptedFibers(rows);

    const result = sweepUnrecoverableFibers(scene.store, NOW);

    expect(result).toEqual({ dropped: 1, scanned: 1, truncated: false });
    expect(scene.survivors()).not.toContain('expired-behind-the-wall');
    expect(scene.survivors()).toHaveLength(SWEEP_MAX_ROWS + 10);
  });

  test('the PATCHED framework scan carries the same row budget, never a stopwatch', async () => {
    // patches/agents@0.22.0.patch rewrites _checkRunFibers as Kinu code; its budget must match the sweep's.
    const scene = installedFiberRecoveryScene();

    try {
      const insert = scene.database.prepare(
        'INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, ?, ?)',
      );

      const expiredAt = Date.now() - FIBER_RECOVERY_MAX_AGE_MS - 1;

      for (let index = 0; index < SWEEP_MAX_ROWS + 10; index++) {
        insert.run(`old-${index}`, 'old', '{}', expiredAt);
      }

      await installedCheckRunFibers.call(scene.subject);

      const skippedIds = scene.events
        .filter(({ name }) => name === 'fiber:recovery:skipped')
        .map(({ payload }) => payload.fiberId);

      expect(skippedIds).toHaveLength(SWEEP_MAX_ROWS + 1);
      expect(skippedIds[SWEEP_MAX_ROWS]).toBe(`old-${SWEEP_MAX_ROWS}`);
      expect(scene.recovered).toEqual([]);
    } finally {
      scene.database.close();
    }

    // The stopwatch's absence is only observable in the installed scan's source.
    const scan = installedCheckRunFibers.toString();
    expect(scan).not.toContain('scan_deadline_exceeded');
    expect(scan).not.toContain('scanStartedAt');
  });
});
