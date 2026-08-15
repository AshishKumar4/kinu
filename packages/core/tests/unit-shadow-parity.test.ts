/**
 * Shadow context parity — a context-dependent task no longer auto-loses in
 * the shadow eval.
 *
 * The live answer is produced with the full conversational context; before
 * the parity fix the shadow's pending got (a) a task-text-only
 * host.defaultInference reconstruction and (b) its ui_chunk output dropped
 * from the judged text — a delegating pending was structurally tie-prone or
 * worse. The orchestrator now replays the live turn's prepared streamText
 * opts into the shadow's defaultInference; these tests pin the core side of
 * that contract: the delegating pending's full-context output reaches the
 * judge verbatim.
 */

import { describe, test, expect } from 'bun:test';
import {
  runAutoShadowEval,
  initScaffoldTables,
  initShadowTables,
  type ScaffoldDefaultInferenceChunk,
  type StructuredJudgeFn,
} from '../src/index.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import { createEvalExecutor, createTestRuntime } from './helpers.js';

/** A pending scaffold that delegates to the default loop — the bootstrap
 *  pattern, and the shape most proposals build on. */
const DELEGATING_PENDING = `async function* run(rt, task) {
  await host.defaultInference();
}`;

const TASK = 'What is my project codename?';
const CONTEXT_AWARE_ANSWER = 'Your project codename is BLUEFIN.';
const CONTEXT_FREE_ANSWER = "I don't have a codename on record for you.";

async function setup(): Promise<AgentRuntime> {
  const { rt } = createTestRuntime();
  initScaffoldTables(rt.storage.execRaw);
  initShadowTables(rt.storage.execRaw);
  rt.executor = createEvalExecutor();
  void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (0, ${Date.now()}, 'bootstrap', 'current')`;
  void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (1, ${Date.now()}, 'delegating pending', 'pending')`;
  await rt.storage.vfs.writeFile('scaffold/agent.js.v1', DELEGATING_PENDING);
  await rt.identity.scaffold.write('async function* run(rt, task) { yield { type: "chunk", data: "v0" }; }');
  return rt;
}

/** A deterministic judge that decides purely from CONTENT — which it must,
 *  since the protocol shows the two responses unlabelled in a randomized
 *  order. It rewards whichever response cites the codename; when both (or
 *  neither) do, it ties. */
const contextJudge: StructuredJudgeFn = async (prompt) => {
  const [a, b] = prompt.split('\nResponse B:\n');
  const aSaw = a.slice(a.indexOf('\nResponse A:\n')).includes('BLUEFIN');
  const bSaw = b.includes('BLUEFIN');
  if (aSaw === bSaw) {
    return { winner: 'tie', rationale: 'both responses cite the codename', scoreA: 0.8, scoreB: 0.8 };
  }
  return {
    winner: aSaw ? 'a' : 'b',
    rationale: 'the loser lacks the conversational context',
    scoreA: aSaw ? 0.8 : 0.2,
    scoreB: bSaw ? 0.8 : 0.2,
  };
};

/** What the orchestrator's defaultInference bridge streams: AI-SDK UI
 *  message chunks. With the live opts replayed it can answer from context. */
function uiStream(answer: string): () => AsyncIterable<ScaffoldDefaultInferenceChunk> {
  return async function* () {
    yield { value: { type: 'text-delta', delta: answer } };
  };
}

describe('shadow context parity', () => {
  test('a delegating pending with the live context no longer auto-loses on a context-dependent task', async () => {
    const rt = await setup();
    const result = await runAutoShadowEval({
      rt,
      task: TASK,
      currentOutput: CONTEXT_AWARE_ANSWER, // the live answer, produced with full context
      judge: contextJudge,
      llmStream: async function* () { yield ''; },
      // The orchestrator now replays the live turn's full streamText opts —
      // so defaultInference yields the context-aware answer.
      defaultInference: uiStream(CONTEXT_AWARE_ANSWER),
      random: () => 0,
    });

    expect(result.skipped).toBe(false);
    expect(result.evaluation?.winner).toBe('tie');

    // The judged pending output is the delegated full-context answer — the
    // ui_chunk text reached the eval row verbatim.
    const row = rt.storage.sql<{ pending_output: string; winner: string }>`
      SELECT pending_output, winner FROM scaffold_evaluations`[0]!;
    expect(row.pending_output).toBe(CONTEXT_AWARE_ANSWER);
    expect(row.winner).toBe('tie');
  });

  test('without the live context the same pending structurally loses — the handicap the fix removes', async () => {
    const rt = await setup();
    const result = await runAutoShadowEval({
      rt,
      task: TASK,
      currentOutput: CONTEXT_AWARE_ANSWER,
      // Old behavior: a task-text-only reconstruction can't know the codename.
      defaultInference: uiStream(CONTEXT_FREE_ANSWER),
      judge: contextJudge,
      llmStream: async function* () { yield ''; },
      random: () => 0,
    });
    expect(result.skipped).toBe(false);
    expect(result.evaluation?.winner).toBe('current');
  });
});
