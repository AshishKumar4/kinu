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
import WorkspacePage from "./WorkspacePage";

/** Home: the owner's Personal assistant's chat once they have one; until then, a new workspace's mission, which is also
 *  its own page (`NewWorkspacePage`). A read that fails shows the mission too, so Home never waits on it. */
export default function HomePage() {
  const assistant = useInstalledAssistant();

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
      <main className="mx-auto grid min-h-full w-full max-w-[1080px] grid-cols-1 content-start gap-6 px-6 py-[clamp(72px,12vh,132px)] md:content-center md:px-10 lg:grid-cols-[minmax(0,680px)_300px]">
        <header className="col-span-full mb-3">
          <h1 className="p-display text-[clamp(38px,4vw,46px)] font-semibold leading-[1.12] p-text">
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
            <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
              <span className="p-eyebrow">Recent</span>
              {listFailed && <span className="p-t-status p-warning">could not load</span>}
            </div>
            <div className="overflow-hidden rounded-[14px] border p-border p-surface">
              {workspaces.slice(0, RECENT_WORKSPACES).map((agent, index) => (
                <WorkspaceOverviewCard key={agent.name} workspace={agent} variant="line" first={index === 0} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
