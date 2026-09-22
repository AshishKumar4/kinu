/**
 * The walk-back, as the operator decides it.
 *
 * ONE action reaches this dialog — "revert to before this turn" — and the
 * dialog's job is to say what that action takes with it. The conversation is
 * always revertible: the durable head moves and the messages from the picked
 * one on leave the head's ancestry. Nothing else is. Workspace files and
 * sandbox files have no snapshot store at all, so a revert cannot touch them
 * and this must not imply otherwise.
 *
 * The second button exists only when the device checkpoint store ANSWERED that
 * it holds a checkpoint for this turn. That is the one thing a revert can
 * really restore, and the store is reachable only while a device is connected —
 * which is why an unreachable store is silence here rather than a notice. The
 * shipped behaviour before this was the reverse: every press of the affordance
 * on a workspace with no device reported `File history is unavailable`, so the
 * one revert the product could always perform looked impossible.
 */
import { startTransition, useCallback, useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import type { FileCheckpointEntry, FileCheckpointListing, FileRestoreChange, FileRestorePlan, Rpc } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";

/** The restore this turn's device checkpoints describe, once the operator has
 *  asked for the files too: what the page's own restore confirm renders. */
export interface DeviceRestorePlan {
  entries: FileCheckpointEntry[];
  dirs: string[];
  files: FileRestoreChange[];
}

export function RevertTurnDialog({ messageId, rpc, onClose, onReverted, onRestorePlan }: {
  /** The user message the walk-back returns to, or null for no open dialog. */
  messageId: string | null;
  rpc: Rpc;
  onClose: () => void;
  /** The conversation moved: the transcript arrives over the socket, and a
   *  surface paging older entries drops what it walked. */
  onReverted: () => void;
  /** The conversation moved AND the operator asked for the device files. The
   *  plan is handed over rather than applied here — overwriting files on a
   *  real machine is its own confirm, with the paths on it. */
  onRestorePlan: (plan: DeviceRestorePlan) => void;
}) {
  const [checkpoints, setCheckpoints] = useState<readonly FileCheckpointEntry[]>([]);
  const [checked, setChecked] = useState(false);
  const [deviceFailure, setDeviceFailure] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (messageId === null) return;
    setCheckpoints([]);
    setChecked(false);
    setDeviceFailure(null);
    setFailure(null);
    let current = true;

    startTransition(async () => {
      try {
        // Keyed on the turn IN THE STORE: retention is per working directory
        // while the limit is global across them, so a window read and filtered
        // here loses a still-restorable checkpoint once the operator has a few
        // active directories.
        const listing = await rpc<FileCheckpointListing>("listFileCheckpoints", [200, messageId]);

        if (current) setCheckpoints(listing.availability.available ? listing.entries : []);
      } catch (cause) {
        // The store is reachable or it is not, and a call that failed answers
        // neither. Said on the option it governs — the conversation revert
        // does not depend on it.
        if (current) setDeviceFailure(renderThrownChain({ cause }));
      } finally {
        if (current) setChecked(true);
      }
    });

    return () => { current = false; };
  }, [messageId, rpc]);

  const revert = useCallback(async (): Promise<boolean> => {
    if (messageId === null) return false;
    setFailure(null);
    setBusy(true);

    try {
      await rpc("revertConversation", [messageId]);
      onReverted();

      return true;
    } catch (cause) {
      setFailure(renderThrownChain({ cause }));

      return false;
    } finally {
      setBusy(false);
    }
  }, [messageId, rpc, onReverted]);

  const revertConversation = useCallback(async () => {
    if (await revert()) onClose();
  }, [revert, onClose]);

  const revertWithFiles = useCallback(async () => {
    if (!await revert()) return;
    setBusy(true);

    try {
      const plans: FileRestorePlan[] = [];

      for (const entry of checkpoints) plans.push(await rpc<FileRestorePlan>("planFileRestore", [entry.dir, entry.id]));
      onRestorePlan({ entries: [...checkpoints], dirs: plans.map((plan) => plan.dir), files: plans.flatMap((plan) => plan.files) });
      onClose();
    } catch (cause) {
      // The conversation is already back: the dialog stays open saying what
      // the files did, rather than closing on a half-done action.
      setFailure(renderThrownChain({ cause }));
    } finally {
      setBusy(false);
    }
  }, [revert, checkpoints, rpc, onRestorePlan, onClose]);

  if (messageId === null) return null;

  return (
    <Modal
      title="Revert the conversation to before this message?"
      icon={<ClockCounterClockwiseIcon size={18} className="p-warning" />}
      onClose={onClose}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        {checkpoints.length > 0 && (
          <Button size="sm" variant="secondary" onClick={revertWithFiles} disabled={busy}
            data-revert-action="conversation-and-device-files">
            Revert conversation and device files
          </Button>
        )}
        <FilledButton onClick={revertConversation} disabled={busy} data-revert-action="conversation">
          Revert conversation
        </FilledButton>
      </>}
    >
      <div className="space-y-2" data-revert-dialog={checked ? "ready" : "checking"}>
        <p className="text-xs p-text-2 leading-relaxed">
          The messages from here on are removed from the conversation. Files in the workspace, sandbox
          and your devices stay as they are.
        </p>
        {deviceFailure && (
          <p className="text-xs p-warning leading-relaxed">
            Your devices' file history could not be read: {deviceFailure}
          </p>
        )}
        {failure && <p className="text-xs p-danger leading-relaxed">{failure}</p>}
      </div>
    </Modal>
  );
}
