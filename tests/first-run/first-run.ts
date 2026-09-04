/**
 * THE FIRST-RUN TIER: what a new user meets, checked on the deployed product
 * after every deploy.
 *
 * WHY IT EXISTS. Between 2026-09-01 and 2026-09-03 the owner found four product
 * defects by hand that 33 gates and an 11,531-test census never touched: a
 * crafted tool whose body would not run, an Approve button that re-ticked every
 * box it had just cleared, two connected machines flapping on one executor slot,
 * and Enter not sending in the TUI. Each had a green test. Each of those tests
 * exercised what its AUTHOR wrote — an `async (args) =>` body handed to the
 * executor, a fixture queue, one fake daemon, a CR byte — and a user brings the
 * model, the click, the second machine and the LF byte instead.
 *
 * Every other gate in this repository runs BEFORE a deploy, on THIS tree, over
 * author-written inputs. `behaviour.eval.ts` drives a real model and
 * deliberately refuses instructed crafting; `live-smoke` sends one turn to prove
 * the wire. So the whole ladder can be green while the product a person meets is
 * red, and AGENTS.md already names that failure for four other gates: a gate
 * that measures a smaller set than the one it governs. This tier is the fifth
 * and the largest, and it closes it from the other side — by driving the
 * DEPLOYED product the way a user drives it.
 *
 * THE STANDING RULE THIS TIER CREATES. A defect the owner finds by hand gets a
 * first-run row BEFORE its fix ships. The row is written against the deployed
 * build that still has the bug, so it is red on the mechanism rather than on the
 * author's idea of it; the fix is what turns it green. AGENTS.md § Build & Check
 * states the same rule for whoever reaches it from that side.
 *
 * WHAT EVERY CASE IN THIS TIER HAS TO BE:
 *
 *   FRESH.      One workspace per case, created through the public REST the web
 *               app creates one with, deleted in a `finally`. A case that
 *               inherits another's state is measuring the harness.
 *   DEPLOYED.   `resolveEvalTarget` / `workerSession` resolve the target and
 *               `KinuPublicSession` drives it — the same surfaces the trajectory
 *               arm uses, reused rather than forked.
 *   HARD.       Assertions only. No statistical score, no "the reply mentioned
 *               it", no `toBeGreaterThan(0)` over a count. A first-run case that
 *               can pass on a broken product is the thing this tier exists to
 *               stop being written.
 *   PAID FOR.   Spend is recorded before any assertion can throw — a turn that
 *               ran and then failed a subgoal still burned what it burned.
 *
 * This module is the half every case shares: the plan, the corpus declaration,
 * the fresh-workspace-per-case invariant, the spend recording, the record. The
 * five cases are the `*.first-run.ts` files beside it; the credential-free
 * assertions over this wiring are `wiring.test.ts`, which runs at every tier and
 * costs nothing.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVAL_MODELS, outcomeRow, publishRunRecord, recordWorkspaceSpend, reportLiveModelSpend,
  subgoalOutcome,
  type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalTier,
} from '@kinu.run/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { disposeFailedCase } from '../evals/episode-failure';
import {
  resolvePublicSessionPlan, type KinuPublicSession, type PublicSessionPlan,
} from '../evals/public-session';

/** The family every case's record is published under, so one tier's evidence is
 *  one family rather than five. */
export const FIRST_RUN_FAMILY = 'first-run';

/** Every case this tier declares, in the order the defects were found. The list
 *  is DATA and lives here rather than in the five files, because "the set this
 *  tier measures equals the set it governs" is the property `wiring.test.ts`
 *  asserts, and a set spread across five modules cannot be asserted at all. */
export const FIRST_RUN_CASES = [
  'codemode-craft',
  'approve-clears',
  'two-machines',
  'enter-sends',
  'files-outside-tree',
] as const;
export type FirstRunCase = (typeof FIRST_RUN_CASES)[number];

/**
 * The defect each case is red on, in the words of the person who found it, with
 * the deployed sha the red direction was proved against.
 *
 * Written down because a first-run case whose mechanism lives only in its
 * assertions is one the next person deletes as flaky. `provedRedAt` is the
 * DEPLOYED BUILD the case was run against and failed on; `null` means the red
 * direction could not be proved by re-running history and the reason is in
 * `redDirection`.
 */
export interface FirstRunDefect {
  readonly id: FirstRunCase;
  /** What the user did, and what the product did instead. */
  readonly found: string;
  /** Why every pre-deploy gate stayed green over it. */
  readonly missedBecause: string;
  /** The sha whose deployed build makes this case fail, or null with a reason. */
  readonly provedRedAt: string | null;
  readonly redDirection: string;
}

export const FIRST_RUN_DEFECTS = {
  'codemode-craft': {
    id: 'codemode-craft',
    found: 'A tool the agent built for itself would not run: the crafted body reached the '
      + 'executor and failed instead of answering.',
    missedBecause: 'every crafted-tool test hands the executor a body the TEST author wrote — an '
      + '`async (args) => …` that is valid by construction — so the one thing a user depends on, '
      + 'a body the MODEL wrote, was never executed by any suite.',
    provedRedAt: null,
    redDirection: 'RED against the deployed build at the time of writing, and it stays red until '
      + "the CraftValidation lane's rebuild on codemode's modules+prelude lands. It is written "
      + 'first and deliberately: this is the tier\'s own rule applied to itself.',
  },
  'approve-clears': {
    id: 'approve-clears',
    found: 'Approving the parked commands re-ticked every checkbox instead of clearing them, so '
      + 'the queue looked like it had refilled itself.',
    missedBecause: 'the queue\'s own tests drive the RPC and the read model, where the decided '
      + 'row does disappear. Nothing clicked the button, and the re-tick is in the component: '
      + 'selection is `null`-means-everything and the decision resets it to `null`.',
    provedRedAt: null,
    redDirection: 'both halves are asserted — the RPC half (the decided row is gone and the '
      + 'approved command then runs) and the UI half (no checkbox is left checked after the '
      + 'click). The UI half is the one that was red by hand.',
  },
  'two-machines': {
    id: 'two-machines',
    found: 'With two machines connected, two calls in one turn landed on different machines: the '
      + 'executor answered as if the account had one.',
    missedBecause: 'every device test attaches ONE fake daemon, so "the first live socket" and '
      + '"the machine the user named" are the same machine in the fixture and different machines '
      + 'in the account.',
    provedRedAt: 'd894de564',
    redDirection: 'the parent of d894de564 resolves no name: an unnamed call lands on whichever '
      + 'machine map iteration yields, and a NAMED call is not routed at all.',
  },
  'enter-sends': {
    id: 'enter-sends',
    found: 'Enter did not send in the composer on a real terminal: the draft stayed put and no '
      + 'turn ran.',
    missedBecause: 'the in-process renderer negotiates no keyboard protocol and delivered CR '
      + 'only. A tty can deliver Enter as LF, and the LF spelling hit opentui\'s default table, '
      + 'which opens a line.',
    provedRedAt: '4e1122d2d',
    redDirection: 'the parent of 4e1122d2d binds `return` only, so the LF run submits nothing '
      + 'and the deployed workspace records no user turn.',
  },
  'files-outside-tree': {
    id: 'files-outside-tree',
    found: 'Opening a hosted file in the Files tab answered EIO — "Code generation from strings '
      + 'disallowed for this context".',
    missedBecause: 'the ranged read ran `node -e` through the box\'s exec, and `node -e` compiles '
      + 'its source with `new Function`, which workerd forbids and every Node-hosted test '
      + 'allows. The whole bun suite was green over it.',
    provedRedAt: '675444233',
    redDirection: 'the parent of 675444233 has no native ranged read on the box file plane, so '
      + 'the first read of a path outside the workspace tree answers EIO on the deployment.',
  },
} satisfies Record<FirstRunCase, FirstRunDefect>;

/** Which arm this process is — the same split every sibling eval arm declares. */
export const FIRST_RUN_TIER: EvalTier = process.env.KINU_EVAL_TIER === 'pro' ? 'pro' : 'flash';

/**
 * The arm, recorded because a measurement whose mechanism was switched off is
 * not a measurement of that mechanism.
 *
 * `tools` is empty and `evolution` false for the reason the device arm states:
 * this tier drives DEPLOYED surfaces and a deployed workspace's tool surface and
 * evolution are its own durable config. Reporting a setting this tier never
 * applied would be a claim about a knob nobody turned.
 */
export const FIRST_RUN_ARM: EvalArmState = { evolution: false, settle: 'none', tools: [] };

const REPO_ROOT = join(import.meta.dirname, '../..');

/** Retained beside the record, never under a swept root — the same
 *  `resolveArtifactRoot` rule every other family states. */
function transcriptRoot(): string {
  return join(
    resolveArtifactRoot({
      flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
      repoRoot: REPO_ROOT, runRoot: tmpdir(),
    }),
    `first-run-${FIRST_RUN_TIER}-${String(Date.now())}`,
  );
}

/**
 * One case's subgoal: what was checked, whether it held, and the evidence.
 *
 * The evidence is not decoration. A first-run failure is read by somebody who
 * was not watching the run, and "MISSED" with no server text is a failure nobody
 * can act on.
 */
export interface FirstRunSubgoal {
  readonly what: string;
  readonly reached: boolean;
  readonly detail: string;
}

/**
 * The live plan for one case, or the reason this environment has none.
 *
 * The resolution is the eval seam's, not this tier's: cloud-gated first, then
 * `resolveEvalTarget`, then the browser plane's identity. Resolved ONCE per
 * module at import so the reason is printed on the line above the skip rather
 * than inside a test nobody ran.
 */
export function firstRunPlan(suite: string): PublicSessionPlan | null {
  const resolution = resolvePublicSessionPlan(suite, EVAL_MODELS[FIRST_RUN_TIER]);
  if (resolution.kind === 'unavailable') {
    console.warn(`[skip] ${suite} — ${resolution.remedy}`);
    return null;
  }
  console.warn(`[live] ${suite} — ${resolution.plan.describe}`);
  return resolution.plan;
}


/**
 * The plan every first-run case opens, with the workspace name kept short
 * enough to delete.
 *
 * The deployment tears a workspace down through its sandbox, whose ids are
 * capped at 63 characters by the substrate itself — a longer workspace name
 * CREATES fine and then cannot be torn down, which is exactly what a tier that
 * promises "teardown in a finally" must not discover late. The resolver composes
 * `first-run-<case>-<subject>-<random>`; this wrapper trims the subject to the
 * case id alone, which keeps every case's name under the cap with room.
 */
export function firstRunCasePlan(suite: string, caseId: FirstRunCase): PublicSessionPlan | null {
  const plan = firstRunPlan(suite);
  if (plan === null) return null;
  return {
    ...plan,
    open: (request) => plan.open({ ...request, subject: SHORT_SUBJECT[caseId] }),
  };
}

/**
 * The subject each case opens its workspace under, kept to one short word.
 *
 * The resolver composes `eval-<suite-slug>-<subject>-<random>`, and the suite
 * slug alone (`first-run-files-outside-tree`) is already 26 characters — with
 * the case id repeated as the subject, every name lands at 59-63 and the longest
 * tip over the substrate's 63-character sandbox-id cap, which CREATES fine and
 * then cannot be torn down. One short word keeps the attribution (the suite
 * slug says which tier, the record says which case) and every name short.
 */
const SHORT_SUBJECT = {
  'codemode-craft': 'craft',
  'approve-clears': 'approve',
  'two-machines': 'fleet',
  'enter-sends': 'enter',
  'files-outside-tree': 'files',
} satisfies Record<FirstRunCase, string>;
/** What a case's body is handed, and what it hands back. */
export interface FirstRunRun {
  readonly session: KinuPublicSession;
  readonly plan: PublicSessionPlan;
}

export interface FirstRunCaseSpec {
  readonly id: FirstRunCase;
  /** The mission the REST create is given — what this workspace is FOR. */
  readonly purpose: string;
  /** The case, driven the way a user drives it. Returns the subgoals it
   *  checked; every one of them is asserted by {@link runFirstRunCase}. */
  run(input: FirstRunRun): Promise<readonly FirstRunSubgoal[]>;
  /** Tool calls this case made through the deployed plane, for the record's
   *  covariate. Read after `run`, so a case that threw still reports what it
   *  had done by then. */
  calls?(): number;
}

/**
 * Run one first-run case against the deployed product and publish its record.
 *
 * THE ORDER IS THE CONTRACT, and every line of it was a defect in some sibling
 * arm before it was a rule here:
 *
 *   1. A FRESH workspace, through the public REST. Never reused between cases.
 *   2. SPEND FIRST — recorded before any assertion can throw, because what a run
 *      cost is a fact about the run rather than a reward for passing.
 *   3. THE OBSERVATION before the assertions, so a missed subgoal still reaches
 *      the record with what the case actually saw. A record that only
 *      accumulates successes is not evidence.
 *   4. EVERY subgoal asserted, each in its own failure message.
 *   5. TEARDOWN in a `finally` — this DELETES the workspace, so a case that
 *      threw must not leave a row on the account.
 */
export async function runFirstRunCase(
  plan: PublicSessionPlan,
  spec: FirstRunCaseSpec,
  observations: EvalObservation[],
): Promise<void> {
  const startedAt = Date.now();
  const session = await plan.open({ subject: spec.id, purpose: spec.purpose });
  console.warn(`    [first-run] ${spec.id} on ${session.describe}`);
  try {
    const subgoals = await spec.run({ session, plan });

    // SPEND FIRST. Every path below this line can throw.
    recordWorkspaceSpend(await session.spend());

    const reached = subgoals.filter((subgoal) => subgoal.reached).length;
    const detail = subgoals
      .map((subgoal) => `${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`)
      .join('; ');
    const scores: EvalScoreRow[] = [
      outcomeRow(subgoalOutcome(reached, subgoals.length, detail)),
    ];
    observations.push({
      taskId: spec.id, repetition: 0, outcome: 'scored', scores,
      turns: 0, toolCalls: spec.calls?.() ?? 0,
      tokensIn: 0, tokensOut: 0, ms: Date.now() - startedAt,
    });
    for (const subgoal of subgoals) {
      console.warn(`    [first-run] ${spec.id}/${subgoal.what}: `
        + `${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
    }

    for (const subgoal of subgoals) {
      expectReached(spec.id, subgoal);
    }
  } catch (error) {
    // THREE CAUSES AND ONE VALUE THAT NAMES WHICH — the behaviour arm's own
    // classification, reused rather than re-derived: `inert` is the product
    // producing nothing, `errored` is this harness failing, and a case the
    // ENVIRONMENT killed is neither and stays resumable.
    const thrown = error instanceof Error ? error : new Error(String(error));
    observations.push({
      taskId: spec.id, repetition: 0,
      outcome: disposeFailedCase(thrown).outcome,
      reason: thrown.message,
    });
    throw error;
  } finally {
    await session.teardown();
  }
}

/**
 * A subgoal's verdict as a THROW rather than a matcher.
 *
 * This module is imported by the five case files and by nothing that runs under
 * a test runner's globals, so it raises rather than reaching for `expect`: the
 * failure text is the whole point, and a plain `Error` carries it identically in
 * every runner.
 */
export function expectReached(caseId: FirstRunCase, subgoal: FirstRunSubgoal): void {
  if (subgoal.reached) return;
  throw new Error(`${caseId}/${subgoal.what}: ${subgoal.detail}`);
}

/** Publish this suite's record. Called from one `afterAll` per case file, so a
 *  file that crashed still publishes what it observed. */
export function publishFirstRunRecord(
  suite: string, declared: readonly FirstRunCase[], observations: EvalObservation[],
): void {
  const spend = reportLiveModelSpend(suite);
  publishRunRecord({
    family: FIRST_RUN_FAMILY, tier: FIRST_RUN_TIER, modelId: EVAL_MODELS[FIRST_RUN_TIER],
    repeats: 1, seed: 1, arm: FIRST_RUN_ARM, declaredTasks: [...declared], observations, spend,
    transcripts: transcriptRoot(), repoRoot: REPO_ROOT,
  });
}
