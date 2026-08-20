// SessionWindow — the durable evolution window + pending outcome review.
import { describe, test, expect } from 'bun:test';
import { createTestSql } from '@kinu/test-utils';
import { initSessionWindowTable, createSessionWindowStore, type SessionWindowStore } from '../src/evolution/session-window';
import type { CompletedTurn } from '../src/evolution/types';

function newStore(): SessionWindowStore {
  const { sql, execRaw } = createTestSql();
  initSessionWindowTable(execRaw);
  return createSessionWindowStore(sql);
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
    expect(win.takePendingReview()).toEqual(aTurn(0));
  });
});

describe('SessionWindow — the pending outcome review', () => {
  test('the newest turn awaiting a follow-up is the one waiting, and it is taken once', () => {
    const win = newStore();
    win.append(aTurn(0), { awaitsFollowup: true, now: 1 });
    win.append(aTurn(1), { awaitsFollowup: true, now: 2 });
    expect(win.takePendingReview()).toEqual(aTurn(1));
    expect(win.takePendingReview()).toBeNull();
  });

  test('a turn with no follow-up coming joins the window but never waits for one', () => {
    const win = newStore();
    win.append(aTurn(0), { awaitsFollowup: true, now: 1 });
    // A reactor turn, or any turn of a one-shot host: the caller says no
    // follow-up can grade it, so it must not displace the turn that IS waiting.
    win.append(aTurn(1, { origin: 'programmatic' }), { awaitsFollowup: false, now: 2 });
    expect(win.size()).toBe(2);
    expect(win.takePendingReview()).toEqual(aTurn(0));
  });

  test('a settled turn is dropped — the table holds the window plus one pending review', () => {
    const { sql, execRaw } = createTestSql();
    initSessionWindowTable(execRaw);
    const win = createSessionWindowStore(sql);
    for (let i = 0; i < 4; i++) {
      win.append(aTurn(i), { awaitsFollowup: true, now: i });
      win.claim()!.settle();
      win.takePendingReview();
    }
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM session_window`[0]?.n).toBe(0);
  });
});
