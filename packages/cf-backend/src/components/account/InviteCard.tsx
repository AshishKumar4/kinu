import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Effect } from "effect";
import { attempt } from "@kinu.run/core/obs";
import { builtinAuthStatus, createBuiltinLink, listBuiltinAccounts } from "@/lib/user-api";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { Card } from "@/components/ui/Card";
import { CardSlot } from "@/components/ui/CardSlot";
import { Group } from "@/components/ui/Group";
import { TextInput, Field } from "@/components/ui/Field";
import { CopyField } from "@/components/ui/CopyField";
import { Notice } from "@/components/ui/Notice";
import { useLabelledStep } from "@/hooks/use-labelled-step";

export function InviteCard() {
  const status = useAsyncResource(builtinAuthStatus);
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState<{ url: string; email: string; expiresAt: number; reset: boolean } | null>(null);
  const step = useLabelledStep();
  const busy = step.busy !== null;

  const create = (reset: boolean, address: string): void => step.run(reset ? "reset" : "invite", () => Effect.map(attempt(
    { doing: reset ? "creating a reset link" : "creating an invite link", otherwise: "io" },
    () => createBuiltinLink(reset ? "resets" : "invites", address),
  ), (link) => { setInvite({ ...link, reset }); }));

  const { resource } = status;

  // Only a failed read draws a slot: a card that may never show takes no room while it loads.
  if (resource.status === "error") {
    return <CardSlot resource={resource} what="whether you can invite people" onRetry={status.reload}>{() => null}</CardSlot>;
  }

  if (resource.status !== "ready" || !resource.value.enabled || !resource.value.owner) return null;

  return (
    <Card title="Invite people">
      <Field label="Invite by email" hint="The link signs up this address only, once, within 7 days.">
        <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); }}>
          <TextInput className="min-w-0 flex-1" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" aria-label="Email to invite" autoComplete="off" />
          <Button type="submit" variant="secondary" size="sm" disabled={email.trim() === ""} busy={step.busy === "invite"} onClick={() => create(false, email.trim())}>
            Create invite link
          </Button>
        </form>
      </Field>
      {invite !== null && (
        <div className="mt-3" data-invite-link><CopyField value={invite.url} what="the invite link" /></div>
      )}
      {invite !== null && (
        <p className="t-meta mt-2 p-text-3">
          {invite.reset ? "Reset link" : "Invite"} for {invite.email}, until {new Date(invite.expiresAt).toLocaleString()}.
        </p>
      )}
      <Accounts busy={busy} onReset={(address) => create(true, address)} />
      {step.error !== null && <Notice tone="danger" className="mt-2">{step.error}</Notice>}
    </Card>
  );
}

function Accounts({ busy, onReset }: { busy: boolean; onReset: (email: string) => void }) {
  const accounts = useAsyncResource(listBuiltinAccounts);

  return (
    <CardSlot resource={accounts.resource} what="this deployment's accounts" onRetry={accounts.reload}>
      {({ accounts: list }) => (
        <Field label="Accounts" hint="A reset link replaces that account's password and passkeys, once, within 7 days, and signs it out everywhere.">
          <Group list>
            {list.map((account) => (
              <li key={account.email} className="flex items-center gap-3 px-3 py-2" data-account={account.email}>
                <span className="t-body min-w-0 flex-1 truncate p-text">{account.email}</span>
                <span className="t-meta p-text-3">{account.role === "owner" ? "Owner" : "Member"}</span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onReset(account.email)}
                  aria-label={`Create a reset link for ${account.email}`}>Reset link</Button>
              </li>
            ))}
          </Group>
        </Field>
      )}
    </CardSlot>
  );
}
