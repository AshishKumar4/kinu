/** Reports clipboard failures; the webhook secret is shown only once. */
import { CheckIcon, CopyIcon, WarningCircleIcon, type Icon } from "@phosphor-icons/react";
import { copyLabel, useCopy, type CopyStatus } from "@/hooks/use-copy";
import { Button } from "@/components/ui/Button";

interface CopyButtonProps {
  value: string;
  what: string;
  /** `secondary` beside a field or link it copies; the quiet ghost elsewhere. */
  variant?: "ghost" | "secondary";
  /** Placement only. */
  className?: string;
}

const FEEDBACK: Record<CopyStatus, { Icon: Icon; verb: string; tone: string }> = {
  idle: { Icon: CopyIcon, verb: "Copy", tone: "" },
  copied: { Icon: CheckIcon, verb: "Copied", tone: "p-success" },
  failed: { Icon: WarningCircleIcon, verb: "Could not copy", tone: "p-danger" },
};

/** ui/Button's icon form that copies `value`, saying so in its icon and tooltip. */
export function CopyButton({ value, what, variant = "ghost", className }: CopyButtonProps) {
  const { status, copy } = useCopy();
  const { Icon, verb, tone } = FEEDBACK[status];

  return (
    <Button variant={variant} size="sm" icon={<Icon size={14} />} onClick={() => copy(value)} title={`${verb} ${what}`} aria-label={`Copy ${what}`}
      className={`${tone}${className === undefined ? "" : ` ${className}`}`} />
  );
}

/** A copy that says so in words beside its icon: the approved code block's head. */
export function CopyText({ value, className }: { value: string; className?: string }) {
  const { status, copy } = useCopy();

  return (
    <button onClick={() => copy(value)} type="button"
      className={`flex shrink-0 cursor-pointer items-center gap-1 transition-colors ${status === "failed" ? "p-danger" : "hover:p-text"}${className === undefined ? "" : ` ${className}`}`}>
      <CopyIcon size={14} />{copyLabel(status)}
    </button>
  );
}
