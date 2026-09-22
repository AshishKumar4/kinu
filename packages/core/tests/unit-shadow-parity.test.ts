import type { ChatEvent } from '../src/chat';
/** Shadow context parity: a delegating pending's full-context output reaches the judge verbatim. */

import { describe, test, expect } from 'bun:test';
import {
  runAutoShadowEval,
  initScaffoldTables,
  initShadowTables,
  type ScaffoldDefaultInferenceChunk,
  type StructuredJudgeFn,
} from '../src/index';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { createEvalExecutor, createTestRuntime } from './helpers';
import { RunEventRecorder } from '../src/events/recorder';

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
  void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, 0, ${Date.now()}, 'bootstrap', 'current')`;
  void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, 1, ${Date.now()}, 'delegating pending', 'pending')`;
  await rt.storage.vfs.writeFile('scaffold/agent.js.v1', DELEGATING_PENDING);
  await rt.identity.scaffold.write('async function* run(rt, task) { yield { type: "chunk", data: "v0" }; }');

  return rt;
}

/** Decides from content alone (responses are unlabelled, shuffled): rewards citing the codename, else ties. */
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

/** What the orchestrator's defaultInference bridge streams: AI-SDK UI message chunks. */
function uiStream(answer: string): () => AsyncIterable<ScaffoldDefaultInferenceChunk> {
  return async function* () {
    yield { value: { type: 'text-delta', delta: answer } };
  };
}

describe('shadow context parity', () => {
  test('a delegating pending with the live context does not auto-lose on a context-dependent task', async () => {
    const rt = await setup();

    const result = await runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt,
      task: TASK,
      currentOutput: CONTEXT_AWARE_ANSWER,
      judge: contextJudge,
      llmStream: async function* () { yield { type: 'text-delta', delta: '' } satisfies ChatEvent; },
      defaultInference: uiStream(CONTEXT_AWARE_ANSWER),
      random: () => 0,
    });

    expect(result.skipped).toBe(false);
    expect(result.evaluation?.winner).toBe('tie');

    const row = rt.storage.sql<{ pending_output: string; winner: string }>`
      SELECT pending_output, winner FROM scaffold_evaluations
      WHERE actor_id = ${rt.actor.actorId}`[0];

    expect(row.pending_output).toBe(CONTEXT_AWARE_ANSWER);
    expect(row.winner).toBe('tie');
  });

  test('without the live context the same pending structurally loses — the handicap the fix removes', async () => {
    const rt = await setup();

    const result = await runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt,
      task: TASK,
      currentOutput: CONTEXT_AWARE_ANSWER,
      defaultInference: uiStream(CONTEXT_FREE_ANSWER),
      judge: contextJudge,
      llmStream: async function* () { yield { type: 'text-delta', delta: '' } satisfies ChatEvent; },
      random: () => 0,
    });

    expect(result.skipped).toBe(false);
    expect(result.evaluation?.winner).toBe('current');
  });
});
