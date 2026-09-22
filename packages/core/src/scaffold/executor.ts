/**
 * Scaffold executor: runs the agent's mutable loop (`scaffold/agent.js`) in the
 * codemode sandbox with `host.*` and every parent sandbox as providers.
 *
 * Contract (enforced by safety-patterns.ts): `async function* run(rt, task)`;
 * both params carry the task string and the host is reachable only via `host.*`.
 * A throw or missing 'done' reports ok=false (or synthesizes 'done').
 */

import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ChatEvent } from '../chat';
import type { UIMessageChunk } from 'ai';
import { nanoid } from '../utils/nanoid';
import { failedToolOutcome, ToolOutcomeSchema, type ToolOutcome } from '../tools/outcome';
import type { Executor } from '../types/primitives';
import {
  assertJsonValue,
  isJsonObject,
  JsonObjectSchema,
  JsonValueSchema,
  decodeJsonValue,
  type JsonObject,
  type JsonValue,
} from '../utils/json';
import { renderThrownChain, KinuError } from '../obs/index';
import type { WorkMode } from '../types/turn';
import { bindTaskPlan } from '../tasks/plan-scope';
import { currentWorkMode, requireWorkModePermission, runWorkModeInvocation } from '../execution/work-mode';

type SandboxFunction = (...args: JsonValue[]) => Promise<JsonValue | undefined>;

interface SandboxFunctions {
  [name: string]: SandboxFunction;
}

/** d.ts for the `host` bridge; exported so the proposal prompt (evolution/engine.ts) cannot drift. */
export const SCAFFOLD_HOST_TYPES = `declare namespace host {
  /** Emit an event back to the chat client. Events: text_delta, tool_call, tool_result, step_finish, done, error, ui_chunk. */
  function emit(event: { type: string; [k: string]: unknown }): Promise<string>;
  /** Invoke a tool from the parent's ToolSet by name with JSON args. */
  function callTool(name: string, args: object): Promise<unknown>;
  /** Stream an LLM completion. Returns the concatenated text; chunks are emitted as text_delta events.
   *  Pass tool NAMES (from the agent's tool surface) in \`tools\`; the host wires the executables. */
  function llmStream(opts: {
    system: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    tools?: string[];
  }): Promise<string>;
  /** Run the agent's standard inference (full tools + multi-step) and stream its
   *  output to the user. Delegate here to reuse the default loop. */
  function defaultInference(): Promise<string>;
  /** Read a memory file (e.g. "memory/MEMORY.md"). Returns "" if absent. */
  function readMemory(path: string): Promise<string>;
  /** Append content to a memory file. */
  function appendMemory(path: string, content: string): Promise<string>;
  /** Read a page of the conversation this loop is running for. READ-ONLY and
   *  budgeted: at most 100 messages and 8000 chars each, and a page stops at
   *  40000 chars total. \`offset\` counts back from the end when negative and
   *  defaults to the tail; \`total\` and each entry's \`chars\` tell you what you
   *  are NOT being shown, so page for the rest rather than asking for it all. */
  function history(query?: { offset?: number; limit?: number; maxChars?: number }): Promise<{
    total: number;
    offset: number;
    entries: Array<{ index: number; role: string; chars: number; text: string; truncated: boolean }>;
    clipped: boolean;
  }>;
}`;

export type ScaffoldToolOutput = Extract<UIMessageChunk, { type: 'tool-output-available' | 'tool-output-error' }>;

export type ScaffoldModelEvent = ChatEvent | { type: 'native-tool-output'; output: ScaffoldToolOutput };

export type ScaffoldEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; name: string; args: JsonObject; toolCallId: string }
  | { type: 'tool_result'; toolCallId: string; result?: JsonValue; outcome: ToolOutcome; error?: string }
  | { type: 'step_finish'; stepIndex: number; reason?: string }
  | { type: 'done'; result?: JsonValue }
  | { type: 'error'; message: string }
  /** AI-SDK UI chunk from `host.defaultInference()`, passed through verbatim. */
  | { type: 'ui_chunk'; chunk: JsonValue }
  | { type: 'chat_chunk' | 'model_chunk'; streamId: string; chunk: ChatEvent }
  | { type: 'model_output'; streamId: string; output: ScaffoldToolOutput };

export type ScaffoldEmitFn = (event: ScaffoldEvent) => void | Promise<void>;

/** Visible text of an event, including text-deltas inside ui_chunks, so delegating scaffolds are scored on real output. */
export function scaffoldEventText(event: ScaffoldEvent): string | null {
  if (event.type === 'text_delta') return event.text;

  if ((event.type === 'chat_chunk' || event.type === 'model_chunk') && event.chunk.type === 'text-delta') return event.chunk.delta;

  if (event.type === 'ui_chunk' && isJsonObject(event.chunk)) {
    const delta = v.safeParse(v.string(), event.chunk.delta);

    if (event.chunk.type === 'text-delta' && delta.success) return delta.output;
  }

  return null;
}

export interface ScaffoldRunResult {
  ok: boolean;
  /** True iff the scaffold emitted 'done' before completing. */
  doneEmitted: boolean;
  emitCount: number;
  events: ScaffoldEvent[];
  durationMs: number;
  error?: string;
  finalResult?: JsonValue;
}

/** Every event kind except native host chunks. */
export type ScaffoldJsonEvent = Exclude<ScaffoldEvent, { type: 'chat_chunk' | 'model_chunk' | 'model_output' }>;

/** A run result for crossing a process boundary; native chunks are only counted. */
export interface ScaffoldRunReport extends Omit<ScaffoldRunResult, 'events'> {
  events: ScaffoldJsonEvent[];
  nativeEvents: number;
}

function jsonScaffoldEvent(event: ScaffoldEvent): ScaffoldJsonEvent | null {
  switch (event.type) {
    case 'chat_chunk':
    case 'model_chunk':
    case 'model_output':
      return null;
    case 'text_delta':
    case 'tool_call':
    case 'tool_result':
    case 'step_finish':
    case 'done':
    case 'error':
    case 'ui_chunk':
      return event;
  }
}

export function scaffoldRunReport(result: ScaffoldRunResult): ScaffoldRunReport {
  const { events, ...figures } = result;
  const carried: ScaffoldJsonEvent[] = [];
  let nativeEvents = 0;

  for (const event of events) {
    const json = jsonScaffoldEvent(event);

    if (json === null) nativeEvents += 1;
    else carried.push(json);
  }

  return { ...figures, events: carried, nativeEvents };
}


export type ScaffoldDefaultInferenceChunk = { value: JsonValue } | { event: ChatEvent };

export interface ScaffoldHistoryQuery {
  offset?: number;
  limit?: number;
  maxChars?: number;
}

export interface ScaffoldHistoryEntry {
  index: number;
  role: string;
  chars: number;
  text: string;
  truncated: boolean;
}

export interface ScaffoldHistoryPage {
  total: number;
  offset: number;
  entries: ScaffoldHistoryEntry[];
  clipped: boolean;
}

export type ScaffoldHistoryReader = (
  query?: ScaffoldHistoryQuery,
) => Promise<ScaffoldHistoryPage>;

export interface ScaffoldRunControl {
  readonly signal?: AbortSignal;
  readonly assertActive?: () => void;
}

export function assertScaffoldActive(control: ScaffoldRunControl): void {
  control.signal?.throwIfAborted();
  control.assertActive?.();
}

export interface ScaffoldRunOptions extends ScaffoldRunControl {
  task: string;
  rt: AgentRuntime;
  /** The invocation's mode, captured by the host rather than by scaffold code. */
  workMode?: WorkMode;
  emit: ScaffoldEmitFn;
  /** Host-side model execution via the shared chat loop, with its own step/spend owner. Returns concatenated text to the scaffold. */
  llmStream: (opts: {
    system: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    tools?: string[];
  }) => AsyncIterable<ScaffoldModelEvent>;
  /** Executes `host.callTool` against the parent's ToolSet; the host emits tool_call and tool_result. */
  callTool?: (name: string, args: JsonObject) => Promise<JsonValue | undefined>;
  /** Runs the default inference for `host.defaultInference()` as 'ui_chunk' events; absent means it returns an error. */
  defaultInference?: () => AsyncIterable<ScaffoldDefaultInferenceChunk>;
  /** Budgeted conversation page for `host.history()` (orchestrator/scaffold-host.ts); absent means it returns an error. */
  history?: ScaffoldHistoryReader;
  /** Scaffold code override for shadow runs. Default: rt.identity.scaffold.read(). */
  scaffoldCodeOverride?: string;
}

const ScaffoldEventSchema: v.GenericSchema<Exclude<ScaffoldEvent, { type: 'chat_chunk' | 'model_chunk' | 'model_output' }>> = v.variant('type', [
  v.object({ type: v.literal('text_delta'), text: v.string() }),
  v.object({
    type: v.literal('tool_call'),
    name: v.string(),
    args: JsonObjectSchema,
    toolCallId: v.string(),
  }),
  v.object({
    type: v.literal('tool_result'),
    toolCallId: v.string(),
    result: v.optional(JsonValueSchema),
    outcome: ToolOutcomeSchema,
    error: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('step_finish'),
    stepIndex: v.number(),
    reason: v.optional(v.string()),
  }),
  v.object({ type: v.literal('done'), result: v.optional(JsonValueSchema) }),
  v.object({ type: v.literal('error'), message: v.string() }),
  v.object({ type: v.literal('ui_chunk'), chunk: JsonValueSchema }),
]);

const LlmStreamOptionsSchema = v.object({
  system: v.string(),
  messages: v.array(v.object({
    role: v.picklist(['system', 'user', 'assistant']),
    content: v.string(),
  })),
  tools: v.optional(v.array(v.string())),
});

const HistoryQuerySchema = v.object({
  offset: v.optional(v.number()),
  limit: v.optional(v.number()),
  maxChars: v.optional(v.number()),
});


function buildHostProvider(opts: ScaffoldRunControl & {
  workMode: WorkMode;
  emit: ScaffoldEmitFn;
  llmStream: ScaffoldRunOptions['llmStream'];
  callTool?: ScaffoldRunOptions['callTool'];
  defaultInference?: ScaffoldRunOptions['defaultInference'];
  history?: ScaffoldRunOptions['history'];
  readMemory: (path: string) => Promise<string>;
  appendMemory: (path: string, content: string) => Promise<void>;
  capturedEvents: ScaffoldEvent[];
  state: { doneEmitted: boolean; finalResult: JsonValue | undefined };
}) {
  const { emit, llmStream, callTool, defaultInference, history, readMemory, appendMemory, capturedEvents, state } = opts;

  async function pushEvent(ev: ScaffoldEvent): Promise<void> {
    capturedEvents.push(ev);

    if (ev.type === 'done') {
      state.doneEmitted = true;
      state.finalResult = ev.result;
    }

    await emit(ev);
  }

  const fns = {
    emit: async (...args: unknown[]) => {
      assertScaffoldActive(opts);
      const event = v.safeParse(ScaffoldEventSchema, args[0]);

      if (!event.success) return 'host.emit: invalid event';
      await pushEvent(event.output);

      return 'emitted';
    },
    callTool: async (...rawArgs: unknown[]) => {
      assertScaffoldActive(opts);
      const name = v.safeParse(v.string(), rawArgs[0]);

      if (!name.success) throw new KinuError('bad_input', 'host.callTool: name must be a string');

      if (!callTool) throw new KinuError('unavailable', 'host.callTool is unavailable in this runtime');
      const callId = `tc-${Math.random().toString(36).slice(2, 10)}`;
      const parsedArgs = v.safeParse(JsonValueSchema, rawArgs[1]);

      if (!parsedArgs.success) throw new KinuError('bad_input', 'host.callTool: arguments must be JSON', { cause: parsedArgs.issues });
      const toolArgs = parsedArgs.output;

      if (!isJsonObject(toolArgs)) throw new KinuError('bad_input', 'host.callTool: arguments must be a JSON object');
      await pushEvent({ type: 'tool_call', name: name.output, args: toolArgs, toolCallId: callId });

      try {
        const result = await callTool(name.output, toolArgs);
        await pushEvent({ type: 'tool_result', toolCallId: callId, result, outcome: { success: true } });

        return result;
      } catch (err) {
        const msg = renderThrownChain({ cause: err });
        await pushEvent({ type: 'tool_result', toolCallId: callId, error: msg, outcome: failedToolOutcome({ cause: err }) });

        return { error: msg };
      }
    },
    llmStream: async (...args: unknown[]) => {
      assertScaffoldActive(opts);
      const parsed = v.safeParse(LlmStreamOptionsSchema, args[0]);

      if (!parsed.success) return { error: 'host.llmStream: invalid options' };
      let acc = '';
      const streamId = nanoid();

      try {
        for await (const chunk of llmStream(parsed.output)) {
          if (chunk.type === 'native-tool-output') await pushEvent({ type: 'model_output', streamId, output: chunk.output });
          else {
            if (chunk.type === 'text-delta') acc += chunk.delta;
            await pushEvent({ type: 'model_chunk', streamId, chunk });
          }
        }

        return acc;
      } catch (err) {
        const msg = renderThrownChain({ cause: err });
        await pushEvent({ type: 'error', message: `llmStream failed: ${msg}` });

        return { error: msg };
      }
    },
    defaultInference: async () => {
      // Chunks are emitted host-side; they do not round-trip through the sandbox.
      assertScaffoldActive(opts);

      if (!defaultInference) {
        return { error: 'host.defaultInference: unavailable in this runtime' };
      }

      const streamId = nanoid();

      try {
        for await (const chunk of defaultInference()) {
          if ('event' in chunk) await pushEvent({ type: 'chat_chunk', streamId, chunk: chunk.event });
          else {
            assertJsonValue(chunk);
            await pushEvent({ type: 'ui_chunk', chunk: chunk.value });
          }
        }

        return 'done';
      } catch (err) {
        const msg = renderThrownChain({ cause: err });
        await pushEvent({ type: 'error', message: `defaultInference failed: ${msg}` });

        return { error: msg };
      }
    },
    history: async (...args: unknown[]) => {
      assertScaffoldActive(opts);

      if (!history) return { error: 'host.history: unavailable in this runtime' };
      const parsed = v.safeParse(HistoryQuerySchema, args[0] ?? {});
      const query = parsed.success ? parsed.output : {};

      try {
        const page = { value: await history(query) };
        assertJsonValue(page);

        return page.value;
      } catch (err) {
        return { error: renderThrownChain({ cause: err }) };
      }
    },
    readMemory: async (...args: unknown[]) => {
      assertScaffoldActive(opts);
      const path = v.safeParse(v.string(), args[0]);

      if (!path.success) return { error: 'host.readMemory: path must be a string' };

      try { return await readMemory(path.output); }
      catch (err) { return { error: renderThrownChain({ cause: err }) }; }
    },
    appendMemory: async (...args: unknown[]) => {
      assertScaffoldActive(opts);
      const path = v.safeParse(v.string(), args[0]);
      const content = v.safeParse(v.string(), args[1]);

      if (!path.success || !content.success) {
        return { error: 'host.appendMemory: path and content must be strings' };
      }

      try {
        await appendMemory(path.output, content.output);

        return 'appended';
      }
      catch (err) { return { error: renderThrownChain({ cause: err }) }; }
    },
  } satisfies Record<string, (...args: unknown[]) => Promise<JsonValue | undefined>>;

  const bound = Object.fromEntries(Object.entries(fns).map(([name, invoke]) => [name,
    (...args: JsonValue[]) => runWorkModeInvocation(opts.workMode, () => invoke(...args)),
  ]));

  return { name: 'host', fns: bound, types: SCAFFOLD_HOST_TYPES };
}

/**
 * Execute the agent's current scaffold for one turn. No elapsed deadline; on
 * failure returns ok=false and the caller falls back and queues a rollback.
 */
export async function runScaffold(opts: ScaffoldRunOptions): Promise<ScaffoldRunResult> {
  assertScaffoldActive(opts);
  const mode = opts.workMode ?? currentWorkMode();
  requireWorkModePermission(mode, false, 'Unrestricted scaffold execution');
  const { rt, task, emit, llmStream, callTool, scaffoldCodeOverride } = opts;
  const startedAt = Date.now();
  const capturedEvents: ScaffoldEvent[] = [];

  const state = {
    doneEmitted: false,
    finalResult: undefined,
  } satisfies { doneEmitted: boolean; finalResult: JsonValue | undefined };

  let code: string;

  try {
    code = scaffoldCodeOverride ?? (await rt.identity.scaffold.read());
  } catch (err) {
    const msg = `scaffold read failed: ${renderThrownChain({ cause: err })}`;
    await emit({ type: 'error', message: msg });

    return {
      ok: false, doneEmitted: false, emitCount: 0, events: [], durationMs: Date.now() - startedAt, error: msg,
    };
  }

  if (!code || code.trim().length === 0) {
    const msg = 'scaffold empty or unreadable';
    await emit({ type: 'error', message: msg });

    return {
      ok: false, doneEmitted: false, emitCount: 0, events: [], durationMs: Date.now() - startedAt, error: msg,
    };
  }

  const hostProvider = buildHostProvider({
    emit, llmStream, callTool, workMode: mode, signal: opts.signal, assertActive: opts.assertActive,
    defaultInference: opts.defaultInference,
    history: opts.history,
    readMemory: async (path) => (await rt.memory.read(path)) ?? '',
    appendMemory: async (path, content) => { await rt.memory.append(path, content); },
    capturedEvents, state,
  });

  // Scaffolds reach the host only via `host.*`; `rt` is not a sandbox
  // global (the live object can't cross the boundary).
  const wrapperCode = buildScaffoldWrapperCode(code, task);

  const exec: Executor = rt.executor;
  const providers = assembleProviders(rt, hostProvider, opts, mode);

  for (const provider of providers) {
    for (const [name, invoke] of Object.entries(provider.fns)) provider.fns[name] = bindTaskPlan(invoke);
  }

  assertScaffoldActive(opts);
  const result = await runWorkModeInvocation(mode, () => exec.execute(wrapperCode, providers));
  const durationMs = Date.now() - startedAt;

  if (result.error) {
    const msg = result.error;
    await emit({ type: 'error', message: msg });

    return {
      ok: false,
      doneEmitted: state.doneEmitted,
      emitCount: capturedEvents.length,
      events: capturedEvents,
      durationMs,
      error: msg,
    };
  }

  if (!state.doneEmitted) {
    await emit({ type: 'done', result: state.finalResult });
  }

  return {
    ok: true,
    doneEmitted: true,
    emitCount: capturedEvents.length,
    events: capturedEvents,
    durationMs,
    finalResult: state.finalResult,
  };
}

/** Wrap scaffold source with a driver for either `run` shape, forwarding yields to host.emit. */
function buildScaffoldWrapperCode(scaffoldSource: string, task: string): string {
  // The task is injected as a JSON literal and passed as both `rt` and `task`.
  // DynamicWorkerExecutor wraps the code in an async IIFE.
  return `
${scaffoldSource}

const __task = ${JSON.stringify(task)};
let __result;
try {
  const __isGen = run && run.constructor && run.constructor.name === 'AsyncGeneratorFunction';
  if (__isGen) {
    // Generator form: async function* run(rt, task) — uses host.* + task.
    const __gen = run(__task, __task);
    let __step = 0;
    for await (const __ev of __gen) {
      if (__ev && typeof __ev === 'object') {
        if (__ev.type === 'chunk' && typeof __ev.data === 'string') {
          await host.emit({ type: 'text_delta', text: __ev.data });
        } else if (__ev.type) {
          await host.emit(__ev);
        }
      }
      __step++;
    }
    await host.emit({ type: 'done', result: { generatorSteps: __step } });
  } else {
    // Object-arg form: async function run({ task, host }).
    __result = await run({ task: __task, host });
    await host.emit({ type: 'done', result: __result });
  }
} catch (e) {
  throw e;
}
return __result;
`;
}

function assembleProviders(
  rt: AgentRuntime,
  hostProvider: { name: string; fns: SandboxFunctions; types?: string },
  control: ScaffoldRunControl,
  mode: WorkMode,
): Array<{ name: string; fns: SandboxFunctions; types?: string }> {
  const out: Array<{ name: string; fns: SandboxFunctions; types?: string }> = [
    hostProvider,
  ];

  const routerProviders = rt.executionRouter?.getProviders() ?? [];

  for (const p of routerProviders) {
    const fns: SandboxFunctions = {};

    for (const [name, descriptor] of Object.entries(p.tools)) {
      fns[name] = (...args: JsonValue[]) => runWorkModeInvocation(mode, async () => {
        assertScaffoldActive(control);
        const result = await descriptor.execute(...args);

        return result === undefined ? undefined : decodeJsonValue({ value: result });
      });
    }

    out.push({ name: p.name, fns, types: p.types });
  }

  return out;
}
