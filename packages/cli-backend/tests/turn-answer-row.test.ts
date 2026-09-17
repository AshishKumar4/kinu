/**
 * THE STORED ANSWER IS THE TURN'S ANSWER — the row side of the one rule.
 *
 * `runChat` selects the answer (the final step's text, chat.ts
 * `answerFromSteps`); the durable assistant row must hold exactly that. The
 * defect measured 2026-09-16 on build cba44dcb9 was every consumer keeping its
 * own rule: the session accumulated every delta it saw and the row read
 * "narration + answer" concatenated. Driven through `LocalAgentSession`, read
 * back off `actor_messages`.
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

/** Narrates, calls a tool, then answers: two model calls, one turn. */
function narratedModel(narration: string, answer: string): TestLanguageModelV2 {
  let calls = 0;

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => {
      const step = calls++;

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (step === 0) {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: narration });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({
                type: 'tool-call', toolCallId: 'call-1', toolName: 'fact',
                input: JSON.stringify({ action: 'recall', key: 'probe' }),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

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
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
      }),
      response: { headers: {} },
    }),
  });
}

function assistantRows(db: Database): string[] {
  return db.query<{ content: string }, []>("SELECT content FROM actor_messages WHERE role = 'assistant' ORDER BY rowid").all()
    .map((row) => row.content);
}

function openSession(name: string) {
  const db = new Database(scratchPath('turn-answer-row', `${name}.db`));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });

  return { db, rt };
}

/** Parks before any token until aborted. */
function silentModel(): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          await new Promise<void>((resolve) => { abortSignal?.addEventListener('abort', () => resolve(), { once: true }); });
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
      }),
      response: { headers: {} },
    }),
  });
}

describe('an interrupted turn', () => {
  test('cut before its first token leaves no assistant row; cut after one keeps the cut text', async () => {
    // Pre-switch shape on both backends: a Stop before anything streamed is
    // the operator's row alone, never an empty bubble on reload.
    const silent = openSession('silent');
    const opened = Promise.withResolvers<void>();

    const a = new LocalAgentSession({
      rt: silent.rt, db: silent.db, model: silentModel(), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'run-event' && event.event.type === 'model_operation') opened.resolve(); },
    });

    const turn = a.send('say nothing');
    await opened.promise;
    a.interrupt();
    await turn;
    await a.end();
    expect(assistantRows(silent.db)).toEqual([]);
    expect(silent.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM actor_messages WHERE role = 'user'").get()?.n).toBe(1);
    silent.db.close();

    const cut = openSession('cut');
    const streamed = Promise.withResolvers<void>();

    const b = new LocalAgentSession({
      rt: cut.rt, db: cut.db, model: parkedModel('part-'), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'text-delta') streamed.resolve(); },
    });

    const cutTurn = b.send('say part');
    await streamed.promise;
    b.interrupt();
    await cutTurn;
    await b.end();
    expect(assistantRows(cut.db)).toEqual(['part-']);
    cut.db.close();
  });
});

describe('the assistant row holds the answer', () => {
  test('a narrated multi-step turn stores its final step; the deltas still stream', async () => {
    const { db, rt } = openSession('narrated');
    const events: SessionEvent[] = [];

    const session = new LocalAgentSession({
      rt, db, model: narratedModel('Running the test in the sandbox:', 'FAIL'), noAutoEvolve: true, onEvent: (event) => events.push(event),
    });

    await session.send('Run the test and reply with only PASS or FAIL.');
    await session.end();

    const streamed = events.filter((event) => event.type === 'text-delta').map((event) => event.type === 'text-delta' ? event.delta : '');
    expect(streamed).toEqual(['Running the test in the sandbox:', 'FAIL']);
    expect(assistantRows(db)).toEqual(['FAIL']);
    db.close();
  });

  test('a continuation that went on to call tools stores the answer, not the cut narration in front of it', async () => {
    // Process A dies inside a narration step; process B continues, calls a
    // tool and answers. The cut text is that narration step's, not the answer's.
    const { db, rt } = openSession('continued');
    const streamedA = Promise.withResolvers<void>();

    const a = new LocalAgentSession({
      rt, db, model: parkedModel('Looking at it: '), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'text-delta') streamedA.resolve(); },
    });

    const dying = a.send('continue me');
    await streamedA.promise;

    const eventsB: SessionEvent[] = [];
    const ended = Promise.withResolvers<void>();

    const b = new LocalAgentSession({
      rt, db, model: narratedModel('', 'FAIL'), noAutoEvolve: true,
      onEvent: (event) => { eventsB.push(event);

 if (event.type === 'turn-end') ended.resolve(); },
    });

    await ended.promise;
    await b.end();

    expect(eventsB.filter((event) => event.type === 'tool-call')).toHaveLength(1);
    expect(assistantRows(db)).toEqual(['FAIL']);
    await Promise.race([dying, Promise.resolve()]);
    db.close();
  });

  test('a continuation of the cut answer step joins the cut text to what it finished', async () => {
    const { db, rt } = openSession('joined');
    const streamedA = Promise.withResolvers<void>();

    const a = new LocalAgentSession({
      rt, db, model: parkedModel('part-'), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'text-delta') streamedA.resolve(); },
    });

    const dying = a.send('continue me');
    await streamedA.promise;

    const ended = Promise.withResolvers<void>();

    const finishing = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'two' });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            controller.close();
          },
        }),
        response: { headers: {} },
      }),
    });

    const b = new LocalAgentSession({
      rt, db, model: finishing, noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'turn-end') ended.resolve(); },
    });

    await ended.promise;
    await b.end();

    expect(assistantRows(db)).toEqual(['part-two']);
    await Promise.race([dying, Promise.resolve()]);
    db.close();
  });
});
