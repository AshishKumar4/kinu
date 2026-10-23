/**
 * One sign-in card both plans draw (the owner, 2026-10-23: "more consistent UI between them"): the provider's terms
 * said once, then numbered steps, the one being done in the item's ink, those done checked, those to come quiet; one
 * Open link, one paste field with its own Paste, the refusal in its place.
 */
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { Effect } from "effect";
import { detach, diagnostics, renderThrownChain } from "@kinu.run/core/obs";
import { ArrowSquareOutIcon, CheckIcon, ClipboardTextIcon, WarningIcon } from "@phosphor-icons/react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Field, TextInput } from "@/components/ui/Field";
import { Surface } from "@/components/ui/Surface";

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

/** The provider's page, a tab of its own unless `onOpen` takes the click into a popup (`useProviderWindow`): a page the
 *  person must copy from stays open in a tab; one whose end this page learns can be a popup it closes. */
export function SignInOpen({ href, label, onOpen }: { href: string; label: string; onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={onOpen} className={buttonClass({ variant: "primary", size: "sm" })} data-sign-in-open>
      <ArrowSquareOutIcon size={12} />{label}
    </a>
  );
}

/** The page a sign-in ends on that does not load, drawn: an address bar whose whole address is what to copy. */
export function DeadPage({ host, rest }: { host: string; rest: string }) {
  const phone = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

  return (
    <figure className="space-y-2" data-dead-page>
      <Surface look="well" className="overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          {/* The design system's own focus ring, held on: the address is what to take. */}
          <Surface look="panel" className="t-code min-w-0 flex-1 truncate px-2 py-1" data-force="focus">
            <span className="p-text">{host}</span><span className="p-text-3">{rest}</span>
          </Surface>
        </div>
        <div className="space-y-1 px-4 pt-3 pb-4">
          <p className="t-item p-text-2">This site can&apos;t be reached</p>
          <p className="t-meta p-text-3">{host.split("/")[0]} refused to connect.</p>
        </div>
      </Surface>
      <figcaption className="t-meta p-text-2">
        {phone
          ? <>Tap the address bar, then <b>Select all</b> and <b>Copy</b>.</>
          : <>Click the address bar, then <kbd className="t-mono">Ctrl/⌘ A</kbd> and <kbd className="t-mono">Ctrl/⌘ C</kbd>.</>}
      </figcaption>
    </figure>
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

/** True once the person has come back to this page after leaving it for the provider's (`armed` from the click). */
export function useReturned(armed: boolean): boolean {
  const [back, setBack] = useState(false);

  useEffect(() => {
    if (!armed) {
      setBack(false);

      return;
    }

    let left = document.visibilityState === "hidden" || !document.hasFocus();

    const leave = () => { left = true; };

    const come = () => {
      if (left && document.visibilityState === "visible") setBack(true);
    };

    const seen = () => {
      if (document.visibilityState === "hidden") leave();
      else come();
    };

    window.addEventListener("blur", leave);
    window.addEventListener("focus", come);
    document.addEventListener("visibilitychange", seen);

    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", come);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [armed]);

  return back;
}
