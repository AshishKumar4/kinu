import type { ReactNode } from "react";
import { TextInput } from "@/components/ui/Field";
import { Choices } from "@/components/ui/Choices";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";

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
    <TextInput value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}
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

/** Who can open it, both ways shown with what each means. */
export function AccessPicker<Id extends string>({ options, value, onChange, disabled }: {
  options: readonly AccessOption<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  disabled: boolean;
}) {
  return <Choices label="Who can open it" marker="data-share-access-option" options={options} value={value} onChange={onChange} disabled={disabled} />;
}

export function StopButton({ onStop, disabled }: { onStop: () => void; disabled: boolean }) {
  return (
    <Button variant="danger" size="sm" onClick={onStop} disabled={disabled} data-stop-sharing className="shrink-0">Stop sharing</Button>
  );
}

export function Failure({ message }: { message: string | null }) {
  return message === null ? null : <Notice tone="danger">{message}</Notice>;
}
