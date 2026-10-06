import { Effect } from "effect";
import { useCallback, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { workspaceDisplayTitle } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { removeWorkspace } from "@/lib/user-api";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { FilledButton } from "./ui/FilledButton";
import { Modal } from "./ui/Modal";

/** Leaves the workspace first: a mounted socket would reconnect, and `idFromName` resurrects an empty one. */
export function RemoveWorkspaceDialog({ workspace, onClose }: { workspace: { name: string; displayName: string }; onClose: () => void }) {
  const navigate = useNavigate();
  const inPage = useMatch({ path: `/workspace/${workspace.name}`, end: false }) !== null;
  const inSwarm = useMatch({ path: `/swarm/${workspace.name}`, end: false }) !== null;
  const inside = inPage || inSwarm;
  const { remove } = useWorkspaceRoster();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(() => detach(Effect.gen(function* () {
    setBusy(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      if (inside) yield* Effect.promise(async () => navigate("/"));
      yield* Effect.promise(async () => removeWorkspace(workspace.name));
      remove(workspace.name);
      onClose();
    }), showing(setError)), Effect.sync(() => setBusy(false)));
  })), [inside, navigate, remove, workspace.name, onClose]);

  return (
    <Modal
      title="Remove workspace"
      icon={<TrashIcon size={18} className="p-danger" />}
      onClose={onClose}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton danger onClick={confirm} disabled={busy}>{busy ? "Removing…" : "Remove"}</FilledButton>
      </>}
    >
      <p className="text-xs p-text-2 leading-relaxed">
        Remove <span className="font-medium p-text">{workspaceDisplayTitle(workspace)}</span> and delete
        everything in it? This cannot be undone.
      </p>
      {error && <div className="p-notice-danger text-xs rounded-md px-3 py-2">Could not remove: {error}</div>}
    </Modal>
  );
}
