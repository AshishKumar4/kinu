/** Click-outside and Esc dismiss unless `busy`: tearing down mid-write leaves the result unreported. */
import { useCallback, useEffect, type MouseEvent, type ReactNode } from "react";
import { composing } from "@/components/ui/form";

/** A dialog's three widths (docs/DESIGN-SYSTEM.md §2): a question, a form, a reader. */
type DialogWidth = "sm" | "md" | "lg";

interface ModalProps {
  title: string;
  onClose: () => void;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: DialogWidth;
  /** The older way to say how wide: a Tailwind max-width, until each caller names its width. */
  maxWidthClass?: string;
  /** Stops backdrop and Escape dismissal; Cancel stays the caller's to offer. */
  busy?: boolean;
}

export function Modal({ title, onClose, icon, children, footer, width = "sm", maxWidthClass, busy = false }: ModalProps) {
  const dismiss = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !composing(e)) dismiss(); };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  return (
    <div
      className="p-scrim fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={dismiss}
    >
      <DialogBox title={title} icon={icon} footer={footer} width={width} maxWidthClass={maxWidthClass} onClick={(e) => e.stopPropagation()}>{children}</DialogBox>
    </div>
  );
}

/** The dialog itself, without its scrim: what `Modal` opens, and what the system frame draws at rest. */
export function DialogBox({ title, icon, children, footer, width = "sm", maxWidthClass, onClick }: Omit<ModalProps, "onClose" | "busy"> & {
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className={`p-dialog p-dialog-${width}${maxWidthClass === undefined ? "" : ` ${maxWidthClass}`}`} onClick={onClick} role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="t-title">{title}</h3>
      </div>
      {children}
      {footer && <div className="flex flex-wrap justify-end gap-2 pt-1">{footer}</div>}
    </div>
  );
}
