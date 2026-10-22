import { Tooltip } from "@/components/ui/Tooltip";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { AgentActivity } from "@kinu.run/core";

/** Read by shape as well as hue; at rest, done or stopped, nothing. */
const SIGNAL: Partial<Record<AgentActivity, { readonly kind: "working" | "waiting" | "failed"; readonly label: string }>> = {
  working: { kind: "working", label: "Working" },
  waiting: { kind: "waiting", label: "Needs you" },
  failed: { kind: "failed", label: "Last turn failed" },
};

export function AgentStatusMark({ activity }: { activity: AgentActivity }) {
  const signal = SIGNAL[activity];

  if (signal === undefined) return null;

  return (
    <Tooltip content={signal.label} side="bottom">
      <span className="p-agent-status" data-status={signal.kind} role="img" aria-label={signal.label}>
        {signal.kind === "failed" && <WarningCircleIcon size={13} weight="fill" aria-hidden />}
      </span>
    </Tooltip>
  );
}
