/**
 * The Work surface's journal is ONE stream out of three ledgers, and plans
 * appear on it exactly once.
 *
 * Tasks, Jobs and the Evolution Changelog share it, because a tab each puts
 * "what happened while I was away" four clicks away and lands the reader in two
 * rooms that are mostly air. The merge only buys anything if the three actually
 * interleave by time — three blocks stacked under one heading would be the
 * same four rooms with the walls painted over. The live plan already has its
 * home in `WorkPlans` above (B12), so the journal carries no second Plan chip:
 * closed tasks ride `self` as settled history, and exactly one plan-bearing
 * tab renders.
 *
 * `All` is the whole feed: the needs-you row above counts an unseen
 * self-change off the same unfiltered read this feed renders and tells the
 * reader to read it below, so a chip that dropped one of those entries pointed
 * at a feed without it. `changesOnly` is the read named for curation. Now owes
 * the work in hand for the same reason — a running job is a prop, not a read,
 * so it renders whatever the plan read is doing.
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

    // …and each chip selects exactly its own rows out of that one list, while
    // All holds every one of them. The closed task rides `self` beside the
    // changelog entry, never a second Plan.
    expect(rows.filter((r) => r.chips.includes('jobs'))).toHaveLength(1);
    expect(rows.filter((r) => r.chips.includes('self'))).toHaveLength(2);
    expect(rows.flatMap((r) => r.chips)).not.toContain('plan');
    expect(rows.filter((r) => r.chips.includes('all'))).toHaveLength(3);
  });

  test('a self-change that changed nothing rides All beside the runs that moved something', () => {
    // OWNER, 2026-09-17: "how is that 'All' then?" — the queue above counts an
    // unseen no-op off the same unfiltered digest read and sends the reader
    // here, so the chip named for everything holds every row. `changesOnly`
    // (core buildChangelog) is where a feed that drops them is named for it.
    const noop: ChangelogEntry = { ...entry('c-refused', 2), kind: 'refinement', noChange: true };
    const changed: ChangelogEntry = { ...entry('c-applied', 3), kind: 'refinement' };
    const rows = buildJournal([job({ id: 'j' })], [task('t', 1)], [noop, changed]);

    expect(rows.filter((r) => r.chips.includes('all'))).toEqual(rows);
    expect(rows.filter((r) => r.chips.includes('self')).map((r) => r.key))
      .toEqual(['self:c-applied', 'self:c-refused', 'task:t']);
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

/** Never answers, so nothing a read would deliver reaches the markup below. */
const UNREAD: Rpc = () => Promise.withResolvers<never>().promise;

/** The tab as the static renderer sees it: `useAsyncResource` fetches inside an
 *  effect, which `renderToStaticMarkup` discards, so both ledger reads are
 *  still out — the state the tab opens in. The queue and the jobs are props and
 *  wait for no read at all. */
function workTabMarkup(jobs: BackgroundJob[], queue: PendingAction[] = [], memory: MemoryEntry[] = []): string {
  return renderToStaticMarkup(createElement(WorkTab, {
    plan: null, planRpc: UNREAD, rpc: UNREAD, pendingActions: queue, backgroundJobs: jobs,
    onRefreshJobs: () => {}, onOpenSurface: () => {}, isStreaming: false, memory,
  }));
}

/** Every section heading the markup mounted, in order. */
function sectionTitles(markup: string): string[] {
  return [...markup.matchAll(/class="p-label">([^<]*)</g)].map(([, title]) => title ?? '');
}

/**
 * Now is two ledgers — the plan's open half and the jobs still running — and it
 * owed the second to a read of the first: a running job sat behind the plan's
 * spinner and disappeared with its failure, which is the one piece of work on
 * this tab that needs no read to render.
 */
describe('Now owes the work in hand whatever the plan read is doing', () => {
  test('a running job renders while the plan read is still out', () => {
    const markup = workTabMarkup([job({ id: 'bgjob-7c1e4a92', kind: 'fork', status: 'running', settledAt: null })]);

    // The job's own ledger id, as the card prints it.
    expect(markup).toContain('7c1e4a92');
    // …and nothing else drew a frame: no queue, and a journal nobody has read.
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

/**
 * Learnings is the workspace's own memory — the same `getMemoryContent` read
 * the Agent surface renders whole — so it draws only once a note exists, and
 * newest first, the order a reader returns to them in.
 */
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
