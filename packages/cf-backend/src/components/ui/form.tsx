/** Buttons are not here: every button is `ui/Button`. */
import type * as React from 'react';
import { Select } from '@cloudflare/kumo';

export const inputCls = "w-full rounded-md px-3 py-2 text-sm p-text focus:outline-none transition-all"
  + " border border-[var(--c-input-border)] bg-[var(--c-surface)]"
  + " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
  + " placeholder:p-text-3";

/** An IME's own keystroke: the Enter that picks a candidate, the Escape that drops one. WebKit ends the composition
 *  first, so there only keyCode 229 marks it. */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

export const tabCls = "p-tab -mb-px flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-2.5 py-[13px] p-t-control";

/**
 * A group: its name as the one section label above it (no icon, no sentence under it: a fact the control can't show is
 * its field's one-line hint), and its rows in one card. `actions` sit on the label's row.
 */
export function Card({ title, actions, children }: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <header className="flex min-h-7 items-end gap-3">
        <h2 className="min-w-0 flex-1 p-label">{title}</h2>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="p-card space-y-5 p-5">{children}</div>
    </section>
  );
}

/** `inline` puts a small control on the label's row at desktop width. */
export function Field({ label, hint, inline = false, children }: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  inline?: boolean;
  children?: React.ReactNode;
}) {
  const text = (
    <div className="min-w-0">
      <div className="p-row-text font-medium p-text">{label}</div>
      {hint && <p className="mt-0.5 p-meta p-text-3">{hint}</p>}
    </div>
  );

  if (inline) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        {text}
        {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {text}
      {children}
    </div>
  );
}

/** The trigger wears the text inputs' surface, border, radius and focus; `!` because Kumo sets its own. */
const choiceCls = '!rounded-md !border !border-[var(--c-input-border)] !bg-[var(--c-surface)] !shadow-none !ring-0'
  + ' focus-visible:!border-[var(--c-accent)] focus-visible:!ring-1 focus-visible:!ring-[var(--c-accent-subtle)]';

/** Kumo's themed popup, never the OS's. */
export function Choice<Value extends string>(props: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
  disabled?: boolean;
  size?: 'sm' | 'base';
  className?: string;
  /** The trigger's own words for the chosen value, where its option's label is too long to sit in a row. */
  shown?: (value: Value) => string;
}) {
  return (
    <Select
      aria-label={props.label}
      size={props.size ?? 'base'}
      className={`w-full ${choiceCls} ${props.size === 'sm' ? '' : '!h-auto !py-2 !text-sm'} ${props.className ?? ''}`}
      value={props.value}
      disabled={props.disabled}
      items={props.options}
      renderValue={(value) => {
        const picked = props.options.find((option) => option.value === value);

        return picked === undefined ? value : props.shown?.(picked.value) ?? picked.label;
      }}
      onValueChange={(next) => {
        const picked = props.options.find((option) => option.value === next);

        if (picked) props.onChange(picked.value);
      }}
    />
  );
}
