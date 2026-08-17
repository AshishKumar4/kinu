/**
 * Run reads over the durable event log.
 *
 * `run_events` is written by every backend and is the only history of what a
 * turn did, so the three shapes a surface asks for — one run's events, the
 * list of runs, and the provenance/cost fold across runs — are the same three
 * everywhere. None of them touches storage the log does not already own.
 *
 * `run_events` is a table `initWorkspaceSchema` creates, so an unreadable log
 * is a broken workspace, not an empty history: the error reaches the surface
 * instead of a history panel that shows the same nothing an idle agent shows.
 */

import type { RunEventQuery, RunEventRecorder } from '../events/recorder.js';
import type { RunEvent } from '../events/types.js';
import { addUsage, usageReported, type Usage } from '../usage.js';

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
  /** Summed over the turns whose provider reported something. A field no turn
   *  reported stays ABSENT here rather than summing to zero. */
  usage: Usage;
  /** Turns that ended with the provider reporting no usage at all. Without this
   *  denominator a run served by a silent provider is indistinguishable from a
   *  run that cost nothing, which is the one thing a budget view must not
   *  confuse. */
  turnsWithoutUsage: number;
}

/** One run's durable events — what an SSE resume replays from (`since` = last
 *  seen index). */
export function getRunEvents(events: RunEventRecorder, runId: string, opts: RunEventQuery = {}): RunEvent[] {
  return events.read(runId, opts);
}

/** Recent runs with their latest timestamp + event count, newest first. */
export function listRuns(events: RunEventRecorder, limit = 50): RunListEntry[] {
  return events.listRuns(limit);
}

/**
 * Recent runs folded with the per-run `run_start` (what caused it) and the
 * `turn_end` usage accumulated field by field — the cross-run history + budget
 * view.
 */
export function getRunSummaries(events: RunEventRecorder, limit = 30): RunSummary[] {
  return listRuns(events, limit).map((run) => {
    let usage: Usage = {};
    let turnsWithoutUsage = 0;
    let causedBy: string | null = null, userMessage: string | null = null, status: string | null = null;
    let startedAt = Date.parse(run.lastTs) || Date.now();
    for (const e of getRunEvents(events, run.runId, { limit: 1000 })) {
      if (e.type === 'run_start') {
        causedBy = e.caused_by ?? 'chat';
        userMessage = e.userMessage ?? null;
        startedAt = Date.parse(e.timestamp) || startedAt;
      } else if (e.type === 'turn_end') {
        const turn = e.usage ?? {};
        if (usageReported(turn)) usage = addUsage(usage, turn);
        else turnsWithoutUsage++;
      } else if (e.type === 'run_end') {
        status = e.reason ?? null;
      }
    }
    return { runId: run.runId, startedAt, causedBy, userMessage, status, usage, turnsWithoutUsage, eventCount: run.eventCount };
  });
}
