import type { McpServerSummary } from "@kinu.run/core";
import type { PluginStatus } from "./PluginRow";

/** An MCP server's state as every view of it words and colours it: in sentence case, as every status reads. */
export function mcpServerStatus(status: McpServerSummary["status"]): PluginStatus {
  switch (status) {
    case "ready":
    case "connected":
      return { label: "Connected", tone: "success" };
    case "authenticating":
      return { label: "Needs sign-in", tone: "warning" };
    case "connecting":
    case "discovering":
      return { label: "Connecting", tone: "warning" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "unknown":
      return { label: "Unknown", tone: "neutral" };
  }
}
