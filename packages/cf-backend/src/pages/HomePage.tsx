import { useState, useTransition } from "react";
import { SetupCard } from "@/components/account/SetupCard";
import {
  MISSION_LABEL,
  MISSION_PLACEHOLDER,
  useCreateWorkspace,
} from "@/hooks/use-create-workspace";
import { RECENT_WORKSPACES, useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { WorkspaceOverviewCard } from "@/components/workspaces/WorkspaceOverviewCard";
import { PromptCard } from "@/components/workspaces/PromptCard";
import { usePastedSecretGuard } from "@/components/secrets/PasteOffer";
import { WORKSPACE_MISSION_ID } from "@/components/workspaces/NewWorkspaceButton";
import { usePendingAttachments } from "@/hooks/use-pending-attachments";
import { CLOUD_MAX_INLINE_ATTACHMENT_BYTES } from "@kinu.run/core";
import { useInstalledAssistant } from "@/hooks/use-installed-assistant";
import { useSetupFinish } from "@/lib/setup-finish";
import { Loader } from "@/components/ui/Loader";
import WorkspacePage from "./WorkspacePage";
import { Surface } from "@/components/ui/Surface";

/** Home: the owner's Personal assistant's chat once they have one; until then, a new workspace's mission, which is also
 *  its own page (`NewWorkspacePage`). A read that fails shows the mission too, so Home never waits on it. */
export default function HomePage() {
  const assistant = useInstalledAssistant();
  const arriving = useSetupFinish()?.assistant;

  // Setup just finished, its assistant still being made: Home says so, then opens its chat.
  if (arriving?.state === "installing") {
    return (
      <div className="flex h-full items-center justify-center px-6" data-assistant-arriving>
        <p className="t-body flex items-center gap-2 p-text-2"><Loader size="sm" /> Setting up {arriving.name}, your assistant…</p>
      </div>
    );
  }

  if (assistant.status === "loading") return null;

  // The assistant installs in `focus`: drawn so from the first frame, not after the workspace's status arrives.
  if (assistant.status === "ready" && assistant.value !== null) return <WorkspacePage workspace={assistant.value} layout="focus" />;

  return <MissionHome />;
}

/** A new workspace's mission, where every New workspace goes. */
export function NewWorkspacePage() {
  return <MissionHome />;
}

function MissionHome() {
  const [mission, setMission] = useState("");
  const { entries: workspaces, error: rosterError } = useWorkspaceRoster();
  const listFailed = rosterError !== null;
  const { busy, err, create } = useCreateWorkspace();
  const files = usePendingAttachments(CLOUD_MAX_INLINE_ATTACHMENT_BYTES);
  const [isPending, startTransition] = useTransition();
  const creating = busy || isPending;

  const submit = (): void => {
    startTransition(async () => {
      await create(mission, undefined, files.parts);
    });
  };

  // A new workspace's mission is its first message: a pasted secret is offered to Secrets before it is sent.
  const secretGuard = usePastedSecretGuard({ draft: mission, setDraft: setMission, workspace: undefined });

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto grid min-h-full w-full max-w-[var(--layout-home-frame)] grid-cols-1 content-start gap-6 px-6 py-[var(--layout-home-pad)] md:content-center md:px-8 lg:grid-cols-[var(--layout-home)]">
        <header className="col-span-full mb-3">
          <h1 className="t-page-title t-hero p-text">
            What do you wanna work on?
          </h1>
        </header>

        <PromptCard
          id={WORKSPACE_MISSION_ID}
          label={MISSION_LABEL}
          placeholder={MISSION_PLACEHOLDER}
          action="Create workspace"
          value={mission}
          onChange={setMission}
          onSubmit={secretGuard.guarded("create", submit)}
          notice={secretGuard.offer}
          busy={creating}
          error={err ?? files.refusal}
          attachments={{ parts: files.parts, onAdd: files.add, onRemove: files.remove }}
        />

        <aside className="order-3 min-w-0 lg:order-none">
          <SetupCard />
        </aside>

        {(listFailed || workspaces.length > 0) && (
          <section aria-label="Recent workspaces" className="order-2 min-w-0 lg:order-none">
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <span className="t-label">Recent</span>
              {listFailed && <span className="t-status p-warning">could not load</span>}
            </div>
            <Surface look="panel" className="overflow-hidden">
              {workspaces.slice(0, RECENT_WORKSPACES).map((agent, index) => (
                <WorkspaceOverviewCard key={agent.name} workspace={agent} variant="line" first={index === 0} />
              ))}
            </Surface>
          </section>
        )}
      </main>
    </div>
  );
}
