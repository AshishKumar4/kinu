/**
 * Behavioural evals for exploration: does the agent use MCTS when it should,
 * use it PROPERLY, and does it WORK.
 *
 * Three questions, deliberately separated, because they fail for different
 * reasons and conflating them is how "MCTS works" got believed while the
 * Exploration pane was empty.
 *
 *   WORKS   — driven by the harness through the MCTS strategy itself, so the
 *             model cannot decline. A pass means the mechanism produces a
 *             branched, ranked, reader-visible search. Deterministic in shape;
 *             the model only supplies the content. Driven at the strategy and
 *             not through `agents.execute`, because the tool no longer routes
 *             anything here — see the WORKS test for why that is the supported
 *             path rather than a bypass.
 *   VISIBLE — the written store and the reader the pane calls agree. The
 *             assertion the twice-shipped empty pane needed.
 *   USED    — the model, handed a task that warrants exploration and the tool to
 *             do it with, reaches for it. Model-dependent by nature: this is the
 *             eval whose number is the finding, and a recorded baseline
 *             converted 0% of eligible turns until a mechanical nudge reached
 *             24%. It is reported as a RATE over a stated denominator rather
 *             than asserted per-attempt, because a single sample is not a rate.
 *
 * Every assertion states its denominator first. `0 of 0 searches were unranked`
 * is the shape of a check that cannot fail, and this suite has already been the
 * only evidence for MCTS at any commit — it does not get to be that shape.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateText, stepCountIs, type LanguageModel, type ToolSet, type StepResult } from 'ai';

import {
  buildActorTools,
  createMCTSStrategy,
  createStrategyRegistry,
  DEFAULT_CONFIG,
  initWorkspaceSchema,
  readSoul,
  type AgentRuntime,
  type LLMProviderConfig,
  type MCTSProgressEvent,
  type SessionMessage,
  type SessionWriter,
  type StrategyRegistry,
} from '../../packages/core/src/index';
import { createWorkspace } from '../../packages/core/src/identity/index';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { makeWorkspaceSchemaSql } from '../../packages/cli-backend/src/runtime';
import { requireSandboxedExecutors } from './harness';
import {
  liveChatModel, liveModelCallSink, liveModelTarget, recordLiveModelEpisode, recordLiveModelSpend,
  reportLiveModelSpend, scoreExploration, scoreSettleVisibility, UNCONFIGURED_LLM,
} from '@kinu/test-utils';

const TARGET = liveModelTarget('Exploration Evals');
const liveTest = test.skipIf(!TARGET);
const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'proteus-eval-exploration-' + String(Date.now()));
const DB_PATH = join(TEST_DIR, 'agent.db');

/**
 * A task with several genuinely different defensible approaches and no obvious
 * winner — the shape the doctrine tells the model to fork on. Deliberately not
 * a puzzle with one right answer: a task the model can just solve is not a task
 * that warrants exploration, and asserting it forks on one would be asserting
 * the wrong behaviour.
 */
const EXPLORATION_TASK =
  'We need to cut the p99 latency of a read-heavy JSON API that currently reads '
  + 'straight from SQLite on every request. There are several defensible designs '
  + '(in-process cache, a read replica, materialised views, a CDN edge cache) and '
  + 'the right one is not obvious — they trade freshness, memory and operational '
  + 'cost differently. Compare the competing approaches and recommend one.';

/**
 * The driven search's shape, stated here rather than inherited from
 * `DEFAULT_CONFIG.mcts`, and taken from the one shape in this repository that has
 * a MEASUREMENT behind it.
 *
 * Production's 5 iterations x 3 branches, each branch judged over 3 samples, ran
 * past 900s against @cf/deepseek-ai/deepseek-v4-pro-0813 and was killed with
 * rollouts still open. So did 2 x 3. `E2E Lifecycle > MCTS evolution` drives one
 * iteration and measured 290s, so one iteration is what this uses: a search sized
 * by a number somebody recorded rather than by how cautious a guess felt. At that
 * budget the whole suite measured 375s.
 *
 * The WIDTH stays at production's 3 and is not reduced with the depth. Width is
 * the competition being scored — `branches > 1` is an assertion about it — and it
 * is also what gives the judge distinct proposals to separate. Depth is what the
 * larger shapes bought and what this suite never scores.
 */
const EVAL_SEARCH_BUDGET = 1;
const EVAL_SEARCH_BRANCHES = 3;

/** Minimal in-memory session sink. MCTS needs somewhere to put a trajectory;
 *  what it holds is not what this suite measures. */
function makeSessionWriter(): SessionWriter {
  const msgs: { id: string; parentId?: string | null; role: string; content: string }[] = [];
  return {
    async appendMessage(msg: SessionMessage, parentId?: string | null) {
      msgs.push({ id: msg.id, parentId, role: msg.role, content: msg.parts.map((p) => p.text).join('') });
    },
    getHistory(leafId?: string | null) {
      if (!leafId) return msgs.map((m) => ({ role: m.role, content: m.content }));
      const trail: { role: string; content: string }[] = [];
      let cur = msgs.find((m) => m.id === leafId);
      while (cur) {
        trail.unshift({ role: cur.role, content: cur.content });
        cur = cur.parentId ? msgs.find((m) => m.id === cur?.parentId) : undefined;
      }
      return trail;
    },
  };
}

describe('Exploration evals — MCTS reached, ranked, and readable', () => {
  let db: InstanceType<typeof Database>;
  let rt: AgentRuntime;
  let model: LanguageModel;
  let registry: StrategyRegistry;
  let tools: ToolSet;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    // Birth, then OPEN — the same two steps production takes (`kinu agent
    // create` then every running surface). The runtime `createWorkspace`
    // returns is what open.ts:49-50 calls "degraded inline
    // VFS/Memory/Executor", and its `spawnBranch` is a HARDCODED MOCK whose
    // every branch resolves to the literal string 'exploration result'
    // (identity/create.ts:57-68). An MCTS suite driving that stub is scoring
    // the stub, not exploration. `initWorkspaceSchema` is also what makes
    // `head_journal` exist at all, which this suite's settle-visibility
    // assertion requires of both halves.
    await createWorkspace(db, {
      name: 'exploration-eval',
      purpose: 'An architecture advisor that compares competing designs before recommending one.',
      llm: LLM_CONFIG,
    });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    // `hostRoot: null` for the reason harness.ts states at length: an episode
    // reaches every registered executor, and the default `laptop` plane is
    // rooted at the repo this suite was launched from. Asserted rather than
    // trusted, because this suite spends real money to find out.
    ({ rt } = await openWorkspaceCLI(db, DB_PATH, { llm: LLM_CONFIG, hostRoot: null }));
    requireSandboxedExecutors('exploration-eval', rt);
    model = liveChatModel(LLM_CONFIG);

    // `mcts` is registered for the WORKS test to drive DIRECTLY. It is no longer
    // reachable from the tool's own surface — `agents-tool.ts:911` dispatches
    // `fork` to the heads strategy and nothing else — and the eval harness is
    // named in that decision: `unit-agents-tool.test.ts:71-73` records that
    // fork-deps.ts keeps the registration "for the durable search store and the
    // eval harness", so a fork that routed here would be a silent misdispatch.
    // Driving the strategy is therefore the SUPPORTED programmatic path, not a
    // way around the tool.
    registry = createStrategyRegistry();
    registry.register(createMCTSStrategy());

    tools = buildActorTools({
      rt,
      agents: {
        mode: 'build',
        fork: {
          rt,
          model,
          defaultOptions: () => ({ mcts: { session: makeSessionWriter() } }),
        },
      },
    });
  });

  afterAll(() => {
    reportLiveModelSpend('Exploration Evals');
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('the agent is actually offered the delegation tool', () => {
    // Credential-free, and the precondition every eval below rests on. Without
    // it "the model did not fork" would be indistinguishable from "the model
    // could not fork", and the delegation rate would be measuring the harness.
    expect(Object.keys(tools)).toContain('agents');
  });

  liveTest('WORKS: a driven mcts search branches and ranks, durably', async () => {
    // Driven through the STRATEGY, not through `agents.execute`. The tool used to
    // reach this with `{ action:'fork', settle:'mcts' }`; `settle` is gone from
    // the model-facing surface (it survives only as a stored-row translation in
    // `resumableForkInput`, which reports that it cannot carry the RANKING), and
    // `fork` now dispatches to the heads strategy alone. So that call refused
    // before writing anything, and every assertion below failed on its own
    // denominator guard in milliseconds — the guards working exactly as intended.
    //
    // `action:'swarm'` is the tool's tree search now, and it is NOT what belongs
    // here: it writes the same `search_nodes` rows, but it marks `terminal` per
    // node that seals past its floor and never converges to one winner
    // (`swarm-run.ts:980`). The durability assertion below — exactly one terminal
    // node, so a later reader sees the winner this run picked — is an MCTS
    // convergence property (`mcts/convergence.ts:146-153`). Re-pointing at swarm
    // would have meant deleting that assertion, which is the opposite of the job.
    const mcts = registry.get('mcts');
    if (!mcts) throw new Error('mcts strategy is not registered');

    // The search's shape is STATED rather than inherited from `DEFAULT_CONFIG.mcts`
    // — see EVAL_SEARCH_BUDGET for the measurements that set it. Nothing below is
    // weakened by that: every assertion is the same assertion over a search that
    // finishes, and a deploy gate that does not terminate is not a gate.
    //
    // `onProgress` WIRED, because without it a search that produces nothing says
    // nothing about why. The engine reports every `branch-failed` through this
    // sink and nowhere else (mcts/engine.ts:246, :347, :433), so an unwired eval
    // discards the only account of a rollout that threw or a judge that broke, and
    // is left printing `ranked: 0` over causes it never saw. `fork-deps.ts` says
    // the same thing about production: without this a search is invisible while it
    // runs.
    const progress: string[] = [];
    const result = await mcts.explore({
      task: EXPLORATION_TASK,
      mode: 'build',
      rt,
      model,
      options: {
        mcts: {
          session: makeSessionWriter(),
          budget: EVAL_SEARCH_BUDGET,
          branches: EVAL_SEARCH_BRANCHES,
          onProgress: (event: MCTSProgressEvent) => {
            if (event.type === 'branch-failed') {
              progress.push(`${event.stage} branch failed: ${event.error}`);
            } else if (event.type === 'iteration-complete') {
              progress.push(`iteration ${String(event.iteration)} scores: `
                + `${event.scores.map((s) => s.toFixed(3)).join(', ') || '(none)'}`);
            } else if (event.type === 'grounding-unavailable') {
              progress.push(`grounding unavailable for ${event.language}; `
                + `executor runs ${event.canRun.join(', ') || '(nothing)'}`);
            }
          },
        },
      },
      reportModelCall: liveModelCallSink(rt.storage.sql),
    });
    for (const line of progress) console.log(`    ${line}`);

    // The search's calls never reach this process as an SDK result, so the ledger
    // the sink above wrote is the only place their usage exists. Reading it here
    // is what stops this suite reporting `TOTAL: 0 model call(s)` over a search
    // that spent real tokens — and if the sink ever stops being wired, this
    // records an UNMEASURED EPISODE rather than a silent zero, which the tier's
    // liveness verdict then refuses.
    recordLiveModelEpisode(rt.storage.sql);

    const score = scoreExploration(rt.storage.sql);
    console.log(`    searches: ${String(score.searchRuns)}, branched: ${String(score.branchedRuns)}, `
      + `ranked: ${String(score.rankedRuns)}, durably ranked: ${String(score.durablyRankedRuns)}`);
    for (const run of score.runs) {
      console.log(`      ${run.id}: ${String(run.branches)} branches, winner `
        + `${String(run.winnerScore)}, terminal nodes ${String(run.terminalNodes)}`);
    }

    // WHY there is no winner, when there is no winner. `converge` refuses to crown
    // one in exactly two states and marks no terminal node in either
    // (mcts/convergence.ts:73-113): distinct approaches scoring BYTE-IDENTICALLY,
    // which means the scorer is not a function of the proposal; and a best score
    // under `minAcceptableScore`. Both abandon the tree, so both arrive at the
    // assertions below as `ranked: 0` — indistinguishable without these scores.
    // Printed unconditionally rather than in a failure branch, because the
    // passing run's margin over the 0.3 floor is the number that says how close
    // this suite is to going red for a reason nobody changed.
    const scores = result.all.map((candidate) => candidate.score);
    console.log(`    winner score: ${result.best.score.toFixed(3)} (floor `
      + `${String(DEFAULT_CONFIG.mcts.minAcceptableScore)}), candidates: `
      + `${scores.map((s) => s.toFixed(3)).join(', ') || '(none)'}`);
    if (new Set(scores).size < scores.length) {
      console.log('    NOTE: candidate scores contain an exact duplicate — the '
        + 'undifferentiated-search refusal, not the score floor');
    }

    // The denominator, asserted before anything about quality. A fork that
    // never reached the store leaves every assertion below vacuously true.
    expect(score.searchRuns).toBeGreaterThan(0);

    // More than one branch: a one-branch search ranked nothing because there
    // was no competition to win.
    expect(score.branchedRuns).toBe(score.searchRuns);

    // A ranked winner the READER can hand over — not just one the engine
    // returned in memory. A merged mcts run with no ranked winner has shipped.
    expect(score.rankedRuns).toBe(score.searchRuns);

    // And the ranking survived into the store as exactly one terminal node, so
    // a later reader sees the same winner this run picked.
    expect(score.durablyRankedRuns).toBe(score.searchRuns);
  }, 900_000);

  liveTest('VISIBLE: every settle mode wrote where the Exploration reader reads', () => {
    const score = scoreSettleVisibility(rt.storage.sql);

    // PRECONDITION, before any visibility number is printed or asserted: both
    // write stores must EXIST. Measured live — a workspace built here had
    // `search_nodes` but no `head_journal`, and the unguarded scorer died with a
    // raw SQLiteError mid-eval. A thrown error is not a measurement, and "0 of 0
    // roots invisible" over a table that is not there is worse: it is a pass.
    for (const half of score.stores) {
      console.log(`    ${half.half} (${half.store}): present=${String(half.present)}`);
      expect(half.present).toBe(true);
    }

    for (const half of score.stores) {
      console.log(`    ${half.half} (${half.store}): ${String(half.rootsVisible)}/`
        + `${String(half.rootsWritten)} roots visible`);
    }

    // Denominator: something was written. An empty store makes "nothing is
    // invisible" true and meaningless — which is exactly how an empty pane
    // passed review twice.
    expect(score.rootsWritten).toBeGreaterThan(0);
    expect(score.invisibleRoots).toEqual([]);
  });

  liveTest('USED: the model reaches for exploration on a task that warrants it', async () => {
    const soul = await readSoul(rt.storage.vfs) ?? '';
    const calls: string[] = [];

    const result = await generateText({
      model,
      system: soul,
      messages: [{ role: 'user' as const, content: EXPLORATION_TASK }],
      tools,
      stopWhen: stepCountIs(12),
      onStepFinish: (step: StepResult<ToolSet>) => {
        for (const call of step.toolCalls ?? []) calls.push(call.toolName);
      },
    });
    recordLiveModelSpend(result.usage);

    const reached = calls.filter((name) => name === 'agents').length;
    console.log(`    tools called: ${calls.join(', ') || '(none)'}`);
    console.log(`    delegation-tool reaches: ${String(reached)} of ${String(calls.length)} calls`);

    // The denominator is one eligible turn, stated. This is a SAMPLE of a rate,
    // not the rate: a single turn cannot measure a conversion percentage, and
    // the aggregate lives in the delegation eval over run_events.
    //
    // What is asserted is the part that is not model-dependent: the turn
    // completed and produced observable tool traffic, so a zero above is the
    // model declining rather than the harness failing to ask. A run where the
    // model called nothing at all cannot distinguish those two.
    expect(calls.length).toBeGreaterThan(0);
  }, 600_000);
});
