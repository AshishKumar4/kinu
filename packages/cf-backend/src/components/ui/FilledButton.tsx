/**
 * The filled action — the one button look Kumo cannot supply.
 *
 * Kumo's `primary` and `destructive` hardcode `!text-white` in its compiled
 * bundle, and white on this brand's light fills measures 2.4:1 (see the
 * "Buttons — one hierarchy" block in index.css). So the fill and its ink stay
 * in index.css while the box is Kumo's own `size="sm"` metrics, which is what
 * lets a filled button sit in a footer row beside Kumo ghost and secondary
 * siblings at the same height. This component is the only spelling: call sites
 * render it, never hand-rolled button classes.
 */
import type { ButtonHTMLAttributes } from "react";

const METRICS = "inline-flex h-6.5 shrink-0 items-center justify-center gap-1 px-2 text-xs cursor-pointer";

export function FilledButton({ danger = false, className, type = "button", ...rest }: {
  /** The destructive confirm — danger fill, same ink discipline. */
  danger?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`${danger ? "p-btn-danger" : "p-btn"} ${METRICS}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}
