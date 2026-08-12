/**
 * Branches-view revalidation policy — the pure half of the Exploration surface's
 * head-run list.
 *
 * Nothing pushes the head journal to the client: it is written row by row as
 * the heads run, and `getHeadRuns` is the only way to see it. A view that
 * loads it once renders the first instant of a split and then lies for the
 * rest of it. This decides when there is still something to watch — and, just
 * as importantly, when there is not.
 */
import type { HeadRunView } from "@proteus/core";

/** Matches the run timeline's mid-turn cadence: fast enough to read as live,
 *  slow enough that a long split is not a poll storm. */
export const BRANCHES_REVALIDATE_MS = 1500;

/** A run is still being written until every head has left `running` — steps,
 *  token counts and the merge all land while it is. */
export function hasLiveHeadRun(runs: readonly HeadRunView[] | null): boolean {
  return !!runs?.some((run) => run.status === "running" || run.heads.some((head) => head.status === "running"));
}

/**
 * How long before the Branches view re-reads the journal, or null to stop.
 *
 * A turn in flight counts even with nothing loaded yet — a split can start at
 * any step, and the run that appears is exactly what the operator opened the
 * tab for. An idle workspace with settled runs polls nothing.
 */
export function branchesRevalidateMs(
  runs: readonly HeadRunView[] | null,
  isStreaming: boolean,
): number | null {
  return isStreaming || hasLiveHeadRun(runs) ? BRANCHES_REVALIDATE_MS : null;
}
