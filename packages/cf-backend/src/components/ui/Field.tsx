/**
 * A labelled control and the text controls (docs/DESIGN-SYSTEM.md §2): the label as an item, a one-line hint, and an
 * error in its place when the value is refused. Fields are md 32 or sm 28, on the field ground with its 3:1 edge.
 */
import type { ComponentProps, ReactNode } from "react";
import { Input } from "@cloudflare/kumo/primitives/input";

export type FieldSize = "md" | "sm";

/** `inline` puts a small control on the label's row at desktop width. */
export function Field({ label, hint, error = null, inline = false, children }: {
  label: ReactNode;
  hint?: ReactNode;
  /** Why the value was refused, in the hint's place. */
  error?: string | null;
  inline?: boolean;
  children?: ReactNode;
}) {
  const text = (
    <div className="min-w-0">
      <div className="t-item">{label}</div>
      {error === null ? hint !== undefined && hint !== null && <p className="mt-1 t-meta">{hint}</p> : <p role="alert" className="mt-1 t-meta p-danger">{error}</p>}
    </div>
  );

  if (inline) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        {text}
        {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {text}
      {children}
    </div>
  );
}

/** A one-line text field; `invalid` draws its edge in danger. */
export function TextInput({ size = "md", invalid = false, className, ...rest }: Omit<ComponentProps<"input">, "size"> & {
  size?: FieldSize;
  invalid?: boolean;
}) {
  return <Input className={`p-field p-field-${size}${className === undefined ? "" : ` ${className}`}`} aria-invalid={invalid || undefined} {...rest} />;
}

/** Text over several lines, at least 80 high; `mono` for text that is code (SOUL.md). */
export function TextArea({ mono = false, invalid = false, className, ...rest }: ComponentProps<"textarea"> & {
  mono?: boolean;
  invalid?: boolean;
}) {
  return <textarea className={`p-field p-field-area${mono ? " t-mono" : ""}${className === undefined ? "" : ` ${className}`}`} aria-invalid={invalid || undefined} {...rest} />;
}
