/**
 * Shared modal shell — the dimmed overlay + centered card used by every dialog
 * (create agent, fork, create webhook). Click-outside and Esc both dismiss.
 * Callers supply the header icon/title, the body, and an optional footer row.
 */
import { useEffect, type ReactNode } from "react";

export interface ModalProps {
  title: string;
  onClose: () => void;
  icon?: ReactNode;
  children: ReactNode;
  /** Right-aligned action row (buttons). Omit for bodies that render their own. */
  footer?: ReactNode;
  /** Tailwind max-width class; defaults to a standard form width. */
  maxWidthClass?: string;
}

export function Modal({ title, onClose, icon, children, footer, maxWidthClass = "max-w-md" }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className={`w-full ${maxWidthClass} rounded-xl border p-border p-elevated p-5 space-y-4 animate-fade-in`}
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
