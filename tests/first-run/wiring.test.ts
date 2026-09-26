/** Credential-free checks for the first-run corpus, gating, and record admission. */
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';

import { assessAdmissibility, outcomeRow, projectRunEventProvenance, scratchDir, subgoalOutcome, TASK_OUTCOME,
  type EvalObservation } from '@kinu.run/test-utils';
import { isFirstRunSuite, trackedFiles } from '../../scripts/sources';
import {
  CI_EXEMPT, LADDER, packageScripts,
} from '../../scripts/ladder';
import firstRunConfig, {
  EXECUTOR_READERS, FIRST_RUN_INCLUDE, FIRST_RUN_PROJECTS, FLEET_MODULE, fleetCases, TUI_HARNESS,
} from '../../vitest.first-run.config';
import {
  FIRST_RUN_ARM, FIRST_RUN_CASES, FIRST_RUN_DEFECTS, FIRST_RUN_FAMILY,
} from './first-run';
import { resolvePublicSessionPlan } from '../../evals/src/session';
import { CAPABILITY_ROWS, ENTRY_ROWS, PAGE_ROWS, STRIP_ROWS } from './surfaces';

/** The deployed tier's package command. */
const GATE = 'bun run gate:first-run';

const RUNNER = 'scripts/first-run-tier.sh';

/** Every case file this tier holds, off the ONE enumeration and narrowed only by
 *  the predicate `scripts/sources.ts` exports for it. */
const onDisk = trackedFiles().filter(isFirstRunSuite).sort();

test('a red in either project reds the tier, which still reports spend and keeps its reports', () => {
  const root = scratchDir('first-run-shell-retention');
  const scripts = join(root, 'scripts');
  const bin = join(root, 'bin');
  const reports = join(root, 'reports');
  mkdirSync(scripts); mkdirSync(bin);
  mkdirSync(join(root, 'tests/first-run'), { recursive: true });
  writeFileSync(join(root, 'tests/first-run/probe.first-run.ts'), '');
  copyFileSync(join(import.meta.dirname, '../../scripts/first-run-tier.sh'), join(scripts, 'first-run-tier.sh'));
  // The fleet project fails and the cases project passes: the other
  // project's green must not become the tier's verdict.
  writeFileSync(join(bin, 'bun'), `#!/bin/bash
case "$1" in
  scripts/bench-retention.ts) mkdir -p "$REPORT_FIXTURE"; printf '%s\\n' "$REPORT_FIXTURE" ;;
  scripts/eval-session-mint.ts) ;;
  scripts/eval-credentials.ts) printf '%s\\n' 'https://kinu.run' 'fixture-token' ;;
  --bun) project="$(printf '%s\\n' "$@" | grep -A1 -x -- --project | tail -1)"
    printf '%s\\n' "$project" >> "$REPORT_FIXTURE/projects"
    printf 'measured-spend\\n' >> "$KINU_EVAL_SPEND_FILE"
    if [[ "$project" == first-run-fleet ]]; then exit 42; fi
    exit 0 ;;
  scripts/eval-spend.ts) printf 'reported\\n' > "$REPORT_FIXTURE/spend-reported" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });

  const run = spawnSync('bash', [join(scripts, 'first-run-tier.sh')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
      REPORT_FIXTURE: reports, KINU_EVAL_WEB_IDENTITY: 'fixture-identity' },
  });

  expect(run.status).toBe(42);
  expect(readFileSync(join(reports, 'projects'), 'utf8').trim().split('\n').sort()).toEqual(['first-run-cases', 'first-run-fleet']);
  expect(readFileSync(join(reports, 'spend-first-run.jsonl'), 'utf8')).toBe('measured-spend\nmeasured-spend\n');
  expect(readFileSync(join(reports, 'spend-reported'), 'utf8')).toBe('reported\n');
});

describe('the first-run corpus is the set this tier runs', () => {
  test('every declared case is a file, and every file is a declared case', () => {
    // BOTH DIRECTIONS. A declared case with no file is a defect nobody checks;
    // a file with no declaration is a case whose failure nobody expects, and
    // whose absence from the record reads as "not attempted" rather than as
    // "never written".
    const expected = FIRST_RUN_CASES.map((id) => `tests/first-run/${id}.first-run.ts`).sort();
    expect(onDisk).toEqual(expected);
    expect(new Set(FIRST_RUN_CASES).size).toBe(FIRST_RUN_CASES.length);
  });

  test('the runner selects exactly those files and nothing else', () => {
    // The config's include is the tier's real denominator, so it is held to the
    // predicate rather than trusted. A glob that widened to `tests/**` would
    // sweep the eval suites into a post-deploy tier that cannot pay for them.
    expect(firstRunConfig.test?.include).toEqual([FIRST_RUN_INCLUDE]);
    expect(FIRST_RUN_INCLUDE).toBe('tests/first-run/**/*.first-run.ts');
    expect(firstRunConfig.plugins).toContainEqual(expect.objectContaining({ name: 'kinu:prompt-text' }));

    for (const file of onDisk) expect(file.startsWith('tests/first-run/')).toBe(true);

    // And no case file can be selected by the runners that must never see it:
    // `bun test` matches only `.test.`/`.spec.`, and the eval suite's config
    // includes `evals/tasks/**` alone.
    for (const file of onDisk) {
      expect(/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)).toBe(false);
      expect(file.startsWith('evals/')).toBe(false);
    }
  });

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

  test('every case on disk drives a surface of the census', () => {
    // The census maps each surface to its rows; a row mapped to none is
    // misfiled or proves nothing a surface needs.
    const mapped = new Set([PAGE_ROWS, STRIP_ROWS, ENTRY_ROWS, CAPABILITY_ROWS]
      .flatMap((census) => Object.values(census))
      .flatMap((rows) => ('unreachable' in rows ? [] : rows)));

    expect(onDisk.map((file) => basename(file, '.first-run.ts')).filter((id) => !mapped.has(id))).toEqual([]);
  });

  test('every declared executor reader is a case on disk', () => {
    expect(Object.keys(EXECUTOR_READERS).map((id) => `tests/first-run/${id}.first-run.ts`).filter((file) => !onDisk.includes(file)))
      .toEqual([]);
  });

  test('the fleet cases run one at a time, the rest beside them, and together they are the corpus', () => {
    // The account's device fleet is the one thing cases share: two-machines
    // measures what happens when exactly two machines are live, so a sibling's
    // daemon beside it is a third machine in the measurement. Asked of vitest
    // itself, per project, so the partition is what the runner selects.
    const selected = (project: string): string[] => {
      const listed = spawnSync('bun', ['--bun', './node_modules/.bin/vitest', 'list', '--config', 'vitest.first-run.config.ts',
        '--project', project, '--filesOnly', '--json'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });

      expect(listed.status, listed.stderr).toBe(0);

      return v.parse(v.array(v.object({ file: v.string() })), JSON.parse(listed.stdout))
        .map(({ file }) => relative(join(import.meta.dirname, '../..'), file)).sort();
    };

    const fleet = selected(FIRST_RUN_PROJECTS.fleet);
    const cases = selected(FIRST_RUN_PROJECTS.cases);
    expect(fleet).toEqual(fleetCases());
    expect(fleet.length).toBeGreaterThan(0);
    expect(cases.filter((file) => fleet.includes(file))).toEqual([]);
    expect([...fleet, ...cases].sort()).toEqual(onDisk);

    const projects = v.parse(
      v.array(v.object({ test: v.object({ name: v.string(), maxWorkers: v.optional(v.number()) }) })),
      firstRunConfig.test?.projects,
    );

    expect(projects.find((project) => project.test.name === FIRST_RUN_PROJECTS.fleet)?.test.maxWorkers).toBe(1);
    // A deployed episode's completion is decided by the episode. An elapsed
    // deadline here would report a slow model as a product defect.
    expect(firstRunConfig.test?.testTimeout).toBe(0);
  });

  test('every case loads under the tier\'s own runner', () => {
    // Collecting a case imports it, under Bun as the tier runs it, which the partition above never does. On
    // 2026-09-25 35 cases failed there at import (`import { z } from 'zod'` in core came back undefined), and only a
    // deploy's post-publish wave would have shown it.
    const listed = spawnSync('bun', ['--bun', './node_modules/.bin/vitest', 'list', '--config', 'vitest.first-run.config.ts', '--json'],
      { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });

    expect(listed.status, listed.stderr).toBe(0);
  });
});

describe('every case has a defect register entry', () => {
  test('the register covers exactly the declared cases', () => {
    expect(Object.keys(FIRST_RUN_DEFECTS).sort()).toEqual([...FIRST_RUN_CASES].sort());

    for (const id of FIRST_RUN_CASES) {
      const defect = FIRST_RUN_DEFECTS[id];
      expect(defect.id).toBe(id);
    }
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

  test('the arm records what it did not control', () => {
    // A deployed workspace's tool surface and evolution are its own durable
    // config and this tier sets neither. Reporting a setting it never applied
    // would be a claim about a knob nobody turned.
    expect(FIRST_RUN_ARM).toEqual({ evolution: false, settle: 'none', tools: [] });
    expect(FIRST_RUN_FAMILY).toBe('first-run');
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

describe('the tier has a deployment gate and package command', () => {
  test('the ladder schedules the tier only after deployment', () => {
    const entry = LADDER.find((gate) => gate.run === GATE);
    expect(entry, `${GATE} is not in LADDER`).toBeDefined();
    expect(entry?.tier).toBe('deploy');
    // And it cannot run at ci: there is nothing deployed at ci to run it
    // against, which is a reason that has to be written down rather than
    // discovered.
    expect(Object.hasOwn(CI_EXEMPT, GATE)).toBe(true);
  });

  test('the package script resolves to the runner', () => {
    // Through the ladder's own parsed reader rather than a second JSON read:
    // `packageScripts` validates the manifest at the boundary, so a manifest
    // with no scripts table fails there instead of reading as an empty object
    // that satisfies nothing.
    expect(packageScripts()['gate:first-run']).toBe(`bash ${RUNNER}`);
  });
});

