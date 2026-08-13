/**
 * The Work surface's journal is ONE stream out of three ledgers.
 *
 * Tasks, Jobs and the Evolution Changelog each used to own a tab, which is why
 * "what happened while I was away" cost four clicks and landed on two rooms
 * that were mostly air. The merge only buys anything if the three actually
 * interleave by time — three blocks stacked under one heading would be the
 * same four rooms with the walls painted over.
 */
import { describe, test, expect } from 'bun:test';
import type { AgentTaskTree, ChangelogEntry } from '@proteus/core';
import type { BackgroundJob } from '../src/lib/protocol.js';
import { buildJournal } from '../src/components/surfaces/WorkTab.tsx';
import { CHANGELOG_REVALIDATE_MS } from '../src/components/surfaces/changelog-entries.tsx';
import { LIVE_DATA_REFRESH_MS } from '../src/hooks/use-proteus.ts';

function job(over: Partial<BackgroundJob> & { id: string }): BackgroundJob {
  return {
    kind: 'run', label: null, status: 'completed', result: null, error: null,
    createdAt: 0, settledAt: 0, ...over,
  };
}

function task(id: string, updatedAt: number): AgentTaskTree {
  return { id, parentId: null, title: id, status: 'done', createdAt: 0, updatedAt, subtasks: [] };
}

function entry(id: string, at: number): ChangelogEntry {
  return { id, kind: 'tool', at, summary: id, evidence: '' };
}

describe('the work journal', () => {
  test('interleaves jobs, closed plan items and self-changes by time, newest first', () => {
    const rows = buildJournal(
      [job({ id: 'j-old', settledAt: 100 }), job({ id: 'j-new', settledAt: 500 })],
      [task('t-mid', 300)],
      [entry('c-newest', 700), entry('c-oldest', 50)],
    );
    expect(rows.map((r) => r.key)).toEqual([
      'self:c-newest', 'job:j-new', 'task:t-mid', 'job:j-old', 'self:c-oldest',
    ]);
  });

  test('every row carries the chip that filters it, so the chips are views over one list', () => {
    const rows = buildJournal([job({ id: 'j' })], [task('t', 1)], [entry('c', 2)]);
    expect(new Set(rows.map((r) => r.filter))).toEqual(new Set(['jobs', 'plan', 'self']));
    // …and each chip selects exactly its own rows out of that one list.
    for (const chip of ['jobs', 'plan', 'self'] as const) {
      expect(rows.filter((r) => r.filter === chip)).toHaveLength(1);
    }
  });

  test('a job that never settled is placed by when it started, not dropped', () => {
    // A cancelled job can carry a null settledAt; falling back to createdAt is
    // what keeps it in the feed instead of sorting it to the epoch.
    const rows = buildJournal([job({ id: 'j', status: 'cancelled', createdAt: 400, settledAt: null })], [], []);
    expect(rows[0]!.at).toBe(400);
  });

  test('keys are stable across re-reads, so a poll does not re-key and re-animate the feed', () => {
    const args = [[job({ id: 'j', settledAt: 1 })], [task('t', 2)], [entry('c', 3)]] as const;
    expect(buildJournal(...args).map((r) => r.key)).toEqual(buildJournal(...args).map((r) => r.key));
  });

  test('nothing settled is an empty feed, not a throw', () => {
    expect(buildJournal([], [], [])).toEqual([]);
  });
});

/**
 * The needs-you queue and the journal beneath it render the SAME ledger. The
 * queue is polled by the surface's own live-data tick; the digest used to load
 * exactly once, at mount. Work is the surface a workspace opens on, so the
 * first turn's self-change landed in a queue that re-read and a journal that
 * never did — "1 self-change you have not seen … decide in the journal below"
 * sitting on top of "Nothing has settled yet", permanently.
 */
describe('the journal reads on the same clock as the queue above it', () => {
  test('the digest revalidates, and no slower than the queue that announces it', () => {
    expect(CHANGELOG_REVALIDATE_MS).toBeGreaterThan(0);
    expect(CHANGELOG_REVALIDATE_MS).toBeLessThanOrEqual(LIVE_DATA_REFRESH_MS);
  });
});
