/** Kumo's `primary`/`destructive` hardcode `!text-white` (2.4:1 on light fills), so fill and ink live in index.css; the box uses Kumo's `size="sm"`. */
import type { ButtonHTMLAttributes } from "react";

const METRICS = "inline-flex h-6.5 shrink-0 items-center justify-center gap-1 px-2 text-xs cursor-pointer";

export function FilledButton({ danger = false, className, type = "button", ...rest }: {
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
