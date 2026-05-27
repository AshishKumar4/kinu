/**
 * Run events — Flue-style discriminated union for everything that happens
 * during an agent run.
 *
 * Persisted in run_events table; queried via /api/runs/<runId>/events;
 * streamed via /api/runs/<runId>/stream (SSE w/ Last-Event-ID resume).
 *
 * Each event carries `runId` + `eventIndex` (monotonic per run) + `timestamp`.
 * Consumers may filter by `type` and slice by index.
 */

export type RunEventType =
  | 'run_start'
  | 'turn_start'
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'step_finish'
  | 'head_split'
  | 'head_merge'
  | 'scaffold_promotion'
  | 'scaffold_rollback'
  | 'memory_write'
  | 'fiber_recovered'
  | 'error'
  | 'turn_end'
  | 'run_end';

export interface RunEventBase {
  /** Unique within a single run; monotonically increasing. */
  readonly eventIndex: number;
  /** Unique run identifier (typically the chat turn id or a fresh nanoid). */
  readonly runId: string;
  readonly type: RunEventType;
  /** ISO timestamp at emission time. */
  readonly timestamp: string;
}

export type RunEvent =
  | (RunEventBase & { type: 'run_start'; agentId: string; userMessage?: string })
  | (RunEventBase & { type: 'turn_start'; turnIndex: number })
  | (RunEventBase & { type: 'text_delta'; text: string })
  | (RunEventBase & { type: 'tool_call_start'; name: string; args: Record<string, unknown>; toolCallId: string })
  | (RunEventBase & { type: 'tool_call_end'; name: string; toolCallId: string; result?: unknown; error?: string; durationMs?: number })
  | (RunEventBase & { type: 'step_finish'; stepIndex: number; reason?: string })
  | (RunEventBase & { type: 'head_split'; rootId: string; headIds: string[]; rationale: string })
  | (RunEventBase & { type: 'head_merge'; rootId: string; headCount: number; mergedNarrative: string })
  | (RunEventBase & { type: 'scaffold_promotion'; fromVersion: number; toVersion: number })
  | (RunEventBase & { type: 'scaffold_rollback'; fromVersion: number; toVersion: number })
  | (RunEventBase & { type: 'memory_write'; path: string; bytes: number })
  | (RunEventBase & { type: 'fiber_recovered'; fiberName: string; fiberId: string; snapshot?: unknown })
  | (RunEventBase & { type: 'error'; message: string; details?: unknown })
  | (RunEventBase & { type: 'turn_end'; turnIndex: number; tokenUsage?: { input: number; output: number } })
  | (RunEventBase & { type: 'run_end'; reason?: string });

/** A new event payload sans the base fields the recorder fills in. */
export type RunEventInput = {
  [K in RunEvent['type']]: Omit<Extract<RunEvent, { type: K }>, keyof RunEventBase> & { type: K }
}[RunEvent['type']];
