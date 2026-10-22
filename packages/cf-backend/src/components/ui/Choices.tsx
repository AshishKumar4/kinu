/**
 * One of a few options, each with what it means, all shown at once (docs/DESIGN-SYSTEM.md §2): rows in a group with a
 * radio at the right, or tiles over a picture. Kumo's radio primitives carry the keys and ARIA; `marker` names a data
 * attribute each option carries its id in.
 */
import type { ReactNode } from "react";
import { Radio } from "@cloudflare/kumo/primitives/radio";
import { RadioGroup } from "@cloudflare/kumo/primitives/radio-group";

export interface Choice<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly detail?: ReactNode;
  /** Rows: a 16 icon before the label. */
  readonly icon?: ReactNode;
  /** Tiles: what the option looks like, above its label. */
  readonly picture?: ReactNode;
  /** Beside the label, at its right: a word on the option's state ("In use"). */
  readonly aside?: ReactNode;
  readonly disabled?: boolean;
}

export function Choices<T extends string>({ label, marker, options, value, onChange, disabled = false, tiles = false }: {
  label: string;
  marker: `data-${string}`;
  options: readonly Choice<T>[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
  tiles?: boolean;
}) {
  return (
    <RadioGroup aria-label={label} value={value} disabled={disabled} className={tiles ? "grid gap-3 sm:grid-cols-2" : "p-group"}
      onValueChange={(next) => {
        const picked = options.find((option) => option.id === next);

        if (picked !== undefined) onChange(picked.id);
      }}>
      {options.map((option) => (
        <Radio.Root key={option.id} nativeButton render={<button type="button" />} value={option.id} disabled={option.disabled === true}
          className={tiles ? "p-choice p-choice-tile" : "p-choice p-choice-row"} {...{ [marker]: option.id }}>
          {tiles ? <Tile option={option} /> : <Row option={option} />}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

function Row<T extends string>({ option }: { option: Choice<T> }) {
  return (
    <>
      {option.icon !== undefined && <span className="p-choice-icon mt-0.5 flex shrink-0">{option.icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="t-item block">{option.label}</span>
        {option.detail !== undefined && <span className="t-meta block">{option.detail}</span>}
      </span>
      {option.aside}
      <span className="p-radio mt-0.5 shrink-0"><Radio.Indicator className="p-radio-dot" /></span>
    </>
  );
}

function Tile<T extends string>({ option }: { option: Choice<T> }) {
  return (
    <>
      {option.picture}
      <span className={`${option.picture === undefined ? "" : "mt-2 "}flex items-baseline justify-between gap-2 px-1`}>
        <span className="t-item">{option.label}</span>
        {option.aside}
      </span>
      {option.detail !== undefined && <span className="t-meta mt-px block px-1 pb-1">{option.detail}</span>}
    </>
  );
}
