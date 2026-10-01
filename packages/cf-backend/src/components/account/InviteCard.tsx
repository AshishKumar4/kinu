/** The owner's invite links, where built-in sign-in is on. */
import { useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { UserPlusIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import { attempt, renderThrownChain, settle } from "@kinu.run/core/obs";
import { builtinAuthStatus, createBuiltinInvite } from "@/lib/user-api";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { Card, Field, inputCls } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { CopyButton } from "@/components/ui/CopyButton";

export function InviteCard() {
  const status = useAsyncResource(builtinAuthStatus);
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState<{ url: string; email: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = () => Effect.sync(() => { setBusy(true); setError(null); }).pipe(
    Effect.andThen(attempt({ doing: "creating an invite link", otherwise: "io" }, () => createBuiltinInvite(email.trim()))),
    Effect.map(setInvite),
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
          <Button type="submit" variant="secondary" size="sm" disabled={busy || email.trim() === ""} onClick={() => settle(create())}>
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
      {invite !== null && <p className="mt-2 p-meta p-text-3">For {invite.email}, until {new Date(invite.expiresAt).toLocaleString()}.</p>}
      {error && <p role="alert" className="mt-2 text-xs p-danger">{error}</p>}
    </Card>
  );
}
