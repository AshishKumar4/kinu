// LocalAgentSession — the local backend's agent loop (re-arch P5). Driven by the
// authentic createCLIRuntime (real filesystem / shell / durable fiber) + a fake
// streaming model, so it exercises the orchestrator + BackendHost wiring without
// a network LLM. Tool-call accounting is covered by the core TurnAccumulator
// tests; here we verify the loop: turns stream + persist, programmatic turns run
// serialized (reactor / job wake), broadcast fans out, end() flushes.
import { describe, test, expect } from 'bun:test';
import { createTestSql, scratchDir, scratchPath, toolExecute } from '@proteus/test-utils';
import { MissionGovernor } from '@proteus/core';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import type { ToolExecutionOptions } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';
import type { LLMProviderConfig } from '@proteus/core';
import {
  DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC, createAgentsCodemodeProvider, createStrategyRegistry,
  initSearchTables, initAlternateTakesTable, captureAlternateTakes, MAX_CONCURRENT_DETACHED_JOBS,
  JsonObjectSchema, WORKSPACE_RUN_ID,
  type AgentsToolDeps, type ModelInfo, type JsonObject, type JsonValue,
  type ModelCallSink,
  createAgentSelfProvider,
} from '@proteus/core';
import { createCLIRuntime } from '../src/runtime';
import { LocalAgentSession, serializeContentForHeads, type LocalAgentSessionOpts, type SessionEvent } from '../src/local-session';
import { cloudProxyBaseURL, createLocalModelResolver, type LocalModelResolver } from '../src/model-resolver';
import { createNodeExecuteToolFactory } from '../src/execute-tools-factory';
import { discoverAgentsMd } from '../src/agents-md';
import * as v from 'valibot';

/** The resolver members these tests do not exercise — spelled out once so a
 *  fake satisfies the whole seam rather than the slice under test. */
const resolverRest = {
  judgeCandidates: async () => [],
  fastModelCandidates: () => [],
  getAuth: async () => null,
};

/** Likewise for the agent.* host behind the Node execute fallback. */
const agentSelfRest = {
  proposeScaffold: async () => ({ ok: true }),
  listScaffoldVersions: async () => [],
  getReplayEvals: async () => [],
  budget: new MissionGovernor({ storage: createTestSql() }),
  armCompactNow: () => {},
};


const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

type PromptMessage = LanguageModelV2CallOptions['prompt'][number];

/** A streaming LanguageModel stub (ai-SDK v2 spec parts) — emits the answer as
 *  two text-delta chunks then a finish, so runChat yields multiple text-delta
 *  events + a done. doGenerate answers the non-streaming callers (the think
 *  strategies) with the same text. */
function fakeModel(
  answer: string,
  usage: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
): TestLanguageModelV2 {
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
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
  });
}

/** A model whose non-streaming call never resolves — the test's stand-in for a
 *  detached `run` that started a server: the work is genuinely alive, and it is
 *  never going to settle. */
function hangingModel(): LanguageModel {
  const base = fakeModel('unused');
  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    // The SESSION's own turns still stream normally; what hangs is the completion a
    // detached job re-drives. Both methods hang, because every agent kind now issues
    // its request through the streaming path — a fixture that hangs only `doGenerate`
    // stopped hanging anything at all and let the arm below pass in 6 ms.
    doStream: () => new Promise<never>(() => { /* never settles */ }),
    doGenerate: () => new Promise<never>(() => { /* never settles */ }),
  });
}

/** Like fakeModel, but records the tool names the SDK hands to doStream — lets a
 *  test assert per-turn toolset filtering (e.g. by an active skill). */
function capturingModel(answer: string, sink: (toolNames: string[]) => void): LanguageModel {
  const base = fakeModel(answer);
  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    doGenerate: base.doGenerate,
    doStream: async (options) => {
      sink((options.tools ?? []).map((t) => t.name));
      return base.doStream(options);
    },
  });
}

function historyCapturingModel(answer: string, sink: (messages: PromptMessage[]) => void): LanguageModel {
  const base = fakeModel(answer);
  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    doGenerate: base.doGenerate,
    doStream: async (options) => {
      sink(options.prompt);
      return base.doStream(options);
    },
  });
}

/** Captures the system prompt the SDK hands to doStream (the first
 *  role:'system' entry of the LanguageModelV2 prompt). */
function systemCapturingModel(answer: string, sink: (system: string) => void): TestLanguageModelV2 {
  const base = fakeModel(answer);
  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    doGenerate: base.doGenerate,
    doStream: async (options) => {
      const system = options.prompt.find(
        (message): message is Extract<PromptMessage, { role: 'system' }> => message.role === 'system',
      );
      sink(system?.content ?? '');
      return base.doStream(options);
    },
  });
}

/** A workspace database and its runtime — the substrate every session in this
 *  file is built on, and the only place the bun:sqlite handle is widened to the
 *  runtime factory's parameter. */
function workspaceRuntime() {
  const db = new Database(':memory:');
  // The agent DB carries a messages table in production (created on `proteus
  // create`); the runtime factory doesn't, so provision it for the test.
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db, { dbPath: scratchPath('local-session', 'agent.db'), llm: DUMMY_LLM });
  return { db, rt };
}

function setup(answer = 'hello there', model?: LanguageModel, extra?: Partial<LocalAgentSessionOpts>) {
  const { db, rt } = workspaceRuntime();
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
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
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
  });
}

function toolSequenceModel(calls: ReadonlyArray<{ name: string; input: JsonObject }>): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let step = 0;
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          const call = calls[step];
          step += 1;
          if (call) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: `call-${step}`,
              toolName: call.name,
              input: JSON.stringify(call.input),
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
    }),
  });
}

/** A model that runs one two-branch search, then answers. The search's nodes run
 *  against the SAME stub via doGenerate. */
function searchingModel(): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const base = fakeModel('head finding');
  let step = 0;
  return new TestLanguageModelV2({
    provider: base.provider,
    modelId: base.modelId,
    doGenerate: base.doGenerate,
    doStream: async () => {
      step += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (step === 1) {
              controller.enqueue({
                type: 'tool-call', toolCallId: 'call-1', toolName: 'agents',
                input: JSON.stringify({
                  action: 'swarm', task: 'explore two angles',
                  preset: 'ideate', branches: 2, depth: 1,
                }),
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
  });
}

function setupWithResolver(resolver: LocalModelResolver) {
  const { db, rt } = workspaceRuntime();
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
  const row = db.query<{ v: string | null }, [string]>(
    `SELECT ${column} v FROM background_jobs WHERE id=?`,
  ).get(id);
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

    const streamed = events
      .filter((event): event is Extract<SessionEvent, { type: 'text-delta' }> => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('');
    expect(streamed).toBe('hello there');

    const turnEnd = events.find((event) => event.type === 'turn-end');
    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.userMessage).toBe('hi');
    expect(turnEnd.turn.assistantResponse).toBe('hello there');

    const rows = db.query<{ role: string; content: string }, []>(
      `SELECT role, content FROM messages ORDER BY created_at`,
    ).all();
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
    const assistants = db.query<{ content: string }, []>(
      `SELECT content FROM messages WHERE role = 'assistant'`,
    ).all();
    expect(assistants).toEqual([{ content: 'streamed answer' }]);
  });

  test('attachments reach the model as [file…, text] user content parts', async () => {
    let observed: PromptMessage[] = [];
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
    const user = [...observed].reverse().find((message) =>
      message.role === 'user' && message.content.some((part) => part.type === 'file'));
    expect(user).toBeDefined();
    if (!user || user.role !== 'user') throw new Error('user attachment message was not captured');
    const parts = user.content;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/png', filename: 'square.png' });
    expect(parts[1]).toMatchObject({ type: 'text', text: 'what is in this image?' });

    // The durable transcript persists the text — never the data-URL payload.
    const rows = db.query<{ role: string; content: string }, []>(
      `SELECT role, content FROM messages ORDER BY created_at`,
    ).all();
    expect(rows[0]).toEqual({ role: 'user', content: 'what is in this image?' });
  });

  test('a PDF the model cannot accept is sanitized to a VFS reference before the model sees it', async () => {
    // The production P0: Workers AI's chat schema rejects type:"file" parts,
    // so an attached PDF 400s every turn forever. The sanitizer replaces the
    // part with a content-addressed VFS path the agent reads back with its
    // file tools — and it must run on EVERY turn's assembly, healing the
    // already-poisoned durable history.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 8, 7]);
    const captures: PromptMessage[][] = [];
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
    const fileParts = observed.flatMap((message) =>
      message.role === 'system' ? [] : message.content.filter((part) => part.type === 'file'));
    expect(fileParts).toHaveLength(0);

    // The replacement text carries the content-addressed path…
    const referenced = observed.find((m) =>
      m.role === 'user' && JSON.stringify(m.content).includes('attachments/'));
    expect(referenced).toBeDefined();
    const referencedJson = JSON.stringify(referenced!.content);
    expect(referencedJson).toContain('resume.pdf');
    const path = /saved to (\S+) — read/.exec(referencedJson)?.[1];
    expect(path).toStartWith('attachments/');

    // …and the exact payload bytes are readable back through the agent's VFS.
    const stored = await rt.storage.vfs.readFile(path!);
    expect(stored instanceof Uint8Array ? Array.from(stored) : stored).toEqual(Array.from(pdfBytes));

    // Second turn: the (unchanged) in-memory history re-sanitizes to the SAME
    // reference — byte-stable, so the prompt-cache prefix holds.
    await session.send('continue');
    const again = captures[1]!.find((m) =>
      m.role === 'user' && JSON.stringify(m.content).includes('attachments/'));
    expect(again).toBeDefined();
    expect(JSON.stringify(again!.content)).toBe(referencedJson);
  });

  test('facts ride the dynamic-context block, never the system prompt', async () => {
    // Cache-prefix stability: the system prompt must stay byte-stable across
    // turns, so live state (the facts world model, executor status) rides the
    // dynamic ledger's frozen blocks in the messages array instead.
    let observed: PromptMessage[] = [];
    let system = '';
    const systemModel = systemCapturingModel('ok', (value) => { system = value; });
    const combinedModel = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doGenerate: fakeModel('ok').doGenerate,
      doStream: async (options) => {
        observed = options.prompt;
        return systemModel.doStream(options);
      },
    });
    const { db, session } = setup('ok', combinedModel);

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
    const rows = db.query<{ content: string }, []>(`SELECT content FROM messages`).all();
    expect(rows.some((r) => r.content.includes('<dynamic_context'))).toBe(false);
  });

  test('the MEMORY.md tail (newest lessons) rides the dynamic block, never the system prefix', async () => {
    // Two regressions guarded here: slice(0, 2000) once injected the OLDEST
    // bytes of the append-only MEMORY.md, and the tail once lived in the
    // byte-stable system prefix — where every lesson/reflection/take-pick
    // append busted the prompt cache with no real agent event.
    let observed: PromptMessage[] = [];
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
    let observed: PromptMessage[] = [];
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

    let observed: PromptMessage[] = [];
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

  // Restore used to stop at the newest 40 messages — a number nothing ever
  // passed, applied on every reconnect. A session past 40 messages lost
  // everything older each time the CLI restarted, silently: no marker in the
  // transcript, and no way for the model to ask what it had lost.
  describe('restoring a long transcript', () => {
    const alternatingRole = (index: number): 'user' | 'assistant' =>
      index % 2 === 0 ? 'user' : 'assistant';

    function seed(db: Database, messages: Array<{ role: 'user' | 'assistant'; content: string }>): void {
      messages.forEach((m, i) => {
        db.query(
          `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, 'default', ?, ?, ?)`,
        ).run(`m-${i}`, m.role, m.content, 1_000 + i);
      });
    }

    function resume(db: Database, rt: ReturnType<typeof createCLIRuntime>) {
      let observed: PromptMessage[] = [];
      const session = new LocalAgentSession({
        rt, db, sessionId: 'default',
        model: historyCapturingModel('ok', (messages) => { observed = messages; }),
        onEvent: () => {}, noAutoEvolve: true,
      });
      return { session, seen: () => observed.map(messageText).filter((t) => !isDynamicBlock(t)) };
    }

    test('a transcript far past the old 40-message cap is restored whole', async () => {
      const { db, rt } = setup();
      seed(db, Array.from({ length: 120 }, (_, i) => ({
        role: alternatingRole(i),
        content: `turn-${i}`,
      })));

      const { session, seen } = resume(db, rt);
      await session.send('and now?');
      await session.end();

      const text = seen();
      expect(text).toContain('turn-0');
      expect(text).toContain('turn-119');
      expect(text.some((t) => t.includes('earlier message'))).toBe(false);
    });

    test('what does not fit the context window is stated, with its count and where it lives', async () => {
      const { db, rt } = setup();
      // The static fallback window is 128k tokens ≈ 512k characters, so 80
      // messages of 10k characters cannot be restored whole.
      seed(db, Array.from({ length: 80 }, (_, i) => ({
        role: alternatingRole(i),
        content: `turn-${i} ${'z'.repeat(10_000)}`,
      })));

      const { session, seen } = resume(db, rt);
      await session.send('and now?');
      await session.end();

      const text = seen();
      const notice = text.find((t) => t.includes('earlier message'));
      expect(notice).toBeDefined();
      // The newest end is what survived, and the count names exactly how much
      // of the old end did not — the boundary the model can reason about.
      expect(text.some((t) => t.startsWith('turn-79'))).toBe(true);
      expect(text.some((t) => t.startsWith('turn-0 '))).toBe(false);
      const omitted = Number(/(\d+) earlier messages/.exec(notice!)![1]);
      expect(omitted).toBeGreaterThan(0);
      expect(omitted).toBeLessThan(80);
      expect(text.some((t) => t.startsWith(`turn-${omitted - 1} `))).toBe(false);
      // Not lost, and it says so — an agent that knows it is reading the tail
      // of its own conversation can ask for the rest.
      expect(notice).toContain('local session store');
      expect(notice).toContain('"default"');
    });
  });
});

describe('LocalAgentSession — tool success/error + cache telemetry fidelity', () => {
  /** step 1: calls the `memory` save tool (which will throw via a stubbed
   *  runtime), finishing with the caller-supplied usage; step 2: answers text. */
  function memoryThenTextModel(firstFinishUsage: LanguageModelV2Usage): LanguageModel {
    let step = 0;
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    return new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
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
    });
  }

  test('a failing tool flags hadError on the turn and still surfaces a tool-result', async () => {
    const model = memoryThenTextModel({ inputTokens: 9, outputTokens: 2, totalTokens: 11 });
    const { rt, session, events } = setup('unused', model);
    // Make the memory-save path throw deterministically at execution time.
    rt.memory.append = async () => { throw new Error('disk full'); };

    await session.send('save a note please');

    const turnEnd = events.find((event) => event.type === 'turn-end');
    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.hadError).toBe(true);
    // The error rode the tool-result path (my case), not the stream-abort catch.
    const toolResult = events.find((event) => event.type === 'tool-result');
    if (!toolResult || toolResult.type !== 'tool-result') throw new Error('tool-result event was not emitted');
    expect(toolResult).toBeDefined();
    expect(toolResult.result).toContain('disk full');
    await session.end();
  });

  test('the cached prefix the provider reported flows from the step into the turn', async () => {
    const model = memoryThenTextModel({ inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 12 });
    const { rt, session, events } = setup('unused', model);
    rt.memory.append = async () => { throw new Error('irrelevant'); };

    await session.send('save it');

    // Both steps, summed, with one witness per field: the step's own report.
    // Adding Anthropic's providerMetadata.cacheReadInputTokens on top of
    // usage.cachedInputTokens counted the SAME tokens twice — @ai-sdk/anthropic
    // sets both from cache_read_input_tokens (dist/index.js:1810).
    //
    // Asserted whole, because what is NOT here is the point: neither step
    // mentioned a cache WRITE or reasoning tokens, so those fields are absent
    // rather than sitting at 0 and claiming the provider measured them.
    const turnEnd = events.find((event) => event.type === 'turn-end');
    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.usage).toEqual({ input: 25, output: 12, cacheRead: 12 });
    await session.end();
  });
});

/** The wire shape of one dynamic-context block (core volatile-context.ts). */
function isDynamicBlock(text: string): boolean {
  return /^<dynamic_context fingerprint="[0-9a-f]{16}">\n/.test(text)
    && text.endsWith('\n</dynamic_context>');
}

function messageText(message: PromptMessage): string {
  if (message.role === 'system') return message.content;
  return message.content
    .map((part) => part.type === 'text' || part.type === 'reasoning' ? part.text : JSON.stringify(part))
    .join('');
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
    expect(await session.listFileCheckpoints()).toEqual({
      availability: { available: false, reason: 'checkpoints are not configured for this session' },
      entries: [],
    });
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
    const base = fakeModel(answer);
    return new TestLanguageModelV2({
      provider: base.provider,
      modelId: base.modelId,
      doGenerate: base.doGenerate,
      doStream: async (options) => {
        calls += 1;
        if (calls <= failures) throw new Error('context_length_exceeded: prompt is too long');
        return base.doStream(options);
      },
    });
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
    const streamed = events
      .filter((event): event is Extract<SessionEvent, { type: 'text-delta' }> => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('');
    expect(streamed).toContain('recovered');
    // …and CONSUMED the armed flag: no compaction_state row stays armed.
    const armed = db.query<{ c: number }, []>(
      `SELECT COUNT(*) as c FROM compaction_state WHERE force_compaction = 1`,
    ).get();
    if (!armed) throw new Error('compaction state count row is missing');
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
    const base = fakeModel('n/a');
    const model = new TestLanguageModelV2({
      provider: base.provider,
      modelId: base.modelId,
      doGenerate: base.doGenerate,
      doStream: async () => {
        calls += 1;
        throw new Error('Failed after 3 attempts. Last error: Too Many Requests');
      },
    });
    const { db, session, events } = setup('unused', model);
    await session.send('build the thing');
    await new Promise((r) => setTimeout(r, 25));
    expect(turnStarts(events)).toHaveLength(1);
    expect(calls).toBe(1);
    const armed = db.query<{ c: number }, []>(
      `SELECT COUNT(*) as c FROM compaction_state WHERE force_compaction = 1`,
    ).get();
    if (!armed) throw new Error('compaction state count row is missing');
    expect(armed.c).toBe(0);
  });
});

describe('LocalAgentSession — context window', () => {
  /** Streams normally but reports a large provider-priced prompt, so the next
   *  turn's compaction has a real measured trigger to budget against. */
  function pricedModel(inputTokens: number): LanguageModel {
    return fakeModel('ok', { inputTokens, outputTokens: 7, totalTokens: inputTokens + 7 });
  }

  /** A spec the static context-window table does not know, so the fallback is
   *  its 128k default and any other number can only have come from the catalog. */
  function resolverReporting(contextWindow: number | undefined, model: LanguageModel): LocalModelResolver {
    return {
      normalizeSpecSync: (spec) => spec?.trim() || 'openai-compatible/house-model',
      resolveModel: () => model,
      listProviders: async () => [],
      listModels: async () => ({ models: [], failures: [] }),
      modelInfo: async () => {
        const info: ModelInfo = {
        id: 'house-model', label: 'house', capabilities: ['tools', 'streaming'],
        };
        if (contextWindow !== undefined) info.contextWindow = contextWindow;
        return info;
      },
      ...resolverRest,
    };
  }

  const compacted = (db: Database) => {
    const row = db.query<{ c: number }, []>(
      `SELECT COUNT(*) c FROM compaction_state WHERE plan_json IS NOT NULL`,
    ).get();
    if (!row) throw new Error('compaction plan count row is missing');
    return row.c > 0;
  };

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
      listModels: async () => ({ models: [], failures: [] }),
      modelInfo: async () => null,
      ...resolverRest,
    };
    const { session, events } = setupWithResolver(resolver);

    expect(session.getStoredModelSpec()).toEqual({ spec: null });
    expect(session.getEffectiveModelSpec()).toBe('local/a');

    await session.send('first');
    const firstTurn = events.find((event) => event.type === 'turn-end');
    if (!firstTurn || firstTurn.type !== 'turn-end') throw new Error('first turn-end event was not emitted');
    expect(firstTurn.turn.assistantResponse).toBe('from a');

    expect(session.setModel('local/b')).toEqual({ ok: true, spec: 'local/b' });
    expect(session.getStoredModelSpec()).toEqual({ spec: 'local/b' });

    await session.send('second');
    const turns = events.filter((e): e is Extract<SessionEvent, { type: 'turn-end' }> => e.type === 'turn-end');
    expect(turns[1]!.turn.assistantResponse).toBe('from b');
  });

  test('reasoning effort persists and merges with prompt-cache options on the main chat turn', async () => {
    let providerOptions: LanguageModelV2CallOptions['providerOptions'];
    const base = fakeModel('reasoned');
    const model = new TestLanguageModelV2({
      provider: base.provider, modelId: base.modelId, doGenerate: base.doGenerate,
      doStream: async (options) => {
        providerOptions = options.providerOptions;
        return base.doStream(options);
      },
    });
    const resolver: LocalModelResolver = {
      normalizeSpecSync: () => 'openai/gpt-5.5',
      resolveModel: () => model,
      listProviders: async () => [],
      listModels: async () => ({ models: [], failures: [] }),
      modelInfo: async () => null,
      ...resolverRest,
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
    const b = events.find((event) => event.type === 'broadcast');
    if (!b || b.type !== 'broadcast') throw new Error('broadcast event was not emitted');
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
    const created = await session.createTimerTrigger({
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
    await session.createTimerTrigger({ atMs: fireAt, label: 'wake', trust: 'owner' });

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
    await session.createTimerTrigger({ atMs: Date.now() + 60_000, label: 'wake', trust: 'owner' });
    await session.fireDueTriggers(Date.now() + 60_000);
    await session.end();
    events.length = 0;
    await session.flushPendingDrains();
    expect(events).toEqual([]);
  });

  test('cron timer triggers reschedule after firing', async () => {
    const { session, events } = setup('handled cron');
    const created = await session.createTimerTrigger({ cron: '*/5 * * * *', label: 'heartbeat' });
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
    const received: Array<{ atMs?: number; label?: string }> = [];
    const executeTool = createNodeExecuteToolFactory({
      extraProviders: [createAgentSelfProvider({
        proposeCurriculumTasks: async () => [],
        listCurriculumTasks: async () => [],
        setCurriculumTaskStatus: async () => ({ ok: true }),
        createTimerTrigger: async (opts) => {
          received.push({ atMs: opts.atMs, label: opts.label });
          return { id: 'trg-local', kind: opts.cron ? 'timer_cron' : 'timer_oneshot', nextFireAt: opts.atMs ?? 123 };
        },
        cancelTrigger: async () => ({ ok: true, changed: true }),
        jobResult: async () => null,
        listBackgroundJobs: async () => [],
        ...agentSelfRest,
      })],
    })({ craftedTools: () => ({}), providers: [], loader: {} });

    const result = await toolExecute<{ code: string }, unknown>(executeTool)({
      code: "return await agent.schedule({ atMs: Date.now() + 60000, label: 'local wake' });",
    });
    expect(result).toMatchObject({ result: { id: 'trg-local', kind: 'timer_oneshot' } });
    expect(received[0]?.label).toBe('local wake');
    expect(received[0]?.atMs).toBeGreaterThan(Date.now());
  });

  test('Node execute fallback exposes agent.compactNow, arming the ladder for the next turn', async () => {
    let arms = 0;
    const executeTool = createNodeExecuteToolFactory({
      extraProviders: [createAgentSelfProvider({
        proposeCurriculumTasks: async () => [],
        listCurriculumTasks: async () => [],
        setCurriculumTaskStatus: async () => ({ ok: true }),
        createTimerTrigger: async () => ({ id: 'trg-local', kind: 'timer_oneshot', nextFireAt: 1 }),
        cancelTrigger: async () => ({ ok: true, changed: true }),
        jobResult: async () => null,
        listBackgroundJobs: async () => [],
        ...agentSelfRest,
        armCompactNow: () => { arms++; },
      })],
    })({ craftedTools: () => ({}), providers: [], loader: {} });

    const result = await toolExecute<{ code: string }, unknown>(executeTool)({
      code: 'return await agent.compactNow();',
    });
    expect(result).toMatchObject({ result: { armed: true, appliesAt: 'next-turn-assembly' } });
    expect(arms).toBe(1);
  });

  test('a /skill activation filters the turn toolset to allowed_tools', async () => {
    let captured: string[] = [];
    const { rt, session } = setup('ok', capturingModel('ok', (t) => { captured = t; }));
    await rt.storage.vfs.mkdir('/workspace/skills', { recursive: true });
    await rt.storage.vfs.writeFile(
      '/workspace/skills/focused.md',
      '---\nname: focused\ndescription: a memory-only skill\nallowed_tools: [memory]\n---\nFocus on memory only.\n',
    );
    await session.send('/focused remember this');
    // The active skill restricts to memory. No tool is exempted from its own
    // restriction: there is no `skills` tool left to protect, and
    // execute_tools (the only remaining path to a skill's own VFS bytes) is
    // restricted the same as any other tool a skill's allowed_tools omits.
    expect(new Set(captured)).toEqual(new Set(['memory']));
  });

  test('recoverBackgroundJobs fails + wakes an orphaned job of a non-resumable kind, clears stale fibers', async () => {
    const { db, session, events } = setup();
    // Simulate a previous CLI exit mid-background-job: a running job + its
    // interrupted bg:* fiber row (stashed phase 'running'). `run` has partial
    // side effects, so it declines the resume and fails as before.
    db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, created_at) VALUES ('bgjob-x', 'run', 'build', 'running', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f1', 'bg:run', '{"phase":"running","jobId":"bgjob-x","kind":"run"}', 1)`);

    await session.recoverBackgroundJobs();

    await waitFor(() => jobStatus(db, 'bgjob-x') === 'failed');
    expect(jobError(db, 'bgjob-x')).toContain('interrupted');
    // The stale row from the prior run is gone; the resume attempt's own fiber
    // row clears itself when it settles.
    expect(db.query(`SELECT COUNT(*) c FROM fibers WHERE id='f1'`).get()).toEqual({ c: 0 });
    await waitFor(() => db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM fibers`).get()?.c === 0);
    await waitFor(() => events.some((e) => e.type === 'turn-start' && e.kind === 'programmatic' && e.event === 'background_job'));
  });

  test('recoverBackgroundJobs re-drives an orphaned think job instead of failing it', async () => {
    const { db, session } = setup('resumed answer');
    const input = JSON.stringify({ strategy: 'single-shot', task: 'finish the interrupted exploration' });
    db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, input_json, created_at) VALUES ('bgjob-t', 'think', 'build', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f2', 'bg:think', '{"phase":"running","jobId":"bgjob-t","kind":"think"}', 1)`);

    await session.recoverBackgroundJobs();

    await waitFor(() => jobStatus(db, 'bgjob-t') === 'completed');
    // Reclaimed under a fresh lease epoch, fencing the executor that died.
    expect(db.query(`SELECT epoch FROM background_jobs WHERE id='bgjob-t'`).get()).toEqual({ epoch: 1 });
    expect(jobResult(db, 'bgjob-t')).toContain('resumed answer');
  });

  test('recoverBackgroundJobs re-drives an orphaned agents fork job (the post-unification kind)', async () => {
    const { db, session } = setup('resumed fork answer');
    // A row written by a surface that no longer exists. It is HISTORY rather
    // than a prompt: `action:'fork'` names a rung this tool dropped, so the row
    // is TRANSLATED onto the action that runs ephemeral nodes today instead of
    // being refused — a refusal here would strand exactly the work resume
    // exists for. The briefs are on the row because that is what the era stored.
    const input = JSON.stringify({
      action: 'fork', task: 'finish the interrupted exploration',
      forks: [
        { task: 'read it', rationale: 'ground it' },
        { task: 'test it', rationale: 'check it' },
      ],
    });
    db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, input_json, created_at) VALUES ('bgjob-a', 'agents', 'build', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('f4', 'bg:agents', '{"phase":"running","jobId":"bgjob-a","kind":"agents"}', 1)`);

    const stderrLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(' ')); };
    try {
      await session.recoverBackgroundJobs();
      await waitFor(() => jobStatus(db, 'bgjob-a') === 'completed');
    } finally {
      console.error = originalError;
    }

    // WHAT IT RE-DROVE AS, not merely that it re-drove: a search under
    // `preset:'ideate'` — the one shape that writes its own competing approaches
    // from `task` alone, which is all a row carrying no objective can become.
    const settled = v.parse(
      v.object({ preset: v.literal('ideate'), report: v.object({ expansions: v.number() }) }),
      JSON.parse(jobResult(db, 'bgjob-a')),
    );
    expect(settled.report.expansions).toBeGreaterThan(0);
    expect(jobResult(db, 'bgjob-a')).toContain('resumed fork answer');

    // And what the translation could NOT carry is named once rather than
    // counted: the briefs have no equivalent on a search, and a re-drive that
    // quietly lost them is worse than one that refused.
    const dropped = stderrLines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('forks');
  });

  test('end() waits for a detached job to settle instead of closing the database under it', async () => {
    // The resume runs in a fiber detached from any turn, so a session that
    // ends while it is in flight would pull SQLite out from under its settle
    // write — the CLI's version of evicting a DO mid-fiber.
    const slow = fakeModel('slow answer');
    const model = new TestLanguageModelV2({
      provider: slow.provider, modelId: slow.modelId, doStream: slow.doStream,
      doGenerate: async (options) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return slow.doGenerate(options);
      },
    });

    const { db, session } = setup('unused', model);
    const input = JSON.stringify({ strategy: 'single-shot', task: 'finish the interrupted exploration' });
    db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, input_json, created_at) VALUES ('bgjob-s', 'think', 'build', 'running', '${input}', 1)`);
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
    db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, created_at) VALUES ('bgjob-w', 'run', 'build', 'running', 1)`);
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
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150, wakesAfterTurn: true },
    });
    const input = JSON.stringify({ strategy: 'single-shot', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, input_json, created_at) VALUES ('bgjob-hang', 'think', 'build', 'running', '${input}', 1)`);
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

  test('abandoning work says it will be resumed on this machine, unattended, and how to stop it', async () => {
    // The regression this pins: a run exited silently at 11:55 with its target
    // file untouched, and the file appeared at 12:02:20 — written by the job
    // the local scheduler daemon resumed, which runs the agent's own tools on
    // the host. Nothing said that would happen. The old notice claimed the work
    // was "left running" and that its "results are not part of this run", both
    // of which are false: the process is exiting, and the work comes back.
    const { db, session, events } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 50, wakesAfterTurn: true },
    });
    const input = JSON.stringify({ strategy: 'single-shot', task: 'edit the target file' });
    db.exec(`INSERT INTO background_jobs (id, kind, label, work_mode, status, input_json, created_at)
      VALUES ('bgjob-quiet', 'think', 'mcts: edit the target file', 'build', 'running', '${input}', 1)`);
    db.exec(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES ('fq', 'bg:think', '{"phase":"running","jobId":"bgjob-quiet","kind":"think"}', 1)`);
    await session.recoverBackgroundJobs();

    const stderrLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(' ')); };
    try {
      await session.settleBackgroundWork();
    } finally {
      console.error = originalError;
    }

    const notice = events.find((e) => e.type === 'evolution' && e.event === 'bg_jobs_abandoned');
    const message = notice?.type === 'evolution' ? notice.message : '';
    expect(message).toContain('bgjob-quiet');
    expect(message).toContain('mcts: edit the target file');
    expect(message).toContain('local scheduler daemon');
    expect(message).toContain('writes files');
    expect(message).toMatch(/proteus jobs \S+ cancel <id>/);
    // The event stream alone is not enough: `proteus exec`'s human renderer
    // drops evolution events, so the operator has to hear it on stderr — the
    // one channel every surface shows and no NDJSON consumer parses.
    expect(stderrLines.some((line) => line.includes('bgjob-quiet'))).toBe(true);
  });

  test('end() releases the session when a fiber will never settle', async () => {
    const { db, session } = setup('unused', hangingModel(), {
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150, wakesAfterTurn: true },
    });
    const input = JSON.stringify({ strategy: 'single-shot', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, input_json, created_at) VALUES ('bgjob-e', 'think', 'build', 'running', '${input}', 1)`);
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
      backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 200, wakesAfterTurn: true },
    });
    const input = JSON.stringify({ strategy: 'single-shot', task: 'start the server' });
    db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, input_json, created_at) VALUES ('bgjob-2x', 'think', 'build', 'running', '${input}', 1)`);
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
      { backgroundPolicy: { detachAfterMs: 10_000, settleGraceMs: 150, wakesAfterTurn: true } },
    );
    await session.send('do the long thing');

    expect(events.some((e) => e.type === 'evolution' && e.event === 'bg_job_started')).toBe(false);
    expect(db.query(`SELECT COUNT(*) c FROM background_jobs`).get()).toEqual({ c: 0 });
    const result = events.find((event) => event.type === 'tool-result');
    expect(JSON.stringify(result?.result)).toContain('computed inline');
  });

  test('the same call detaches once it crosses the policy threshold', async () => {
    const { db, session, events } = setup(
      'unused',
      executeToolsModel('await new Promise(r => setTimeout(r, 200));\n"computed late"'),
      { backgroundPolicy: { detachAfterMs: 20, settleGraceMs: 5_000, wakesAfterTurn: true } },
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
      { backgroundPolicy: { detachAfterMs: 20, settleGraceMs: 500, wakesAfterTurn: true } },
    );
    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      db.exec(`INSERT INTO background_jobs (id, kind, work_mode, status, created_at) VALUES ('busy-${i}', 'run', 'build', 'running', 1)`);
    }

    await session.send('start another one');

    // No new job minted: the cap held.
    expect(db.query(`SELECT COUNT(*) c FROM background_jobs`).get()).toEqual({ c: MAX_CONCURRENT_DETACHED_JOBS });
    expect(events.some((e) => e.type === 'evolution' && e.event === 'bg_job_refused')).toBe(true);
    const result = events.find((event) => event.type === 'tool-result');
    const text = JSON.stringify(result?.result);
    expect(text).toContain('CANCELLED');
    expect(text).toContain('busy-0');
  });

  test('toolNames exposes the full surface (agents/memory parity); end() resolves', async () => {
    const { session } = setup();
    const names = session.toolNames();
    // Full parity with the DO surface: execution + durable state + delegation.
    // No `skills` — read/create/edit/delete are workspace.readFile/writeFile/
    // readdir/exec calls now, not a separate tool.
    for (const t of ['run', 'execute_tools', 'memory', 'agents']) expect(names).toContain(t);
    expect(names).not.toContain('skills');
    // ...and the keyed-fact actions ride the one durable-state tool.
    expect(names).not.toContain('fact');
    await session.send('hi');
    await session.end();   // flush partial session — no-op with auto-evolve off, must not throw
  });

  test('a native file read authorizes workspace.writeFile in the same CLI turn', async () => {
    const model = toolSequenceModel([
      { name: 'file', input: { action: 'read', path: 'shared.txt' } },
      {
        name: 'execute_tools',
        input: { code: 'return await workspace.writeFile("shared.txt", "changed by codemode");' },
      },
    ]);
    const { rt, session } = setup('unused', model);
    await rt.storage.vfs.writeFile('shared.txt', 'original');

    await session.send('read it natively, then replace it through codemode');

    expect(await rt.storage.vfs.readFile('shared.txt', { encoding: 'utf8' }))
      .toBe('changed by codemode');
  });

  test('a workspace.readFile authorizes native file write in the same CLI turn', async () => {
    const model = toolSequenceModel([
      {
        name: 'execute_tools',
        input: { code: 'return await workspace.readFile("shared.txt");' },
      },
      {
        name: 'file',
        input: { action: 'write', path: 'shared.txt', content: 'changed by native file' },
      },
    ]);
    const { rt, session } = setup('unused', model);
    await rt.storage.vfs.writeFile('shared.txt', 'original');

    await session.send('read it through codemode, then replace it natively');

    expect(await rt.storage.vfs.readFile('shared.txt', { encoding: 'utf8' }))
      .toBe('changed by native file');
  });

  test('a background job that settles WHILE the same multi-step turn is still running reaches the model at its next step — no polling required', async () => {
    // Defect B's reliability question, answered against the REAL pipeline: the
    // owner reported the agent polling agent.jobResult in a loop despite the
    // detach message already promising a wake. This proves (or disproves) that
    // the wake mechanism itself delivers, independent of what the model does
    // with it — three real steps of the SAME streamText multi-step turn
    // (matching the shape of the caffe-cifar-10 bench trial: one continuous
    // turn, background jobs detaching and settling mid-flight), with the third
    // step's actual model-bound messages captured and inspected.
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    const capturedSteps: PromptMessage[][] = [];
    let step = 0;
    const model: LanguageModel = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        step += 1;
        capturedSteps.push(options.prompt);
        if (step === 2) {
          // Real wall-clock delay standing in for a slower model round trip —
          // comfortably longer than the background job's own 60ms of work, so
          // by the time step 3's prepareStep runs the job has genuinely
          // settled and (if the wake fired) already delivered its signal.
          await new Promise((r) => setTimeout(r, 150));
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              if (step === 1) {
                controller.enqueue({
                  toolCallId: 'call-1', type: 'tool-call', toolName: 'execute_tools',
                  input: JSON.stringify({ code: 'await new Promise(r => setTimeout(r, 60)); return "slow-done";' }),
                });
                controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
              } else if (step === 2) {
                controller.enqueue({
                  toolCallId: 'call-2', type: 'tool-call', toolName: 'execute_tools',
                  input: JSON.stringify({ code: '"noop"' }),
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
    });

    const { session } = setup('unused', model, { backgroundPolicy: { detachAfterMs: 10, settleGraceMs: 5_000, wakesAfterTurn: true } });
    await session.send('do the slow thing then finish');

    expect(step).toBeGreaterThanOrEqual(3);
    const thirdStepMessages = capturedSteps[2]!;
    const injectedTexts = thirdStepMessages
      .filter((m) => m.role === 'user')
      .map((m) => JSON.stringify(m.content));
    const wakeText = injectedTexts.find((t) => t.includes('Background') && t.includes('completed'));

    // The wake reached the THIRD step's own request — the model was handed the
    // settled result without ever calling agent.jobResult. This is the
    // mechanism the owner's polling complaint doubted; here it is proven, not
    // asserted.
    expect(wakeText).toBeDefined();
    expect(wakeText).toContain('execute_tools');
    expect(wakeText).toContain("agent.jobResult('");
    await session.end();
  });
});

describe('LocalAgentSession — turn-outcome review (Hermes-style forked review)', () => {
  function setupWithEvolution(classifierJson: string) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    const rt = createCLIRuntime(db, { dbPath: scratchPath('local-session-review', 'agent.db'), llm: DUMMY_LLM });
    // The classifier + reflection ride rt.llm.complete — stub it so the review
    // runs without a network LLM.
    Object.defineProperty(rt, 'llm', { value: {
      stream: rt.llm.stream.bind(rt.llm),
      complete: async (prompt: string) =>
        prompt.includes('Classify what the follow-up reveals')
          ? classifierJson
          : 'verify the cluster name before rotating keys',
    } });
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

    await waitFor(() => db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM turn_outcomes`,
    ).get()?.c === 1, 3000);
    const row = db.query<{
      outcome: string; source: string; turn_id: string; session_id: string; followup: string;
    }, []>(`SELECT * FROM turn_outcomes`).get();
    if (!row) throw new Error('turn outcome row is missing');
    expect(row.outcome).toBe('corrected');
    expect(row.source).toBe('classifier');
    expect(row.followup).toContain('STAGING');
    expect(row.session_id).toBe('default');
    // Tied to the FIRST turn's durable assistant message id.
    const firstAssistant = db.query<{ id: string }, []>(
      `SELECT id FROM messages WHERE role = 'assistant' ORDER BY created_at, rowid LIMIT 1`,
    ).get();
    if (!firstAssistant) throw new Error('first assistant message row is missing');
    expect(row.turn_id).toBe(firstAssistant.id);

    // The corrected outcome reflects a corroborated lesson into MEMORY.md.
    await waitFor(() => db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM lessons WHERE status = 'corroborated'`,
    ).get()?.c === 1, 3000);
    await session.end();
  });

  test('trivial turns (greetings) skip classification entirely', async () => {
    const { db, session } = setupWithEvolution('{"outcome":"accepted","confidence":0.9,"evidence":"x"}');

    await session.send('hi');
    await session.send('thanks!');
    // Give any (wrongly) dispatched detached review a beat to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(db.query<{ c: number }, []>(`SELECT count(*) AS c FROM turn_outcomes`).get()?.c).toBe(0);
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
    expect(db.query<{ c: number }, []>(`SELECT count(*) AS c FROM turn_outcomes`).get()?.c).toBe(0);
    // …and the turn is still in the window, still waiting for its verdict.
    expect(db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM session_window WHERE in_window = 1`,
    ).get()?.c).toBe(1);

    // A second run against the same workspace: its prompt IS the follow-up.
    const next = new LocalAgentSession({ rt, db, model: fakeModel('here is the runbook'), onEvent: () => {} });
    await next.send('no — that summary missed the rollback step entirely');
    await next.end();

    const row = db.query<{ outcome: string; source: string }, []>(
      `SELECT outcome, source FROM turn_outcomes`,
    ).get();
    expect(row).toEqual({ outcome: 'corrected', source: 'classifier' });
    expect(db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM session_window WHERE in_window = 1`,
    ).get()?.c).toBe(2);
  });
});

describe('LocalAgentSession — AGENTS.md + session transcript recall', () => {
  test('injects the cwd AGENTS.md chain into the turn system prompt', async () => {
    const root = scratchDir('local-session-agentsmd');
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
  });

  test('omits the AGENTS.md block when no file exists up the tree', async () => {
    const root = scratchDir('local-session-noagents');
    // Ancestors of the tmpdir could theoretically carry an AGENTS.md on a
    // developer machine — only assert omission when the chain is truly empty.
    if (discoverAgentsMd(root).length > 0) return;
    let system = '';
    const { session } = setup('ok', systemCapturingModel('ok', (s) => { system = s; }), { cwd: root });
    await session.send('hello');
    expect(system.length).toBeGreaterThan(0);
    expect(system).not.toContain('Project instructions (AGENTS.md)');
    await session.end();
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
    const prompts: PromptMessage[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let calls = 0;
    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);
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
    });
    return { model, prompts, release };
  }

  /** Single-step model that streams one delta, then holds the turn open until
   *  release() — a deterministic window for mid-turn steering. */
  function gatedTextModel(answer: string) {
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async ({ abortSignal }) => ({
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
    });
    return { model, release };
  }

  const userTexts = (prompt: PromptMessage[]) =>
    prompt
      .filter((message): message is Extract<PromptMessage, { role: 'user' }> => message.role === 'user')
      .map((message) => message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''));

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
    const rows = db.query<{ role: string; content: string }, []>(
      `SELECT role, content FROM messages WHERE session_id = 'default' ORDER BY created_at, rowid`,
    ).all();
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
    const rows = db.query<{ role: string; content: string }, []>(
      `SELECT role, content FROM messages WHERE session_id = 'default' ORDER BY created_at, rowid`,
    ).all();
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

    const rows = db.query<{ role: string; content: string }, []>(
      `SELECT role, content FROM messages WHERE session_id = 'default' ORDER BY created_at, rowid`,
    ).all();
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

  test('an interrupted turn leaves a history the next turn can be assembled from', async () => {
    // The owner's 2026-08-16 report: he interrupted a turn mid-tool-call and the
    // session stopped being usable — every later attempt died with
    // `AI_MissingToolResultsError: Tool result is missing for tool call …`,
    // thrown by the AI SDK's own prompt assembly before any request goes out.
    // Call #1 announces a tool call and then withholds its step boundary, which
    // is exactly the window Ctrl+C lands in.
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompts: PromptMessage[][] = [];
    let calls = 0;
    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);
        calls += 1;
        if (calls === 1) {
          return {
            stream: new ReadableStream({
              async start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({
                  type: 'tool-call', toolCallId: 'call_ed15d29f352a4735e6b01b5', toolName: 'fact',
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
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'still here' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
    });

    const { session, events } = setup('unused', model);
    const turn = session.send('check the repo');
    await waitFor(() => events.some((e) => e.type === 'tool-call'));
    session.interrupt();
    release();
    await turn;
    // The interruption is recorded as one: the turn did not finish.
    expect(events.some((e) => e.type === 'error')).toBe(true);

    // The next turn is the assertion. Before the fix, `streamText` threw on
    // assembly and this model was never called a second time.
    const before = prompts.length;
    await session.send('what did you find?');
    expect(prompts.length).toBeGreaterThan(before);

    // And the interrupted call carries a terminal result, so the model reads the
    // interruption instead of a call that appears never to have happened.
    const last = prompts.at(-1) ?? [];
    const results = last.flatMap((message) => message.role === 'tool'
      ? message.content.filter((part) => part.type === 'tool-result') : []);
    expect(results.map((r) => r.toolCallId)).toContain('call_ed15d29f352a4735e6b01b5');
    await session.end();
  });

  test('a mid-stream failure keeps drained steers in the live context for the next turn', async () => {
    // Call #1 streams a tool call (steer drains at its step boundary), then
    // call #2 — which HAS seen the steer — dies mid-stream.
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompts: PromptMessage[][] = [];
    let calls = 0;
    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        prompts.push(options.prompt);
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
    });

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
      code: 'async () => 1', params: null, scope: 'local',
    });
    void rt.storage.sql`INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
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
      name: 'doomed_tool', description: 'soon retired', code: 'async () => 2', params: null, scope: 'local',
    });
    void rt.storage.sql`INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
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
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, action, observation, value, visits, depth, status)
                        VALUES ('win', 'win', 'pick a strategy', 'A', 'go with approach A', 0.9, 3, 1, 'open')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, action, observation, value, visits, depth, status)
                        VALUES ('win', 'alt', 'pick a strategy', 'B', 'go with approach B', 0.86, 2, 1, 'open')`;
    // In production the capture happens MID-turn (inside think-mcts), so its
    // timestamp falls inside the claiming turn's window. This seed runs
    // before send() — stamp it just ahead so the scoped claim sees it as a
    // mid-turn capture rather than a stale leftover.
    captureAlternateTakes(rt.storage.sql, { rootId: 'win', task: 'pick a strategy', winnerId: 'win', epsilon: 0.1, now: Date.now() + 1_000 });
    // Mirror converge()'s close: winner terminal, the near-tied rival pruned.
    void rt.storage.sql`UPDATE search_nodes SET status = 'terminal' WHERE id = 'win'`;
    void rt.storage.sql`UPDATE search_nodes SET status = 'pruned' WHERE id = 'alt'`;
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
    const erroringModel = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.error(new Error('provider exploded'));
          },
        }),
        response: { headers: {} },
      }),
    });
    const { session, rt, events } = setup('unused', erroringModel);
    seedTakes(rt);

    await session.send('solve it');

    expect(events.some((e) => e.type === 'error')).toBe(true);
    const turnEnd = events.find((event) => event.type === 'turn-end');
    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.hadError).toBe(true);
    // The seeded (unclaimed) take was purged, not claimed for the failed turn.
    expect(session.latestAlternateTakes()).toBeNull();
    await session.end();
  });

  // A BEHAVIOUR CHANGE, recorded as one: this turn's takes used to be purged.
  // The claim read `acc.hadError`, which the accumulator raises from the
  // transport discriminator on any failed tool result — so a turn that hit one
  // bad tool call, recovered and answered dropped its captures, while the cf
  // backend claimed them. The credit decision is now core's `creditedTurnId`
  // and reads whether the turn ENDED, which is what "an answer that no longer
  // exists" was reaching for.
  test('a turn that answered despite a failing tool call still claims its takes', async () => {
    let step = 0;
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    const failingToolModel = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async () => {
        step += 1;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              if (step === 1) {
                controller.enqueue({
                  type: 'tool-call', toolCallId: 'call-1', toolName: 'memory',
                  input: JSON.stringify({ action: 'save', content: 'note' }),
                });
                controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
              } else {
                controller.enqueue({ type: 'text-start', id: '0' });
                controller.enqueue({ type: 'text-delta', id: '0', delta: 'answered with A' });
                controller.enqueue({ type: 'text-end', id: '0' });
                controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              }
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      },
    });
    const { session, rt, events } = setup('unused', failingToolModel);
    rt.memory.append = async () => { throw new Error('disk full'); };
    seedTakes(rt);

    await session.send('solve it');

    const turnEnd = events.find((event) => event.type === 'turn-end');
    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.hadError).toBe(true);
    const turnId = rt.storage.sql<{ id: string }>`
      SELECT id FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1`[0]!.id;
    expect(session.latestAlternateTakes()).toMatchObject({ turnId, sessionId: 'default' });
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
    /** The LIVE turn's requests only — what "the live turn is never touched" is
     *  asserted against. A branch head's request is counted separately below, because
     *  both kinds now arrive through the same method. */
    const streamPrompts: PromptMessage[][] = [];
    let streams = 0;
    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      // THE LIVE TURN IS THE FIRST STREAM, and every later one is a branch head.
      // The two used to be told apart by METHOD — the live turn streamed, the head
      // called `doGenerate` — and that stopped being true when every agent kind
      // started issuing its request through the streaming path. Ordinal, because it
      // is the one thing the fixture actually knows: `session.send` opens the live
      // stream and holds the gate before `session.branch` is ever called.
      doStream: async ({ prompt, abortSignal }) => {
        streams += 1;
        if (streams > 1) {
          const text = branchAnswer();
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'text-start', id: 'b' });
                controller.enqueue({ type: 'text-delta', id: 'b', delta: text });
                controller.enqueue({ type: 'text-end', id: 'b' });
                controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
                controller.close();
              },
            }),
            response: { headers: {} },
          };
        }
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
    });
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
    const turnEnd = events.find((event) => event.type === 'turn-end');
    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.assistantResponse).toBe('the live answer');
    expect(streamPrompts).toHaveLength(1);

    // The settled pair: A = live answer (winner), B = branch answer, claimed
    // against the live turn's assistant message — the ONE takes pipeline.
    const set = session.latestAlternateTakes()!;
    expect(set.source).toBe('branch');
    expect(set.candidates.map((c) => c.text)).toEqual(['the live answer', 'the branch answer']);
    expect(set.candidates.map((c) => c.origin)).toEqual(['live', 'branch']);
    expect(set.winnerNodeId).toBe(set.candidates[0]!.nodeId);
    const assistant = db.query<{ id: string }, []>(
      `SELECT id FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get();
    if (!assistant) throw new Error('assistant message row is missing');
    const assistantId = assistant.id;
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
    const turnEnd = events.find((event) => event.type === 'turn-end');
    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.assistantResponse).toBe('the live answer');
    await session.end();
  });

  test('an interrupted live turn discards the branch — no takes set', async () => {
    let releaseBranch!: () => void;
    const branchGate = new Promise<void>((resolve) => { releaseBranch = resolve; });
    const { model } = branchableModel('never finishes', () => 'unused');
    model.doGenerate = async () => {
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
    const chunk = (choice: JsonObject, extra: JsonObject = {}) =>
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
    const completions: Array<{
      auth: string | null;
      affinity: string | null;
      model: JsonValue | undefined;
      stream: JsonValue | undefined;
    }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/api/cli/models') {
          return Response.json({
            models: [{
              spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'DeepSeek V4 Pro 0813', provider: 'workers-ai',
              capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 1048576,
            }],
            failures: [],
          });
        }
        if (path === '/api/user/ai/v1/chat/completions') {
          const body = v.parse(JsonObjectSchema, await request.json());
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
          model: DEFAULT_WORKERS_AI_MODEL_ID,
        },
        credentials: {},
        cloud: { origin, token: TOKEN, sessionAffinity: 'proteus-jarvis' },
      });
      const { db, session, events } = setupWithResolver(resolver);
      expect(session.getEffectiveModelSpec()).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);

      await session.send('hi from the laptop');

      const streamed = events
        .filter((event): event is Extract<SessionEvent, { type: 'text-delta' }> => event.type === 'text-delta')
        .map((event) => event.delta)
        .join('');
      expect(streamed).toBe('local cloud turn');
      const turnEnd = events.find((event) => event.type === 'turn-end');
      if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
      expect(turnEnd.turn.assistantResponse).toBe('local cloud turn');
      expect(turnEnd.turn.hadError).toBe(false);
      const rows = db.query<{ role: string }, []>(`SELECT role FROM messages ORDER BY created_at`).all();
      expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);

      expect(completions).toEqual([{
        auth: `Bearer ${TOKEN}`,
        affinity: 'proteus-jarvis',
        model: DEFAULT_WORKERS_AI_MODEL_ID,
        stream: true,
      }]);

      // /model parity at the session surface: the worker menu's metadata flows.
      const { models } = await session.listAvailableModels();
      const deepseek = models.find((m) => m.provider === 'workers-ai' && m.id === DEFAULT_WORKERS_AI_MODEL_ID);
      expect(deepseek?.contextWindow).toBe(1048576);
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

    const runId = session.listRuns().items[0]!.runId;
    const streamed = events
      .filter((e): e is Extract<SessionEvent, { type: 'run-event' }> => e.type === 'run-event')
      .map((e) => e.event);
    expect(streamed).toEqual(session.getRunEvents(runId));

    await session.end();
  });

  test('a search lands in the ledger with what it produced and what it cost', async () => {
    // Head phases were broadcast-only here while the DO recorded them, so every
    // local run — and therefore every benchmark trial — left no durable trace of
    // a delegated search at all: that one came back empty could only be found by
    // reading trajectories by hand.
    //
    // A search on the interactive surface detaches the instant it spawns
    // (defect A), so the durable trace has two halves and this walks both. The
    // run ledger records the DISPATCH — the call exactly as sent, and the job it
    // handed off to — while the settled job row records what the run came back
    // with. settleBackgroundWork() drains the job; the dispatch row is found by
    // the tool that wrote it rather than by run recency, since the wake turn's
    // run can easily be the newer one.
    const { db, session } = setup('unused', searchingModel());
    await session.send('go');
    await session.settleBackgroundWork();

    const events = session.listRuns().items.flatMap((r) => session.getRunEvents(r.runId));
    const dispatch = events.find((e): e is Extract<typeof events[number], { type: 'tool_call_end' }> =>
      e.type === 'tool_call_end' && e.name === 'agents');
    expect(dispatch).toBeDefined();
    // The call as SENT, so a reader of the ledger knows which search this was
    // rather than only that one happened.
    expect(dispatch!.args).toMatchObject({
      action: 'swarm', task: 'explore two angles', preset: 'ideate', branches: 2, depth: 1,
    });

    const job = v.parse(
      v.object({ id: v.string(), status: v.string() }),
      db.query(`SELECT id, status FROM background_jobs WHERE kind = 'agents'`).get(),
    );
    expect(job.status).toBe('completed');
    // The halves are LINKED: the dispatch row names the job that carries the
    // outcome, so the ledger never leaves a spawn with no reachable result.
    expect(String(dispatch!.result)).toContain(job.id);

    // What it PRODUCED and what it COST, off the settled row: two branches
    // expanded, two candidates back, and the tokens they burned.
    const settled = v.parse(
      v.object({
        report: v.object({ stop: v.string(), expansions: v.number(), tokens: v.number() }),
        candidates: v.array(v.object({ artifact: v.string() })),
      }),
      JSON.parse(jobResult(db, job.id)),
    );
    expect(settled.report.stop).toBe('settled');
    expect(settled.report.expansions).toBe(2);
    expect(settled.candidates).toHaveLength(2);
    expect(settled.report.tokens).toBeGreaterThan(0);

    await session.end();
  });

  test('a turn that dies before its stream exists still terminates: error, turn-end, run_end', async () => {
    // The regression this pins: 2 of ~7 `proteus exec` runs ended mid-turn with
    // no error event, no turn_end, no run_end and no final message, correlating
    // with heavy provider 429s — and exited 0. Everything before the turn's own
    // stream (model resolution, skills, the system prompt) sat OUTSIDE any
    // failure path, so a throw there escaped past an already-opened run, was
    // logged to stderr by the pump, and resolved the caller as if the turn had
    // simply produced nothing.
    const { db, rt } = workspaceRuntime();
    // Fails where the real runs did: in the per-turn setup, before the turn's
    // stream (and so before any failure path) exists. Which specific setup call
    // failed in production was never isolated; that the region had no failure
    // path at all is what this pins.
    const failing = {
      ...rt,
      memory: {
        ...rt.memory,
        read: async () => { throw new Error('Failed after 3 attempts. Last error: Too Many Requests'); },
      },
    };
    const events: SessionEvent[] = [];
    const session = new LocalAgentSession({
      rt: failing, db, model: fakeModel('never reached'),
      onEvent: (e) => events.push(e), noAutoEvolve: true,
    });

    await session.send('write the target file');

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type === 'error' && errors[0].message).toContain('Too Many Requests');

    const ends = events.filter((e) => e.type === 'turn-end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.type === 'turn-end' && ends[0].turn.hadError).toBe(true);

    // The durable ledger has to agree — an open run is a run nothing can read
    // back as finished.
    const runs = session.listRuns().items;
    expect(runs).toHaveLength(1);
    const runEvents = session.getRunEvents(runs[0]!.runId);
    expect(runEvents.at(-1)?.type).toBe('run_end');
    const end = runEvents.find((e) => e.type === 'run_end');
    expect(end?.reason).toBe('error');
    expect(end?.error).toContain('Too Many Requests');

    await session.end();
  });

  test('a turn records a replayable run in run_events', async () => {
    // Backend parity: the DO persists every run into run_events and can replay
    // it (list_run_events / SSE Last-Event-ID resume). The CLI recorded nothing
    // at all, so a local workspace had no run history — despite having the very
    // same SQLite the cf recorder is written against.
    const { session } = setup('hello there');
    await session.send('hi');

    const runs = session.listRuns().items;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventCount).toBeGreaterThan(0);

    const events = session.getRunEvents(runs[0]!.runId);
    // `turn_steering` belongs here: this is the session's FIRST turn, so the
    // step-0 delegation hint fires (turn-steering.ts's freshAsk — no assistant
    // message yet, and the ask is not a question), and the settle spine records
    // every hint it spliced. A first turn with no steering row would mean the
    // hint never reached the model.
    expect(events.map((e) => e.type)).toEqual([
      'run_start', 'turn_start', 'step_finish', 'turn_steering', 'turn_end', 'run_end',
    ]);

    const start = events[0];
    if (!start || start.type !== 'run_start') throw new Error('run_start event is missing');
    expect(start.caused_by).toBe('chat');
    expect(start.userMessage).toBe('hi');

    const end = events.at(-1);
    if (!end || end.type !== 'run_end') throw new Error('run_end event is missing');
    expect(end.reason).toBe('completed');
    expect(end.error).toBeUndefined();

    // Monotonic indices are what makes a resume possible at all.
    expect(events.map((e) => e.eventIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    // …and `since` replays the tail, exactly as an SSE Last-Event-ID does.
    expect(session.getRunEvents(runs[0]!.runId, { since: 3 }).map((e) => e.type))
      .toEqual(['turn_steering', 'turn_end', 'run_end']);

    await session.end();
  });

  test('a programmatic turn records its trigger, and each turn is its own run', async () => {
    const { session } = setup('done');
    await session.send('first');
    await session.enqueueTurn({ text: 'job finished', metadata: { proteusEvent: 'background_job' } });
    await waitFor(() => session.listRuns().items.length === 2);

    const runs = session.listRuns().items;
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);
    const causes = runs.map((r) => {
      const start = session.getRunEvents(r.runId)[0];
      return start?.type === 'run_start' ? start.caused_by : null;
    });
    expect(causes.sort()).toEqual(['background_job', 'chat']);

    await session.end();
  });

  test('a failed turn seals the run with the provider error text', async () => {
    const exploding = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async () => { throw new Error('upstream is on fire'); },
    });
    const { session } = setup('unused', exploding);
    await session.send('hi');

    const run = session.listRuns().items[0]!;
    const end = session.getRunEvents(run.runId).at(-1);
    expect(end?.type).toBe('run_end');
    expect(end).toMatchObject({ reason: 'error', error: expect.stringContaining('upstream is on fire') });

    await session.end();
  });

  // The judge, the fast tier, the reflection seam and the heads' merge are built
  // with the RUNTIME (createCLIRuntime), before a session exists, so the session
  // installs itself as their ledger afterwards. Capturing what it installed is
  // therefore how a test reaches those producers at all — there is no other door.
  /** A one-slot box for the sink the session installs. A bare `let` cannot do
   *  this job: the assignment happens inside a callback, so TypeScript narrows
   *  the captured binding to `never` at the call site. */
  interface SinkSlot { sink: ModelCallSink | null }

  function capturedSink() {
    const { db, rt } = workspaceRuntime();
    const captured: SinkSlot = { sink: null };
    const session = new LocalAgentSession({
      rt: { ...rt, setModelCallSink: (sink) => { captured.sink = sink; } },
      db, model: fakeModel('unused'), onEvent: () => {}, noAutoEvolve: true,
    });
    return { session, captured };
  }

  test('a non-turn model call lands as its own row, and a silent provider stays unmeasured', async () => {
    const { session, captured } = capturedSink();
    expect(captured.sink).not.toBeNull();

    captured.sink?.({ source: 'judge', usage: { input: 41, output: 7 }, spec: 'anthropic/claude-x' });
    // A provider that reported nothing STILL writes a row. This is the whole
    // point: unmeasured spend has to read as unmeasured, never as free.
    captured.sink?.({ source: 'fast', usage: {} });

    // Between runs, so both are filed under the reserved workspace run rather
    // than dropped — half these producers never fire inside a turn.
    const rows = session.getRunEvents(WORKSPACE_RUN_ID).filter((e) => e.type === 'model_call');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: 'judge', usage: { input: 41, output: 7 }, spec: 'anthropic/claude-x',
    });
    expect(rows[1]).toMatchObject({ source: 'fast', usage: {} });
    // Never priced at the ACTOR's rate: a judge deliberately runs on another
    // model, so a usd here would be a number nobody measured.
    expect(rows[0]).not.toHaveProperty('usd');
    expect(rows[1]).not.toHaveProperty('usd');

    await session.end();
  });

  test('a call made during a turn is filed under that run, not the workspace bucket', async () => {
    const { db, rt } = workspaceRuntime();
    const captured: SinkSlot = { sink: null };
    // Reported from inside the model call itself, which is when a real judge or
    // fast-tier call fires: mid-turn, with a run open.
    const model = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async (options) => {
        captured.sink?.({ source: 'reflection', usage: { input: 3 } });
        return fakeModel('answered').doStream(options);
      },
    });
    const session = new LocalAgentSession({
      rt: { ...rt, setModelCallSink: (sink) => { captured.sink = sink; } },
      db, model, onEvent: () => {}, noAutoEvolve: true,
    });
    await session.send('hi');

    const runId = session.listRuns().items[0]!.runId;
    expect(runId).not.toBe(WORKSPACE_RUN_ID);
    expect(session.getRunEvents(runId).filter((e) => e.type === 'model_call'))
      .toMatchObject([{ source: 'reflection', usage: { input: 3 } }]);
    expect(session.getRunEvents(WORKSPACE_RUN_ID)).toEqual([]);

    await session.end();
  });
});

// ── agents.* in the node codemode sandbox ───────────────────────────────────
// The bridge that makes a crafted tool able to BE a workflow: LLM-authored JS
// delegating with plain control flow. Exercised through the REAL node sandbox
// (`new Function` over the real provider bindings). A search runs its branches
// in THIS process off the deps' runtime and model, so the MODEL is the seam
// every search below is scripted and observed through — there is no strategy
// in between to script instead.

describe('agents.* codemode namespace — node sandbox', () => {
  /** The node factory with only the agents provider bound, so the code under
   *  test is the sandbox + the projection and nothing else. */
  function sandboxWith(deps: AgentsToolDeps) {
    const tool = createNodeExecuteToolFactory({
      extraProviders: [createAgentsCodemodeProvider(() => deps)],
    })({ craftedTools: () => ({}), providers: [], loader: {} });
    return (code: string, options?: ToolExecutionOptions) =>
      toolExecute<{ code: string }, JsonValue>(tool)({ code }, options);
  }

  interface SearchSandbox {
    deps: AgentsToolDeps;
    /** Every model call the search's expansions made, in call order. */
    calls: Array<{ prompt: string; signal?: AbortSignal }>;
  }

  /** The exploration substrate a local session wires, with the node model
   *  scripted to answer without a network and to record what it was asked. */
  function searchSandbox(answer = 'one approach'): SearchSandbox {
    const calls: SearchSandbox['calls'] = [];
    const base = fakeModel(answer);
    const record = (options: LanguageModelV2CallOptions) => {
      calls.push({ prompt: JSON.stringify(options.prompt), signal: options.abortSignal });
    };
    const model = new TestLanguageModelV2({
      provider: base.provider,
      modelId: base.modelId,
      doGenerate: async (options) => { record(options); return base.doGenerate(options); },
      doStream: async (options) => { record(options); return base.doStream(options); },
    });
    const db = new Database(':memory:');
    const rt = createCLIRuntime(db, { dbPath: ':memory:', llm: DUMMY_LLM });
    // The registry is empty deliberately: a search dispatches through no
    // strategy, so a registration here would script a path it does not take.
    // `AgentsForkDeps` still declares the field, so it is still passed.
    return { deps: { mode: 'build', fork: { registry: createStrategyRegistry(), rt, model } }, calls };
  }

  test('a script searches, branches on the result, and returns its own synthesis', async () => {
    const { deps, calls } = searchSandbox();
    const run = sandboxWith(deps);
    // The shape a workflow actually has: fan out, inspect, decide, aggregate.
    const result = await run(`
      const angles = ['auth', 'billing'];
      const searched = await Promise.all(angles.map((a) => agents.swarm({
        task: 'review ' + a, preset: 'ideate', branches: 2, depth: 1,
      })));
      const ran = searched.filter((s) => !s.reason && s.report.expansions === 2);
      return { count: ran.length, branches: ran.map((s) => s.caps.branches.value) };
    `);
    expect(result).toEqual({ result: { count: 2, branches: [2, 2] } });
    // Each search reached the model carrying its OWN task, so the typed call
    // fields arrive at the run rather than only surviving the parse.
    const asked = calls.map((call) => call.prompt).join('\n');
    expect(asked).toContain('review auth');
    expect(asked).toContain('review billing');
  });

  test('a sandbox search runs in-process, and one with no preset is refused', async () => {
    const { deps, calls } = searchSandbox();
    const run = sandboxWith(deps);
    const dispatched = v.parse(
      v.object({ result: v.object({ preset: v.string(), report: v.object({ expansions: v.number() }) }) }),
      await run(`return await agents.swarm({ task: 'pick an approach', preset: 'ideate', branches: 2, depth: 1 });`),
    );
    expect(dispatched.result.preset).toBe('ideate');
    // The branches ran here, on this plane, and came back as a report — there
    // is no strategy and no facet between the sandbox call and the run.
    expect(dispatched.result.report.expansions).toBe(2);
    const expanded = calls.length;
    expect(expanded).toBeGreaterThan(0);
    // `preset` is the SHAPE of the search and none can be invented for a call
    // that named none, so it is refused before anything expands — and the
    // refusal names the missing field rather than only the action.
    const refused = v.parse(
      v.object({ result: v.object({ reason: v.literal('bad_input'), error: v.string() }) }),
      await run(`return await agents.swarm({ task: 'pick an approach' });`),
    );
    expect(refused.result.error).toContain('swarm needs `preset`');
    expect(calls).toHaveLength(expanded);
  });

  test('a search refusal is a value the script can branch on, not a sandbox failure', async () => {
    const { deps, calls } = searchSandbox();
    // An illegal COMPOSITION rather than a missing field: `ideate` is flat by
    // design, so an objective riding it is refused on the axis. The script
    // reads that refusal as an ordinary return value and recovers from it.
    const result = await sandboxWith(deps)(`
      const searched = await agents.swarm({
        task: 't', preset: 'ideate',
        objective: {
          kind: 'scalar', metric: 'ms', unit: 'ms', direction: 'minimise',
          scale: 'linear', target: 1, verify: { kind: 'exec-ratio', spec: {} },
        },
      });
      return searched.error ? 'recovered: ' + searched.error.includes('no value signal') : 'no error';
    `);
    expect(result).toEqual({ result: 'recovered: true' });
    // Refused on the shape, so nothing was spent discovering it.
    expect(calls).toEqual([]);
  });

  test('the turn abort signal reaches a search started inside the sandbox', async () => {
    // An agent node is not cancelled by an `abortSignal` on its model call — it
    // is polled — so the signal's arrival is observable where it has an EFFECT:
    // the run's own stop reason. A turn already cancelled when the script calls
    // out has to stop the search before it expands anything, not after.
    const { deps, calls } = searchSandbox();
    const controller = new AbortController();
    controller.abort();
    const result = v.parse(
      v.object({ result: v.object({ report: v.object({ stop: v.string(), expansions: v.number() }) }) }),
      await sandboxWith(deps)(
        `return await agents.swarm({ task: 't', preset: 'ideate', branches: 2, depth: 1 });`,
        { abortSignal: controller.signal, toolCallId: 'swarm-abort-test', messages: [] },
      ),
    );
    expect(result.result.report.stop).toBe('aborted');
    expect(result.result.report.expansions).toBe(0);
    expect(calls).toEqual([]);
  });

  test('ungated actions are structurally absent from the local sandbox', async () => {
    const { deps } = searchSandbox();
    const result = await sandboxWith(deps)(
      'return { members: Object.keys(agents), hire: typeof agents.hire, swarm: typeof agents.swarm };',
    );
    // Local sessions wire the exploration SUBSTRATE only — no daemon routes
    // hiring or peer mail — and the single rung that substrate carries is the
    // search: a model to expand with and a workspace to measure in.
    expect(result).toEqual({ result: { members: ['swarm'], hire: 'undefined', swarm: 'function' } });
  });

  test('a live session turn gets the namespace, gated to what it actually wired', async () => {
    // The production wiring, end to end: a real turn, the real toolset, the
    // real sandbox. The script reports what it can reach by writing to the
    // workspace, which is how sandbox code returns anything durable anyway.
    const { rt, session, events } = setup('done', executeToolsModel(`
      await workspace.writeFile('/workspace/probe/agents.json', JSON.stringify({
        members: Object.keys(agents), swarm: typeof agents.swarm, hire: typeof agents.hire,
      }));
      return 'probed';
    `));
    await session.send('what can you delegate to?');
    expect(events.some((e) => e.type === 'tool-result' && e.toolName === 'execute_tools' && e.success)).toBe(true);
    // Local sessions wire the exploration substrate only, and the search is the
    // one rung that rides it.
    const probe = await rt.storage.vfs.readFile('/workspace/probe/agents.json', { encoding: 'utf8' });
    expect(JSON.parse(String(probe))).toEqual({
      members: ['swarm'], swarm: 'function', hire: 'undefined',
    });
    await session.end();
  });

  test('local sessions reject Plan rather than presenting a mode with no review surface', async () => {
    const probeCode = (path: string) => `
      await workspace.writeFile('${path}', JSON.stringify({
        releaseType: typeof release,
        workspaceType: typeof workspace,
      }));
      return 'probed';
    `;
    const plan = setup('done', executeToolsModel(probeCode('/workspace/probe/plan-tools.json')));
    await expect(plan.session.enqueueTurn({
      text: 'research a plan', metadata: { proteusMode: 'plan' },
    })).rejects.toThrow('hosted workspace UI');
    expect(await plan.rt.storage.vfs.exists('/workspace/probe/plan-tools.json')).toBe(false);
    await plan.session.end();

    // Ordinary local Build behavior stays unchanged.
    const build = setup('done', executeToolsModel(probeCode('/workspace/probe/build-tools.json')));
    await build.session.send('implement the change');
    const buildProbe = JSON.parse(String(await build.rt.storage.vfs.readFile(
      '/workspace/probe/build-tools.json',
      { encoding: 'utf8' },
    )));
    expect(buildProbe).toEqual({ releaseType: 'object', workspaceType: 'object' });
    await build.session.end();
  });
});

// ── the mechanical completion gate ──────────────────────────────────────────
// A one-shot run is graded on what it leaves behind with nobody reading the
// answer, so the harness takes its own look before letting the process go. The
// two properties worth pinning: the trigger is what the turn DID, and the
// evidence is read by the harness — so no claim of success can satisfy it.

/** A model that runs one shell command, answers, and (on the confirming turn)
 *  answers again. `confirmWith` is what it does when the gate comes back:
 *  'text' = it just re-asserts, 'tool' = it goes back to work. */
function runThenAnswerModel(confirmWith: 'text' | 'tool' = 'text'): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let step = 0;
  const answer = (controller: ReadableStreamDefaultController, text: string) => {
    controller.enqueue({ type: 'text-start', id: '0' });
    controller.enqueue({ type: 'text-delta', id: '0', delta: text });
    controller.enqueue({ type: 'text-end', id: '0' });
    controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
  };
  const call = (controller: ReadableStreamDefaultController, id: string, command: string) => {
    controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: 'run', input: JSON.stringify({ command }) });
    controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
  };
  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-model',
    doStream: async () => {
      step += 1;
      const at = step;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (at === 1) call(controller, 'call-1', 'echo working');
            else if (at === 2) answer(controller, 'all done, the task is complete');
            else if (at === 3 && confirmWith === 'tool') call(controller, 'call-2', 'echo fixing');
            else answer(controller, 'confirmed');
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

const gateTurn = (events: SessionEvent[]) =>
  turnStarts(events).find((t) => t.event === 'completion_gate');

describe('LocalAgentSession — the one-shot completion gate', () => {
  test('a one-shot turn that did work gets one more turn carrying state the HARNESS read', async () => {
    const { session, events } = setup('unused', runThenAnswerModel(), { oneShot: true });
    await session.send('write the report');
    await session.settleBackgroundWork();

    const gate = gateTurn(events);
    expect(gate).toBeDefined();
    // Harness-authored, and the model's "the task is complete" did not prevent it.
    expect(gate!.text).toContain('[Runtime check');
    expect(gate!.text).toContain('write the report');
    // Observed, not asserted: the real probe output from the real shell.
    expect(gate!.text).toContain('$ pwd');
    expect(gate!.text).toContain('$ ls -la');

    // Exactly one gate, and it does not gate itself into a loop.
    expect(turnStarts(events).filter((t) => t.event === 'completion_gate')).toHaveLength(1);
    await session.end();
  });

  test('the gate is not armed on the interactive surface, where a human is the check', async () => {
    const { session, events } = setup('unused', runThenAnswerModel());
    await session.send('write the report');
    await session.settleBackgroundWork();

    expect(gateTurn(events)).toBeUndefined();
    await session.end();
  });

  test('a turn that called no tools is not gated — it left no state to check', async () => {
    const { session, events } = setup('just answering', undefined, { oneShot: true });
    await session.send('what is 2 + 2');
    await session.settleBackgroundWork();

    expect(gateTurn(events)).toBeUndefined();
    await session.end();
  });

  test('a failed turn is not gated — it already reported the failure', async () => {
    const exploding = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doStream: async () => { throw new Error('upstream is on fire'); },
    });
    const { session, events } = setup('unused', exploding, { oneShot: true });
    await session.send('write the report');
    await session.settleBackgroundWork();

    expect(gateTurn(events)).toBeUndefined();
    await session.end();
  });

  test('the confirming turn records whether the re-look converted into real work', async () => {
    const { session } = setup('unused', runThenAnswerModel('tool'), { oneShot: true });
    await session.send('write the report');
    await session.settleBackgroundWork();

    const gateRun = session.listRuns().items
      .map((r) => session.getRunEvents(r.runId))
      .find((evs) => evs.some((e) => e.type === 'completion_gate'));
    expect(gateRun).toBeDefined();
    expect(gateRun!.find((e) => e.type === 'completion_gate')).toMatchObject({ converted: true });
    await session.end();
  });

  test('a re-look that only re-asserts is recorded as an honest non-conversion', async () => {
    const { session } = setup('unused', runThenAnswerModel('text'), { oneShot: true });
    await session.send('write the report');
    await session.settleBackgroundWork();

    const rows = session.listRuns().items
      .flatMap((r) => session.getRunEvents(r.runId))
      .filter((e) => e.type === 'completion_gate');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ converted: false });
    await session.end();
  });
});

// The two axes, proven on the prompt the model is ACTUALLY handed — not on the
// builder in isolation, and not on a source grep. `systemCapturingModel` reads
// the role:'system' entry off the LanguageModelV2 call.
describe('LocalAgentSession — provenance and stance reach the model', () => {
  test('a background-job wake carries the resume guidance even though it also carries a work mode', async () => {
    // jobs/runner.ts stamps BOTH proteusEvent and proteusMode on the wake, and
    // `background_jobs.work_mode` is never null. Under the old single-`mode`
    // precedence the work mode won and this guidance — written to stop the
    // agent re-doing or polling work that already settled — never reached a
    // model on the real wake path.
    let system = '';
    const { session } = setup('ok', systemCapturingModel('ok', (s) => { system = s; }));
    await session.enqueueTurn({
      text: 'job bgjob-1 finished',
      metadata: { proteusEvent: 'background_job', proteusMode: 'build' },
    });
    expect(system).toContain('Background-resume mode');
    expect(system).toContain('fetch the referenced job result first');
    await session.end();
  });

  test('an ordinary turn carries neither overlay, and no Turn mode line', async () => {
    let system = '';
    const { session } = setup('ok', systemCapturingModel('ok', (s) => { system = s; }));
    await session.send('do it');
    expect(system).not.toContain('Background-resume mode');
    // Auto is the absence of constraint: it announces nothing, so an Auto turn
    // and a chat turn share the same cacheable prefix.
    expect(system).not.toContain('Turn mode');
    await session.end();
  });

  test('a stance the agent sets through `tasks` is in the next turn\'s system prompt', async () => {
    // Durable across sessions, because that is what a stance is: the second
    // session builds its prompt from the same workspace config the first
    // session's tool call wrote.
    const { db, rt } = workspaceRuntime();
    const events: SessionEvent[] = [];
    const setter = new LocalAgentSession({
      rt, db, noAutoEvolve: true, onEvent: (e) => events.push(e),
      model: toolSequenceModel([{ name: 'tasks', input: { action: 'mode', stance: 'research' } }]),
    });
    await setter.send('work carefully from here');
    await setter.end();

    let system = '';
    const next = new LocalAgentSession({
      rt, db, noAutoEvolve: true, onEvent: (e) => events.push(e),
      model: systemCapturingModel('ok', (s) => { system = s; }),
    });
    await next.send('carry on');
    expect(system).toContain('Research stance:');
    expect(system).toContain('name the file and line each claim rests on');
    await next.end();
  });
});
