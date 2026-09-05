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
 *
 * The two cross-run reads are CURSORED. A bare `LIMIT 50` over a workspace's
 * runs answers "that is all there is" about a window it chose, and the Supervise
 * surface then sums the tokens of exactly those rows and prints the total as the
 * workspace's spend — a truncated denominator presented as a figure the owner
 * decides on. Both traverse and present newest-first, so a caller walking them
 * APPENDS each page.
 */

import { boundRunEventQuery } from '../events/recorder';
import type { RunEventQuery, RunEventRecorder, RunListEntry } from '../events/recorder';
import type { RunEvent } from '../events/types';
import { boundedInt } from '../utils/bounds';
import { addUsage, usageReported, type Usage } from '../usage';
import { mapPage, seekPage, StaleCursorError, type Page, type SeekCursor } from './page';

export type { RunListEntry };

/** A page of the run list. Fifty is what the bare `LIMIT` was, kept so the
 *  first page is the window every caller already sized its view for. */
const DEFAULT_RUN_PAGE = 50;

/** A page of run summaries. Smaller than the list's, because each row costs a
 *  full read of that run's events to fold its provenance and usage. */
const DEFAULT_SUMMARY_PAGE = 30;

/**
 * The ceiling on one run-list page — the bound the HTTP route already enforced
 * (`Math.min(200, ...)`), applied here so the RPC behind it, the MCP tool and
 * the CLI get it too.
 *
 * This is NOT a reinstatement of the cap `OrchestratorAgent.getRunSummaries`
 * records as "load-bearing in the wrong direction". That cap truncated an
 * UNCURSORED window, so Supervise summed the rows it happened to receive and
 * printed the total as the workspace's spend — a truncated denominator with no
 * way to reach the rest. These pages carry a cursor and report `next`, so a
 * bounded page is a page, not a truncation: the remaining history stays
 * reachable and the caller can tell a full page from the end of the log.
 */
const MAX_RUN_PAGE = 200;

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

/**
 * One run's durable events as an UNTRUSTED caller may ask for them — the read
 * every RPC and HTTP path into this log goes through, and what an SSE resume
 * replays from (`since` = last seen index).
 *
 * The bounds are closed HERE and not only at the route, because the route is not
 * the only way in: `getRunEvents` is reachable by direct RPC on both backends.
 * An in-object fold that needs a wider window calls `events.read` and states it.
 */
export function getRunEvents(events: RunEventRecorder, runId: string, opts: RunEventQuery = {}): RunEvent[] {
  return events.read(runId, boundRunEventQuery(opts));
}

/**
 * A page of recent runs, newest first.
 *
 * Newest-first in BOTH traversal and presentation, so a walker appends.
 */
export function listRuns(
  events: RunEventRecorder,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_RUN_PAGE,
): Page<RunListEntry> {
  // A negative limit is worse here than an unbounded read: `limit + 1` reaches
  // SQL as `LIMIT 0`, and an empty page is how this read-model says the history
  // behind the cursor is EXHAUSTED. A caller's typo would report a workspace as
  // having no runs.
  const page = boundedInt(limit, DEFAULT_RUN_PAGE, 1, MAX_RUN_PAGE);
  return seekPage(events.listRunsBefore(anchorSeq(events, cursor), page + 1), page, (run) => run.runId);
}

/**
 * A page of recent runs folded with the per-run `run_start` (what caused it) and
 * the `turn_end` usage accumulated field by field — the cross-run history +
 * budget view. Same window and same order as {@link listRuns}, one summary per
 * row of it.
 */
export function getRunSummaries(
  events: RunEventRecorder,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_SUMMARY_PAGE,
): Page<RunSummary> {
  // Closed HERE with the summary default, not left to `listRuns` to close with
  // the list's. A default parameter only fires on `undefined`, so an RPC caller
  // forwarding `Number('abc')` states NaN, and falling back downstream would
  // hand this read the wider list page — 50 rows, each costing a full read of
  // that run's events, where this surface is deliberately sized at 30.
  const page = boundedInt(limit, DEFAULT_SUMMARY_PAGE, 1, MAX_RUN_PAGE);
  return mapPage(listRuns(events, cursor, page), (runs) => runs.map((run) => summarize(events, run)));
}

function summarize(events: RunEventRecorder, run: RunListEntry): RunSummary {
  let usage: Usage = {};
  let turnsWithoutUsage = 0;
  let causedBy: string | null = null, userMessage: string | null = null, status: string | null = null;
  let startedAt = Date.parse(run.lastTs) || Date.now();
  // Straight to the log, not through the boundary read: this window is the one
  // the sums below are correct over, and it is wider than a stranger's ceiling.
  // Paged by `since` until a short page, so a run longer than one window still
  // folds whole instead of dropping its tail (and the `run_end` in it).
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

/** The cursor's anchor as a position in the log's write order. A run that is no
 *  longer there cannot be answered with an empty page: that would report the
 *  history behind it as exhausted. */
function anchorSeq(events: RunEventRecorder, cursor: SeekCursor | null): number | null {
  if (cursor === null) return null;
  const seq = events.runSeq(cursor.after);
  if (seq === null) throw new StaleCursorError('run history', cursor.after);
  return seq;
}
