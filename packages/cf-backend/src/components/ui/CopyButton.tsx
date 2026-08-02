/**
 * The icon-only copy action. Every one of these used to be a bare
 * `onClick={() => navigator.clipboard.writeText(x)}` with no feedback at all —
 * including the webhook secret, which is shown exactly once, where a rejected
 * write leaves the user with nothing and no way to know.
 */
import { CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCopy } from "@/hooks/use-copy";

export interface CopyButtonProps {
  value: string;
  /** What is being copied, for the tooltip: "webhook URL", "the secret". */
  what: string;
  size?: number;
  className?: string;
}

export function CopyButton({ value, what, size = 12, className }: CopyButtonProps) {
  const { status, copy } = useCopy();
  const Icon = status === "copied" ? CheckIcon : status === "failed" ? WarningCircleIcon : CopyIcon;
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      title={status === "copied" ? `Copied ${what}` : status === "failed" ? `Couldn't copy ${what}` : `Copy ${what}`}
      aria-label={`Copy ${what}`}
      className={`${status === "copied" ? "p-success" : status === "failed" ? "p-danger" : ""} ${className ?? ""}`}
    >
      <Icon size={size} />
    </button>
  );
}
