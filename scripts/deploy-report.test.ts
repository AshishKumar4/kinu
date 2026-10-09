import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { childEnv, runToExit, scratchDir } from '@kinu.run/test-utils';
import { measurePromptUsage, type Assertion } from '../evals/src/results';
import { previousSummary, recordRunner, renderReport, type ReportEntry, type ReportSummary } from './deploy-report';

const META = { environment: 'staging', mode: 'deploy', sha: 'bbbbbbbbbbbbbbbb', startedAt: '2026-09-30T20:00:00.000Z' };

const red = (phase: string, command: string): ReportEntry => ({
  kind: 'red', phase, what: command, command, verdict: 'exit 1', finding: `${command} went red`, reproduce: command,
  log: `/logs/${command}.log`, tail: ['(fail) one test'],
});

const summary = (sha: string, dir: string, mode: string, reds: readonly string[]): ReportSummary => ({
  sha, environment: 'staging', mode, startedAt: META.startedAt, dir, reds: [...reds], skipped: 0,
  totalSeconds: 100, liveSeconds: 10, testable: true,
});

describe('the deploy report', () => {
  test('the final report withdraws this staging run’s record at 1201 s, but keeps it at 1199 s', async () => {
    const source = readFileSync(new URL('deploy.sh', import.meta.url), 'utf8');
    const start = source.indexOf('finish() {');
    const end = source.indexOf('\n}\n', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const finish = source.slice(start, end + 2);

    for (const [seconds, published, expected] of [
      [1199, 1, [0, '1']],
      [1201, 1, [1, '0']],
      [1201, 0, [1, '1']],
    ] as const) {
      const { summary: verdict } = renderReport({ dir: '/reports/final', meta: META,
        entries: [{ kind: 'mark', mark: 'end', seconds }],
      });

      const run = await runToExit(['bash', '-c', `
KINU_ROOT=.
KINU_ENV=staging
KINU_REDS=0
DEPLOY_PUBLISHED=${String(published)}
verified=1
trap 'printf "%s" "$verified"' EXIT
mark() { :; }
report() { return ${verdict.reds.length === 0 ? '0' : '1'}; }
bun() { [ "$1" = "./scripts/promote.ts" ] && [ "$2" = "forget" ] && verified=0; }
${finish}
finish
`], { env: childEnv() });

      expect([run.exitCode, run.stdout], run.stderr).toEqual([...expected]);
    }
  });

  // m1973, m1976: the budget subtracted the longest eval trial, so a deploy far over twenty minutes was reported within it.
  test('the whole deploy, start to verdict, is held to twenty minutes; the eval soak\'s red is its own, never the deploy\'s', () => {
    const input = (seconds: number) => ({
      dir: '/reports/budget', meta: META, entries: [
        { kind: 'mark' as const, mark: 'end', seconds },
        { kind: 'timing' as const, phase: 'post-publish', what: 'product flows', command: 'bash scripts/product-flows-tier.sh', seconds: 524 },
        { kind: 'red' as const, phase: 'soak', what: 'One trial of every eval task', command: 'bash scripts/eval-pass-tier.sh', verdict: 'exit 1',
          reproduce: 'bash scripts/eval-pass-tier.sh', finding: 'chess trial 1 failed its checks', log: '/reports/budget/soak.log', tail: ['chess: 0/3 checks'] },
      ],
      evals: [{ status: 'failed', duration: 1_600_000, meta: { harness: { run: {
        session: { metadata: { taskId: 'chess', taskVersion: 'v1', evalCommit: META.sha, productSha: META.sha, arm: 'product', trial: 1 }, events: [] },
        usage: { model: 'muse', metadata: { steps: [], plan: [] } }, errors: [],
        output: { metrics: { modelTurns: 0, toolCalls: 0, toolErrors: 0, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 }, toolFailures: [], turns: [] },
      } } } } satisfies Assertion],
    });

    const at = renderReport(input(1200));
    const over = renderReport(input(1201));

    expect({ at: at.summary.reds, over: over.summary.reds }).toEqual({ at: [], over: ['budget: deployment wall'] });
    expect(at.text).toContain('Soak, after the verdict');
    expect(at.text).toContain('chess trial 1 failed its checks');
    expect(over.text).toContain('product flows');
    expect(over.summary.totalSeconds).toBe(1201);
  });

  test('current and previous cache measurements stay separate at both deployment and trial scope', () => {
    const measured = (sha: string, input: number, cacheRead: number, output: number): Assertion => ({
      status: 'passed', duration: 1000, meta: { harness: { run: {
        session: { metadata: { taskId: 'task', taskVersion: 'v1', evalCommit: sha, productSha: sha, arm: 'product', trial: 1 }, events: [] },
        usage: { model: 'muse', ...measurePromptUsage([{ actor: 'main', events: [{
          type: 'step_finish', runId: 'run', eventIndex: 0, stepIndex: 1, timestamp: '2026-10-02T19:00:00Z', usage: { input, cacheRead, output },
        }] }]) }, errors: [],
        output: { metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 }, toolFailures: [], turns: [] },
      } } },
    });

    const before = measured('aaaaaaaaaaaaaaaa', 100, 20, 10);
    const after = measured(META.sha, 200, 180, 30);

    const { text } = renderReport({ dir: '/reports/after', meta: META, entries: [], evals: [after],
      previous: { summary: summary('aaaaaaaaaaaaaaaa', '/reports/before', 'deploy', []), merges: { kind: 'listed', merges: [] }, evals: [before] },
    });

    expect(text).toContain('| current | Deployment | 200 | 180 | 30 | 90.00% | 90.00% | 90.00% | 90.00% | 1/1 |');
    expect(text).toContain('| previous | Deployment | 100 | 20 | 10 | 20.00% | 20.00% | 20.00% | 20.00% | 1/1 |');
    expect(text).toContain('| current | task / muse / product / trial 1 | 200 | 180 | 30 | 90.00%');
    expect(text).toContain('| previous | task / muse / product / trial 1 | 100 | 20 | 10 | 20.00%');
  });

  // THE DIFFERENTIAL. A fixer starts from what this deploy's merges broke: a red the previous report of the
  // environment already held is carried over, and one it did not is new.
  test('each red is new or carried over from the previous report, and the merges between them are listed', () => {
    const previous = summary('aaaaaaaaaaaaaaaa', '/reports/previous', 'deploy', ['source: bun run test:core']);

    const { text, summary: rendered } = renderReport({
      dir: '/reports/this', meta: META, entries: [
        red('source', 'bun run test:core'), red('post-publish', 'bun run gate:first-run'),
        { kind: 'step', phase: 'publish', what: 'build, upload and smoke', finding: 'vite build failed' },
      ],
      previous: { summary: previous, merges: { kind: 'listed', merges: ['1234567 Merge lane/x'] } },
    });

    expect(text).toContain('3 red (2 new, 1 carried over)');
    expect(text).toContain('### CARRIED OVER: bun run test:core (exit 1)');
    expect(text).toContain('### NEW: bun run gate:first-run (exit 1)');
    expect(text).toContain('### NEW: build, upload and smoke');
    expect(text).toContain('Merges since then (1):\n- 1234567 Merge lane/x');
    expect(rendered.reds).toEqual(['source: bun run test:core', 'post-publish: bun run gate:first-run', 'publish: build, upload and smoke']);
  });

  // What the deploy did not run, and what a fixer should act on that is no red, are in the file and are not reds.
  test('a soak runner that crashed before reporting a red is the soak\'s red; one that exited on its reds adds none', () => {
    const steps = (entries: readonly ReportEntry[], exit: number): string[] => {
      const dir = scratchDir('deploy-report-runner');

      writeFileSync(join(dir, 'entries.jsonl'), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
      recordRunner(dir, 'soak', exit);

      return readFileSync(join(dir, 'entries.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map((line) => v.parse(v.looseObject({ kind: v.string(), what: v.string() }), JSON.parse(line)))
        .flatMap((entry) => (entry.kind === 'step' ? [entry.what] : []));
    };

    expect(steps([], 1)).toEqual(['the soak runner']);
    expect(steps([red('soak', 'bash scripts/eval-pass-tier.sh')], 1)).toEqual([]);
    expect(steps([], 0)).toEqual([]);
  });

  test('a skipped row and a notice are reported and are no red', () => {
    const { text, summary: rendered } = renderReport({
      dir: '/reports/this', meta: META, entries: [
        { kind: 'skipped', phase: 'post-publish', what: 'bun run gate:first-run', why: 'staging does not serve this build' },
        { kind: 'notice', phase: 'post-publish', what: 'First-run tier', notice: 'no measured cost, so it ran alone' },
        { kind: 'mark', mark: 'end', seconds: 42 },
      ],
    });

    expect(text).toContain('0 red, 1 skipped');
    expect(text).toContain('- post-publish: `bun run gate:first-run`, because staging does not serve this build');
    expect(text).toContain('- post-publish: First-run tier: no measured cost, so it ran alone');
    expect(text).toContain('staging never served this build');
    expect([rendered.reds, rendered.skipped, rendered.testable]).toEqual([[], 1, false]);
  });

  // A rehearsal ran no tier, so a red it lacks says nothing about this deploy: it is never the differential's base,
  // and neither is this deploy's own entry.
  test('the previous report is the last real deploy of the environment, never a gates-only one or this one', () => {
    const reports = scratchDir('deploy-report-index');
    const index = join(reports, 'staging', 'index.jsonl');

    mkdirSync(join(reports, 'staging'));
    expect(previousSummary(index, '/reports/this')).toBeUndefined();

    writeFileSync(index, `${[
      summary('aaaa', '/reports/first', 'deploy', []), summary('cccc', '/reports/rehearsal', 'gates-only', []),
      summary('bbbb', '/reports/this', 'deploy', []),
    ].map((line) => JSON.stringify(line)).join('\n')}\n`);

    expect(previousSummary(index, '/reports/this')?.sha).toBe('aaaa');
  });
});
