/** Only the conversation is always revertible; workspace and sandbox files have no snapshot store. File restore is offered only when the device checkpoint store answers. */
import { startTransition, useCallback, useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import type { FileCheckpointEntry, FileCheckpointListing, FileRestoreChange, FileRestorePlan, Rpc } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";

export interface DeviceRestorePlan {
  entries: FileCheckpointEntry[];
  dirs: string[];
  files: FileRestoreChange[];
}

export function RevertTurnDialog({ messageId, rpc, onClose, onReverted, onRestorePlan }: {
  messageId: string;
  rpc: Rpc;
  onClose: () => void;
  onReverted: () => void;
  /** The plan is handed over, not applied: overwriting device files needs its own confirm. */
  onRestorePlan: (plan: DeviceRestorePlan) => void;
}) {
  const [checkpoints, setCheckpoints] = useState<readonly FileCheckpointEntry[]>([]);
  const [checked, setChecked] = useState(false);
  const [deviceFailure, setDeviceFailure] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;

    startTransition(async () => {
      try {
        // Keyed on the turn in the store: retention is per directory but the limit is global, so a filtered window loses checkpoints.
        const listing = await rpc<FileCheckpointListing>("listFileCheckpoints", [200, messageId]);

        if (current) setCheckpoints(listing.availability.available ? listing.entries : []);
      } catch (cause) {
        if (current) setDeviceFailure(renderThrownChain({ cause }));
      } finally {
        if (current) setChecked(true);
      }
    });

    return () => { current = false; };
  }, [messageId, rpc]);

  const revert = useCallback(async (): Promise<string | null> => {
    setBusy(true);

    try {
      await rpc("revertConversation", [messageId]);
      onReverted();

      return null;
    } catch (cause) {
      return renderThrownChain({ cause });
    } finally {
      setBusy(false);
    }
  }, [messageId, rpc, onReverted]);

  const revertConversation = useCallback(async () => {
    const reverted = await revert();
    setFailure(reverted);

    if (reverted === null) onClose();
  }, [revert, onClose]);

  const revertWithFiles = useCallback(async () => {
    const reverted = await revert();
    setFailure(reverted);

    if (reverted !== null) return;
    setBusy(true);

    try {
      const plans: FileRestorePlan[] = [];

      for (const entry of checkpoints) plans.push(await rpc<FileRestorePlan>("planFileRestore", [entry.dir, entry.id]));
      onRestorePlan({ entries: [...checkpoints], dirs: plans.map((plan) => plan.dir), files: plans.flatMap((plan) => plan.files) });
      onClose();
    } catch (cause) {
      // The conversation is already reverted: stay open reporting the file outcome.
      setFailure(renderThrownChain({ cause }));
    } finally {
      setBusy(false);
    }
  }, [revert, checkpoints, rpc, onRestorePlan, onClose]);

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
