/**
 * AN INTERRUPTED TURN CONTINUES — the ledger side of the invariant.
 *
 * The turn a dead process left open is re-opened ONCE. The continuation runs
 * under the run the dead process opened, so the run it seals is the run that
 * was open, and a later restart finds nothing to re-open. A continuation that
 * opened a run of its own would leave the original open for good, and every
 * restart after it would run the same turn again.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath } from '@kinu.run/test-utils';
import { initWorkspaceSchema, type LLMProviderConfig } from '@kinu.run/core';
import type { LanguageModelV2Usage } from '@ai-sdk/provider';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

/** Streams one delta and parks with the body open — the instant a death cuts. */
function parkedModel(delta: string): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta });
          await new Promise<void>((resolve) => { abortSignal?.addEventListener('abort', () => resolve(), { once: true }); });
        },
      }),
      response: { headers: {} },
    }),
  });
}

/** Answers at once, and records how many calls it took. */
function answeringModel(answer: string, calls: { n: number }): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => {
      calls.n += 1;

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

async function waitFor(pred: () => boolean): Promise<void> {
  const until = Date.now() + 5000;

  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor: condition not met');
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 5);
    await tick.promise;
  }
}

describe('AN INTERRUPTED TURN CONTINUES — once', () => {
  test('the continuation seals the run it re-opened, so a third process re-opens nothing', async () => {
    const db = new Database(scratchPath('turn-continuation', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });

    // Process A dies with the turn's first delta durable.
    const eventsA: SessionEvent[] = [];
    const a = new LocalAgentSession({ rt, db, model: parkedModel('part-'), noAutoEvolve: true, onEvent: (event) => eventsA.push(event) });
    const dying = a.send('continue me');
    await waitFor(() => eventsA.some((event) => event.type === 'text-delta'));

    // Process B continues it to completion: one model call, one answer.
    const eventsB: SessionEvent[] = [];
    const callsB = { n: 0 };
    const b = new LocalAgentSession({ rt, db, model: answeringModel('one', callsB), noAutoEvolve: true, onEvent: (event) => eventsB.push(event) });
    await waitFor(() => eventsB.some((event) => event.type === 'turn-end'));
    await b.end();
    expect(eventsB.filter((event) => event.type === 'background' && event.event === 'turn_reopened')).toHaveLength(1);
    expect(callsB.n).toBe(1);

    const runs = db.query<{ run_id: string; type: string }, []>("SELECT run_id, type FROM run_events WHERE type IN ('run_start', 'run_end') ORDER BY rowid").all();
    // ONE run: opened by A, sealed by B.
    expect(runs.map((row) => row.type)).toEqual(['run_start', 'run_end']);
    expect(new Set(runs.map((row) => row.run_id)).size).toBe(1);

    // Process C finds nothing open: no re-open (announced synchronously at
    // construction, so it is readable at once), no model call, no third answer.
    const eventsC: SessionEvent[] = [];
    const callsC = { n: 0 };
    const c = new LocalAgentSession({ rt, db, model: answeringModel('never', callsC), noAutoEvolve: true, onEvent: (event) => eventsC.push(event) });
    await c.end();
    expect(eventsC.filter((event) => event.type === 'background' && event.event === 'turn_reopened')).toHaveLength(0);
    expect(callsC.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM conversation_entries WHERE role = 'assistant'").get()?.n).toBe(1);

    // The dead process is never resumed; racing its landing against the last
    // close is what lets the test end without awaiting it.
    await Promise.race([dying, Promise.resolve()]);
    db.close();
  });
});
