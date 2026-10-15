/** The workspace's mounts, read again whenever a machine's availability flips: each row's live flag follows it. */
import { useCallback, useEffect, useRef } from "react";
import type { ExecutorInfo } from "@kinu.run/core";
import { useAsyncResource } from "@/hooks/use-async-resource";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

export function useMounts(rpc: WorkspaceRpc, executors: readonly ExecutorInfo[]) {
  const load = useCallback(() => rpc("listMounts", []), [rpc]);
  const read = useAsyncResource(load);
  const { reload } = read;
  const availability = executors.map((executor) => `${executor.name}:${String(executor.available)}:${executor.status ?? ""}`).join("|");
  const seen = useRef(availability);

  useEffect(() => {
    if (seen.current === availability) return;
    seen.current = availability;
    reload();
  }, [availability, reload]);

  return read;
}
