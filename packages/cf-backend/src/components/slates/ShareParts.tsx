import { useState, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { inputCls } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";

export function Lead({ children }: { children: ReactNode }) {
  return <p className="t-body p-text-2">{children}</p>;
}

export function EmailsField({ value, onChange, disabled, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <input value={value} onChange={(event) => onChange(event.target.value)} className={inputCls} placeholder={placeholder}
      aria-label={placeholder} disabled={disabled} data-share-emails />
  );
}

export function emailsOf(text: string): string[] {
  return text.split(/[\s,;]+/u).map((email) => email.trim()).filter(Boolean);
}

export interface AccessOption<Id extends string> {
  readonly id: Id;
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail: string;
}

export function AccessPicker<Id extends string>({ options, value, onChange, disabled }: {
  options: readonly AccessOption<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((option) => option.id === value) ?? options[0];

  if (chosen === undefined) return null;

  return (
    <div className="relative flex items-start gap-3">
      <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-full p-fill p-text-2">{chosen.icon}</span>
      <span className="min-w-0 flex-1">
        <button type="button" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} data-share-access={chosen.id}
          onClick={() => setOpen((shown) => !shown)}
          className="t-item -ml-2 inline-flex items-center gap-1 rounded-md px-1 py-px p-text transition-colors hover:bg-[var(--c-hover)]">
          {chosen.label} <CaretDownIcon size={12} className="p-text-3" />
        </button>
        <span className="t-meta block p-text-3">{chosen.detail}</span>
      </span>
      {open && (
        <div role="listbox" aria-label="Who can open it" className="absolute left-0 top-12 z-10 w-[21rem] max-w-full p-card border p-border p-1 p-shadow-menu animate-fade-in">
          {options.map((option) => (
            <button key={option.id} type="button" role="option" aria-selected={option.id === value} data-share-access-option={option.id}
              onClick={() => { onChange(option.id); setOpen(false); }}
              className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--c-hover)]">
              <span className="mt-px flex shrink-0 p-text-3">{option.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="t-item block p-text">{option.label}</span>
                <span className="t-meta block p-text-3">{option.detail}</span>
              </span>
              <span className="mt-px flex w-4 shrink-0">{option.id === value && <CheckIcon size={14} weight="bold" className="p-accent-fg" />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function StopButton({ onStop, disabled }: { onStop: () => void; disabled: boolean }) {
  return (
    <button type="button" onClick={onStop} disabled={disabled} data-stop-sharing
      className="t-status shrink-0 rounded-md px-2 py-1 p-danger transition-colors hover:bg-[var(--c-danger-tint)]">
      Stop sharing
    </button>
  );
}

export function Failure({ message }: { message: string | null }) {
  return message === null ? null : <Notice tone="danger">{message}</Notice>;
}
