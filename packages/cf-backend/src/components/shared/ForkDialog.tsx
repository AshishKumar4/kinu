/** Admission never runs the source; the fork lands on a panel naming what it calls on the forker's surface. */
import { Cause, Effect } from 'effect';
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { GitBranchIcon } from "@phosphor-icons/react";
import { showing, detach } from "@kinu.run/core/obs";
import { workspaceDisplayTitle, type BlueprintFork, type WorkspaceEntry } from "@kinu.run/core";
import { Modal } from "@/components/ui/Modal";
import { TextInput } from "@/components/ui/Field";
import { Choices } from "@/components/ui/Choices";
import { listWorkspaces } from "@/lib/user-api";
import { forkBlueprint, forkLiveShare } from "@/lib/shared-api";
import { Notice } from "@/components/ui/Notice";
import { useLimitRefusal } from "@/components/limits/LimitRefusal";

/** The choice of a new workspace: a `+` is in no workspace's name. */
const NEW_WORKSPACE = "+new";

/** `reaches` is the fork's requirements, one namespace each, for its landing panel. */
function forkedSlatePath(fork: BlueprintFork): string {
  const reaches = fork.requirements.map((requirement) => requirement.name).join(",");

  return `/workspace/${encodeURIComponent(fork.workspace)}?slate=${encodeURIComponent(fork.slate)}&reaches=${encodeURIComponent(reaches)}`;
}

export function ForkDialog({ blueprint, live, title, onClose, workspaces, create }: {
  /** A blueprint id, OR a live share's `{ share, workspace }` — never both. */
  blueprint?: string;
  live?: { share: string; workspace: string };
  title: string;
  onClose: () => void;
  /** A fixture roster; absent, the dialog reads the account's own. */
  workspaces?: readonly WorkspaceEntry[];
  /** Makes the new workspace a fork lands in: in the app's shell the roster's, so the sidebar lists it at once. */
  create: (mission: string) => Promise<WorkspaceEntry>;
}) {
  const navigate = useNavigate();
  const [roster, setRoster] = useState<readonly WorkspaceEntry[] | null>(workspaces ?? null);
  const [target, setTarget] = useState<string>(workspaces?.[0]?.name ?? NEW_WORKSPACE);
  const [mission, setMission] = useState(title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const offerRefusal = useLimitRefusal();

  useEffect(() => {
    if (workspaces !== undefined) return;
    let mounted = true;
    detach(Effect.catchCause(Effect.map(Effect.promise(() => listWorkspaces()), (list) => {
      if (!mounted) return;
      setRoster(list.entries);
      setTarget(list.entries[0]?.name ?? NEW_WORKSPACE);
    }), showing((chain) => { if (mounted) setErr(chain); })));

    return () => { mounted = false; };
  }, [workspaces]);

  const submit = useCallback(() => detach(Effect.gen(function* () {
    if (busy) return;
    setBusy(true);
    setErr(null);

    return yield* Effect.catchCause(Effect.gen(function* () {
      const workspace = target === NEW_WORKSPACE ? (yield* Effect.promise(async () => create(mission))).name : target;

      const fork = blueprint !== undefined
        ? (yield* Effect.promise(async () => forkBlueprint({ blueprint, workspace })))
        : (yield* Effect.promise(async () => forkLiveShare({ live: live?.share ?? '', ownerWorkspace: live?.workspace ?? '', workspace })));

      yield* Effect.promise(async () => navigate(forkedSlatePath(fork)));
    }), (failed) => {
      // A limit's refusal closes this dialog for the limit's own, in the shell that offers it.
      if (offerRefusal({ cause: Cause.squash(failed) })) return Effect.sync(onClose);

      return showing((chain) => {
        setErr(chain);
        setBusy(false);
      })(failed);
    });
  })), [busy, target, mission, blueprint, live, navigate, create, offerRefusal, onClose]);

  return (
    <Modal
      title="Fork into a workspace"
      icon={<GitBranchIcon size={18} className="p-accent-fg" />}
      onClose={onClose}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="md" onClick={submit} disabled={busy || roster === null || (target === NEW_WORKSPACE && mission.trim() === "")}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Forking…</span></> : "Fork"}
        </Button>
      </>}
    >
      <p className="t-body">
        <span className="t-item">{title}</span> lands as a new slate that calls your own workspace, as you. Nothing runs until you open it.
      </p>
      {roster === null && err === null && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {roster !== null && (
        <div className="space-y-3">
          <Choices label="Target workspace" marker="data-fork-target" value={target} disabled={busy} onChange={setTarget}
            options={[
              ...roster.map((entry) => ({ id: entry.name, label: workspaceDisplayTitle(entry), detail: <span className="t-mono">{entry.name}</span> })),
              { id: NEW_WORKSPACE, label: "New workspace" },
            ]} />
          {target === NEW_WORKSPACE && (
            <div className="space-y-1">
              <label className="t-meta p-text-3 block" htmlFor="fork-mission">What the new workspace is for</label>
              <TextInput id="fork-mission" value={mission} onChange={(event) => setMission(event.target.value)} disabled={busy} />
            </div>
          )}
        </div>
      )}
      {err && <Notice tone="danger">{err}</Notice>}
    </Modal>
  );
}
