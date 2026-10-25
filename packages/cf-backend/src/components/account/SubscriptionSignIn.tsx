/**
 * One sign-in card both plans draw (the owner, 2026-10-23: "more consistent UI between them"): the provider's terms
 * said once, then numbered steps, the one being done in the item's ink, those done checked, those to come quiet; one
 * Open link, one paste field with its own Paste, the refusal in its place.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Effect } from "effect";
import { detach, diagnostics, renderThrownChain } from "@kinu.run/core/obs";
import { ArrowSquareOutIcon, CheckIcon, ClipboardTextIcon, WarningIcon } from "@phosphor-icons/react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Field, TextInput } from "@/components/ui/Field";
import { Surface } from "@/components/ui/Surface";
import type { ProviderWindow } from "@/hooks/use-provider-window";

/** The provider's terms, said once and quietly, where the sign-in starts. */
export function SignInRisk({ children }: { children: ReactNode }) {
  return (
    <p className="t-meta flex items-start gap-2 p-text-3" data-sign-in-risk>
      <WarningIcon size={14} className="mt-px shrink-0 p-warning" />
      <span>{children}</span>
    </p>
  );
}

export type SignInStepState = "done" | "now" | "next";

export function SignInSteps({ children }: { children: ReactNode }) {
  return <ol className="space-y-4" data-sign-in-steps>{children}</ol>;
}

export function SignInStep({ n, state, title, children }: { n: number; state: SignInStepState; title: string; children?: ReactNode }) {
  return (
    <li className={`flex gap-3 ${state === "next" ? "opacity-50" : ""}`} data-sign-in-step={n} data-step-state={state}>
      <Surface look={state === "now" ? "selected" : "tile"} round as="span" className="t-label flex size-6 shrink-0 items-center justify-center">
        {state === "done" ? <CheckIcon size={12} weight="bold" className="p-success" /> : n}
      </Surface>
      <div className="min-w-0 flex-1 space-y-2 pt-px">
        <p className={state === "now" ? "t-item p-text" : "t-body p-text-2"}>{title}</p>
        {children}
      </div>
    </li>
  );
}

/** The provider's page, in the sign-in's popup (`useProviderWindow`), which the card closes once the sign-in connects. A
 *  click asking for a tab, or a popup the browser refused, is left to the link, which opens a tab. */
export function SignInOpen({ href, label, signInWindow, onOpen }: { href: string; label: string; signInWindow: ProviderWindow; onOpen?: () => void }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => { signInWindow.open(event); onOpen?.(); }}
      className={buttonClass({ variant: "primary", size: "sm" })} data-sign-in-open>
      <ArrowSquareOutIcon size={12} />{label}
    </a>
  );
}

/** How to take a page's whole address from its address bar, on this device. */
export function CopyAddressHint() {
  const phone = window.matchMedia("(hover: none)").matches;

  return (
    <p className="t-meta p-text-3" data-copy-hint>
      {phone
        ? <>Tap the address bar, then <b>Select all</b> and <b>Copy</b>.</>
        : <>Click the address bar, then press <kbd className="t-mono">Ctrl/⌘ A</kbd> and <kbd className="t-mono">Ctrl/⌘ C</kbd>.</>}
    </p>
  );
}

/** The paste field both plans use: its own Paste reads the clipboard; Enter or Connect sends; the refusal names what is wrong. */
export function SignInPaste({ label, placeholder, value, onChange, onSubmit, busy, problem, action }: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  problem: string | null;
  action: string;
}) {
  // A browser that will not let the page read the clipboard leaves the field to the person's own paste, and says why.
  const [unread, setUnread] = useState<string | null>(null);

  const readClipboard = () => Effect.tryPromise({ try: () => navigator.clipboard.readText(), catch: (cause) => cause }).pipe(
    Effect.map((text) => {
      setUnread(null);

      if (text.trim() !== "") onChange(text.trim());
    }),
    Effect.catch((cause) => Effect.sync(() => {
      diagnostics.event("ui.clipboard_read_refused", { error: renderThrownChain({ cause }) });
      setUnread("This browser won't let Kinu read the clipboard: paste into the field yourself.");
    })),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (value.trim() !== "" && !busy) onSubmit();
  };

  return (
    <form onSubmit={submit} data-sign-in-paste>
      <Field label={label} error={problem ?? unread}>
        <div className="flex flex-wrap gap-2">
          <TextInput className="t-mono min-w-0 flex-1 max-sm:basis-full" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}
            aria-label={label} invalid={problem !== null} autoComplete="off" spellCheck={false} disabled={busy} />
          <Button size="md" icon={<ClipboardTextIcon size={14} />} onClick={() => detach(readClipboard())} disabled={busy}>Paste</Button>
          <Button type="submit" variant="primary" size="md" busy={busy} disabled={busy || value.trim() === ""}>{action}</Button>
        </div>
      </Field>
    </form>
  );
}
