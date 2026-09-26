/** The confirm field applies `confirmsAccountDelete`, the same rule as the route. No rate limit by design; the typed phrase is the gate. */
import { startTransition, useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { confirmsAccountDelete } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { deleteAccount } from "@/lib/user-api";
import { Card, Field, composing, inputCls } from "@/components/ui/form";
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
      // /logout clears the cookie; the next sign-in builds a fresh object.
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
    <Card title="Delete this account" icon={WarningIcon}>
      <Field inline label="Start over">
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
          <Field label="Type your email to confirm">
            <input
              autoFocus
              autoComplete="off"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !composing(e.nativeEvent) && confirmed && !busy) startTransition(run); }}
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
