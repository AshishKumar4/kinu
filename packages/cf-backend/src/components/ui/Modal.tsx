/**
 * A dialog over the page (docs/DESIGN-SYSTEM.md §2): Base UI's dialog, through Kumo's primitives, for its focus trap,
 * focus return, inert page, scroll lock and stacking. Escape and a press on the scrim close only the topmost one, and a
 * text selection that ends over the scrim is not a press. Neither dismisses while `busy`: tearing down mid-write leaves
 * the result unreported.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { Dialog } from "@cloudflare/kumo/primitives/dialog";

/** A dialog's three widths (docs/DESIGN-SYSTEM.md §2): a question, a form, a reader. */
export type DialogWidth = "sm" | "md" | "lg";

interface ModalProps {
  title: string;
  onClose: () => void;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: DialogWidth;
  /** Stops scrim and Escape dismissal; Cancel stays the caller's to offer. */
  busy?: boolean;
  /** Keys the dialog itself answers (the arrows that step through takes): the popup keeps arrow keys from the page. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** The page under it keeps its scroll, as the feedback dialog's capture of the whole page needs; focus stays held. */
  pageScrolls?: boolean;
}

/** `data-*` marks the dialog's whole layer, its scrim included (the feedback capture's omit marker). */
export function Modal({ title, onClose, icon, children, footer, width = "sm", busy = false, onKeyDown, pageScrolls = false, ...data }: ModalProps & Readonly<Record<`data-${string}`, string>>) {
  return (
    <Dialog.Root open modal={pageScrolls ? "trap-focus" : true} disablePointerDismissal={busy} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      {/* One stacking context over the page, in the page's order, with no z-index inside it: a select or menu opened in
          the dialog is portalled into it after the popup, so it draws above. */}
      <Dialog.Portal className="isolate" {...data}>
        <Dialog.Backdrop className="p-scrim fixed inset-0" />
        <Dialog.Viewport className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Popup className={`p-dialog p-dialog-${width}`} aria-label={title} onKeyDown={onKeyDown}>
            <DialogFace heading={<Dialog.Title render={<h3 />} className="t-title">{title}</Dialog.Title>} icon={icon} footer={footer}>
              {children}
            </DialogFace>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A dialog's inside: its heading, body and footer, which the system frame draws at rest in a `p-dialog` of its own. */
export function DialogFace({ heading, icon, footer, children }: { heading: ReactNode; icon?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-2">
        {icon}
        {heading}
      </div>
      {children}
      {footer && <div className="flex flex-wrap justify-end gap-2 pt-1">{footer}</div>}
    </>
  );
}
