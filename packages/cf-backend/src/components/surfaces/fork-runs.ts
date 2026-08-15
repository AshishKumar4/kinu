/**
 * Fork runs, as the Exploration surface reads them.
 *
 * Two jobs, both pure enough to test without a DOM:
 *
 *  1. **The adapters.** A fork is a tree whichever way it settled, so the two
 *     stores are folded into ONE node shape here and the renderer never learns
 *     which store a tree came from. A merge is that tree at depth 1 — the
 *     split's task at the root, one head per child; a competition is the same
 *     tree deeper, carrying scores and rollouts the merge simply does not have.
 *
 *  2. **The revalidation policy.** Nothing pushes either store to the client:
 *     both are written row by row as the fork runs, and a view that loads once
 *     renders the first instant of a split and then lies for the rest of it.
 *     An open tab always revalidates — fast while work is visibly live, at a
 *     slow keep-fresh cadence otherwise. Never zero: a split can start from a
 *     detached job, a drain or an autonomous turn, none of which stream
 *     through this tab's chat socket.
 */
import { useCallback } from "react";
import type { ForkRunSummary, HeadRunView } from "@proteus/core";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import type { BackgroundJob, ForkNode, Rpc } from "@/lib/protocol";

export const FORK_RUN_LIMIT = 30;

/** Matches the run timeline's mid-turn cadence: fast enough to read as live,
 *  slow enough that a long fork is not a poll storm. */
export const FORK_REVALIDATE_MS = 1500;

/** The idle cadence: one cheap RPC while the tab is actually open — the price
 *  of never again showing a settled snapshot as if it were the present. */
export const FORK_IDLE_REVALIDATE_MS = 15_000;

/** A fork is still being written until it leaves `running` — branches, scores,
 *  token counts and the merge all land while it is. */
export function hasLiveForkRun(runs: readonly ForkRunSummary[] | null): boolean {
  return !!runs?.some((run) => run.status === "running");
}

/** All workspace activity that can create or continue a fork. Detached jobs
 * do not stream through the chat connection, so they must count independently. */
export function hasActiveForkWork(
  isStreaming: boolean,
  backgroundJobs: readonly BackgroundJob[],
): boolean {
  return isStreaming || backgroundJobs.some((job) => job.status === "running");
}

/** An explicit permalink never falls through to a different run. */
export function selectForkRun(
  runs: readonly ForkRunSummary[] | null,
  requestedId: string | null,
): ForkRunSummary | null {
  if (runs === null) return null;
  if (requestedId !== null) return runs.find((run) => run.id === requestedId) ?? null;
  return runs[0] ?? null;
}

/**
 * How long before the fork list re-reads.
 *
 * `hasActiveWork` is everything the workspace can see in flight — a streaming
 * chat turn or a running background job. Either counts even with nothing
 * loaded yet: a fork can start at any step, and the run that appears is
 * exactly what the operator opened the tab for.
 */
export function forkRunsRevalidateMs(
  runs: readonly ForkRunSummary[] | null,
  hasActiveWork: boolean,
): number {
  return hasActiveWork || hasLiveForkRun(runs) ? FORK_REVALIDATE_MS : FORK_IDLE_REVALIDATE_MS;
}

/** The single live fork-list resource used by both Exploration renderings. */
export function useLiveForkRuns(
  rpc: Rpc,
  isStreaming: boolean,
  backgroundJobs: readonly BackgroundJob[],
) {
  const hasActiveWork = hasActiveForkWork(isStreaming, backgroundJobs);
  const load = useCallback(
    () => rpc<ForkRunSummary[]>("listForkRuns", [FORK_RUN_LIMIT]),
    [rpc],
  );
  const revalidate = useCallback(
    (runs: ForkRunSummary[] | null) => forkRunsRevalidateMs(runs, hasActiveWork),
    [hasActiveWork],
  );
  const { resource, reload } = useAsyncResource(load, revalidate);
  return { resource, reload, runs: lastValue(resource), hasActiveWork };
}

/** One permalink target, independent of the bounded recent-fork list. */
export function useExactForkRun(
  rpc: Rpc,
  requestedId: string | null,
  hasActiveWork: boolean,
) {
  const load = useCallback(
    () => requestedId === null
      ? Promise.resolve<ForkRunSummary | null>(null)
      : rpc<ForkRunSummary | null>("getForkRun", [requestedId]),
    [requestedId, rpc],
  );
  const revalidate = useCallback(
    (run: ForkRunSummary | null) => requestedId === null
      ? null
      : forkRunsRevalidateMs(run === null ? null : [run], hasActiveWork),
    [hasActiveWork, requestedId],
  );
  const { resource, reload } = useAsyncResource<ForkRunSummary | null>(
    load,
    revalidate,
    requestedId ?? undefined,
  );
  return { resource, reload, run: lastValue(resource) };
}

/**
 * A head's lifecycle in the tree's own vocabulary.
 *
 * Never `terminal`: that state means "the branch the fork settled on", and a
 * merge settles on all of them at once. Claiming a winner here would be the
 * one thing this unification must not do.
 */
function headStatus(status: string): ForkNode["status"] {
  if (status === "running") return "running";
  return status === "completed" ? "open" : "failed";
}

/**
 * One merged fork as a depth-1 tree.
 *
 * `value` and `visits` are null throughout, deliberately: a merge ranks
 * nothing and rolls nothing out, and the renderer drops every encoding that
 * would otherwise be drawn from a zero no head earned.
 */
export function headRunToTree(run: HeadRunView): ForkNode {
  return {
    id: run.rootId,
    parentId: null,
    depth: 0,
    value: null,
    visits: null,
    status: run.status === "running" ? "running" : "open",
    action: run.task || run.rationale || "(fork)",
    task: run.task,
    observation: run.merge?.narrative ?? run.rationale,
    children: run.heads.map((head) => ({
      id: head.id,
      parentId: run.rootId,
      depth: 1,
      value: null,
      visits: null,
      status: headStatus(head.status),
      action: head.task,
      task: head.task,
      observation: head.summary ?? head.errorMessage ?? "",
      children: [],
    })),
  };
}

/** The head behind a node of a merged fork's tree, or null for its root. */
export function findHead(run: HeadRunView, nodeId: string): HeadRunView["heads"][number] | null {
  return run.heads.find((head) => head.id === nodeId) ?? null;
}
