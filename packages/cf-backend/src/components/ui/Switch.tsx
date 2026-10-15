/** An on/off control; its label is the setting it turns, read aloud by assistive technology. */
export function Switch({ on, onChange, label, disabled = false, ...data }: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
  [attribute: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      {...data}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
        on ? "border-[var(--c-accent)] bg-[var(--c-accent)]" : "border-[var(--c-border-strong)] bg-[var(--c-fill)]"
      }`}
    >
      <span className={`size-3 rounded-full transition-transform ${on ? "translate-x-3 bg-[var(--c-accent-on)]" : "translate-x-0.5 bg-[var(--c-text-3)]"}`} />
    </button>
  );
}
