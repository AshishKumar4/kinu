import { memo } from "react";
import { workspaceOverviewEvidence, workspaceOverviewStatus, type WorkspaceOverview, type WorkspaceOverviewFact } from "@kinu.run/core";

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

/** Core's tone words resolved to this surface's tokens. A fact never decides
 *  its own class: `workspaceOverviewEvidence` says WHAT is true, the card
 *  says how loud each truth is drawn. */
const FACT_TONE = {
  warning: "p-warning",
  accent: "p-accent",
  muted: "p-text-3",
  quiet: "p-text-4",
  success: "p-success",
} satisfies Record<WorkspaceOverviewFact["tone"], string>;

/** The evidence row beneath the lead line: every fact the overview carries,
 *  in core's fixed order, as small chips. The task is the row's second line,
 *  not a chip — it is the widest thing here and wrapping beside it would
 *  read as noise. "No runs yet" appears plainly only when there is no fact
 *  to show at all: no pill shape for a non-fact, and never a word a sealed
 *  run did not earn. */
export const OverviewEvidence = memo(function OverviewEvidence(
  { overview, stale }: { overview: WorkspaceOverview; stale: boolean },
) {
  const toneOf = (fact: WorkspaceOverviewFact): string => stale ? "p-text-4" : FACT_TONE[fact.tone];

  return (
    <span className="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" data-overview-evidence>
      {workspaceOverviewEvidence(overview).map((fact) => (
        <span key={fact.key} data-evidence={fact.key} className={`${toneOf(fact)} ${
          fact.key === "task" ? "w-full min-w-0 truncate p-meta"
            : fact.key === "empty" ? "p-meta"
            : "rounded-full p-fill px-2 py-0.5 p-t-status"
        }`}>{fact.text}</span>
      ))}
    </span>
  );
});
