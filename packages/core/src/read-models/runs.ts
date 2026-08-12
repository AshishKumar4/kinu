/**
 * Run reads over the durable event log.
 *
 * `run_events` is written by every backend and is the only history of what a
 * turn did, so the three shapes a surface asks for — one run's events, the
 * list of runs, and the provenance/cost fold across runs — are the same three
 * everywhere. None of them touches storage the log does not already own.
 *
 * All three are read-tolerant: a workspace can predate `run_events`, and a
 * history panel that throws instead of showing nothing is strictly worse.
 */

import type { RunEventQuery, RunEventRecorder } from '../events/recorder.js';
import type { RunEvent } from '../events/types.js';

export interface RunListEntry {
  runId: string;
  lastTs: string;
  eventCount: number;
}

/** A run with PROVENANCE (what kicked it off) and COST (tokens spent). */
export interface RunSummary extends Pick<RunListEntry, 'runId' | 'eventCount'> {
  startedAt: number;
  causedBy: string | null;
  userMessage: string | null;
  status: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
}

/** One run's durable events — what an SSE resume replays from (`since` = last
 *  seen index). */
export function getRunEvents(events: RunEventRecorder, runId: string, opts: RunEventQuery = {}): RunEvent[] {
  try { return events.read(runId, opts); }
  catch { return []; }
}

/** Recent runs with their latest timestamp + event count, newest first. */
export function listRuns(events: RunEventRecorder, limit = 50): RunListEntry[] {
  try { return events.listRuns(limit); }
  catch { return []; }
}

/**
 * Recent runs folded with the per-run `run_start` (what caused it) and the
 * summed `turn_end` token usage — the cross-run history + budget view. A run
 * whose events are unreadable still reports its bare summary.
 */
export function getRunSummaries(events: RunEventRecorder, limit = 30): RunSummary[] {
  return listRuns(events, limit).map((run) => {
    let tokensIn = 0, tokensOut = 0, tokensCached = 0;
    let causedBy: string | null = null, userMessage: string | null = null, status: string | null = null;
    let startedAt = Date.parse(run.lastTs) || Date.now();
    for (const e of getRunEvents(events, run.runId, { limit: 1000 })) {
      if (e.type === 'run_start') {
        causedBy = e.caused_by ?? 'chat';
        userMessage = e.userMessage ?? null;
        startedAt = Date.parse(e.timestamp) || startedAt;
      } else if (e.type === 'turn_end' && e.tokenUsage) {
        tokensIn += e.tokenUsage.input;
        tokensOut += e.tokenUsage.output;
        tokensCached += e.tokenUsage.cached ?? 0;
      } else if (e.type === 'run_end') {
        status = e.reason ?? null;
      }
    }
    return { runId: run.runId, startedAt, causedBy, userMessage, status, tokensIn, tokensOut, tokensCached, eventCount: run.eventCount };
  });
}
