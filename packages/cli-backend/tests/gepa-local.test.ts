// GEPA on the local backend — the capability that did not exist.
//
// The optimisation pass was written as a `@callable()` on OrchestratorAgent, so
// a flagship self-improvement loop with nothing Cloudflare-shaped in it could
// only ever run in the cloud. The driver now lives in core
// (evolution/control.ts) and a LocalAgentSession supplies the surface; this
// runs the whole pass through that session and checks the artifacts it is
// supposed to leave behind.
//
// Deterministic: the chat model answers, the judge scores from a script, and
// the reflection LM returns a candidate scaffold. Nothing here reaches a
// network — but every stage between the outcome ledger and gepa_runs is the
// production code path.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import {
  bootstrapScaffold, initWorkspaceSchema, listGepaRuns, recordTurnOutcome, seedSoul,
  type LLMProviderConfig,
} from '@proteus/core';
import { createCLIRuntime, makeSql, makeWorkspaceSchemaSql } from '../src/runtime.js';
import { LocalAgentSession } from '../src/local-session.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** A scripted chat model: streams `answer`, and answers non-streaming callers
 *  (the reflection LM) with `completion`. */
function scriptedModel(answer: string, completion: string): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: completion }],
      finishReason: 'stop' as const,
      usage,
      response: { id: 'r', modelId: 'fake-model', timestamp: new Date() },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  } as unknown as LanguageModel;
}

/** A candidate scaffold the 4-gate modify pipeline accepts: it delegates to the
 *  host's default loop, which is what a local scaffold has to do. */
const CANDIDATE_SCAFFOLD = `
export default async function agent(task, host) {
  const stream = await host.defaultInference();
  for await (const chunk of stream) { void chunk; }
  return { done: true };
}
`.trim();

/** Scores the seed's rollouts low and everything after them high — the shape a
 *  real pass has when reflection finds a genuine improvement, without asking a
 *  scripted judge to discriminate two identical strings. */
function risingJudge(seedCalls: number): () => Promise<string> {
  let call = 0;
  return async () => {
    const score = call++ < seedCalls ? 0.2 : 0.9;
    return JSON.stringify({ score, feedback: 'answer the correction, not the original ask' });
  };
}

async function setup(judge: () => Promise<string>) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db as never, {
    dbPath: `/tmp/proteus-gepa-${Math.floor(performance.now())}.db`,
    llm: DUMMY_LLM,
  });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  seedSoul(rt.storage.sql, { name: 'gepa-local', purpose: 'prove the pass runs locally' });
  await bootstrapScaffold(rt);

  // The judge is core's `LLM` primitive on this backend; every score comes back
  // from the script, so the pass is deterministic.
  let judgeCalls = 0;
  rt.judgeModel = {
    stream: () => { throw new Error('the judge is asked for completions, not streams'); },
    complete: async () => { judgeCalls++; return judge(); },
  };

  const model = scriptedModel('a local answer', CANDIDATE_SCAFFOLD);
  const session = new LocalAgentSession({
    rt, db, model, noAutoEvolve: true, onEvent: () => {},
  });
  return { db, rt, session, judgeCalls: () => judgeCalls };
}

/** The ledger GEPA draws its split from: failures to optimise toward, plus
 *  accepted turns as regression guards. */
function seedOutcomes(sql: ReturnType<typeof makeSql>, n = 5): void {
  for (let i = 0; i < n; i++) {
    recordTurnOutcome(sql, {
      turnId: `bad-${i}`, outcome: 'corrected', confidence: 1, source: 'classifier',
      userMessage: `summarise report ${i}`, assistantResponse: 'wrong summary',
      followup: 'no, summarise the conclusions', now: 1_000 + i,
    });
    recordTurnOutcome(sql, {
      turnId: `good-${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
      userMessage: `list the files in ${i}`, assistantResponse: 'a.txt, b.txt', now: 2_000 + i,
    });
  }
}

describe('GEPA runs on the local backend', () => {
  test('a full pass runs, is scored, and is persisted to gepa_runs', async () => {
    const { db, rt, session, judgeCalls } = await setup(risingJudge(4));
    seedOutcomes(makeSql(db));

    const result = await session.runScaffoldGepaOptimization({ maxIterations: 2, evalSize: 8, maxMetricCalls: 200 });
    await session.end();

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.runId).toBeTruthy();
    // The winner is selected out of sample: held-out failures plus guards.
    expect(result.selection!.heldOutNegatives).toBeGreaterThan(0);
    expect(result.selection!.guards).toBeGreaterThan(0);
    expect(result.seedScore!.n).toBe(result.selection!.heldOutNegatives + result.selection!.guards);
    expect(result.bestScore).toBeDefined();

    // The lineage `proteus gepa` and the web surface read.
    const runs = listGepaRuns(rt.storage.sql, 10);
    expect(runs.length).toBe(1);
    expect(runs[0]!.runId).toBe(result.runId!);
    expect(runs[0]!.status).toBe('completed');
    // Reflection really ran: metric calls beyond the seed's out-of-sample
    // scoring are minibatch rollouts of reflection-proposed candidates. Each
    // one is a full scaffold execution plus a judge call.
    expect(runs[0]!.metricCalls).toBeGreaterThan(result.seedScore!.n);
    expect(judgeCalls()).toBe(runs[0]!.metricCalls);
    const candidates = db.query(`SELECT COUNT(*) AS c FROM gepa_candidates`).get() as { c: number };
    expect(candidates.c).toBeGreaterThan(0);
    db.close();
  }, 60_000);

  test('the pass refuses when the ledger has no failure to optimise toward', async () => {
    const { db, session } = await setup(risingJudge(0));
    // Accepted turns only: nothing to select on but judge noise.
    for (let i = 0; i < 4; i++) {
      recordTurnOutcome(makeSql(db), {
        turnId: `ok-${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
        userMessage: `q${i}`, assistantResponse: 'a', now: 3_000 + i,
      });
    }

    const result = await session.runScaffoldGepaOptimization({ maxIterations: 1, evalSize: 4 });
    await session.end();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/negative|failure|labeled/i);
    // A refusal costs nothing: no run row, so the lineage stays honest.
    const runs = db.query(`SELECT COUNT(*) AS c FROM gepa_runs`).get() as { c: number };
    expect(runs.c).toBe(0);
    db.close();
  }, 30_000);
});
