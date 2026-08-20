/**
 * Scaffold executor — closes the central novelty.
 *
 * The mutable scaffold (`scaffold/agent.js`) is the agent's own agentic loop,
 * versioned in scaffold_versions, validated through modifyScaffold's 4 gates,
 * and rewritten via maybeEvolveScaffold. Earlier, the scaffold was stored
 * but NEVER executed — every turn ran Think's standard streamText() loop.
 *
 * This module closes the loop. It executes the scaffold through the codemode
 * sandbox (DynamicWorkerExecutor), wiring three providers the scaffold uses:
 *
 *   • rt.*       — bridge to host-side LLM streaming + memory + sandboxes
 *   • host.*     — emit events back to the chat client (text deltas, tool calls)
 *   • workspace.* — existing inline executor (file/memory)
 *
 * Plus any external environments registered on the parent (sandbox.*, laptop.*).
 *
 * Scaffold contract (v1):
 *
 *   async function run({ rt, task, host, tools }) {
 *     // rt.llm.stream({ system, messages, tools, maxSteps })
 *     //   → for await each chunk: host.emit({ type: 'text_delta', text: chunk })
 *     // host.callTool(name, args) → invokes a parent tool, returns result
 *     // host.emit({ type: 'done', result }) → signals completion
 *   }
 *
 * If the scaffold throws or fails to emit a 'done' event within a timeout,
 * the orchestrator auto-falls-back to streamText() and queues a rollback.
 *
 * Shadow mode: a pending scaffold version can run alongside the current
 * version for N turns; a judge LLM scores both; auto-promote on uplift.
 * (See scaffold/shadow.ts for the rollout state machine.)
 */

import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { Executor } from '../types/primitives';
import { TURN_WALL_CLOCK_ENVELOPE_MS } from '../config';
import {
  assertJsonValue,
  isJsonObject,
  JsonObjectSchema,
  JsonValueSchema,
  decodeJsonValue,
  type JsonObject,
  type JsonValue,
} from '../utils/json';
import { renderThrownChain } from '../obs/index';

type SandboxFunction = (...args: JsonValue[]) => Promise<JsonValue | undefined>;
interface SandboxFunctions {
  [name: string]: SandboxFunction;
}

/**
 * The d.ts the scaffold sandbox sees for the `host` bridge — the ONLY way a
 * scaffold reaches the host (the live runtime object cannot cross the
 * codemode sandbox boundary). Exported so the scaffold-proposal prompt
 * (evolution/engine.ts) documents exactly this contract and cannot drift.
 */
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
    maxSteps?: number;
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

/** What scaffold execution emits back to the caller. */
export type ScaffoldEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; name: string; args: JsonObject; toolCallId: string }
  | { type: 'tool_result'; toolCallId: string; result?: JsonValue }
  | { type: 'step_finish'; stepIndex: number; reason?: string }
  | { type: 'done'; result?: JsonValue }
  | { type: 'error'; message: string }
  /** A ready-made AI-SDK UI message stream chunk, emitted by
   *  `host.defaultInference()`. Passed through verbatim by the adapter. */
  | { type: 'ui_chunk'; chunk: JsonValue };

/** Callback the host provides — every scaffold emit is forwarded through here. */
export type ScaffoldEmitFn = (event: ScaffoldEvent) => void | Promise<void>;

/**
 * Extract the user-visible text carried by a scaffold event: a direct
 * text_delta, or the text-delta inside a ui_chunk emitted by
 * host.defaultInference. Shared by the auto-judge shadow eval and the GEPA
 * metric rollout so a DELEGATING scaffold's output is captured everywhere —
 * collecting only text_delta silently scored host.defaultInference users as
 * empty output.
 */
export function scaffoldEventText(event: ScaffoldEvent): string | null {
  if (event.type === 'text_delta') return event.text;
  if (event.type === 'ui_chunk' && isJsonObject(event.chunk)) {
    const delta = v.safeParse(v.string(), event.chunk.delta);
    if (event.chunk.type === 'text-delta' && delta.success) return delta.output;
  }
  return null;
}

/** Result of a single scaffold turn execution. */
export interface ScaffoldRunResult {
  ok: boolean;
  /** True iff the scaffold called host.emit({type:'done', ...}) before completing. */
  doneEmitted: boolean;
  /** Number of events emitted (text deltas, tool calls, etc). */
  emitCount: number;
  /** All events captured (use for shadow-mode quality comparison). */
  events: ScaffoldEvent[];
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Set if the scaffold threw or codemode rejected. */
  error?: string;
  /** Whatever the scaffold returned as its final result (if it did). */
  finalResult?: JsonValue;
}

/**
 * Wall clock one scaffold turn gets, live or under evaluation.
 *
 * ONE number, deliberately. The promotion gate compares a candidate scaffold's
 * output against what the live loop produced, and an A/B whose arms get
 * different resource is not measuring what it claims to: a candidate evaluated
 * under a tenth of the live budget fails for running out of room, not for being
 * worse, so the gate systematically promotes scaffolds that finish fast and do
 * little. Both backends' live turns and the shadow evaluation read this
 * constant; nothing sets its own.
 *
 * That argument applies to the MAGNITUDE too, and it was 5 minutes — under the
 * 509 s longest turn {@link TURN_WALL_CLOCK_ENVELOPE_MS} records, so BOTH arms
 * were being cut and the gate was comparing two truncations. A scaffold turn is
 * a whole agentic loop, so it gets the measured turn envelope and nothing of its
 * own to drift from.
 */
export const SCAFFOLD_TURN_TIMEOUT_MS = TURN_WALL_CLOCK_ENVELOPE_MS;

/** One host inference chunk before validation at the codemode JSON boundary. */
export interface ScaffoldDefaultInferenceChunk {
  value: JsonValue;
}

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

/** Options for a scaffold run. */
export interface ScaffoldRunOptions {
  /** The task / user message that drives this turn. */
  task: string;
  /** The agent runtime — gives the scaffold access to LLM, memory, sandboxes. */
  rt: AgentRuntime;
  /** Per-event callback. Called synchronously from inside the scaffold's execution. */
  emit: ScaffoldEmitFn;
  /**
   * Host-side LLM stream — invoked when the scaffold calls host.llmStream(opts).
   * Yields text deltas; the host batches them into 'text_delta' events. `tools`
   * is a list of tool NAMES from the agent's surface; the host resolves them to
   * executables (closures can't cross the sandbox boundary).
   */
  llmStream: (opts: {
    system: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    tools?: string[];
    maxSteps?: number;
  }) => AsyncIterable<string>;
  /**
   * Tool invoker — when the scaffold calls host.callTool(name, args), this
   * function executes the tool from the parent's ToolSet and returns the
   * result. The host emits both 'tool_call' and 'tool_result' events.
   */
  callTool?: (name: string, args: JsonObject) => Promise<JsonValue | undefined>;
  /**
   * Default-inference bridge — when the scaffold calls host.defaultInference(),
   * this runs the standard host inference (the AI SDK streamText the agent
   * would otherwise use) and streams its UI message chunks back as
   * 'ui_chunk' events. Lets a scaffold delegate to / wrap the default loop
   * instead of reimplementing the tool-call loop. Absent means this host
   * capability is unavailable and host.defaultInference returns an error.
   */
  defaultInference?: () => AsyncIterable<ScaffoldDefaultInferenceChunk>;
  /**
   * Read-only history bridge — when the scaffold calls host.history(query),
   * this returns a budgeted page of the conversation it is the inference loop
   * for. Absent means the capability is unavailable and host.history returns an
   * error, exactly like the other optional bridges. Built by
   * orchestrator/scaffold-host.ts, which owns the budget.
   */
  history?: ScaffoldHistoryReader;
  /** Hard timeout in milliseconds. Default {@link SCAFFOLD_TURN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Optional: override the scaffold code (for shadow-mode A/B). Default: rt.identity.scaffold.read(). */
  scaffoldCodeOverride?: string;
}

const ScaffoldEventSchema: v.GenericSchema<ScaffoldEvent> = v.variant('type', [
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
  maxSteps: v.optional(v.number()),
});

const HistoryQuerySchema = v.object({
  offset: v.optional(v.number()),
  limit: v.optional(v.number()),
  maxChars: v.optional(v.number()),
});


/** Build the codemode provider that bridges scaffold ↔ host. */
function buildHostProvider(opts: {
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
      const event = v.safeParse(ScaffoldEventSchema, args[0]);
      if (!event.success) return 'host.emit: invalid event';
      await pushEvent(event.output);
      return 'emitted';
    },
    callTool: async (...rawArgs: unknown[]) => {
      const name = v.safeParse(v.string(), rawArgs[0]);
      if (!name.success) return { error: 'host.callTool: name must be a string' };
      if (!callTool) return { error: 'host.callTool: unavailable in this runtime (parent provides ToolSet only when scaffold mode is enabled)' };
      const callId = `tc-${Math.random().toString(36).slice(2, 10)}`;
      const parsedArgs = v.safeParse(JsonObjectSchema, rawArgs[1]);
      const toolArgs = parsedArgs.success ? parsedArgs.output : {};
      await pushEvent({ type: 'tool_call', name: name.output, args: toolArgs, toolCallId: callId });
      try {
        const result = await callTool(name.output, toolArgs);
        await pushEvent({ type: 'tool_result', toolCallId: callId, result });
        return result;
      } catch (err) {
        const msg = renderThrownChain({ cause: err });
        await pushEvent({ type: 'tool_result', toolCallId: callId, result: { error: msg } });
        return { error: msg };
      }
    },
    llmStream: async (...args: unknown[]) => {
      // Returns the full concatenated text. The scaffold may also iterate by
      // calling llmStream({...}) again for additional turns — that's its
      // responsibility. We push 'text_delta' events as chunks arrive.
      const parsed = v.safeParse(LlmStreamOptionsSchema, args[0]);
      if (!parsed.success) return { error: 'host.llmStream: invalid options' };
      let acc = '';
      try {
        for await (const chunk of llmStream(parsed.output)) {
          acc += chunk;
          await pushEvent({ type: 'text_delta', text: chunk });
        }
        return acc;
      } catch (err) {
        const msg = renderThrownChain({ cause: err });
        await pushEvent({ type: 'error', message: `llmStream failed: ${msg}` });
        return { error: msg };
      }
    },
    defaultInference: async () => {
      // Run the agent's standard inference and stream its UI message chunks
      // back as 'ui_chunk' events. Lets a scaffold delegate to (or wrap) the
      // default loop without reimplementing it. The chunks are emitted
      // host-side — they do NOT round-trip through the sandbox per chunk.
      if (!defaultInference) {
        return { error: 'host.defaultInference: unavailable in this runtime' };
      }
      try {
        for await (const chunk of defaultInference()) {
          assertJsonValue(chunk);
          await pushEvent({ type: 'ui_chunk', chunk: chunk.value });
        }
        return 'done';
      } catch (err) {
        const msg = renderThrownChain({ cause: err });
        await pushEvent({ type: 'error', message: `defaultInference failed: ${msg}` });
        return { error: msg };
      }
    },
    history: async (...args: unknown[]) => {
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
      const path = v.safeParse(v.string(), args[0]);
      if (!path.success) return { error: 'host.readMemory: path must be a string' };
      try { return await readMemory(path.output); }
      catch (err) { return { error: renderThrownChain({ cause: err }) }; }
    },
    appendMemory: async (...args: unknown[]) => {
      const path = v.safeParse(v.string(), args[0]);
      const content = v.safeParse(v.string(), args[1]);
      if (!path.success || !content.success) {
        return { error: 'host.appendMemory: path and content must be strings' };
      }
      try { await appendMemory(path.output, content.output); return 'appended'; }
      catch (err) { return { error: renderThrownChain({ cause: err }) }; }
    },
  } satisfies Record<string, (...args: unknown[]) => Promise<JsonValue | undefined>>;

  return { name: 'host', fns, types: SCAFFOLD_HOST_TYPES };
}

/**
 * Execute the agent's current scaffold for one turn.
 *
 * Wraps the scaffold's `run(...)` invocation in a try/catch + timeout race.
 * Host-side bridges (LLM streaming, tool calls, emits) are exposed as
 * codemode providers so the scaffold body — which runs inside a sandboxed
 * Worker via DynamicWorkerExecutor — can call them as `host.emit(...)`,
 * `host.llmStream(...)`, `host.callTool(...)`.
 *
 * On any failure (parse, throw, timeout) returns ok=false; the orchestrator
 * is expected to fall back to streamText() and queue a scaffold rollback.
 */
export async function runScaffold(opts: ScaffoldRunOptions): Promise<ScaffoldRunResult> {
  const { rt, task, emit, llmStream, callTool, timeoutMs = SCAFFOLD_TURN_TIMEOUT_MS, scaffoldCodeOverride } = opts;
  const startedAt = Date.now();
  const capturedEvents: ScaffoldEvent[] = [];
  const state = {
    doneEmitted: false,
    finalResult: undefined,
  } satisfies { doneEmitted: boolean; finalResult: JsonValue | undefined };

  // 1. Load scaffold code (with optional shadow-mode override).
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

  // 2. Build host provider (LLM bridge + emit + callTool + memory + default
  // inference). Memory is bridged to rt.memory on the host side; the scaffold
  // reaches it only through host.* (the live `rt` object can't cross the
  // codemode sandbox boundary).
  const hostProvider = buildHostProvider({
    emit, llmStream, callTool,
    defaultInference: opts.defaultInference,
    history: opts.history,
    readMemory: async (path) => (await rt.memory.read(path)) ?? '',
    appendMemory: async (path, content) => { await rt.memory.append(path, content); },
    capturedEvents, state,
  });

  // 3. Build the wrapper code that defines `run` (from scaffold) and invokes
  // it with the task (injected as a literal) and the `host` global.
  // Scaffolds use `host.*` for all host interaction — `rt` is NOT a sandbox
  // global (the live object can't cross the boundary).
  const wrapperCode = buildScaffoldWrapperCode(code, task);

  // 4. Execute through the platform executor (codemode/DynamicWorkerExecutor on CF).
  const exec: Executor = rt.executor;
  const providers = await assembleProviders(rt, hostProvider);

  const execPromise = exec.execute(wrapperCode, providers, { timeoutMs });
  // The timer is cleared once the race settles. A live timer is invisible on
  // the DO, but it pins a CLI process open for the whole budget after every
  // scaffold turn — `kinu exec` hung for five minutes past its answer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ result: JsonValue | undefined; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ result: undefined, error: `scaffold timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
  });

  const result = await Promise.race([execPromise, timeoutPromise]).finally(() => clearTimeout(timer));
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

  // If the scaffold returned but never emitted 'done', synthesize one.
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

/**
 * Wrap scaffold source so that whether it exports `async function run(...)`
 * or `async function* run(rt, task)`, the wrapper code drives it correctly
 * and emits done at the end.
 *
 * We inject the scaffold source verbatim, then call `run`. For generator
 * scaffolds, we iterate the generator and forward each yield
 * to host.emit (mapping `{type:'chunk', data}` → text_delta).
 */
function buildScaffoldWrapperCode(scaffoldSource: string, task: string): string {
  // The scaffold source declares `async function run(...)` or
  // `async function* run(...)`. We append a driver that invokes it and
  // handles both shapes uniformly.
  //
  // The task is injected as a JSON literal (the live `rt` object cannot cross
  // the codemode sandbox boundary, so the scaffold uses `host.*` + this task).
  // `rt` is passed as the literal task string for the 2-arg generator
  // signature `run(rt, task)` — both params receive the task so a scaffold
  // can read it from either; neither is the host `rt` object.
  //
  // DynamicWorkerExecutor wraps the user code in `(async () => { <code> })()`,
  // so top-level `async function run(...)` declarations live inside the IIFE.
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
  await host.emit({ type: 'error', message: (e && e.message) ? e.message : String(e) });
  throw e;
}
return __result;
`;
}

/**
 * Assemble codemode providers for scaffold execution.
 *
 * Includes:
 *   • host          — the bridge to LLM stream / tool calls / emits
 *   • workspace/etc — every sandbox the parent's ExecutionRouter knows about
 */
async function assembleProviders(
  rt: AgentRuntime,
  hostProvider: { name: string; fns: SandboxFunctions; types?: string },
): Promise<Array<{ name: string; fns: SandboxFunctions; types?: string }>> {
  const out: Array<{ name: string; fns: SandboxFunctions; types?: string }> = [
    hostProvider,
  ];
  const routerProviders = rt.executionRouter?.getProviders() ?? [];
  for (const p of routerProviders) {
    const fns: SandboxFunctions = {};
    for (const [name, descriptor] of Object.entries(p.tools)) {
      fns[name] = async (...args: JsonValue[]) => {
        const result = await descriptor.execute(...args);
        return result === undefined ? undefined : decodeJsonValue({ value: result });
      };
    }
    out.push({ name: p.name, fns, types: p.types });
  }
  return out;
}
