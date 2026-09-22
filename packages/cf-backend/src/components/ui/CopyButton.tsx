/** Reports clipboard failures; the webhook secret is shown only once. */
import { CheckIcon, CopyIcon, WarningCircleIcon, type Icon } from "@phosphor-icons/react";
import { useCopy, type CopyStatus } from "@/hooks/use-copy";

export interface CopyButtonProps {
  value: string;
  what: string;
  size?: number;
  className?: string;
}

const FEEDBACK: Record<CopyStatus, { Icon: Icon; verb: string; tone: string }> = {
  idle: { Icon: CopyIcon, verb: "Copy", tone: "" },
  copied: { Icon: CheckIcon, verb: "Copied", tone: "p-success" },
  failed: { Icon: WarningCircleIcon, verb: "Could not copy", tone: "p-danger" },
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
