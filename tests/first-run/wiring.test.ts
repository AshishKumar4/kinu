/**
 * THE FIRST-RUN TIER'S OWN WIRING, credential-free.
 *
 * Everything about this tier that is a property of the HARNESS rather than of a
 * deployment is checked here, at every tier, for nothing. The live half costs a
 * deploy, two daemons and a browser, so a defect that can be caught here must
 * not be discovered there.
 *
 * A `.test.ts` deliberately: `bun test ./tests/` already runs it at ci and at
 * deploy, so the tier's wiring is proved before the deploy whose product it
 * will judge. The live cases are `*.first-run.ts`, which no `bun test`
 * invocation can select.
 *
 * WHAT EACH GROUP GUARDS, stated because a test whose failure mode is unclear
 * gets deleted by the next person:
 *
 *   corpus      the set this tier RUNS equals the set it DECLARES equals the
 *               set on disk. This tier exists because a gate measured a smaller
 *               set than it governed; a first-run tier with a case file nobody
 *               runs would be the same defect wearing this tier's name.
 *   defects     every case names the defect it is red on, why the pre-deploy
 *               gates missed it, and either the sha its red direction was proved
 *               against or the reason there is none.
 *   fresh       a case gets its own workspace and deletes it, and the plan that
 *               opens one is refused outright off the cloud backend.
 *   admissible  a run that measured four of five cases is not evidence about the
 *               fifth, and a run whose scores carry no `task_outcome` measured
 *               activity rather than whether anything worked.
 *   gate        the tier is declared at all three sites the census requires.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assessAdmissibility, outcomeRow, subgoalOutcome, TASK_OUTCOME,
  type EvalObservation } from '@kinu.run/test-utils';
import { isFirstRunSuite, trackedFiles } from '../../scripts/sources';
import {
  CI_EXEMPT, LADDER, SERIAL_GATES, deployGates, deployWaves, packageScripts,
} from '../../scripts/ladder';
import firstRunConfig, { FIRST_RUN_INCLUDE } from '../../vitest.first-run.config';
import {
  FIRST_RUN_ARM, FIRST_RUN_CASES, FIRST_RUN_DEFECTS, FIRST_RUN_FAMILY,
} from './first-run';
import { resolvePublicSessionPlan } from '../evals/public-session';

const REPO_ROOT = resolve(import.meta.dir, '../..');

/** The gate line, spelled once. Every site below is compared against THIS
 *  string, so three declarations cannot drift into three gates. */
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

describe('every case names the defect it is red on', () => {
  test('each declared case has a register entry with a red direction', () => {
    expect(Object.keys(FIRST_RUN_DEFECTS).sort()).toEqual([...FIRST_RUN_CASES].sort());
    for (const id of FIRST_RUN_CASES) {
      const defect = FIRST_RUN_DEFECTS[id];
      expect(defect.id).toBe(id);
      // What the user did, why every gate missed it, and how it fails today.
      // Prose lengths rather than exact text: the register is written for a
      // reader, and pinning its wording would make an improvement a failure.
      expect(defect.found.length).toBeGreaterThan(40);
      expect(defect.missedBecause.length).toBeGreaterThan(40);
      expect(defect.redDirection.length).toBeGreaterThan(40);
    }
  });

  test('a proved red direction names a real commit, and an unproved one says why', () => {
    // The rule this tier creates is that a defect found by hand gets a row
    // BEFORE its fix ships — so a row with no sha is legitimate and a row with a
    // sha must be checkable. Both are held: `provedRedAt` is either a sha shape
    // or null, and a null one has to explain itself in `redDirection`.
    const sha = /^[0-9a-f]{9,40}$/;
    for (const id of FIRST_RUN_CASES) {
      const defect = FIRST_RUN_DEFECTS[id];
      if (defect.provedRedAt === null) {
        expect(defect.redDirection.toUpperCase()).toContain('RED');
        continue;
      }
      expect(sha.test(defect.provedRedAt), `${id} names ${defect.provedRedAt}`).toBe(true);
    }
    // At least one row proved red against a real deployed build, or this tier
    // is a set of assertions nobody has seen fail.
    expect(FIRST_RUN_CASES.filter((id) => FIRST_RUN_DEFECTS[id].provedRedAt !== null).length)
      .toBeGreaterThanOrEqual(3);
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

  test('the runner refuses to measure nothing', () => {
    // The one place this tier differs from the eval tier, held as a fact about
    // the script: a missing credential FAILS. A post-deploy gate that skipped
    // every case would exit 0 having looked at no product at all.
    const script = readFileSync(join(REPO_ROOT, RUNNER), 'utf8');
    expect(script).toContain('KINU_EVAL_BACKEND=cloud');
    expect(script).toContain('KINU_EVAL_WEB_IDENTITY');
    expect(script).toContain('--expect-live');
    // And it names the override a production run requires, so the command that
    // measures production is discoverable from the script that runs it.
    expect(script).toContain('KINU_EVAL_ALLOW_PROD=1');
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
  test('four of five cases is inadmissible, and five carries the primary metric', () => {
    const scored = (id: string): EvalObservation => ({
      taskId: id, repetition: 0, outcome: 'scored',
      scores: [outcomeRow(subgoalOutcome(3, 3, 'every subgoal reached'))],
      turns: 1, toolCalls: 2, toolNames: ['laptop.exec'], tokensIn: 10, tokensOut: 5, ms: 1_000,
    });
    const declared = [...FIRST_RUN_CASES];

    const partial = assessAdmissibility(declared, declared.slice(0, 4).map(scored));
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

describe('the tier is declared at all three sites', () => {
  test('deploy.sh runs it, after the smoke gate, in a wave of its own', () => {
    // THE ORDER IS THE CLAIM. This tier judges the DEPLOYED build, so it cannot
    // run in step 1 with the source gates; and it must not run beside
    // `gate:infra`, because both drive the same account.
    const source = readFileSync(join(REPO_ROOT, 'scripts/deploy.sh'), 'utf8');
    expect(source).toContain(`run_required_gate "First-run tier" ${GATE}`);
    const smokeAt = source.indexOf('Step 4: Post-deploy smoke test');
    const gateAt = source.indexOf(`run_required_gate "First-run tier" ${GATE}`);
    expect(smokeAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(smokeAt);

    const waves = deployWaves(source);
    const wave = waves.findIndex((entries) => entries.includes(GATE));
    expect(waves[wave]).toEqual([GATE]);
    // Its own wave means it must declare itself serial, or `deploy.test.ts`'s
    // "the serial gates run alone" assertion is satisfied by an undeclared one.
    expect(Object.keys(SERIAL_GATES)).toContain(GATE);
    expect(deployGates(source)).toContain(GATE);
  });

  test('the ladder declares it at the deploy tier, with what it catches and misses', () => {
    const entry = LADDER.find((gate) => gate.run === GATE);
    expect(entry, `${GATE} is not in LADDER`).toBeDefined();
    expect(entry?.tier).toBe('deploy');
    // A gate whose blind spots are unwritten is a gate whose reach nobody can
    // judge — the rule every other row here follows.
    expect((entry?.catches ?? '').length).toBeGreaterThan(80);
    expect((entry?.blind ?? '').length).toBeGreaterThan(80);
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
