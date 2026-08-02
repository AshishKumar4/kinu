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
 * Plus any sandboxes registered on the parent (sandbox.*, nimbus.*, laptop.*).
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

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { Executor } from '../types/primitives.js';

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
    messages: Array<{ role: string; content: string }>;
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
}`;

/** What scaffold execution emits back to the caller. */
export type ScaffoldEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; toolCallId: string }
  | { type: 'tool_result'; toolCallId: string; result: unknown }
  | { type: 'step_finish'; stepIndex: number; reason?: string }
  | { type: 'done'; result?: unknown }
  | { type: 'error'; message: string }
  /** A ready-made AI-SDK UI message stream chunk, emitted by
   *  `host.defaultInference()`. Passed through verbatim by the adapter. */
  | { type: 'ui_chunk'; chunk: unknown };

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
  if (event.type === 'ui_chunk') {
    const c = event.chunk as { type?: string; delta?: string } | undefined;
    if (c?.type === 'text-delta' && typeof c.delta === 'string') return c.delta;
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
  finalResult?: unknown;
}

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
    messages: Array<{ role: string; content: string }>;
    tools?: string[];
    maxSteps?: number;
  }) => AsyncIterable<string>;
  /**
   * Tool invoker — when the scaffold calls host.callTool(name, args), this
   * function executes the tool from the parent's ToolSet and returns the
   * result. The host emits both 'tool_call' and 'tool_result' events.
   */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Default-inference bridge — when the scaffold calls host.defaultInference(),
   * this runs the standard host inference (the AI SDK streamText the agent
   * would otherwise use) and streams its UI message chunks back as
   * 'ui_chunk' events. Lets a scaffold delegate to / wrap the default loop
   * instead of reimplementing the tool-call loop. Absent means this host
   * capability is unavailable and host.defaultInference returns an error.
   */
  defaultInference?: () => AsyncIterable<unknown>;
  /** Hard timeout in milliseconds. Default 5 min. */
  timeoutMs?: number;
  /** Optional: override the scaffold code (for shadow-mode A/B). Default: rt.identity.scaffold.read(). */
  scaffoldCodeOverride?: string;
}

/** Build the codemode provider that bridges scaffold ↔ host. */
function buildHostProvider(opts: {
  emit: ScaffoldEmitFn;
  llmStream: ScaffoldRunOptions['llmStream'];
  callTool?: ScaffoldRunOptions['callTool'];
  defaultInference?: ScaffoldRunOptions['defaultInference'];
  readMemory: (path: string) => Promise<string>;
  appendMemory: (path: string, content: string) => Promise<void>;
  capturedEvents: ScaffoldEvent[];
  state: { doneEmitted: boolean; finalResult: unknown };
}): { name: string; fns: Record<string, (...args: unknown[]) => Promise<unknown>>; types: string } {
  const { emit, llmStream, callTool, defaultInference, readMemory, appendMemory, capturedEvents, state } = opts;

  async function pushEvent(ev: ScaffoldEvent): Promise<void> {
    capturedEvents.push(ev);
    if (ev.type === 'done') {
      state.doneEmitted = true;
      state.finalResult = ev.result;
    }
    await emit(ev);
  }

  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    emit: async (event: unknown) => {
      if (event == null || typeof event !== 'object') return 'host.emit: invalid event';
      const ev = event as ScaffoldEvent;
      if (!('type' in ev) || typeof ev.type !== 'string') return 'host.emit: missing type';
      await pushEvent(ev);
      return 'emitted';
    },
    callTool: async (name: unknown, args: unknown) => {
      if (typeof name !== 'string') return { error: 'host.callTool: name must be a string' };
      if (!callTool) return { error: 'host.callTool: unavailable in this runtime (parent provides ToolSet only when scaffold mode is enabled)' };
      const callId = `tc-${Math.random().toString(36).slice(2, 10)}`;
      const parsedArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? args as Record<string, unknown> : {};
      await pushEvent({ type: 'tool_call', name, args: parsedArgs, toolCallId: callId });
      try {
        const result = await callTool(name, parsedArgs);
        await pushEvent({ type: 'tool_result', toolCallId: callId, result });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await pushEvent({ type: 'tool_result', toolCallId: callId, result: { error: msg } });
        return { error: msg };
      }
    },
    llmStream: async (rawOpts: unknown) => {
      // Returns the full concatenated text. The scaffold may also iterate by
      // calling llmStream({...}) again for additional turns — that's its
      // responsibility. We push 'text_delta' events as chunks arrive.
      const o = rawOpts as Parameters<ScaffoldRunOptions['llmStream']>[0];
      let acc = '';
      try {
        for await (const chunk of llmStream(o)) {
          acc += chunk;
          await pushEvent({ type: 'text_delta', text: chunk });
        }
        return acc;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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
          await pushEvent({ type: 'ui_chunk', chunk });
        }
        return 'done';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await pushEvent({ type: 'error', message: `defaultInference failed: ${msg}` });
        return { error: msg };
      }
    },
    readMemory: async (path: unknown) => {
      try { return await readMemory(String(path)); }
      catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
    },
    appendMemory: async (path: unknown, content: unknown) => {
      try { await appendMemory(String(path), String(content)); return 'appended'; }
      catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
    },
  };

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
  const { rt, task, emit, llmStream, callTool, timeoutMs = 5 * 60 * 1000, scaffoldCodeOverride } = opts;
  const startedAt = Date.now();
  const capturedEvents: ScaffoldEvent[] = [];
  const state = { doneEmitted: false, finalResult: undefined as unknown };

  // 1. Load scaffold code (with optional shadow-mode override).
  let code: string;
  try {
    code = scaffoldCodeOverride ?? (await rt.identity.scaffold.read());
  } catch (err) {
    const msg = `scaffold read failed: ${err instanceof Error ? err.message : String(err)}`;
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
  const timeoutPromise = new Promise<{ result: unknown; error: string }>((resolve) =>
    setTimeout(
      () => resolve({ result: undefined, error: `scaffold timeout after ${timeoutMs}ms` }),
      timeoutMs,
    ),
  );

  const result = await Promise.race([execPromise, timeoutPromise]);
  const durationMs = Date.now() - startedAt;

  if ((result as { error?: string }).error) {
    const msg = (result as { error: string }).error;
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
  hostProvider: { name: string; fns: Record<string, (...args: unknown[]) => Promise<unknown>>; types?: string },
): Promise<Array<{ name: string; fns: Record<string, (...args: unknown[]) => Promise<unknown>>; types?: string }>> {
  const out: Array<{ name: string; fns: Record<string, (...args: unknown[]) => Promise<unknown>>; types?: string }> = [
    hostProvider,
  ];
  const routerProviders = rt.executionRouter?.getProviders() ?? [];
  for (const p of routerProviders) {
    const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, descriptor] of Object.entries(p.tools)) {
      fns[name] = descriptor.execute as (...args: unknown[]) => Promise<unknown>;
    }
    out.push({ name: p.name, fns, types: p.types });
  }
  return out;
}
