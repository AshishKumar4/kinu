/** Controlled by the caller, which decides when "changed" is saved. */
import { DISPLAY_NAME_MAX } from "@kinu.run/core";
import { Field, inputCls } from "@/components/ui/form";

export function DisplayNameField({ value, onChange, saving, bare = false }: {
  value: string;
  onChange: (next: string) => void;
  saving?: boolean;
  /** Under a heading that already names it (onboarding's "Your name"), the field draws no label of its own. */
  bare?: boolean;
}) {
  const input = (
      <input
        aria-label="Your name"
        className={inputCls}
        maxLength={DISPLAY_NAME_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={saving === true}
        placeholder="What should Kinu call you?"
        autoComplete="name"
      />
  );

  return bare ? input : <Field label="Name">{input}</Field>;
}
