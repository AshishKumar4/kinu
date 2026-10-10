/** The account's MCP servers and the presets they install from: one read every view of them on a page shares. */
import { listMcpPresets, listMcpServers, type McpPresetAvailability, type McpServerSummary } from "@/lib/user-api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAsyncResource, type AsyncResourceControl } from "@/hooks/use-async-resource";

export interface McpServers {
  readonly servers: AsyncResourceControl<McpServerSummary[]>;
  readonly presets: AsyncResourceControl<McpPresetAvailability[]>;
  /** Reads both again: after a change made here. */
  readonly refresh: () => void;
  /** Reads both every few seconds until the returned release: an open manager watches. */
  readonly watch: () => () => void;
}

/** How often a read is asked again while there is reason to. */
const CADENCE_MS = 5000;

/** A server still signing in or connecting, which can finish in another tab. */
const unsettled = (rows: McpServerSummary[] | null): boolean =>
  rows?.some((s) => s.status === "authenticating" || s.status === "connecting" || s.status === "discovering") === true;

/**
 * Each read's one cadence is chosen here, armed once per answer: every few seconds while a manager watches, so a
 * sign-in or a rotated app credential elsewhere shows; otherwise only while a server is unsettled, or while the
 * deployment's apps have never answered, so a card that needs the app's credential can still offer it.
 */
export function useMcpServers(): McpServers {
  const [watchers, setWatchers] = useState(0);
  const watched = watchers > 0;
  const serversCadence = useCallback((rows: McpServerSummary[] | null) => (watched || unsettled(rows) ? CADENCE_MS : null), [watched]);
  const presetsCadence = useCallback((rows: McpPresetAvailability[] | null) => (watched || rows === null ? CADENCE_MS : null), [watched]);
  const servers = useAsyncResource(listMcpServers, serversCadence);
  const presets = useAsyncResource(listMcpPresets, presetsCadence);
  const { reload: readServers } = servers;
  const { reload: readPresets } = presets;
  const refresh = useCallback(() => { readServers(); readPresets(); }, [readServers, readPresets]);

  const watch = useCallback(() => {
    setWatchers((count) => count + 1);

    return () => setWatchers((count) => count - 1);
  }, []);

  return useMemo(() => ({ servers, presets, refresh, watch }), [servers, presets, refresh, watch]);
}

/** Watches the servers and presets while the calling view is mounted. */
export function useMcpWatch(mcp: McpServers): void {
  const { watch } = mcp;

  useEffect(() => watch(), [watch]);
}
