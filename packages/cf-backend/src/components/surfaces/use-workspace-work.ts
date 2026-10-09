/** The workspace's plans and tasks, one read for the column: Work's lists and each plan's page draw from the same rows. */
import { useCallback, useEffect, useRef } from "react";
import type { PlanReview, Rpc, WorkspaceWork } from "@kinu.run/core";
import type { ReadMoves, WorkspacePlanArrival } from "@/hooks/use-kinu";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";

export interface WorkspaceWorkRead {
  readonly work: WorkspaceWork | null;
  readonly resource: AsyncResource<WorkspaceWork>;
  readonly reload: () => void;
}

export function useWorkspaceWork({ rpc, readMoves, plan, arrival }: {
  rpc: Rpc;
  readMoves: ReadMoves;
  /** The pushed plan: the read has no push of its own, so each `plan_updated` frame reads it again. */
  plan: PlanReview | null;
  arrival: WorkspacePlanArrival | null | undefined;
}): WorkspaceWorkRead {
  const load = useCallback(() => rpc<WorkspaceWork>("listWorkspaceWork", []), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  const moves = readMoves.listWorkspaceWork ?? 0;
  const moved = useRef(moves);

  useEffect(() => {
    if (moved.current === moves) return;
    moved.current = moves;
    reload();
  }, [moves, reload]);

  // `plan` is a fresh object per push; a decision reuses the revision, so a key would miss it.
  useEffect(() => {
    if (plan !== null || arrival) reload();
  }, [plan, arrival, reload]);

  return { work: lastValue(resource), resource, reload };
}
