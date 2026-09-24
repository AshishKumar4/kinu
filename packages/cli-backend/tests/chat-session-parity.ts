/**
 * One scripted conversation through the local backend and the durable rows plus frontend events it leaves,
 * with minted ids and clocks normalized; `chat-session-parity.test.ts` compares it to a recorded fixture.
 */
import { Database } from 'bun:sqlite';
import { parityNormalizer, scratchPath, type ParityNormalizer } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { decodeJsonValue, initWorkspaceSchema, JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { LanguageModelV2CallOptions, LanguageModelV2Usage } from '@ai-sdk/provider';
import type { LLMProviderConfig, SessionTranscriptReader } from '@kinu.run/core';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

type PromptMessage = LanguageModelV2CallOptions['prompt'][number];

function answeringModel(answer: string, prompts: PromptMessage[][] = []): TestLanguageModelV2 {
  const [a, b] = [answer.slice(0, answer.length >> 1), answer.slice(answer.length >> 1)];

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options) => ({
      stream: new ReadableStream({
        start(controller) {
          prompts.push(options.prompt);
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

/** Call #1 parks on `stepGate` after announcing a tool call; call #2 parks on `endGate` after the steer lands. */
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
                type: 'tool-call', toolCallId: 'call-1', toolName: 'memory',
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

async function refusalCode(landing: Promise<string>): Promise<string> {
  try {
    return await landing;
  } catch (cause) {
    if (cause instanceof KinuError) return cause.code;
    throw new Error('a send was refused with something other than a KinuError', { cause });
  }
}

function pendingSteerTexts(db: Database): string[] {
  return db.query<{ text: string }, []>('SELECT text FROM pending_steers ORDER BY seq').all().map((row) => row.text);
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

/** Harness-authored blocks beside the conversation; their wording is not a loop decision. */
const HARNESS_BLOCK = /^<(dynamic_context|workspace_instructions|unverified_instructions)\b/u;

/** One model call as the script decides it; a harness block is named by its tag, never its prose. */
function promptView(prompt: readonly PromptMessage[]): JsonValue {
  return prompt.map((message): JsonValue => {
    if (message.role === 'system') return { role: 'system' };

    const parts: JsonValue[] = message.content.map((part): JsonValue => {
      switch (part.type) {
        case 'text': {
          const block = HARNESS_BLOCK.exec(part.text)?.[1];

          return block === undefined ? { type: 'text', text: part.text } : { type: 'text', block };
        }

        case 'tool-call': return { type: 'tool-call', toolName: part.toolName, toolCallId: part.toolCallId };

        case 'tool-result': return {
          type: 'tool-result', toolCallId: part.toolCallId,
          output: part.output.type === 'text' || part.output.type === 'error-text' ? part.output.value : part.output.type,
        };

        case 'file':
        case 'reasoning': return { type: part.type };
      }
    });

    return { role: message.role, parts };
  });
}

/** Events of the n-th turn (1-based), so a wait never reads an earlier turn's leftovers. */
function turnEvents(events: readonly SessionEvent[], n: number): readonly SessionEvent[] {
  let starts = 0;
  const from = events.findIndex((event) => event.type === 'turn-start' && ++starts === n);

  return from === -1 ? [] : events.slice(from);
}

const NOTE_FILE = { filename: 'note.txt', mediaType: 'text/plain', url: 'data:text/plain;base64,aGVsbG8=' };

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
    case 'history-reverted': return { type: event.type, entryId: event.entryId };
    default: return event satisfies never;
  }
}

const DurableRowsSchema = v.object({
  actorMessages: v.array(JsonValueSchema),
  pendingSteers: v.array(JsonValueSchema),
  pendingSteerFiles: v.array(JsonValueSchema),
  agentLog: v.array(JsonValueSchema),
  terminalEffects: v.array(JsonValueSchema),
});

export type DurableRows = v.InferOutput<typeof DurableRowsSchema>;

export const ParitySnapshotSchema = v.object({
  afterTwo: DurableRowsSchema,
  beforeRestart: DurableRowsSchema,
  end: DurableRowsSchema,
  events: v.array(v.array(JsonValueSchema)),
  landings: JsonValueSchema,
  restartedCalls: v.array(JsonValueSchema),
});

export type ParitySnapshot = v.InferOutput<typeof ParitySnapshotSchema>;

async function durableRows(db: Database, norm: ParityNormalizer, transcript: SessionTranscriptReader): Promise<DurableRows> {
  const parseJson = (column: string | null): JsonValue => column === null ? null : norm.json(decodeJsonValue({ value: JSON.parse(column) }));

  const actorMessages: JsonValue[] = [];
  const page = transcript.pageIds({ limit: 200 });

  if (page.status !== 'end') throw new Error('scripted transcript exceeds its expected page');

  for (const { id } of [...page.items].reverse()) {
    const row = await transcript.project(id);

    if (row === null) throw new Error('scripted transcript entry disappeared');
    actorMessages.push({ id: norm.text(row.id), sessionId: transcript.sessionId,
      parentId: row.parentId === null ? null : norm.text(row.parentId),
      role: row.role, content: row.content, metadata: row.metadata === undefined ? null : norm.json(row.metadata) });
  }

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

export async function runParityScenario(interruptRecovery = false): Promise<ParitySnapshot> {
  const db = new Database(scratchPath('chat-session-parity', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });
  const transcript = rt.stores.history.transcript('default');

  const eventsA: SessionEvent[] = [];
  const two = drainWindowModel('answer two');
  const three = gatedTextModel('answer three');
  const four = drainWindowModel('never answered');

  const modelA = sequencedModel([
    answeringModel('answer one'),
    two.model, two.model,
    three.model,
    four.model,
    ...(interruptRecovery ? [four.model] : []),
  ]);

  const a = new LocalAgentSession({ rt, db, model: modelA, noAutoEvolve: true, onEvent: (event) => eventsA.push(event) });
  const norm = parityNormalizer();

  // 1. An idle send runs as a turn of its own.
  await a.send('one', { id: crypto.randomUUID() });

  // 2. A send mid-turn with a file lands and is answered at the next step boundary (the drain's, not admission's).
  const turnTwo = a.send('two', { id: crypto.randomUUID() });
  await waitFor(() => turnEvents(eventsA, 2).some((event) => event.type === 'tool-call'));
  const steerTwo = a.send({ text: 'two-steer', files: [NOTE_FILE] }, { id: crypto.randomUUID() });
  two.stepGate.resolve();
  const landingTwo = await steerTwo;
  await waitFor(() => two.prompts.length === 2);
  two.endGate.resolve();
  await turnTwo;
  const afterTwo = await durableRows(db, norm, transcript);

  // 3. An interrupt hands the steer back and cuts the turn: the send is refused, never landed.
  const turnThree = a.send('three', { id: crypto.randomUUID() });
  await waitFor(() => turnEvents(eventsA, 3).some((event) => event.type === 'text-delta'));
  const steerThree = a.send('three-steer', { id: crypto.randomUUID() });
  await waitFor(() => pendingSteerTexts(db).includes('three-steer'));
  const returned = a.interrupt();
  const landingThree = await refusalCode(steerThree);
  await turnThree;
  three.release();

  // 4. A send with a file is acknowledged mid-turn, then the process dies before the drain; its producers stay parked.
  const turnFour = a.send('four', { id: crypto.randomUUID() });
  await waitFor(() => turnEvents(eventsA, 4).some((event) => event.type === 'tool-call'));
  const steerFour = a.send({ text: 'four-steer', files: [NOTE_FILE] }, { id: crypto.randomUUID() });
  await waitFor(() => pendingSteerTexts(db).includes('four-steer'));
  const landingFour = 'acknowledged';
  const beforeRestart = await durableRows(db, norm, transcript);

  if (interruptRecovery) {
    four.stepGate.resolve();
    await waitFor(() => four.prompts.length === 2);
    const recoveryEvents: SessionEvent[] = [];
    const recovery = gatedTextModel('recovery paused');
    new LocalAgentSession({ rt, db, model: recovery.model, noAutoEvolve: true, onEvent: (event) => recoveryEvents.push(event) });
    await waitFor(() => recoveryEvents.some((event) => event.type === 'text-delta'));
  }

  // 5. The restart: the next process replays what the dead one acknowledged,
  //    then takes a fresh send.
  const eventsB: SessionEvent[] = [];
  const restartedPrompts: PromptMessage[][] = [];
  const modelB = sequencedModel([answeringModel('answer four again', restartedPrompts), answeringModel('answer five', restartedPrompts)]);
  const b = new LocalAgentSession({ rt, db, model: modelB, noAutoEvolve: true, onEvent: (event) => eventsB.push(event) });
  await waitFor(() => eventsB.some((event) => event.type === 'turn-end'));
  const landingFive = await b.send('five', { id: crypto.randomUUID() });

  const record: ParitySnapshot = {
    afterTwo,
    beforeRestart,
    end: await durableRows(db, norm, transcript),
    events: [eventsA, eventsB].map((stream) => stream.map((event) => norm.json(frontendView(event)))),
    landings: { landingTwo, landingThree, returned, landingFour, landingFive },
    restartedCalls: restartedPrompts.map((prompt) => norm.json(promptView(prompt))),
  };

  // The dead session is never resumed: settling it would write through a claim the restart re-admitted at a newer epoch,
  // which the claims fence refuses. Racing its unsettled promise against close ends the script.
  await Promise.race([turnFour, steerFour, b.end()]);
  db.close();

  return record;
}
