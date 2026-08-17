/**
 * What the parent reads back about its children's file changes.
 *
 * A fork used to merge back prose and nothing else, so the one thing a parent
 * most needs after delegating — which files came back changed, and by how much —
 * was not in the answer at all. It is now a deterministic section of the merge
 * the parent continues its turn from: written from the record, not synthesized,
 * because a model paraphrasing a diffstat produces numbers you cannot act on.
 */

import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createHeadsStrategy } from '../src/strategy/heads.js';
import { HeadController } from '../src/heads/controller.js';
import { HeadJournal } from '../src/heads/journal.js';
import { initHeadsTables } from '../src/heads/schema.js';
import { HEAD_FILE_CHANGE_PROVENANCE } from '../src/heads/file-changes.js';
import type { HeadFileChangeSet, HeadReport, MergeResult } from '../src/heads/index.js';
import type { StrategyContext } from '../src/strategy/types.js';
import { Database } from 'bun:sqlite';
import { createTestRuntime, makeSql, makeExecRaw } from './helpers.js';

function mergeWith(fileChanges: readonly HeadFileChangeSet[]): MergeResult {
  return {
    mergedNarrative: 'Both heads landed their part of the router change.',
    selectedDecisions: [], unresolvedQuestions: [], recommendations: [], blindSpots: [],
    evidenceAggregate: [], headIds: ['h-lexer', 'h-grammar'],
    headScores: [], fileChanges, grounded: false,
    costSummary: {
      headCount: 2, headsWithFindings: 2, totalTokens: 1200, totalWallClockMs: 4000, maxDepth: 3,
    },
  };
}

function ctxFor(merge: MergeResult): StrategyContext {
  const { rt } = createTestRuntime();
  const controller = new HeadController({
    spawnHead: async () => { throw new Error('strategy test replaces controller.run'); },
    mergeLLM: async () => { throw new Error('strategy test replaces controller.run'); },
  }, new HeadJournal(rt.storage.sql));
  controller.run = async () => merge;
  return {
    task: 't',
    mode: 'build',
    rt,
    model: new MockLanguageModelV3(),
    options: {
      heads: {
        controller,
        heads: [{ task: 'a', rationale: 'r' }],
      },
    },
  };
}

const CHANGES: HeadFileChangeSet[] = [
  {
    id: 'h-lexer',
    changes: [
      { path: '/workspace/src/lexer.ts', status: 'changed', added: 18, removed: 4 },
      { path: '/workspace/src/lexer.test.ts', status: 'added', added: 62, removed: 0 },
    ],
  },
  {
    id: 'h-grammar',
    changes: [{ path: '/workspace/src/grammar.ts', status: 'changed', added: 3, removed: 41 }],
  },
];

describe("the merge the parent reads back names each head's file changes", () => {
  test('renders path and +/- per file, per head, verbatim', async () => {
    const result = await createHeadsStrategy().explore(ctxFor(mergeWith(CHANGES)));
    expect(result.best.text).toContain([
      '### Files changed',
      'Head h-lexer',
      '  M  /workspace/src/lexer.ts  +18 −4',
      '  A  /workspace/src/lexer.test.ts  +62 −0',
      'Head h-grammar',
      '  M  /workspace/src/grammar.ts  +3 −41',
      '',
      `_${HEAD_FILE_CHANGE_PROVENANCE}_`,
    ].join('\n'));
  });

  test('a head that touched nothing is not given a heading', async () => {
    const result = await createHeadsStrategy().explore(ctxFor(mergeWith([CHANGES[1]!])));
    expect(result.best.text).toContain('Head h-grammar');
    expect(result.best.text).not.toContain('Head h-lexer');
  });

  test('a split that changed nothing emits no section at all', async () => {
    const result = await createHeadsStrategy().explore(ctxFor(mergeWith([])));
    expect(result.best.text).not.toContain('Files changed');
  });

  test('the strategy cost carries the distinct file count, and omits it when there is none', async () => {
    const changed = await createHeadsStrategy().explore(ctxFor(mergeWith(CHANGES)));
    expect(changed.cost.filesChanged).toBe(3);
    const untouched = await createHeadsStrategy().explore(ctxFor(mergeWith([])));
    expect(untouched.cost.filesChanged).toBeUndefined();
  });

  test('every file is named however many there are — no "first N" summary', async () => {
    const many: HeadFileChangeSet[] = [{
      id: 'h-wide',
      changes: Array.from({ length: 400 }, (_, i) => ({
        path: `/workspace/src/f${String(i).padStart(3, '0')}.ts`, status: 'changed' as const,
        added: 1, removed: 1,
      })),
    }];
    const result = await createHeadsStrategy().explore(ctxFor(mergeWith(many)));
    expect(result.best.text).toContain('/workspace/src/f000.ts');
    expect(result.best.text).toContain('/workspace/src/f399.ts');
    expect(result.cost.filesChanged).toBe(400);
  });
});

describe('the head journal makes a split\'s file changes queryable', () => {
  test('a recorded report round-trips, and heads that changed nothing are absent', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db));
    const journal = new HeadJournal(makeSql(db));
    const base = {
      rootId: 'run-1', parentId: null, depth: 0, rationale: 'r',
      mode: 'build' as const,
      inheritedContext: [], budget: { maxDepth: 3, spawnedAt: 1 },
      mergeStrategy: 'synthesize' as const,
    };
    journal.recordSplit('run-1', 'r', 1);
    journal.insertSpawn({ ...base, id: 'h-lexer', task: 'lex' });
    journal.insertSpawn({ ...base, id: 'h-quiet', task: 'read' });

    const report = (id: string, fileChanges: HeadReport['fileChanges']): HeadReport => ({
      id, status: 'completed', summary: 's',
      evidence: [], decisions: [], artifactRefs: [], fileChanges,
      childHeadIds: [], toolCalls: [], stepCount: 0,
      tokenUsage: { input: 1, output: 1, total: 2 }, wallClockMs: 5,
    });
    journal.recordReport(report('h-lexer', CHANGES[0]!.changes));
    journal.recordReport(report('h-quiet', []));

    expect(journal.readFileChanges('run-1')).toEqual([CHANGES[0]!]);
  });

  test('a journal created before the column exists gains it', () => {
    const db = new Database(':memory:');
    // The shape a live agent's journal already has: no file_changes_json, and
    // CREATE TABLE IF NOT EXISTS will not add one.
    db.exec(`CREATE TABLE head_journal (
      id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL,
      task TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL, spawned_at INTEGER NOT NULL,
      completed_at INTEGER, token_input INTEGER DEFAULT 0, token_output INTEGER DEFAULT 0,
      wall_clock_ms INTEGER DEFAULT 0, summary TEXT, error_message TEXT,
      decisions_json TEXT, artifacts_json TEXT, tool_calls_json TEXT, child_head_ids_json TEXT,
      merge_strategy TEXT NOT NULL DEFAULT 'synthesize')`);
    initHeadsTables(makeExecRaw(db));
    const journal = new HeadJournal(makeSql(db));
    journal.insertSpawn({
      id: 'h', rootId: 'run-2', parentId: null, depth: 0, task: 't', rationale: 'r',
      mode: 'build',
      inheritedContext: [], budget: { maxDepth: 3, spawnedAt: 1 }, mergeStrategy: 'synthesize',
    });
    journal.recordReport({
      id: 'h', status: 'completed', summary: 's',
      evidence: [], decisions: [], artifactRefs: [], fileChanges: CHANGES[1]!.changes,
      childHeadIds: [], toolCalls: [], stepCount: 0,
      tokenUsage: { input: 1, output: 1, total: 2 }, wallClockMs: 5,
    });
    expect(journal.readFileChanges('run-2')).toEqual([{ id: 'h', changes: CHANGES[1]!.changes }]);
  });
});
