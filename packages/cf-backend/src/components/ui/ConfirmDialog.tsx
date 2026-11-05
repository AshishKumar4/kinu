import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { useLabelledStep } from "@/hooks/use-labelled-step";
import { Modal, type DialogWidth } from "./Modal";
import { Notice } from "./Notice";

/** A second way to go ahead, offered beside the main one; the main one stays the default. */
interface AlternateStep {
  readonly action: string;
  readonly run: () => Promise<void>;
}

/** Closes on success; a failure stays open with its reason. */
export function ConfirmDialog({ title, icon, children, action, failed, onConfirm, onClose, marker, width, danger = true, alternate }: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  action: string;
  failed?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  marker?: `data-${string}`;
  width?: DialogWidth;
  /** False for a step that loses nothing, such as signing in again. */
  danger?: boolean;
  alternate?: AlternateStep;
}) {
  /** The action running, so only its button says so. */
  const { busy, error, run: confirm } = useLabelledStep(onClose);

  return (
    <Modal title={title} icon={icon} onClose={onClose} busy={busy !== null} width={width}
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
        <Notice tone="danger">{failed === undefined ? error : `${failed}: ${error}`}</Notice>
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
