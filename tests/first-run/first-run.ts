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
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REAL_CLOCK, type EvalAccount } from '../../packages/core/src/index';
import {
  createObservedModelAccumulator, EVAL_ACCOUNT_ENV, EVAL_MODELS, ledgerTotalsFromEvents, outcomeRow, scoreToolOutcomes, toolOutcomes,
  projectRunEventProvenance, publishRunRecord,
  reportLiveModelSpend, retainEpisodeTranscript, subgoalsOutcome, withEpisodeEvidence,
  type EpisodeEvidenceReader, type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalSubgoal, type EvalTier,
} from '@kinu.run/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { disposeFailedCase } from './episode-failure';
import {
  resolvePublicSessionPlan, type KinuPublicSession, type PublicSessionPlan,
} from '../../evals/src/session';

/** The family every case's record is published under, so one tier's evidence is
 *  one family rather than six. */
export const FIRST_RUN_FAMILY = 'first-run';

/** Serving models the cases reported, noted before each workspace is torn down
 *  (teardown DELETES it). One suite per process, so module scope is suite scope. */
const observedModels = createObservedModelAccumulator();

/**
 * The defect a case is red on, in the words of the person who found it, with
 * the deployed sha the red direction was proved against. Each case file holds
 * its own, and a missed subgoal's failure names it (`expectReached`).
 *
 * Written down because a first-run case whose mechanism lives only in its
 * assertions is one the next person deletes as flaky. `provedRedAt` is the
 * DEPLOYED BUILD the case was run against and failed on; `null` means the red
 * direction could not be proved by re-running history and the reason is in
 * `redDirection`.
 */
export interface FirstRunDefect {
  /** What the user did, and what the product did instead. */
  readonly found: string;
  /** Why every pre-deploy gate stayed green over it. */
  readonly missedBecause: string;
  /** The sha whose deployed build makes this case fail, or null with a reason. */
  readonly provedRedAt: string | null;
  readonly redDirection: string;
}

/** The model every case's workspace pins: the scripted one, served by the tiers' Worker (scripts/tier-model.ts). */
export const FIRST_RUN_TIER: EvalTier = 'scripted';

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
export function firstRunPlan(suite: string, account?: EvalAccount): PublicSessionPlan | null {
  const resolution = resolvePublicSessionPlan(suite, EVAL_MODELS[FIRST_RUN_TIER],
    account === undefined ? process.env : { ...process.env, [EVAL_ACCOUNT_ENV]: account });

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
/** A case's id: its file's name, `<id>.first-run.ts`, so the case set is the tracked files (`isFirstRunSuite`). */
export function firstRunCaseId(moduleUrl: string): string {
  return basename(fileURLToPath(moduleUrl), '.first-run.ts');
}

/**
 * The plan a case opens its workspace with, under `subject`: one short word.
 *
 * The resolver composes `eval-<suite-slug>-<subject>-<random>`, and the suite
 * slug alone (`first-run-files-outside-tree`) is already 26 characters — with
 * the case id repeated as the subject, every name lands at 59-63 and the longest
 * tip over the substrate's 63-character sandbox-id cap, which CREATES fine and
 * then cannot be torn down. One short word keeps the attribution (the suite
 * slug says which tier, the record says which case) and every name short.
 */
export function firstRunCasePlan(suite: string, subject: string, account?: EvalAccount): PublicSessionPlan | null {
  const plan = firstRunPlan(suite, account);

  if (plan === null) return null;

  return {
    ...plan,
    open: (request) => plan.open({ ...request, subject }),
  };
}


/** What a case's body is handed, and what it hands back. */
export interface FirstRunSession extends EpisodeEvidenceReader {
  readonly describe: string;
  teardown(): Promise<void>;
}

export interface FirstRunPlan<Session extends FirstRunSession> {
  open(request: { subject: string; purpose: string; genesis?: boolean }): Promise<Session>;
}

export interface FirstRunRun<Session extends FirstRunSession = KinuPublicSession, Plan = PublicSessionPlan> {
  readonly session: Session;
  readonly plan: Plan;
  /** Aborted when the case's `budgetMs` is spent: a wait the product may
   *  never end reads this and stops, so the verdict is read off the ledger
   *  as found rather than lost to the runner's own timeout. */
  readonly budget: AbortSignal;
}

export interface FirstRunCaseSpec<Session extends FirstRunSession = KinuPublicSession, Plan = PublicSessionPlan> {
  /** The case's id, `firstRunCaseId` of its file. */
  readonly id: string;
  /** What the case found, which a missed subgoal's failure names. */
  readonly defect: FirstRunDefect;
  /** The mission the REST create is given — what this workspace is FOR. */
  readonly purpose: string;
  /** Omit the autonomous opening turn when the fixture needs an untouched fleet. */
  readonly genesis?: boolean;
  /** Whether the case drives the model. `expected` fails the case when its
   *  store accounted for no call, because a green over zero calls is the
   *  vacuous tier this suite was rebuilt to remove; `none` records a measured
   *  zero and fails the case if the store disagrees. */
  readonly modelCalls: 'expected' | 'none';
  /** The most wall time the case may take once its session is open. When it
   *  is spent the evidence is retained as it stands and the case fails on
   *  the budget, with `failure.json` saying so. Every case declares one: a
   *  wait on a deployment may never end (a signed-in page has no default
   *  timeout, `signedInPage`), and without a budget such a wait is a silent
   *  hang of the whole tier, as approve-clears was on staging 7fecf0225. */
  readonly budgetMs: number;
  /** The case, driven the way a user drives it. Returns the subgoals it
   *  checked; every one of them is asserted by {@link runFirstRunCase}. */
  run(input: FirstRunRun<Session, Plan>): Promise<readonly EvalSubgoal[]>;
  /** Calls outside the workspace ledger, added to its observed tool-call count. */
  calls?(): number;
  /** The retained episode's own name, when one row runs more than once under
   *  one defect id. Each case keeps its events, history, and subgoals under
   *  `TRANSCRIPTS/<episode>/`, and two runs sharing `id` would otherwise
   *  overwrite each other's evidence — the device-link row's three cases are
   *  exactly that shape. Omit it for a row's single case; the task id remains
   *  the record's join either way. */
  readonly episode?: string;
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
 *   7. TEARDOWN on every path — this DELETES the workspace, so a case that
 *      threw must not leave a row on the account.
 */
export async function runFirstRunCase<Session extends FirstRunSession, Plan>(
  plan: FirstRunPlan<Session> & Plan,
  spec: FirstRunCaseSpec<Session, Plan>,
  observations: EvalObservation[],
): Promise<void> {
  // Refused before any workspace is made: a case with no budget can wait on the deployment forever.
  if (!(Number.isFinite(spec.budgetMs) && spec.budgetMs > 0)) {
    throw new Error(`${spec.id}: a first-run case declares the budget its waits end on (budgetMs), and this one declares none`);
  }

  const startedAt = Date.now();
  let opened: Session | undefined;
  let failure: Error | null = null;

  const episode = spec.episode ?? spec.id;

  try {
    await withEpisodeEvidence(async () => {
      opened = await plan.open({ subject: spec.id, purpose: spec.purpose, genesis: spec.genesis });

      return opened;
    }, { transcripts: TRANSCRIPTS, taskId: episode, modelCalls: spec.modelCalls, clock: REAL_CLOCK, budgetMs: spec.budgetMs }, async (session, collect, budget) => {
    console.warn(`    [first-run] ${spec.id} on ${session.describe}`);
    const subgoals = await spec.run({ session, plan, budget });

    const { events, history } = await collect();
    observedModels.note(events);
    const totals = ledgerTotalsFromEvents(events);
    const retained = retainEpisodeTranscript(TRANSCRIPTS, episode, { events, history, subgoals });

    const outcome = subgoalsOutcome(subgoals, { turns: totals.turns, toolCalls: totals.toolCalls });
    // The census every other family records, off the same ledger: a subgoal met over a broken call stays visible.
    const tools = { ...scoreToolOutcomes(events), name: toolOutcomes.name, asserts: toolOutcomes.asserts };
    const scores: EvalScoreRow[] = [outcomeRow(outcome), tools];
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
      expectReached(spec.id, spec.defect, subgoal);
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

    failure = thrown;
  }

  // A teardown that fails is reported beside the case's own failure, never in
  // its place: on 2026-09-23 a DELETE the host never delivered replaced the
  // turn's own verdict, and the run printed only the teardown.
  try {
    await opened?.teardown();
  } catch (teardown) {
    if (failure === null) throw teardown;
    throw new AggregateError([failure, teardown], failure.message, { cause: teardown });
  }

  if (failure !== null) throw failure;
}

/**
 * A subgoal's verdict as a THROW rather than a matcher.
 *
 * This module is imported by the case files and by nothing that runs under
 * a test runner's globals, so it raises rather than reaching for `expect`: the
 * failure text is the whole point, and a plain `Error` carries it identically in
 * every runner.
 */
export function expectReached(caseId: string, defect: FirstRunDefect, subgoal: EvalSubgoal): void {
  if (subgoal.reached) return;
  throw new Error(`${caseId}/${subgoal.what}: ${subgoal.detail} — the defect this case guards: ${defect.found}`);
}

/** Publish with the actual selected model; an operator-only case names none. */
export async function publishFirstRunRecord(
  suite: string, modelId: string | undefined, declared: readonly string[], observations: EvalObservation[],
): Promise<void> {
  const spend = reportLiveModelSpend(suite);
  await publishRunRecord({
    family: FIRST_RUN_FAMILY, tier: FIRST_RUN_TIER, modelId: modelId ?? 'no-model',
    modelObserved: observedModels.observed,
    repeats: 1, seed: 1, arm: FIRST_RUN_ARM, declaredTasks: [...declared], observations, spend,
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });
}
