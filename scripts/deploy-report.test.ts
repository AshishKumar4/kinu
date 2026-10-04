import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { measurePromptUsage, type Assertion } from '../evals/src/results';
import { previousSummary, renderReport, type ReportEntry, type ReportSummary } from './deploy-report';

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
  test('owned deploy wall over twenty minutes is red; the longest eval trial is named and excluded, never killed', () => {
    const input = (seconds: number) => ({
      dir: '/reports/budget', meta: META, entries: [
        { kind: 'mark' as const, mark: 'end', seconds },
        { kind: 'timing' as const, phase: 'upload', what: 'secret scan', command: 'bun run security-scan', seconds: 73.5 },
        { kind: 'timing' as const, phase: 'post-publish', what: 'product flows', command: 'bash scripts/product-flows-tier.sh', seconds: 524 },
      ],
      evals: [{ status: 'passed', duration: 1_600_000, meta: { harness: { run: {
        session: { metadata: { taskId: 'chess', taskVersion: 'v1', evalCommit: META.sha, productSha: META.sha, arm: 'product', trial: 1 }, events: [] },
        usage: { model: 'muse', metadata: { steps: [] } }, errors: [],
        output: { metrics: { modelTurns: 0, toolCalls: 0, toolErrors: 0, providerWaits: 0, providerWaitMs: 0 }, turns: [] },
      } } } } satisfies Assertion],
    });

    const at = renderReport(input(2800));
    const over = renderReport(input(2801));

    expect(at.summary.reds).toEqual([]);
    expect(over.summary.reds).toEqual(['budget: owned deployment wall']);
    expect(over.text).toContain('chess / muse / product / trial 1');
    expect(over.text).toContain('product flows');
    expect(over.text).toContain('524');
    expect(over.summary.totalSeconds).toBe(2801);
  });

  test('current and previous cache measurements stay separate at both deployment and trial scope', () => {
    const measured = (sha: string, input: number, cacheRead: number, output: number): Assertion => ({
      status: 'passed', duration: 1000, meta: { harness: { run: {
        session: { metadata: { taskId: 'task', taskVersion: 'v1', evalCommit: sha, productSha: sha, arm: 'product', trial: 1 }, events: [] },
        usage: { model: 'muse', ...measurePromptUsage([{ actor: 'main', events: [{
          type: 'step_finish', runId: 'run', eventIndex: 0, stepIndex: 1, timestamp: '2026-10-02T19:00:00Z', usage: { input, cacheRead, output },
        }] }]) }, errors: [],
        output: { metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, providerWaits: 0, providerWaitMs: 0 }, turns: [] },
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
