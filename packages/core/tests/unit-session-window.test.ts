// SessionWindow — the durable evolution window + pending outcome review.
import { describe, test, expect } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import { initCompletedTurnTable, createCompletedTurnStore, type CompletedTurnStore } from '../src/evolution/session-window';
import type { CompletedTurn } from '../src/evolution/types';
import type { SqlExecutor } from '../src/types/primitives';

function newStore(): CompletedTurnStore {
  const { sql, execRaw } = createTestSql();
  initCompletedTurnTable(execRaw, sql);
  return createCompletedTurnStore(sql);
}

const aTurn = (i: number, extra: Partial<CompletedTurn> = {}): CompletedTurn => ({
  userMessage: `t${i}`, assistantResponse: `r${i}`, toolCalls: [], steps: 1, durationMs: 1,
  feedback: null, hadError: false, turnId: `m${i}`, origin: 'user', ...extra,
});

describe('SessionWindow — the open window', () => {
  test('turns accumulate in order and are claimed as one batch', () => {
    const win = newStore();
    for (let i = 0; i < 3; i++) win.append(aTurn(i), { awaitsFollowup: true, now: 1000 + i });
    expect(win.size()).toBe(3);

    const claimed = win.claim();
    expect(claimed).not.toBeNull();
    expect(claimed!.startedAt).toBe(1000);
    expect(claimed!.turns.map(t => t.userMessage)).toEqual(['t0', 't1', 't2']);
    // The turns stay in the window until the pass that claimed them settles.
    expect(win.size()).toBe(3);

    claimed!.settle();
    expect(win.size()).toBe(0);
    expect(win.claim()).toBeNull();
  });

  test('a claim that is never settled leaves the turns for the next host', () => {
    const win = newStore();
    for (let i = 0; i < 3; i++) win.append(aTurn(i), { awaitsFollowup: true, now: 1000 + i });
    // A process that dies mid-pass never calls settle().
    expect(win.claim()!.turns).toHaveLength(3);
    expect(win.size()).toBe(3);
    expect(win.claim()!.turns.map(t => t.userMessage)).toEqual(['t0', 't1', 't2']);
  });

  test('a turn appended during a pass belongs to the NEXT window', () => {
    const win = newStore();
    for (let i = 0; i < 2; i++) win.append(aTurn(i), { awaitsFollowup: true, now: 1000 + i });
    const claimed = win.claim()!;
    win.append(aTurn(9), { awaitsFollowup: true, now: 1010 });
    claimed.settle();
    expect(win.size()).toBe(1);
    expect(win.claim()!.turns.map(t => t.userMessage)).toEqual(['t9']);
  });

  test('a turn round-trips with its tool calls and usage intact', () => {
    const win = newStore();
    const turn = aTurn(0, {
      toolCalls: [{ name: 'shell', args: { cmd: 'ls' }, result: { stdout: 'a\nb' } }],
      usage: { input: 10, output: 5, cacheRead: 2 },
      hadError: true,
      sessionId: 'conv-1',
    });
    win.append(turn, { awaitsFollowup: true });
    expect(win.claim()!.turns).toEqual([turn]);
  });

  test('settling the window does not discard a turn still waiting to be graded', () => {
    const win = newStore();
    win.append(aTurn(0), { awaitsFollowup: true });
    win.claim()!.settle();
    expect(win.claimPendingReview()!.turn).toEqual(aTurn(0));
    expect(win.claimPendingReview()).toBeNull(); // taken once, then claimed
  });

  // The recording is durable work a backend can OWE, so it may run twice. Both
  // lifetimes of the row and the session cadence — which counts window rows —
  // have to survive that.
  test('appending one turn id twice leaves ONE row and one cadence tick', () => {
    const win = newStore();
    const id = win.append(aTurn(0), { awaitsFollowup: true, id: 'settle:msg-1', now: 1000 });
    expect(id).toBe('settle:msg-1');

    // The replay re-offers the same recording — same id, later clock.
    expect(win.append(aTurn(0), { awaitsFollowup: true, id: 'settle:msg-1', now: 9000 }))
      .toBe('settle:msg-1');

    expect(win.size()).toBe(1);
    const claimed = win.claim()!;
    expect(claimed.turns).toEqual([aTurn(0)]);
    // The row the FIRST append wrote, untouched: the replay must not restamp
    // the window it opened.
    expect(claimed.startedAt).toBe(1000);
  });

  test('a replay leaves the review state the row has since reached', () => {
    const win = newStore();
    win.append(aTurn(0), { awaitsFollowup: true, id: 'settle:msg-1', now: 1000 });
    const pending = win.claimPendingReview()!;
    win.settleReview(pending.rowId);

    // The graded turn must not come back as a fresh one owing a review.
    win.append(aTurn(0), { awaitsFollowup: true, id: 'settle:msg-1', now: 9000 });
    expect(win.claimPendingReview()).toBeNull();
    expect(win.size()).toBe(1);
  });

  test('appends with no id are distinct rows — two turns, not one', () => {
    const win = newStore();
    const a = win.append(aTurn(0), { awaitsFollowup: true, now: 1000 });
    const b = win.append(aTurn(0), { awaitsFollowup: true, now: 1001 });
    expect(a).not.toBe(b);
    expect(win.size()).toBe(2);
  });
});

describe('SessionWindow — the pending outcome review', () => {
  test('the newest awaiting turn waits first, and every awaiting turn is owed', () => {
    const win = newStore();
    win.append(aTurn(0), { awaitsFollowup: true, now: 1 });
    win.append(aTurn(1), { awaitsFollowup: true, now: 2 });
    // Newest first, and claiming PARKS the row until its review settles
    // instead of destroying it — a claim whose process dies is recoverable.
    const first = win.claimPendingReview()!;
    expect(first.turn).toEqual(aTurn(1));
    const second = win.claimPendingReview()!;
    expect(second.turn).toEqual(aTurn(0));
    expect(win.claimPendingReview()).toBeNull();
    win.settleReview(first.rowId);
    win.settleReview(second.rowId);
    expect(win.claimPendingReview()).toBeNull();
  });

  test('a turn with no follow-up coming joins the window but never waits for one', () => {
    const win = newStore();
    win.append(aTurn(0), { awaitsFollowup: true, now: 1 });
    // A reactor turn, or any turn of a one-shot host: the caller says no
    // follow-up can grade it, so it must not displace the turn that IS waiting.
    win.append(aTurn(1, { origin: 'programmatic' }), { awaitsFollowup: false, now: 2 });
    expect(win.size()).toBe(2);
    expect(win.claimPendingReview()!.turn).toEqual(aTurn(0));
  });

  test('a settled turn is dropped — the table holds the window plus one pending review', () => {
    const { sql, execRaw } = createTestSql();
    initCompletedTurnTable(execRaw, sql);
    const win = createCompletedTurnStore(sql);
    for (let i = 0; i < 4; i++) {
      win.append(aTurn(i), { awaitsFollowup: true, now: i });
      win.claim()!.settle();
      const p = win.claimPendingReview();
      if (p) win.settleReview(p.rowId);
    }
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM completed_turns`[0]?.n).toBe(0);
  });
});

// A retired row can no longer say what happened to it, and every one of these
// rows is retired on somebody else's schedule. What survives is the tombstone.
describe('SessionWindow — durability past the row', () => {
  function open() {
    const { sql, execRaw } = createTestSql();
    initCompletedTurnTable(execRaw, sql);
    return { sql, win: createCompletedTurnStore(sql) };
  }
  const rowCount = (sql: SqlExecutor): number =>
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM completed_turns`[0]?.n ?? 0;

  test('a keyed append replayed after its row was SWEPT does not resurrect the turn', () => {
    const { sql, win } = open();
    expect(win.append(aTurn(0), { awaitsFollowup: false, id: 'settle:msg-1', now: 1000 }))
      .toBe('settle:msg-1');
    win.claim()!.settle();
    const taken = win.takeQueuedReviews(5);
    expect(taken.reviews).toHaveLength(1);
    win.recordReviewRan(taken.reviews[0]!.id);
    win.settleReview(taken.reviews[0]!.id);
    // Both lifetimes over: the row the append wrote is gone, so `ON CONFLICT(id)`
    // has nothing left to conflict with.
    expect(rowCount(sql)).toBe(0);

    expect(win.append(aTurn(0), { awaitsFollowup: false, id: 'settle:msg-1', now: 9000 }))
      .toBe('settle:msg-1');
    expect(rowCount(sql)).toBe(0);
    expect(win.size()).toBe(0);
    expect(win.countQueuedReviews()).toBe(0);
  });

  test('a claimed review whose work already ran is settled by recovery, not re-queued', () => {
    const { win } = open();
    win.append(aTurn(0), { awaitsFollowup: false, now: 1 });
    const id = win.takeQueuedReviews(5).reviews[0]!.id;
    // reviewTurn resolved — the turn_outcomes row and the craft EMA moves have
    // landed — and the host was evicted before it could settle the lease.
    win.recordReviewRan(id);

    expect(win.resetStaleClaims()).toBe(0);
    expect(win.countQueuedReviews()).toBe(0);
    expect(win.takeQueuedReviews(5).reviews).toEqual([]);
  });

  test('a claimed review whose work did NOT run is re-queued and offered again', () => {
    const { win } = open();
    win.append(aTurn(0), { awaitsFollowup: false, now: 1 });
    win.takeQueuedReviews(5);

    expect(win.resetStaleClaims()).toBe(1);
    expect(win.countQueuedReviews()).toBe(1);
    expect(win.takeQueuedReviews(5).reviews.map((r) => r.turn)).toEqual([aTurn(0)]);
  });

  test('a released row whose work had already run is settled rather than offered', () => {
    const { win } = open();
    win.append(aTurn(0), { awaitsFollowup: false, now: 1 });
    const id = win.takeQueuedReviews(5).reviews[0]!.id;
    win.recordReviewRan(id);
    // Some other lane put the lease back — a release, a stale-claim reset on a
    // second host. The review still must not run twice.
    win.releaseQueuedReview(id);

    expect(win.takeQueuedReviews(5).reviews).toEqual([]);
    expect(win.countQueuedReviews()).toBe(0);
  });

  test('expireAwaitingReviews({ before }) demotes the older park and leaves the newer one', () => {
    const { win } = open();
    win.append(aTurn(0), { awaitsFollowup: true, now: 1000 });
    win.append(aTurn(1), { awaitsFollowup: true, now: 5000 });

    // A replayed independent-task recording, expiring only what existed when the
    // task it recorded ended.
    expect(win.expireAwaitingReviews({ before: 2000 })).toBe(1);
    expect(win.claimPendingReview()!.turn).toEqual(aTurn(1));
    expect(win.takeQueuedReviews(5).reviews.map((r) => r.turn)).toEqual([aTurn(0)]);
  });

  test('expireAwaitingReviews() with no cutoff still demotes every park', () => {
    const { win } = open();
    win.append(aTurn(0), { awaitsFollowup: true, now: 1000 });
    win.append(aTurn(1), { awaitsFollowup: true, now: 5000 });

    expect(win.expireAwaitingReviews()).toBe(2);
    expect(win.claimPendingReview()).toBeNull();
    expect(win.countQueuedReviews()).toBe(2);
  });
});
