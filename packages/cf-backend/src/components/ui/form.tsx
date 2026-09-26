/** Buttons are not here: the filled action is `ui/FilledButton`, quiet buttons are Kumo's. */
import type * as React from 'react';
import { Select } from '@cloudflare/kumo';

export const inputCls = "w-full rounded-md px-3 py-2 text-sm p-text focus:outline-none transition-all"
  + " border border-[var(--c-input-border)] bg-[var(--c-surface)]"
  + " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
  + " placeholder:p-text-3";

/** Shared by both headers so the active underline lands on the strip's rule. */
export const tabStripH = "h-[45px]";

/** An IME's own keystroke: the Enter that picks a candidate, the Escape that drops one. WebKit ends the composition
 *  first, so there only keyCode 229 marks it. */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

export const tabCls = "p-tab -mb-px flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-2.5 py-[13px] p-t-control";

export function Card({ title, icon: Icon, description, actions, children }: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="p-card overflow-hidden">
      <header className="flex items-start gap-3 border-b p-border px-5 py-4">
        <Icon size={16} className="mt-0.5 shrink-0 p-text-3" />
        <div className="min-w-0 flex-1">
          <h2 className="p-title p-text">{title}</h2>
          {description && <p className="mt-0.5 p-meta p-text-3">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="space-y-5 px-5 py-5">{children}</div>
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
}) {
  return (
    <Select
      aria-label={props.label}
      size={props.size ?? 'base'}
      className={`w-full ${choiceCls} ${props.size === 'sm' ? '' : '!h-auto !py-2 !text-sm'} ${props.className ?? ''}`}
      value={props.value}
      disabled={props.disabled}
      items={props.options}
      renderValue={(value) => props.options.find((option) => option.value === value)?.label ?? value}
      onValueChange={(next) => {
        const picked = props.options.find((option) => option.value === next);

        if (picked) props.onChange(picked.value);
      }}
    />
  );
}
