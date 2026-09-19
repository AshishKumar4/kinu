/**
 * The workspace status palette — the one place a `WorkspaceStatus` becomes
 * colour. Every surface that says a workspace's state draws it the same way:
 * a dot and a coloured word, never a palette of its own. `working` pulses
 * like every other running dot in the app.
 */
import type { WorkspaceStatus } from "@kinu.run/core";

export interface StatusTone {
  readonly dot: string;
  readonly text: string;
}

export function workspaceStatusTone(status: WorkspaceStatus): StatusTone {
  switch (status) {
    case "needs":
      return { dot: "p-dot-warning", text: "p-warning" };
    case "working":
      return { dot: "p-dot-success p-dot-pulse", text: "p-success" };
    case "failed":
    case "unfinished":
      return { dot: "p-dot-danger", text: "p-danger" };
    case "updated":
    case "idle":
      return { dot: "p-dot-neutral", text: "p-text-3" };
  }
}
