import { memo } from "react";
import { workspaceOverviewStatus, type WorkspaceOverview } from "@kinu.run/core";

/** The card's one attention line: what to say and which token to say it in. */
interface LabelText {
  readonly text: string;
  readonly tone: string;
}

/** What the overview says about the work, as the card's one attention line.
 *  The slot ordering is the shared {@link workspaceOverviewStatus}; text and
 *  tone are the card's own. Green is reserved for a run the log actually
 *  sealed 'completed' — an unknown or failed end is said in words. */
function labelText(overview: WorkspaceOverview): LabelText {
  const slot = workspaceOverviewStatus(overview);

  if (slot.kind === "attention") {
    return { text: `Needs you · ${overview.decisionsWaiting}`, tone: "p-warning" };
  }

  if (slot.kind === "working") return { text: "Working", tone: "p-accent" };

  if (slot.kind === "unfinished") return { text: "Work remains", tone: "p-warning" };

  if (slot.kind === "idle") return { text: "No active work", tone: "p-text-4" };

  if (slot.status === "completed") return { text: "Last run completed", tone: "p-success" };

  if (slot.status === "error") return { text: "Last run failed", tone: "p-danger" };

  if (slot.status === "aborted") return { text: "Last run aborted", tone: "p-text-3" };

  if (slot.status === null) return { text: "Last run unfinished", tone: "p-text-3" };

  return { text: `Last run ${slot.status}`, tone: "p-text-3" };
}

/** The attention line, rendered. A stale card speaks in the quiet token:
 *  keeping the last good text but dimming it is how the card shows an old
 *  answer without presenting it as fresh. */
export const OverviewLabel = memo(function OverviewLabel(
  { overview, stale }: { overview: WorkspaceOverview; stale: boolean },
) {
  const label = labelText(overview);

  return <span className={stale ? "p-text-4" : label.tone}>{label.text}</span>;
});
