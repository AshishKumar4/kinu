/**
 * The Work journal interleaves Tasks, Jobs and the Evolution Changelog by time, with no second Plan chip
 * (the live plan lives in `WorkPlans`, B12). `All` is the whole feed: the needs-you row counts off it.
 */
import './helpers/ui-module-globals';
import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentTaskTree, ChangelogEntry, MemoryEntry, PanelAgent, PendingAction, Rpc, WorkspaceWorkOwner } from '@kinu.run/core';
import type { BackgroundJob } from '@kinu.run/core/protocol';
import { buildJournal, WorkTab } from '../src/components/surfaces/WorkTab';
import { HelperRow, TaskTree } from '../src/components/surfaces/work-tasks';

function job(over: Partial<BackgroundJob> & { id: string }): BackgroundJob {
  return {
    kind: 'shell', label: null, workMode: 'build', status: 'completed', result: null, error: null,
    createdAt: 0, settledAt: 0, ...over,
  };
}

function task(id: string, updatedAt: number): AgentTaskTree {
  return { id, parentId: null, title: id, status: 'done', updatedAt, note: null, subtasks: [] };
}

const MAIN: WorkspaceWorkOwner = { actorId: 'actor-main', name: 'main', title: 'main', retired: false, path: [] };

/** A closed task as the Work read hands it: with the owner it belongs to. */
function closed(id: string, updatedAt: number, owner: WorkspaceWorkOwner = MAIN) {
  return { task: task(id, updatedAt), owner };
}

function entry(id: string, at: number): ChangelogEntry {
  return { id, kind: 'tool', at, summary: id, evidence: '' };
}

describe('the work journal', () => {
  test('interleaves jobs, closed plan items and self-changes by time, newest first', () => {
    const rows = buildJournal(
      [job({ id: 'j-old', settledAt: 100 }), job({ id: 'j-new', settledAt: 500 })],
      [closed('t-mid', 300)],
      [entry('c-newest', 700), entry('c-oldest', 50)],
    );

    expect(rows.map((r) => r.key)).toEqual([
      'self:c-newest', 'job:j-new', 'task:actor-main:t-mid', 'job:j-old', 'self:c-oldest',
    ]);
  });

  test('every row carries the chips it answers to, so the chips are views over one list', () => {
    const rows = buildJournal([job({ id: 'j' })], [closed('t', 1)], [entry('c', 2)]);
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
    const rows = buildJournal([job({ id: 'j' })], [closed('t', 1)], [noop, changed]);

    expect(rows.filter((r) => r.chips.includes('all'))).toEqual(rows);
    expect(rows.filter((r) => r.chips.includes('self')).map((r) => r.key))
      .toEqual(['self:c-applied', 'self:c-refused', 'task:actor-main:t']);
  });

  test('a job that never settled is placed by when it started, not dropped', () => {
    // A cancelled job can carry a null settledAt; createdAt keeps it off the epoch.
    const rows = buildJournal([job({ id: 'j', status: 'cancelled', createdAt: 400, settledAt: null })], [], []);
    expect(rows[0].at).toBe(400);
  });

  test('keys are stable across re-reads, so a poll does not re-key and re-animate the feed', () => {
    const args = [[job({ id: 'j', settledAt: 1 })], [closed('t', 2)], [entry('c', 3)]] as const;
    // The second read proves a poll re-keys nothing.
    const first = buildJournal(...args).map((r) => r.key);
    expect(first).toEqual(['self:c', 'task:actor-main:t', 'job:j']);
    expect(buildJournal(...args).map((r) => r.key)).toEqual(first);
  });

  test('a finished task keeps the owner it belongs to, so a helper with no tab still opens from it', () => {
    const helper: WorkspaceWorkOwner = { actorId: 'actor-refiner', name: 'ask-refiner-fb0gr9', title: 'ask-refiner-fb0gr9', retired: true, path: ['ask-refiner-fb0gr9'] };
    const [row] = buildJournal([], [closed('t', 1, helper)], []);

    expect(row?.kind === 'task' ? row.owner : null).toEqual(helper);
  });

  test('nothing settled is an empty feed, not a throw', () => {
    expect(buildJournal([], [], [])).toEqual([]);
  });
});

const UNREAD: Rpc = () => Promise.withResolvers<never>().promise;

/** `renderToStaticMarkup` discards effects, so both ledger reads are still out: the opening state. */
function workTabMarkup(jobs: BackgroundJob[], queue: PendingAction[] = [], memory: MemoryEntry[] = [], agents: PanelAgent[] = []): string {
  return renderToStaticMarkup(createElement(WorkTab, {
    plan: null, planRpc: UNREAD, rpc: UNREAD, pendingActions: queue, backgroundJobs: jobs,
    onRefreshJobs: () => {}, onOpenSurface: () => {}, memory, agents: { list: agents, open: () => {} },
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

  // Main, 2026-10-02: the card named a job by its kind and the TUI by its label. Every surface names it the one way
  // core does: its label, else its kind, then its short id.
  test("a job's card names it by its label, then its short id", () => {
    const labeled = workTabMarkup([job({ id: 'bgjob-4e1a77c0aa11', label: 'workspace: bun run build', status: 'running', settledAt: null })]);
    expect(labeled.indexOf('>workspace: bun run build<')).toBeGreaterThan(-1);
    expect(labeled.indexOf('>4e1a77c0<')).toBeGreaterThan(labeled.indexOf('>workspace: bun run build<'));
    expect(labeled).not.toContain('>shell<');

    const unlabeled = workTabMarkup([job({ id: 'bgjob-9f00aa11', label: '', status: 'running', settledAt: null })]);
    expect(unlabeled.indexOf('>shell<')).toBeGreaterThan(-1);
    expect(unlabeled.indexOf('>9f00aa11<')).toBeGreaterThan(unlabeled.indexOf('>shell<'));
  });

  // Main's queue, 2026-10-02: a long build showed nothing until it finished. A running job's card shows the last
  // lines its frames told; a settled one shows its result as before.
  test("a running job's card shows the last lines it printed, and a settled job's its result", () => {
    const output = {
      seq: 3, omitted: 0,
      chunks: [{ stream: 'stdout' as const, text: 'one\ntwo\nthree\n' }, { stream: 'stderr' as const, text: 'warn: four\nfive\n' }],
    };

    const running = workTabMarkup([job({ id: 'bgjob-5d0c2b11', status: 'running', settledAt: null, output })]);
    expect(running).toContain('two\nthree\nwarn: four\nfive');
    expect(running).not.toContain('one\n');

    const settled = workTabMarkup([job({ id: 'bgjob-5d0c2b11', status: 'completed', result: 'built', output })]);
    expect(settled).not.toContain('warn: four');
  });

  test('one decision and no work in flight renders Needs you and no journal frame', () => {
    const decision: PendingAction = {
      id: 'defer-1', kind: 'deferred_action', title: 'Approve: a command the agent wants to run on device',
      detail: 'bun run db:migrate', at: 0,
    };

    expect(sectionTitles(workTabMarkup([], [decision]))).toEqual(['Needs you', 'Now']);
  });
});

describe('an evolution helper is a Now row that opens its chat', () => {
  const agent = (label: string, category: PanelAgent['category']): PanelAgent => ({
    key: `actor-${label}`, label, category, activity: 'working', parent: null,
    open: { kind: 'chat', path: `ask-${label}` }, tab: false, input: category !== 'background', figures: { activeMs: 0, cacheEma: null },
  });

  test('a background helper is listed in Now and a hired agent is not', () => {
    const markup = workTabMarkup([], [], [], [agent('Refiner', 'background'), agent('Builder', 'hired')]);

    expect(sectionTitles(markup)).toEqual(['Now']);
    expect(markup).toContain('Refiner');
    expect(markup).not.toContain('Builder');
  });

  test('its row opens that helper through the opener the Agents panel uses', () => {
    const refiner = agent('Refiner', 'background');
    const opened: PanelAgent[] = [];
    const row = HelperRow({ agent: refiner, onOpen: (open) => { opened.push(open); } });

    row.props.onClick();

    expect(opened).toEqual([refiner]);
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

/** A helper's tab is gone, so the task it owns is the door to its conversation. */
describe('a task names its owner, and a subordinate owner opens from the row', () => {
  const owner = (name: string, path: string[] | null): WorkspaceWorkOwner => ({ actorId: `actor-${name}`, name, title: name, retired: false, path });
  const open = { ...task('Tighten the turn-ending rule', 0), status: 'active' as const };

  const row = (shown: WorkspaceWorkOwner) => renderToStaticMarkup(createElement(TaskTree, { task: open, owner: shown, onOpenOwner: () => {} }));

  test('a helper\'s task names it, and its owner is a control that opens that helper\'s conversation, at any depth', () => {
    for (const path of [['ask-refiner-fb0gr9'], ['auditor', 'ask-refiner-fb0gr9']]) {
      expect(row(owner('ask-refiner-fb0gr9', path))).toContain('aria-label="Open ask-refiner-fb0gr9&#x27;s conversation"');
    }
  });

  test('the workspace\'s own task and one past a head name their owner and offer no door', () => {
    for (const shown of [owner('workspace', []), owner('ask-reader-b2', null)]) {
      expect(row(shown)).toContain(shown.name);
      expect(row(shown)).not.toContain('<button');
    }
  });
});
