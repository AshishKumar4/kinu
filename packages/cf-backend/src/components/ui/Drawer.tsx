/** A panel from the right edge over a scrim (docs/DESIGN-SYSTEM.md §2): a file read beside the page it was opened from. */
import type { ReactNode } from "react";

export function Drawer({ onClose, children, ...data }: { onClose: () => void; children: ReactNode } & Readonly<Record<`data-${string}`, string>>) {
  return (
    <>
      <div aria-hidden="true" className="p-scrim fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[var(--layout-drawer)]" {...data}>{children}</div>
    </>
  );
}
