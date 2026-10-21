/**
 * A sentence the page needs said, inline where it applies (docs/DESIGN-SYSTEM.md §2): the tone's tint, a line in its
 * ink at 30%, the body in its ink, a 16 icon. Ours: Kumo's banner has no success tone and its own ground.
 */
import type { ReactNode } from "react";
import { CheckCircleIcon, InfoIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const ICON = { info: InfoIcon, success: CheckCircleIcon, warning: WarningIcon, danger: WarningCircleIcon } as const;

export function Notice({ tone, children, action }: { tone: NoticeTone; children: ReactNode; action?: ReactNode }) {
  const Icon = ICON[tone];

  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`p-notice p-notice-tone-${tone}`}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 t-body">{children}</div>
      {action}
    </div>
  );
}
