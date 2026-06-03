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

/** Like fakeModel, but records the tool names the SDK hands to doStream — lets a
 *  test assert per-turn toolset filtering (e.g. by an active skill). */
function capturingModel(answer: string, sink: (toolNames: string[]) => void): LanguageModel {
  const base = fakeModel(answer) as unknown as Record<string, unknown> & { doStream: (o: unknown) => unknown };
  const inner = base.doStream.bind(base);
  return {
    ...base,
    doStream: async (options: { tools?: Array<{ name: string }> }) => {
      sink((options.tools ?? []).map((t) => t.name));
      return inner(options);
    },
  } as unknown as LanguageModel;
}

function setup(answer = 'hello there', model?: LanguageModel) {
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
    rt, db, model: model ?? fakeModel(answer), onEvent: (e) => events.push(e), noAutoEvolve: true,
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
  test('always-active skills round-trip through agent_config', () => {
    const { session } = setup();
    expect(session.getAlwaysActiveSkills()).toEqual([]);
    session.setAlwaysActiveSkills(['debugging', 'review']);
    expect(session.getAlwaysActiveSkills()).toEqual(['debugging', 'review']);
    session.setAlwaysActiveSkills([]);
    expect(session.getAlwaysActiveSkills()).toEqual([]);
  });

  test('broadcast fans out as a SessionEvent', () => {
    const { session, events } = setup();
    session.broadcast({ type: 'job_update', jobId: 'x' });
    const b = events.find((e) => e.type === 'broadcast') as Extract<SessionEvent, { type: 'broadcast' }>;
    expect(b.event.type).toBe('job_update');
  });

  test('a /skill activation filters the turn toolset to allowed_tools (+ skills)', async () => {
    let captured: string[] = [];
    const { rt, session } = setup('ok', capturingModel('ok', (t) => { captured = t; }));
    await rt.storage.vfs.mkdir('/workspace/skills', { recursive: true });
    await rt.storage.vfs.writeFile(
      '/workspace/skills/focused.md',
      '---\nname: focused\ndescription: a memory-only skill\nallowed_tools: [memory]\n---\nFocus on memory only.\n',
    );
    await session.send('/focused remember this');
    // The active skill restricts to memory; the skills tool stays reachable so
    // the agent can list/invoke more mid-turn.
    expect(new Set(captured)).toEqual(new Set(['memory', 'skills']));
  });

  test('recoverBackgroundJobs fails + wakes an orphaned running bg job, clears stale fibers', async () => {
    const { db, session, events } = setup();
    // Simulate a previous CLI exit mid-background-job: a running job + its
    // interrupted bg:* fiber row (stashed phase 'running').
    db.exec(`INSERT INTO background_jobs (id, kind, status, created_at) VALUES ('bgjob-x', 'run', 'running', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f1', 'bg:run', '{"phase":"running","jobId":"bgjob-x","kind":"run"}', 1)`);

    await session.recoverBackgroundJobs();

    expect((db.query(`SELECT status FROM background_jobs WHERE id='bgjob-x'`).get() as { status: string }).status).toBe('failed');
    expect(db.query(`SELECT COUNT(*) c FROM fibers`).get()).toEqual({ c: 0 });
    await waitFor(() => events.some((e) => e.type === 'turn-start' && e.kind === 'programmatic' && e.event === 'background_job'));
  });

  test('toolNames exposes the full surface (think/fact parity); end() resolves', async () => {
    const { session } = setup();
    const names = session.toolNames();
    // Full parity with the DO surface: execution + memory + reasoning + facts + skills.
    for (const t of ['run', 'execute_tools', 'memory', 'think', 'fact', 'skills']) expect(names).toContain(t);
    await session.send('hi');
    await session.end();   // flush partial session — no-op with auto-evolve off, must not throw
  });
});
