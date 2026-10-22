/**
 * An on/off control, always beside a visible label (docs/DESIGN-SYSTEM.md §2): a 32 by 18 track with a 14 thumb, brass
 * when on. `label` is the setting it turns, read aloud by assistive technology.
 */
import { Switch as Primitive } from "@cloudflare/kumo/primitives/switch";

export function Switch({ on, onChange, label, disabled = false, ...data }: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
  [attribute: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    // A real button, as every control here is: pressed by Enter and Space and found by its role and name.
    <Primitive.Root nativeButton render={<button type="button" />} checked={on} onCheckedChange={(next) => onChange(next)} aria-label={label}
      disabled={disabled} className="p-switch" {...data}>
      <Primitive.Thumb className="p-switch-thumb" />
    </Primitive.Root>
  );
}
