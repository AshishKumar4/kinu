// LocalAgentSession — the local backend's agent loop (re-arch P5). Driven by the
// authentic createCLIRuntime (real SqliteFS / shell / durable fiber) + a fake
// streaming model, so it exercises the orchestrator + BackendHost wiring without
// a network LLM. Tool-call accounting is covered by the core TurnAccumulator
// tests; here we verify the loop: turns stream + persist, programmatic turns run
// serialized (reactor / job wake), broadcast fans out, end() flushes.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LLMProviderConfig } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession, type SessionEvent } from '../src/local-session.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** A streaming LanguageModel stub (ai-SDK v2 spec parts) — emits the answer as
 *  two text-delta chunks then a finish, so runChat yields multiple text-delta
 *  events + a done. */
function fakeModel(answer: string): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: a });
          controller.enqueue({ type: 'text-delta', id: '0', delta: b });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  } as unknown as LanguageModel;
}

function setup(answer = 'hello there') {
  const db = new Database(':memory:');
  // The agent DB carries a messages table in production (created on `proteus
  // create`); the runtime factory doesn't, so provision it for the test.
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db as never, { dbPath: `/tmp/proteus-test-${Math.floor(performance.now())}.db`, llm: DUMMY_LLM });
  const events: SessionEvent[] = [];
  const session = new LocalAgentSession({
    rt, db, model: fakeModel(answer), onEvent: (e) => events.push(e), noAutoEvolve: true,
  });
  return { db, rt, session, events };
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise<void>((r) => setTimeout(r, 2));
  }
}

const kinds = (events: SessionEvent[]) => events.map((e) => e.type);
const turnStarts = (events: SessionEvent[]) =>
  events.filter((e): e is Extract<SessionEvent, { type: 'turn-start' }> => e.type === 'turn-start');

describe('LocalAgentSession.send — a user turn', () => {
  test('streams text, persists the exchange, and ends the turn', async () => {
    const { db, session, events } = setup('hello there');
    await session.send('hi');

    expect(kinds(events)).toContain('turn-start');
    expect(kinds(events)).toContain('text-delta');
    expect(kinds(events)).toContain('turn-end');

    const start = turnStarts(events)[0]!;
    expect(start.kind).toBe('user');
    expect(start.text).toBe('hi');

    const streamed = events.filter((e) => e.type === 'text-delta').map((e) => (e as { delta: string }).delta).join('');
    expect(streamed).toBe('hello there');

    const turnEnd = events.find((e) => e.type === 'turn-end') as Extract<SessionEvent, { type: 'turn-end' }>;
    expect(turnEnd.turn.userMessage).toBe('hi');
    expect(turnEnd.turn.assistantResponse).toBe('hello there');

    const rows = db.query(`SELECT role, content FROM messages ORDER BY created_at`).all() as Array<{ role: string; content: string }>;
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[1]!.content).toBe('hello there');
  });
});

describe('LocalAgentSession — programmatic turns (reactor / background-job wake)', () => {
  test('enqueueTurn runs serialized after the user turn, marked with its event', async () => {
    const { session, events } = setup('ok');
    // Enqueue a user turn and a programmatic wake in the same tick → FIFO, no interleave.
    const userDone = session.send('do it');
    await session.enqueueTurn({ text: 'job xyz finished', metadata: { proteusEvent: 'background_job', jobId: 'bgjob-1' } });
    await userDone;
    // send() resolves on its own turn; the cascaded programmatic turn drains next.
    await waitFor(() => events.filter((e) => e.type === 'turn-end').length === 2);

    const starts = turnStarts(events);
    expect(starts.map((s) => s.kind)).toEqual(['user', 'programmatic']);
    expect(starts[0]!.text).toBe('do it');
    expect(starts[1]!.event).toBe('background_job');
  });

  test('enqueueTurn self-starts the pump when idle (a wake with no user turn)', async () => {
    const { session, events } = setup('woke');
    await session.enqueueTurn({ text: 'wake up', metadata: { proteusEvent: 'background_job' } });
    // Give the self-started pump a tick to finish.
    await new Promise<void>((r) => setTimeout(r, 5));
    const starts = turnStarts(events);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.kind).toBe('programmatic');
  });
});

describe('LocalAgentSession — BackendHost + lifecycle', () => {
  test('broadcast fans out as a SessionEvent', () => {
    const { session, events } = setup();
    session.broadcast({ type: 'job_update', jobId: 'x' });
    const b = events.find((e) => e.type === 'broadcast') as Extract<SessionEvent, { type: 'broadcast' }>;
    expect(b.event.type).toBe('job_update');
  });

  test('toolNames exposes the built-in surface; end() resolves', async () => {
    const { session } = setup();
    const names = session.toolNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('run');
    await session.send('hi');
    await session.end();   // flush partial session — no-op with auto-evolve off, must not throw
  });
});
