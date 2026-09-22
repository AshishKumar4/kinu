/**
 * Run reads over `run_events`. The cross-run reads are cursored, newest-first in traversal and
 * presentation, so a truncated window is never summed as the workspace's spend.
 */

import { boundRunEventQuery } from '../events/recorder';
import type { RunEventQuery, RunEventRecorder, RunListEntry } from '../events/recorder';
import type { RunEvent } from '../events/types';
import { boundedInt } from '../utils/bounds';
import { addUsage, usageReported, type Usage } from '../usage';
import { mapPage, seekPage, StaleCursorError, type Page, type SeekCursor } from '../session/page';

export type { RunListEntry };

const DEFAULT_RUN_PAGE = 50;

/** Smaller than the list page: each summary row costs a full read of that run's events. */
const DEFAULT_SUMMARY_PAGE = 30;

/** Pages carry a cursor and report `next`, so this bounds a page without truncating history. */
const MAX_RUN_PAGE = 200;

/** A run with provenance (what kicked it off) and cost (tokens spent). */
export interface RunSummary extends Pick<RunListEntry, 'runId' | 'eventCount'> {
  startedAt: number;
  causedBy: string | null;
  userMessage: string | null;
  status: string | null;
  /** A field no turn reported stays absent rather than summing to zero. */
  usage: Usage;
  /** Separates a run served by a silent provider from a run that cost nothing. */
  turnsWithoutUsage: number;
}

/**
 * One run's events as an untrusted caller may ask for them (also the SSE resume replay). Bounds
 * close here because `getRunEvents` is reachable by direct RPC on both backends.
 */
export function getRunEvents(events: RunEventRecorder, runId: string, opts: RunEventQuery = {}): RunEvent[] {
  return events.read(runId, boundRunEventQuery(opts));
}

/** A page of recent runs, newest first. */
export function listRuns(
  events: RunEventRecorder,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_RUN_PAGE,
): Page<RunListEntry> {
  // A negative limit would reach SQL as `LIMIT 0`, an empty page that reads as exhausted history.
  const page = boundedInt(limit, DEFAULT_RUN_PAGE, 1, MAX_RUN_PAGE);

  return seekPage(events.listRunsBefore(anchorSeq(events, cursor), page + 1), page, (run) => run.runId);
}

/** {@link listRuns} folded with each run's `run_start` provenance and `turn_end` usage. */
export function getRunSummaries(
  events: RunEventRecorder,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_SUMMARY_PAGE,
): Page<RunSummary> {
  // Closed with the summary default: a NaN from RPC would otherwise get the wider list page.
  const page = boundedInt(limit, DEFAULT_SUMMARY_PAGE, 1, MAX_RUN_PAGE);

  return mapPage(listRuns(events, cursor, page), (runs) => runs.map((run) => summarize(events, run)));
}

function summarize(events: RunEventRecorder, run: RunListEntry): RunSummary {
  let usage: Usage = {};
  let turnsWithoutUsage = 0;
  let causedBy: string | null = null, userMessage: string | null = null, status: string | null = null;
  let startedAt = Date.parse(run.lastTs) || Date.now();
  // Direct log read, wider than the boundary ceiling, paged by `since` so the whole run folds.
  const window = 1000;
  let since = 0;

  for (;;) {
    const batch = events.read(run.runId, { since, limit: window });

    for (const e of batch) {
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

    if (batch.length < window) break;
    const last = batch[batch.length - 1];

    if (last === undefined) break;
    since = last.eventIndex + 1;
  }

  return { runId: run.runId, startedAt, causedBy, userMessage, status, usage, turnsWithoutUsage, eventCount: run.eventCount };
}

/** A vanished anchor throws rather than returning an empty page that reads as exhausted history. */
function anchorSeq(events: RunEventRecorder, cursor: SeekCursor | null): number | null {
  if (cursor === null) return null;
  const seq = events.runSeq(cursor.after);

  if (seq === null) throw new StaleCursorError('run history', cursor.after);

  return seq;
}
