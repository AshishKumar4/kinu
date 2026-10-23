/**
 * The focus bar's line for a workspace's main agent (docs/HOME-EXPLORE.md §2; core `focus-line.ts`): the step its live
 * turn is on, else what it watches and the next one due. The watches are read in the focus layout alone, and again as
 * each turn ends, since a turn may arm or end one.
 */
import { useCallback, useEffect, useRef } from "react";
import { liveStep, watchingLine, type LiveTail, type Watch } from "@kinu.run/core";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

const NONE: readonly Watch[] = [];

export function useFocusLine(rpc: WorkspaceRpc, focus: boolean, tail: LiveTail | null): string | null {
  const load = useCallback(async (): Promise<readonly Watch[]> => (focus ? (await rpc("listTriggers", [])).triggers : NONE), [rpc, focus]);
  const { resource, reload } = useAsyncResource(load);
  const live = tail !== null;
  const wasLive = useRef(live);

  useEffect(() => {
    if (wasLive.current && !live) reload();
    wasLive.current = live;
  }, [live, reload]);

  return liveStep(tail) ?? watchingLine(lastValue(resource) ?? NONE, Date.now());
}
