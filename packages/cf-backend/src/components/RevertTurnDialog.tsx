/** Only the conversation is always revertible; workspace and sandbox files have no snapshot store. File restore is offered only when the device checkpoint store answers. */
import { Cause, Effect } from 'effect';
import { startTransition, useCallback, useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import {
  deviceHistoryNote, summarizeRestorePlan, type FileCheckpointEntry, type FileCheckpointListing, type FileRestoreChange, type FileRestorePlan, type Rpc,
} from "@kinu.run/core";
import { renderThrownChain, showing, detach, settle } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";

interface DeviceRestorePlan {
  entries: FileCheckpointEntry[];
  dirs: string[];
  files: FileRestoreChange[];
}

function RevertTurnDialog({ messageId, rpc, onClose, onReverted, onRestorePlan }: {
  messageId: string;
  rpc: Rpc;
  onClose: () => void;
  onReverted: () => void;
  /** The plan is handed over, not applied: overwriting device files needs its own confirm. */
  onRestorePlan: (plan: DeviceRestorePlan) => void;
}) {
  const [checkpoints, setCheckpoints] = useState<readonly FileCheckpointEntry[]>([]);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [deviceFailure, setDeviceFailure] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;

    startTransition(() => settle(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      // Keyed on the turn in the store: retention is per directory but the limit is global, so a filtered window loses checkpoints.
      const listing = yield* Effect.promise(async () => rpc<FileCheckpointListing>("listFileCheckpoints", [200, messageId]));

      if (current) {
        setCheckpoints(listing.availability.available ? listing.entries : []);
        setHistoryNote(deviceHistoryNote(listing));
      }
    }), showing((chain) => {
      if (current) setDeviceFailure(chain);
    })), Effect.sync(() => {
      if (current) setChecked(true);
    }))));

    return () => { current = false; };
  }, [messageId, rpc]);

  const revert = useCallback((): Promise<string | null> => settle(Effect.gen(function* () {
    setBusy(true);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => rpc("revertConversation", [messageId]));
      onReverted();

      return null;
    }), (failed) => Effect.sync(() => renderThrownChain({ cause: Cause.squash(failed) }))), Effect.sync(() => {
      setBusy(false);
    }));
  })), [messageId, rpc, onReverted]);

  const revertConversation = useCallback(async () => {
    const reverted = await revert();
    setFailure(reverted);

    if (reverted === null) onClose();
  }, [revert, onClose]);

  const revertWithFiles = useCallback(() => detach(Effect.gen(function* () {
    const reverted = yield* Effect.promise(async () => revert());
    setFailure(reverted);

    if (reverted !== null) return;
    setBusy(true);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const plans: FileRestorePlan[] = [];

      for (const entry of checkpoints) plans.push(yield* Effect.promise(async () => rpc<FileRestorePlan>("planFileRestore", [entry.dir, entry.id])));
      onRestorePlan({ entries: [...checkpoints], dirs: plans.map((plan) => plan.dir), files: plans.flatMap((plan) => plan.files) });
      onClose();
    }), showing((chain) => {
      // The conversation is already reverted: stay open reporting the file outcome.
      setFailure(chain);
    })), Effect.sync(() => {
      setBusy(false);
    }));
  })), [revert, checkpoints, rpc, onRestorePlan, onClose]);

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
        <FilledButton onClick={(...args: Parameters<typeof revertConversation>) => detach(Effect.promise(async () => revertConversation(...args)))} disabled={busy} data-revert-action="conversation">
          Revert conversation
        </FilledButton>
      </>}
    >
      <div className="space-y-2" data-revert-dialog={checked ? "ready" : "checking"}>
        <p className="text-xs p-text-2 leading-relaxed">
          The messages from here on are removed from the conversation. Files in the workspace, its computer
          and your devices stay as they are.
        </p>
        {historyNote && <p data-device-history className="text-xs p-text-3 leading-relaxed">{historyNote}</p>}
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

/**
 * Reverting a turn: the dialog while `messageId` is set, then, when the device holds files from before the turn, their
 * restore under a confirm of its own, after a safety snapshot. What the restore did is said through `onNotice`.
 */
export function TurnRevert({ messageId, rpc, onClose, onReverted, onNotice }: {
  messageId: string | null;
  rpc: Rpc;
  onClose: () => void;
  onReverted: () => void;
  onNotice: (notice: string) => void;
}) {
  const [plan, setPlan] = useState<DeviceRestorePlan | null>(null);
  const [restoring, setRestoring] = useState(false);

  const restore = useCallback(() => detach(Effect.gen(function* () {
    if (!plan) return;
    setRestoring(true);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      for (const entry of plan.entries) {
        yield* Effect.promise(async () => rpc('restoreFileCheckpoint', [entry.dir, entry.id]));
      }

      onNotice(`Restored ${String(plan.files.length)} ${plan.files.length === 1 ? "file" : "files"}. Run restore again to undo it.`);
      setPlan(null);
    }), showing((chain) => {
      onNotice(`Restore failed: ${chain}`);
      setPlan(null);
    })), Effect.sync(() => {
      setRestoring(false);
    }));
  })), [plan, rpc, onNotice]);

  return (
    <>
      {messageId !== null && <RevertTurnDialog messageId={messageId} rpc={rpc} onClose={onClose} onReverted={onReverted} onRestorePlan={setPlan} />}
      {plan && <RestoreFilesModal plan={plan} busy={restoring} onCancel={() => setPlan(null)} onConfirm={restore} />}
    </>
  );
}

const RESTORE_PREVIEW_LIMIT = 12;

const RESTORE_MARK = {
  modify: { mark: "~", tone: "p-warning" },
  create: { mark: "+", tone: "p-success" },
  delete: { mark: "-", tone: "p-danger" },
} satisfies Record<FileRestoreChange["kind"], { mark: string; tone: string }>;

function RestoreFilesModal({ plan, busy, onCancel, onConfirm }: {
  plan: DeviceRestorePlan; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const { modified, created, deleted } = summarizeRestorePlan(plan.files);

  const counts = [
    modified ? `${modified} modified` : null,
    created ? `${created} recreated` : null,
    deleted ? `${deleted} removed` : null,
  ].filter(Boolean).join(", ");

  const shown = plan.files.slice(0, RESTORE_PREVIEW_LIMIT);

  return (
    <Modal
      title="Restore device files to before this turn"
      icon={<ClockCounterClockwiseIcon size={18} className="p-warning" />}
      onClose={onCancel}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <FilledButton onClick={onConfirm} disabled={busy}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Restoring…</span></> : `Restore ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}`}
        </FilledButton>
      </>}
    >
      <div className="space-y-2">
        <p className="text-xs p-text-2 leading-relaxed">
          This changes files under <span className="font-mono p-text">{plan.dirs.join(", ")}</span> on your
          device: {counts}. Kinu creates a safety snapshot first. Restore again to undo this change.
        </p>
        <ul className="rounded-md border p-border p-elevated max-h-52 overflow-y-auto p-annotation">
          {shown.map((f) => {
            const { mark, tone } = RESTORE_MARK[f.kind];

            return (
              <li key={`${f.kind}:${f.path}`} className="flex gap-2 px-2.5 py-1 border-b p-border last:border-0">
                <span className={`shrink-0 ${tone}`}>{mark}</span>
                <span className="p-text-2 truncate" title={f.path}>{f.path}</span>
              </li>
            );
          })}
          {plan.files.length > shown.length && (
            <li className="px-2.5 py-1 p-text-3">… {plan.files.length - shown.length} more</li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
