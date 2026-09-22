/** Admission never runs the source; the forker binds each requirement on the unmapped-bindings panel. */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { GitBranchIcon } from "@phosphor-icons/react";
import { renderThrownChain } from "@kinu.run/core/obs";
import { workspaceDisplayTitle } from "@kinu.run/core";
import { Modal } from "@/components/ui/Modal";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import { listWorkspaces, type WorkspaceEntry } from "@/lib/user-api";
import { createWorkspaceFromMission } from "@/lib/create-workspace";
import { forkBlueprint, forkLiveShare } from "@/lib/shared-api";

const NEW_WORKSPACE = "\u0000new";

function forkedSlatePath(workspace: string, slate: string): string {
  return `/workspace/${encodeURIComponent(workspace)}?slate=${encodeURIComponent(slate)}&unmapped=1`;
}

export function ForkDialog({ blueprint, live, title, onClose, workspaces }: {
  /** A blueprint id, OR a live share's `{ share, workspace }` — never both. */
  blueprint?: string;
  live?: { share: string; workspace: string };
  title: string;
  onClose: () => void;
  /** A fixture roster; absent, the dialog reads the account's own. */
  workspaces?: readonly WorkspaceEntry[];
}) {
  const navigate = useNavigate();
  const [roster, setRoster] = useState<readonly WorkspaceEntry[] | null>(workspaces ?? null);
  const [target, setTarget] = useState<string>(workspaces?.[0]?.name ?? NEW_WORKSPACE);
  const [mission, setMission] = useState(title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (workspaces !== undefined) return;
    let mounted = true;
    const failed = (...rejection: [unknown]): void => { if (mounted) setErr(renderThrownChain({ cause: rejection[0] })); };

    listWorkspaces().then((list) => {
      if (!mounted) return;
      setRoster(list.entries);
      setTarget(list.entries[0]?.name ?? NEW_WORKSPACE);
    }).catch(failed);

    return () => { mounted = false; };
  }, [workspaces]);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);

    try {
      const workspace = target === NEW_WORKSPACE ? (await createWorkspaceFromMission(mission)).name : target;

      const fork = blueprint !== undefined
        ? await forkBlueprint({ blueprint, workspace })
        : await forkLiveShare({ live: live?.share ?? '', ownerWorkspace: live?.workspace ?? '', workspace });

      await navigate(forkedSlatePath(fork.workspace, fork.slate));
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
      setBusy(false);
    }
  }, [busy, target, mission, blueprint, live, navigate]);

  return (
    <Modal
      title="Fork into a workspace"
      icon={<GitBranchIcon size={18} className="p-accent" />}
      onClose={onClose}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton onClick={submit} disabled={busy || roster === null || (target === NEW_WORKSPACE && mission.trim() === "")}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Forking…</span></> : "Fork"}
        </FilledButton>
      </>}
    >
      <p className="text-xs p-text-2 leading-relaxed">
        <span className="font-medium p-text">{title}</span> lands as a new slate with every binding unmapped. Nothing runs until you connect each requirement and open it.
      </p>
      {roster === null && err === null && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {roster !== null && (
        <fieldset className="space-y-1" aria-label="Target workspace">
          {roster.map((entry) => (
            <label key={entry.name} className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm cursor-pointer ${target === entry.name ? "p-border p-elevated" : "border-transparent p-card-hover"}`}>
              <input type="radio" name="fork-target" value={entry.name} checked={target === entry.name} onChange={() => setTarget(entry.name)} disabled={busy} />
              <span className="min-w-0 flex-1 truncate p-text">{workspaceDisplayTitle(entry)}</span>
              <span className="p-meta p-text-4 font-mono">{entry.name}</span>
            </label>
          ))}
          <label className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm cursor-pointer ${target === NEW_WORKSPACE ? "p-border p-elevated" : "border-transparent p-card-hover"}`}>
            <input type="radio" name="fork-target" value={NEW_WORKSPACE} checked={target === NEW_WORKSPACE} onChange={() => setTarget(NEW_WORKSPACE)} disabled={busy} />
            <span className="p-text">New workspace</span>
          </label>
          {target === NEW_WORKSPACE && (
            <div className="space-y-1 pl-1 pt-1">
              <label className="p-meta p-text-3 block" htmlFor="fork-mission">What the new workspace is for</label>
              <input id="fork-mission" value={mission} onChange={(event) => setMission(event.target.value)} className={inputCls} disabled={busy} />
            </div>
          )}
        </fieldset>
      )}
      {err && <div className="p-notice-danger text-xs rounded-md px-3 py-2">{err}</div>}
    </Modal>
  );
}
