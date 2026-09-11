/**
 * Shared control primitives — one input style, one settings card, one field
 * grammar, and the metrics for a surface tab, so the pages never drift apart visually.
 * Buttons are not here: the filled action is `ui/FilledButton`, and quiet
 * buttons are Kumo's.
 */

export const inputCls = "w-full rounded-md px-3 py-2 text-sm p-text focus:outline-none transition-all"
  + " border border-[var(--c-input-border)] bg-[var(--c-surface)]"
  + " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
  + " placeholder:p-text-3";


/**
 * Metrics for a tab in a surface strip. The look is `p-tab` (+ `p-tab-active`
 * on the current one) from index.css; this is only the box. Every strip in
 * the app uses the pair, so a tab reads the same above the chat as it does
 * above the work surfaces.
 */
export const tabCls = "p-tab -mb-px flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-2.5 py-[13px] text-[12.5px] leading-[18px] font-medium";

/**
 * A settings group: one titled card whose header names the group and, when
 * the title alone does not say it, what the controls inside change. The body
 * keeps one vertical rhythm (`space-y-5`) so every field, list and notice
 * inside lands on the same beat, and `actions` is the slot for a state badge
 * or a one-off control that belongs to the group rather than to a field.
 */
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

/**
 * One setting: what it is called, what it does to the workspace, and the
 * control. `inline` puts a small control (a switch, a select, a short value)
 * on the label's row at desktop width and under it on a phone; the default
 * stacks the control under the label at every width, which is where a text
 * field, a combobox or a list belongs.
 */
export function Field({ label, hint, inline = false, children }: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  inline?: boolean;
  children?: React.ReactNode;
}) {
  const text = (
    <div className="min-w-0">
      <div className="p-row-text font-medium p-text">{label}</div>
      {hint && <p className="mt-0.5 p-meta leading-relaxed p-text-3">{hint}</p>}
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
