/** The account's MCP servers and the presets they install from: one read every view of them on a page shares. */
import { GOOGLE_CONNECTION, type McpPresetAvailability, type McpServerSummary } from "@kinu.run/core";
import { googleConnection, listMcpPresets, listMcpServers } from "@/lib/user-api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { lastValue, useAsyncResource, type AsyncResourceControl } from "@/hooks/use-async-resource";

/** The Google connection as Settings reads it: whether this account may connect it, and the one it holds. */
export type GoogleConnectionRead = Awaited<ReturnType<typeof googleConnection>>;

export interface McpServers {
  readonly servers: AsyncResourceControl<McpServerSummary[]>;
  readonly presets: AsyncResourceControl<McpPresetAvailability[]>;
  /** The Google connection, one read for every row of it on the page: a change in one shows in each. */
  readonly google: AsyncResourceControl<GoogleConnectionRead>;
  /** Reads them all again: after a change made here. */
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
  const google = useAsyncResource(googleConnection);
  const { reload: readServers } = servers;
  const { reload: readPresets } = presets;
  const { reload: readGoogle } = google;
  const refresh = useCallback(() => { readServers(); readPresets(); readGoogle(); }, [readServers, readPresets, readGoogle]);

  const watch = useCallback(() => {
    setWatchers((count) => count + 1);

    return () => setWatchers((count) => count - 1);
  }, []);

  return useMemo(() => ({ servers, presets, google, refresh, watch }), [servers, presets, google, refresh, watch]);
}

/** Watches the servers and presets while the calling view is mounted. */
export function useMcpWatch(mcp: McpServers): void {
  const { watch } = mcp;

  useEffect(() => watch(), [watch]);
}

/** Whether the account holds a connection: a server from a preset, signed in and serving, or the Google connection; null
 *  where the read that would say has not answered, which is not the same as absent. A blueprint's need reads it. */
export function useConnectedPreset(): (connection: string) => boolean | null {
  const mcp = useMcpServers();
  const servers = lastValue(mcp.servers.resource);
  const google = lastValue(mcp.google.resource);

  return (connection) => {
    if (connection === GOOGLE_CONNECTION) return google === null ? null : google.connection !== null;

    return servers === null ? null : servers.some((server) => server.presetId === connection && (server.status === "ready" || server.status === "connected"));
  };
}
