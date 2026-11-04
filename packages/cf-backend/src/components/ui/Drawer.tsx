/**
 * A panel from an edge over a scrim (docs/DESIGN-SYSTEM.md §2): from the right, a file read beside the page it was
 * opened from; from the left, a phone's menu. Base UI's dialog, as `Modal` is: focus held inside and given back, Escape
 * and the scrim closing the topmost one only. Mounted is open.
 */
import type { ReactNode } from "react";
import { Dialog } from "@cloudflare/kumo/primitives/dialog";

const SIDE = {
  right: "right-0 w-full sm:w-[var(--layout-drawer)]",
  left: "left-0 w-72 max-w-[var(--layout-nav-drawer)]",
} as const;

export function Drawer({ label, onClose, side = "right", children, ...data }: {
  /** Its name for a screen reader: what it shows. */
  label: string;
  onClose: () => void;
  side?: keyof typeof SIDE;
  children: ReactNode;
} & Readonly<Record<`data-${string}`, string>>) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="p-scrim fixed inset-0 z-50 animate-fade-in" />
        <Dialog.Popup className={`fixed inset-y-0 z-50 outline-none ${SIDE[side]}`} aria-label={label} {...data}>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The dimmed page behind a panel laid over it in place; pressed, it closes the panel. */
export function Scrim({ label, onClose, ...data }: { label: string; onClose: () => void } & Readonly<Record<`data-${string}`, string | boolean>>) {
  return <button type="button" aria-label={label} className="p-scrim" onClick={onClose} {...data} />;
}
