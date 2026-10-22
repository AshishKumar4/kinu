import { Effect } from "effect";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { detach, showing } from "@kinu.run/core/obs";
import { Modal } from "./Modal";

/** A second way to go ahead, offered beside the main one; the main one stays the default. */
interface AlternateStep {
  readonly action: string;
  readonly run: () => Promise<void>;
}

/** What `useLabelledStep` gives a control: the step running, the last failure, and the way to run one. */
export interface LabelledStep {
  readonly busy: string | null;
  readonly error: string | null;
  readonly run: (label: string, step: () => Promise<void>) => void;
}

/**
 * One labelled step at a time: `busy` names the step running, so only its control says so; a failure is kept, in
 * words, until the next step; `done` runs after a step that succeeded.
 */
export function useLabelledStep(done: () => void): LabelledStep {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback((label: string, step: () => Promise<void>) => detach(Effect.gen(function* () {
    setBusy(label);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(step);
      done();
    }), showing(setError)), Effect.sync(() => setBusy(null)));
  })), [done]);

  return { busy, error, run };
}

/** Closes on success; a failure stays open with its reason. */
export function ConfirmDialog({ title, icon, children, action, failed, onConfirm, onClose, marker, maxWidthClass, danger = true, alternate }: {
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
  alternate?: AlternateStep;
}) {
  /** The action running, so only its button says so. */
  const { busy, error, run: confirm } = useLabelledStep(onClose);

  return (
    <Modal title={title} icon={icon} onClose={onClose} busy={busy !== null} maxWidthClass={maxWidthClass}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy !== null}>Cancel</Button>
        {alternate !== undefined && (
          <Button size="sm" variant="secondary" onClick={() => confirm(alternate.action, alternate.run)} disabled={busy !== null}>
            {busy === alternate.action ? `${alternate.action}…` : alternate.action}
          </Button>
        )}
        <Button variant={danger ? "destructive" : "primary"} size="md" {...(marker === undefined ? {} : { [marker]: "" })} onClick={() => confirm(action, onConfirm)} disabled={busy !== null}>
          {busy === action ? `${action}…` : action}
        </Button>
      </>}>
      {children}
      {error !== null && (
        <div role="alert" className="t-meta p-notice-danger rounded-[var(--r-control)] px-3 py-2">{failed === undefined ? error : `${failed}: ${error}`}</div>
      )}
    </Modal>
  );
}

/** What a confirmation asks, and the step it runs once confirmed. */
interface Confirmation {
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly failed?: string;
  readonly danger?: boolean;
  readonly run: () => Promise<void>;
  readonly alternate?: AlternateStep;
}

/** The app's one way to ask before a step: `ask` opens the dialog, which the asking component renders as `dialog`. */
export function useConfirmation() {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const close = useCallback(() => setPending(null), []);

  const dialog = pending === null ? null : (
    <ConfirmDialog title={pending.title} action={pending.action} failed={pending.failed} danger={pending.danger}
      onConfirm={pending.run} onClose={close} alternate={pending.alternate}>
      <p className="t-meta p-text-2">{pending.body}</p>
    </ConfirmDialog>
  );

  return { ask: setPending, dialog };
}
