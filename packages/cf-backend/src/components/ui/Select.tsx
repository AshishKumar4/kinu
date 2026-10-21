/** A choice of one from a list, in Kumo's themed popup, never the OS's; md 32 or sm 28 like every field. */
import { Select as KumoSelect } from "@cloudflare/kumo";
import type { FieldSize } from "@/components/ui/Field";

export function Select<Value extends string>({ label, value, options, onChange, disabled, size = "md", quiet = false, shown, className }: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
  disabled?: boolean;
  /** `xs` sits in a line of text, as the composer's thinking level does. */
  size?: FieldSize | "xs";
  /** No edge or ground of its own: a choice in a row of others, washed under the pointer. */
  quiet?: boolean;
  /** The trigger's own words for the chosen value, where its option's label is too long to sit in a row. */
  shown?: (value: Value) => string;
  className?: string;
}) {
  return (
    <KumoSelect
      aria-label={label}
      size={size === "md" ? "base" : size}
      className={`p-select${size === "xs" ? "" : ` p-field-${size}`}${quiet ? " p-select-quiet" : ""}${className === undefined ? "" : ` ${className}`}`}
      value={value}
      disabled={disabled}
      items={options}
      renderValue={(chosen) => {
        const picked = options.find((option) => option.value === chosen);

        return picked === undefined ? chosen : shown?.(picked.value) ?? picked.label;
      }}
      onValueChange={(next) => {
        const picked = options.find((option) => option.value === next);

        if (picked) onChange(picked.value);
      }}
    />
  );
}

/** One value searched for and chosen (docs/DESIGN-SYSTEM.md §2, Select / Combobox): Kumo's, themed through the
 *  `--color-kumo-*` bridge, its menu the system's. This is the one place it is imported. */
export { Combobox } from "@cloudflare/kumo";
