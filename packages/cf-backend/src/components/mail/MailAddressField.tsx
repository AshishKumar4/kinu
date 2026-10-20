/**
 * The person's address, `<username>@<domain>`, as they choose it (docs/MAIL.md §1): one field, checked as they type, used
 * in setup and where Mail would show their mailbox. The username starts as the one they are offered.
 */
import { useEffect, useState } from "react";
import { MAIL_LABEL_PATTERN, mailUsernameRefusal } from "@kinu.run/core";
import { inputCls } from "@/components/ui/form";
import { Status, type StatusTone } from "@/components/ui/Status";
import { checkMailUsername } from "@/lib/mail-api";

export type MailUsernameState = "checking" | "available" | "taken" | "reserved" | "invalid" | "unchecked";

const SAID: Record<Exclude<MailUsernameState, "unchecked">, [StatusTone, string]> = {
  checking: ["neutral", "Checking"],
  available: ["success", "Available"],
  taken: ["danger", "Taken"],
  reserved: ["danger", "Kept for mail systems"],
  invalid: ["danger", "Lowercase letters, digits and hyphens, up to 20"],
};

/**
 * A username and whether it is free, read a moment after the last keystroke; a check that fails leaves it unchecked.
 * It follows the suggestion until the person types.
 */
export function useMailUsername(suggested: string | null) {
  const [typed, setUsername] = useState<string | null>(null);
  const username = typed ?? suggested ?? "";
  const [state, setState] = useState<MailUsernameState>("checking");

  useEffect(() => {
    const refusal = mailUsernameRefusal(username);

    if (refusal !== null) {
      setState(username === "" ? "unchecked" : refusal);

      return undefined;
    }

    setState("checking");

    let current = true;

    const timer = setTimeout(() => {
      checkMailUsername(username).then(
        (checked) => { if (current) setState(checked.available ? "available" : checked.refusal ?? "unchecked"); },
        () => { if (current) setState("unchecked"); },
      );
    }, 250);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [username]);

  return { username, setUsername, state };
}

export function MailAddressField({ domain, username, state, onChange, disabled }: {
  domain: string;
  username: string;
  state: MailUsernameState;
  onChange: (username: string) => void;
  disabled?: boolean;
}) {
  const said = state === "unchecked" ? null : SAID[state];

  return (
    <div data-mail-address className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input value={username} onChange={(event) => onChange(event.target.value.trim().toLowerCase())} aria-label="Username"
          autoComplete="off" autoCapitalize="none" spellCheck={false} pattern={MAIL_LABEL_PATTERN} maxLength={20} disabled={disabled}
          className={`${inputCls} min-w-0 flex-1 font-mono`} />
        <span className="shrink-0 font-mono p-row-text p-text-2">@{domain}</span>
      </div>
      <div className="min-h-5">{said !== null && <Status tone={said[0]} hooks={{ "data-mail-address-state": state }}>{said[1]}</Status>}</div>
    </div>
  );
}
