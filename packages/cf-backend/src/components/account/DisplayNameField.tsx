/**
 * The one field that renames the owner, shared by the wizard's first step and
 * the Account settings Profile card. The input is controlled by its caller so
 * the caller decides when "changed" — the wizard saves on Next, the card on
 * its own Save.
 */
import { DISPLAY_NAME_MAX } from "@kinu.run/core";
import { Field, inputCls } from "@/components/ui/form";

export function DisplayNameField({ value, onChange, saving }: {
  value: string;
  onChange: (next: string) => void;
  saving?: boolean;
}) {
  return (
    <Field label="Name">
      <input
        aria-label="Your name"
        className={inputCls}
        maxLength={DISPLAY_NAME_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={saving === true}
        placeholder="Your name"
        autoComplete="name"
      />
    </Field>
  );
}
