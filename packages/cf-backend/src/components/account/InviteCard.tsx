/** The owner's invite links, where built-in sign-in is on. */
import { useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { UserPlusIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import { attempt, renderThrownChain, settle } from "@kinu.run/core/obs";
import { builtinAuthStatus, createBuiltinInvite } from "@/lib/user-api";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { Card, Field } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { CopyButton } from "@/components/ui/CopyButton";

export function InviteCard() {
  const status = useAsyncResource(builtinAuthStatus);
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = () => Effect.sync(() => { setBusy(true); setError(null); }).pipe(
    Effect.andThen(attempt({ doing: "creating an invite link", otherwise: "io" }, createBuiltinInvite)),
    Effect.map(setInvite),
    Effect.catch((failure) => Effect.sync(() => { setError(renderThrownChain({ cause: failure.cause ?? failure })); })),
    Effect.ensuring(Effect.sync(() => { setBusy(false); })),
  );

  return (
    <CardSlot resource={status.resource} what="whether you can invite people" onRetry={status.reload}>
      {({ enabled, owner }) => (!enabled || !owner ? null : (
        <Card title="Invite people" icon={UserPlusIcon}>
          <Field inline label="Invite link" hint="One person can sign up with each link. It expires after 7 days.">
            <Button variant="secondary" size="sm" onClick={() => settle(create())} disabled={busy}>
              {busy ? <Loader size="sm" /> : null} {invite === null ? "Create invite link" : "Create another"}
            </Button>
          </Field>
          {invite !== null && (
            <div className="mt-3 flex items-center gap-2" data-invite-link>
              <code className="min-w-0 flex-1 truncate rounded-md border p-border p-fill px-3 py-2 font-mono p-row-text p-text select-all">{invite.url}</code>
              <CopyButton value={invite.url} what="the invite link" size={14} className="p-btn-quiet inline-flex size-8 shrink-0 items-center justify-center" />
            </div>
          )}
          {invite !== null && <p className="mt-2 p-meta p-text-3">Valid until {new Date(invite.expiresAt).toLocaleString()}. Send it to one person.</p>}
          {error && <p role="alert" className="mt-2 text-xs p-danger">{error}</p>}
        </Card>
      ))}
    </CardSlot>
  );
}
