/**
 * The optimization eval: hand the agent a solvable, measured golfing challenge
 * and hold it to a THRESHOLD — then record HOW it got there, swarm or not.
 *
 * THE INSTRUMENT IS THE SHIPPED CORPUS TASK `hard-majority-vote`, deliberately
 * the same instance the live swarm arm forces a search over: same seed files,
 * same metered oracle, same `exec-ratio` verifier, same log-scale score. What
 * differs is WHO DECIDES. The swarm arm dictates `agents({action:'swarm'})`;
 * this family hands the session its full surface — swarm included — and the
 * agent chooses its own approach. Two arms on one instrument is what makes
 * "did the swarm help" a comparison rather than an anecdote, and the choice is
 * LOGGED per observation (`swarm_use`, with the tree shape when there is one)
 * so `scripts/eval-report.ts` can correlate swarm use with attainment as the
 * records accumulate. The correlation is never asserted here: a threshold on
 * HOW would teach the agent to cargo-cult a tool; the threshold is on the
 * RESULT.
 *
 * THE THRESHOLD, pre-registered: task_outcome ≥ 0.5, the log-scale midpoint
 * between the measured reference and the corpus target. On this instance
 * (n=1200, reference 2·n² = 2,880,000 oracle calls measured live by the swarm
 * arm, target 2,992) a score of 0.5 is ~93,000 calls — any genuinely
 * sub-quadratic method clears it (an n·log n approach scores ≈0.69, the
 * textbook Boyer–Moore pairing ≈0.93), matching the handed reference scores 0,
 * and a wrong answer scores 0 whatever it cost. Solvable, not vacuous.
 *
 * WHY THE SPAWNED CLI. The agent under eval is the `proteus` process a user
 * runs — `proteus create --mode local`, then `proteus exec --workspace <name>
 * --json`, per bench/harbor/proteus_agent.py. The instrument sits either side
 * of that process: the task's seed files are written into the workspace BEFORE
 * the child starts, and the verifier measures the workspace the child left
 * behind AFTER it exits. Both halves go through the OPENED runtime
 * (`openWorkspaceCLI`) rather than the birth one, for the reason harness.ts
 * states at length — the birth runtime registers no executors, so its shell
 * cannot run the `exec-ratio` measurement and every attempt would read as
 * unmeasurable. The store is closed between seeding and the child, and
 * reopened after: two processes never hold it at once.
 *
 * WHAT IS JUDGED: the workspace, not the transcript. The corpus's own verifier
 * runs the metered oracle over the files the agent left, so the score is a
 * measurement rather than an opinion about an answer. The CLI's event stream
 * and the workspace ledgers supply the covariates — turns, tool calls, steps,
 * tokens, swarm shape.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';

import type { EvalCase, LLMProviderConfig } from '../../packages/core/src/index';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { makeSql } from '../../packages/cli-backend/src/runtime';
import { cliWorkspaceDbPath, createCliWorkspace, execCliTask } from './cli-driver';
import {
  readLedgerTotals, requireExecutorSurface, requireSandboxedExecutors, requireVerifierShell,
} from './harness';
import {
  assembleRunRecord, EVAL_MODELS, formatRunRecord, FULL_TOOL_SURFACE, hardTaskCases,
  hardTaskFor, liveModelTarget, recordLiveModelEpisode, reportLiveModelSpend, seedHardTask,
  TASK_OUTCOME, UNCONFIGURED_LLM, verifyHardTask, writeRunRecord,
  type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalTier, type HardTask,
} from '@proteus/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';

const SUITE = 'Optimization Evals';
const TARGET = liveModelTarget(SUITE);
const liveTest = test.skipIf(!TARGET);

const REPO_ROOT = join(import.meta.dirname, '../..');

/** See the header: the swarm arm's instance, so forced-search and free-choice
 *  numbers land on one instrument. The smallest wide-headroom entry, for the
 *  measured cost reason `swarm.eval.ts` states. */
const TASK_ID = 'hard-majority-vote';

/** The pre-registered bar. A run that changes it is a different family and owes
 *  a new baseline — the number is part of what `threshold_attained` records. */
const THRESHOLD = 0.5;

/** The workspace the child CLI is told to create, and the wall it gets. Longer
 *  than the research family's: this episode is a search over a metered
 *  instrument, and the swarm path is the expensive branch it is allowed to
 *  take. A hung child becomes a named red, never a runner timeout. */
const WORKSPACE = 'optimization-eval';
const EPISODE_TIMEOUT_MS = 1_800_000;

function corpusCase(id: string): EvalCase {
  const found = hardTaskCases().find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`the hard-task corpus has no "${id}", so this eval has no instrument: `
      + `it holds ${hardTaskCases().map((candidate) => candidate.id).join(', ')}`);
  }
  return found;
}

const CASE = corpusCase(TASK_ID);

const TIER: EvalTier = process.env.PROTEUS_EVAL_TIER === 'pro' ? 'pro' : 'flash';
const LLM: LLMProviderConfig = TARGET === null
  ? UNCONFIGURED_LLM
  : { ...TARGET.llm, model: EVAL_MODELS[TIER] };

/** Evolution off — the family measures whether the agent attains the bar, and
 *  the behaviour arm owns the evolution comparison. `settle` is the model's own
 *  choice per swarm call here, which is exactly what this family exists to
 *  observe rather than dictate. */
const ARM: EvalArmState = {
  evolution: false,
  settle: 'model-chosen',
  tools: FULL_TOOL_SURFACE,
};

const TRANSCRIPTS = join(
  resolveArtifactRoot({
    flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
    repoRoot: REPO_ROOT, runRoot: tmpdir(),
  }),
  `optimization-${TIER}-${String(Date.now())}`,
);

const opened: Database[] = [];
const observations: EvalObservation[] = [];

/** What the episode's store says about search use: nothing asserted, everything
 *  measured. `exploration_records` is created by the first swarm run rather
 *  than by the workspace schema, so its absence IS the no-swarm case and is
 *  read as zero rows rather than as an error. */
function swarmTelemetry(db: Database, agentsCalls: number): EvalScoreRow {
  const sql = makeSql(db);
  const tree = sql<{ nodes: number; maxDepth: number | null }>`
    SELECT COUNT(*) AS nodes, MAX(depth) AS maxDepth FROM search_nodes`[0]
    ?? { nodes: 0, maxDepth: null };
  const byDepth = sql<{ depth: number; n: number }>`
    SELECT depth, COUNT(*) AS n FROM search_nodes GROUP BY depth ORDER BY depth`;
  const hasRecords = sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'exploration_records'`
    .length > 0;
  const records = hasRecords
    ? sql<{ n: number }>`SELECT COUNT(*) AS n FROM exploration_records`[0]?.n ?? 0
    : 0;
  const best = sql<{ value: number | null }>`
    SELECT MAX(value) AS value FROM search_nodes WHERE status != 'failed'`[0]?.value;
  const used = tree.nodes > 0;
  const counts = {
    searchNodes: tree.nodes,
    maxDepth: tree.maxDepth ?? 0,
    recordsWritten: records,
    agentsCalls,
  };
  const measured = best !== null && best !== undefined ? { ...counts, bestNodeValue: best } : counts;
  return {
    name: 'swarm_use',
    asserts: 'the episode ran a swarm — recorded so attainment can be correlated with search '
      + 'use across accumulated runs, never gated: the threshold is on the result',
    eligible: 1,
    passed: used ? 1 : 0,
    rate: used ? 1 : 0,
    detail: used
      ? `${String(tree.nodes)} swarm node(s), depth ${String(tree.maxDepth ?? 0)}, shape `
        + `${byDepth.map((row) => `${String(row.depth)}:${String(row.n)}`).join(' ')}, `
        + `${String(records)} record(s) written, best node value ${String(best ?? 'none')}, `
        + `${String(agentsCalls)} agents call(s)`
      : `no swarm: 0 search nodes, ${String(agentsCalls)} agents call(s)`,
    measured,
  };
}

afterAll(() => {
  const spend = reportLiveModelSpend(SUITE);
  const record = assembleRunRecord({
    family: 'optimization', tier: TIER, modelId: LLM.model, repeats: 1, seed: 1,
    arm: ARM, declaredTasks: [TASK_ID], observations, spend,
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });
  const out = process.env.PROTEUS_EVAL_RECORD ?? join(TRANSCRIPTS, 'run-record.json');
  writeRunRecord(out, record);
  console.log(`\n${formatRunRecord(record)}\n\nrecord: ${out}\n`);
  for (const db of opened) db.close();
});

describe('Optimization evals — a measured challenge with a pre-registered threshold', () => {
  /**
   * CREDENTIAL-FREE: the bar itself. A threshold of 0 is the reference handed to
   * the agent and a threshold of 1 demands the corpus target — both make the
   * family unable to distinguish anything. And the instrument must exist with
   * headroom: a target at or above the floor's certificate leaves no honest
   * range to score on.
   */
  test('the threshold is a bar something can clear and something can miss', () => {
    expect(THRESHOLD).toBeGreaterThan(0);
    expect(THRESHOLD).toBeLessThan(1);
    const params = CASE.params ?? {};
    expect(params['n'], `${TASK_ID} lost its instance size — the record could not say what was solved`)
      .toBeGreaterThan(0);
  });

  liveTest('MEASURED: the agent attains the threshold on the metered instrument', async () => {
    mkdirSync(TRANSCRIPTS, { recursive: true });
    const home = join(TRANSCRIPTS, 'home');
    const workspace = {
      home, workspace: WORKSPACE, llm: LLM,
      purpose: 'A senior engineer working in the given workspace. Prefer real tool calls over '
        + 'describing what you would do, and break independent work apart.',
    };
    const hard: HardTask | undefined = hardTaskFor(CASE);
    if (hard === undefined) {
      throw new Error(`${TASK_ID} is not a hard-task corpus entry, so it carries no seed files and `
        + 'no verifier — this family would grade nothing');
    }
    const dbPath = cliWorkspaceDbPath(home, WORKSPACE);

    // Birth through the shipped CLI, then SEED and pre-flight through the
    // opened runtime, then CLOSE: the child must be the only process holding
    // the store while it runs.
    await createCliWorkspace(workspace);
    {
      const seedDb = new Database(dbPath);
      try {
        const { rt } = await openWorkspaceCLI(seedDb, dbPath, { llm: LLM, hostRoot: null });
        // Before anything is spent: a runtime that cannot execute is not a
        // measurement of an agent that can, and one that can execute on the
        // developer's machine is not a measurement either. The verifier's own
        // shell is required here rather than discovered at grading time, so a
        // shell-less workspace costs nothing instead of reading as an agent
        // that solved nothing.
        requireExecutorSurface(TASK_ID, rt);
        requireSandboxedExecutors(TASK_ID, rt);
        requireVerifierShell(TASK_ID, rt);
        await seedHardTask(hard, rt.storage.vfs);
      } finally {
        seedDb.close();
      }
    }

    const startedAt = Date.now();
    let child;
    try {
      child = await execCliTask({
        ...workspace, prompt: CASE.task,
        noAutoEvolve: !ARM.evolution, timeoutMs: EPISODE_TIMEOUT_MS,
      });
    } catch (error) {
      observations.push({
        taskId: TASK_ID, repetition: 0, outcome: 'errored',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const ms = Date.now() - startedAt;

    // The child's own store, reopened after it exited. `recordLiveModelEpisode`
    // is what puts the child's spend on this arm's spend file — the usage lives
    // in the workspace, so the liveness assertion works over a subprocess.
    const db = new Database(dbPath);
    opened.push(db);
    recordLiveModelEpisode(makeSql(db));
    const totals = readLedgerTotals(db);
    const agentsCalls = totals.toolNames.filter((name) => name === 'agents').length;
    const swarmRow = swarmTelemetry(db, agentsCalls);

    // The OUTCOME, measured over the workspace the agent left behind and
    // nothing else — no transcript, no model, no judge. Measured through a
    // freshly opened runtime because the verifier runs commands in its shell.
    const { rt: verifyRt } = await openWorkspaceCLI(db, dbPath, { llm: LLM, hostRoot: null });
    const shell = requireVerifierShell(TASK_ID, verifyRt);
    const outcome = await verifyHardTask(hard, {
      vfs: verifyRt.storage.vfs,
      exec: (command) => shell.exec(command),
    });
    const attained = outcome.rate !== null && outcome.rate >= THRESHOLD;
    const thresholdMeasured: EvalScoreRow['measured'] = outcome.rate !== null
      ? { threshold: THRESHOLD, score: outcome.rate }
      : { threshold: THRESHOLD };
    const thresholdRow: EvalScoreRow = {
      name: 'threshold_attained',
      asserts: `${TASK_OUTCOME} reached the pre-registered bar of ${String(THRESHOLD)} — the pass/fail `
        + 'this family gates on, kept beside the continuous score it was derived from',
      eligible: 1,
      passed: attained ? 1 : 0,
      rate: attained ? 1 : 0,
      detail: `score ${String(outcome.rate)} vs threshold ${String(THRESHOLD)} — ${outcome.detail}`,
      measured: thresholdMeasured,
    };

    // The observation FIRST: a missed threshold is exactly the run the record
    // must keep, or the accumulated data only ever shows successes.
    observations.push({
      taskId: TASK_ID, repetition: 0, outcome: 'scored',
      scores: [outcome, swarmRow, thresholdRow],
      turns: totals.turns, toolCalls: totals.toolCalls, toolNames: totals.toolNames,
      tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, ms,
    });
    console.log(`    ${String(totals.turns)} turn(s), ${String(totals.toolCalls)} tool call(s), `
      + `${String(totals.steps)} step(s), ${(ms / 1000).toFixed(1)}s, `
      + `${String(totals.tokensIn)} in / ${String(totals.tokensOut)} out tokens`);
    console.log(`    ${swarmRow.detail}`);
    console.log(`    ${thresholdRow.detail}`);

    // ── Denominators first ─────────────────────────────────────────────────
    // The CHILD before the agent: a killed or crashed process is a fact about
    // the run, and holding a torn episode to the threshold would report an
    // agent failure for a harness one.
    expect(child.timedOut,
      `the child \`proteus exec\` was killed at ${String(EPISODE_TIMEOUT_MS)}ms — a hung episode, `
      + `not a missed threshold${child.stderr.trim() === '' ? '' : `; stderr: ${child.stderr.trim()}`}`)
      .toBe(false);
    expect(child.exitCode,
      'the child `proteus exec` exited non-zero, so the episode never completed'
      + `${child.stderr.trim() === '' ? '' : `; stderr: ${child.stderr.trim()}`}`)
      .toBe(0);
    // A trajectory that produced nothing is `inert`, never a zero on the bar.
    expect(totals.turns, `${TASK_ID}: the episode closed no turn — nothing ran`).toBeGreaterThan(0);
    expect(totals.toolCalls,
      `${TASK_ID}: the episode made no tool call, so it never touched the workspace it is graded on`
      + (totals.failures.length > 0 ? ` (recorded failures: ${totals.failures.join(' | ')})` : ''))
      .toBeGreaterThan(0);
    expect(outcome.eligible, `${TASK_ID}: ${TASK_OUTCOME} has a zero denominator — "0 of 0" is not a verdict`)
      .toBeGreaterThan(0);

    // ── The bar ────────────────────────────────────────────────────────────
    expect(outcome.rate ?? 0,
      `${TASK_ID}: score ${String(outcome.rate)} did not attain the pre-registered threshold `
      + `${String(THRESHOLD)} — ${outcome.detail}`)
      .toBeGreaterThanOrEqual(THRESHOLD);
  });
});
