/**
 * Search isolation — one runMCTS call may only ever read, expand and settle its
 * OWN tree.
 *
 * Selection, pruning and convergence used to scan `search_nodes` globally and
 * relied on a single invariant to stay correct: "nothing stays open across
 * tasks", enforced only by the tree close at the end of a successful converge().
 * Every way of not reaching that close — an eviction, an aborted turn, a
 * convergence that throws — left the invariant broken, and a converged search's
 * terminal winner was never excluded at all. These tests pin the invariant to
 * the data (`root_id`) instead of to the happy path.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, createMockSession, makeSql } from './helpers';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { initCraftScoreTables } from '../src/craft/schemas';
import { MctsSearchStore, initMctsSearchTable } from '../src/mcts/search-store';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { LLM } from '../src/types/primitives';

function initTables(rt: AgentRuntime): void {
  initSearchTables(rt.storage.execRaw, rt.storage.sql);
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  initCraftScoreTables(rt.storage.execRaw);
  initMctsSearchTable(rt.storage.execRaw, rt.storage.sql);
}

/** An LLM whose judge verdicts are controlled per-search, so one search can be
 *  made to score higher than the next. */
function scriptedLLM(score: () => number, onSummary: () => string): LLM {
  return {
    stream() { throw new Error('MCTS never streams — branches are mocked'); },
    async complete(prompt: string) {
      if (prompt.includes('Summarize in')) return onSummary();
      return JSON.stringify({ score: score(), rationale: 'scripted' });
    },
  };
}

function nodesOf(db: Database, rootId: string): Array<{ id: string; status: string; task: string }> {
  return db.query<{ id: string; status: string; task: string }, [string]>(
    'SELECT id, status, task FROM search_nodes WHERE root_id = ?',
  ).all(rootId);
}

function rootIdOfNode(db: Database, nodeId: string): string | null {
  return db.query<{ root_id: string | null }, [string]>(
    'SELECT root_id FROM search_nodes WHERE id = ?',
  ).get(nodeId)?.root_id ?? null;
}

function requiredRootId(db: Database, nodeId: string): string {
  const rootId = rootIdOfNode(db, nodeId);
  if (!rootId) throw new Error(`Expected node '${nodeId}' to belong to a search tree`);
  return rootId;
}

describe('MCTS search isolation', () => {
  test('a convergence that throws settles the search as failed, not converged, and leaves no open node', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db));
    // converge() awaits a summary call after the branches are scored; failing it
    // is the cheapest faithful stand-in for "the settle work did not complete".
    rt.llm = scriptedLLM(() => 0.9, () => { throw new Error('summary model down'); });
    rt.judgeModel = rt.llm;

    await expect(runMCTS(rt, createMockSession(), 'a task that cannot settle', {
      budget: 1, branches: 1, search: store,
    })).rejects.toThrow('summary model down');

    const run = db.query<{ root_id: string }, []>('SELECT root_id FROM mcts_search_runs').get();
    if (!run) throw new Error('Expected a durable MCTS search run');
    const rootId = run.root_id;
    // The durable record must never claim an outcome the search did not reach.
    expect(store.get(rootId)?.status).toBe('failed');
    // And the tree must be retired, so nothing here is selectable ever again.
    expect(nodesOf(db, rootId).map(n => n.status)).not.toContain('open');
    expect(store.findResumable('a task that cannot settle')).toBeNull();
  });

  test('a new search cannot converge onto a previous search\'s terminal winner', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    let score = 0.95;
    rt.llm = scriptedLLM(() => score, () => 'summary');
    rt.judgeModel = rt.llm;

    const first = await runMCTS(rt, createMockSession(), 'TASK ONE', { budget: 1, branches: 1 });
    expect(first.converged).toBe(true);

    // The second task scores strictly worse than the first search's winner, so
    // a global argmax over terminal/open nodes would hand it the wrong answer.
    score = 0.4;
    const second = await runMCTS(rt, createMockSession(), 'TASK TWO', { budget: 1, branches: 1 });

    expect(second.winnerId).not.toBe(first.winnerId);
    const secondRoot = requiredRootId(db, second.winnerId);
    expect(secondRoot).not.toBe(rootIdOfNode(db, first.winnerId));
    expect(nodesOf(db, secondRoot).every(n => n.task === 'TASK TWO')).toBe(true);

    const history = db.query<{ task: string }, []>('SELECT task FROM task_history ORDER BY rowid').all();
    expect(history.map(h => h.task)).toEqual(['TASK ONE', 'TASK TWO']);
  });

  test('a search abandoned mid-run cannot capture a later search\'s budget', async () => {
    const { rt, db } = createTestRuntime();
    initTables(rt);
    const store = new MctsSearchStore(makeSql(db));
    rt.llm = scriptedLLM(() => 0.9, () => 'summary');
    rt.judgeModel = rt.llm;

    // Search A is evicted after one iteration: its tree stays open and its
    // durable row stays 'running' (that is what makes it resumable).
    const ctrl = new AbortController();
    await expect(runMCTS(rt, createMockSession(), 'ABANDONED', {
      budget: 4, branches: 2, search: store, signal: ctrl.signal,
      onProgress: (e) => { if (e.type === 'iteration-complete') ctrl.abort(new Error('evicted')); },
    })).rejects.toThrow();
    const abandoned = store.findResumable('ABANDONED');
    expect(abandoned).not.toBeNull();
    if (!abandoned) throw new Error('Expected the evicted search to remain resumable');
    const openBefore = nodesOf(db, abandoned.rootId).filter(n => n.status === 'open').length;
    expect(openBefore).toBeGreaterThan(0);

    // Search B runs a different task while A's tree is still open.
    const second = await runMCTS(rt, createMockSession(), 'LATER', { budget: 2, branches: 2 });

    const laterRoot = requiredRootId(db, second.winnerId);
    expect(laterRoot).not.toBe(abandoned.rootId);
    expect(nodesOf(db, laterRoot).every(n => n.task === 'LATER')).toBe(true);
    // B neither expanded under A's frontier nor closed it — A stays resumable.
    expect(nodesOf(db, abandoned.rootId).filter(n => n.status === 'open').length).toBe(openBefore);
    expect(store.findResumable('ABANDONED')?.rootId).toBe(abandoned.rootId);
  });
});
