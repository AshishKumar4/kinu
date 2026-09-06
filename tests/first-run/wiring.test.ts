/** Credential-free checks for the first-run corpus, gating, and record admission. */
import { describe, expect, test } from 'bun:test';

import { assessAdmissibility, outcomeRow, subgoalOutcome, TASK_OUTCOME,
  type EvalObservation } from '@kinu.run/test-utils';
import { isFirstRunSuite, trackedFiles } from '../../scripts/sources';
import {
  CI_EXEMPT, LADDER, packageScripts,
} from '../../scripts/ladder';
import firstRunConfig, { FIRST_RUN_INCLUDE } from '../../vitest.first-run.config';
import {
  FIRST_RUN_ARM, FIRST_RUN_CASES, FIRST_RUN_DEFECTS, FIRST_RUN_FAMILY,
} from './first-run';
import { resolvePublicSessionPlan } from '../evals/public-session';

/** The deployed tier's package command. */
const GATE = 'bun run gate:first-run';
const RUNNER = 'scripts/first-run-tier.sh';

/** Every case file this tier holds, off the ONE enumeration and narrowed only by
 *  the predicate `scripts/sources.ts` exports for it. */
const onDisk = trackedFiles().filter(isFirstRunSuite).sort();

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
    for (const file of onDisk) expect(file.startsWith('tests/first-run/')).toBe(true);
    // And no case file can be selected by the two runners that must never see
    // it: `bun test` matches only `.test.`/`.spec.`, and the eval tier's config
    // includes `tests/evals/**` alone.
    for (const file of onDisk) {
      expect(/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)).toBe(false);
      expect(file.startsWith('tests/evals/')).toBe(false);
    }
  });

  test('the tier runs every case in one process, serially, with no wall clock', () => {
    // Two cases attach machines to ONE account's device fleet, and one of them
    // is measuring what happens when two machines are live. Running the files
    // concurrently would have a sibling's daemons inside that measurement.
    expect(firstRunConfig.test?.fileParallelism).toBe(false);
    // A deployed episode's completion is decided by the episode. An elapsed
    // deadline here would report a slow model as a product defect.
    expect(firstRunConfig.test?.testTimeout).toBe(0);
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
  test('five of six cases is inadmissible, and six carries the primary metric', () => {
    const scored = (id: string): EvalObservation => ({
      taskId: id, repetition: 0, outcome: 'scored',
      scores: [outcomeRow(subgoalOutcome(3, 3, 'every subgoal reached'))],
      turns: 1, toolCalls: 2, toolNames: ['laptop.exec'], tokensIn: 10, tokensOut: 5, ms: 1_000,
    });
    const declared = [...FIRST_RUN_CASES];

    const partial = assessAdmissibility(declared, declared.slice(0, 5).map(scored));
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
      turns: 1, toolCalls: 2, tokensIn: 10, tokensOut: 5, ms: 1_000,
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

