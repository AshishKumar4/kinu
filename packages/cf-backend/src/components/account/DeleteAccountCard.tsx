/** The confirm field applies `confirmsAccountDelete`, the same rule as the route. No rate limit by design; the typed phrase is the gate. */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { WarningIcon } from "@phosphor-icons/react";
import { confirmsAccountDelete } from "@kinu.run/core";
import { deleteAccount } from "@/lib/user-api";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { TextInput, Field, composing } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { useLabelledStep } from "@/hooks/use-labelled-step";

export function DeleteAccountCard({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const step = useLabelledStep();
  const busy = step.busy !== null;

  const confirmed = confirmsAccountDelete(confirm, email);

  // /logout clears the cookie; the next sign-in builds a fresh object.
  const run = (): void => step.run("delete", async () => {
    await deleteAccount(confirm);
    window.location.assign('/logout?return_to=/');
  });

  const close = () => {
    if (busy) return;
    setOpen(false);
    setConfirm('');
    step.clear();
  };

  return (
    <Card title="Delete this account">
      <Field inline label="Start over">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Delete account…</Button>
      </Field>
      {open && (
        <Modal title="Delete this account" onClose={close} busy={busy}
          icon={<WarningIcon size={16} className="p-danger" />}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={close} disabled={busy}>Cancel</Button>
              <Button variant="destructive" size="sm" disabled={!confirmed} busy={busy} onClick={run}>
                Delete everything
              </Button>
            </>
          }
        >
          <Field label="Type your email to confirm">
            <TextInput autoFocus autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !composing(e.nativeEvent) && confirmed) run(); }} aria-label="Confirm your email" />
          </Field>
          {step.error !== null && <Notice tone="danger">{step.error}</Notice>}
        </Modal>
      )}
    </Card>
  );
}
