/** Only the conversation is always revertible; workspace and sandbox files have no snapshot store. File restore is offered only when the device checkpoint store answers. */
import { Effect } from 'effect';
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { deviceHistoryNote, summarizeRestorePlan, type FileCheckpointEntry, type FileRestoreChange, type FileRestorePlan, countOf } from "@kinu.run/core";
import { showing } from "@kinu.run/core/obs";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { useLabelledStep } from "@/hooks/use-labelled-step";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { Surface } from "@/components/ui/Surface";

interface DeviceRestorePlan {
  entries: FileCheckpointEntry[];
  dirs: string[];
  files: FileRestoreChange[];
}

function RevertTurnDialog({ messageId, rpc, onClose, onReverted, onRestorePlan }: {
  messageId: string;
  rpc: WorkspaceRpc;
  onClose: () => void;
  onReverted: () => void;
  /** The plan is handed over, not applied: overwriting device files needs its own confirm. */
  onRestorePlan: (plan: DeviceRestorePlan) => void;
}) {
  // Keyed on the turn in the store: retention is per directory but the limit is global, so a filtered window loses checkpoints.
  const load = useCallback(() => rpc("listFileCheckpoints", [200, messageId]), [rpc, messageId]);
  const { resource } = useAsyncResource(load);
  const listing = lastValue(resource);
  const checkpoints = listing?.availability.available === true ? listing.entries : [];
  const historyNote = listing === null ? null : deviceHistoryNote(listing);
  const deviceFailure = resource.status === "error" ? resource.message : null;
  const { busy, error, run } = useLabelledStep(onClose);

  // `chatOnly`: the computer keeps what the rewound turns did, and the agent is told of it (REWIND-0924).
  const revertConversation = (): void => run("conversation", () => Effect.gen(function* () {
    yield* Effect.promise(async () => rpc("revertConversation", [messageId, { chatOnly: true }]));
    onReverted();
  }));

  // A failure reading the plans keeps the dialog open on it: the conversation is already reverted.
  const revertWithFiles = (): void => run("files", () => Effect.gen(function* () {
    yield* Effect.promise(async () => rpc("revertConversation", [messageId, { chatOnly: false }]));
    onReverted();
    const plans: FileRestorePlan[] = [];

    for (const entry of checkpoints) plans.push(yield* Effect.promise(async () => rpc("planFileRestore", [entry.dir, entry.id])));
    onRestorePlan({ entries: [...checkpoints], dirs: plans.map((plan) => plan.dir), files: plans.flatMap((plan) => plan.files) });
  }));

  return (
    <Modal
      title="Revert the conversation to before this message?"
      icon={<ClockCounterClockwiseIcon size={18} className="p-warning" />}
      onClose={onClose}
      busy={busy !== null}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy !== null}>Cancel</Button>
        {checkpoints.length > 0 && (
          <Button size="sm" variant="secondary" onClick={revertWithFiles} disabled={busy !== null} busy={busy === "files"}
            data-revert-action="conversation-and-device-files">
            Revert conversation and device files
          </Button>
        )}
        <Button variant="primary" size="md" onClick={revertConversation} disabled={busy !== null} busy={busy === "conversation"} data-revert-action="conversation">
          Revert conversation
        </Button>
      </>}
    >
      <div className="space-y-2" data-revert-dialog={resource.status === "loading" ? "checking" : "ready"}>
        <p className="t-meta p-text-2">
          The messages from here on are removed from the conversation. Files in the workspace, its computer
          and your devices stay as they are.
        </p>
        {historyNote && <p data-device-history className="t-meta p-text-3">{historyNote}</p>}
        {deviceFailure && (
          <p className="t-meta p-warning">
            Your devices' file history could not be read: {deviceFailure}
          </p>
        )}
        {error !== null && <Notice tone="danger">{error}</Notice>}
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
  rpc: WorkspaceRpc;
  onClose: () => void;
  onReverted: () => void;
  onNotice: (notice: string) => void;
}) {
  const [plan, setPlan] = useState<DeviceRestorePlan | null>(null);
  const { busy, run } = useLabelledStep();

  // Said either way through `onNotice`, so the step itself keeps no failure.
  const restore = (): void => run("restore", () => Effect.catchCause(Effect.gen(function* () {
    if (!plan) return;

    for (const entry of plan.entries) yield* Effect.promise(async () => rpc("restoreFileCheckpoint", [entry.dir, entry.id]));
    onNotice(`Restored ${countOf(plan.files.length, "file")}. Run restore again to undo it.`);
    setPlan(null);
  }), showing((chain) => {
    onNotice(`Restore failed: ${chain}`);
    setPlan(null);
  })));

  return (
    <>
      {messageId !== null && <RevertTurnDialog messageId={messageId} rpc={rpc} onClose={onClose} onReverted={onReverted} onRestorePlan={setPlan} />}
      {plan && <RestoreFilesModal plan={plan} busy={busy !== null} onCancel={() => setPlan(null)} onConfirm={restore} />}
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
        <Button variant="primary" size="md" onClick={onConfirm} busy={busy}>
          {busy ? "Restoring…" : `Restore ${countOf(plan.files.length, "file")}`}
        </Button>
      </>}
    >
      <div className="space-y-2">
        <p className="t-meta p-text-2">
          This changes files under <span className="font-mono p-text">{plan.dirs.join(", ")}</span> on your
          device: {counts}. Kinu creates a safety snapshot first. Restore again to undo this change.
        </p>
        <Surface look="tile" as="ul" className="t-meta t-mono border p-border max-h-52 overflow-y-auto">
          {shown.map((f) => {
            const { mark, tone } = RESTORE_MARK[f.kind];

            return (
              <li key={`${f.kind}:${f.path}`} className="flex gap-2 px-2 py-1 border-b p-border last:border-0">
                <span className={`shrink-0 ${tone}`}>{mark}</span>
                <span className="p-text-2 truncate" title={f.path}>{f.path}</span>
              </li>
            );
          })}
          {plan.files.length > shown.length && (
            <li className="px-2 py-1 p-text-3">… {plan.files.length - shown.length} more</li>
          )}
        </Surface>
      </div>
    </Modal>
  );
}
