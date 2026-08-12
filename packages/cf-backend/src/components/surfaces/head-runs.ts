/**
 * Branches-view revalidation policy — the pure half of the Exploration surface's
 * head-run list.
 *
 * Nothing pushes the head journal to the client: it is written row by row as
 * the heads run, and `getHeadRuns` is the only way to see it. A view that
 * loads it once renders the first instant of a split and then lies for the
 * rest of it. This decides how fast there is something to watch.
 *
 * The policy used to stop polling entirely once the loaded runs had settled
 * and no chat turn was streaming — which assumed the loaded snapshot was the
 * world. It is not: splits also start from detached background jobs, drains
 * and autonomous turns, none of which stream through the chat socket, and the
 * tab sat on the previous attempt's branches while the new ones landed. An
 * open tab now always revalidates — fast while work is visibly live, at a
 * slow keep-fresh cadence otherwise.
 */
import type { HeadRunView } from "@proteus/core";

/** Matches the run timeline's mid-turn cadence: fast enough to read as live,
 *  slow enough that a long split is not a poll storm. */
export const BRANCHES_REVALIDATE_MS = 1500;

/** The idle cadence: one cheap RPC while the tab is actually open — the price
 *  of never again showing a settled snapshot as if it were the present. */
export const BRANCHES_IDLE_REVALIDATE_MS = 15_000;

/** A run is still being written until every head has left `running` — steps,
 *  token counts and the merge all land while it is. */
export function hasLiveHeadRun(runs: readonly HeadRunView[] | null): boolean {
  return !!runs?.some((run) => run.status === "running" || run.heads.some((head) => head.status === "running"));
}

/**
 * How long before the Branches view re-reads the journal.
 *
 * `hasActiveWork` is everything the workspace can see in flight — a streaming
 * chat turn or a running background job. Either counts even with nothing
 * loaded yet: a split can start at any step, and the run that appears is
 * exactly what the operator opened the tab for.
 */
export function branchesRevalidateMs(
  runs: readonly HeadRunView[] | null,
  hasActiveWork: boolean,
): number {
  return hasActiveWork || hasLiveHeadRun(runs) ? BRANCHES_REVALIDATE_MS : BRANCHES_IDLE_REVALIDATE_MS;
}
