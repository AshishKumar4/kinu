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
 *   FRESH.      Mutating cases create a fresh workspace and delete it in finally.
 *               Explicit owned-workspace read-only cases do not use that runner:
 *               they keep user data intact and record only their actual reads.
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
 * six cases are the `*.first-run.ts` files beside it; the credential-free
 * assertions over this wiring are `wiring.test.ts`, which runs at every tier and
 * costs nothing.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVAL_MODELS, ledgerTotalsFromEvents, outcomeRow, projectRunEventProvenance, publishRunRecord,
  reportLiveModelSpend, retainEpisodeTranscript, subgoalsOutcome, withEpisodeEvidence,
  type EpisodeEvidenceReader, type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalSubgoal, type EvalTier,
} from '@kinu.run/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { disposeFailedCase } from '../evals/episode-failure';
import {
  resolvePublicSessionPlan, type KinuPublicSession, type PublicSessionPlan,
} from '../evals/public-session';

/** The family every case's record is published under, so one tier's evidence is
 *  one family rather than six. */
export const FIRST_RUN_FAMILY = 'first-run';

/** Every case this tier declares, in the order the defects were found. The list
 *  is DATA and lives here rather than in the six files, because "the set this
 *  tier measures equals the set it governs" is the property `wiring.test.ts`
 *  asserts, and a set spread across six modules cannot be asserted at all. */
export const FIRST_RUN_CASES = [
  'codemode-craft',
  'approve-clears',
  'two-machines',
  'enter-sends',
  'files-outside-tree',
  'slate',
  'command-refusal',
  'preview-address',
  'workspace-title',
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
  'slate': {
    id: 'slate',
    found: 'An agent-built slate appears in the tab strip but its HTTP preview cannot answer.',
    missedBecause: 'Lower-level suites run projects written by test authors. They do not check '
      + 'whether files authored by the model produce a working preview.',
    provedRedAt: null,
    redDirection: 'Not proved red against a deployed sha. The first deployed tier run must '
      + 'measure listing, preview startup, and the authored HTTP response.',
  },
  'command-refusal': {
    id: 'command-refusal',
    found: 'A production slate binding and workspace executor reported a command that never ran as ordinary exit-one prose, losing the denied or waiting-for-approval class.',
    missedBecause: 'Tests checked NOT RUN prose and queue state rather than structural producer refusals; generic stdout interpretation also mistakes successful business data for errors.',
    provedRedAt: '53ba25348',
    redDirection: 'Non-model CLI REST and AgentClient calls require producer-owned refusal metadata and no execution for denied/parked commands. Executed exit-one failures and successful JSON-looking stdout are independent controls. Original 53ba25348 RED receipts remain retained unchanged.',
  },
  'preview-address': {
    id: 'preview-address',
    found: 'Production admitted a workspace name whose length prevented every workspace preview URL.',
    missedBecause: 'Creation tests used short names; preview-only tests refused the long name after the unusable workspace already existed.',
    provedRedAt: '53ba25348',
    redDirection: 'Non-model CLI creation must reject a fresh 32-character address with the 31-character limit, while a fresh 31-character address must serve actual preview HTTP.',
  },
  'workspace-title': {
    id: 'workspace-title',
    found: 'The owned workspace registry held its generated display title, but the loaded actor status returned the workspace ID.',
    missedBecause: 'Warm or locally initialized status fixtures did not read a generated title from the real owner registry on a cold actor.',
    provedRedAt: 'b48b9bba4',
    redDirection: 'Read-only production mismatch retained by the title owner in workspace-title-production-before.json. This case selects an explicitly owned workspace with a distinct registry title, reads its loaded snapshot first, and compares without writes, eviction or model/spend claims.',
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
 *  `resolveArtifactRoot` rule every other family states. ONE directory per
 *  suite process, resolved at import: every case retains its ledger and its
 *  transcript under it before its subgoals are asserted, and the record this
 *  process publishes names the same directory. Minting it at publish time
 *  instead makes the record point at a directory nothing has ever written
 *  into. */
const TRANSCRIPTS = join(
  resolveArtifactRoot({
    flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
    repoRoot: REPO_ROOT, runRoot: tmpdir(),
  }),
  `first-run-${FIRST_RUN_TIER}-${String(Date.now())}`,
);

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
  'slate': 'slate',
  'command-refusal': 'command',
  'preview-address': 'address',
  'workspace-title': 'title',
} satisfies Record<FirstRunCase, string>;
/** What a case's body is handed, and what it hands back. */
export interface FirstRunSession extends EpisodeEvidenceReader {
  readonly describe: string;
  teardown(): Promise<void>;
}

export interface FirstRunPlan<Session extends FirstRunSession> {
  open(request: { subject: string; purpose: string }): Promise<Session>;
}

export interface FirstRunRun<Session extends FirstRunSession = KinuPublicSession, Plan = PublicSessionPlan> {
  readonly session: Session;
  readonly plan: Plan;
}

export interface FirstRunCaseSpec<Session extends FirstRunSession = KinuPublicSession, Plan = PublicSessionPlan> {
  readonly id: FirstRunCase;
  /** The mission the REST create is given — what this workspace is FOR. */
  readonly purpose: string;
  /** Whether the case drives the model. `expected` fails the case when its
   *  store accounted for no call, because a green over zero calls is the
   *  vacuous tier this suite was rebuilt to remove; `none` records a measured
   *  zero and fails the case if the store disagrees. */
  readonly modelCalls: 'expected' | 'none';
  /** The case, driven the way a user drives it. Returns the subgoals it
   *  checked; every one of them is asserted by {@link runFirstRunCase}. */
  run(input: FirstRunRun<Session, Plan>): Promise<readonly EvalSubgoal[]>;
  /** Calls outside the workspace ledger, added to its observed tool-call count. */
  calls?(): number;
}

/**
 * Run one first-run case against the deployed product and record it.
 *
 * THE ORDER IS THE CONTRACT, and every line of it was a defect in some sibling
 * arm before it was a rule here:
 *
 *   1. A FRESH workspace, through the public REST. Never reused between cases.
 *   2. SPEND FIRST — recorded before any assertion can throw, because what a run
 *      cost is a fact about the run rather than a reward for passing.
 *   3. THE LEDGER, READ. Turns, tool calls and tokens come off the workspace's
 *      own run-event routes, the same read the trajectory arm scores from.
 *      `turns: 0, tokensIn: 0` as literals makes every record this tier
 *      publishes INADMISSIBLE — "zero graded turns" — beside a spend line
 *      showing the eight calls it just made.
 *   4. THE EVIDENCE, RETAINED: ledger, transcript and verdicts under the
 *      directory the record names, before any verdict on them.
 *   5. THE OBSERVATION before the assertions, so a missed subgoal still reaches
 *      the record with what the case actually saw. A record that only
 *      accumulates successes is not evidence.
 *   6. EVERY subgoal asserted, each in its own failure message.
 *   7. TEARDOWN in a `finally` — this DELETES the workspace, so a case that
 *      threw must not leave a row on the account.
 */
export async function runFirstRunCase<Session extends FirstRunSession, Plan>(
  plan: FirstRunPlan<Session> & Plan,
  spec: FirstRunCaseSpec<Session, Plan>,
  observations: EvalObservation[],
): Promise<void> {
  const startedAt = Date.now();
  let opened: Session | undefined;
  try {
    await withEpisodeEvidence(async () => {
      opened = await plan.open({ subject: spec.id, purpose: spec.purpose });
      return opened;
    }, { transcripts: TRANSCRIPTS, taskId: spec.id, modelCalls: spec.modelCalls }, async (session, collect) => {
    console.warn(`    [first-run] ${spec.id} on ${session.describe}`);
    const subgoals = await spec.run({ session, plan });

    const { events, history } = await collect();
    const totals = ledgerTotalsFromEvents(events);
    const retained = retainEpisodeTranscript(TRANSCRIPTS, spec.id, { events, history, subgoals });

    const outcome = subgoalsOutcome(subgoals, { turns: totals.turns, toolCalls: totals.toolCalls });
    const scores: EvalScoreRow[] = [outcomeRow(outcome)];
    observations.push({
      taskId: spec.id, repetition: 0, outcome: 'scored', scores,
      turns: totals.turns, toolCalls: totals.toolCalls + (spec.calls?.() ?? 0),
      toolNames: totals.toolNames,
      tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, reasoningOut: totals.reasoningOut,
      provenance: projectRunEventProvenance(events),
      ms: Date.now() - startedAt,
    });
    console.warn(`    [first-run] ${spec.id}: ${String(totals.turns)} turn(s), `
      + `${String(totals.toolCalls)} tool call(s), ${String(outcome.reached)}/${String(outcome.total)} `
      + `subgoals — retained at ${retained}`);
    for (const subgoal of subgoals) {
      console.warn(`    [first-run] ${spec.id}/${subgoal.what}: `
        + `${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
    }

    for (const subgoal of subgoals) {
      expectReached(spec.id, subgoal);
    }
    });
  } catch (error) {
    // THREE CAUSES AND ONE VALUE THAT NAMES WHICH — the behaviour arm's own
    // classification, reused rather than re-derived: `inert` is the product
    // producing nothing, `errored` is this harness failing, and a case the
    // ENVIRONMENT killed is neither and stays resumable.
    //
    // ONE ROW PER CASE. A case that was already scored carries its verdict
    // above — the throw after it is `expectReached` naming the miss, which the
    // outcome row holds as partial credit — so a second row here would count one
    // attempt twice and file the product's shortcoming as this harness failing.
    // Measured on 2026-09-06: the `slate` record carried `scored` (3/4) AND
    // `errored: slate/replied …` for the same pairing key.
    const thrown = error instanceof Error ? error : new Error(String(error));
    if (!observations.some((o) => o.taskId === spec.id)) {
      observations.push({
        taskId: spec.id, repetition: 0,
        outcome: disposeFailedCase(thrown).outcome,
        reason: thrown.message,
      });
    }
    throw error;
  } finally {
    await opened?.teardown();
  }
}

/**
 * A subgoal's verdict as a THROW rather than a matcher.
 *
 * This module is imported by the case files and by nothing that runs under
 * a test runner's globals, so it raises rather than reaching for `expect`: the
 * failure text is the whole point, and a plain `Error` carries it identically in
 * every runner.
 */
export function expectReached(caseId: FirstRunCase, subgoal: EvalSubgoal): void {
  if (subgoal.reached) return;
  throw new Error(`${caseId}/${subgoal.what}: ${subgoal.detail}`);
}

/** Publish with the actual selected model; an operator-only case names none. */
export function publishFirstRunRecord(
  suite: string, modelId: string | undefined, declared: readonly FirstRunCase[], observations: EvalObservation[],
): void {
  const spend = reportLiveModelSpend(suite);
  publishRunRecord({
    family: FIRST_RUN_FAMILY, tier: FIRST_RUN_TIER, modelId: modelId ?? 'no-model',
    repeats: 1, seed: 1, arm: FIRST_RUN_ARM, declaredTasks: [...declared], observations, spend,
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });
}
