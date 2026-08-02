/**
 * Shared modal shell — the dimmed overlay + centered card used by every dialog
 * (create agent, fork, create webhook). Click-outside and Esc both dismiss,
 * unless the dialog is `busy`: a stray backdrop click during an in-flight
 * create/clear/dismiss used to tear the dialog down mid-write, leaving the
 * result unreported. Two call sites guarded that themselves and four did not,
 * so the policy lives here.
 * Callers supply the header icon/title, the body, and an optional footer row.
 */
import { useCallback, useEffect, type ReactNode } from "react";

export interface ModalProps {
  title: string;
  onClose: () => void;
  icon?: ReactNode;
  children: ReactNode;
  /** Right-aligned action row (buttons). Omit for bodies that render their own. */
  footer?: ReactNode;
  /** Tailwind max-width class; defaults to a standard form width. */
  maxWidthClass?: string;
  /** A write is in flight — backdrop and Escape stop dismissing. An explicit
   *  Cancel stays the caller's to offer (or disable). */
  busy?: boolean;
}

export function Modal({ title, onClose, icon, children, footer, maxWidthClass = "max-w-md", busy = false }: ModalProps) {
  const dismiss = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={dismiss}
    >
      <div
        className={`w-full ${maxWidthClass} max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border p-border p-elevated p-4 sm:p-5 space-y-4 animate-fade-in`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-base font-semibold p-text">{title}</h3>
        </div>
        {children}
        {footer && <div className="flex justify-end gap-2 pt-1">{footer}</div>}
      </div>
    </div>
  );
}
