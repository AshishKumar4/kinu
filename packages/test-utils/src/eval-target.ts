/**
 * Which backend a live tier runs against, and the ledger reads every tier shares: an episode's
 * totals, time order over a ledger, and the run a mid-turn landing is answered by. Depends only on
 * `@kinu.run/core` (core devDepends on this package).
 */
import { classifyToolFailure } from '@kinu.run/core';
import type { RunEvent } from '@kinu.run/core';

/** `local`: the in-process `cli-backend` runtime. `cloud`: a workspace on the deployment. */
export type EvalBackend = 'local' | 'cloud';

/** Read once and reported; never inferred from credentials. */
export const EVAL_BACKEND_ENV = 'KINU_EVAL_BACKEND';

/** The target for this process; defaults to `local`, and an unrecognised value throws rather than falling back. */
export type EvalBackendResolution =
  | { readonly kind: 'ready'; readonly backend: EvalBackend }
  | { readonly kind: 'refused'; readonly reason: string };

export function resolveEvalBackend(
  env: Record<string, string | undefined> = { [EVAL_BACKEND_ENV]: process.env.KINU_EVAL_BACKEND },
): EvalBackendResolution {
  const raw = env[EVAL_BACKEND_ENV]?.trim();

  if (raw === undefined || raw === '') return { kind: 'ready', backend: 'local' };

  if (raw === 'local' || raw === 'cloud') return { kind: 'ready', backend: raw };

  return {
    kind: 'refused',
    reason: `${EVAL_BACKEND_ENV}=${raw} names no target. It is \`local\` (the in-process `
      + 'cli-backend runtime) or `cloud` (a workspace on the deployment). Unset it '
      + 'for local.',
  };
}

/** What the ledger says one episode did. */
export interface LedgerTotals {
  turns: number;
  toolCalls: number;
  toolNames: string[];
  tokensIn: number;
  tokensOut: number;
  reasoningOut: number;
  /** Model steps the episode closed, counted from `step_finish`. */
  steps: number;
  /** Why a turn produced nothing; "0 tool calls" alone cannot tell a declining model from a failing provider. */
  failures: string[];
}

/** Prefix marking a turn's own provider error in {@link LedgerTotals.failures}; `environmentFailure` matches on it. */
export const RUN_END_FAILURE_PREFIX = 'run_end: ';

/** Episode totals reduced from `RunEvent[]`. */
export function ledgerTotalsFromEvents(events: readonly RunEvent[]): LedgerTotals {
  let turns = 0, toolCalls = 0, tokensIn = 0, tokensOut = 0, reasoningOut = 0, steps = 0;
  const toolNames: string[] = [];
  const failures: string[] = [];

  for (const event of events) {
    if (event.type === 'turn_end') {
      turns += 1;
      tokensIn += event.usage?.input ?? 0;
      tokensOut += event.usage?.output ?? 0;
      reasoningOut += event.usage?.reasoning ?? 0;
    } else if (event.type === 'tool_call_end') {
      toolCalls += 1;
      toolNames.push(event.name);
      const failure = classifyToolFailure(event);

      if (failure) failures.push(`${event.name}: ${event.error ?? failure.reason}`);
    } else if (event.type === 'step_finish') {
      steps += 1;
    } else if (event.type === 'error') {
      failures.push(event.message);
    } else if (event.type === 'run_end' && event.error != null && event.error !== '') {
      failures.push(`${RUN_END_FAILURE_PREFIX}${event.error}`);
    }
  }

  return { turns, toolCalls, toolNames, tokensIn, tokensOut, reasoningOut, steps, failures };
}

/** Time order over a ledger: timestamp, run, then the recorder's index within the run. */
export function compareRunEventOrder(a: RunEvent, b: RunEvent): number {
  return a.timestamp.localeCompare(b.timestamp)
    || a.runId.localeCompare(b.runId)
    || a.eventIndex - b.eventIndex;
}


/**
 * The run a mid-turn landing is answered by: the run open at `landedAt` (ISO, same clock as `timestamp`).
 * A mid-turn prompt opens no run of its own. Without `landedAt`, the live run or the most recently closed one.
 */
export function absorbingRunId(
  events: readonly RunEvent[], landedAt?: string,
): string | null {
  const starts = new Map<string, string>();
  const ends = new Map<string, string>();

  for (const event of events) {
    if (event.type === 'run_start') starts.set(event.runId, event.timestamp);

    if (event.type === 'run_end') ends.set(event.runId, event.timestamp);
  }

  if (starts.size === 0) return null;

  if (landedAt !== undefined) {
    // Open at the landing: started no later, and no `run_end` before it.
    const open = [...starts.entries()].filter(([runId, started]) => {
      const ended = ends.get(runId);

      return started <= landedAt && (ended === undefined || ended > landedAt);
    });

    if (open.length > 0) {
      open.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

      return open[open.length - 1][0];
    }

    // The run closed between write and read: the latest run ending at or after the landing.
    const closed = [...ends.entries()].filter(([, ended]) => ended >= landedAt)
      .sort((a, b) => b[1].localeCompare(a[1]) || b[0].localeCompare(a[0]));

    if (closed.length > 0) return closed[0][0];

    // No run admits the landing; the send said mid-turn, so the latest run answered.
    return [...starts.entries()].sort((a, b) =>
      a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))[starts.size - 1][0];
  }

  const live = [...starts].filter(([runId]) => !ends.has(runId))
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

  if (live.length > 0) return live[live.length - 1][0];

  const closed = [...ends.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]) || b[0].localeCompare(a[0]));

  return closed[0]?.[0] ?? null;
}
