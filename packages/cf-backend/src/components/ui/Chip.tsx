/**
 * A small named thing a row holds, with its one control (docs/DESIGN-SYSTEM.md §2; a device's grant to a workspace):
 * 24 tall and round, on the hover wash, or a tone's tint in its ink.
 */
import type { ComponentProps, ReactNode } from "react";
import { XIcon } from "@phosphor-icons/react";

export type ChipTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

const GROUND: Record<ChipTone, string> = {
  neutral: "p-chip-neutral",
  success: "p-chip-success",
  warning: "p-chip-warning",
  danger: "p-chip-danger",
  info: "p-chip-info",
  accent: "p-chip-accent",
};

export function Chip({ tone = "neutral", icon, children, onRemove, removeLabel, ...data }: {
  tone?: ChipTone;
  /** A 14 icon before the words. */
  icon?: ReactNode;
  children: ReactNode;
  /** The chip's own control, a 16 ghost ×; `removeLabel` names what it does. */
  onRemove?: () => void;
  removeLabel?: string;
} & Readonly<Record<`data-${string}`, string>>) {
  return (
    <span className={`p-chip ${GROUND[tone]}${onRemove === undefined ? "" : " p-chip-removable"}`} {...data}>
      {icon}
      <span className="truncate">{children}</span>
      {onRemove !== undefined && (
        <button type="button" onClick={onRemove} aria-label={removeLabel} title={removeLabel} className="p-chip-remove">
          <XIcon size={10} weight="bold" />
        </button>
      )}
    </span>
  );
}

/** A chip that is a choice, pressed while chosen: a machine to work on. A dashed one offers to add another. `sm` is 28
 *  tall in the status role, a filter among filters (Explore's categories). */
export function ChipToggle({ size = "md", className, type = "button", ...rest }: ComponentProps<"button"> & { size?: "md" | "sm" }) {
  return <button type={type} className={`p-chip-toggle${size === "sm" ? " p-chip-toggle-sm t-status" : ""}${className === undefined ? "" : ` ${className}`}`} {...rest} />;
}
