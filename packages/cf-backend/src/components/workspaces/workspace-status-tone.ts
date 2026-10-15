import type { WorkspaceStatus } from "@kinu.run/core";
import type { StatusTone } from "@/components/ui/Status";

/** How a workspace stands, by core's one headline: the Workspaces card and the sidebar's dot read it alike. */
export function workspaceStatusTone(status: WorkspaceStatus): StatusTone {
  switch (status) {
    case "needs":
      return "warning";
    case "working":
      return "live";
    case "failed":
    case "unfinished":
      return "danger";
    case "updated":
    case "idle":
    case "unreported":
      return "neutral";
  }
}
