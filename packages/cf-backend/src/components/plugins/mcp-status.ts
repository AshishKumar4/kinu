import type { McpServerSummary } from "@/lib/user-api";
import type { PluginStatus } from "./PluginRow";

/** An MCP server's state as every view of it words and colours it. */
export function mcpServerStatus(status: McpServerSummary["status"]): PluginStatus {
  switch (status) {
    case "ready":
    case "connected":
      return { label: "connected", tone: "success" };
    case "authenticating":
      return { label: "auth needed", tone: "warning" };
    case "connecting":
    case "discovering":
      return { label: status, tone: "warning" };
    case "failed":
      return { label: "failed", tone: "danger" };
    case "unknown":
      return { label: status, tone: "neutral" };
  }
}
