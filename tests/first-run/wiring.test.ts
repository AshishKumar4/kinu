/** Credential-free checks for the first-run corpus, gating, and record admission. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { assessAdmissibility, outcomeRow, projectRunEventProvenance, runToExit, scratchDir, spawnTest, subgoalOutcome, TASK_OUTCOME,
  type EvalObservation } from '@kinu.run/test-utils';
import { FLEET_MODULE, fleetCases, TUI_HARNESS } from '../../vitest.first-run.config';
import { FIRST_RUN_CASES } from './first-run';
import { resolvePublicSessionPlan } from '../../evals/src/session';

const RUNTIME = resolve(import.meta.dirname, '../../node_modules/.bin/bun');

const RUNNER_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${dirname(RUNTIME)}:${process.env.PATH ?? ''}` });

/** The tier script in a scratch tree whose `bun` is a fake: everything but `--bun` (a vitest project) answers as the
 *  deployment's helpers would, and a project runs `project`, a bash body that sees `$project` and `$REPORT_FIXTURE`. */
function tierFixture(name: string, project: string, cases: readonly string[] = ['probe']) {
  const root = scratchDir(name);
  const scripts = join(root, 'scripts');
  const bin = join(root, 'node_modules', '.bin');
  const reports = join(root, 'reports');
  mkdirSync(scripts); mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'tests/first-run'), { recursive: true });

  for (const each of cases) writeFileSync(join(root, `tests/first-run/${each}.first-run.ts`), '');
  copyFileSync(join(import.meta.dirname, '../../scripts/first-run-tier.sh'), join(scripts, 'first-run-tier.sh'));
  copyFileSync(join(import.meta.dirname, '../../scripts/repo-runtime.sh'), join(scripts, 'repo-runtime.sh'));
  writeFileSync(join(bin, 'bun'), `#!/bin/bash
case "$1" in
  -e) printf '%s\\n' KINU_EVAL_WEB_IDENTITY ;;
  scripts/bench-retention.ts) mkdir -p "$REPORT_FIXTURE"; printf '%s\\n' "$REPORT_FIXTURE" ;;
  scripts/eval-session-mint.ts) ;;
  scripts/eval-credentials.ts) printf '%s\\n' 'https://kinu.run' 'fixture-token' ;;
  scripts/scripted-tier.ts) shift; printf '%s %s\\n' "$*" "$KINU_TOKEN" >> "$REPORT_FIXTURE/scripted" ;;
  --bun) project="$(printf '%s\\n' "$@" | grep -A1 -x -- --project | tail -1)"
${project}
    ;;
  scripts/eval-spend.ts) printf 'reported\\n' > "$REPORT_FIXTURE/spend-reported" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, REPORT_FIXTURE: reports, KINU_EVAL_WEB_IDENTITY: 'fixture-identity' };

  return { script: join(scripts, 'first-run-tier.sh'), reports, env };
}

test('a red in either project reds the tier, which still reports spend and keeps its reports', async () => {
  // The fleet project fails and the cases project passes: the other
  // project's green must not become the tier's verdict.
  const tier = tierFixture('first-run-shell-retention', `    printf '%s\\n' "$project" >> "$REPORT_FIXTURE/projects"
    printf 'measured-spend\\n' >> "$KINU_EVAL_SPEND_FILE"
    if [[ "$project" == first-run-fleet ]]; then exit 42; fi
    exit 0`);

  const run = await runToExit(['bash', tier.script], { env: tier.env });
  const reports = tier.reports;

  expect(run.exitCode).toBe(42);
  // Both accounts the cases act as run on the scripted model, each put there with its own bearer.
  expect(readFileSync(join(reports, 'scripted'), 'utf8').trim().split('\n').sort())
    .toEqual(['https://kinu.run devices fixture-token', 'https://kinu.run scripted fixture-token']);
  expect(readFileSync(join(reports, 'projects'), 'utf8').trim().split('\n').sort()).toEqual(['first-run-cases', 'first-run-fleet']);
  expect(readFileSync(join(reports, 'spend-first-run.jsonl'), 'utf8')).toBe('measured-spend\nmeasured-spend\n');
  expect(readFileSync(join(reports, 'spend-reported'), 'utf8')).toBe('reported\n');
});

// The deploy of 2026-10-08 ran the tier past its 1800 s bound, and its output held only the fleet's tail: nothing named
// the case that hung. Stopped as `timeout` stops it, the whole group signalled, the tier names what never reported.
test('a tier stopped by its deadline names the case files that never reported', async () => {
  const tier = tierFixture('first-run-shell-stopped', `    if [[ "$project" == first-run-cases ]]; then
      printf '%s\\n' ' ✓  first-run-cases  tests/first-run/done.first-run.ts (1 test) 1ms'
      until grep -q done.first-run "$REPORT_FIXTURE/first-run-cases.log" 2>/dev/null; do :; done
      echo started > "$REPORT_FIXTURE/started"
      read -r < "$REPORT_FIXTURE/hold"
    fi
    exit 0`, ['done', 'stuck']);

  mkdirSync(tier.reports, { recursive: true });
  execFileSync('mkfifo', [join(tier.reports, 'started'), join(tier.reports, 'hold')]);
  const started = readFile(join(tier.reports, 'started'), 'utf8');
  const run = spawnTest(['setsid', 'bash', tier.script], { env: tier.env, stdout: 'pipe', stderr: 'pipe' });

  expect(await started).toBe('started\n');
  process.kill(-run.pid, 'SIGTERM');
  const [stderr, exitCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);

  const unfinished = stderr.split('\n').filter((line) => line.startsWith('  tests/first-run/')).map((line) => line.trim());

  expect({ exitCode, unfinished }).toEqual({ exitCode: 124, unfinished: ['tests/first-run/stuck.first-run.ts'] });
});

describe('the first-run corpus is the set this tier runs', () => {

  test('a case that attaches a machine or drives the TUI is derived into the fleet, however many hops out', () => {
    const fleet = fleetCases(new Map([
      [FLEET_MODULE, 'export const attachMachine = 1;'],
      [TUI_HARNESS, 'export const runTuiInPty = 1;'],
      ['tests/first-run/helper.ts', "export { attachMachine } from './daemon';"],
      ['tests/first-run/direct.first-run.ts', "import { attachMachine } from './daemon';"],
      ['tests/first-run/indirect.first-run.ts', "import { attachMachine } from './helper';"],
      ['tests/first-run/tui.first-run.ts', "import { runTuiInPty } from '../../packages/cli/tests/helpers/pty-screen';"],
      ['tests/first-run/alone.first-run.ts', "import { firstRunCasePlan } from './first-run';"],
    ]), ['reader']);

    expect(fleet).toEqual([
      'tests/first-run/direct.first-run.ts', 'tests/first-run/indirect.first-run.ts',
      'tests/first-run/reader.first-run.ts', 'tests/first-run/tui.first-run.ts',
    ]);
  });

  test('every case loads under the tier\'s own runner', async () => {
    // Collecting a case imports it, under Bun as the tier runs it, which the partition above never does. On
    // 2026-09-25 35 cases failed there at import (`import { z } from 'zod'` in core came back undefined), and only a
    // deploy's post-publish wave would have shown it.
    const listed = await runToExit([RUNTIME, '--bun', './node_modules/.bin/vitest', 'list', '--config', 'vitest.first-run.config.ts', '--json'], { env: RUNNER_ENV(), cwd: join(import.meta.dirname, '../..') });

    expect(listed.exitCode, listed.stderr).toBe(0);
  });
});

describe('a case gets a fresh workspace, and gives it back', () => {
  test('the plan is refused off the cloud backend, before any credential', () => {
    // The gate that makes "this tier drives a DEPLOYMENT" an assertion rather
    // than a comment. Driven with an empty environment, so it cannot pass by
    // holding a credential.
    for (const env of [{}, { KINU_EVAL_BACKEND: 'local' }]) {
      const resolution = resolvePublicSessionPlan('First-run wiring probe', '@cf/model', env);
      expect(resolution.kind).toBe('unavailable');
      const remedy = resolution.kind === 'unavailable' ? resolution.remedy : '';
      expect(remedy).toContain('KINU_EVAL_BACKEND');
    }
  });

});

describe('a partial first-run tier is not evidence', () => {
  test('omitting a declared case is inadmissible; the complete set carries the primary metric', () => {
    const scored = (id: string): EvalObservation => ({
      taskId: id, repetition: 0, outcome: 'scored',
      scores: [outcomeRow(subgoalOutcome(3, 3, 'every subgoal reached'))],
      turns: 1, toolCalls: 2, toolNames: ['device.exec'], tokensIn: 10, tokensOut: 5, reasoningOut: 0, ms: 1_000,
      provenance: projectRunEventProvenance([]),
    });

    const declared = [...FIRST_RUN_CASES];

    const partial = assessAdmissibility(declared, declared.slice(0, -1).map(scored));
    expect(partial.admissible).toBe(false);
    expect(partial.failures.join(' ')).toContain('never attempted');

    const complete = assessAdmissibility(declared, declared.map(scored));
    expect(complete.failures).toEqual([]);
    expect(complete.admissible).toBe(true);
    expect(complete.outcomesScored).toBe(declared.length);

    // The same rule from the other side: an observation whose scores are all
    // covariates measured activity, not outcome.
    const activityOnly: EvalObservation = {
      taskId: declared[0] ?? '', repetition: 0, outcome: 'scored', scores: [],
      turns: 1, toolCalls: 2, toolNames: ['device.exec'], tokensIn: 10, tokensOut: 5, reasoningOut: 0, ms: 1_000,
      provenance: projectRunEventProvenance([]),
    };

    expect(assessAdmissibility([declared[0] ?? ''], [activityOnly]).failures.join(' '))
      .toContain(TASK_OUTCOME);
  });
});
