import { Effect } from "effect";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { detach, showing } from "@kinu.run/core/obs";
import { FilledButton } from "./FilledButton";
import { Modal } from "./Modal";

/** Closes on success; a failure stays open with its reason. */
export function ConfirmDialog({ title, icon, children, action, failed, onConfirm, onClose, marker, maxWidthClass }: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  action: string;
  failed?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  marker?: `data-${string}`;
  maxWidthClass?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(() => detach(Effect.gen(function* () {
    setBusy(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(onConfirm);
      onClose();
    }), showing(setError)), Effect.sync(() => setBusy(false)));
  })), [onConfirm, onClose]);

  return (
    <Modal title={title} icon={icon} onClose={onClose} busy={busy} maxWidthClass={maxWidthClass}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton danger {...(marker === undefined ? {} : { [marker]: "" })} onClick={confirm} disabled={busy}>
          {busy ? `${action}…` : action}
        </FilledButton>
      </>}>
      {children}
      {error !== null && (
        <div role="alert" className="p-notice-danger text-xs rounded-md px-3 py-2">{failed === undefined ? error : `${failed}: ${error}`}</div>
      )}
    </Modal>
  );
}
