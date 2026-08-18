/**
 * Behavioural evals for exploration: does the agent use MCTS when it should,
 * use it PROPERLY, and does it WORK.
 *
 * Three questions, deliberately separated, because they fail for different
 * reasons and conflating them is how "MCTS works" got believed while the
 * Exploration pane was empty.
 *
 *   WORKS   — driven by the harness through the real `agents` tool, so the model
 *             cannot decline. A pass means the mechanism produces a branched,
 *             ranked, reader-visible search. Deterministic in shape; the model
 *             only supplies the content.
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
  buildBuiltinTools,
  createMCTSStrategy,
  createStrategyRegistry,
  initWorkspaceSchema,
  readSoul,
  type AgentRuntime,
  type LLMProviderConfig,
  type SessionMessage,
  type SessionWriter,
  type StrategyRegistry,
} from '../../packages/core/src/index';
import { createWorkspace } from '../../packages/core/src/identity/index';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { makeWorkspaceSchemaSql } from '../../packages/cli-backend/src/runtime';
import { requireSandboxedExecutors } from './harness';
import {
  liveChatModel, liveModelTarget, recordLiveModelSpend, reportLiveModelSpend,
  scoreExploration, scoreSettleVisibility, UNCONFIGURED_LLM,
} from '@proteus/test-utils';

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
    // Birth, then OPEN — the same two steps production takes (`proteus agent
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

    // Only `mcts` is registered, so `settle` has exactly one destination and a
    // fork that lands anywhere else is a wiring fault rather than a choice.
    registry = createStrategyRegistry();
    registry.register(createMCTSStrategy());

    tools = buildBuiltinTools({
      rt,
      agents: {
        mode: 'build',
        fork: {
          registry,
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

  liveTest('WORKS: a driven mcts fork branches and ranks, durably', async () => {
    const agents = tools.agents;
    if (!agents?.execute) throw new Error('agents tool has no execute');

    await agents.execute(
      { action: 'fork', task: EXPLORATION_TASK, settle: 'mcts' },
      { toolCallId: 'eval-mcts-1', messages: [] },
    );

    const score = scoreExploration(rt.storage.sql);
    console.log(`    searches: ${String(score.competedRuns)}, branched: ${String(score.branchedRuns)}, `
      + `ranked: ${String(score.rankedRuns)}, durably ranked: ${String(score.durablyRankedRuns)}`);
    for (const run of score.runs) {
      console.log(`      ${run.id}: ${String(run.branches)} branches, winner `
        + `${String(run.winnerScore)}, terminal nodes ${String(run.terminalNodes)}`);
    }

    // The denominator, asserted before anything about quality. A fork that
    // never reached the store leaves every assertion below vacuously true.
    expect(score.competedRuns).toBeGreaterThan(0);

    // More than one branch: a one-branch search ranked nothing because there
    // was no competition to win.
    expect(score.branchedRuns).toBe(score.competedRuns);

    // A ranked winner the READER can hand over — not just one the engine
    // returned in memory. A merged mcts run with no ranked winner has shipped.
    expect(score.rankedRuns).toBe(score.competedRuns);

    // And the ranking survived into the store as exactly one terminal node, so
    // a later reader sees the same winner this run picked.
    expect(score.durablyRankedRuns).toBe(score.competedRuns);
  }, 900_000);

  liveTest('VISIBLE: every settle mode wrote where the Exploration reader reads', () => {
    const score = scoreSettleVisibility(rt.storage.sql);

    // PRECONDITION, before any visibility number is printed or asserted: both
    // write stores must EXIST. Measured live — a workspace built here had
    // `search_nodes` but no `head_journal`, and the unguarded scorer died with a
    // raw SQLiteError mid-eval. A thrown error is not a measurement, and "0 of 0
    // roots invisible" over a table that is not there is worse: it is a pass.
    for (const half of score.stores) {
      console.log(`    ${half.settle} (${half.store}): present=${String(half.present)}`);
      expect(half.present).toBe(true);
    }

    for (const half of score.stores) {
      console.log(`    ${half.settle} (${half.store}): ${String(half.rootsVisible)}/`
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
