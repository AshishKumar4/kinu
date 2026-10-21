/** Buttons are not here: every button is `ui/Button`. */
import { Select } from '@/components/ui/Select';

export { Card } from '@/components/ui/Card';

export { Field } from '@/components/ui/Field';

export const inputCls = "t-body w-full rounded-[var(--r-control)] px-3 py-2 p-text transition-all"
  + " border border-[var(--c-field-border)] bg-[var(--c-surface)]"
  + " placeholder:p-text-3";

/** An IME's own keystroke: the Enter that picks a candidate, the Escape that drops one. WebKit ends the composition
 *  first, so there only keyCode 229 marks it. */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Select under its older name and sizes (`base` is md), until every caller says `Select`. */
export function Choice<Value extends string>({ size = "base", ...rest }: Omit<Parameters<typeof Select<Value>>[0], "size"> & { size?: "sm" | "base" }) {
  return <Select {...rest} size={size === "sm" ? "sm" : "md"} />;
}
