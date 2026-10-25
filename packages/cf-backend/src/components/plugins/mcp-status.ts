import type { McpServerSummary } from "@kinu.run/core";
import type { StatusTone } from "@/components/ui/Status";

/** What a connection's row says of it: the words and the tone they are drawn in. */
export interface PluginStatus {
  readonly label: string;
  readonly tone: StatusTone;
}

/** A connection a call can use: an MCP server serving, or the Google connection held. */
export const CONNECTED: PluginStatus = { label: "Connected", tone: "success" };

/** An MCP server's state as every view of it words and colours it: in sentence case, as every status reads. */
export function mcpServerStatus(status: McpServerSummary["status"]): PluginStatus {
  switch (status) {
    case "connected":
      return CONNECTED;
    case "needs_sign_in":
      return { label: "Needs sign-in", tone: "warning" };
    case "failed":
      return { label: "Failed", tone: "danger" };
  }
}

/** A row's `data-plugin-state` where it has no status: the account does not hold the connection. */
export const NOT_ADDED = "Not added";
