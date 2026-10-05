import { Effect } from "effect";
import { useCallback, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { detach, showing } from "@kinu.run/core/obs";
import { FilledButton } from "./ui/FilledButton";
import { Modal } from "./ui/Modal";

export function DeleteChatDialog({ title, onDelete, onClose }: { title: string; onDelete: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(() => detach(Effect.gen(function* () {
    setBusy(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(onDelete);
      onClose();
    }), showing(setError)), Effect.sync(() => setBusy(false)));
  })), [onDelete, onClose]);

  return (
    <Modal
      title={`Delete ${title}?`}
      icon={<TrashIcon size={18} className="p-danger" />}
      onClose={onClose}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton danger onClick={confirm} disabled={busy}>{busy ? "Deleting…" : "Delete"}</FilledButton>
      </>}
    >
      <p className="text-xs p-text-2 leading-relaxed">
        Its conversation is deleted. This cannot be undone.
      </p>
      {error && <div role="alert" className="p-notice-danger text-xs rounded-md px-3 py-2">Could not delete: {error}</div>}
    </Modal>
  );
}
