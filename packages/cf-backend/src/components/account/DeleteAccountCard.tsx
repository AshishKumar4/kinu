/**
 * The one action that cannot be undone, in a card of its own at the foot of
 * the Account section — below the profile it erases, never inside it.
 *
 * Two steps, both local: a quiet button opens the modal, and the modal asks
 * for the account's own email before its danger button wakes up. The rule the
 * field applies is `confirmsAccountDelete`, the same one the route applies, so
 * a phrase the field accepts is a phrase the server accepts. There is no rate
 * limit behind it by design; the typed phrase is the gate.
 */
import { startTransition, useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { confirmsAccountDelete } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { deleteAccount } from "@/lib/user-api";
import { Card, Field, inputCls } from "@/components/ui/form";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";

export function DeleteAccountCard({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = confirmsAccountDelete(confirm, email);

  const run = async () => {
    setBusy(true);
    setError(null);

    try {
      await deleteAccount(confirm);
      // The object is gone and with it every session row; /logout clears the
      // cookie and lands on the signed-out door. The next sign-in builds a
      // fresh object and lands on onboarding.
      window.location.assign('/logout?return_to=/');
    } catch (cause) {
      setError(renderThrownChain({ cause }));
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    setConfirm('');
    setError(null);
  };

  return (
    <Card title="Delete this account" icon={WarningIcon}
      description="Every workspace, connection, device link and credential goes. The next time you sign in, this account starts from the beginning.">
      <Field inline label="Start over" hint="Deleting asks for your email first.">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Delete account…</Button>
      </Field>
      {open && (
        <Modal title="Delete this account" onClose={close} busy={busy}
          icon={<WarningIcon size={16} className="p-danger" />}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={close} disabled={busy}>Cancel</Button>
              <FilledButton danger disabled={!confirmed || busy} onClick={run}>
                {busy ? <Loader size="sm" /> : null} Delete everything
              </FilledButton>
            </>
          }
        >
          <p className="p-row-text p-text-3">
            This deletes <span className="font-medium p-text">{email}</span> and everything it owns:
            workspaces, credentials, devices, MCP servers and the agents on them. It cannot be undone.
          </p>
          <Field label="Type your email to confirm" hint={email}>
            <input
              autoFocus
              autoComplete="off"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && confirmed && !busy) startTransition(run); }}
              className={inputCls}
              aria-label="Confirm your email"
            />
          </Field>
          {error && <p className="text-xs p-danger">{error}</p>}
        </Modal>
      )}
    </Card>
  );
}
