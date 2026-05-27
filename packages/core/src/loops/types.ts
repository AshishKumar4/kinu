// InferenceLoop — the universal contract for any "run a turn" implementation.
//
// Proteus has three coexisting loops today (Think's streamText, the scaffold
// codemode loop, and the Heads parallel-then-merge loop), each with a
// different signature. This interface picks RunEvent as the shared currency
// so caching, instrumentation, replay, eval, and middleware all compose
// against ONE event stream.
//
// To add a new loop (Recursive Language Models, Reflexion, MemGPT-style, …):
//   1. Implement `InferenceLoop`: `run(ctx) → AsyncIterable<RunEvent>`
//   2. Register it via `inferenceLoopRegistry.register(myLoop)`
//   3. Set `agent_config.inference_loop = 'my-loop'` (or pick per-turn).
// That's the entire wiring.

import type { LanguageModel, ToolSet } from 'ai';
import type { RunEvent } from '../events/types.js';
import type { AgentRuntime } from '../types/agent-runtime.js';

/** Per-turn context handed to a Loop. Carries everything a loop might
 *  need without forcing it to take a dependency on Think internals. */
export interface LoopContext {
  /** Stable turn id. Inherited from the run-event log. */
  runId: string;
  /** The user's task (prose). */
  task: string;
  /** Resolved language model — same instance the orchestrator's Think loop
   *  would have used. The loop may resolve its own per-step models. */
  model: LanguageModel;
  /** System prompt prefix. */
  system: string;
  /** Tools available to the loop. */
  tools: ToolSet;
  /** Conversation history (caller-controlled — Think's history if you're the
   *  default loop, parent-head context if you're a sub-loop, etc.). */
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
  /** Runtime — gives the loop access to VFS, memory, executors, etc. */
  rt: AgentRuntime;
  /** Optional per-turn budget. */
  budget?: { tokens?: number; wallClockMs?: number; steps?: number };
  /** AbortSignal — the loop must check it during long iterations. */
  signal?: AbortSignal;
}

export interface InferenceLoop {
  /** Stable id used in agent_config.inference_loop. */
  readonly id: string;
  /** Human label. */
  readonly label?: string;
  /** Describe the loop in one short sentence — surfaced in the UI picker. */
  readonly description?: string;
  /** Stream RunEvents as the turn progresses. The last event should be a
   *  `turn_end` or `run_end` event. The caller (orchestrator) is responsible
   *  for persistence — the loop only yields. */
  run(ctx: LoopContext): AsyncIterable<RunEvent>;
}

export interface InferenceLoopRegistry {
  register(loop: InferenceLoop): void;
  get(id: string): InferenceLoop | undefined;
  list(): InferenceLoop[];
}

export function createInferenceLoopRegistry(): InferenceLoopRegistry {
  const byId = new Map<string, InferenceLoop>();
  const ordered: InferenceLoop[] = [];
  return {
    register(loop) {
      if (byId.has(loop.id)) throw new Error(`InferenceLoop ${loop.id} already registered`);
      byId.set(loop.id, loop);
      ordered.push(loop);
    },
    get(id) { return byId.get(id); },
    list() { return [...ordered]; },
  };
}
