/** Click-outside and Esc dismiss unless `busy`: tearing down mid-write leaves the result unreported. */
import { useCallback, useEffect, type ReactNode } from "react";
import { composing } from "@/components/ui/form";

export interface ModalProps {
  title: string;
  onClose: () => void;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  maxWidthClass?: string;
  /** Stops backdrop and Escape dismissal; Cancel stays the caller's to offer. */
  busy?: boolean;
}

export function Modal({ title, onClose, icon, children, footer, maxWidthClass = "max-w-md", busy = false }: ModalProps) {
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
      <div
        className={`w-full ${maxWidthClass} max-h-[calc(100vh-2rem)] overflow-y-auto border p-border p-overlay p-4 sm:p-5 space-y-4 animate-fade-in`}
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
