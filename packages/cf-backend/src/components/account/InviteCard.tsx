import { useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { UserPlusIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import { attempt, renderThrownChain, settle } from "@kinu.run/core/obs";
import { builtinAuthStatus, createBuiltinLink, listBuiltinAccounts } from "@/lib/user-api";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { Card, Field, inputCls } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { CopyButton } from "@/components/ui/CopyButton";

export function InviteCard() {
  const status = useAsyncResource(builtinAuthStatus);
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState<{ url: string; email: string; expiresAt: number; reset: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = (reset: boolean, address: string) => Effect.sync(() => { setBusy(true); setError(null); }).pipe(
    Effect.andThen(attempt(
      { doing: reset ? "creating a reset link" : "creating an invite link", otherwise: "io" },
      () => createBuiltinLink(reset ? "resets" : "invites", address),
    )),
    Effect.map((link) => { setInvite({ ...link, reset }); }),
    Effect.catch((failure) => Effect.sync(() => { setError(renderThrownChain({ cause: failure.cause ?? failure })); })),
    Effect.ensuring(Effect.sync(() => { setBusy(false); })),
  );

  const { resource } = status;

  // Only a failed read draws a slot: a card that may never show takes no room while it loads.
  if (resource.status === "error") {
    return <CardSlot resource={resource} what="whether you can invite people" onRetry={status.reload}>{() => null}</CardSlot>;
  }

  if (resource.status !== "ready" || !resource.value.enabled || !resource.value.owner) return null;

  return (
    <Card title="Invite people" icon={UserPlusIcon}>
      <Field label="Invite by email" hint="The link signs up this address only, once, within 7 days.">
        <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); }}>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com"
            aria-label="Email to invite" autoComplete="off" className={`${inputCls} min-w-0 flex-1`} />
          <Button type="submit" variant="secondary" size="sm" disabled={busy || email.trim() === ""} onClick={() => settle(create(false, email.trim()))}>
            {busy ? <Loader size="sm" /> : null} Create invite link
          </Button>
        </form>
      </Field>
      {invite !== null && (
        <div className="mt-3 flex items-center gap-2" data-invite-link>
          <code className="min-w-0 flex-1 truncate rounded-md border p-border p-fill px-3 py-2 font-mono p-row-text p-text select-all">{invite.url}</code>
          <CopyButton value={invite.url} what="the invite link" size={14} className="p-btn-quiet inline-flex size-8 shrink-0 items-center justify-center" />
        </div>
      )}
      {invite !== null && (
        <p className="mt-2 p-meta p-text-3">
          {invite.reset ? "Reset link" : "Invite"} for {invite.email}, until {new Date(invite.expiresAt).toLocaleString()}.
        </p>
      )}
      <Accounts busy={busy} onReset={(address) => settle(create(true, address))} />
      {error && <p role="alert" className="mt-2 text-xs p-danger">{error}</p>}
    </Card>
  );
}

function Accounts({ busy, onReset }: { busy: boolean; onReset: (email: string) => void }) {
  const accounts = useAsyncResource(listBuiltinAccounts);

  return (
    <CardSlot resource={accounts.resource} what="this deployment's accounts" onRetry={accounts.reload}>
      {({ accounts: list }) => (
        <Field label="Accounts" hint="A reset link replaces that account's password and passkeys, once, within 7 days, and signs it out everywhere.">
          <ul className="p-group">
            {list.map((account) => (
              <li key={account.email} className="flex items-center gap-3 px-3 py-2" data-account={account.email}>
                <span className="min-w-0 flex-1 truncate p-row-text p-text">{account.email}</span>
                <span className="p-meta p-text-3">{account.role === "owner" ? "Owner" : "Member"}</span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onReset(account.email)}
                  aria-label={`Create a reset link for ${account.email}`}>Reset link</Button>
              </li>
            ))}
          </ul>
        </Field>
      )}
    </CardSlot>
  );
}
