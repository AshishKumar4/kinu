import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { childEnv, runToExit, scratchDir } from '@kinu.run/test-utils';
import { measurePromptUsage, type Assertion } from '../evals/src/results';
import {
  externalCause, externalOnly, markInstant, previousSummary, recordMarkAt, recordRed, recordRunner, renderReport, type ReportEntry, type ReportSummary,
} from './deploy-report';

const META = { environment: 'staging', mode: 'deploy', sha: 'bbbbbbbbbbbbbbbb', startedAt: '2026-09-30T20:00:00.000Z' };

const red = (phase: string, command: string, external?: string): ReportEntry => ({
  kind: 'red', phase, what: command, command, verdict: 'exit 1', finding: `${command} went red`, reproduce: command,
  log: `/logs/${command}.log`, tail: ['(fail) one test'], external,
});

const summary = (sha: string, dir: string, mode: string, reds: readonly string[]): ReportSummary => ({
  sha, environment: 'staging', mode, startedAt: META.startedAt, dir, reds: [...reds], skipped: 0,
  totalSeconds: 100, liveSeconds: 10, testable: true,
});

describe('the deploy report', () => {
  // The owner, 2026-10-23, "Monitors don't block": a deploy over its wall is said, and keeps its record.
  test('the final report keeps this staging run’s record at 1199 s and at 1201 s, and withdraws it on a red', async () => {
    const source = readFileSync(new URL('deploy.sh', import.meta.url), 'utf8');
    const start = source.indexOf('finish() {');
    const end = source.indexOf('\n}\n', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const finish = source.slice(start, end + 2);

    for (const [seconds, published, reds, expected] of [
      [1199, 1, [], [0, '1']],
      [1201, 1, [], [0, '1']],
      [1201, 1, [red('post-publish', 'bun run gate:first-run')], [1, '0']],
      [1201, 0, [red('post-publish', 'bun run gate:first-run')], [1, '1']],
    ] as const) {
      const { summary: verdict } = renderReport({ dir: '/reports/final', meta: META,
        entries: [{ kind: 'mark', mark: 'end', seconds }, ...reds],
      });

      const run = await runToExit(['bash', '-c', `
KINU_ROOT=.
KINU_ENV=staging
KINU_REDS=${String(verdict.reds.length)}
DEPLOY_PUBLISHED=${String(published)}
verified=1
trap 'printf "%s" "$verified"' EXIT
mark() { :; }
report() { return ${verdict.reds.length === 0 ? '0' : '1'}; }
bun() { [ "$1" = "./scripts/promote.ts" ] && [ "$2" = "withdraw" ] && verified=0; }
${finish}
finish
`], { env: childEnv() });

      expect([run.exitCode, run.stdout], run.stderr).toEqual([...expected]);
    }
  });

  // m1973, m1976: the budget subtracted the longest eval trial, so a deploy far over twenty minutes was reported within it.
  test('the whole deploy, start to verdict, is measured against twenty minutes and said, never a red; the eval soak\'s red is its own', () => {
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
        output: { metrics: { modelTurns: 0, toolCalls: 0, toolErrors: 0, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 }, toolFailures: [], waits: { backgrounded: [], slowest: [], pastInteractiveMs: 0 }, turns: [] },
      } } } } satisfies Assertion],
    });

    const at = renderReport(input(1200));
    const over = renderReport(input(1201));

    expect({ at: at.summary.reds, over: over.summary.reds }).toEqual({ at: [], over: [] });
    expect(over.text).toContain('Notices, not reds');
    expect(over.text).toContain('budget: deployment wall: The deploy took 1201.0 s');
    expect(at.text).toContain('Soak, after the verdict');
    expect(at.text).toContain('chess trial 1 failed its checks');
    expect(over.text).toContain('product flows');
    expect(over.summary.totalSeconds).toBe(1201);
  });

  test('current and previous cache measurements stay separate at both deployment and trial scope', () => {
    const measured = (sha: string, input: number, cacheRead: number, output: number): Assertion => ({
      status: 'passed', duration: 1000, meta: { harness: { run: {
        session: { metadata: { taskId: 'task', taskVersion: 'v1', evalCommit: sha, productSha: sha, arm: 'product', trial: 1 }, events: [] },
        usage: { model: 'muse', ...measurePromptUsage([{ actor: 'main', events: [{ type: 'step_finish', parts: [], runId: 'run', eventIndex: 0, stepIndex: 1, timestamp: '2026-10-02T19:00:00Z', usage: { input, cacheRead, output }, }] }]) }, errors: [],
        output: { metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 }, toolFailures: [], waits: { backgrounded: [], slowest: [], pastInteractiveMs: 0 }, turns: [] },
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

  // The ladder marks when the wave stopped driving the deployment, and Step 5b ends its telemetry window there.
  test('a mark taken at an instant is in whole seconds from the start, never before it, and answers that instant', () => {
    const dir = scratchDir('deploy-report-mark');

    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ environment: 'staging', mode: 'plain', sha: 'abc', startedAt: '2026-10-14T08:39:09.002Z' })}\n`);
    expect(markInstant(dir, 'traffic')).toBeUndefined();
    recordMarkAt(dir, 'traffic', Date.parse('2026-10-14T08:48:44.100Z'));

    expect({ entry: readFileSync(join(dir, 'entries.jsonl'), 'utf8'), at: markInstant(dir, 'traffic')?.toISOString() })
      .toEqual({ entry: `${JSON.stringify({ kind: 'mark', mark: 'traffic', seconds: 576 })}\n`, at: '2026-10-14T08:48:45.002Z' });
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

  // Every deploy report since 2026-10-09 held `"startupMs": null`: the devbox probe's open container-startup flight,
  // never the Worker's. The Worker's startup is the validator's reading, as wrangler printed it for each upload.
  test("the validator's startup readings are reported, and the deployed version's is the summary's", () => {
    const { text, summary: rendered } = renderReport({
      dir: '/reports/this', meta: META, entries: [
        { kind: 'startup', at: 'validated', reading: 503 },
        { kind: 'startup', at: 'deployed', reading: 487 },
        { kind: 'mark', mark: 'end', seconds: 42 },
      ],
    });

    expect(text).toContain('- the version uploaded before the reset: 503 ms');
    expect(text).toContain('- the deployed version: 487 ms');
    expect(rendered.workerStartupMs).toBe(487);

    const refused = renderReport({ dir: '/reports/this', meta: META, entries: [{ kind: 'startup', at: 'validated', reading: 'refused' }] });

    expect(refused.text).toContain('- the version uploaded before the reset: refused');
    expect(refused.summary.workerStartupMs).toBeNull();
  });

  // rc28, 2026-10-20: a version cannot bind a class its deploy has not provisioned, so the one validated before a reset
  // leaves the build's new classes out; the report says which, and that the script read is the one deployed.
  test('a validated version that left classes out names them', () => {
    const { text } = renderReport({
      dir: '/reports/this', meta: META, entries: [{ kind: 'startup', at: 'validated', reading: 412, withheld: ['MailNameDO', 'MailboxDO'] }],
    });

    expect(text).toContain('- the version uploaded before the reset: 412 ms, without the bindings of MailNameDO, MailboxDO: new to this target, '
      + 'a version cannot bind them before the deploy provisions them; the script it read is the one deployed');
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

/** A first-run tier's output as it ends: two vitest projects begun, the fleet's green summary, each failed case's first
 *  error line and the summary that counts them, then the spend check's (`after` in its place). */
const vitest = (errors: readonly string[], after: readonly string[] = ['tier liveness: PROVEN — 176 model call(s)']): string => [
  ' RUN  v4.1.12 /home/ci/work/kinu/kinu', ' RUN  v4.1.12 /home/ci/work/kinu/kinu',
  ' Test Files  7 passed (7)', '      Tests  9 passed (9)',
  ` ❯  first-run-cases  tests/first-run/web-search.first-run.ts (${String(errors.length)} test | ${String(errors.length)} failed) 8322ms`,
  `⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${String(errors.length)} ⎯⎯⎯⎯⎯⎯⎯`, '',
  ...errors.flatMap((error, at) => [
    // Coloured as vitest writes it into the row's log.
    `\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[30m\u001b[45m first-run-cases \u001b[49m\u001b[39m tests/first-run/case-${String(at)}.first-run.ts > MEASURED: case-${String(at)}`,
    error, ' ❯ expectReached tests/first-run/first-run.ts:370:3', '',
  ]),
  ` Test Files  ${String(errors.length)} failed | 43 passed (50)`, `      Tests  ${String(errors.length)} failed | 43 passed | 4 skipped (50)`,
  'error: "vitest" exited with code 1', ...after,
].join('\n');

// Production 06498fc55, 2026-10-23: the first-run tier's three web searches, refused by the owner's AI Gateway credits.
const GATEWAY = 'Error: web-search/searched: 1 web search call(s), none answered: call-web-0 "Linkup on this deployment\'s AI Gateway: '
  + 'Cloudflare answered 402: Your AI Gateway credit balance is zero, so this search could not be billed. Load credits on yo — the defect';

const OWN = 'Error: web-search/searched: 1 web search call(s), none answered: call-web-0 "Your Kinu account\'s search answered 402: payment required"';

// The provider's words as the gallery's stand-in answers them (gallery-web-search.ts), quoted by a product assertion.
const QUOTED = 'AssertionError: expected \'Exa on your AI Gateway: Cloudflare answered 402: Your AI Gateway credit balance is zero\' to equal \'results\'';

const CREDITS = "the AI Gateway's credit balance is zero (Cloudflare, HTTP 402)";

describe('a red that is a provider\'s refusal, not the build\'s (owner, 2026-10-23, "Promote, list them")', () => {
  test('every failed test refused by the provider\'s own billing is external; a 402 of our own, or a failure past the list, holds', () => {
    expect({
      gateway: externalCause(vitest([GATEWAY, GATEWAY, GATEWAY])),
      own: externalCause(vitest([GATEWAY, OWN])),
      unproven: externalCause(vitest([GATEWAY], ['tier liveness: UNPROVEN — no model call'])),
      spendCut: externalCause(vitest([GATEWAY], ['error: spend.jsonl line 3 does not parse'])),
      uncounted: externalCause(vitest([GATEWAY]).replace('Tests  1 failed', 'Tests  2 failed')),
      projectCut: externalCause(vitest([GATEWAY]).replace(' Test Files  7 passed (7)\n      Tests  9 passed (9)\n', '')),
      quoted: externalCause(vitest([QUOTED.replace('AssertionError', 'Error')])),
      asserted: externalCause(vitest([QUOTED])),
      oneOfTwo: externalCause(vitest([GATEWAY.replace('1 web search call(s)', '2 web search call(s)')])),
      killed: externalCause(`${vitest([GATEWAY])}\nKILLED  First-run tier  after 600s with no output, 900.0s in — the run hung`),
      left: externalCause(`${vitest([GATEWAY])}\nLEFT    First-run tier  exited with 1 process(es) of its own still running, now ended: chrome`),
      bun: externalCause(`(fail) web search\n${GATEWAY}\n 0 pass\n 1 fail`),
    }).toEqual({
      gateway: `${CREDITS}, in 3 failed test(s)`, own: undefined, unproven: undefined, spendCut: undefined, uncounted: undefined,
      projectCut: undefined, quoted: undefined, asserted: undefined, oneOfTwo: undefined, killed: undefined, left: undefined, bun: undefined,
    });
  });

  test('a recorded red keeps its cause, and production takes the build only when every red is external', () => {
    const dir = scratchDir('deploy-report-external');

    const row = { phase: 'post-publish', what: 'First-run tier', command: 'bun run gate:first-run', finding: 'red', reproduce: 'run', output: vitest([GATEWAY]) };

    recordRed(dir, { ...row, verdict: 'exit 1' });
    recordRed(dir, { ...row, verdict: 'killed: silent for its bound' });

    const [external, killed] = readFileSync(join(dir, 'entries.jsonl'), 'utf8').trim().split('\n')
      .map((line) => v.parse(v.looseObject({ external: v.optional(v.string()) }), JSON.parse(line)).external);

    const report = (entries: readonly ReportEntry[]) => renderReport({ dir: '/reports/this', meta: META, entries: [...entries] });
    const firstRun = red('post-publish', 'bun run gate:first-run', external);

    expect(killed).toBeUndefined();
    expect(report([firstRun]).text).toContain(`- external: ${CREDITS}, in 1 failed test(s)`);
    expect({
      only: externalOnly(report([firstRun]).summary),
      mixed: externalOnly(report([firstRun, red('post-publish', 'bash scripts/product-flows-tier.sh --flow=activity')]).summary),
      own: externalOnly(report([red('post-publish', 'bun run gate:first-run', externalCause(vitest([OWN])))]).summary),
      green: externalOnly(report([]).summary),
    }).toEqual({
      only: { promote: true, listed: `post-publish: bun run gate:first-run: ${CREDITS}, in 1 failed test(s)` },
      mixed: { promote: false, held: ['post-publish: bash scripts/product-flows-tier.sh --flow=activity'] },
      own: { promote: false, held: ['post-publish: bun run gate:first-run'] },
      green: { promote: false, held: [] },
    });
  });
});
