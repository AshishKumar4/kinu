import { useCallback } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { TrashIcon } from "@phosphor-icons/react";
import { workspaceDisplayTitle } from "@kinu.run/core";
import { removeWorkspace } from "@/lib/user-api";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { ConfirmDialog } from "./ui/ConfirmDialog";

/** Leaves first: a mounted socket would reconnect and `idFromName` resurrect it empty. */
export function RemoveWorkspaceDialog({ workspace, onClose }: { workspace: { name: string; displayName: string }; onClose: () => void }) {
  const navigate = useNavigate();
  const inPage = useMatch({ path: `/workspace/${workspace.name}`, end: false }) !== null;
  const inSwarm = useMatch({ path: `/swarm/${workspace.name}`, end: false }) !== null;
  const inside = inPage || inSwarm;
  const { remove } = useWorkspaceRoster();

  const confirm = useCallback(async () => {
    if (inside) await navigate("/");
    await removeWorkspace(workspace.name);
    remove(workspace.name);
  }, [inside, navigate, remove, workspace.name]);

  return (
    <ConfirmDialog title="Remove workspace" icon={<TrashIcon size={18} className="p-danger" />} action="Remove"
      failed="Could not remove" onConfirm={confirm} onClose={onClose}>
      <p className="text-xs p-text-2 leading-relaxed">
        Remove <span className="font-medium p-text">{workspaceDisplayTitle(workspace)}</span> and delete
        everything in it? This cannot be undone.
      </p>
    </ConfirmDialog>
  );
}
