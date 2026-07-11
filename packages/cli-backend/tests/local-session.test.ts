// LocalAgentSession — the local backend's agent loop (re-arch P5). Driven by the
// authentic createCLIRuntime (real SqliteFS / shell / durable fiber) + a fake
// streaming model, so it exercises the orchestrator + BackendHost wiring without
// a network LLM. Tool-call accounting is covered by the core TurnAccumulator
// tests; here we verify the loop: turns stream + persist, programmatic turns run
// serialized (reactor / job wake), broadcast fans out, end() flushes.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel, ModelMessage } from 'ai';
import type { LLMProviderConfig } from '@proteus/core';
import { DEFAULT_WORKERS_AI_MODEL_SPEC, initSearchTables, initAlternateTakesTable, captureAlternateTakes } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession, serializeContentForHeads, type LocalAgentSessionOpts, type SessionEvent } from '../src/local-session.js';
import { cloudProxyBaseURL, createLocalModelResolver, type LocalModelResolver } from '../src/model-resolver.js';
import { createNodeExecuteToolFactory } from '../src/execute-tools-factory.js';
import { createLocalAgentSelfProvider } from '../src/agent-self.js';

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

function historyCapturingModel(answer: string, sink: (messages: ModelMessage[]) => void): LanguageModel {
  const base = fakeModel(answer) as unknown as Record<string, unknown> & { doStream: (o: unknown) => unknown };
  const inner = base.doStream.bind(base);
  return {
    ...base,
    doStream: async (options: { messages?: ModelMessage[]; prompt?: ModelMessage[] }) => {
      sink(options.messages ?? options.prompt ?? []);
      return inner(options);
    },
  } as unknown as LanguageModel;
}

/** Captures the system prompt the SDK hands to doStream (the first
 *  role:'system' entry of the LanguageModelV2 prompt). */
function systemCapturingModel(answer: string, sink: (system: string) => void): LanguageModel {
  const base = fakeModel(answer) as unknown as Record<string, unknown> & { doStream: (o: unknown) => unknown };
  const inner = base.doStream.bind(base);
  return {
    ...base,
    doStream: async (options: { prompt?: Array<{ role: string; content: unknown }> }) => {
      const system = (options.prompt ?? []).find((m) => m.role === 'system');
      sink(typeof system?.content === 'string' ? system.content : '');
      return inner(options);
    },
  } as unknown as LanguageModel;
}

function setup(answer = 'hello there', model?: LanguageModel, extra?: Partial<LocalAgentSessionOpts>) {
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
    ...extra,
  });
  return { db, rt, session, events };
}

function setupWithResolver(resolver: LocalModelResolver) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db as never, { dbPath: `/tmp/proteus-test-${Math.floor(performance.now())}.db`, llm: DUMMY_LLM });
  const events: SessionEvent[] = [];
  const session = new LocalAgentSession({
    rt, db, model: fakeModel('fallback'), modelResolver: resolver, onEvent: (e) => events.push(e), noAutoEvolve: true,
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

  test('attachments reach the model as [file…, text] user content parts', async () => {
    let observed: ModelMessage[] = [];
    const { db, session } = setup('a red square', historyCapturingModel('a red square', (messages) => { observed = messages; }));

    await session.send({
      text: 'what is in this image?',
      files: [{
        filename: 'square.png',
        mediaType: 'image/png',
        url: 'data:image/png;base64,iVBORw0KGgo=',
      }],
    });

    // The trailing user message is the ephemeral system-state block; the
    // attachment rides on the user's own message (the one carrying a file part).
    const user = [...observed].reverse().find((m) =>
      m.role === 'user' && Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some((p) => p?.type === 'file'));
    expect(user).toBeDefined();
    const parts = user!.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/png', filename: 'square.png' });
    expect(parts[1]).toMatchObject({ type: 'text', text: 'what is in this image?' });

    // The durable transcript persists the text — never the data-URL payload.
    const rows = db.query(`SELECT role, content FROM messages ORDER BY created_at`).all() as Array<{ role: string; content: string }>;
    expect(rows[0]).toEqual({ role: 'user', content: 'what is in this image?' });
  });

  test('facts ride the ephemeral system-state block, never the system prompt', async () => {
    // Cache-prefix stability: the system prompt must stay byte-stable across
    // turns, so system state (the facts world model, executor status) rides
    // the ephemeral ledger's frozen blocks in the messages array instead.
    let observed: ModelMessage[] = [];
    let system = '';
    const model = historyCapturingModel('ok', (messages) => { observed = messages; });
    const base = model as unknown as { doStream: (o: never) => unknown };
    const inner = base.doStream.bind(base);
    base.doStream = ((options: { prompt?: Array<{ role: string; content: unknown }> }) => {
      const sys = (options.prompt ?? []).find((m) => m.role === 'system');
      if (typeof sys?.content === 'string') system = sys.content;
      return inner(options as never);
    }) as never;
    const { db, session } = setup('ok', model);

    await session.send('hi');
    const factsBefore = observed.map(messageText).join('\n');
    expect(factsBefore).not.toContain('FACT-MARKER');
    // Turn 1 froze one block (executor status renders even with no facts).
    const turn1Block = observed.map(messageText).find((t) => t.startsWith('[Ephemeral context'));
    expect(turn1Block).toBeDefined();

    // Seed a fact, then run another turn — the state fingerprint changed, so
    // a NEW block appends at the tail while turn 1's block stays frozen.
    db.exec(`INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
             VALUES ('test.marker', '"FACT-MARKER"', 1.0, 'tool', ${Date.now()})`);
    await session.send('and now?');

    expect(system).not.toContain('FACT-MARKER');
    const texts = observed.map(messageText);
    const tail = texts.at(-1)!;
    expect(tail).toStartWith('[Ephemeral context');
    expect(tail).toContain('World model');
    expect(tail).toContain('FACT-MARKER');
    expect(texts).toContain(turn1Block!); // byte-identical, still in place

    // Ephemeral blocks are turn-assembly state — never persisted.
    const rows = db.query(`SELECT content FROM messages`).all() as Array<{ content: string }>;
    expect(rows.some((r) => r.content.includes('Ephemeral context'))).toBe(false);
  });

  test('the MEMORY.md tail (newest lessons) rides the ephemeral block, never the system prefix', async () => {
    // Two regressions guarded here: slice(0, 2000) once injected the OLDEST
    // bytes of the append-only MEMORY.md, and the tail once lived in the
    // byte-stable system prefix — where every lesson/reflection/take-pick
    // append busted the prompt cache with no real agent event.
    let observed: ModelMessage[] = [];
    const { rt, session } = setup('ok', historyCapturingModel('ok', (messages) => { observed = messages; }));
    await rt.memory.write(
      'memory/MEMORY.md',
      `### Lesson OLD-STALE-MARKER\n${'x'.repeat(2500)}\n### Lesson NEW-LESSON-MARKER recorded last\n`,
    );
    await session.send('hi');

    const system = observed.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(String(system!.content)).not.toContain('NEW-LESSON-MARKER');
    const block = observed.map(messageText).find((t) => t.startsWith('[Ephemeral context'))!;
    expect(block).toContain('NEW-LESSON-MARKER');
    expect(block).not.toContain('OLD-STALE-MARKER');
  });

  test('the system prompt advertises the laptop as the direct CLI host machine', async () => {
    // Local agents run ON the user's machine — the laptop executor is always
    // available and direct, so the prompt must not borrow the cloud wording
    // (device tunnel, consent prompt, offline/reconnect states).
    let observed: ModelMessage[] = [];
    const { session } = setup('ok', historyCapturingModel('ok', (messages) => { observed = messages; }));
    await session.send('hi');

    const system = observed.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    const text = String(system!.content);
    expect(text).toContain('laptop.*');
    expect(text).toContain('the local machine the Proteus CLI is running on');
    expect(text).not.toContain('device tunnel');
    expect(text).not.toContain('asks the user for consent');
    expect(text).not.toContain('OFFLINE');
  });

  test('head-inherited context drops file-part data URLs, keeps the reference', () => {
    const serialized = serializeContentForHeads([
      { type: 'file', data: 'data:image/png;base64,AAAA', mediaType: 'image/png', filename: 'square.png' },
      { type: 'text', text: 'what is this?' },
    ]);
    expect(serialized).not.toContain('base64,AAAA');
    expect(JSON.parse(serialized)).toEqual([
      { type: 'file', mediaType: 'image/png', filename: 'square.png' },
      { type: 'text', text: 'what is this?' },
    ]);
    expect(serializeContentForHeads('plain text')).toBe('plain text');
  });

  test('restores persisted history for the same durable session id', async () => {
    const { db, rt, session } = setup('remembered answer');
    await session.send('remember this');
    await session.end();

    let observed: ModelMessage[] = [];
    const events: SessionEvent[] = [];
    const resumed = new LocalAgentSession({
      rt,
      db,
      sessionId: 'default',
      model: historyCapturingModel('next answer', (messages) => { observed = messages; }),
      onEvent: (e) => events.push(e),
      noAutoEvolve: true,
    });

    await resumed.send('what did I say?');
    await resumed.end();

    // The ephemeral system-state blocks (executor status etc.) are woven in
    // at turn assembly and never persisted — filter them for the order checks.
    const text = observed.map(messageText).filter((t) => !t.startsWith('[Ephemeral context'));
    expect(text).toContain('remember this');
    expect(text).toContain('remembered answer');
    expect(text.at(-1)).toBe('what did I say?');
    expect(text.indexOf('remember this')).toBeLessThan(text.indexOf('remembered answer'));
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
  });
});

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) return String(part.text);
        return JSON.stringify(part);
      })
      .join('');
  }
  return JSON.stringify(message.content);
}

describe('LocalAgentSession — shadow-git checkpoint wiring', () => {
  test('each turn arms the engine with a fresh turn id and the durable session id', async () => {
    const { rt, session } = setup('ok', undefined, { sessionId: 'chat-1' });
    const turns: Array<{ turnId: string; sessionId: string }> = [];
    rt.checkpoints = {
      beginTurn: (meta) => { turns.push(meta); },
      ensureCheckpoint: async () => null,
      list: async () => [],
      plan: async () => { throw new Error('unused'); },
      restore: async () => { throw new Error('unused'); },
      status: async () => ({ available: true }),
      workdirForPath: (p) => p,
    };
    await session.send('first');
    await session.send('second');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.sessionId).toBe('chat-1');
    expect(turns[1]!.sessionId).toBe('chat-1');
    expect(turns[0]!.turnId).not.toBe(turns[1]!.turnId);
  });

  test('the checkpoint surface degrades honestly when no engine is configured', async () => {
    const { rt, session } = setup();
    rt.checkpoints = undefined;
    expect(await session.listFileCheckpoints()).toEqual([]);
    expect(await session.checkpointStatus()).toEqual({
      available: false, reason: 'checkpoints are not configured for this session',
    });
    expect(session.restoreFileCheckpoint('/tmp', 'abcdef0')).rejects.toThrow('not configured');
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
    const starts = turnStarts(events);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.kind).toBe('programmatic');
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
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

  test('shell approval mode round-trips through agent_config', () => {
    const { session } = setup();
    expect(session.getShellApprovalMode()).toEqual({ mode: 'strict' });
    expect(session.setShellApprovalMode('allow_all')).toEqual({ ok: true, mode: 'allow_all' });
    expect(session.getShellApprovalMode()).toEqual({ mode: 'allow_all' });
    expect(session.setShellApprovalMode('deny_all')).toEqual({ ok: true, mode: 'deny_all' });
    expect(session.getShellApprovalMode()).toEqual({ mode: 'deny_all' });
  });

  test('setModel persists agent_config.model and drives the next turn model', async () => {
    const resolver: LocalModelResolver = {
      normalizeSpecSync: (spec) => spec?.trim() || 'local/a',
      resolveModel: (spec) => fakeModel(spec === 'local/b' ? 'from b' : 'from a'),
      listProviders: async () => [],
      listModels: async () => [],
    };
    const { session, events } = setupWithResolver(resolver);

    expect(session.getStoredModelSpec()).toEqual({ spec: null });
    expect(session.getEffectiveModelSpec()).toBe('local/a');

    await session.send('first');
    expect((events.find((e) => e.type === 'turn-end') as Extract<SessionEvent, { type: 'turn-end' }>).turn.assistantResponse).toBe('from a');

    expect(session.setModel('local/b')).toEqual({ ok: true, spec: 'local/b' });
    expect(session.getStoredModelSpec()).toEqual({ spec: 'local/b' });

    await session.send('second');
    const turns = events.filter((e): e is Extract<SessionEvent, { type: 'turn-end' }> => e.type === 'turn-end');
    expect(turns[1]!.turn.assistantResponse).toBe('from b');
  });

  test('broadcast fans out as a SessionEvent', () => {
    const { session, events } = setup();
    session.broadcast({ type: 'job_update', jobId: 'x' });
    const b = events.find((e) => e.type === 'broadcast') as Extract<SessionEvent, { type: 'broadcast' }>;
    expect(b.event.type).toBe('job_update');
  });

  test('publishEvent stores a hub event and wakes a programmatic turn', async () => {
    const { session, events } = setup('handled event');
    const result = await session.publishEvent({
      descriptor: {
        ingress: 'chat_ws',
        variant: 'chat',
        payload: { text: 'external wake' },
        operator_user_id: 'owner-1',
        session_id: 'local-test',
      },
      now: 123,
    });

    expect(result.admitted).toBe(true);
    await waitFor(() => events.some((e) => e.type === 'turn-start' && e.kind === 'programmatic'));

    const recent = session.listRecentEvents({ variant: 'chat', limit: 5 });
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(result.event_id);
    expect(recent[0]!.trust).toBe('owner');
    expect(recent[0]!.priority).toBe('urgent');

    const starts = turnStarts(events);
    expect(starts[0]!.kind).toBe('programmatic');
    expect(starts[0]!.text).toContain('[chat]');
    expect(session.pendingEvents()).toEqual([]);
  });

  test('one-shot timer triggers publish timer events and wake a programmatic turn', async () => {
    const { session, events } = setup('handled timer');
    const fireAt = Date.now() + 60_000;
    const created = session.createTimerTrigger({
      atMs: fireAt,
      label: 'follow-up',
      payload: { reason: 'test' },
      trust: 'owner',
    });

    expect(created.kind).toBe('timer_oneshot');
    expect(created.nextFireAt).toBe(fireAt);
    expect(session.listTriggers().triggers[0]!.next_fire_at).toBe(fireAt);

    const outcome = await session.fireDueTriggers(fireAt);
    expect(outcome.fired).toBe(1);
    await waitFor(() => events.some((e) => e.type === 'turn-start' && e.kind === 'programmatic'));

    const recent = session.listRecentEvents({ variant: 'timer', limit: 5 });
    expect(recent).toHaveLength(1);
    expect(recent[0]!.trust).toBe('owner');
    expect(recent[0]!.payload).toMatchObject({
      trigger_id: created.id,
      scheduled_fire_at: fireAt,
      label: 'follow-up',
      user_payload: { reason: 'test' },
    });

    const trigger = session.listTriggers().triggers.find((t) => t.id === created.id)!;
    expect(trigger.state).toBe('revoked');
    expect(trigger.next_fire_at).toBeNull();
    expect(trigger.last_fire_at).toBe(fireAt);
    expect(trigger.fire_count).toBe(1);
  });

  test('cron timer triggers reschedule after firing', async () => {
    const { session, events } = setup('handled cron');
    const created = session.createTimerTrigger({ cron: '*/5 * * * *', label: 'heartbeat' });
    expect(created.kind).toBe('timer_cron');
    expect(created.nextFireAt).toBeGreaterThan(Date.now());

    const outcome = await session.fireDueTriggers(created.nextFireAt!);
    expect(outcome.fired).toBe(1);
    await waitFor(() => events.some((e) => e.type === 'turn-start' && e.kind === 'programmatic'));

    const trigger = session.listTriggers().triggers.find((t) => t.id === created.id)!;
    expect(trigger.state).toBe('active');
    expect(trigger.last_fire_at).toBe(created.nextFireAt);
    expect(trigger.fire_count).toBe(1);
    expect(trigger.next_fire_at).toBeGreaterThan(created.nextFireAt!);
    session.cancelTrigger(created.id);
  });

  test('Node execute fallback exposes the local agent.schedule namespace', async () => {
    const { rt } = setup();
    let received: { atMs?: number; label?: string } | null = null;
    const executeTool = createNodeExecuteToolFactory({
      vfs: rt.storage.vfs,
      memory: rt.memory,
      extraProviders: [createLocalAgentSelfProvider({
        proposeCurriculumTasks: async () => [],
        listCurriculumTasks: async () => [],
        setCurriculumTaskStatus: async () => ({ ok: true }),
        createTimerTrigger: (opts) => {
          received = { atMs: opts.atMs, label: opts.label };
          return { id: 'trg-local', kind: opts.cron ? 'timer_cron' : 'timer_oneshot', nextFireAt: opts.atMs ?? 123 };
        },
        cancelTrigger: async () => ({ ok: true }),
        jobResult: async () => null,
        listBackgroundJobs: async () => [],
      })],
    })({ tools: {}, providers: [], loader: {} });

    const result = await (executeTool as { execute: (args: { code: string }) => Promise<unknown> }).execute({
      code: "return await agent.schedule({ atMs: Date.now() + 60000, label: 'local wake' });",
    });
    expect(result).toMatchObject({ result: { id: 'trg-local', kind: 'timer_oneshot' } });
    expect(received?.label).toBe('local wake');
    expect(received?.atMs).toBeGreaterThan(Date.now());
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

describe('LocalAgentSession — turn-outcome review (Hermes-style forked review)', () => {
  function setupWithEvolution(classifierJson: string) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    const rt = createCLIRuntime(db as never, { dbPath: `/tmp/proteus-test-${Math.floor(performance.now())}.db`, llm: DUMMY_LLM });
    // The classifier + reflection ride rt.llm.complete — stub it so the review
    // runs without a network LLM.
    (rt as { llm: { complete(p: string): Promise<string>; stream: unknown } }).llm = {
      stream: rt.llm.stream.bind(rt.llm),
      complete: async (prompt: string) =>
        prompt.includes('Classify what the follow-up reveals')
          ? classifierJson
          : 'verify the cluster name before rotating keys',
    };
    const events: SessionEvent[] = [];
    const session = new LocalAgentSession({
      rt, db, model: fakeModel('rotated the production keys'), onEvent: (e) => events.push(e),
    });
    return { db, rt, session, events };
  }

  test('the next user message grades the previous turn into the durable outcome ledger', async () => {
    const { db, session } = setupWithEvolution('{"outcome":"corrected","confidence":0.9,"evidence":"user re-asked"}');

    await session.send('please rotate the API keys for the staging cluster');
    await session.send('no — I said STAGING, you rotated production');

    await waitFor(() => (db.query(`SELECT count(*) AS c FROM turn_outcomes`).get() as { c: number }).c >= 1, 3000);
    const row = db.query(`SELECT * FROM turn_outcomes`).get() as {
      outcome: string; source: string; turn_id: string; session_id: string; followup: string;
    };
    expect(row.outcome).toBe('corrected');
    expect(row.source).toBe('classifier');
    expect(row.followup).toContain('STAGING');
    expect(row.session_id).toBe('default');
    // Tied to the FIRST turn's durable assistant message id.
    const firstAssistant = db.query(
      `SELECT id FROM messages WHERE role = 'assistant' ORDER BY created_at, rowid LIMIT 1`,
    ).get() as { id: string };
    expect(row.turn_id).toBe(firstAssistant.id);

    // The corrected outcome reflects a corroborated lesson into MEMORY.md.
    await waitFor(() => (db.query(`SELECT count(*) AS c FROM lessons WHERE status = 'corroborated'`).get() as { c: number }).c >= 1, 3000);
    await session.end();
  });

  test('trivial turns (greetings) skip classification entirely', async () => {
    const { db, session } = setupWithEvolution('{"outcome":"accepted","confidence":0.9,"evidence":"x"}');

    await session.send('hi');
    await session.send('thanks!');
    // Give any (wrongly) dispatched detached review a beat to land.
    await new Promise((r) => setTimeout(r, 50));
    expect((db.query(`SELECT count(*) AS c FROM turn_outcomes`).get() as { c: number }).c).toBe(0);
    await session.end();
  });

  test('end() reviews the still-pending turn as abandoned', async () => {
    const { db, session } = setupWithEvolution('unused');

    await session.send('please summarize the deployment runbook for me');
    await session.end();

    const row = db.query(`SELECT outcome, source FROM turn_outcomes`).get() as { outcome: string; source: string } | null;
    expect(row).toEqual({ outcome: 'abandoned', source: 'session_end' });
  });
});

describe('LocalAgentSession — AGENTS.md + session transcript recall', () => {
  test('injects the cwd AGENTS.md chain into the turn system prompt', async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'proteus-ls-agentsmd-'));
    try {
      const nested = join(root, 'app');
      mkdirSync(nested);
      writeFileSync(join(root, 'AGENTS.md'), 'Root: prefer bun.');
      writeFileSync(join(nested, 'AGENTS.md'), 'App: run lint before commit.');

      let system = '';
      const { session } = setup('ok', systemCapturingModel('ok', (s) => { system = s; }), { cwd: nested });
      await session.send('hello');

      expect(system).toContain('## Project instructions (AGENTS.md)');
      expect(system).toContain('Root: prefer bun.');
      expect(system).toContain('App: run lint before commit.');
      // Nearest renders last (it wins on conflict).
      expect(system.indexOf('Root: prefer bun.')).toBeLessThan(system.indexOf('App: run lint before commit.'));
      expect(system).toContain(`Working directory: ${nested}`);
      await session.end();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('omits the AGENTS.md block when no file exists up the tree', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { discoverAgentsMd } = await import('../src/agents-md.js');
    const root = mkdtempSync(join(tmpdir(), 'proteus-ls-noagents-'));
    try {
      // Ancestors of the tmpdir could theoretically carry an AGENTS.md on a
      // developer machine — only assert omission when the chain is truly empty.
      if (discoverAgentsMd(root).length > 0) return;
      let system = '';
      const { session } = setup('ok', systemCapturingModel('ok', (s) => { system = s; }), { cwd: root });
      await session.send('hello');
      expect(system.length).toBeGreaterThan(0);
      expect(system).not.toContain('Project instructions (AGENTS.md)');
      await session.end();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('persisted turns are searchable through the session-search seam', async () => {
    const { SessionSearchStore } = await import('@proteus/core');
    const { rt, session } = setup('the staging deploy used wrangler version three');
    await session.send('how did we deploy to staging?');

    // Same seam the memory tool's `sessions` action uses: rt.storage.sql.
    const store = new SessionSearchStore(rt.storage.sql);
    const hits = store.search('wrangler staging');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.sessionId).toBe('default');

    const view = store.scroll(hits[0]!.messageId, 2)!;
    expect(view.messages.some((m) => m.content.includes('how did we deploy'))).toBe(true);

    const sessions = store.browse();
    expect(sessions[0]!.sessionId).toBe('default');
    expect(sessions[0]!.preview).toContain('how did we deploy');
    await session.end();
  });
});

describe('LocalAgentSession.steer — mid-turn steering (Hermes steer-drain)', () => {
  /** Two-call model: call #1 streams a `fact` tool call, gated so the test can
   *  steer before the step boundary; call #2 answers in text. Captures the v2
   *  prompt of every doStream call so tests can assert what the model saw. */
  function toolThenAnswerModel(answer: string) {
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let calls = 0;
    const model = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doStream: async ({ prompt }: { prompt: Array<{ role: string; content: unknown }> }) => {
        prompts.push(prompt);
        calls += 1;
        if (calls === 1) {
          return {
            stream: new ReadableStream({
              async start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({
                  type: 'tool-call', toolCallId: 'call-1', toolName: 'fact',
                  input: JSON.stringify({ action: 'recall', key: 'probe' }),
                });
                await gate;
                controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
                controller.close();
              },
            }),
            response: { headers: {} },
          };
        }
        return {
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
        };
      },
    } as unknown as LanguageModel;
    return { model, prompts, release };
  }

  /** Single-step model that streams one delta, then holds the turn open until
   *  release() — a deterministic window for mid-turn steering. */
  function gatedTextModel(answer: string) {
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
            abortSignal?.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
            await gate;
            if (abortSignal?.aborted) return;
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      }),
    } as unknown as LanguageModel;
    return { model, release };
  }

  const userTexts = (prompt: Array<{ role: string; content: unknown }>) =>
    prompt.filter((m) => m.role === 'user').map((m) => {
      if (typeof m.content === 'string') return m.content;
      return (m.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
    });

  test('two rapid steers drain into ONE merged user message at the step boundary, after the tool results', async () => {
    const { model, prompts, release } = toolThenAnswerModel('done, checked both');
    const { db, session, events } = setup('unused', model);

    const turn = session.send('main question');
    await waitFor(() => events.some((e) => e.type === 'tool-call'));
    expect(session.steer('also check X')).toBe(true);
    expect(session.steer('and Y')).toBe(true);
    release();
    await turn;

    // The second model call (post-tool step) sees exactly one injected user
    // message, merged from both steers, AFTER the tool-result message.
    expect(prompts.length).toBe(2);
    const second = prompts[1]!;
    const injected = userTexts(second).filter((text) => text.includes('also check X'));
    expect(injected).toEqual(['also check X\n\nand Y']);
    const roles = second.map((m) => m.role);
    expect(roles.indexOf('tool')).toBeGreaterThan(-1);
    expect(roles.lastIndexOf('user')).toBeGreaterThan(roles.lastIndexOf('tool'));

    // One turn only — steering never spawned a second turn.
    expect(turnStarts(events)).toHaveLength(1);

    // Durable conversation keeps ONE row per steer (verbatim, as surfaces
    // recorded them) so the walk-back fork pivot can match each individually —
    // only the model-facing injection is merged.
    const rows = db.query(`SELECT role, content FROM messages WHERE session_id = 'default' ORDER BY created_at, rowid`)
      .all() as Array<{ role: string; content: string }>;
    expect(rows.map((r) => r.role)).toEqual(['user', 'user', 'user', 'assistant']);
    expect(rows[1]!.content).toBe('also check X');
    expect(rows[2]!.content).toBe('and Y');
    await session.end();
  });

  test('a steer with no remaining step boundary runs as the immediate next user turn', async () => {
    const { model, release } = gatedTextModel('first answer');
    const { db, session, events } = setup('unused', model);

    const turn = session.send('first question');
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    expect(session.steer('follow up please')).toBe(true);
    release();
    await turn;
    await waitFor(() => events.filter((e) => e.type === 'turn-end').length >= 2);

    const starts = turnStarts(events);
    expect(starts).toHaveLength(2);
    expect(starts[1]!).toMatchObject({ kind: 'user', text: 'follow up please' });

    const rows = db.query(`SELECT role, content FROM messages WHERE session_id = 'default' ORDER BY created_at, rowid`)
      .all() as Array<{ role: string; content: string }>;
    expect(rows.map((r) => `${r.role}:${r.content}`)).toContain('user:follow up please');
    await session.end();
  });

  test('steer with no active turn returns false', () => {
    const { session } = setup('idle');
    expect(session.steer('nothing running')).toBe(false);
  });

  test('interrupt drops pending steers — no surprise follow-up turn — and returns them to the caller', async () => {
    const { model } = gatedTextModel('never finishes');
    const { session, events } = setup('unused', model);

    const turn = session.send('long task');
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    expect(session.steer('change of plans')).toBe(true);
    // Surfaces already rendered the steer as sent — the dropped text comes
    // back so they can restore it to the composer instead of losing it.
    expect(session.interrupt()).toEqual(['change of plans']);
    await turn;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(turnStarts(events)).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    await session.end();
  });

  test('a mid-stream failure keeps drained steers in the live context for the next turn', async () => {
    // Call #1 streams a tool call (steer drains at its step boundary), then
    // call #2 — which HAS seen the steer — dies mid-stream.
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    let calls = 0;
    const model = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doStream: async ({ prompt }: { prompt: Array<{ role: string; content: unknown }> }) => {
        prompts.push(prompt);
        calls += 1;
        if (calls === 1) {
          return {
            stream: new ReadableStream({
              async start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({
                  type: 'tool-call', toolCallId: 'call-1', toolName: 'fact',
                  input: JSON.stringify({ action: 'recall', key: 'probe' }),
                });
                await gate;
                controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
                controller.close();
              },
            }),
            response: { headers: {} },
          };
        }
        if (calls === 2) {
          return {
            stream: new ReadableStream({
              start(controller) { controller.error(new Error('provider exploded')); },
            }),
            response: { headers: {} },
          };
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'recovered' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
    } as unknown as LanguageModel;

    const { session, events } = setup('unused', model);
    const turn = session.send('main question');
    await waitFor(() => events.some((e) => e.type === 'tool-call'));
    expect(session.steer('do it differently')).toBe(true);
    release();
    await turn;
    expect(events.some((e) => e.type === 'error')).toBe(true);

    // The NEXT turn's model context must still carry the steer the model
    // already saw (and the surfaces already recorded).
    await session.send('follow-up');
    const last = prompts.at(-1)!;
    const texts = userTexts(last);
    expect(texts).toContain('do it differently');
    await session.end();
  });
});

describe('LocalAgentSession — Evolution Changelog parity', () => {
  test('digest assembles from the real local ledgers; viewing zeroes unseen', async () => {
    const { rt, session } = setup('quiet');
    rt.craftStore.create({
      name: 'local_helper', description: 'a locally crafted helper',
      code: 'async () => 1', scope: 'local',
    });
    rt.storage.sql`INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
                   VALUES ('editor', '"helix"', 0.8, 'sleep_time_compute', ${Date.now()})`;

    const view = session.getEvolutionChangelog();
    const summaries = view.entries.map((e) => e.summary);
    expect(summaries.some((s) => s.includes('Crafted tool local_helper'))).toBe(true);
    expect(summaries.some((s) => s.includes('Learned fact editor = helix'))).toBe(true);
    expect(view.unseenCount).toBe(2);

    session.markChangelogSeen();
    expect(session.getEvolutionChangelog().unseenCount).toBe(0);
    await session.end();
  });

  test('revert by id retires the crafted tool and forgets the fact for real', async () => {
    const { rt, session } = setup('quiet');
    rt.craftStore.create({
      name: 'doomed_tool', description: 'soon retired', code: 'async () => 2', scope: 'local',
    });
    rt.storage.sql`INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
                   VALUES ('stale', '"value"', 1.0, NULL, ${Date.now()})`;

    const view = session.getEvolutionChangelog();
    const tool = view.entries.find((e) => e.kind === 'tool')!;
    const fact = view.entries.find((e) => e.kind === 'fact')!;

    expect((await session.revertChangelogEntry(tool.id)).ok).toBe(true);
    expect(rt.craftStore.get('doomed_tool')).toBeFalsy();
    expect((await session.revertChangelogEntry(fact.id)).ok).toBe(true);
    expect(rt.storage.sql`SELECT * FROM agent_facts WHERE key = 'stale'`).toHaveLength(0);

    // Both rows are gone from the next digest, and re-reverting refuses.
    expect(session.getEvolutionChangelog().entries.filter((e) => e.revert)).toHaveLength(0);
    const again = await session.revertChangelogEntry(tool.id);
    expect(again.ok).toBe(false);
    await session.end();
  });
});

describe('LocalAgentSession — Alternate Takes parity', () => {
  function seedTakes(rt: ReturnType<typeof createCLIRuntime>) {
    initSearchTables(rt.storage.execRaw);
    initAlternateTakesTable(rt.storage.execRaw);
    rt.storage.sql`INSERT INTO search_nodes (id, task, action, observation, value, visits, depth, status)
        VALUES ('win', 'pick a strategy', 'A', 'go with approach A', 0.9, 3, 1, 'open')`;
    rt.storage.sql`INSERT INTO search_nodes (id, task, action, observation, value, visits, depth, status)
        VALUES ('alt', 'pick a strategy', 'B', 'go with approach B', 0.86, 2, 1, 'open')`;
    // In production the capture happens MID-turn (inside think-mcts), so its
    // timestamp falls inside the claiming turn's window. This seed runs
    // before send() — stamp it just ahead so the scoped claim sees it as a
    // mid-turn capture rather than a stale leftover.
    captureAlternateTakes(rt.storage.sql, { task: 'pick a strategy', winnerId: 'win', epsilon: 0.1, now: Date.now() + 1_000 });
    // Mirror converge()'s close: winner terminal, the near-tied rival pruned.
    rt.storage.sql`UPDATE search_nodes SET status = 'terminal' WHERE id = 'win'`;
    rt.storage.sql`UPDATE search_nodes SET status = 'pruned' WHERE id = 'alt'`;
  }

  test('takes captured mid-turn are claimed for the turn at turn end', async () => {
    const { session, rt } = setup('answered with A');
    seedTakes(rt);
    await session.send('solve it');
    const turnId = rt.storage.sql<{ id: string }>`
      SELECT id FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1`[0]!.id;
    expect(session.latestAlternateTakes()).toMatchObject({ turnId, sessionId: 'default', chosenNodeId: null });
    await session.end();
  });

  test('picking a sibling writes the take_pick ledger row, re-points, and queues the continuation', async () => {
    const { session, rt, events } = setup('answered with A');
    seedTakes(rt);
    await session.send('solve it');
    const set = session.latestAlternateTakes()!;

    const result = await session.pickAlternateTake(set.id, 'alt');
    expect(result).toMatchObject({ outcome: 'corrected', changedAnswer: true, continuationQueued: true });

    const row = rt.storage.sql<{ outcome: string; source: string; followup: string | null; turn_id: string }>`
      SELECT outcome, source, followup, turn_id FROM turn_outcomes`[0]!;
    expect(row).toMatchObject({ outcome: 'corrected', source: 'take_pick', followup: 'go with approach B', turn_id: set.turnId });
    expect(rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'alt'`[0]!.status).toBe('terminal');
    expect(rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'win'`[0]!.status).toBe('pruned');

    // The gentle continuation runs as a programmatic turn with the chosen take.
    await waitFor(() => turnStarts(events).some((s) => s.kind === 'programmatic' && s.event === 'take_pick'));
    const continuation = turnStarts(events).find((s) => s.event === 'take_pick')!;
    expect(continuation.text).toContain('go with approach B');
    await waitFor(() => events.filter((e) => e.type === 'turn-end').length === 2);
    await session.end();
  });

  test('confirming the answered winner records acceptance and queues nothing', async () => {
    const { session, rt, events } = setup('answered with A');
    seedTakes(rt);
    await session.send('solve it');
    const set = session.latestAlternateTakes()!;

    const result = await session.pickAlternateTake(set.id, 'win');
    expect(result).toMatchObject({ outcome: 'accepted', changedAnswer: false, continuationQueued: false });
    expect(rt.storage.sql<{ source: string }>`SELECT source FROM turn_outcomes`[0]!.source).toBe('take_pick');
    expect(turnStarts(events).every((s) => s.kind === 'user')).toBe(true);
    await session.end();
  });
});

describe('LocalAgentSession.branch — Steer-as-Branch (mid-turn parallel redirect)', () => {
  /** Dual-path model: doStream serves the LIVE turn (one delta, then holds the
   *  turn open until release() — the branching window); doGenerate serves the
   *  branch HEAD's inference (createCLIHeadRuntime drives generateText). */
  function branchableModel(liveAnswer: string, branchAnswer: () => string) {
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const streamPrompts: Array<Array<{ role: string; content: unknown }>> = [];
    const model = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doStream: async ({ prompt, abortSignal }: { prompt: Array<{ role: string; content: unknown }>; abortSignal?: AbortSignal }) => {
        streamPrompts.push(prompt);
        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: liveAnswer });
              abortSignal?.addEventListener('abort', () => {
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              }, { once: true });
              await gate;
              if (abortSignal?.aborted) return;
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
      doGenerate: async () => ({
        content: [{ type: 'text', text: branchAnswer() }],
        finishReason: 'stop',
        usage,
        warnings: [],
      }),
    } as unknown as LanguageModel;
    return { model, release, streamPrompts };
  }

  type BranchStatus = { type: 'branch_status'; status: string; branchId: string; task: string; message?: string; takeSetId?: string; turnId?: string };
  const branchEvents = (events: SessionEvent[]): BranchStatus[] =>
    events
      .filter((e): e is Extract<SessionEvent, { type: 'broadcast' }> => e.type === 'broadcast')
      .map((e) => e.event)
      .filter((e): e is BranchStatus => e.type === 'branch_status');

  test('branch while running settles into a claimed two-candidate takes set; the live turn is never touched', async () => {
    const { model, release, streamPrompts } = branchableModel('the live answer', () => 'the branch answer');
    const { db, session, events } = setup('unused', model);

    const turn = session.send('original question');
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    expect(session.branch('what about the other approach?')).toBe(true);
    expect(branchEvents(events)).toMatchObject([{ status: 'running', task: 'what about the other approach?' }]);

    release();
    await turn;
    await waitFor(() => branchEvents(events).some((e) => e.status === 'settled'), 5000);

    // The live turn ran untouched: one turn, the full answer, no injections.
    expect(turnStarts(events)).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const turnEnd = events.find((e) => e.type === 'turn-end') as Extract<SessionEvent, { type: 'turn-end' }>;
    expect(turnEnd.turn.assistantResponse).toBe('the live answer');
    expect(streamPrompts).toHaveLength(1);

    // The settled pair: A = live answer (winner), B = branch answer, claimed
    // against the live turn's assistant message — the ONE takes pipeline.
    const set = session.latestAlternateTakes()!;
    expect(set.source).toBe('branch');
    expect(set.candidates.map((c) => c.text)).toEqual(['the live answer', 'the branch answer']);
    expect(set.candidates.map((c) => c.origin)).toEqual(['live', 'branch']);
    expect(set.winnerNodeId).toBe(set.candidates[0]!.nodeId);
    const assistantId = (db.query(`SELECT id FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    expect(set.turnId).toBe(assistantId);
    const settled = branchEvents(events).find((e) => e.status === 'settled')!;
    expect(settled).toMatchObject({ takeSetId: set.id, turnId: assistantId });
    await session.end();
  });

  test('picking the branch records corrected + queues the continuation turn', async () => {
    const { model, release } = branchableModel('the live answer', () => 'the branch answer');
    const { rt, session, events } = setup('unused', model);

    const turn = session.send('original question');
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    session.branch('try it the other way');
    release();
    await turn;
    await waitFor(() => branchEvents(events).some((e) => e.status === 'settled'), 5000);

    const set = session.latestAlternateTakes()!;
    const branchCandidate = set.candidates.find((c) => c.origin === 'branch')!;
    const result = await session.pickAlternateTake(set.id, branchCandidate.nodeId);
    expect(result).toMatchObject({ outcome: 'corrected', changedAnswer: true, continuationQueued: true });

    const ledger = rt.storage.sql<{ outcome: string; source: string; followup: string | null }>`
      SELECT outcome, source, followup FROM turn_outcomes`[0]!;
    expect(ledger).toMatchObject({ outcome: 'corrected', source: 'take_pick', followup: 'the branch answer' });

    await waitFor(() => turnStarts(events).some((s) => s.kind === 'programmatic' && s.event === 'take_pick'), 5000);
    expect(turnStarts(events).find((s) => s.event === 'take_pick')!.text).toContain('the branch answer');
    await waitFor(() => events.filter((e) => e.type === 'turn-end').length === 2, 5000);
    await session.end();
  });

  test('a failing branch head yields NO takes set and an honest error broadcast', async () => {
    const { model, release } = branchableModel('the live answer', () => { throw new Error('head model exploded'); });
    const { session, events } = setup('unused', model);

    const turn = session.send('original question');
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    expect(session.branch('redirect')).toBe(true);
    release();
    await turn;
    await waitFor(() => branchEvents(events).some((e) => e.status === 'error'), 5000);

    expect(branchEvents(events).find((e) => e.status === 'error')!.message).toContain('head model exploded');
    expect(session.latestAlternateTakes()).toBeNull();
    // The live turn still completed normally.
    const turnEnd = events.find((e) => e.type === 'turn-end') as Extract<SessionEvent, { type: 'turn-end' }>;
    expect(turnEnd.turn.assistantResponse).toBe('the live answer');
    await session.end();
  });

  test('an interrupted live turn discards the branch — no takes set', async () => {
    let releaseBranch!: () => void;
    const branchGate = new Promise<void>((resolve) => { releaseBranch = resolve; });
    const { model } = branchableModel('never finishes', () => 'unused');
    (model as unknown as { doGenerate: () => Promise<unknown> }).doGenerate = async () => {
      await branchGate;
      return {
        content: [{ type: 'text', text: 'late branch answer' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    };
    const { session, events } = setup('unused', model);

    const turn = session.send('long task');
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    expect(session.branch('redirect')).toBe(true);
    session.interrupt();
    await turn;
    await waitFor(() => branchEvents(events).some((e) => e.status === 'error'), 5000);
    releaseBranch();

    expect(branchEvents(events).find((e) => e.status === 'error')!.message).toContain('did not complete');
    expect(session.latestAlternateTakes()).toBeNull();
    await session.end();
  });

  test('branch with no active turn returns false', () => {
    const { session } = setup('idle');
    expect(session.branch('nothing running')).toBe(false);
    expect(session.branch('   ')).toBe(false);
  });
});

describe('LocalAgentSession — signed-in cloud proxy turn (zero BYO keys)', () => {
  const TOKEN = 'ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz';

  /** OpenAI-compatible SSE stream the worker proxy passes through untouched. */
  function sseCompletion(model: string, deltas: string[]): Response {
    const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model,
        choices: [{ index: 0, ...choice }], ...extra,
      })}\n\n`;
    const body = [
      chunk({ delta: { role: 'assistant', content: deltas[0] }, finish_reason: null }),
      ...deltas.slice(1).map((delta) => chunk({ delta: { content: delta }, finish_reason: null })),
      chunk({ delta: {}, finish_reason: 'stop' }, { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }),
      'data: [DONE]\n\n',
    ].join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }

  test('a user turn streams through /api/user/ai/v1 with the CLI bearer + affinity pin', async () => {
    const completions: Array<{ auth: string | null; affinity: string | null; model: unknown; stream: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/api/cli/models') {
          return Response.json([{
            spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'Kimi K2.6', provider: 'workers-ai',
            capabilities: ['tools', 'streaming'], contextWindow: 262144,
          }]);
        }
        if (path === '/api/user/ai/v1/chat/completions') {
          const body = await request.json() as { model?: unknown; stream?: unknown };
          completions.push({
            auth: request.headers.get('authorization'),
            affinity: request.headers.get('x-session-affinity'),
            model: body.model,
            stream: body.stream,
          });
          return sseCompletion(String(body.model), ['local ', 'cloud turn']);
        }
        return new Response(`unexpected: ${path}`, { status: 500 });
      },
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const resolver = createLocalModelResolver({
        // The llm config cli/config.ts derives for a signed-in user with no BYO keys.
        llm: {
          name: 'workers-ai',
          baseURL: cloudProxyBaseURL(origin),
          headers: { Authorization: `Bearer ${TOKEN}` },
          model: '@cf/moonshotai/kimi-k2.6',
        },
        credentials: {},
        cloud: { origin, token: TOKEN, sessionAffinity: 'proteus-jarvis' },
      });
      const { db, session, events } = setupWithResolver(resolver);
      expect(session.getEffectiveModelSpec()).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);

      await session.send('hi from the laptop');

      const streamed = events.filter((e) => e.type === 'text-delta').map((e) => (e as { delta: string }).delta).join('');
      expect(streamed).toBe('local cloud turn');
      const turnEnd = events.find((e) => e.type === 'turn-end') as Extract<SessionEvent, { type: 'turn-end' }>;
      expect(turnEnd.turn.assistantResponse).toBe('local cloud turn');
      expect(turnEnd.turn.hadError).toBe(false);
      const rows = db.query(`SELECT role FROM messages ORDER BY created_at`).all() as Array<{ role: string }>;
      expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);

      expect(completions).toEqual([{
        auth: `Bearer ${TOKEN}`,
        affinity: 'proteus-jarvis',
        model: '@cf/moonshotai/kimi-k2.6',
        stream: true,
      }]);

      // /model parity at the session surface: the worker menu's metadata flows.
      const models = await session.listAvailableModels();
      const kimi = models.find((m) => m.provider === 'workers-ai' && m.id === '@cf/moonshotai/kimi-k2.6');
      expect(kimi?.contextWindow).toBe(262144);
    } finally {
      server.stop(true);
    }
  });
});
