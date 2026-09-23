/**
 * Run Timeline: one server-side merge of `run_events`, `evolution_events`, `search_nodes` and
 * background jobs into an ordered span list, so clients never merge and drift.
 */

import type { RunEventRecorder } from '../events/recorder';
import type { RunEvent } from '../events/types';
import type { BackgroundJobStore } from '../jobs/store';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { Usage } from '../usage';
import { safeJsonParse, type JsonValue } from '../utils/json';
import { boundedInt } from '../utils/bounds';

export type TimelineKind =
  | 'llm-turn' | 'tool-call' | 'runtime-exec' | 'mcts' | 'scaffold' | 'shadow-eval'
  | 'craft' | 'reflection' | 'head-split' | 'head-merge' | 'gepa' | 'skills'
  | 'curriculum' | 'trigger' | 'event-ingress' | 'background' | 'error' | 'abort' | 'recovery' | 'other';

export interface TimelineSpan {
  ts: number;
  kind: TimelineKind;
  label: string;
  detail?: string;
  /** Latency in ms when known. */
  elapsedMs?: number;
  /** Preserved structured payload (e.g. evolution_events.data). */
  data?: JsonValue;
  source: 'shell' | 'evolution' | 'mcts' | 'background';
  /** Node id, run-event id, root id… */
  refId?: string;
  rawType?: string;
}

/** `think` is the pre-unification exploration tool; stored run events keep its kind. `agents`
 *  stays a plain tool-call: run events carry no arguments to tell a fork from a hire. */
export function toolKindFor(name: string): TimelineKind {
  if (name === 'shell') return 'runtime-exec';

  if (name === 'think') return 'mcts';

  if (name === 'skills') return 'skills';

  return 'tool-call';
}

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

/** Token figure on a finished turn's span; unreported sides are omitted, never shown as zero. */
function turnUsageDetail(usage: Usage | undefined): string | undefined {
  const parts: string[] = [];

  if (usage?.input !== undefined) parts.push(`${usage.input} in`);

  if (usage?.output !== undefined) parts.push(`${usage.output} out`);

  return parts.length === 0 ? undefined : `${parts.join(' + ')} tok`;
}

/** Shown by name only; a new event type must be placed here or given a switch arm. */
type DiagnosisOnlyEvent = Extract<RunEvent, { type:
  | 'step_partial'
  | 'model_call'
  | 'provider_wait'
  | 'model_operation'
  | 'db_op'
  | 'context_edit'
  | 'context_budget'
  | 'file_edit'
  | 'turn_steering'
  | 'profile_resolution'
  | 'completion_gate'
  | 'craft_cycle'
  | 'execution_recovery'
  | 'approval_consumed'
  | 'execution_escalation'
  | 'budget_exhausted'
}>;

const DIAGNOSIS_ONLY_EVENTS: ReadonlySet<string> = new Set<DiagnosisOnlyEvent['type']>([
  'step_partial',
  'model_call',
  'provider_wait',
  'model_operation',
  'db_op',
  'context_edit',
  'context_budget',
  'file_edit',
  'turn_steering',
  'profile_resolution',
  'completion_gate',
  'craft_cycle',
  'execution_recovery',
  'approval_consumed',
  'execution_escalation',
  'budget_exhausted',
]);

function isDiagnosisOnly(e: RunEvent): e is DiagnosisOnlyEvent {
  return DIAGNOSIS_ONLY_EVENTS.has(e.type);
}

export function runEventToSpan(e: RunEvent): TimelineSpan {
  const ts = Date.parse(e.timestamp) || Date.now();
  const base = { ts, source: 'shell' as const, rawType: e.type };

  if (isDiagnosisOnly(e)) return { ...base, kind: 'other', label: e.type };

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
  }
}

export interface RunTimelineDeps {
  readonly sql: SqlExecutor;
  /** Evolution and search reads are actor-scoped, as `run_events` is. */
  readonly actor: ActorHandle;
  readonly events: RunEventRecorder;
  readonly jobs: BackgroundJobStore;
  /** The in-flight run, the default focus. */
  readonly currentRunId: string | null;
}

/** The CLI's local peer keeps its own default of 100 and shares only the ceiling. */
const RUN_TIMELINE_DEFAULT = 200;

/** Admits the widest recorded caller (`kinu timeline`), matching `ACTIVITY_STEP_WINDOW` at 400. */
export const RUN_TIMELINE_MAX = 400;

/** Merge sources into one ordered timeline, focused on the active run, else the most recent one. */
export function getRunTimeline(
  deps: RunTimelineDeps,
  opts?: { runId?: string; limit?: number },
): TimelineSpan[] {
  // Closed once: `@callable` reaches this and the value feeds four `LIMIT` binds and `slice(-limit)`.
  const limit = boundedInt(opts?.limit, RUN_TIMELINE_DEFAULT, 1, RUN_TIMELINE_MAX);
  // Via the recorder: actor-scoped, and `listRunsBefore` excludes WORKSPACE_RUN_ID.
  const recent = deps.events.listRunsBefore(null, 1)[0]?.runId;
  // An empty id names no run and falls through like an absent one.
  const runId = [opts?.runId, deps.currentRunId, recent].find((id) => id !== null && id !== undefined && id !== '');
  const spans: TimelineSpan[] = [];

  if (runId) {
    for (const e of deps.events.read(runId, { limit })) spans.push(runEventToSpan(e));
  }

  // Preserve the `data` payload.
  const evolutionRows = deps.sql<{ id: string; type: string; message: string; data: string | null; created_at: number }>`
    SELECT id, type, message, data, created_at FROM evolution_events
    WHERE actor_id = ${deps.actor.actorId} ORDER BY created_at DESC LIMIT ${limit}`;

  for (const r of evolutionRows) {
    spans.push({
      ts: r.created_at, kind: classifyEvolutionType(r.type), label: r.message || r.type,
      data: r.data ? safeJsonParse(r.data) : undefined,
      source: 'evolution', refId: r.id, rawType: r.type,
    });
  }

  const nodes = deps.sql<{ id: string; action: string; value: number; status: string; created_at: number }>`
    SELECT id, action, value, status, created_at FROM search_nodes
    WHERE actor_id = ${deps.actor.actorId} ORDER BY created_at DESC LIMIT ${limit}`;

  for (const n of nodes) {
    spans.push({
      ts: n.created_at, kind: 'mcts', label: n.action || `node ${n.id.slice(0, 8)}`,
      detail: `value ${Number(n.value).toFixed(2)} · ${n.status}`,
      source: 'mcts', refId: n.id,
    });
  }

  // A run that ended because work moved to the background must say so.
  for (const j of deps.jobs.list(limit)) {
    const failure = j.error === null || j.error === '' ? null : `${j.status}: ${j.error}`;
    const detail = j.status === 'running' ? 'running in background' : (failure ?? j.status);

    spans.push({
      ts: j.createdAt, kind: 'background',
      label: `Background ${j.kind}`, detail,
      source: 'background', refId: j.id, rawType: j.status,
    });
  }

  spans.sort((a, b) => a.ts - b.ts);

  return spans.slice(-limit);
}
