// SessionWindow — the durable evolution window + pending outcome review.
import { describe, test, expect } from 'bun:test';
import { createTestSql } from '@proteus/test-utils';
import { initSessionWindowTable, createSessionWindowStore, type SessionWindowStore } from '../src/evolution/session-window.js';
import type { CompletedTurn } from '../src/evolution/types.js';

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
  test('turns accumulate in order and close as one batch', () => {
    const win = newStore();
    for (let i = 0; i < 3; i++) win.append(aTurn(i), 1000 + i);
    expect(win.size()).toBe(3);
    expect(win.startedAt()).toBe(1000);

    const closed = win.close();
    expect(closed.map(t => t.userMessage)).toEqual(['t0', 't1', 't2']);
    expect(win.size()).toBe(0);
    expect(win.startedAt()).toBeNull();
    expect(win.close()).toEqual([]);
  });

  test('a turn round-trips with its tool calls and usage intact', () => {
    const win = newStore();
    const turn = aTurn(0, {
      toolCalls: [{ name: 'shell', args: { cmd: 'ls' }, result: { stdout: 'a\nb' } }],
      usage: { input: 10, output: 5, cached: 2 },
      hadError: true,
      sessionId: 'conv-1',
    });
    win.append(turn);
    expect(win.close()).toEqual([turn]);
  });

  test('closing the window does not discard a turn still waiting to be graded', () => {
    const win = newStore();
    win.append(aTurn(0));
    win.close();
    expect(win.takePendingReview()).toEqual(aTurn(0));
  });
});

describe('SessionWindow — the pending outcome review', () => {
  test('the newest user-origin turn is the one waiting, and it is taken once', () => {
    const win = newStore();
    win.append(aTurn(0), 1);
    win.append(aTurn(1), 2);
    expect(win.takePendingReview()).toEqual(aTurn(1));
    expect(win.takePendingReview()).toBeNull();
  });

  test('a programmatic turn joins the window but never waits for a follow-up', () => {
    const win = newStore();
    win.append(aTurn(0), 1);
    win.append(aTurn(1, { origin: 'programmatic' }), 2);
    expect(win.size()).toBe(2);
    // The reactor turn does not displace the user turn awaiting its verdict.
    expect(win.takePendingReview()).toEqual(aTurn(0));
  });

  test('a settled turn is dropped — the table holds the window plus one pending review', () => {
    const { sql, execRaw } = createTestSql();
    initSessionWindowTable(execRaw);
    const win = createSessionWindowStore(sql);
    for (let i = 0; i < 4; i++) {
      win.append(aTurn(i), i);
      win.close();
      win.takePendingReview();
    }
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM session_window`[0]?.n).toBe(0);
  });
});
