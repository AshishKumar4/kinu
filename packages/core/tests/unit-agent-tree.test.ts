// Defends: `agents.list` showing a hire more than its own subtree and its peers (Main and the person's agents, each
// alone), a retired agent listed unasked, a running agent ranked below an idle one, rows past the cap dropped without
// being counted, and a report the caller has not read left unsaid.
import { describe, expect, test } from 'bun:test';
import { agentTree, AGENT_TREE_LIMIT, unreadReports } from '../src/delegation/agent-tree';
import type { KinuEvent, PendingFilter } from '../src/events/hub/index';
import { NO_FIGURES } from '../src/read-models/agent-figures';
import type { AgentActivity, PanelAgent } from '../src/read-models/workspace-agents';

const NOW = Date.now();

function hire({ key, path, parent, activity, lastActiveAt, doing }: {
  readonly key: string;
  readonly path: string;
  readonly parent: string;
  readonly activity: AgentActivity;
  readonly lastActiveAt?: number;
  readonly doing?: string;
}): PanelAgent {
  return {
    key, label: path.split('/').at(-1) ?? path, category: 'hired', activity, parent, open: { kind: 'chat', path }, tab: false, input: true,
    actorId: key, colour: 1, figures: { ...NO_FIGURES, ...(lastActiveAt !== undefined && { lastActiveAt }) }, ...(doing !== undefined && { doing }),
  };
}

const MAIN: PanelAgent = {
  key: 'main', label: 'Main', category: 'main', activity: 'working', parent: null, open: { kind: 'chat', path: null }, tab: true, input: true,
  actorId: 'a-main', colour: 0, figures: NO_FIGURES,
};

/** An agent the person made at the top level, under Main, as the read model has it (`category: 'user'`). */
function chat({ key, path, activity, lastActiveAt }: { readonly key: string; readonly path: string; readonly activity: AgentActivity; readonly lastActiveAt?: number }): PanelAgent {
  return { ...hire({ key, path, parent: 'main', activity, ...(lastActiveAt !== undefined && { lastActiveAt }) }), category: 'user', tab: true };
}

/**
 * Main hired `lead`, which hired `ledger` (working) and `docs` (idle); Main also hired `old`, since dismissed. The person
 * made `research` (working), which hired `notes`, and `drafts`, since dismissed.
 */
const WORKSPACE: readonly PanelAgent[] = [
  MAIN,
  chat({ key: 'a-research', path: 'research', activity: 'working', lastActiveAt: NOW - 1_000 }),
  hire({ key: 'a-notes', path: 'research/notes', parent: 'a-research', activity: 'idle', lastActiveAt: NOW - 2_000 }),
  chat({ key: 'a-drafts', path: 'drafts', activity: 'dismissed', lastActiveAt: NOW - 3_000 }),
  hire({ key: 'a-lead', path: 'lead', parent: 'main', activity: 'idle', lastActiveAt: NOW - 60_000 }),
  hire({ key: 'a-old', path: 'old', parent: 'main', activity: 'dismissed', lastActiveAt: NOW - 10_000 }),
  hire({ key: 'a-docs', path: 'lead/docs', parent: 'a-lead', activity: 'idle', lastActiveAt: NOW - 5_000 }),
  hire({ key: 'a-ledger', path: 'lead/ledger', parent: 'a-lead', activity: 'working', lastActiveAt: NOW - 120_000, doing: 'Move the ledger to integer cents.' }),
  {
    key: 'run-1/n1', label: 'Try a lock-free queue', category: 'swarm', activity: 'done', parent: 'a-lead',
    open: { kind: 'node', runId: 'run-1', nodeId: 'n1', owner: 'lead' }, tab: false, input: false, colour: 1, figures: NO_FIGURES,
  },
];

const view = (owner: string, extra: Partial<Parameters<typeof agentTree>[0]> = {}) =>
  agentTree({ agents: WORKSPACE, owner, unread: new Map(), retired: false, limit: AGENT_TREE_LIMIT, ...extra });

describe('the agents tree', () => {
  test('main sees the whole workspace in preorder, running before idle, and each row says where it sits', () => {
    const { tree, counts, note } = view('main');

    expect(tree.map((row) => [row.name, row.depth, row.status])).toEqual([
      ['main', 0, 'running'], ['research', 1, 'running'], ['notes', 2, 'idle'], ['lead', 1, 'idle'], ['ledger', 2, 'running'], ['docs', 2, 'idle'],
    ]);

    expect(tree[0]).toMatchObject({ you: true, kind: 'main', active: 'now' });
    expect(tree[4]).toMatchObject({ kind: 'hired', active: 'now', doing: 'Move the ledger to integer cents.' });
    expect(tree[5]?.active).toBe('just now');
    expect(tree.some((row) => row.peer === true)).toBe(false);
    expect(counts).toEqual({ running: 2, waiting: 0, idle: 3, failed: 0, retired: 3, shown: 6, notShown: 0 });
    expect(note).toBe('3 retired not listed: list({retired:true}) lists them.');
  });

  test("a middle hire sees itself and what it started, then Main and the person's agents as peers, never its hirer's other hires", () => {
    const { tree, counts } = view('a-lead');

    expect(tree.map((row) => [row.name, row.peer ?? false])).toEqual([
      ['lead', false], ['ledger', false], ['docs', false], ['main', true], ['research', true],
    ]);
    expect(tree[0]).toMatchObject({ you: true, depth: 1 });
    // Counted as listed: `research`'s own hire is not walked, and `drafts` is retired.
    expect(counts).toEqual({ running: 3, waiting: 0, idle: 1, failed: 0, retired: 2, shown: 5, notShown: 0 });
  });

  test("an agent the person made sees its own subtree, then Main and the person's other agents, retired ones when asked", () => {
    expect(view('a-research').tree.map((row) => [row.name, row.peer ?? false])).toEqual([['research', false], ['notes', false], ['main', true]]);
    expect(view('a-research', { retired: true }).tree.map((row) => row.name)).toEqual(['research', 'notes', 'main', 'drafts']);
  });

  test('retired agents are listed when asked for, after the live ones', () => {
    expect(view('main', { retired: true }).tree.map((row) => row.name))
      .toEqual(['main', 'research', 'notes', 'lead', 'ledger', 'docs', 'Try a lock-free queue', 'drafts', 'old']);
  });

  test('past the limit the rest is counted and said, never silently dropped', () => {
    const { tree, counts, note } = view('main', { limit: 2 });

    expect(tree.map((row) => row.name)).toEqual(['main', 'research']);
    expect(counts).toMatchObject({ shown: 2, notShown: 4 });
    expect(note).toContain('4 not shown: list({limit}) shows up to 200');
  });

  test('a report the caller has not read is counted on its own child only', () => {
    const unread = new Map([['lead', 2], ['ledger', 1]]);

    expect(view('main', { unread }).tree.map((row) => [row.name, row.unreadReports])).toEqual([
      ['main', undefined], ['research', undefined], ['notes', undefined], ['lead', 2], ['ledger', undefined], ['docs', undefined],
    ]);
  });
});

describe('the caller\'s unread reports', () => {
  // `pending` answers a drain's batch unless told otherwise: past it, a child's reports were once not counted.
  test('are every report pending, past a drain\'s batch', () => {
    const report = (n: number): KinuEvent => ({
      id: `e${String(n)}`, trace_id: `e${String(n)}`, caused_by: null, ingress: 'subagent', variant: 'subagent_report', trust: 'authenticated',
      priority: 'normal', payload_visibility: 'full', received_at: n, reply_channel: null, dedupe_key: null,
      payload: { from_subagent: n < 60 ? 'lead' : 'docs', status: 'completed', content: 'Done.', sequence_id: `s${String(n)}`, kinu_mode: 'build' },
    });

    const pending = Array.from({ length: 70 }, (_, n) => report(n));

    expect(unreadReports({ pending: (filter: PendingFilter) => pending.slice(0, filter.limit ?? 50) })).toEqual(new Map([['lead', 60], ['docs', 10]]));
  });
});
