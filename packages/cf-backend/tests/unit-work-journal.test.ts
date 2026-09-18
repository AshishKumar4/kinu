/**
 * The Work surface's journal is ONE stream out of three ledgers.
 *
 * Tasks, Jobs and the Evolution Changelog share it, because a tab each puts
 * "what happened while I was away" four clicks away and lands the reader in two
 * rooms that are mostly air. The merge only buys anything if the three actually
 * interleave by time — three blocks stacked under one heading would be the
 * same four rooms with the walls painted over.
 */
import { describe, test, expect } from 'bun:test';
import type { AgentTaskTree, ChangelogEntry } from '@kinu.run/core';
import type { BackgroundJob } from '@kinu.run/core/protocol';
import { buildJournal } from '../src/components/surfaces/WorkTab';
import { CHANGELOG_REVALIDATE_MS } from '../src/components/surfaces/changelog-entries';
import { LIVE_DATA_REFRESH_MS } from '../src/hooks/use-kinu';

function job(over: Partial<BackgroundJob> & { id: string }): BackgroundJob {
  return {
    kind: 'shell', label: null, workMode: 'build', status: 'completed', result: null, error: null,
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

  test('every row carries the chips it answers to, so the chips are views over one list', () => {
    const rows = buildJournal([job({ id: 'j' })], [task('t', 1)], [entry('c', 2)]);
    expect(new Set(rows.flatMap((r) => r.chips))).toEqual(new Set(['all', 'jobs', 'plan', 'self']));

    // …and each chip selects exactly its own rows out of that one list, while
    // All holds every one of them.
    for (const chip of ['jobs', 'plan', 'self'] as const) {
      expect(rows.filter((r) => r.chips.includes(chip))).toHaveLength(1);
    }

    expect(rows.filter((r) => r.chips.includes('all'))).toHaveLength(3);
  });

  test('a self-change that changed nothing answers to Self-changes and never to All', () => {
    // OWNER, 2026-09-16: a refused self-review ("I reviewed my own recent
    // failures and changed nothing") sat in All between the things that did
    // happen. It is kept where it answers a question — Self-changes — and the
    // run that moved behaviour stays in both.
    const noop: ChangelogEntry = { ...entry('c-refused', 2), kind: 'refinement', noChange: true };
    const changed: ChangelogEntry = { ...entry('c-applied', 3), kind: 'refinement' };
    const rows = buildJournal([job({ id: 'j' })], [task('t', 1)], [noop, changed]);

    expect(rows.filter((r) => r.chips.includes('all')).map((r) => r.key))
      .toEqual(['self:c-applied', 'task:t', 'job:j']);
    expect(rows.filter((r) => r.chips.includes('self')).map((r) => r.key))
      .toEqual(['self:c-applied', 'self:c-refused']);
  });

  test('a job that never settled is placed by when it started, not dropped', () => {
    // A cancelled job can carry a null settledAt; falling back to createdAt is
    // what keeps it in the feed instead of sorting it to the epoch.
    const rows = buildJournal([job({ id: 'j', status: 'cancelled', createdAt: 400, settledAt: null })], [], []);
    expect(rows[0]!.at).toBe(400);
  });

  test('keys are stable across re-reads, so a poll does not re-key and re-animate the feed', () => {
    const args = [[job({ id: 'j', settledAt: 1 })], [task('t', 2)], [entry('c', 3)]] as const;
    // The literal pins the key vocabulary the ordering test establishes. The second read proves a poll re-keys nothing.
    const first = buildJournal(...args).map((r) => r.key);
    expect(first).toEqual(['self:c', 'task:t', 'job:j']);
    expect(buildJournal(...args).map((r) => r.key)).toEqual(first);
  });

  test('nothing settled is an empty feed, not a throw', () => {
    expect(buildJournal([], [], [])).toEqual([]);
  });
});

/**
 * The needs-you queue and the journal beneath it render the SAME ledger, so the
 * digest revalidates on the surface's own live-data tick instead of loading
 * exactly once, at mount. Work is the surface a workspace opens on: a queue
 * that re-reads over a journal that never does puts "1 self-change you have not
 * seen … decide in the journal below" on top of "Nothing has settled yet",
 * permanently.
 */
describe('the journal reads on the same clock as the queue above it', () => {
  test('the digest revalidates, and no slower than the queue that announces it', () => {
    expect(CHANGELOG_REVALIDATE_MS).toBeGreaterThan(0);
    expect(CHANGELOG_REVALIDATE_MS).toBeLessThanOrEqual(LIVE_DATA_REFRESH_MS);
  });
});
