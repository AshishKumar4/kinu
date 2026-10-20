/**
 * Replaying a pending scaffold against recorded turns (docs/EVOLUTION.md, "Scaffold replay"): each turn's recorded
 * model outputs are served in order, a tool call is answered from the recording when its name and arguments match one
 * there, and anything else is refused. Memory writes stay in memory and no machine is reachable, so nothing a replay
 * does reaches the agent. A version passes when every turn completes with an answer, calling nothing outside its
 * recording, within the step bound.
 */

import type { ModelMessage } from 'ai';
import type { ChatEvent } from '../chat';
import type { AgentStores } from '../state/agent-stores';
import type { AgentRuntime } from '../types/agent-runtime';
import type { Memory } from '../types/primitives';
import type { JsonObject, JsonValue } from '../utils/json';
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError, settle } from '../obs/index';
import { JsonObjectSchema, JsonValueSchema } from '../utils/json';
import { stableStringify } from '../safety/argument-digest';
import { decodeModelMessageValues, encodeModelMessageValues } from '../session/message-codec';
import { renderToolResult } from '../utils/evidence-window';
import { successfulToolOutcome } from '../tools/outcome';
import { createScaffoldHistory } from '../orchestrator/scaffold-host';
import {
  runScaffold, type ScaffoldDefaultInferenceChunk, type ScaffoldEvent, type ScaffoldHistoryReader, type ScaffoldRunResult,
} from './executor';

/** The turns a pending version is replayed against, newest first among the answered ones. */
const REPLAYED_TURNS = 10;

/** Host calls (model streams, the default turn, tool calls) a replayed turn may make beyond its recorded steps. */
const SPARE_HOST_CALLS = 8;

/** A replayed turn that takes longer has stalled: the recording answers at once. */
const REPLAY_DEADLINE_MS = 30_000;

/** What one answered turn was asked with and what it produced, as the session recorded them. */
export interface RecordedTurn {
  readonly turnId: string;
  /** The user's message the turn answered. */
  readonly task: string;
  /** The conversation at its admission: the history before it and the user's message. */
  readonly input: readonly ModelMessage[];
  /** Its outputs in order: each step's assistant message, then its tools' results. */
  readonly output: readonly ModelMessage[];
}

/** The newest `limit` answered turns, oldest first, each with the conversation it was asked in and what it produced. */
export async function recordedTurns(stores: Pick<AgentStores, 'history' | 'claims'>, limit = REPLAYED_TURNS): Promise<RecordedTurn[]> {
  const turns: RecordedTurn[] = [];

  for (const claim of stores.claims.turns(limit * 3)) {
    if (turns.length >= limit) break;

    if (claim.outcome !== 'completed') continue;
    const admission = [...stores.history.requests.forTurn(claim.turnId)].reverse().find((request) => request.step === null);

    if (admission === undefined) continue;
    const { messages: input } = await stores.history.requests.materialize(admission.id);
    const output = await stores.history.messages.materializeAll((await stores.history.outputForTurn(claim.turnId)).messages);
    const task = textOf([...input].reverse().find((message) => message.role === 'user'));

    if (task !== '' && output.some((message) => message.role === 'assistant')) turns.push({ turnId: claim.turnId, task, input, output });
  }

  return turns.reverse();
}

const RecordedTurnWireSchema = v.object({
  turnId: v.string(), task: v.string(), input: v.array(JsonValueSchema), output: v.array(JsonValueSchema),
});

/** Across an isolate boundary, each turn's messages in the session codec's durable form. */
export function encodeRecordedTurns(turns: readonly RecordedTurn[]): JsonValue[] {
  return turns.map((turn) => ({
    turnId: turn.turnId, task: turn.task,
    input: encodeModelMessageValues(turn.input), output: encodeModelMessageValues(turn.output),
  }));
}

export function decodeRecordedTurns(values: readonly JsonValue[]): RecordedTurn[] {
  return values.map((value) => {
    const wire = v.parse(RecordedTurnWireSchema, value);

    return { turnId: wire.turnId, task: wire.task, input: decodeModelMessageValues(wire.input), output: decodeModelMessageValues(wire.output) };
  });
}

function textOf(message: ModelMessage | undefined): string {
  if (message === undefined) return '';

  if (typeof message.content === 'string') return message.content;

  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

const ToolOutputEnvelopeSchema = v.object({ value: JsonValueSchema });

interface RecordedCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonObject;
}

/** One recorded step: the model's text and calls, and each call's recorded result. */
interface RecordedStep {
  readonly text: string;
  readonly calls: readonly RecordedCall[];
  readonly results: ReadonlyMap<string, JsonValue>;
  readonly messages: readonly ModelMessage[];
}

function stepsOf(output: readonly ModelMessage[]): RecordedStep[] {
  const steps: RecordedStep[] = [];

  for (const message of output) {
    if (message.role === 'assistant') {
      const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;

      steps.push({
        text: parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
        calls: parts.flatMap((part) => {
          if (part.type !== 'tool-call') return [];
          // A call recorded with no arguments, or with a non-object, reads as `{}`.
          const input = v.safeParse(JsonObjectSchema, part.input);

          return [{ toolCallId: part.toolCallId, toolName: part.toolName, input: input.success ? input.output : {} }];
        }),
        results: new Map(),
        messages: [message],
      });
      continue;
    }

    const step = steps.at(-1);

    if (message.role !== 'tool' || step === undefined) continue;
    const results = new Map(step.results);

    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      // The value a tool returned, from the AI SDK's tool output envelope.
      const returned = v.safeParse(ToolOutputEnvelopeSchema, part.output);

      results.set(part.toolCallId, returned.success ? returned.output.value : null);
    }

    steps[steps.length - 1] = { ...step, results, messages: [...step.messages, message] };
  }

  return steps;
}

/** What one turn's replay saw that decides it, beyond the run's own result. */
interface ReplayWatch {
  /** Tool calls made that the recording holds no answer for. */
  readonly outside: string[];
  hostCalls: number;
  /** Twice its recorded steps, plus a spare: past it the run is stopped. */
  readonly bound: number;
  overBound: boolean;
  /** Ends the run once it passes its bound: a host call after that throws (`assertScaffoldActive`). */
  readonly stop: AbortController;
}

/** Reads see the agent's memory; writes stay here and are dropped with the replay. */
function replayMemory(base: Memory): Memory {
  const written = new Map<string, string>();

  return {
    chunk: (id) => base.chunk(id),
    search: (query, limit) => base.search(query, limit),
    write: async (path, content) => { written.set(path, content); },
    append: async (path, content) => { written.set(path, `${written.get(path) ?? await base.read(path) ?? ''}${content}`); },
    index: async () => undefined,
    read: async (path) => written.get(path) ?? await base.read(path),
    tail: async (path, bytes) => {
      const text = written.get(path);

      return text === undefined ? base.tail(path, bytes) : text.slice(-bytes);
    },
  };
}

/** The scripted host one recorded turn is replayed in: its public members are what the run's host calls reach. */
class ReplayHost {
  private readonly steps: readonly RecordedStep[];
  /** Each recorded call's results, by name and arguments, in the order they were made. */
  private readonly answers = new Map<string, JsonValue[]>();
  private served = 0;
  readonly history: ScaffoldHistoryReader;

  constructor(private readonly turn: RecordedTurn, private readonly watch: ReplayWatch) {
    this.steps = stepsOf(turn.output);
    this.history = createScaffoldHistory(async () => turn.input);

    for (const step of this.steps) {
      for (const call of step.calls) {
        const key = callKey(call.toolName, call.input);
        this.answers.set(key, [...this.answers.get(key) ?? [], step.results.get(call.toolCallId) ?? null]);
      }
    }
  }

  /** False once the run passed its bound, which ends it: its next host call fails as stopped. */
  private counted(): boolean {
    this.watch.hostCalls += 1;

    if (this.watch.hostCalls <= this.watch.bound) return true;
    this.watch.overBound = true;
    this.watch.stop.abort();

    return false;
  }

  async* llmStream(): AsyncGenerator<ChatEvent> {
    if (!this.counted()) return;
    const step = this.steps[this.served];
    this.served += 1;

    if (step !== undefined && step.text !== '') yield { type: 'text-delta', delta: step.text };
  }

  callTool(name: string, args: JsonObject): Promise<JsonValue> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!this.counted()) return yield* new KinuError('budget', `the replay passed its bound of ${String(this.watch.bound)} model and tool calls`);
      const answer = this.answers.get(callKey(name, args))?.shift();

      if (answer === undefined) {
        this.watch.outside.push(name);

        return yield* new KinuError('missing', `${name} with these arguments is not in the recording`);
      }

      return answer;
    }));
  }

  async* defaultInference(): AsyncGenerator<ScaffoldDefaultInferenceChunk> {
    if (!this.counted()) return;

    for (const [stepIndex, step] of this.steps.entries()) {
      for (const event of recordedStep(step, stepIndex)) yield { event };

      // Made once its results were handed on; a run that stops reading before then made none of them.
      for (const call of step.calls) this.answers.get(callKey(call.toolName, call.input))?.shift();
    }

    yield { event: { type: 'done', text: this.steps.at(-1)?.text ?? '', responseMessages: [...this.turn.output] } };
  }

  /** The recorded calls this run never made, by name: the work the recorded turn did that it skipped. */
  skipped(): string[] {
    return [...this.answers.entries()].flatMap(([key, left]) => left.map(() => key.slice(0, key.indexOf('\u0000'))));
  }
}

function callKey(name: string, args: JsonObject): string {
  return `${name}\u0000${stableStringify(args)}`;
}

function recordedStep(step: RecordedStep, stepIndex: number): ChatEvent[] {
  return [
    ...(step.text === '' ? [] : [{ type: 'text-delta' as const, delta: step.text }]),
    ...step.calls.map((call): ChatEvent => ({ type: 'tool-call', toolName: call.toolName, toolCallId: call.toolCallId, args: call.input })),
    ...step.calls.map((call): ChatEvent => {
      const output = step.results.get(call.toolCallId) ?? null;

      return {
        type: 'tool-result', toolName: call.toolName, toolCallId: call.toolCallId, result: renderToolResult(output), output,
        ...successfulToolOutcome(call.toolName, { output }),
      };
    }),
    { type: 'step-finish', stepIndex, responseMessages: step.messages },
  ];
}

/** The answer a run gave: its streamed text, else its final result. */
function answerOf(events: readonly ScaffoldEvent[], finalResult: JsonValue | undefined): string {
  const text = events.map((event) => {
    if (event.type === 'text_delta') return event.text;

    return (event.type === 'chat_chunk' || event.type === 'model_chunk') && event.chunk.type === 'text-delta' ? event.chunk.delta : '';
  }).join('');

  if (text.trim() !== '') return text;

  return typeof finalResult === 'string' ? finalResult : '';
}

export interface ReplayVerdict {
  /** The turn it failed on; null when there was none to replay. */
  readonly turnId: string | null;
  /** Null when the turn passed; otherwise why it did not. */
  readonly failed: string | null;
}

/** One recorded turn under `source`. */
async function replayTurn(rt: AgentRuntime, source: string, turn: RecordedTurn): Promise<ReplayVerdict> {
  const bound = stepsOf(turn.output).length * 2 + SPARE_HOST_CALLS;
  const watch: ReplayWatch = { outside: [], hostCalls: 0, bound, overBound: false, stop: new AbortController() };
  const signal = AbortSignal.any([watch.stop.signal, AbortSignal.timeout(REPLAY_DEADLINE_MS)]);
  const events: ScaffoldEvent[] = [];
  // No machine is reachable and memory writes stay here: nothing a replay does reaches the agent.
  const isolated: AgentRuntime = { ...rt, memory: replayMemory(rt.memory), executionRouter: undefined };

  const host = new ReplayHost(turn, watch);

  const result = await runScaffold({
    rt: isolated, task: turn.task, emit: (event) => { events.push(event); }, stores: null, scaffoldCodeOverride: source, signal,
    llmStream: () => host.llmStream(), callTool: (name, args) => host.callTool(name, args), history: host.history,
    defaultInference: () => host.defaultInference(),
  });

  return { turnId: turn.turnId, failed: failure(watch, signal, result, host.skipped()) };
}

function failure(watch: ReplayWatch, signal: AbortSignal, result: ScaffoldRunResult, skipped: readonly string[]): string | null {
  if (watch.overBound) return `it passed its bound of ${String(watch.bound)} model and tool calls`;

  if (signal.aborted) return `it did not finish within ${String(REPLAY_DEADLINE_MS / 1000)} s`;

  if (!result.ok) return `it threw: ${result.error ?? 'without a message'}`;

  if (watch.outside.length > 0) return `it called ${watch.outside.join(', ')}, which the recording does not hold`;

  // Each recorded call is a file the turn wrote or a result its answer was built on; the recording cannot tell which
  // one a version could drop, so it may drop none.
  if (skipped.length > 0) return `it skipped ${[...new Set(skipped)].join(', ')}, which the recorded turn made`;

  return answerOf(result.events, result.finalResult).trim() === '' ? 'it gave no answer' : null;
}

/**
 * Every turn replayed in order; the first that fails decides, and later turns are not run. With no recorded turn there
 * is nothing to hold the version to, which is a failure, never a pass.
 */
export async function replayScaffold(rt: AgentRuntime, source: string, turns: readonly RecordedTurn[]): Promise<ReplayVerdict | null> {
  if (turns.length === 0) return { turnId: null, failed: 'no answered turn is recorded to replay it against' };

  for (const turn of turns) {
    const verdict = await replayTurn(rt, source, turn);

    if (verdict.failed !== null) return verdict;
  }

  return null;
}
