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
import {
  DEFAULT_WORKERS_AI_MODEL_SPEC, FORK_STRATEGY_ID, createAgentsCodemodeProvider, createStrategyRegistry,
  initSearchTables, initAlternateTakesTable, captureAlternateTakes, MAX_CONCURRENT_DETACHED_JOBS,
  type AgentsToolDeps, type StrategyContext,
} from '@proteus/core';
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
 *  events + a done. doGenerate answers the non-streaming callers (the think
 *  strategies) with the same text. */
function fakeModel(answer: string): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: answer }],
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

/** A model whose non-streaming call never resolves — the test's stand-in for a
 *  detached `run` that started a server: the work is genuinely alive, and it is
 *  never going to settle. */
function hangingModel(): LanguageModel {
  const base = fakeModel('unused') as unknown as Record<string, unknown>;
  return {
    ...base,
    doGenerate: () => new Promise<never>(() => { /* never settles */ }),
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

/** A model that calls execute_tools once with the given code, then answers. */
function executeToolsModel(code: string): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let step = 0;
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async () => {
      step += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (step === 1) {
              controller.enqueue({
                type: 'tool-call', toolCallId: 'call-1', toolName: 'execute_tools',
                input: JSON.stringify({ code }),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            }
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  } as unknown as LanguageModel;
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

function jobColumn(db: Database, id: string, column: 'status' | 'error' | 'result'): string {
  const row = db.query(`SELECT ${column} v FROM background_jobs WHERE id=?`).get(id) as { v: string | null } | null;
  return row?.v ?? '';
}
const jobStatus = (db: Database, id: string) => jobColumn(db, id, 'status');
const jobError = (db: Database, id: string) => jobColumn(db, id, 'error');
const jobResult = (db: Database, id: string) => jobColumn(db, id, 'result');

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

  test('a post-stream persistence failure ends the turn and does not stall the queue', async () => {
    const { db, session, events } = setup('streamed answer');
    db.exec(`CREATE TRIGGER fail_first_turn_persist
      BEFORE INSERT ON messages
      WHEN NEW.role = 'assistant'
        AND EXISTS (SELECT 1 FROM messages WHERE id = NEW.parent_id AND content = 'first')
      BEGIN
        SELECT RAISE(FAIL, 'forced persist failure');
      END`);

    const first = session.send('first');
    const second = session.send('second');

    await waitFor(() => turnStarts(events).length === 2);
    await Promise.all([first, second]);

    const errors = events.filter((event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error');
    const turns = events.filter((event): event is Extract<SessionEvent, { type: 'turn-end' }> => event.type === 'turn-end');
    expect(errors.some((event) => event.message.includes('forced persist failure'))).toBe(true);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turn).toMatchObject({
      userMessage: 'first',
      assistantResponse: 'streamed answer',
      hadError: true,
    });
    expect(turns[1]!.turn.userMessage).toBe('second');
    expect(turns[1]!.turn.hadError).toBe(false);
    const assistants = db.query(`SELECT content FROM messages WHERE role = 'assistant'`).all() as Array<{ content: string }>;
    expect(assistants).toEqual([{ content: 'streamed answer' }]);
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

  test('a PDF the model cannot accept is sanitized to a VFS reference before the model sees it', async () => {
    // The production P0: Workers AI's chat schema rejects type:"file" parts,
    // so an attached PDF 400s every turn forever. The sanitizer replaces the
    // part with a content-addressed VFS path the agent reads back with its
    // file tools — and it must run on EVERY turn's assembly, healing the
    // already-poisoned durable history.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 8, 7]);
    const captures: ModelMessage[][] = [];
    const { rt, session } = setup('reading it', historyCapturingModel('reading it', (messages) => { captures.push(messages); }));

    await session.send({
      text: 'here is my resume',
      files: [{
        filename: 'resume.pdf',
        mediaType: 'application/pdf',
        url: `data:application/pdf;base64,${btoa(String.fromCharCode(...pdfBytes))}`,
      }],
    });

    // No file part survives to the model request.
    const observed = captures[0]!;
    const fileParts = observed.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<{ type?: string }>).filter((p) => p?.type === 'file') : []);
    expect(fileParts).toHaveLength(0);

    // The replacement text carries the content-addressed path…
    const referenced = observed.find((m) =>
      m.role === 'user' && JSON.stringify(m.content).includes('/local/attachments/'));
    expect(referenced).toBeDefined();
    const referencedJson = JSON.stringify(referenced!.content);
    expect(referencedJson).toContain('resume.pdf');
    const path = /saved to (\S+) — read/.exec(referencedJson)?.[1];
    expect(path).toStartWith('/local/attachments/');

    // …and the exact payload bytes are readable back through the agent's VFS.
    const stored = await rt.storage.vfs.readFile(path!);
    expect(stored instanceof Uint8Array ? Array.from(stored) : stored).toEqual(Array.from(pdfBytes));

    // Second turn: the (unchanged) in-memory history re-sanitizes to the SAME
    // reference — byte-stable, so the prompt-cache prefix holds.
    await session.send('continue');
    const again = captures[1]!.find((m) =>
      m.role === 'user' && JSON.stringify(m.content).includes('/local/attachments/'));
    expect(again).toBeDefined();
    expect(JSON.stringify(again!.content)).toBe(referencedJson);
  });

  test('facts ride the dynamic-context block, never the system prompt', async () => {
    // Cache-prefix stability: the system prompt must stay byte-stable across
    // turns, so live state (the facts world model, executor status) rides the
    // dynamic ledger's frozen blocks in the messages array instead.
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
    const turn1Block = observed.map(messageText).find(isDynamicBlock);
    expect(turn1Block).toBeDefined();

    // Seed a fact, then run another turn — the state fingerprint changed, so
    // a NEW block appends at the tail while turn 1's block stays frozen.
    db.exec(`INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
             VALUES ('test.marker', '"FACT-MARKER"', 1.0, 'tool', ${Date.now()})`);
    await session.send('and now?');

    expect(system).not.toContain('FACT-MARKER');
    const texts = observed.map(messageText);
    const tail = texts.at(-1)!;
    expect(isDynamicBlock(tail)).toBe(true);
    expect(tail).toContain('World model');
    expect(tail).toContain('FACT-MARKER');
    expect(texts).toContain(turn1Block!); // byte-identical, still in place

    // Dynamic blocks are step state — never persisted.
    const rows = db.query(`SELECT content FROM messages`).all() as Array<{ content: string }>;
    expect(rows.some((r) => r.content.includes('<dynamic_context'))).toBe(false);
  });

  test('the MEMORY.md tail (newest lessons) rides the dynamic block, never the system prefix', async () => {
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
    const block = observed.map(messageText).find(isDynamicBlock)!;
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

    // The dynamic-context blocks (executor status etc.) are woven in per step
    // and never persisted — filter them for the order checks.
    const text = observed.map(messageText).filter((t) => !isDynamicBlock(t));
    expect(text).toContain('remember this');
    expect(text).toContain('remembered answer');
    expect(text.at(-1)).toBe('what did I say?');
    expect(text.indexOf('remember this')).toBeLessThan(text.indexOf('remembered answer'));
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
  });
});

describe('LocalAgentSession — tool success/error + cache telemetry fidelity', () => {
  /** step 1: calls the `memory` save tool (which will throw via a stubbed
   *  runtime), finishing with the caller-supplied usage; step 2: answers text. */
  function memoryThenTextModel(firstFinishUsage: Record<string, number>, firstProviderMetadata?: Record<string, unknown>) {
    let step = 0;
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    return {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doStream: async () => {
        step += 1;
        if (step === 1) {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({
                  type: 'tool-call', toolCallId: 'call-1', toolName: 'memory',
                  input: JSON.stringify({ action: 'save', content: 'note' }),
                });
                controller.enqueue({
                  type: 'finish', finishReason: 'tool-calls', usage: firstFinishUsage,
                  ...(firstProviderMetadata ? { providerMetadata: firstProviderMetadata } : {}),
                });
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
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
    } as unknown as LanguageModel;
  }

  test('a failing tool flags hadError on the turn and still surfaces a tool-result', async () => {
    const model = memoryThenTextModel({ inputTokens: 9, outputTokens: 2, totalTokens: 11 });
    const { rt, session, events } = setup('unused', model);
    // Make the memory-save path throw deterministically at execution time.
    rt.memory.append = async () => { throw new Error('disk full'); };

    await session.send('save a note please');

    const turnEnd = events.find((e) => e.type === 'turn-end') as Extract<SessionEvent, { type: 'turn-end' }>;
    expect(turnEnd.turn.hadError).toBe(true);
    // The error rode the tool-result path (my case), not the stream-abort catch.
    const toolResult = events.find((e) => e.type === 'tool-result') as Extract<SessionEvent, { type: 'tool-result' }>;
    expect(toolResult).toBeDefined();
    expect(toolResult.result).toContain('disk full');
    await session.end();
  });

  test('cached-prefix tokens flow from the step into the turn accumulator', async () => {
    const model = memoryThenTextModel(
      { inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 12 },
      { anthropic: { cacheReadInputTokens: 3 } },
    );
    const { rt, session } = setup('unused', model);
    rt.memory.append = async () => { throw new Error('irrelevant'); };

    await session.send('save it');

    // The accumulator is the evolution/telemetry signal — 12 (usage) + 3
    // (Anthropic providerMetadata) combine into usage.cached (was 0 before the
    // ChatEvent seam carried cached tokens).
    const acc = (session as unknown as { orch: { acc: { usage: { cached: number } } } }).orch.acc;
    expect(acc.usage.cached).toBe(15);
    await session.end();
  });
});

/** The wire shape of one dynamic-context block (core volatile-context.ts). */
function isDynamicBlock(text: string): boolean {
  return /^<dynamic_context fingerprint="[0-9a-f]{16}">\n/.test(text)
    && text.endsWith('\n</dynamic_context>');
}

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

describe('LocalAgentSession — overflow recovery (context_length turn failures)', () => {
  /** doStream throws a context-window error for the first `failures` calls,
   *  then streams normally — the provider-overflow shape end to end. */
  function overflowingModel(failures: number, answer = 'recovered'): LanguageModel {
    let calls = 0;
    const base = fakeModel(answer) as unknown as Record<string, unknown> & { doStream: (o: unknown) => unknown };
    const inner = base.doStream.bind(base);
    return {
      ...base,
      doStream: async (options: unknown) => {
        calls += 1;
        if (calls <= failures) throw new Error('context_length_exceeded: prompt is too long');
        return inner(options);
      },
    } as unknown as LanguageModel;
  }

  test('a context_length failure arms force-compaction and enqueues ONE retry that resumes the work', async () => {
    const { db, session, events } = setup('unused', overflowingModel(1));
    await session.send('build the thing');
    await waitFor(() => events.filter((e) => e.type === 'turn-end').length === 2);

    // Turn 1 errored, the ONE retry ran as a programmatic overflow_retry turn.
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const starts = turnStarts(events);
    expect(starts.map((s) => s.kind)).toEqual(['user', 'programmatic']);
    expect(starts[1]!.event).toBe('overflow_retry');
    expect(starts[1]!.text).toContain('compacted');
    // The retry turn completed…
    const streamed = events.filter((e) => e.type === 'text-delta').map((e) => (e as { delta: string }).delta).join('');
    expect(streamed).toContain('recovered');
    // …and CONSUMED the armed flag: no compaction_state row stays armed.
    const armed = db.prepare(`SELECT COUNT(*) as c FROM compaction_state WHERE force_compaction = 1`).get() as { c: number };
    expect(armed.c).toBe(0);
  });

  test('a retry turn that fails again never enqueues a third turn (never loops)', async () => {
    const { session, events } = setup('unused', overflowingModel(Number.POSITIVE_INFINITY));
    await session.send('build the thing');
    await waitFor(() => events.filter((e) => e.type === 'turn-end').length === 2);
    // Give any (wrong) further enqueue a chance to surface, then assert quiet.
    await new Promise((r) => setTimeout(r, 25));
    expect(turnStarts(events)).toHaveLength(2);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(2);
  });

  test('a rate-limit failure never force-compacts or retries', async () => {
    let calls = 0;
    const base = fakeModel('n/a') as unknown as Record<string, unknown> & { doStream: (o: unknown) => unknown };
    const model = {
      ...base,
      doStream: async () => {
        calls += 1;
        throw new Error('Failed after 3 attempts. Last error: Too Many Requests');
      },
    } as unknown as LanguageModel;
    const { db, session, events } = setup('unused', model);
    await session.send('build the thing');
    await new Promise((r) => setTimeout(r, 25));
    expect(turnStarts(events)).toHaveLength(1);
    expect(calls).toBe(1);
    const armed = db.prepare(`SELECT COUNT(*) as c FROM compaction_state WHERE force_compaction = 1`).get() as { c: number };
    expect(armed.c).toBe(0);
  });
});

describe('LocalAgentSession — context window', () => {
  /** Streams normally but reports a large provider-priced prompt, so the next
   *  turn's compaction has a real measured trigger to budget against. */
  function pricedModel(inputTokens: number): LanguageModel {
    const base = fakeModel('ok') as unknown as Record<string, unknown> & { doStream: (o: unknown) => Promise<{ stream: ReadableStream }> };
    const inner = base.doStream.bind(base);
    return {
      ...base,
      doStream: async (options: unknown) => {
        const { stream, ...rest } = await inner(options);
        return {
          ...rest,
          stream: stream.pipeThrough(new TransformStream({
            transform(part: { type: string; usage?: unknown }, controller) {
              controller.enqueue(part.type === 'finish'
                ? { ...part, usage: { inputTokens, outputTokens: 7, totalTokens: inputTokens + 7 } }
                : part);
            },
          })),
        };
      },
    } as unknown as LanguageModel;
  }

  /** A spec the static context-window table does not know, so the fallback is
   *  its 128k default and any other number can only have come from the catalog. */
  function resolverReporting(contextWindow: number | undefined, model: LanguageModel): LocalModelResolver {
    return {
      normalizeSpecSync: (spec) => spec?.trim() || 'openai-compatible/house-model',
      resolveModel: () => model,
      listProviders: async () => [],
      listModels: async () => [],
      modelInfo: async () => ({
        id: 'house-model', label: 'house', capabilities: ['tools', 'streaming'],
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      }),
    };
  }

  const compacted = (db: Database) =>
    (db.prepare(`SELECT COUNT(*) c FROM compaction_state WHERE plan_json IS NOT NULL`).get() as { c: number }).c > 0;

  async function converse(session: LocalAgentSession): Promise<void> {
    for (const turn of ['one', 'two', 'three', 'four']) await session.send(turn);
  }

  test("a 40k-token prompt compacts against the catalog's 8k window, not the 128k fallback", async () => {
    const tight = setupWithResolver(resolverReporting(8_000, pricedModel(40_000)));
    await converse(tight.session);
    expect(compacted(tight.db)).toBe(true);

    // Same traffic, same model, catalog silent on the window: 40k of the static
    // table's 128k default is nowhere near the trigger, so nothing compacts.
    const loose = setupWithResolver(resolverReporting(undefined, pricedModel(40_000)));
    await converse(loose.session);
    expect(compacted(loose.db)).toBe(false);
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
      modelInfo: async () => null,
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

  test('reasoning effort persists and merges with prompt-cache options on the main chat turn', async () => {
    let providerOptions: Record<string, Record<string, unknown>> | undefined;
    const model = fakeModel('reasoned') as unknown as Record<string, unknown> & {
      doStream: (options: unknown) => unknown;
    };
    const stream = model.doStream.bind(model);
    model.doStream = async (options: { providerOptions?: Record<string, Record<string, unknown>> }) => {
      providerOptions = options.providerOptions;
      return stream(options);
    };
    const resolver: LocalModelResolver = {
      normalizeSpecSync: () => 'openai/gpt-5.5',
      resolveModel: () => model as unknown as LanguageModel,
      listProviders: async () => [],
      listModels: async () => [],
      modelInfo: async () => null,
    };
    const { session } = setupWithResolver(resolver);

    expect(session.getReasoningEffort()).toEqual({ effort: null });
    expect(session.setReasoningEffort('high')).toEqual({ ok: true, effort: 'high' });
    expect(session.getReasoningEffort()).toEqual({ effort: 'high' });
    expect(() => session.setReasoningEffort('extreme')).toThrow('Invalid reasoning effort');

    await session.send('think hard');
    expect(providerOptions).toEqual({
      openai: {
        promptCacheKey: expect.any(String),
        reasoningEffort: 'high',
      },
    });
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

  test('daemon-style tick: flushPendingDrains runs the fired trigger turn before end()', async () => {
    // Regression: the scheduler daemon fires triggers then ends immediately.
    // fireDueTriggers only ARMS the ~250ms debounced drain, and end() sets
    // `ended` which makes the drain timer skip — so the fired trigger's
    // autonomous turn was silently dropped. The daemon now flushes before end.
    const { session, events } = setup('handled timer');
    const fireAt = Date.now() + 60_000;
    session.createTimerTrigger({ atMs: fireAt, label: 'wake', trust: 'owner' });

    const outcome = await session.fireDueTriggers(fireAt);
    expect(outcome.fired).toBe(1);
    // The turn runs synchronously as part of the flush (drainPendingEvents
    // awaits the enqueued turn to completion) — asserted with NO waitFor, so
    // this proves the flush drained it, not the debounce timer.
    await session.flushPendingDrains();

    const starts = turnStarts(events);
    expect(starts.some((s) => s.kind === 'programmatic')).toBe(true);
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
    expect(session.pendingEvents()).toEqual([]);
    await session.end();
  });

  test('flushPendingDrains is a no-op once the session has ended', async () => {
    const { session, events } = setup('handled timer');
    session.createTimerTrigger({ atMs: Date.now() + 60_000, label: 'wake', trust: 'owner' });
    await session.fireDueTriggers(Date.now() + 60_000);
    await session.end();
    events.length = 0;
    await session.flushPendingDrains();
    expect(events).toEqual([]);
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
    let received: { atMs?: number; label?: string } | null = null;
    const executeTool = createNodeExecuteToolFactory({
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

  test('Node execute fallback exposes agent.compactNow, arming the ladder for the next turn', async () => {
    let arms = 0;
    const executeTool = createNodeExecuteToolFactory({
      extraProviders: [createLocalAgentSelfProvider({
        proposeCurriculumTasks: async () => [],
        listCurriculumTasks: async () => [],
        setCurriculumTaskStatus: async () => ({ ok: true }),
        createTimerTrigger: () => ({ id: 'trg-local', kind: 'timer_oneshot', nextFireAt: 1 }),
        cancelTrigger: async () => ({ ok: true }),
        jobResult: async () => null,
        listBackgroundJobs: async () => [],
        armCompactNow: () => { arms++; },
      })],
    })({ tools: {}, providers: [], loader: {} });

    const result = await (executeTool as { execute: (args: { code: string }) => Promise<unknown> }).execute({
      code: 'return await agent.compactNow();',
    });
    expect(result).toMatchObject({ result: { armed: true, appliesAt: 'next-turn-assembly' } });
    expect(arms).toBe(1);
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

  test('recoverBackgroundJobs fails + wakes an orphaned job of a non-resumable kind, clears stale fibers', async () => {
    const { db, session, events } = setup();
    // Simulate a previous CLI exit mid-background-job: a running job + its
    // interrupted bg:* fiber row (stashed phase 'running'). `run` has partial
    // side effects, so it declines the resume and fails as before.
    db.exec(`INSERT INTO background_jobs (id, kind, status, created_at) VALUES ('bgjob-x', 'run', 'running', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f1', 'bg:run', '{"phase":"running","jobId":"bgjob-x","kind":"run"}', 1)`);

    await session.recoverBackgroundJobs();

    await waitFor(() => jobStatus(db, 'bgjob-x') === 'failed');
    expect(jobError(db, 'bgjob-x')).toContain('interrupted');
    // The stale row from the prior run is gone; the resume attempt's own fiber
    // row clears itself when it settles.
    expect(db.query(`SELECT COUNT(*) c FROM fibers WHERE id='f1'`).get()).toEqual({ c: 0 });
    await waitFor(() => (db.query(`SELECT COUNT(*) c FROM fibers`).get() as { c: number }).c === 0);
    await waitFor(() => events.some((e) => e.type === 'turn-start' && e.kind === 'programmatic' && e.event === 'background_job'));
  });

  test('recoverBackgroundJobs re-drives an orphaned think job instead of failing it', async () => {
    const { db, session } = setup('resumed answer');
    const input = JSON.stringify({ strategy: 'single-shot', task: 'finish the interrupted exploration' });
    db.exec(`INSERT INTO background_jobs (id, kind, status, input_json, created_at) VALUES ('bgjob-t', 'think', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f2', 'bg:think', '{"phase":"running","jobId":"bgjob-t","kind":"think"}', 1)`);

    await session.recoverBackgroundJobs();

    await waitFor(() => jobStatus(db, 'bgjob-t') === 'completed');
    // Reclaimed under a fresh lease epoch, fencing the executor that died.
    expect(db.query(`SELECT epoch FROM background_jobs WHERE id='bgjob-t'`).get()).toEqual({ epoch: 1 });
    expect(jobResult(db, 'bgjob-t')).toContain('resumed answer');
  });

  test('recoverBackgroundJobs re-drives an orphaned agents fork job (the post-unification kind)', async () => {
    const { db, session } = setup('resumed fork answer');
    const input = JSON.stringify({ action: 'fork', settle: 'single-shot', task: 'finish the interrupted exploration' });
    db.exec(`INSERT INTO background_jobs (id, kind, status, input_json, created_at) VALUES ('bgjob-a', 'agents', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f4', 'bg:agents', '{"phase":"running","jobId":"bgjob-a","kind":"agents"}', 1)`);

    await session.recoverBackgroundJobs();

    await waitFor(() => jobStatus(db, 'bgjob-a') === 'completed');
    expect(jobResult(db, 'bgjob-a')).toContain('resumed fork answer');
  });

  test('end() waits for a detached job to settle instead of closing the database under it', async () => {
    // The resume runs in a fiber detached from any turn, so a session that
    // ends while it is in flight would pull SQLite out from under its settle
    // write — the CLI's version of evicting a DO mid-fiber.
    const slow = fakeModel('slow answer') as unknown as Record<string, unknown> & { doGenerate: () => Promise<unknown> };
    const inner = slow.doGenerate.bind(slow);
    const model = {
      ...slow,
      doGenerate: async () => { await new Promise((r) => setTimeout(r, 50)); return inner(); },
    } as unknown as LanguageModel;

    const { db, session } = setup('unused', model);
    const input = JSON.stringify({ strategy: 'single-shot', task: 'finish the interrupted exploration' });
    db.exec(`INSERT INTO background_jobs (id, kind, status, input_json, created_at) VALUES ('bgjob-s', 'think', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f3', 'bg:think', '{"phase":"running","jobId":"bgjob-s","kind":"think"}', 1)`);

    await session.recoverBackgroundJobs();
    expect(jobStatus(db, 'bgjob-s')).toBe('running');

    await session.end();
    expect(jobStatus(db, 'bgjob-s')).toBe('completed');
    expect(db.query(`SELECT COUNT(*) c FROM fibers`).get()).toEqual({ c: 0 });
  });

  test('settleBackgroundWork drives a detached job\'s wake turn to completion', async () => {
    // The bug this pins: a one-shot `proteus exec` used to close right after the
    // user turn, cutting off the wake turn a backgrounded job triggers (its
    // turn-start streamed, its turn-end never did). settleBackgroundWork drains
    // the fiber AND the wake turn it enqueues before the caller closes.
    const { db, session, events } = setup('synthesized the background result');
    // A non-resumable orphaned job: recover fails it, then wakes the agent.
    db.exec(`INSERT INTO background_jobs (id, kind, status, created_at) VALUES ('bgjob-w', 'run', 'running', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('fw', 'bg:run', '{"phase":"running","jobId":"bgjob-w","kind":"run"}', 1)`);

    await session.recoverBackgroundJobs();
    // Awaiting this must not resolve until the wake turn has run start→end — no
    // polling, so a truncated wake would leave the turn-end assertion failing.
    await session.settleBackgroundWork();

    const order = events.filter((e) => e.type === 'turn-start' || e.type === 'turn-end');
    const wakeStartIdx = order.findIndex((e) => e.type === 'turn-start' && e.kind === 'programmatic' && e.event === 'background_job');
    expect(wakeStartIdx).toBeGreaterThanOrEqual(0);
    // A turn-end follows the wake's turn-start: it completed, not truncated.
    expect(order.slice(wakeStartIdx + 1).some((e) => e.type === 'turn-end')).toBe(true);
    // Quiescent: no background work left in flight once settle returned.
    expect(db.query(`SELECT COUNT(*) c FROM fibers`).get()).toEqual({ c: 0 });
  });

  test('settleBackgroundWork gives up on work that never settles, and leaves it running', async () => {
    // The regression this pins: `proteus exec` detaches a server-style `run`
    // (a VM, a package server, a training job), the agent correctly ends its
    // turn, and the process then blocked on Promise.allSettled over a fiber
    // that never settles — 6.4 of 16.2 agent-hours of dead idle across a
    // benchmark run, every trial of it ended by the harness SIGKILL.
    const { db, session, events } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150 },
    });
    const input = JSON.stringify({ strategy: 'single-shot', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (id, kind, status, input_json, created_at) VALUES ('bgjob-hang', 'think', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('fh', 'bg:think', '{"phase":"running","jobId":"bgjob-hang","kind":"think"}', 1)`);

    await session.recoverBackgroundJobs();
    expect(jobStatus(db, 'bgjob-hang')).toBe('running');

    const started = performance.now();
    await session.settleBackgroundWork();
    const waited = performance.now() - started;

    // Bounded by the grace, not by the work.
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(5_000);
    // Left RUNNING, not cancelled: a server the agent deliberately started has
    // to outlive the one-shot process that started it, and the durable row is
    // what the next start's orphan recovery reads.
    expect(jobStatus(db, 'bgjob-hang')).toBe('running');
    // Not silent about it either.
    expect(events.some((e) => e.type === 'evolution' && e.event === 'bg_jobs_abandoned')).toBe(true);
  });

  test('end() releases the session when a fiber will never settle', async () => {
    const { db, session } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150 },
    });
    const input = JSON.stringify({ strategy: 'single-shot', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (id, kind, status, input_json, created_at) VALUES ('bgjob-e', 'think', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('fe', 'bg:think', '{"phase":"running","jobId":"bgjob-e","kind":"think"}', 1)`);

    await session.recoverBackgroundJobs();
    const started = performance.now();
    await session.end();
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(jobStatus(db, 'bgjob-e')).toBe('running');
  });

  test('a one-shot drain then close pays the grace once, not twice', async () => {
    // runOneShot calls settleBackgroundWork() and then close() → end(), back to
    // back, on the same never-settling job. Two independent graces would double
    // the idle tail this whole change exists to remove.
    const { db, session } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 200 },
    });
    const input = JSON.stringify({ strategy: 'single-shot', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (id, kind, status, input_json, created_at) VALUES ('bgjob-2x', 'think', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f2x', 'bg:think', '{"phase":"running","jobId":"bgjob-2x","kind":"think"}', 1)`);

    await session.recoverBackgroundJobs();
    const started = performance.now();
    await session.settleBackgroundWork();
    await session.end();
    const total = performance.now() - started;

    expect(total).toBeGreaterThanOrEqual(190);
    expect(total).toBeLessThan(400);
  });

  test('a long tool call runs inline under a policy whose threshold it does not cross', async () => {
    // A one-shot run has no human waiting on a fast turn, so ordinary long work
    // — a build, a test suite — completes inline. Detaching it would truncate
    // the turn and force the model into polling its own job instead of working.
    const { db, session, events } = setup(
      'unused',
      executeToolsModel('await new Promise(r => setTimeout(r, 120));\n"computed inline"'),
      { backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150 } },
    );
    await session.send('do the long thing');

    expect(events.some((e) => e.type === 'evolution' && e.event === 'bg_job_started')).toBe(false);
    expect(db.query(`SELECT COUNT(*) c FROM background_jobs`).get()).toEqual({ c: 0 });
    const result = events.find((e) => e.type === 'tool-result') as { result?: unknown } | undefined;
    expect(JSON.stringify(result?.result)).toContain('computed inline');
  });

  test('the same call detaches once it crosses the policy threshold', async () => {
    const { db, session, events } = setup(
      'unused',
      executeToolsModel('await new Promise(r => setTimeout(r, 200));\n"computed late"'),
      { backgroundPolicy: { detachAfterMs: 20, settleGraceMs: 5_000 } },
    );
    await session.send('do the long thing');
    await session.settleBackgroundWork();

    expect(events.some((e) => e.type === 'evolution' && e.event === 'bg_job_started')).toBe(true);
    expect(db.query(`SELECT COUNT(*) c FROM background_jobs`).get()).toEqual({ c: 1 });
  });

  test('past the concurrent-job cap a crossing call is refused, and the model is told why', async () => {
    const { db, session, events } = setup(
      'unused',
      executeToolsModel('await new Promise(r => setTimeout(r, 200));\n"never detached"'),
      { backgroundPolicy: { detachAfterMs: 20, settleGraceMs: 500 } },
    );
    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      db.exec(`INSERT INTO background_jobs (id, kind, status, created_at) VALUES ('busy-${i}', 'run', 'running', 1)`);
    }

    await session.send('start another one');

    // No new job minted: the cap held.
    expect(db.query(`SELECT COUNT(*) c FROM background_jobs`).get()).toEqual({ c: MAX_CONCURRENT_DETACHED_JOBS });
    expect(events.some((e) => e.type === 'evolution' && e.event === 'bg_job_refused')).toBe(true);
    const result = events.find((e) => e.type === 'tool-result') as { result?: unknown } | undefined;
    const text = JSON.stringify(result?.result);
    expect(text).toContain('CANCELLED');
    expect(text).toContain('busy-0');
  });

  test('toolNames exposes the full surface (agents/memory parity); end() resolves', async () => {
    const { session } = setup();
    const names = session.toolNames();
    // Full parity with the DO surface: execution + durable state + delegation + skills.
    for (const t of ['run', 'execute_tools', 'memory', 'agents', 'skills']) expect(names).toContain(t);
    // ...and the keyed-fact actions ride the one durable-state tool.
    expect(names).not.toContain('fact');
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

  // `proteus exec` is one process per turn. The evolution window and the turn
  // awaiting its verdict therefore have to outlive the session object, or
  // headless usage never reaches the reflection cadence and every turn is
  // graded by the same constant.
  test('the window and the pending review survive end() — the next run grades the turn', async () => {
    const classifierJson = '{"outcome":"corrected","confidence":0.9,"evidence":"user re-asked"}';
    const { db, rt, session } = setupWithEvolution(classifierJson);

    await session.send('please summarize the deployment runbook for me');
    await session.end();

    // Nothing invented about a turn nobody has graded yet…
    expect((db.query(`SELECT count(*) AS c FROM turn_outcomes`).get() as { c: number }).c).toBe(0);
    // …and the turn is still in the window, still waiting for its verdict.
    expect((db.query(`SELECT count(*) AS c FROM session_window WHERE in_window = 1`).get() as { c: number }).c).toBe(1);

    // A second run against the same workspace: its prompt IS the follow-up.
    const next = new LocalAgentSession({ rt, db, model: fakeModel('here is the runbook'), onEvent: () => {} });
    await next.send('no — that summary missed the rollback step entirely');
    await next.end();

    const row = db.query(`SELECT outcome, source FROM turn_outcomes`).get() as { outcome: string; source: string };
    expect(row).toEqual({ outcome: 'corrected', source: 'classifier' });
    expect((db.query(`SELECT count(*) AS c FROM session_window WHERE in_window = 1`).get() as { c: number }).c).toBe(2);
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

  test('a background event reaches the LIVE turn at its next step, alongside a user steer', async () => {
    // One delivery time for everything asynchronous: the agent's next step.
    // A platform wake and a user steer land in the same window here, and the
    // two channels stay separate — the wake is model-visible only, the steer
    // keeps its verbatim durable row, and neither spawns a second turn.
    const { model, prompts, release } = toolThenAnswerModel('handled both');
    const { db, session, events } = setup('unused', model);

    const turn = session.send('main question');
    await waitFor(() => events.some((e) => e.type === 'tool-call'));
    expect(session.turnInFlight()).toBe(true);
    expect(session.steer('also check X')).toBe(true);
    await session.publishEvent({
      descriptor: {
        ingress: 'chat_ws', variant: 'chat', payload: { text: 'mail from bob' },
        operator_user_id: 'owner-1', session_id: 'local-test',
      },
      now: 123,
    });
    await session.flushPendingDrains();
    release();
    await turn;

    const second = prompts[1]!;
    const injected = userTexts(second).filter((text) => text.includes('also check X') || text.includes('mail from bob'));
    expect(injected).toHaveLength(2);
    expect(injected[0]).toBe('also check X');
    expect(injected[1]).toContain('mail from bob');
    // Both land after the tool results, so role alternation stays valid.
    const roles = second.map((m) => m.role);
    expect(roles.lastIndexOf('user')).toBeGreaterThan(roles.lastIndexOf('tool'));

    // ONE turn: the event no longer waits for a programmatic turn of its own.
    expect(turnStarts(events)).toHaveLength(1);
    expect(session.pendingEvents()).toEqual([]);

    // The steer persists verbatim; the signal is ephemeral — model-visible at
    // the tip of the live turn and nowhere in durable history.
    const rows = db.query(`SELECT role, content FROM messages WHERE session_id = 'default' ORDER BY created_at, rowid`)
      .all() as Array<{ role: string; content: string }>;
    expect(rows.map((r) => r.content)).toContain('also check X');
    expect(rows.some((r) => r.content.includes('mail from bob'))).toBe(false);
    await session.end();
  });

  test('turnInFlight is false once the stream is over, so a late signal starts its own turn', async () => {
    const { session, events } = setup('answered');
    expect(session.turnInFlight()).toBe(false);
    await session.send('question');
    expect(session.turnInFlight()).toBe(false);

    await session.publishEvent({
      descriptor: {
        ingress: 'chat_ws', variant: 'chat', payload: { text: 'arrived after the turn' },
        operator_user_id: 'owner-1', session_id: 'local-test',
      },
      now: 456,
    });
    await session.flushPendingDrains();
    await waitFor(() => turnStarts(events).length >= 2);
    expect(turnStarts(events)[1]!.kind).toBe('programmatic');
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
    const tool = view.entries.find((entry) => entry.kind === 'tool')!;
    const facts = view.entries.find((entry) => entry.kind === 'fact')!;
    expect(tool.summary).toBe('Created a tool: local helper');
    expect(facts.summary).toBe('Learned 1 thing about your environment');
    expect(facts.items?.map((entry) => entry.summary)).toEqual(['Your editor is helix']);
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
    const facts = view.entries.find((e) => e.kind === 'fact')!;

    expect((await session.revertChangelogEntry(tool.id)).ok).toBe(true);
    expect(rt.craftStore.get('doomed_tool')).toBeFalsy();
    expect((await session.revertChangelogEntry(facts.id)).ok).toBe(true);
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
    rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, action, observation, value, visits, depth, status)
        VALUES ('win', 'win', 'pick a strategy', 'A', 'go with approach A', 0.9, 3, 1, 'open')`;
    rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, action, observation, value, visits, depth, status)
        VALUES ('win', 'alt', 'pick a strategy', 'B', 'go with approach B', 0.86, 2, 1, 'open')`;
    // In production the capture happens MID-turn (inside think-mcts), so its
    // timestamp falls inside the claiming turn's window. This seed runs
    // before send() — stamp it just ahead so the scoped claim sees it as a
    // mid-turn capture rather than a stale leftover.
    captureAlternateTakes(rt.storage.sql, { rootId: 'win', task: 'pick a strategy', winnerId: 'win', epsilon: 0.1, now: Date.now() + 1_000 });
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

  test('an errored turn purges its unclaimed takes instead of claiming them', async () => {
    // A turn whose stream errored produced no durable answer to compare the
    // captured takes against — claiming them would credit a turn that failed.
    // Mirrors the cf backend's purge-on-error.
    const erroringModel = {
      specificationVersion: 'v2', provider: 'fake', modelId: 'fake-model', supportedUrls: {},
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.error(new Error('provider exploded'));
          },
        }),
        response: { headers: {} },
      }),
    } as unknown as LanguageModel;
    const { session, rt, events } = setup('unused', erroringModel);
    seedTakes(rt);

    await session.send('solve it');

    expect(events.some((e) => e.type === 'error')).toBe(true);
    const turnEnd = events.find((e) => e.type === 'turn-end') as Extract<SessionEvent, { type: 'turn-end' }>;
    expect(turnEnd.turn.hadError).toBe(true);
    // The seeded (unclaimed) take was purged, not claimed for the failed turn.
    expect(session.latestAlternateTakes()).toBeNull();
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

describe('LocalAgentSession — the durable run-event log', () => {
  // The table is scoped to the agent's database, which a one-shot run or a
  // benchmark container destroys on exit. Every row is therefore also handed
  // to the frontend as it is written, from the one recorder, so the live
  // stream and the durable table can never disagree.
  test('every recorded row is forwarded to the frontend as it is written', async () => {
    const { session, events } = setup('hello there');
    await session.send('hi');

    const runId = session.listRuns()[0]!.runId;
    const streamed = events
      .filter((e): e is Extract<SessionEvent, { type: 'run-event' }> => e.type === 'run-event')
      .map((e) => e.event);
    expect(streamed).toEqual(session.getRunEvents(runId));

    await session.end();
  });

  test('a turn records a replayable run in run_events', async () => {
    // Backend parity: the DO persists every run into run_events and can replay
    // it (list_run_events / SSE Last-Event-ID resume). The CLI recorded nothing
    // at all, so a local workspace had no run history — despite having the very
    // same SQLite the cf recorder is written against.
    const { session } = setup('hello there');
    await session.send('hi');

    const runs = session.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventCount).toBeGreaterThan(0);

    const events = session.getRunEvents(runs[0]!.runId);
    expect(events.map((e) => e.type)).toEqual([
      'run_start', 'turn_start', 'step_finish', 'turn_end', 'run_end',
    ]);

    const start = events[0] as Extract<typeof events[number], { type: 'run_start' }>;
    expect(start.caused_by).toBe('chat');
    expect(start.userMessage).toBe('hi');

    const end = events.at(-1) as Extract<typeof events[number], { type: 'run_end' }>;
    expect(end.reason).toBe('completed');
    expect(end.error).toBeUndefined();

    // Monotonic indices are what makes a resume possible at all.
    expect(events.map((e) => e.eventIndex)).toEqual([0, 1, 2, 3, 4]);
    // …and `since` replays the tail, exactly as an SSE Last-Event-ID does.
    expect(session.getRunEvents(runs[0]!.runId, { since: 3 }).map((e) => e.type))
      .toEqual(['turn_end', 'run_end']);

    await session.end();
  });

  test('a programmatic turn records its trigger, and each turn is its own run', async () => {
    const { session } = setup('done');
    await session.send('first');
    await session.enqueueTurn({ text: 'job finished', metadata: { proteusEvent: 'background_job' } });
    await waitFor(() => session.listRuns().length === 2);

    const runs = session.listRuns();
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);
    const causes = runs.map((r) => {
      const start = session.getRunEvents(r.runId)[0];
      return start?.type === 'run_start' ? start.caused_by : null;
    });
    expect(causes.sort()).toEqual(['background_job', 'chat']);

    await session.end();
  });

  test('a failed turn seals the run with the provider error text', async () => {
    const exploding = {
      specificationVersion: 'v2', provider: 'fake', modelId: 'fake-model', supportedUrls: {},
      doStream: async () => { throw new Error('upstream is on fire'); },
    } as unknown as LanguageModel;
    const { session } = setup('unused', exploding);
    await session.send('hi');

    const run = session.listRuns()[0]!;
    const end = session.getRunEvents(run.runId).at(-1);
    expect(end?.type).toBe('run_end');
    expect(end).toMatchObject({ reason: 'error', error: expect.stringContaining('upstream is on fire') });

    await session.end();
  });
});

// ── agents.* in the node codemode sandbox ───────────────────────────────────
// The bridge that makes a crafted tool able to BE a workflow: LLM-authored JS
// delegating with plain control flow. Exercised through the REAL node sandbox
// (`new Function` over the real provider bindings), with the exploration
// strategy scripted so no model is called.

describe('agents.* codemode namespace — node sandbox', () => {
  /** The node factory with only the agents provider bound, so the code under
   *  test is the sandbox + the projection and nothing else. */
  function sandboxWith(deps: AgentsToolDeps) {
    const tool = createNodeExecuteToolFactory({
      extraProviders: [createAgentsCodemodeProvider(() => deps)],
    })({ tools: {}, providers: [], loader: {} });
    return (code: string, options?: unknown) =>
      (tool as { execute: (a: { code: string }, o?: unknown) => Promise<unknown> }).execute({ code }, options);
  }

  /** A scripted exploration strategy: records what the fork asked for and
   *  answers without an LLM. */
  function scriptedFork(seen: StrategyContext[] = []): { deps: AgentsToolDeps; seen: StrategyContext[] } {
    const registry = createStrategyRegistry();
    for (const id of [FORK_STRATEGY_ID, 'mcts']) {
      registry.register({
        id,
        async explore(ctx: StrategyContext) {
          seen.push(ctx);
          return {
            strategy: id,
            best: { text: `${id} settled: ${ctx.task}`, score: 0.9, source: id },
            all: [],
            cost: { durationMs: 1 },
          };
        },
      });
    }
    const db = new Database(':memory:');
    const rt = createCLIRuntime(db as never, { dbPath: ':memory:', llm: DUMMY_LLM });
    return { deps: { fork: { registry, rt, model: rt.llm as never } }, seen };
  }

  test('a script forks, branches on the result, and returns its own synthesis', async () => {
    const { deps, seen } = scriptedFork();
    const run = sandboxWith(deps);
    // The shape a workflow actually has: fan out, inspect, decide, aggregate.
    const result = await run(`
      const angles = ['auth', 'billing'];
      const settled = await Promise.all(angles.map((a) => agents.fork({
        task: 'review ' + a,
        forks: [
          { task: 'read ' + a, rationale: 'ground it' },
          { task: 'test ' + a, rationale: 'check it' },
        ],
      })));
      const good = settled.filter((s) => !s.error && s.score > 0.5);
      return { count: good.length, texts: good.map((g) => g.text) };
    `);
    expect(result).toEqual({
      result: {
        count: 2,
        texts: [`${FORK_STRATEGY_ID} settled: review auth`, `${FORK_STRATEGY_ID} settled: review billing`],
      },
    });
    expect(seen.map((c) => c.task)).toEqual(['review auth', 'review billing']);
    // The typed fork specs reached the strategy the same way the tool sends them.
    expect((seen[0].options?.heads as { heads: unknown[] }).heads).toHaveLength(2);
  });

  test('settle:"mcts" from the sandbox reaches the mcts strategy', async () => {
    const { deps } = scriptedFork();
    const result = await sandboxWith(deps)(
      'return await agents.fork({ task: "pick an approach", settle: "mcts" });',
    ) as { result: { strategy: string } };
    expect(result.result.strategy).toBe('mcts');
  });

  test('a fork error is a value the script can branch on, not a sandbox failure', async () => {
    const registry = createStrategyRegistry();
    registry.register({
      id: FORK_STRATEGY_ID,
      async explore() { throw new Error('heads unavailable'); },
    });
    const db = new Database(':memory:');
    const rt = createCLIRuntime(db as never, { dbPath: ':memory:', llm: DUMMY_LLM });
    const result = await sandboxWith({ fork: { registry, rt, model: rt.llm as never } })(`
      const settled = await agents.fork({ task: 't' });
      return settled.error ? 'recovered: ' + settled.error.includes('heads unavailable') : 'no error';
    `);
    expect(result).toEqual({ result: 'recovered: true' });
  });

  test('the turn abort signal reaches a fork started inside the sandbox', async () => {
    const { deps, seen } = scriptedFork();
    const controller = new AbortController();
    await sandboxWith(deps)('return await agents.fork({ task: "t" });', { abortSignal: controller.signal });
    expect(seen[0].signal).toBeDefined();
    expect(seen[0].signal?.aborted).toBe(false);
    controller.abort();
    expect(seen[0].signal?.aborted).toBe(true);
  });

  test('ungated actions are structurally absent from the local sandbox', async () => {
    const { deps } = scriptedFork();
    const result = await sandboxWith(deps)(
      'return { members: Object.keys(agents), staff: typeof agents.staff, fork: typeof agents.fork };',
    );
    // Local sessions wire fork only — no daemon routes staffing or peer mail.
    expect(result).toEqual({ result: { members: ['fork'], staff: 'undefined', fork: 'function' } });
  });

  test('a live session turn gets the namespace, gated to what it actually wired', async () => {
    // The production wiring, end to end: a real turn, the real toolset, the
    // real sandbox. The script reports what it can reach by writing to the
    // workspace, which is how sandbox code returns anything durable anyway.
    const { rt, session, events } = setup('done', executeToolsModel(`
      await workspace.writeFile('/workspace/probe/agents.json', JSON.stringify({
        members: Object.keys(agents), fork: typeof agents.fork, staff: typeof agents.staff,
      }));
      return 'probed';
    `));
    await session.send('what can you delegate to?');
    expect(events.some((e) => e.type === 'tool-result' && e.toolName === 'execute_tools' && e.success)).toBe(true);
    // Local sessions wire fork only — no daemon routes staffing or peer mail.
    const probe = await rt.storage.vfs.readFile('/workspace/probe/agents.json', { encoding: 'utf8' });
    expect(JSON.parse(String(probe))).toEqual({
      members: ['fork'], fork: 'function', staff: 'undefined',
    });
    await session.end();
  });
});
