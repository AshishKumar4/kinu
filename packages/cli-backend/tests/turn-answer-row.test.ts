/** The durable assistant row reads as the answer `runChat` selects (chat.ts `answerFromSteps`), not narration + answer. */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readTranscriptRows, scratchPath } from '@kinu.run/test-utils';
import { CHAT_SESSION_ID, initWorkspaceSchema, readSessionTranscript, type LLMProviderConfig } from '@kinu.run/core';
import type { LanguageModelV2Usage } from '@ai-sdk/provider';
import { createCLIRuntime, makeSql, makeWorkspaceSchemaSql, type CLIRuntime } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

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

/** A step that says `narration` and calls a tool, then one that streams `delta` and waits to be stopped. */
function narratedThenParked(narration: string, delta: string): TestLanguageModelV2 {
  const narrated = narratedModel(narration, '');
  const parked = parkedModel(delta);
  let calls = 0;

  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-model', doStream: async (options) => (calls++ === 0 ? narrated : parked).doStream(options),
  });
}

interface OpenedSession { readonly db: Database; readonly rt: CLIRuntime }

function openSession(name: string): OpenedSession {
  const db = new Database(scratchPath('turn-answer-row', `${name}.db`));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });

  return { db, rt };
}

async function rowsOf(session: OpenedSession, role: 'user' | 'assistant'): Promise<string[]> {
  const rows = await readTranscriptRows(makeSql(session.db), session.rt.actor, session.rt.storage.vfs);

  return rows.filter((row) => row.role === role).map((row) => row.content);
}

/** Each assistant row's texts as the chat pane draws them. */
async function drawnTexts(session: OpenedSession): Promise<string[][]> {
  const transcript = readSessionTranscript(makeSql(session.db), session.rt.actor, CHAT_SESSION_ID, () => Promise.resolve(session.rt.storage.vfs));

  return (await transcript.history()).filter((message) => message.role === 'assistant')
    .map((message) => message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []));
}

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
    // A Stop before anything streamed leaves the operator's row alone, never an empty bubble on reload.
    const silent = openSession('silent');
    const opened = Promise.withResolvers<void>();

    const a = new LocalAgentSession({
      rt: silent.rt, db: silent.db, model: silentModel(), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'run-event' && event.event.type === 'model_operation') opened.resolve(); },
    });

    const turn = a.send('say nothing', { id: crypto.randomUUID() });
    await opened.promise;
    a.interrupt();
    await turn;
    await a.end();
    expect(await rowsOf(silent, 'assistant')).toEqual([]);
    expect(await rowsOf(silent, 'user')).toEqual(['say nothing']);
    silent.db.close();

    const cut = openSession('cut');
    const streamed = Promise.withResolvers<void>();

    const b = new LocalAgentSession({
      rt: cut.rt, db: cut.db, model: parkedModel('part-'), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'text-delta') streamed.resolve(); },
    });

    const cutTurn = b.send('say part', { id: crypto.randomUUID() });
    await streamed.promise;
    b.interrupt();
    await cutTurn;
    await b.end();
    expect(await rowsOf(cut, 'assistant')).toEqual(['part-']);
    cut.db.close();
  });

  test('stopped after a narrated step, the row keeps the narration in place and answers with the last text', async () => {
    const opened = openSession('stopped-narrated');
    const streamed = Promise.withResolvers<void>();

    const session = new LocalAgentSession({
      rt: opened.rt, db: opened.db, model: narratedThenParked('Checking the fact first.', 'The fact is'), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'text-delta' && event.delta === 'The fact is') streamed.resolve(); },
    });

    const turn = session.send('What is the fact?', { id: crypto.randomUUID() });
    await streamed.promise;
    session.interrupt();
    await turn;
    await session.end();
    expect(await drawnTexts(opened)).toEqual([['Checking the fact first.', 'The fact is']]);
    expect(await rowsOf(opened, 'assistant')).toEqual(['The fact is']);
    opened.db.close();
  });
});

describe('the assistant row holds the answer', () => {
  test('a narrated multi-step turn stores its final step; the deltas still stream', async () => {
    const opened = openSession('narrated');
    const { db, rt } = opened;
    const events: SessionEvent[] = [];

    const session = new LocalAgentSession({
      rt, db, model: narratedModel('Running the test in the sandbox:', 'FAIL'), noAutoEvolve: true, onEvent: (event) => events.push(event),
    });

    await session.send('Run the test and reply with only PASS or FAIL.', { id: crypto.randomUUID() });
    await session.end();

    const streamed = events.filter((event) => event.type === 'text-delta').map((event) => event.type === 'text-delta' ? event.delta : '');
    expect(streamed).toEqual(['Running the test in the sandbox:', 'FAIL']);
    expect(await drawnTexts(opened)).toEqual([['Running the test in the sandbox:', 'FAIL']]);
    expect(await rowsOf(opened, 'assistant')).toEqual(['FAIL']);
    db.close();
  });

  test('a continuation that went on to call tools stores the answer, not the cut narration in front of it', async () => {
    // The cut text is the dead process's narration step, not the answer.
    const opened = openSession('continued');
    const { db, rt } = opened;
    const streamedA = Promise.withResolvers<void>();

    const a = new LocalAgentSession({
      rt, db, model: parkedModel('Looking at it: '), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'text-delta') streamedA.resolve(); },
    });

    const dying = a.send('continue me', { id: crypto.randomUUID() });
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
    expect(await rowsOf(opened, 'assistant')).toEqual(['FAIL']);
    await Promise.race([dying, Promise.resolve()]);
    db.close();
  });

  test('a continuation of the cut answer step joins the cut text to what it finished', async () => {
    const opened = openSession('joined');
    const { db, rt } = opened;
    const streamedA = Promise.withResolvers<void>();

    const a = new LocalAgentSession({
      rt, db, model: parkedModel('part-'), noAutoEvolve: true,
      onEvent: (event) => { if (event.type === 'text-delta') streamedA.resolve(); },
    });

    const dying = a.send('continue me', { id: crypto.randomUUID() });
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

    expect(await rowsOf(opened, 'assistant')).toEqual(['part-two']);
    await Promise.race([dying, Promise.resolve()]);
    db.close();
  });
});
