/** The account's MCP servers and the presets they install from: one read every view of them on a page shares. */
import { listMcpPresets, listMcpServers, type McpPresetAvailability, type McpServerSummary } from "@/lib/user-api";
import { useAsyncResource, type AsyncResourceControl } from "@/hooks/use-async-resource";

export interface McpServers {
  readonly servers: AsyncResourceControl<McpServerSummary[]>;
  readonly presets: AsyncResourceControl<McpPresetAvailability[]>;
}

/** Read again while a server is still signing in or connecting, which can finish in another tab; settled, never. */
const revalidateServers = (rows: McpServerSummary[] | null): number | null =>
  rows?.some((s) => s.status === "authenticating" || s.status === "connecting" || s.status === "discovering") ? 5000 : null;

export function useMcpServers(): McpServers {
  return { servers: useAsyncResource(listMcpServers, revalidateServers), presets: useAsyncResource(listMcpPresets) };
}
