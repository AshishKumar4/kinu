/**
 * A small named thing a row holds, with its one control (a device's grant to a workspace; design review 2026-10-20,
 * D4): 24 tall and round, on the neutral wash, or the danger wash in danger ink for a refusal.
 */
import type { ReactNode } from "react";
import { XIcon } from "@phosphor-icons/react";

export function Chip({ tone = "neutral", children, onRemove, removeLabel }: {
  tone?: "neutral" | "danger";
  children: ReactNode;
  /** The chip's own control, a 16 px ×; `removeLabel` names what it does. */
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const ground = tone === "danger" ? "bg-[var(--c-danger-tint)] p-danger" : "bg-[var(--c-hover)] p-text-2";

  return (
    <span className={`inline-flex h-6 max-w-full items-center gap-1 rounded-full text-xs font-medium leading-4 ${ground} ${onRemove === undefined ? "px-2.5" : "pl-2.5 pr-1"}`}>
      <span className="truncate">{children}</span>
      {onRemove !== undefined && (
        <button type="button" onClick={onRemove} aria-label={removeLabel} title={removeLabel}
          className="flex size-4 shrink-0 items-center justify-center rounded-full opacity-70 transition-colors hover:bg-[var(--c-hover)] hover:opacity-100">
          <XIcon size={10} weight="bold" />
        </button>
      )}
    </span>
  );
}
