/**
 * One scripted conversation through the local backend, and the durable rows
 * it leaves — the observable the ChatSession extraction is held to.
 *
 * The script covers every arm of the loop the extraction moved: an idle send,
 * a send mid-turn carrying a file, an interrupt that returns a steer, a process
 * that dies after acknowledging a send and before the drain, and the restart
 * that replays what it left. What is compared is the durable record —
 * `actor_messages`, the pending-send ledger, the event log, the terminal
 * ledger — and the event stream the frontend saw, with every minted id and
 * every clock reading normalized so the same conversation reads the same on
 * any run.
 *
 * `chat-session-parity.test.ts` asserts the snapshot against the one recorded
 * before the extraction; the recorder that wrote that fixture ran this same
 * scenario on the pre-extraction tree.
 */
import { Database } from 'bun:sqlite';
import { scratchPath } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { decodeJsonValue, initWorkspaceSchema, JsonValueSchema, type JsonValue } from '@kinu.run/core';
import type { LanguageModelV2CallOptions, LanguageModelV2Usage } from '@ai-sdk/provider';
import type { LLMProviderConfig } from '@kinu.run/core';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

type PromptMessage = LanguageModelV2CallOptions['prompt'][number];

/** Streams one answer in two deltas and finishes. */
function answeringModel(answer: string): TestLanguageModelV2 {
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: a });
          controller.enqueue({ type: 'text-delta', id: '0', delta: b });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  });
}

/**
 * A turn held open at two points: call #1 announces a tool call and parks on
 * `stepGate` (the mid-turn window), call #2 parks on `endGate` after the steer
 * has landed and before the answer commits. Every later call answers at once.
 */
function drainWindowModel(answer: string) {
  const prompts: PromptMessage[][] = [];
  const stepGate = Promise.withResolvers<void>();
  const endGate = Promise.withResolvers<void>();
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
              options.abortSignal?.addEventListener('abort', () => {
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              }, { once: true });
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'tool-call', toolCallId: 'call-1', toolName: 'fact',
                input: JSON.stringify({ action: 'recall', key: 'probe' }),
              });
              await stepGate.promise;
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      }

      return {
        stream: new ReadableStream({
          async start(controller) {
            options.abortSignal?.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            await endGate.promise;
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

  return { model, prompts, stepGate, endGate };
}

/** Streams one delta, then holds the turn open until released or aborted. */
function gatedTextModel(answer: string) {
  const gate = Promise.withResolvers<void>();

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
          await gate.promise;

          if (abortSignal?.aborted) return;
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  });

  return { model, release: gate.resolve };
}

/** A model that hands each call to the next script in the list. */
function sequencedModel(scripts: readonly TestLanguageModelV2[]): TestLanguageModelV2 {
  let next = 0;

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: (options) => {
      const script = scripts[next];

      if (script === undefined) throw new Error(`the scenario scripted ${String(scripts.length)} model calls and a ${String(next + 1)}th arrived`);
      next += 1;

      return script.doStream(options);
    },
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;

  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor: condition not met');
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 5);
    await tick.promise;
  }
}

/** The events of the n-th turn (1-based) a session has started, so a wait
 *  reads that turn's own stream and not an earlier turn's leftovers. */
function turnEvents(events: readonly SessionEvent[], n: number): readonly SessionEvent[] {
  let starts = 0;
  const from = events.findIndex((event) => event.type === 'turn-start' && ++starts === n);

  return from === -1 ? [] : events.slice(from);
}

const NOTE_FILE = { filename: 'note.txt', mediaType: 'text/plain', url: 'data:text/plain;base64,aGVsbG8=' };

/** What one session's frontend saw, reduced to what the script decides. */
function frontendView(event: SessionEvent): JsonValue {
  switch (event.type) {
    case 'turn-start': return { type: event.type, kind: event.kind, text: event.text, workMode: event.workMode, ...(event.event !== undefined && { event: event.event }) };
    case 'text-delta': return { type: event.type, delta: event.delta };
    case 'tool-call': return { type: event.type, toolName: event.toolName, toolCallId: event.toolCallId };
    case 'tool-result': return { type: event.type, toolName: event.toolName, toolCallId: event.toolCallId, success: event.success };
    case 'turn-end': return {
      type: event.type, origin: event.turn.origin ?? null, userMessage: event.turn.userMessage,
      assistantResponse: event.turn.assistantResponse, toolCalls: event.turn.toolCalls.length,
    };
    case 'error': return { type: event.type, message: event.message };
    case 'evolution':
    case 'background': return { type: event.type, event: event.event, message: event.message };
    case 'broadcast': return { type: event.type, event: event.event.type };
    case 'run-event': return { type: event.type, event: event.event.type };
    default: return event satisfies never;
  }
}

/**
 * Every minted id and clock reading replaced by its order of appearance, so
 * two runs of one conversation compare equal on everything the script decides.
 */
function normalizer() {
  const seen = new Map<string, string>();
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const STEER = /\bsteer-[A-Za-z0-9_-]{12}\b/g;
  const CLOCK_KEY = /(?:At|Ms|_at|_ms)$/;

  const name = (id: string, kind: string): string => {
    const known = seen.get(id);

    if (known !== undefined) return known;
    const minted = `<${kind}#${String(seen.size + 1)}>`;
    seen.set(id, minted);

    return minted;
  };

  const text = (value: string): string =>
    value.replace(UUID, (id) => name(id, 'uuid')).replace(STEER, (id) => name(id, 'steer'));

  const json = (value: JsonValue): JsonValue => {
    if (v.is(v.string(), value)) return text(value);

    if (Array.isArray(value)) return value.map(json);

    if (v.is(v.record(v.string(), JsonValueSchema), value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
        [key, CLOCK_KEY.test(key) && v.is(v.number(), entry) ? '<clock>' : json(entry)]));
    }

    return value;
  };

  /** A whole-column id (an event-log id, a trace id) that has no recognisable shape. */
  const opaque = (value: string | null, kind: string): string | null => value === null ? null : name(value, kind);

  return { text, json, opaque };
}

/** The durable record at one point of the script: one row per entry. */
const DurableRowsSchema = v.object({
  actorMessages: v.array(JsonValueSchema),
  pendingSteers: v.array(JsonValueSchema),
  pendingSteerFiles: v.array(JsonValueSchema),
  agentLog: v.array(JsonValueSchema),
  terminalEffects: v.array(JsonValueSchema),
});

export type DurableRows = v.InferOutput<typeof DurableRowsSchema>;

/** The record the scenario leaves, and the shape the fixture is read back as. */
export const ParitySnapshotSchema = v.object({
  /** After the mid-turn send with a file has landed and its turn committed. */
  afterTwo: DurableRowsSchema,
  /** What the dead process left: its acknowledged sends, unreplayed. */
  beforeRestart: DurableRowsSchema,
  /** After the restart replayed them and answered a fresh send. */
  end: DurableRowsSchema,
  /** What each session's frontend saw, in order. */
  events: v.array(v.array(JsonValueSchema)),
  /** What each driver call answered. */
  landings: JsonValueSchema,
});

export type ParitySnapshot = v.InferOutput<typeof ParitySnapshotSchema>;

function durableRows(db: Database, norm: ReturnType<typeof normalizer>): DurableRows {
  const parseJson = (column: string | null): JsonValue => column === null ? null : norm.json(decodeJsonValue({ value: JSON.parse(column) }));

  const actorMessages = db.query<{
    id: string; session_id: string; parent_id: string | null; role: string; content: string; metadata: string | null;
  }, []>(`SELECT id, session_id, parent_id, role, content, metadata FROM actor_messages ORDER BY rowid`).all()
    .map((row) => ({
      id: norm.text(row.id), sessionId: row.session_id,
      parentId: row.parent_id === null ? null : norm.text(row.parent_id),
      role: row.role, content: row.content, metadata: parseJson(row.metadata),
    }));

  const pendingSteers = db.query<{ id: string; turn_id: string | null; mode: string; text: string }, []>(
    `SELECT id, turn_id, mode, text FROM pending_steers ORDER BY seq`,
  ).all().map((row) => ({
    id: norm.text(row.id), turnId: row.turn_id === null ? null : norm.text(row.turn_id), mode: row.mode, text: row.text,
  }));

  const pendingSteerFiles = db.query<{ steer_id: string; filename: string; media_type: string; url: string }, []>(
    `SELECT steer_id, filename, media_type, url FROM pending_steer_files ORDER BY seq`,
  ).all().map((row) => ({ steerId: norm.text(row.steer_id), filename: row.filename, mediaType: row.media_type, url: row.url }));

  const agentLog = db.query<{
    id: string; kind: string; turn_id: string | null; step_idx: number | null; parent_id: string | null;
    trace_id: string; ingress: string | null; variant: string | null; trust: string | null; priority: string | null;
    payload: string; dedupe_key: string | null; consumed_at: number | null;
  }, []>(`SELECT id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant, trust, priority, payload, dedupe_key, consumed_at
          FROM agent_log ORDER BY rowid`).all()
    .map((row) => ({
      id: norm.opaque(row.id, 'log'), kind: row.kind,
      turnId: row.turn_id === null ? null : norm.text(row.turn_id), stepIdx: row.step_idx,
      parentId: norm.opaque(row.parent_id, 'log'), traceId: norm.opaque(row.trace_id, 'trace'),
      ingress: row.ingress, variant: row.variant, trust: row.trust, priority: row.priority,
      payload: parseJson(row.payload), dedupeKey: row.dedupe_key === null ? null : norm.text(row.dedupe_key),
      consumed: row.consumed_at !== null,
    }));

  const terminalEffects = db.query<{
    sequence_id: string; effect_key: string; effect_name: string; scope: string; seq: number;
    input_json: string; lane: string; status: string; outcome: string | null; attempts: number; settled_at: number | null;
  }, []>(`SELECT sequence_id, effect_key, effect_name, scope, seq, input_json, lane, status, outcome, attempts, settled_at
          FROM terminal_effects ORDER BY rowid`).all()
    .map((row) => ({
      sequenceId: norm.text(row.sequence_id), effectKey: norm.text(row.effect_key), effectName: row.effect_name,
      scope: norm.text(row.scope), seq: row.seq, input: parseJson(row.input_json), lane: row.lane,
      status: row.status, outcome: row.outcome === null ? null : norm.text(row.outcome), attempts: row.attempts,
      settled: row.settled_at !== null,
    }));

  return { actorMessages, pendingSteers, pendingSteerFiles, agentLog, terminalEffects };
}

/**
 * Drive the scripted conversation over a fresh workspace and return the
 * durable record it leaves.
 */
export async function runParityScenario(): Promise<ParitySnapshot> {
  const db = new Database(scratchPath('chat-session-parity', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });

  // Session A: the conversation, and the process that dies mid-drain.
  const eventsA: SessionEvent[] = [];
  const two = drainWindowModel('answer two');
  const three = gatedTextModel('answer three');
  const four = drainWindowModel('never answered');

  const modelA = sequencedModel([
    answeringModel('answer one'),
    two.model, two.model,
    three.model,
    four.model,
  ]);

  const a = new LocalAgentSession({ rt, db, model: modelA, noAutoEvolve: true, onEvent: (event) => eventsA.push(event) });
  const norm = normalizer();

  // 1. An idle send runs as a turn of its own.
  await a.send('one');

  // 2. A send mid-turn, carrying a file: it lands at the next step boundary.
  const turnTwo = a.send('two');
  await waitFor(() => turnEvents(eventsA, 2).some((event) => event.type === 'tool-call'));
  const landingTwo = await a.send({ text: 'two-steer', files: [NOTE_FILE] });
  two.stepGate.resolve();
  await waitFor(() => two.prompts.length === 2);
  two.endGate.resolve();
  await turnTwo;
  const afterTwo = durableRows(db, norm);

  // 3. An interrupt hands the pending steer back and cuts the turn.
  const turnThree = a.send('three');
  await waitFor(() => turnEvents(eventsA, 3).some((event) => event.type === 'text-delta'));
  const landingThree = await a.send('three-steer');
  const returned = a.interrupt();
  await turnThree;
  three.release();

  // 4. A send with a file acknowledged mid-turn, then the process dies before
  //    the drain.
  const turnFour = a.send('four');
  await waitFor(() => turnEvents(eventsA, 4).some((event) => event.type === 'tool-call'));
  const landingFour = await a.send({ text: 'four-steer', files: [NOTE_FILE] });
  const beforeRestart = durableRows(db, norm);

  // 5. The restart: the next process replays what the dead one acknowledged,
  //    then takes a fresh send.
  const eventsB: SessionEvent[] = [];
  const modelB = sequencedModel([answeringModel('answer four again'), answeringModel('answer five')]);
  const b = new LocalAgentSession({ rt, db, model: modelB, noAutoEvolve: true, onEvent: (event) => eventsB.push(event) });
  await waitFor(() => eventsB.some((event) => event.type === 'turn-end'));
  const landingFive = await b.send('five');

  const record: ParitySnapshot = {
    afterTwo,
    beforeRestart,
    end: durableRows(db, norm),
    events: [eventsA, eventsB].map((stream) => stream.map((event) => norm.json(frontendView(event)))),
    landings: { landingTwo, landingThree, returned, landingFour, landingFive },
  };

  // The dead session's parked turn is released only after the record is
  // taken: a real process death never runs this, so nothing it writes counts.
  a.interrupt();
  await turnFour;
  four.stepGate.resolve();
  four.endGate.resolve();
  await a.end();
  await b.end();
  db.close();

  return record;
}
