import { describe, expect, test } from 'bun:test';
import { baselineOf, joinReports, restamp, taskKey, type TaskKey } from './gate';

const KEY: TaskKey = {
  build: 'f41eb85615', version: '77b6f49c-8934-457c-a0e3-98868f1196f1', origin: 'https://kinu.run', definitions: 'tree-1',
  task: 'order-book.eval.ts',
  models: ['opencode-go/muse-spark-1.3-contributor'], arms: ['product'], trials: 5,
};

/** One task's report as the runner writes it, one trial long. */
function report(task: string, stamp = { productSha: 'old-build', evalCommit: 'old-commit' }): string {
  return JSON.stringify({ testResults: [{
    name: `/repo/evals/tasks/${task}`,
    assertionResults: [{ status: 'passed', meta: { harness: { run: { session: { metadata: { ...stamp, trial: 1 } } } } } }],
  }] });
}

describe('a task\'s stored result', () => {
  // A stored result is reused only while nothing it measured has changed: each of these is a thing it measured.
  test('is reused under the same key, and under no key that differs in the build, its version, the definitions, the task or the matrix', () => {
    const variants: readonly Partial<TaskKey>[] = [
      {}, { build: '7db1093f39' }, { version: '1a8e2b7c-0d44-4f1e-9c3a-5b6d7e8f9a0b' }, { version: null },
      { origin: 'https://staging.kinu.run' }, { definitions: 'tree-2' }, { task: 'budget-board.eval.ts' },
      { models: ['workers-ai/@cf/zai-org/glm-5.3'] }, { arms: ['product', 'lean'] }, { trials: 10 },
    ];

    expect(new Set([taskKey(KEY), taskKey({ ...KEY })]).size).toBe(1);
    expect(new Set(variants.map((changed) => taskKey({ ...KEY, ...changed }))).size).toBe(variants.length);
  });

  test('says the build and commit of the run that reuses it', () => {
    expect(JSON.parse(restamp(report('order-book.eval.ts'), { productSha: 'new-build', evalCommit: 'new-commit' }))
      .testResults[0].assertionResults[0].meta.harness.run.session.metadata)
      .toEqual({ productSha: 'new-build', evalCommit: 'new-commit', trial: 1 });
  });
});

describe('the joined report', () => {
  test('holds every task once, and a missing task is refused rather than read as removed', () => {
    const tasks = ['budget-board.eval.ts', 'order-book.eval.ts'];
    const both = new Map(tasks.map((task) => [task, report(task)]));

    expect(JSON.parse(joinReports(tasks, both)).testResults).toHaveLength(2);
    expect(() => joinReports(tasks, new Map([['order-book.eval.ts', report('order-book.eval.ts')]]))).toThrow(/budget-board/);
  });
});

describe('the baseline', () => {
  test('is the newest stored report of a strict ancestor, never the candidate\'s own', () => {
    const ancestors = new Set(['b-2', 'b-1']);

    expect(baselineOf('b-3', ['b-3', 'x-9', 'b-2', 'b-1'], (sha) => ancestors.has(sha))).toBe('b-2');
    expect(baselineOf('b-3', ['b-3', 'x-9'], (sha) => ancestors.has(sha))).toBeUndefined();
  });
});
