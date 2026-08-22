/**
 * Shared control primitives — one input style, one section card, and the
 * metrics for a surface tab, so the pages never drift apart visually.
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

export function Card({ title, icon: Icon, children }: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="p-card p-5 space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon size={16} className="p-accent" />
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}
