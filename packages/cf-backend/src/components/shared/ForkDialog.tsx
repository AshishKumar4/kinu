/** Admission never runs the source; the fork lands on a panel naming what it calls on the forker's surface. */
import { Cause, Effect } from 'effect';
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { GitBranchIcon } from "@phosphor-icons/react";
import { workspaceDisplayTitle, type BlueprintFork, type WorkspaceEntry, workspaceRoute } from "@kinu.run/core";
import { Modal } from "@/components/ui/Modal";
import { TextInput } from "@/components/ui/Field";
import { Choices } from "@/components/ui/Choices";
import { listWorkspaces } from "@/lib/user-api";
import { forkBlueprint, forkLiveShare } from "@/lib/shared-api";
import { Notice } from "@/components/ui/Notice";
import { useLimitRefusal } from "@/components/limits/LimitRefusal";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { useLabelledStep } from "@/hooks/use-labelled-step";

const readRoster = async (): Promise<readonly WorkspaceEntry[]> => (await listWorkspaces()).entries;

/** The choice of a new workspace: a `+` is in no workspace's name. */
const NEW_WORKSPACE = "+new";

/** `reaches` is the fork's requirements, one namespace each, for its landing panel. */
function forkedSlatePath(fork: BlueprintFork): string {
  const reaches = fork.requirements.map((requirement) => requirement.name).join(",");

  return `${workspaceRoute(fork.workspace)}?slate=${encodeURIComponent(fork.slate)}&reaches=${encodeURIComponent(reaches)}`;
}

export function ForkDialog({ blueprint, live, title, onClose, create }: {
  /** A blueprint id, OR a live share's `{ share, workspace }` — never both. */
  blueprint?: string;
  live?: { share: string; workspace: string };
  title: string;
  onClose: () => void;
  /** Makes the new workspace a fork lands in: in the app's shell the roster's, so the sidebar lists it at once. */
  create: (mission: string) => Promise<WorkspaceEntry>;
}) {
  const navigate = useNavigate();
  const { resource, reload } = useAsyncResource(readRoster);
  const roster = resource.status === "ready" ? resource.value : null;
  // Unchosen, the first workspace the account lists.
  const [chosen, setTarget] = useState<string | null>(null);
  const target = chosen ?? roster?.[0]?.name ?? NEW_WORKSPACE;
  const [mission, setMission] = useState(title);
  const { busy, error, run } = useLabelledStep();
  const offerRefusal = useLimitRefusal();

  const submit = (): void => run("fork", () => Effect.catchCause(Effect.gen(function* () {
    const workspace = target === NEW_WORKSPACE ? (yield* Effect.promise(async () => create(mission))).name : target;

    const fork = blueprint !== undefined
      ? (yield* Effect.promise(async () => forkBlueprint({ blueprint, workspace })))
      : (yield* Effect.promise(async () => forkLiveShare({ live: live?.share ?? '', ownerWorkspace: live?.workspace ?? '', workspace })));

    yield* Effect.promise(async () => navigate(forkedSlatePath(fork)));
  }), (failed) => {
    // A limit's refusal closes this dialog for the limit's own, in the shell that offers it.
    if (offerRefusal({ cause: Cause.squash(failed) })) return Effect.sync(onClose);

    return Effect.failCause(failed);
  }));

  return (
    <Modal
      title="Fork into a workspace"
      icon={<GitBranchIcon size={18} className="p-accent-fg" />}
      onClose={onClose}
      busy={busy !== null}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy !== null}>Cancel</Button>
        <Button variant="primary" size="md" onClick={submit} busy={busy !== null} disabled={roster === null || (target === NEW_WORKSPACE && mission.trim() === "")}>
          {busy !== null ? "Forking…" : "Fork"}
        </Button>
      </>}
    >
      <p className="t-body">
        <span className="t-item">{title}</span> lands as a new slate that calls your own workspace, as you. Nothing runs until you open it.
      </p>
      {resource.status === "loading" && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {resource.status === "error" && <LoadFailure what="your workspaces" message={resource.message} onRetry={reload} />}
      {roster !== null && (
        <div className="space-y-3">
          <Choices label="Target workspace" marker="data-fork-target" value={target} disabled={busy !== null} onChange={setTarget}
            options={[
              ...roster.map((entry) => ({ id: entry.name, label: workspaceDisplayTitle(entry), detail: <span className="t-mono">{entry.name}</span> })),
              { id: NEW_WORKSPACE, label: "New workspace" },
            ]} />
          {target === NEW_WORKSPACE && (
            <div className="space-y-1">
              <label className="t-meta p-text-3 block" htmlFor="fork-mission">What the new workspace is for</label>
              <TextInput id="fork-mission" value={mission} onChange={(event) => setMission(event.target.value)} disabled={busy !== null} />
            </div>
          )}
        </div>
      )}
      {error !== null && <Notice tone="danger">{error}</Notice>}
    </Modal>
  );
}
