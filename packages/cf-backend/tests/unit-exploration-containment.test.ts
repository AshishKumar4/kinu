import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HeadController,
  HeadJournal,
  initHeadsTables,
  type HeadInput,
  type HeadReport,
  type HeadRuntime,
  type MergeOutput,
  type SqlExecutor,
} from '@proteus/core';

function makeSql(db: Database): SqlExecutor {
  return function <T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
    const query = strings.reduce((sql, part, index) => sql + part + (index < values.length ? '?' : ''), '');
    const statement = db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...values) as T[];
    statement.run(...values);
    return [];
  } as SqlExecutor;
}

function report(id: string): HeadReport {
  return {
    id,
    status: 'completed',
    summary: `completed ${id}`,
    evidence: [],
    decisions: [],
    artifactRefs: [],
    childHeadIds: [],
    toolCalls: [],
    steps: [],
    tokenUsage: { input: 1, output: 1, total: 2 },
    wallClockMs: 1,
  };
}

const mergeOutput: MergeOutput = {
  narrative: 'merged child findings',
  selected_decisions: [],
  unresolved_questions: [],
  recommendations: [],
};

describe('ExplorationAgent containment', () => {
  test('heads remain bare Agents with no ActorAgent tool surface', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'exploration.ts'), 'utf8');
    expect(source).toContain('export class ExplorationAgent extends Agent<Env>');
    expect(source).not.toContain('class ExplorationAgent extends ActorAgent');
    expect(source).not.toContain('this.rt');

    const toolBuilder = source.slice(
      source.indexOf('  private buildHeadTools('),
      source.indexOf('  // ── Recursive split'),
    );
    expect(toolBuilder).toContain('split_subheads: tool({');
    expect(toolBuilder).not.toMatch(/\bthink\s*:/);
    expect(toolBuilder).not.toMatch(/\bteam\s*:/);
    expect(toolBuilder).not.toMatch(/\bpeers\s*:/);
    expect(toolBuilder).toContain('facet.runRecursiveSplit(');
  });

  test('the recursive split controller decrements maxDepth for spawned subheads', async () => {
    const db = new Database(':memory:');
    initHeadsTables((ddl) => db.exec(ddl));
    const spawned: HeadInput[] = [];
    const runtime: HeadRuntime = {
      async spawnHead(input) {
        spawned.push(input);
        return {
          id: input.id,
          async run() { return report(input.id); },
          async abort() {},
        };
      },
      async mergeLLM() { return mergeOutput; },
    };
    const controller = new HeadController(runtime, new HeadJournal(makeSql(db)));

    await controller.run({
      parentHeadId: 'parent-head',
      rootId: 'root-head',
      inheritedContext: [],
      request: {
        rationale: 'split the investigation',
        heads: [
          { task: 'child one', rationale: 'first angle' },
          { task: 'child two', rationale: 'second angle' },
        ],
      },
      parentBudget: {
        maxDepth: 2,
        maxTokens: 10_000,
        maxWallClockMs: 60_000,
        spawnedAt: Date.now(),
      },
    });

    expect(spawned).toHaveLength(2);
    expect(spawned.map((input) => input.budget.maxDepth)).toEqual([1, 1]);
    expect(spawned.map((input) => input.depth)).toEqual([1, 1]);
  });
});
