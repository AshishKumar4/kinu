import { Effect } from "effect";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { detach, showing } from "@kinu.run/core/obs";
import { FilledButton } from "./FilledButton";
import { Modal } from "./Modal";

/** Closes on success; a failure stays open with its reason. */
export function ConfirmDialog({ title, icon, children, action, failed, onConfirm, onClose, marker, maxWidthClass, danger = true }: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  action: string;
  failed?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  marker?: `data-${string}`;
  maxWidthClass?: string;
  /** False for a step that loses nothing, such as signing in again. */
  danger?: boolean;
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
        <FilledButton danger={danger} {...(marker === undefined ? {} : { [marker]: "" })} onClick={confirm} disabled={busy}>
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

/** What a confirmation asks, and the step it runs once confirmed. */
export interface Confirmation {
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly failed?: string;
  readonly danger?: boolean;
  readonly run: () => Promise<void>;
}

/** The app's one way to ask before a step: `ask` opens the dialog, which the asking component renders as `dialog`. */
export function useConfirmation() {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const close = useCallback(() => setPending(null), []);

  const dialog = pending === null ? null : (
    <ConfirmDialog title={pending.title} action={pending.action} failed={pending.failed} danger={pending.danger}
      onConfirm={pending.run} onClose={close}>
      <p className="text-xs p-text-2 leading-relaxed">{pending.body}</p>
    </ConfirmDialog>
  );

  return { ask: setPending, dialog };
}
