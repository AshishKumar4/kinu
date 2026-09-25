import { type FormEvent, useState, useTransition } from "react";
import { Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
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

export default function HomePage() {
  const [mission, setMission] = useState("");
  const { entries: workspaces, error: rosterError } = useWorkspaceRoster();
  const listFailed = rosterError !== null;
  const { hasModels, busy, err, create } = useCreateWorkspace();
  const [isPending, startTransition] = useTransition();
  const creating = busy || isPending;

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();

    if (creating) return;

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

        <form onSubmit={submit} className="p-focus min-w-0 overflow-hidden rounded-2xl border p-border bg-[var(--c-input-bg)] shadow-[0_18px_55px_-42px_rgba(0,0,0,.75)] transition-[border-color,box-shadow]">
          <div className="px-6 pt-5">
            <label htmlFor="workspace-mission" className="block p-t-status p-text-3">
              {MISSION_LABEL}
            </label>
            <textarea
              id="workspace-mission"
              value={mission}
              onChange={(event) => setMission(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={MISSION_PLACEHOLDER}
              rows={4}
              autoFocus
              disabled={creating}
              className="block min-h-[128px] w-full resize-none bg-transparent pb-4 pt-3 p-t-composer p-text outline-none focus-visible:!outline-none placeholder:p-text-3 disabled:opacity-60"
            />
          </div>
          {hasModels === false && (
            <div className="px-6 pb-4">
              <CloudflareAIConnectNotice returnTo="/" message={CONNECT_AI_MESSAGE} />
            </div>
          )}
          {err && (
            <div className="mx-6 mb-4 rounded-md px-3 py-2 text-xs p-notice-danger">{err}</div>
          )}
          <div className="flex items-center justify-end px-6 pb-5">
            <FilledButton
              type="submit"
              disabled={creating || hasModels === false}
              className="!h-10 !rounded-full px-5 p-t-control"
            >
              {creating && <Loader size="sm" />}
              Create workspace
            </FilledButton>
          </div>
        </form>

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
