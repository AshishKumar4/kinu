import { type FormEvent, useState, useTransition } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import {
  CONNECT_AI_MESSAGE,
  MISSION_LABEL,
  MISSION_PLACEHOLDER,
  useCreateWorkspace,
} from "@/hooks/use-create-workspace";
import { APP_ROUTES } from "@kinu.run/core";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { lastValue } from "@/hooks/use-async-resource";
import { RECENT_WORKSPACES, useWorkspaceOverview } from "@/hooks/use-workspace-overviews";
import type { WorkspaceEntry } from "@/lib/user-api";
import { timeAgo } from "@kinu.run/core";
import { OverviewEvidence, OverviewLabel } from "@/pages/home-overview-label";

export default function HomePage() {
  const [mission, setMission] = useState("");
  const { entries: workspaces, error: rosterError } = useWorkspaceRoster();
  const listFailed = rosterError !== null;
  const { hasModels, busy, err, create } = useCreateWorkspace();
  const [isPending, startTransition] = useTransition();
  const creating = busy || isPending;

  /** React owns the async action; the workspace hook owns its visible error. */
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
          {/* Hero display heading: fluid clamp, the one type on the page above the scale. */}
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
          <div className="rounded-[14px] border p-border p-surface px-[18px] py-4">
            <div className="mb-2.5 text-xs font-semibold p-text-4">Setup</div>
            <Link to={APP_ROUTES.userSettings} className="block py-[5px] p-t-control p-accent">
              Connect providers →
            </Link>
            <Link to={APP_ROUTES.userMcp} className="block py-[5px] p-t-control p-accent">
              Add MCP servers →
            </Link>
            <a href="/install" className="block py-[5px] p-t-control p-accent">
              Install the CLI →
            </a>
          </div>
        </aside>

        {(listFailed || workspaces.length > 0) && (
          <section aria-label="Recent workspaces" className="order-2 min-w-0 lg:order-none">
            <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
              <span className="p-eyebrow">Recent</span>
              {listFailed && <span className="p-t-status p-warning">could not load</span>}
            </div>
            <div className="overflow-hidden rounded-[14px] border p-border p-surface">
              {workspaces.slice(0, RECENT_WORKSPACES).map((agent, index) => (
                <HomeWorkspaceRow key={agent.name} workspace={agent} first={index === 0} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

/** One workspace row: the name renders the moment the roster lands; the
 *  overview loads beside it and fails independently. The retry button sits
 *  BESIDE the link — a button inside an anchor is nested interactive content,
 *  so the row is a wrapper holding the link and the action separately. */
function HomeWorkspaceRow({ workspace, first }: { workspace: WorkspaceEntry; first: boolean }) {
  const { resource, reload } = useWorkspaceOverview(workspace.name);

  const overview = lastValue(resource);
  const stale = resource.status === "error" && overview !== null;
  const unavailable = resource.status === "error" && overview === null;

  return (
    <div className={`flex items-center gap-2 px-[18px] py-3 transition-colors hover:p-elevated ${first ? "" : "border-t border-dashed border-[var(--c-dash)]"}`}>
      <Link
        to={`/workspace/${workspace.name}`}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 p-row-text p-text hover:p-accent"
      >
        <span className="w-full truncate">{workspace.displayName || workspace.name}</span>
        <span
          role="status"
          aria-live="polite"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 p-t-status"
        >
          {workspace.lastVisited > 0 && (
            <span className="hidden p-text-4 sm:inline">Opened {timeAgo(workspace.lastVisited)}</span>
          )}
          {resource.status === "loading" && <span className="p-text-4">…</span>}
          {overview !== null && <OverviewLabel overview={overview} stale={stale} />}
          {stale && <span className="p-text-4">Last checked {timeAgo(overview.observedAt)}</span>}
          {unavailable && <span className="p-warning">unavailable</span>}
          <span className="p-arrow" aria-hidden="true">→</span>
          {overview !== null && <OverviewEvidence overview={overview} stale={stale} />}
        </span>
      </Link>
      {(stale || unavailable) && (
        <button
          type="button"
          onClick={() => reload()}
          className="shrink-0 p-accent underline decoration-dotted underline-offset-2 p-t-status"
        >
          retry
        </button>
      )}
    </div>
  );
}
