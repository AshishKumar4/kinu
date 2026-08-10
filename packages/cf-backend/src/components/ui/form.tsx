/**
 * Shared control primitives — one input style, one section card, and the
 * metrics for the dense action row, so the pages never drift apart visually.
 */

export const inputCls = "w-full rounded-md px-3 py-2 text-sm p-text focus:outline-none transition-all"
  + " border border-[var(--c-input-border)] bg-[var(--c-surface)]"
  + " focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
  + " placeholder:p-text-3";

/**
 * Metrics for a button in a dense action row (modal footers, surface
 * toolbars), matched to Kumo's `size="sm"` so ours line up with the Kumo
 * buttons beside them. Pair with a look class from index.css — `p-btn` for
 * the one primary action, `p-btn-danger` for a destructive confirm.
 *
 * The look and the metrics are separate because the `p-*` classes are
 * unlayered and would outrank any Tailwind size utility written next to them;
 * keeping height and padding here leaves them overridable at the call site.
 */
export const btnSmCls = "inline-flex h-6.5 shrink-0 items-center justify-center gap-1 px-2 text-xs cursor-pointer";

export function Card({ title, icon: Icon, children }: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="p-card rounded-xl p-5 space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon size={16} className="p-accent" />
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}
