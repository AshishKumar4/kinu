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
 */
export const btnSmCls = "inline-flex h-6.5 shrink-0 items-center justify-center gap-1 px-2 text-xs cursor-pointer";

/**
 * Metrics for a tab in a surface strip. The look is `p-tab` (+ `p-tab-active`
 * on the current one) from index.css; this is only the box. Every strip in
 * the app uses the pair, so a tab reads the same above the chat as it does
 * above the work surfaces.
 */
export const tabCls = "p-tab -mb-px flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-2 py-2.5 p-row-text font-medium @[38rem]:px-3";

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
