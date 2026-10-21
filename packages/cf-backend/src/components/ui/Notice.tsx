/**
 * A sentence the page needs said, inline where it applies (docs/DESIGN-SYSTEM.md §2): the tone's tint, a line in its
 * ink at 30%, the body in its ink, a 16 icon. Ours: Kumo's banner has no success tone and its own ground.
 */
import type { ReactNode } from "react";
import { CheckCircleIcon, InfoIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const ICON = { info: InfoIcon, success: CheckCircleIcon, warning: WarningIcon, danger: WarningCircleIcon } as const;

export function Notice({ tone, children, action, alert = tone === "danger", phrasing = false, className, ...data }: {
  tone: NoticeTone;
  children: ReactNode;
  action?: ReactNode;
  /** Read out at once: every danger notice, and a warning to hear before going on (possible secrets in a blueprint). */
  alert?: boolean;
  /** Inside running text, such as a slate in a chat answer: the same notice, built of spans. */
  phrasing?: boolean;
  /** Placement only (`mt-4`, `mx-6 mb-4`). */
  className?: string;
} & Readonly<Record<`data-${string}`, string>>) {
  const Icon = ICON[tone];
  const Box = phrasing ? "span" : "div";

  return (
    <Box role={alert ? "alert" : "status"} className={`p-notice p-notice-tone-${tone}${className === undefined ? "" : ` ${className}`}`} {...data}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <Box className="min-w-0 flex-1 t-body">{children}</Box>
      {action}
    </Box>
  );
}
