/** The account's MCP servers and the presets they install from: one read every view of them on a page shares. */
import { listMcpPresets, listMcpServers, type McpPresetAvailability, type McpServerSummary } from "@/lib/user-api";
import { useCallback, useEffect, useMemo } from "react";
import { useAsyncResource, type AsyncResourceControl } from "@/hooks/use-async-resource";

export interface McpServers {
  readonly servers: AsyncResourceControl<McpServerSummary[]>;
  readonly presets: AsyncResourceControl<McpPresetAvailability[]>;
  /** Reads both again: after a change, or on the manager's watch. */
  readonly refresh: () => void;
}

/** Read again while a server is still signing in or connecting, which can finish in another tab; settled, never. */
const revalidateServers = (rows: McpServerSummary[] | null): number | null =>
  rows?.some((s) => s.status === "authenticating" || s.status === "connecting" || s.status === "discovering") ? 5000 : null;

/** A presets read that has never answered is asked again, so a card that needs the app's credential can still offer it. */
const retryPresets = (rows: McpPresetAvailability[] | null): number | null => (rows === null ? 5000 : null);

export function useMcpServers(): McpServers {
  const servers = useAsyncResource(listMcpServers, revalidateServers);
  const presets = useAsyncResource(listMcpPresets, retryPresets);
  const { reload: readServers } = servers;
  const { reload: readPresets } = presets;
  const refresh = useCallback(() => { readServers(); readPresets(); }, [readServers, readPresets]);

  return useMemo(() => ({ servers, presets, refresh }), [servers, presets, refresh]);
}

/** While a manager is open, both are read every few seconds, so a sign-in or a rotated app credential elsewhere shows. */
export function useMcpWatch(mcp: McpServers): void {
  const { refresh } = mcp;

  useEffect(() => {
    const timer = setInterval(refresh, 5000);

    return () => clearInterval(timer);
  }, [refresh]);
}
