/**
 * The behavioural eval tier: does the agent ACT the way the harness intends?
 *
 * This is the reward signal CL-Bench found missing. Its first live run recorded
 * 14 evolution events across 14 turns, every one "ungraded (no follow-up) | 0
 * tool calls | 1 steps", finishing at scaffoldVersion 0 / searchNodeCount 0 /
 * craftedToolCount 0 — evolution fired with nothing to learn from, and the
 * resulting mean_gain of -0.2 read as a measurement. Eight scorers over the
 * `run_events` ledger are what turn a trajectory into a graded one.
 *
 * FOUR PROPERTIES, each an assertion here rather than a convention:
 *
 *   1. THE MEASURED SET EQUALS THE GOVERNED SET. `assessAdmissibility` fails the
 *      run when the executed task ids differ from the declared ones, so a corpus
 *      that silently shrank cannot report a rate over the wrong denominator.
 *   2. THE CHECK CAN FAIL LOUDLY. Every scorer has a proven red case in
 *      `packages/test-utils/tests/agent-evals.test.ts`, and three needed their
 *      obvious form rejected to get one — recovery over recoveries is n/n = 1.00
 *      forever, completion honesty inverts polarity, and spill retrieval had to
 *      exclude spills with no readable address.
 *   3. A CHECK THAT FAILS PUBLISHES NO NUMBER. The harness throws on a degenerate
 *      trajectory.
 *   4. THE ASSERTION SITS UPSTREAM OF EVERY WRITE PATH. That throw is inside the
 *      harness, before `run(...)` returns, which is the only placement that
 *      works. `vitest-evals` writes `task.meta.eval` from `applyAutomaticJudges`
 *      (dist/index.mjs:1393) and from `appendJudgeScore`, the explicit
 *      `toSatisfyJudge` path (:1447); both are reachable only from a result
 *      `run(...)` handed back, and at :1393 the write executes UNCONDITIONALLY
 *      with `if (thresholdFailed) assert(...)` firing afterwards. The number is
 *      published first and the failure raised second — statement order, not a
 *      reporter quirk. A body-level `expect()` therefore fixes the verdict and
 *      leaves the contaminated score in the artifact.
 *
 * The body-level precondition is written anyway, immediately after `run`, and is
 * not redundant: it carries the task-specific expectation a generic harness
 * cannot know — this task needed a file edit, that one needed a failure to
 * recover from — and names it in the failure message. C for the artifact, B for
 * legibility.
 *
 * NO AUTOMATIC `judges` ARRAY, though not for the reason first circulated: an
 * empty array is identical to omitting the key (`:1353`, then the `:1291` guard),
 * so it publishes nothing either way. The real hazard is any judge that returns a
 * score on a degenerate run, and `ToolCallJudge()` with no `expectedTools`
 * returns 1 unconditionally — an agent that did nothing scoring perfectly. The
 * judges here are built from the ledger scorers, which cannot score a trajectory
 * that never reached them.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, createJudge, describeEval } from 'vitest-evals';
import type { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';

import type { EvalCase, LLMProviderConfig } from '../../packages/core/src/index.js';
import { minimumPairsForSignificance, parseCorpus } from '../../packages/core/src/index.js';
import {
  assessAdmissibility, EVAL_MODELS, formatRunRecord, FULL_TOOL_SURFACE, gitProvenance,
  liveChatModel, liveModelTarget, preRegister, reportLiveModelSpend, TASK_OUTCOME, UNCONFIGURED_LLM,
  writeRunRecord,
  type EvalArmState, type EvalObservation, type EvalRunRecord, type EvalTier,
} from '@proteus/test-utils';
import { DegenerateRunError, runBehaviourTask, type BehaviourOutput } from './harness.js';

/** One observation's input: the task and which repetition of it. That pair IS
 *  the pairing identity two runs are compared on. */
interface EvalInput { task: EvalCase; repetition: number }

const REPO_ROOT = join(import.meta.dirname, '../..');
const TARGET = liveModelTarget('Behaviour Evals');
const LLM: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

/**
 * Which arm this process is. Flash is the volume arm that produces the stats,
 * pro the small arm that establishes the bound — the owner's split, declared as
 * a property of the run rather than left in a comment, because a 18-observation
 * flash number and a 9-observation pro number invite different readings.
 */
const TIER: EvalTier = process.env.PROTEUS_EVAL_TIER === 'pro' ? 'pro' : 'flash';
const REPEATS = Number(process.env.PROTEUS_EVAL_REPEATS ?? (TIER === 'pro' ? '1' : '2'));
const SEED = Number(process.env.PROTEUS_EVAL_SEED ?? '1');

/**
 * The arm state, recorded because a measurement whose mechanism was switched off
 * is not a measurement of that mechanism. Evolution defaults ON: the sibling bun
 * suites pass `noAutoEvolve: true`, which is right for measuring steering in
 * isolation and wrong for a record that a later run will be compared against.
 */
const ARM: EvalArmState = {
  evolution: process.env.PROTEUS_EVAL_EVOLUTION !== '0',
  settle: 'none',
  tools: FULL_TOOL_SURFACE,
};

/**
 * The corpus: `behaviour.jsonl` first, because those are the cases that hand
 * over an environment.
 *
 * seed.jsonl is kept whole rather than replaced, but its no-tool cases are
 * filtered out BY TAG rather than deleted. "What is 17 * 23?" cannot exercise a
 * single mechanism here, and including it would guarantee a degenerate
 * observation the harness would correctly refuse — 500 steps available and one
 * used is a property of the task format, not of the agent. seed.jsonl remains
 * the corpus for the judged A/B in `scripts/eval.ts`, which is what it is for.
 */
function loadCorpus(): EvalCase[] {
  const read = (name: string) =>
    parseCorpus(readFileSync(join(REPO_ROOT, 'tests/eval/corpus', name), 'utf8'));
  const behaviour = read('behaviour.jsonl');
  const toolUsing = read('seed.jsonl').filter((c) =>
    c.tags?.some((t) => t === 'tool-use' || t === 'multi-step') === true);
  return [...behaviour, ...toolUsing];
}

const CORPUS = loadCorpus();
/** One entry per (task, repetition) — pi's pairing identity, and what makes two
 *  runs comparable at all. */
const CASES = CORPUS.flatMap((task) =>
  Array.from({ length: REPEATS }, (_, repetition) => ({ task, repetition })));

const DIR = mkdtempSync(join(tmpdir(), 'proteus-behaviour-eval-'));
const opened: Database[] = [];
const observations: EvalObservation[] = [];
let model: LanguageModel;

/**
 * A ledger scorer as a `vitest-evals` judge.
 *
 * The score IS the mechanism's rate, and a scorer with no eligible opportunity
 * records `null` rather than 0 — "not scored" instead of "scored zero", which is
 * the distinction the whole panel rests on. A judge that reported 0 for an
 * unexercised mechanism would be this library's own `ToolCallJudge` defect
 * inverted: instead of certifying inertness as success it would certify an
 * untouched mechanism as failure.
 */
function ledgerJudge(name: string) {
  return createJudge<EvalInput, BehaviourOutput>(
    name,
    ({ output }) => {
      const row = output.scores.find((s) => s.name === name);
      if (!row) return { score: null, metadata: { rationale: `${name} did not report` } };
      return {
        score: row.rate,
        metadata: {
          rationale: row.eligible === 0
            ? `${name}: no eligible opportunity — absent, not zero`
            : `${name}: ${row.detail}`,
          eligible: row.eligible,
          passed: row.passed,
        },
      };
    },
  );
}

/**
 * Did the task exercise the mechanism its tag implies?
 *
 * A measurement, not a gate, and the distinction was learned from the first live
 * flash run: `ws-inventory` is tagged `edit`, and the agent solved it correctly
 * with four `run` calls and shell redirection, never touching the `file`
 * primitive. Asserting the tag would have painted a correct solution red; not
 * recording it at all would hide something important, because a turn that edits
 * through the shell produces NO gradable edit signal — `sed -i` exits 0 whether
 * or not it matched. So the tag-vs-ledger agreement is itself a rate, and a
 * corpus whose tags stop matching what the agent does shows up here as a decline
 * rather than as a silently shrinking denominator.
 */
const TAG_MECHANISM = new Map<string, string>([
  ['edit', 'edit_landing'],
  ['failure', 'recovery_durability'],
  ['multipart', 'delegation_conversion'],
]);

const tagExpectation = createJudge<EvalInput, BehaviourOutput>(
  'tag_expectation',
  ({ input, output }) => {
    const expected = (input.task.tags ?? [])
      .map((tag) => TAG_MECHANISM.get(tag)).filter((n): n is string => n !== undefined);
    if (expected.length === 0) {
      return { score: null, metadata: { rationale: 'no tag implies a mechanism' } };
    }
    const met = expected.filter((name) =>
      (output.scores.find((s) => s.name === name)?.eligible ?? 0) > 0);
    return {
      score: met.length / expected.length,
      metadata: {
        rationale: `${String(met.length)}/${String(expected.length)} tag-implied mechanisms `
          + `reached (${expected.join(', ')}); tools called: ${output.toolNames.join(', ')}`,
        expected: expected.length, met: met.length,
      },
    };
  },
);

const JUDGES = [
  'delegation_conversion', 'steering_conversion', 'craft_reuse', 'edit_landing',
  'recovery_durability', 'completion_honesty', 'spill_retrieval', 'tool_outcomes',
].map(ledgerJudge).concat([tagExpectation]);

beforeAll(() => {
  model = liveChatModel(LLM);
  const pre = preRegister(CORPUS.length, REPEATS);
  console.log('\n── behaviour eval tier ────────────────────────────────');
  console.log(`arm:     ${TIER} (${EVAL_MODELS[TIER]})`);
  console.log(`         evolution ${ARM.evolution ? 'ON' : 'OFF'}, `
    + `${String(ARM.tools.length)} tools, seed ${String(SEED)}`);
  console.log(`corpus:  ${String(CORPUS.length)} tasks x ${String(REPEATS)} repeats `
    + `= ${String(CASES.length)} observations`);
  console.log(`design:  ${pre.note}`);
  console.log(`         the floor needs ${String(pre.minimumPairs)} DIFFERING pairs; `
    + `resolving 20pp at 80% power needs ${String(pre.pairsFor20pp)} tasks`);
  console.log('──────────────────────────────────────────────────────\n');
});

afterAll(() => {
  const spend = reportLiveModelSpend('Behaviour Evals');
  const declared = CORPUS.map((c) => c.id);
  const record: EvalRunRecord = {
    schema: 1,
    runId: `behaviour-${TIER}-${String(Date.now())}`,
    createdAt: new Date().toISOString(),
    ...gitProvenance(REPO_ROOT),
    tier: TIER,
    modelId: EVAL_MODELS[TIER],
    repeats: REPEATS,
    seed: SEED,
    arm: ARM,
    declaredTasks: declared,
    executedTasks: [...new Set(observations.map((o) => o.taskId))],
    observations,
    admissibility: assessAdmissibility(declared, observations),
    // FIELD RENAME ONLY: LiveModelSpend now carries `usage: Usage` instead of
    // flat inputTokens/outputTokens. The `?? 0` and the tokensIn/tokensOut
    // spelling are EvalsInfra's agreed follow-up (spend becomes
    // { calls, callsWithoutUsage, input, output }); this keeps the build green.
    spend: {
      calls: spend.calls,
      tokensIn: spend.usage.input ?? 0,
      tokensOut: spend.usage.output ?? 0,
    },
  };
  const out = process.env.PROTEUS_EVAL_RECORD
    ?? join(REPO_ROOT, 'tests/eval/runs', `${record.runId}.json`);
  writeRunRecord(out, record);
  console.log(`\n${formatRunRecord(record)}\n\nrecord: ${out}\n`);

  for (const db of opened) db.close();
  rmSync(DIR, { recursive: true, force: true });
});

describeEval('Agent behaviour over the run-event ledger', {
  // `createHarness` rather than a bare object: a `Harness` must return a fully
  // normalized `HarnessRun` (session, usage, errors), and this normalizes the
  // lightweight result instead of us hand-building a transcript.
  harness: createHarness<EvalInput, BehaviourOutput>({
    name: 'proteus-local-session',
    async run({ input }) {
      const startedAt = Date.now();
      try {
        const output = await runBehaviourTask(input.task, {
          dir: join(DIR, `rep${String(input.repetition)}`), model, llm: LLM, arm: ARM, opened,
        });
        observations.push({
          taskId: input.task.id, repetition: input.repetition, outcome: 'scored',
          scores: output.scores, turns: output.turns, toolCalls: output.toolCalls,
          // Computed by the harness since the first run and dropped here until
          // now, which is why "did it ever enter codemode" had to be re-derived
          // from source rather than read off the artifact.
          toolNames: output.toolNames,
          tokensIn: output.tokensIn, tokensOut: output.tokensOut, ms: Date.now() - startedAt,
        });
        return {
          output,
          usage: { inputTokens: output.tokensIn, outputTokens: output.tokensOut },
          messages: [{ role: 'user', content: input.task.task }],
        };
      } catch (error) {
        // `inert` and `errored` are different facts and the record must not
        // conflate them: one is an agent that did nothing, the other a harness
        // that broke. Either way the throw propagates, so no score is published.
        observations.push({
          taskId: input.task.id, repetition: input.repetition,
          outcome: error instanceof DegenerateRunError ? 'inert' : 'errored',
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  }),
  // No automatic judges — see the header. Judges are invoked explicitly below,
  // after the precondition, so nothing scores a trajectory that never arrived.
  skipIf: () => TARGET === null,
}, (it) => {
  it.for(CASES)('$task.id rep$repetition', async (input, { run }) => {
    const result = await run(input);
    const out = result.output;

    // DESIGN B — the precondition, and ONLY the precondition: was this a graded
    // turn at all? The harness has already refused a wholly degenerate run; this
    // restates it in the suite where a reader will look for it, and names the
    // task.
    expect(out.toolCalls, `${input.task.id}: turn was ungraded — 0 tool calls`).toBeGreaterThan(0);

    // WHAT IS DELIBERATELY *NOT* ASSERTED HERE, having been tried and removed.
    // An earlier version asserted that an `edit`-tagged task must have attempted
    // a file edit. The first live flash run made it red: given `ws-inventory` the
    // agent solved the task correctly using four `run` calls and shell
    // redirection, never touching the `file` primitive, so `edit_landing` had a
    // zero denominator. That is a genuine BEHAVIOURAL FINDING — the model prefers
    // shell over the edit primitive, which also means those turns produce no
    // gradable edit signal at all — and turning a finding into a gate is exactly
    // the flaky red this file's next paragraph warns about. It is measured by
    // `tag_expectation` below and reported as a rate instead.

    // Scores RECORDED, never gated on a floor. A recorded baseline converted 0%
    // of eligible delegation turns where a mechanical nudge reached 24%; at this
    // sample size a floor would be a coin flip dressed as a gate, and a flaky
    // gate teaches everyone to ignore red. `threshold: null` records without
    // failing, which is what makes these measurements rather than assertions —
    // and the run record, not this suite, is what a later run is compared to.
    for (const judge of JUDGES) {
      await expect(result).toSatisfyJudge(judge, { threshold: null });
    }
  });
});

/**
 * CORPUS QUALITY — properties of the CORPUS, asserted so a future edit that
 * saturates it fails loudly instead of quietly ranking nothing.
 *
 * Neither of these is a statement about the agent. A corpus can be perfectly
 * good and the agent bad, and that is the finding we want; what neither of these
 * tolerates is a corpus on which no finding is POSSIBLE.
 *
 * These deliberately do NOT assert mechanism coverage. An earlier version of this
 * ticket asserted that every scorer must have a non-zero eligibility count, and
 * that was wrong: it makes mechanism coverage a target, and adding tasks to move
 * a mechanism meter is how a delegation rate that converted 4/4 wherever the work
 * was divisible came to be reported as an 85% failure. Mechanism telemetry is
 * recorded in full and explains a moved outcome after the fact. It is not a bar.
 */
describe('corpus quality — can this corpus rank anything at all', () => {
  /**
   * Static, so it runs without a credential and without spending anything: below
   * `minimumPairsForSignificance()` DIFFERING pairs no exact paired test can
   * reach p ≤ alpha at any effect size, and a corpus smaller than that floor
   * cannot supply them however the arms behave. CL-Bench reported a gain over 5
   * tasks of which 2 differed; the best two-sided p 2 differing pairs can produce
   * is 0.5.
   */
  test('the corpus is large enough for significance to be reachable', () => {
    const floor = minimumPairsForSignificance();
    expect(
      CORPUS.length,
      `${String(CORPUS.length)} tasks cannot supply the ${String(floor)} DIFFERING pairs the `
      + 'exact paired test needs; no outcome on this corpus could be significant at any effect size',
    ).toBeGreaterThanOrEqual(floor);
  });

  /**
   * HEADROOM: two arms can only disagree where the outcome has somewhere to move.
   *
   * A corpus the baseline sweeps ranks nothing — that is exactly the state that
   * produced `pass@1 1.000 -> 1.000` with 0 of 6 tasks differing and a measured
   * dispersion of 0.0000. A corpus nothing can solve ranks nothing either. So the
   * observed outcomes must contain both a success and a shortfall.
   *
   * Skipped, not passed, without a live model: an empty observation list must
   * never read as a satisfied property.
   */
  test.skipIf(TARGET === null)('the corpus is not saturated — arms could disagree on it', () => {
    const rates = observations
      .filter((o): o is Extract<EvalObservation, { outcome: 'scored' }> => o.outcome === 'scored')
      .flatMap((o) => o.scores.filter((s) => s.name === TASK_OUTCOME))
      .filter((s) => s.eligible > 0)
      .map((s) => s.passed / s.eligible);

    expect(rates.length, 'no attempt recorded a task_outcome — the corpus declares no ground '
      + 'truth, so it measures activity rather than whether anything was solved').toBeGreaterThan(0);

    const solvedSomething = rates.some((r) => r > 0);
    const fellShortSomewhere = rates.some((r) => r < 1);
    expect(solvedSomething, 'every attempt scored 0.000 — nothing in this corpus is solvable, so '
      + 'no improvement could ever show up in it').toBe(true);
    expect(fellShortSomewhere, 'every attempt scored 1.000 — this corpus is SATURATED and has no '
      + 'headroom, so two arms cannot disagree on it and it ranks nothing. Add tasks you expect '
      + 'to fail.').toBe(true);
  });
});
