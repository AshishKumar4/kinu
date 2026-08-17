/**
 * Behavioural eval: does the agent delegate at all, over a stated denominator?
 *
 * This one has to run through the FULL turn pipeline, and that constraint is the
 * whole design. `turn_steering` rows — the only record of an eligible turn and
 * whether it converted — are written by the settle spine when a turn closes.
 * A bare `generateText` call never closes a turn, so the sibling exploration
 * eval, which drives the `agents` tool directly, structurally cannot measure
 * this. It would report `0 eligible` and look like a pass.
 *
 * So this drives `LocalAgentSession` in-process. That is the same spine the CLI
 * uses (`proteus exec` → `runOneShot` → `LocalAgentSession.processTurn` →
 * `closeTurnRun`), with no subprocess, no `PROTEUS_HOME`, no daemon guard and no
 * stdout parsing. The rows land in the workspace's own SQLite, which is exactly
 * what the scorer reads.
 *
 * WHY THE DENOMINATOR IS BUILT FROM SEPARATE WORKSPACES. The turn-start
 * eligibility predicate requires a FRESH ask: no assistant message anywhere in
 * the context. So a session's second turn is never eligible for that arm, and
 * N turns in one session would give a denominator of 1 while looking like N. One
 * fresh workspace per eligible turn is the only honest way to get a rate.
 *
 * WHY THE PROMPTS ARE IMPERATIVES. The same predicate refuses any ask ending in
 * `?` or `!`. A question yields ZERO eligible turns — a silent zero denominator,
 * which is the defect class this whole harness exists to remove. Each prompt is
 * also deliberately multi-part, because splitting is the behaviour the steer
 * asks for.
 *
 * WHAT IS ASSERTED, AND WHAT IS ONLY REPORTED. The denominator is asserted: the
 * number of eligible turns must equal the number of fresh asks made, so steering
 * silently ceasing to fire fails here rather than reading as "the model chose
 * not to delegate". The RATE is reported, not asserted against a floor. A
 * recorded baseline converted 0% of eligible turns where a mechanical nudge
 * reached 24%; at this sample size a floor would be a coin flip dressed as a
 * gate, and a flaky gate teaches everyone to ignore red.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';

import type { LLMProviderConfig } from '../../packages/core/src/index.js';
import { createWorkspace } from '../../packages/core/src/identity/index.js';
import { LocalAgentSession } from '../../packages/cli-backend/src/local-session.js';
import { makeSql } from '../../packages/cli-backend/src/runtime.js';
import {
  liveChatModel, liveModelTarget, reportLiveModelSpend, scoreDelegation, UNCONFIGURED_LLM,
} from '@proteus/test-utils';

const TARGET = liveModelTarget('Delegation Evals');
const liveTest = test.skipIf(!TARGET);
const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'proteus-eval-delegation-' + String(Date.now()));

/**
 * One eligible turn each: an imperative (never a question), multi-part, with
 * parts that are genuinely independent so splitting them is the right call
 * rather than a trick.
 */
const ELIGIBLE_ASKS: readonly string[] = [
  'Add rate limiting, structured logging, and a health endpoint to the service in this workspace. '
  + 'Treat them as three independent pieces of work.',
  'Write up three separate things about this workspace: how it stores state, how it handles errors, '
  + 'and how it would scale. Cover all three.',
  'Compare a queue-based design, a cron-based design, and an event-driven design for a scheduled '
  + 'job runner, then recommend one. Each design needs its own analysis.',
];

interface TurnOutcome {
  readonly ask: string;
  readonly db: InstanceType<typeof Database>;
}

describe('Delegation evals — conversion over eligible turns', () => {
  let model: LanguageModel;
  let outcomes: TurnOutcome[] = [];

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    model = liveChatModel(LLM_CONFIG);
  });

  afterAll(() => {
    reportLiveModelSpend('Delegation Evals');
    for (const outcome of outcomes) outcome.db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  liveTest('the delegation rate is measured over a non-zero count of eligible turns', async () => {
    for (const [index, ask] of ELIGIBLE_ASKS.entries()) {
      const dbPath = join(TEST_DIR, `ask-${String(index)}.db`);
      const db = new Database(dbPath);
      db.exec('PRAGMA journal_mode = WAL');
      const rt = await createWorkspace(db, {
        name: `delegation-eval-${String(index)}`,
        purpose: 'A senior engineer who breaks independent work apart before starting it.',
        llm: LLM_CONFIG,
      });
      const session = new LocalAgentSession({
        rt, db, model, onEvent: () => {}, noAutoEvolve: true,
      });
      await session.send(ask);
      outcomes.push({ ask, db });
    }

    // Scored per workspace and summed, because each workspace holds exactly one
    // eligible turn. Summing the scorer's own counts keeps one definition of
    // eligibility rather than a second query here.
    const scores = outcomes.map((outcome) => scoreDelegation(makeSql(outcome.db)));

    const eligible = scores.reduce((n, s) => n + s.eligible, 0);
    const converted = scores.reduce((n, s) => n + s.converted, 0);
    const forkedRuns = scores.reduce((n, s) => n + s.forkedRuns, 0);
    const headsOpened = scores.reduce((n, s) => n + s.headsOpened, 0);
    const completedTurns = scores.reduce((n, s) => n + s.completedTurns, 0);

    for (const [index, score] of scores.entries()) {
      const start = score.arms.find((arm) => arm.trigger === 'turn_start_no_delegation');
      console.log(`    ask ${String(index)}: eligible ${String(start?.eligible ?? 0)}, `
        + `converted ${String(start?.converted ?? 0)}, forked ${String(score.forkedRuns)}, `
        + `heads ${String(score.headsOpened)}`);
    }
    console.log(`    DELEGATION RATE: ${String(converted)}/${String(eligible)} eligible turns `
      + `converted (${eligible === 0 ? 'n/a' : String(Math.round((converted / eligible) * 100))}%)`);
    console.log(`    forks that actually opened heads: ${String(forkedRuns)} run(s), `
      + `${String(headsOpened)} head(s)`);

    // Every turn closed. Rows are written on settle, so a turn killed by a
    // timeout contributes to neither numerator nor denominator — and a run where
    // nothing settled must not read as a measured 0%.
    expect(completedTurns).toBeGreaterThanOrEqual(ELIGIBLE_ASKS.length);

    // THE DENOMINATOR, asserted exactly rather than merely as non-zero: every
    // fresh imperative ask must have produced one eligible turn. If the
    // eligibility predicate stops firing — a prompt that drifts into a question,
    // a steering extension that stops being registered, a higher-priority steer
    // taking the slot — this fails, instead of the rate quietly becoming a
    // measurement over nothing.
    expect(eligible).toBe(ELIGIBLE_ASKS.length);

    // The rate itself is the finding, not the gate. Bounds only.
    expect(converted).toBeGreaterThanOrEqual(0);
    expect(converted).toBeLessThanOrEqual(eligible);

    // A conversion is any `agents` call, including one that just lists the
    // roster. Heads-opened cannot exceed a fork's worth of heads per conversion,
    // so this catches a `head_split` row appearing without a conversion — which
    // would mean the steer's own bookkeeping disagrees with what the fork
    // substrate recorded.
    if (forkedRuns > 0) expect(converted).toBeGreaterThan(0);
  }, 1_800_000);
});
