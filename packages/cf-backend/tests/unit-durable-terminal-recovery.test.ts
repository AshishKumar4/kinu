/**
 * What a fresh activation does with what an interruption left behind.
 *
 * Two obligations outlive the isolate that took them on: an event batch bound to
 * a drain turn whose reply was never dispatched, and the durable fibers a lane
 * was running inside. Both are read from storage by an activation that shares
 * nothing with the one that opened them, which is why every case here drives a
 * REAL restart rather than re-entering the same instance.
 *
 * The interrupted-fiber sweep's oracle is the SQL it issues: "does not
 * materialize a snapshot" is a claim about the READ, and only the read can
 * answer it. A test that checked which rows survived would pass over a sweep
 * that loaded every blob and then deleted the right ones.
 *
 * The terminal ledger itself — claim, effects, replay — is
 * unit-durable-terminal.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import {
  orchestratorHarness,
  type ActorHarness,
  type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import type { FiberRecoveryContext } from 'agents';
import {
  sweepUnrecoverableFibers,
  FIBER_RECOVERY_MAX_AGE_MS,
  SWEEP_MAX_ROWS,
  TERMINAL_LANE_FIBER,
  type FiberMetaRow,
  type FiberRowStore,
} from '../src/fiber-recovery';

// The actor harness replaces `agents`; load the installed artifact separately.
// Its Workers builtins come from the preload's boundary stub; `partyserver` is
// the one module declaration it still needs supplied. A narrow
// `cloudflare:workers` mock here once dropped `WorkerEntrypoint` and `tracing`
// for every suite sharing the process.
await mock.module('partyserver', () => ({
  Server: class {},
  getServerByName: () => undefined,
  routePartykitRequest: () => undefined,
}));
const installedAgentModule = [
  '../../../node_modules/agents/dist/index.js',
  'fiber-recovery-sql-probe',
].join('?');
const { Agent: InstalledAgent } = await import(installedAgentModule);
const InstalledRecoveryMethodsSchema = v.object({ _checkRunFibers: v.function() });
const installedRecoveryMethods = v.parse(InstalledRecoveryMethodsSchema, InstalledAgent.prototype);
const installedCheckRunFibers = installedRecoveryMethods._checkRunFibers;
// The wake's own callback name, from the module that arms it — DYNAMICALLY,
// after the harness above has replaced `agents`. A static import here would pull
// the actor module (and the real SDK behind it) in before the stand-in is
// installed, and every case in this file would construct a vendor Agent with no
// storage. The name is imported rather than restated because the sweep, the arm
// and this assertion must agree about which row is the terminal wake.
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

/** One admitted event bound to a synthetic drain turn with its recovery lease
 *  OPEN — what a drain leaves behind on its way to a turn. The payload is a
 *  real delivery shape, because the events-hub row schema parses it. */
function boundDelivery(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  eventId: string,
  drainTurnId: string,
  consumedAt: number,
): void {
  harness.db.prepare(
    `INSERT INTO agent_log
       (id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
        trust, priority, payload_visibility, payload, received_at,
        schema_version, dedupe_key, consumed_at)
     VALUES (?, 'event', ?, 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
             'authenticated', 'normal', 'full',
             '{"webhook_id":"w1","http_method":"POST","http_headers":{},"body":{"x":1},"delivery_id":"d1"}',
             1, 1, NULL, ?)`,
  ).run(eventId, drainTurnId, consumedAt);
}

/** The durable transcript pair a resumed reply reads: the queued drain turn's
 *  user row carrying `drainTurnId`, and the assistant row answering it. */
function persistedDrainTurn(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  drainTurnId: string,
  answer: string | null,
): void {
  // The SDK's own transcript table, created the way every other suite over it
  // does: the agents base class creates it lazily on first write, and no turn
  // has run here.
  harness.db.exec(`CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT '', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const append = harness.db.prepare(
    `INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at)
     VALUES (?, 'default', ?, ?, ?, '2026-08-16 22:05:00')`,
  );
  append.run(`u-${drainTurnId}`, null, 'user', JSON.stringify({
    id: `u-${drainTurnId}`,
    role: 'user',
    parts: [{ type: 'text', text: '1 event arrived while you were idle.' }],
    metadata: { kinuEvent: 'event_drain', drainTurnId },
  }));
  if (answer === null) return;
  append.run(`a-${drainTurnId}`, `u-${drainTurnId}`, 'assistant', JSON.stringify({
    id: `a-${drainTurnId}`,
    role: 'assistant',
    parts: [{ type: 'text', text: answer }],
  }));
}

/** A lease a LIVE activation left open, inside the sweep's 10-minute grace. The
 *  distinction is load-bearing: an ancient lease is one the activation sweep is
 *  RIGHT to reclaim, so seeding one would measure the sweep where the resume is
 *  what is under test. */
const RECENT = Date.now();

function lease(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  eventId: string,
): { turn_id: string | null; consumed_at: number | null } {
  // Parsed, not cast: a row that came back with the wrong shape (or a missing
  // row) fails by name here rather than reading as `undefined` two assertions
  // later.
  return v.parse(
    v.object({ turn_id: v.nullable(v.string()), consumed_at: v.nullable(v.number()) }),
    harness.db.query(`SELECT turn_id, consumed_at FROM agent_log WHERE id = ?`).get(eventId),
  );
}

describe('an interrupted terminal transition finishes the reply it still owed', () => {
  test('the answer already in the transcript is dispatched and the lease closes', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-owed', 'evt-owed', 5);
    persistedDrainTurn(harness, 'evt-owed', 'the build passed');
    // The prefix: the turn answered, the transition was claimed, and the isolate
    // died before the reply left.
    expect(harness.agent.harnessBeginTerminalTransition('u-owed')).toBe('first');

    // Classification arms the wake and dispatches NOTHING — the init ruling
    // covers spawned work too. The activation's whole answer is this boolean;
    // the alarm frame is what pays for the reply.
    expect(harness.agent.harnessOwedWorkExists()).toBe(true);
    expect(lease(harness, 'ev-owed')).toEqual({ turn_id: 'evt-owed', consumed_at: 5 });
    await harness.agent._kinuTerminalRetryTick();

    // The delivery is settled: lease closed, BINDING kept, so no later drain can
    // select it and no sweep can re-ask the question.
    expect(lease(harness, 'ev-owed')).toEqual({ turn_id: 'evt-owed', consumed_at: null });
    // And the transition is closed, so a recovery reads the settled
    // disposition rather than re-offering the effects.
    expect(harness.agent.harnessBeginTerminalTransition('u-owed')).toBe('done');
  });

  /**
   * The negative control, and the case the sweep exists for. A lease whose turn
   * produced NO answer must not be closed: nothing was said, so there is nothing
   * to send, and the question has to be asked again. Without this, "the resume
   * closes leases" would be satisfied by a resume that closed all of them and
   * silently dropped the unanswered ones.
   */
  test('a lease whose turn never answered is left open for the sweep to re-ask', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-silent', 'evt-silent', RECENT);
    persistedDrainTurn(harness, 'evt-silent', null);
    harness.agent.harnessBeginTerminalTransition('u-silent');

    await harness.agent.harnessResumeTerminalTransitions();

    expect(lease(harness, 'ev-silent')).toEqual({ turn_id: 'evt-silent', consumed_at: RECENT });
  });

  /** An empty answer is not an answer. A turn that streamed nothing must not
   *  close a channel whose sender is still waiting. */
  test('an empty answer does not count as a reply', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-blank', 'evt-blank', RECENT);
    persistedDrainTurn(harness, 'evt-blank', '   ');
    harness.agent.harnessBeginTerminalTransition('u-blank');

    await harness.agent.harnessResumeTerminalTransitions();

    expect(lease(harness, 'ev-blank')).toEqual({ turn_id: 'evt-blank', consumed_at: RECENT });
  });

  /** An unfinished transition with nothing re-derivable is CLOSED rather than
   *  re-offered. Left open it would be handed to every future activation
   *  forever, which is a sweep that never converges. */
  test('an unfinished transition with nothing to resume stops being re-offered', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessBeginTerminalTransition('u-nothing');

    await harness.agent.harnessResumeTerminalTransitions();

    expect(harness.agent.harnessBeginTerminalTransition('u-nothing')).toBe('done');
  });

  /**
   * Activation, end to end: the answered lease is finished and the unanswered
   * one is re-asked, from one pass, in that order.
   */
  test('activation finishes what was answered and re-asks only what was not', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-answered', 'evt-answered', 5);
    boundDelivery(harness, 'ev-unanswered', 'evt-unanswered', 5);
    persistedDrainTurn(harness, 'evt-answered', 'the build passed');
    persistedDrainTurn(harness, 'evt-unanswered', null);

    await harness.agent.activateActor();
    // The reconcile is detached from `onStart` (a bounded sweep plus one
    // schedule write); a macrotask lets that chain settle.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The activation touched NOTHING: both leases are exactly as the dead
    // activation left them — it proved existence and armed the wake, which is
    // the whole contract. The wake's frame joins the answered set, sweeps the
    // unanswered lease back to pending, and dispatches the owed reply.
    expect(lease(harness, 'ev-answered')).toEqual({ turn_id: 'evt-answered', consumed_at: 5 });
    expect(lease(harness, 'ev-unanswered')).toEqual({ turn_id: 'evt-unanswered', consumed_at: 5 });
    await harness.agent._kinuTerminalRetryTick();

    // Answered: finished, binding kept.
    expect(lease(harness, 'ev-answered').turn_id).toBe('evt-answered');
    expect(lease(harness, 'ev-answered').consumed_at).toBeNull();
    // Unanswered: back in the pending pool to be asked again.
    expect(lease(harness, 'ev-unanswered')).toEqual({ turn_id: null, consumed_at: null });
  });
});

/**
 * The recovery context the SDK builds for the terminal lane's own fiber row.
 * Only `name` is a decision here; the rest is the shape the hook is handed.
 */
const interruptedTerminalFiber: FiberRecoveryContext = {
  id: 'fiber-terminal',
  name: TERMINAL_LANE_FIBER,
  snapshot: { lane: TERMINAL_LANE_FIBER },
  createdAt: Date.now() - 60_000,
  recoveryReason: 'interrupted',
};

/**
 * The terminal lane's recovery arm, which must NOT replay.
 *
 * The replay is the expensive one — `terminal-effects.ts` says so itself: "a
 * reply makes an SMTP round trip, a branch waits on a live head, and the
 * between-turn lanes each spend a model call" — and it says the cost is
 * acceptable because "a recovery runs off an alarm with no queue to block, and
 * awaits everything". That was true of two of the three entry points. It was
 * false of this one: the SDK awaits the fiber-recovery hook inside
 * `blockConcurrencyWhile`, where the whole object's queue is exactly what is
 * blocked, so a branch wait of a few minutes was the platform's 30s cancellation
 * and a RESET of the object with the same rows still owed.
 */
describe('an interrupted terminal fiber arms the durable wake rather than replaying', () => {
  test('the hook classifies and arms; the replay happens off the gate', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    // A settled response whose sequence was claimed and never closed — what an
    // isolate that died mid-report leaves on disk.
    expect(agent.harnessBeginTerminalTransition('u-owed')).toBe('first');
    expect((await agent.listSchedules()).map((row) => row.callback))
      .not.toContain(TERMINAL_RETRY_CALLBACK);

    const result = await agent.harnessRecoverFiber(interruptedTerminalFiber);

    // THE property: the claim is still open at the instant the hook answered. The
    // in-gate arm settled this row before returning, because it had run the whole
    // replay — every owed reply, branch wait and between-turn model call — inside
    // `blockConcurrencyWhile` first.
    expect(agent.harnessTerminalClaims().map((row) => row.result_json)).toEqual([null]);
    expect(result).toEqual({
      status: 'completed', snapshot: { lane: TERMINAL_LANE_FIBER, redrive: 'terminal-wake' },
    });

    await agent.harnessJoinDetachedFibers();
    // The wake, durably: the ledger's own retry row, which is the carrier the
    // module was designed for and the one the stale-schedule sweep spares.
    expect((await agent.listSchedules()).map((row) => row.callback))
      .toContain(TERMINAL_RETRY_CALLBACK);

    // Idempotent, and this is the entry the module documents as free to await
    // everything: it acquires each sequence under the claim join, so the wake and
    // this activation's own detached reconcile cannot both replay one row.
    await agent._kinuTerminalRetryTick();

    expect(agent.harnessBeginTerminalTransition('u-owed')).toBe('done');
  });

  /** Nothing owed, nothing armed. Without this, "recovery arms the wake" would be
   *  satisfied by an arm that fired on every activation and woke an idle
   *  workspace for a roster that was already empty. */
  test('a workspace with no incomplete sequence arms no wake', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;

    await agent.harnessRecoverFiber(interruptedTerminalFiber);
    await agent.harnessJoinDetachedFibers();

    expect((await agent.listSchedules()).map((row) => row.callback))
      .not.toContain(TERMINAL_RETRY_CALLBACK);
  });
});


// ── The installed Agents recovery scan ───────────────────────────────────

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
      // The corrupt terminal payload and every large expired payload are never
      // fetched. The two survivors are fetched exactly at their own ids.
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
// ── The interrupted-fiber sweep ──────────────────────────────────────────

/** A SqlExecutor over a scripted `cf_agents_runs`, recording every query it is
 *  asked to run — the only oracle that can answer "did this read a snapshot?".
 *  `onBoundaryRead` fires immediately after `MAX(rowid)` is answered, which is
 *  the one moment a frozen-boundary claim can be tested at. */
/**
 * A scripted {@link FiberRowStore}, recording every question the sweep asks.
 *
 * ZERO casts: the port declares four narrow answers, so the fake states them
 * directly. That is also the strongest form the "never materializes a snapshot"
 * oracle can take — the interface has no method that could return one, so the
 * property is structural rather than a claim about a query string.
 *
 * `onBoundaryRead` fires immediately after `upperBoundary()` answers, which is
 * the one moment a frozen-boundary claim can be tested at.
 */
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

    // The framework's own scan opens with `SELECT id, name, snapshot,
    // created_at` over every row, which is the allocation this pass exists to
    // precede. What the pass asks for instead is exactly this, and no member of
    // `FiberRowStore` can answer with a snapshot — so the property is carried by
    // the interface rather than by a query string a refactor could change.
    expect(new Set(scene.asked)).toEqual(new Set(['present', 'upperBoundary', 'page', 'dropIfExpired']));
    // The cutoff lives in the query, so the fresh row is never paged at all:
    // one drop for the single expired row is the whole conversation.
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

  /** The negative control for the case above: with nothing past the budget the
   *  sweep must remove NOTHING. A pass that dropped unconditionally would
   *  satisfy every "it dropped the old ones" assertion. */
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

  /**
   * Paging, exercised past the quantum. 600 expired rows are more than two
   * pages, so a pass that read one page and stopped would report a third of
   * them — and a pass that read the table once would issue exactly one
   * `SELECT rowid`.
   */
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

  /**
   * The upper boundary, frozen — asserted at the only moment it can be: a lane
   * starts DURING the pass, right after `MAX(rowid)` was taken. Its row is
   * expired by age and would otherwise be dropped, and it survives because it
   * landed above the boundary. That is what makes a liveness check unnecessary
   * rather than racy.
   */
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

    // An inherent bound on the work itself — rows scanned — never a stopwatch:
    // the pass stops at the budget and says so rather than keep going.
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(SWEEP_MAX_ROWS);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.dropped).toBeLessThan(rows.length);
    // What it did not reach is still there for the next activation.
    expect(scene.survivors().length).toBeGreaterThan(0);
  });

  test('deletion is the cursor: the next wake reaches what this one did not', () => {
    // A backlog deeper than one budget, all expired. No durable cursor exists,
    // and none is needed: rowid order tracks insertion, so an expired row
    // cannot sit BEHIND a fresh one, and the rows a wake drops are exactly the
    // prefix the next wake no longer scans.
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
    // The adversarial ordering `created_at`-tracks-rowid would starve: imported
    // rows or a stepped clock put fresh timestamps at LOW rowids and an expired
    // row above the whole budget. The cutoff sits in the query, so the wall is
    // never scanned and the expired row is page one.
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
    // This repo owns patches/agents@0.20.1.patch: its _checkRunFibers rewrite
    // is Kinu code wearing a vendor path, so the init ruling applies to it the
    // same way. The budget half runs the INSTALLED scan past the sweep's own
    // budget: every expired row reports skipped, and the first row past the
    // budget is the last one the scan names. Sized from the imported sweep
    // budget because the patch exists to carry that same bound.
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

    // The stopwatch half has no behavioral surface: a fast suite never trips a
    // wall-clock exit, so its absence is only observable in the installed
    // artifact. A repin that resurrects it fails here by name.
    const dist = readFileSync(
      join(import.meta.dirname, '../../../node_modules/agents/dist/index.js'), 'utf8',
    );
    expect(dist).not.toContain('scan_deadline_exceeded');
    expect(dist).not.toContain('scanStartedAt');
  });
});
