/** A box to tick and a set to choose one from (docs/DESIGN-SYSTEM.md §2): 16 square, on Kumo's primitives' keys and ARIA. */
import type { ReactNode } from "react";
import { CheckIcon, MinusIcon } from "@phosphor-icons/react";
import { Checkbox as Box } from "@cloudflare/kumo/primitives/checkbox";
import { Radio } from "@cloudflare/kumo/primitives/radio";
import { RadioGroup as Group } from "@cloudflare/kumo/primitives/radio-group";

/** `mixed` for a box standing for a set some of which are ticked. */
export function Checkbox({ checked, onChange, label, mixed = false, disabled = false }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  mixed?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-2 t-body">
      <Box.Root nativeButton render={<button type="button" />} checked={checked} indeterminate={mixed} disabled={disabled}
        onCheckedChange={(next) => onChange(next)} className="p-check">
        <Box.Indicator className="flex">{mixed ? <MinusIcon size={12} weight="bold" /> : <CheckIcon size={12} weight="bold" />}</Box.Indicator>
      </Box.Root>
      {label}
    </label>
  );
}

export function RadioGroup<Value extends string>({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: ReactNode }>;
  onChange: (value: Value) => void;
  disabled?: boolean;
}) {
  return (
    <Group aria-label={label} value={value} disabled={disabled} className="flex flex-col gap-2"
      onValueChange={(next) => {
        const picked = options.find((option) => option.value === next);

        if (picked) onChange(picked.value);
      }}>
      {options.map((option) => (
        <label key={option.value} className="inline-flex items-center gap-2 t-body">
          <Radio.Root nativeButton render={<button type="button" />} value={option.value} className="p-radio"><Radio.Indicator className="p-radio-dot" /></Radio.Root>
          {option.label}
        </label>
      ))}
    </Group>
  );
}
