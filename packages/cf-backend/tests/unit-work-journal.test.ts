/**
 * The Work journal interleaves Tasks, Jobs and the Evolution Changelog by time, with no second Plan chip
 * (the live plan lives in `WorkPlans`, B12). `All` is the whole feed: the needs-you row counts off it.
 */
import './helpers/ui-module-globals';
import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentTaskTree, ChangelogEntry, MemoryEntry, PendingAction, Rpc } from '@kinu.run/core';
import type { BackgroundJob } from '@kinu.run/core/protocol';
import { buildJournal, WorkTab } from '../src/components/surfaces/WorkTab';
import { CHANGELOG_REVALIDATE_MS } from '../src/components/surfaces/changelog-entries';
import { LIVE_DATA_REFRESH_MS } from '../src/hooks/use-kinu';

function job(over: Partial<BackgroundJob> & { id: string }): BackgroundJob {
  return {
    kind: 'shell', label: null, workMode: 'build', status: 'completed', result: null, error: null,
    createdAt: 0, settledAt: 0, ...over,
  };
}

function task(id: string, updatedAt: number): AgentTaskTree {
  return { id, parentId: null, title: id, status: 'done', createdAt: 0, updatedAt, note: null, subtasks: [] };
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
    expect(new Set(rows.flatMap((r) => r.chips))).toEqual(new Set(['all', 'jobs', 'self']));

    expect(rows.filter((r) => r.chips.includes('jobs'))).toHaveLength(1);
    expect(rows.filter((r) => r.chips.includes('self'))).toHaveLength(2);
    expect(rows.flatMap((r) => r.chips)).not.toContain('plan');
    expect(rows.filter((r) => r.chips.includes('all'))).toHaveLength(3);
  });

  test('a self-change that changed nothing rides All beside the runs that moved something', () => {
    // OWNER, 2026-09-17: the chip named for everything holds every row; `changesOnly` is the curated feed.
    const noop: ChangelogEntry = { ...entry('c-refused', 2), kind: 'refinement', noChange: true };
    const changed: ChangelogEntry = { ...entry('c-applied', 3), kind: 'refinement' };
    const rows = buildJournal([job({ id: 'j' })], [task('t', 1)], [noop, changed]);

    expect(rows.filter((r) => r.chips.includes('all'))).toEqual(rows);
    expect(rows.filter((r) => r.chips.includes('self')).map((r) => r.key))
      .toEqual(['self:c-applied', 'self:c-refused', 'task:t']);
  });

  test('a job that never settled is placed by when it started, not dropped', () => {
    // A cancelled job can carry a null settledAt; createdAt keeps it off the epoch.
    const rows = buildJournal([job({ id: 'j', status: 'cancelled', createdAt: 400, settledAt: null })], [], []);
    expect(rows[0].at).toBe(400);
  });

  test('keys are stable across re-reads, so a poll does not re-key and re-animate the feed', () => {
    const args = [[job({ id: 'j', settledAt: 1 })], [task('t', 2)], [entry('c', 3)]] as const;
    // The second read proves a poll re-keys nothing.
    const first = buildJournal(...args).map((r) => r.key);
    expect(first).toEqual(['self:c', 'task:t', 'job:j']);
    expect(buildJournal(...args).map((r) => r.key)).toEqual(first);
  });

  test('nothing settled is an empty feed, not a throw', () => {
    expect(buildJournal([], [], [])).toEqual([]);
  });
});

/** Queue and journal render the same ledger, so the digest revalidates on the live-data tick, not once at mount. */
describe('the journal reads on the same clock as the queue above it', () => {
  test('the digest revalidates, and no slower than the queue that announces it', () => {
    expect(CHANGELOG_REVALIDATE_MS).toBeGreaterThan(0);
    expect(CHANGELOG_REVALIDATE_MS).toBeLessThanOrEqual(LIVE_DATA_REFRESH_MS);
  });
});

const UNREAD: Rpc = () => Promise.withResolvers<never>().promise;

/** `renderToStaticMarkup` discards effects, so both ledger reads are still out: the opening state. */
function workTabMarkup(jobs: BackgroundJob[], queue: PendingAction[] = [], memory: MemoryEntry[] = []): string {
  return renderToStaticMarkup(createElement(WorkTab, {
    plan: null, planRpc: UNREAD, rpc: UNREAD, pendingActions: queue, backgroundJobs: jobs,
    onRefreshJobs: () => {}, onOpenSurface: () => {}, isStreaming: false, memory,
  }));
}

function sectionTitles(markup: string): string[] {
  return [...markup.matchAll(/class="p-label">([^<]*)</g)].map(([, title]) => title ?? '');
}

/** A running job is a prop and must render without waiting on the plan read. */
describe('Now owes the work in hand whatever the plan read is doing', () => {
  test('a running job renders while the plan read is still out', () => {
    const markup = workTabMarkup([job({ id: 'bgjob-7c1e4a92', kind: 'fork', status: 'running', settledAt: null })]);

    expect(markup).toContain('7c1e4a92');
    expect(sectionTitles(markup)).toEqual(['Now']);
  });

  test('one decision and no work in flight renders Needs you and no journal frame', () => {
    const decision: PendingAction = {
      id: 'apr_1', kind: 'release_approval', title: 'Approve: deploy to production',
      detail: null, at: 0,
    };

    expect(sectionTitles(workTabMarkup([], [decision]))).toEqual(['Needs you', 'Now']);
  });
});

/** Learnings draws only once a note exists, newest first. */
describe('Learnings lists what the workspace remembered', () => {
  const note = (content: string, when = '2026-09-18', by: string | null = 'main'): MemoryEntry => ({
    path: 'memory/MEMORY.md', content, matchScore: 1, updatedAt: when, savedBy: by,
  });

  test('no saved notes, no Learnings frame', () => {
    expect(sectionTitles(workTabMarkup([]))).not.toContain('Learnings');
  });

  test('rows list newest first, each with its stamp and who saved it', () => {
    const markup = workTabMarkup([], [], [
      note('Gateway timeout repair\nretry the upstream fetch', '2026-09-15', 'main'),
      note('Prompt assembles lanes', '2026-09-17', 'worker'),
    ]);

    expect(sectionTitles(markup)).toContain('Learnings');
    expect(markup.indexOf('Prompt assembles lanes')).toBeLessThan(markup.indexOf('Gateway timeout repair'));
    expect(markup).toContain('2026-09-17 · worker');
    expect(markup).toContain('2026-09-15 · main');
  });
});
