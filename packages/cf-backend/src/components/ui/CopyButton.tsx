/**
 * The icon-only copy action, with feedback. A bare
 * `onClick={() => navigator.clipboard.writeText(x)}` reports nothing —
 * including for the webhook secret, which is shown exactly once, where a
 * rejected write leaves the user with nothing and no way to know.
 */
import { CheckIcon, CopyIcon, WarningCircleIcon, type Icon } from "@phosphor-icons/react";
import { useCopy, type CopyStatus } from "@/hooks/use-copy";

export interface CopyButtonProps {
  value: string;
  /** What is being copied, for the tooltip: "webhook URL", "the secret". */
  what: string;
  size?: number;
  className?: string;
}

const FEEDBACK: Record<CopyStatus, { Icon: Icon; verb: string; tone: string }> = {
  idle: { Icon: CopyIcon, verb: "Copy", tone: "" },
  copied: { Icon: CheckIcon, verb: "Copied", tone: "p-success" },
  failed: { Icon: WarningCircleIcon, verb: "Couldn't copy", tone: "p-danger" },
};

export function CopyButton({ value, what, size = 12, className }: CopyButtonProps) {
  const { status, copy } = useCopy();
  const { Icon, verb, tone } = FEEDBACK[status];

  return (
    <button
      type="button"
      onClick={() => copy(value)}
      title={`${verb} ${what}`}
      aria-label={`Copy ${what}`}
      className={`${tone} ${className ?? ""}`}
    >
      <Icon size={size} />
    </button>
  );
}
