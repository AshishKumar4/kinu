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
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  orchestratorHarness,
  type ActorHarness,
  type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import {
  sweepUnrecoverableFibers,
  FIBER_RECOVERY_MAX_AGE_MS,
  FIBER_RECOVERY_SCAN_DEADLINE_MS,
  type FiberMetaRow,
  type FiberRowStore,
} from '../src/fiber-recovery';

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

    await harness.agent.harnessReconcileEventDeliveries();

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

    harness.agent.activateActor();
    // The reconcile is detached from `onStart` (it sends mail, and `onStart` runs
    // inside the init gate); a macrotask is what lets that chain settle.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // Answered: finished, binding kept.
    expect(lease(harness, 'ev-answered').turn_id).toBe('evt-answered');
    expect(lease(harness, 'ev-answered').consumed_at).toBeNull();
    // Unanswered: back in the pending pool to be asked again.
    expect(lease(harness, 'ev-unanswered')).toEqual({ turn_id: null, consumed_at: null });
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
    page: (after, through) => {
      asked.push('page');
      return [...table.values()]
        .filter((row) => row.rowid > after && row.rowid <= through)
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
    // One page for two rows, and one drop for the single expired one.
    expect(scene.asked.filter((question) => question === 'dropIfExpired')).toHaveLength(1);
  });

  test('it drops what the budget already refused and keeps what it did not', () => {
    const scene = scriptedFibers([
      { rowid: 1, id: 'old-1', created_at: overAge(1) },
      { rowid: 2, id: 'fresh-1', created_at: inBudget(1_000) },
      { rowid: 3, id: 'old-2', created_at: overAge(60_000) },
    ]);

    const result = sweepUnrecoverableFibers(scene.store, NOW);

    expect(result).toEqual({ dropped: 2, scanned: 3, deadlineExceeded: false });
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
      .toEqual({ dropped: 0, scanned: 2, deadlineExceeded: false });
    expect(scene.survivors()).toEqual(['fresh-1', 'fresh-2']);
  });

  test('an empty table is zero rows, not a failure', () => {
    expect(sweepUnrecoverableFibers(scriptedFibers([]).store, NOW))
      .toEqual({ dropped: 0, scanned: 0, deadlineExceeded: false });
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

  test('the deadline stops the pass and says so, leaving the rest for the next wake', () => {
    const rows = Array.from({ length: 600 }, (_unused, index) => ({
      rowid: index + 1, id: `old-${index}`, created_at: overAge(index + 1),
    }));
    const scene = scriptedFibers(rows);
    // A clock that jumps past the budget once the first page is done: the pass
    // must stop and say so rather than keep going.
    let reads = 0;
    const clock = () => {
      reads++;
      return reads <= 2 ? NOW : NOW + FIBER_RECOVERY_SCAN_DEADLINE_MS + 1;
    };

    const result = sweepUnrecoverableFibers(scene.store, NOW, clock);

    expect(result.deadlineExceeded).toBe(true);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.dropped).toBeLessThan(600);
    // What it did not reach is still there for the next activation.
    expect(scene.survivors().length).toBeGreaterThan(0);
  });
});
