import { useState, useTransition } from "react";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import { SetupCard } from "@/components/account/SetupCard";
import {
  CONNECT_AI_MESSAGE,
  MISSION_LABEL,
  MISSION_PLACEHOLDER,
  useCreateWorkspace,
} from "@/hooks/use-create-workspace";
import { RECENT_WORKSPACES, useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { WorkspaceOverviewCard } from "@/components/workspaces/WorkspaceOverviewCard";
import { PromptCard } from "@/components/workspaces/PromptCard";

export default function HomePage() {
  const [mission, setMission] = useState("");
  const { entries: workspaces, error: rosterError } = useWorkspaceRoster();
  const listFailed = rosterError !== null;
  const { hasModels, busy, err, create } = useCreateWorkspace();
  const [isPending, startTransition] = useTransition();
  const creating = busy || isPending;

  const submit = (): void => {
    startTransition(async () => {
      await create(mission);
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto grid min-h-full w-full max-w-[1080px] grid-cols-1 content-start gap-6 px-6 py-[clamp(72px,12vh,132px)] md:content-center md:px-10 lg:grid-cols-[minmax(0,680px)_300px]">
        <header className="col-span-full mb-3">
          <h1 className="p-display text-[clamp(38px,4vw,46px)] font-semibold leading-[1.12] p-text">
            What do you wanna work on?
          </h1>
        </header>

        <PromptCard
          id="workspace-mission"
          label={MISSION_LABEL}
          placeholder={MISSION_PLACEHOLDER}
          action="Create workspace"
          value={mission}
          onChange={setMission}
          onSubmit={submit}
          busy={creating}
          blocked={hasModels === false}
          error={err}
          notice={hasModels === false && <CloudflareAIConnectNotice returnTo="/" message={CONNECT_AI_MESSAGE} />}
        />

        <aside className="order-3 min-w-0 lg:order-none">
          <SetupCard returnTo="/" />
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
