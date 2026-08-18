/**
 * The Run Timeline read model — ONE server-side merge of the four durable
 * sources a turn leaves behind (per-run `run_events`, the agent-level
 * `evolution_events` stream, the MCTS `search_nodes`, and detached background
 * jobs) into a single ordered span list.
 *
 * The merge is the point: a client that fetched three RPCs and merged them
 * itself would be a fourth place that has to agree about ordering, and would
 * drift. Nothing here is backend-shaped — every source is a table or a core
 * store — so a timeline is a capability any backend has, not one the Durable
 * Object happened to grow.
 */

import type { RunEventRecorder } from '../events/recorder.js';
import type { RunEvent } from '../events/types.js';
import type { BackgroundJobStore } from '../jobs/store.js';
import type { SqlExecutor } from '../types/primitives.js';
import type { Usage } from '../usage.js';
import { parseJsonValue, type JsonValue } from '../utils/json.js';

export type TimelineKind =
  | 'llm-turn' | 'tool-call' | 'runtime-exec' | 'mcts' | 'scaffold' | 'shadow-eval'
  | 'craft' | 'reflection' | 'head-split' | 'head-merge' | 'gepa' | 'skills'
  | 'curriculum' | 'trigger' | 'event-ingress' | 'background' | 'error' | 'abort' | 'recovery' | 'other';

/** One typed span on the unified spine. */
export interface TimelineSpan {
  ts: number;
  kind: TimelineKind;
  label: string;
  detail?: string;
  /** Latency in ms when known (tool calls, activity timings). */
  elapsedMs?: number;
  /** Preserved structured payload (e.g. evolution_events.data) for drill-in. */
  data?: JsonValue;
  source: 'run' | 'evolution' | 'mcts' | 'background';
  /** Id for driving the work surface (node id, run-event id, root id…). */
  refId?: string;
  /** Original backend event type, for finer affordances. */
  rawType?: string;
}

export function safeJsonParse(s: string): JsonValue {
  try { return parseJsonValue(s); } catch { return s; }
}

/** Map a crafted/builtin tool name to a timeline kind. `think` is the
 *  pre-unification exploration tool — stored run events keep its kind. The
 *  unified `agents` tool stays a plain tool-call span (run events carry no
 *  arguments to tell a fork from a staff/ask); fork runs still surface as
 *  exploration through their head_split / head_merge spans. */
export function toolKindFor(name: string): TimelineKind {
  if (name === 'run') return 'runtime-exec';
  if (name === 'think') return 'mcts';
  if (name === 'skills') return 'skills';
  return 'tool-call';
}

/** Map an evolution_events.type to a timeline kind. */
export function classifyEvolutionType(type: string): TimelineKind {
  if (type === 'turn_complete') return 'llm-turn';
  if (type === 'reflection') return 'reflection';
  if (type.startsWith('scaffold')) return 'scaffold';
  if (type.startsWith('mcts')) return 'mcts';
  if (type === 'consolidation' || type === 'craft_discovered') return 'craft';
  if (type === 'fiber_recovered') return 'recovery';
  if (type.startsWith('gepa')) return 'gepa';
  if (type.startsWith('curriculum')) return 'curriculum';
  return 'other';
}

/**
 * The token figure on a finished turn's span, printing only what the provider
 * actually reported.
 *
 * A one-line span label has no room to explain a silence, so an unreported side
 * is left out of the string entirely and a turn that reported neither gets no
 * detail at all — the reader sees no number rather than a zero the provider
 * never claimed.
 */
function turnUsageDetail(usage: Usage | undefined): string | undefined {
  const parts: string[] = [];
  if (usage?.input !== undefined) parts.push(`${usage.input} in`);
  if (usage?.output !== undefined) parts.push(`${usage.output} out`);
  return parts.length === 0 ? undefined : `${parts.join(' + ')} tok`;
}

/** Project a durable RunEvent onto a unified TimelineSpan. */
export function runEventToSpan(e: RunEvent): TimelineSpan {
  const ts = Date.parse(e.timestamp) || Date.now();
  const base = { ts, source: 'run' as const, rawType: e.type };
  switch (e.type) {
    case 'run_start':
      return { ...base, kind: 'trigger', label: e.caused_by ? `Run started · ${e.caused_by}` : 'Run started', detail: e.userMessage };
    case 'turn_start':
      return { ...base, kind: 'llm-turn', label: `Turn ${e.turnIndex}` };
    case 'tool_call_end':
      return {
        ...base, kind: toolKindFor(e.name), label: e.error ? `${e.name} failed` : e.name,
        detail: e.error, elapsedMs: e.durationMs, refId: e.toolCallId,
      };
    case 'step_finish':
      return { ...base, kind: 'llm-turn', label: `Step ${e.stepIndex}`, detail: e.reason };
    case 'head_split':
      return { ...base, kind: 'head-split', label: 'Heads split', detail: e.rationale, data: { rootId: e.rootId, headIds: e.headIds }, refId: e.rootId };
    case 'head_merge':
      return { ...base, kind: 'head-merge', label: `Heads merged (${e.headCount})`, detail: e.mergedNarrative?.slice(0, 200), refId: e.rootId };
    case 'head_abandoned':
      return {
        ...base, kind: 'abort', label: `Heads abandoned (${e.abandoned} of ${e.headCount})`,
        detail: e.rationale || e.reason, refId: e.rootId,
      };
    case 'scaffold_promotion':
      return { ...base, kind: 'scaffold', label: `Scaffold promoted v${e.fromVersion} → v${e.toVersion}` };
    case 'scaffold_rollback':
      return { ...base, kind: 'scaffold', label: `Scaffold rolled back v${e.fromVersion} → v${e.toVersion}` };
    case 'memory_write':
      return { ...base, kind: 'craft', label: 'Memory write', detail: `${e.path} (${e.bytes}b)` };
    case 'fiber_recovered':
      return { ...base, kind: 'recovery', label: `Recovered fiber "${e.fiberName}"` };
    case 'error':
      return { ...base, kind: 'error', label: 'Error', detail: e.message };
    case 'turn_end':
      return { ...base, kind: 'llm-turn', label: `Turn ${e.turnIndex} done`, detail: turnUsageDetail(e.usage) };
    case 'run_end':
      return { ...base, kind: e.reason === 'aborted' ? 'abort' : 'other', label: e.reason ? `Run ended (${e.reason})` : 'Run ended', detail: e.error };
    default:
      return { ...base, kind: 'other', label: e.type };
  }
}

export interface RunTimelineDeps {
  readonly sql: SqlExecutor;
  readonly events: RunEventRecorder;
  readonly jobs: BackgroundJobStore;
  /** The in-flight run, when a turn is running — the default focus. */
  readonly currentRunId: string | null;
}

/**
 * Merge the sources into one ordered timeline. Defaults to the active run,
 * else the most recent recorded one. Every source is a table
 * `initWorkspaceSchema` creates, so a failing read means a broken workspace
 * rather than an idle one — the error reaches the caller instead of being
 * rendered as a timeline that is silently missing one of its four spines.
 */
export function getRunTimeline(
  deps: RunTimelineDeps,
  opts?: { runId?: string; limit?: number },
): TimelineSpan[] {
  const limit = opts?.limit ?? 200;
  const recent = deps.sql<{ run_id: string }>`
    SELECT run_id FROM run_events ORDER BY ts DESC LIMIT 1`[0]?.run_id;
  const runId = opts?.runId || deps.currentRunId || recent;
  const spans: TimelineSpan[] = [];

  // 1) Durable per-run events for the focused run.
  if (runId) {
    for (const e of deps.events.read(runId, { limit })) spans.push(runEventToSpan(e));
  }
  // 2) Agent-level evolution events — PRESERVE the `data` payload.
  const evolutionRows = deps.sql<{ id: string; type: string; message: string; data: string | null; created_at: number }>`
    SELECT id, type, message, data, created_at FROM evolution_events ORDER BY created_at DESC LIMIT ${limit}`;
  for (const r of evolutionRows) {
    spans.push({
      ts: r.created_at, kind: classifyEvolutionType(r.type), label: r.message || r.type,
      data: r.data ? safeJsonParse(r.data) : undefined,
      source: 'evolution', refId: r.id, rawType: r.type,
    });
  }
  // 3) MCTS search nodes.
  const nodes = deps.sql<{ id: string; action: string; value: number; status: string; created_at: number }>`
    SELECT id, action, value, status, created_at FROM search_nodes ORDER BY created_at DESC LIMIT ${limit}`;
  for (const n of nodes) {
    spans.push({
      ts: n.created_at, kind: 'mcts', label: n.action || `node ${n.id.slice(0, 8)}`,
      detail: `value ${Number(n.value).toFixed(2)} · ${n.status}`,
      source: 'mcts', refId: n.id,
    });
  }
  // 4) Background jobs — auto-detached >30s tool calls, as first-class spans
  // (the run that "ended" because work moved to the background must say so).
  for (const j of deps.jobs.list(limit)) {
    const detail = j.status === 'running' ? 'running in background'
      : j.error ? `${j.status}: ${j.error}` : j.status;
    spans.push({
      ts: j.createdAt, kind: 'background',
      label: `Background ${j.kind}`, detail,
      source: 'background', refId: j.id, rawType: j.status,
    });
  }

  spans.sort((a, b) => a.ts - b.ts);
  return spans.slice(-limit);
}
